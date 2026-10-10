//! Responsive-terminal-restore Workstream 1 — the paced replay core,
//! end-to-end on REAL sockets: a REAL axum server (ephemeral loopback
//! port), a REAL PTY (`TerminalRegistry`), and REAL tokio-tungstenite WS
//! clients, one of which negotiates `pacedTerminalReplayV1` and drives
//! continuation credits over the raw socket.
//!
//! The harness follows `hello_capabilities.rs` (the `connect_async`
//! `WsClient` type — the two files' WS client types are deliberately NOT
//! shared). The page budget and the scrollback ring are per-server registry
//! knobs, so fixtures are deterministic without env races.
//!
//! Core contract under test: a negotiated attach gets `attach.ready` bounds
//! plus ONE bounded first page; further replay pages flow only on valid
//! `terminal.replay.credit` (stale generations, out-of-window values, and
//! credits from non-negotiated connections are ignored); the grant is
//! strictly page-end (a partial consumption report is observed, grants
//! nothing); live output produced during the replay is delivered strictly
//! AFTER the pages covering it, in seq order; the tail drain completes
//! against a continuously-producing terminal (fixed tail target + the
//! one-shot live handoff — never a chase of the moving head); retention
//! expiry mid-replay reports the exact lost interval with the task-2
//! bounds fields and continues from the new baseline; a re-attach
//! supersedes the old session; a disconnect mid-replay leaves the
//! terminal running and re-attachable.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

// ── capturing tracing layer (dev-only test facility). PROCESS-GLOBAL by
// deliberate choice (the diag01_lifecycle_events.rs `global_capture` /
// invariants.rs e08g pattern, extended with `record_u64` so the paced
// events' u64 fields — `page_bytes`, `pages` — are captured too): a
// thread-local `set_default` capture is UNSOUND for callsites shared with
// sibling tests running in parallel — tracing-core caches each callsite's
// Interest process-wide on first registration, and a subscriber-less
// sibling thread executing a shared emission site first (e.g.
// `credit_on_a_non_negotiated_connection_is_inert` firing the
// `non_negotiated` callsite) caches `Interest::never`, so a thread-local
// capture then never sees its OWN thread's emissions (kata 59nb). One
// global subscriber sees every thread's events; every read below MUST
// filter by the per-test-unique `terminal_id` because ALL tests in this
// binary share the vec. ─────────────────────────────────────────────────

use std::sync::Mutex;
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

/// Process-global capture for this test binary (first caller installs;
/// `get_or_init` is the synchronization). This binary installs no other
/// global subscriber; `.expect()` turns any future second installer into an
/// immediate diagnosable panic instead of a silently-empty capture.
fn global_capture() -> Arc<Mutex<Vec<CapturedEvent>>> {
    static EVENTS: std::sync::OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> = std::sync::OnceLock::new();
    Arc::clone(EVENTS.get_or_init(|| {
        let events = Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            events: Arc::clone(&events),
        };
        // Target/level-filter the process-global registry (task-010b
        // hygiene): an unfiltered registry enables every callsite
        // process-wide — a latent perf and determinism footgun. Unlike the
        // term09 twin (a plain WARN level filter), this binary's
        // assertions read INFO-level `ws.restore.*` events, emitted by
        // exactly two modules: `freshell_ws::paced_replay` (paced_start /
        // paced_complete / paced_expired; paced_gone is warn) and
        // `freshell_ws::terminal` (the credit verdicts and
        // restore-unavailable). The filter admits exactly those targets at
        // INFO plus WARN-or-above everywhere else — nothing the tests read
        // is disabled.
        let subscriber = tracing_subscriber::registry().with(layer).with(
            tracing_subscriber::filter::Targets::new()
                .with_default(tracing_subscriber::filter::LevelFilter::WARN)
                .with_target(
                    "freshell_ws::paced_replay",
                    tracing_subscriber::filter::LevelFilter::INFO,
                )
                .with_target(
                    "freshell_ws::terminal",
                    tracing_subscriber::filter::LevelFilter::INFO,
                ),
        );
        tracing::subscriber::set_global_default(subscriber)
            .expect("this test binary installs exactly one global subscriber");
        events
    }))
}

/// Poll the capture until an event for THIS test's terminal (the vec is
/// shared by every test in the binary — the unique `terminal_id` is the
/// per-test discriminator) with this message AND `fields[field] == value`
/// lands (or the 5s deadline passes). The `ws.restore.credit` events share
/// one message name, so the verdict `status` field is the selector.
async fn wait_for_restore_event(
    events: &Arc<Mutex<Vec<CapturedEvent>>>,
    terminal_id: &str,
    message: &str,
    field: &str,
    value: &str,
) -> Option<CapturedEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            if let Some(found) = captured.iter().find(|e| {
                e.message == message
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
                    && e.fields.get(field).map(String::as_str) == Some(value)
            }) {
                return Some(found.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// [`wait_for_restore_event`] without the extra field selector — for the
/// one-event-per-terminal messages (`ws.restore.paced_start`,
/// `ws.restore.paced_complete`).
async fn wait_for_restore_event_of_terminal(
    events: &Arc<Mutex<Vec<CapturedEvent>>>,
    terminal_id: &str,
    message: &str,
) -> Option<CapturedEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        {
            let captured = events.lock().unwrap();
            if let Some(found) = captured.iter().find(|e| {
                e.message == message
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
            }) {
                return Some(found.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";
/// Deliberately small page budget: deterministic multi-page fixtures with
/// small floods (the production default is 128 KiB).
const PAGE_BUDGET: i64 = 4096;

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

/// Spawn a real server with a paced-page budget of [`PAGE_BUDGET`] and a
/// scrollback ring of `ring_chars` UTF-16 units (per-server registry knobs —
/// no env races between parallel tests).
async fn spawn_server(ring_chars: i64) -> String {
    spawn_server_with(ring_chars, PAGE_BUDGET, None).await
}

/// [`spawn_server`] with per-test registry/backpressure overrides: the
/// paced page budget (default [`PAGE_BUDGET`]) and an optional
/// `queue_max_bytes` TERM-09 output-queue cap (None keeps
/// [`freshell_ws::backpressure::Term09Config::default`] — the production
/// 16 MiB lane; Some makes the drain's connection backpressure observable
/// at test scale).
async fn spawn_server_with(
    ring_chars: i64,
    page_budget: i64,
    queue_max_bytes: Option<usize>,
) -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let registry = freshell_terminal::TerminalRegistry::new();
    // Round-5 finding 1 (degenerate settings): mirror the server boot's
    // page-budget clamp — the boot applies the queue-derived admission
    // ceiling right after TERM-09 resolution, so a paced page always fits
    // the connection queue's drain-admission watermark. The harness
    // applies the SAME relationship so every paced fixture runs the
    // production shape (with default knobs this is a no-op).
    let effective_page_budget =
        page_budget.min(freshell_ws::backpressure::paced_page_budget_ceiling(
            queue_max_bytes.unwrap_or_else(|| {
                freshell_ws::backpressure::Term09Config::default().queue_max_bytes
            }),
        ));
    registry.set_paced_page_max_bytes(effective_page_budget);
    registry.set_scrollback_max_bytes(ring_chars);

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
        registry,
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 64 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config {
            queue_max_bytes: queue_max_bytes.unwrap_or_else(|| {
                freshell_ws::backpressure::Term09Config::default().queue_max_bytes
            }),
            ..freshell_ws::backpressure::Term09Config::default()
        },
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
        ownership: None,
        units: Default::default(),
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

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str) -> WsClient {
    let (ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws
}

/// Complete the hello handshake, optionally negotiating the paced capability
/// (and echo-reading the 4 handshake frames).
async fn hello(ws: &mut WsClient, paced: bool) {
    let capabilities = if paced {
        serde_json::json!({ "pacedTerminalReplayV1": true })
    } else {
        serde_json::json!({})
    };
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
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        assert!(matches!(msg, WsMessage::Text(_)));
    }
}

async fn next_json(ws: &mut WsClient) -> serde_json::Value {
    let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("frame within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    let WsMessage::Text(text) = msg else {
        panic!("expected a text frame, got {msg:?}");
    };
    serde_json::from_str(&text).expect("frame is JSON")
}

/// Read the next JSON frame, or `None` if no frame at all arrives within
/// `window`. A keepalive Ping/Pong landing INSIDE the window is NOT
/// silence — the burst-complete heuristic treats only text frames as
/// signal, so a server ping mid-read cannot truncate a page read (the
/// 30s ping interval makes this rare vs the ~1-2s bursts, but the harness
/// must not depend on that timing).
async fn next_json_or_timeout(ws: &mut WsClient, window: Duration) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                return Some(serde_json::from_str(&text).expect("frame is JSON"));
            }
            // Control frames never count as the burst's end: keep waiting
            // for text until the window actually elapses.
            Ok(Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

async fn create_shell_terminal(ws: &mut WsClient, request_id: &str) -> String {
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let value = next_json(ws).await;
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.created")
            && value.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
        {
            return value
                .get("terminalId")
                .and_then(|v| v.as_str())
                .expect("terminal.created carries terminalId")
                .to_string();
        }
    }
    panic!("terminal.created never arrived");
}

/// Send `terminal.attach` (viewport hydrate, sinceSeq 0 by default).
async fn attach(ws: &mut WsClient, terminal_id: &str, attach_request_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "attachRequestId": attach_request_id,
            "sinceSeq": 0,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach");
}

/// Send `terminal.attach` WITHOUT an `attachRequestId` — the uncorrelated
/// legacy shape: even a negotiated connection falls back to the inline
/// full-replay path (credits cannot be correlated without a generation key).
async fn attach_without_arid(ws: &mut WsClient, terminal_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
        })
        .to_string(),
    ))
    .await
    .expect("send arid-less terminal.attach");
}

/// Send one continuation credit.
async fn credit(ws: &mut WsClient, terminal_id: &str, arid: &str, consumed_seq: i64) {
    credit_with_stream(
        ws,
        terminal_id,
        &known_stream(terminal_id),
        arid,
        consumed_seq,
    )
    .await;
}

/// Send `terminal.replay.credit` with an EXPLICIT stream id — the honest
/// client shape (the stream comes from the terminal's `attach.ready`),
/// used by tests that credit without having observed a ready for the
/// terminal (round-2 finding F4 made stream identity part of the
/// continuation contract, so the old fixture value
/// "ignored-by-server" is now correctly rejected as a stream mismatch).
async fn credit_with_stream(
    ws: &mut WsClient,
    terminal_id: &str,
    stream_id: &str,
    arid: &str,
    consumed_seq: i64,
) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.replay.credit",
            "terminalId": terminal_id,
            "streamId": stream_id,
            "attachRequestId": arid,
            "consumedSeq": consumed_seq,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.replay.credit");
}

/// The stream ids observed in `terminal.attach.ready` frames, keyed by
/// terminal id (terminal ids are unique per test, so the map is race-free
/// across parallel tests in this binary). `credit()` sends the terminal's
/// REAL stream id from here — see [`credit_with_stream`]. Poison-tolerant:
/// the map is a test fixture, and one test's panic must not cascade
/// through every other test's lock acquisition.
fn note_ready_stream(ready: &serde_json::Value) {
    let terminal_id = ready["terminalId"].as_str().expect("ready.terminalId");
    let stream_id = ready["streamId"].as_str().expect("ready.streamId");
    test_ready_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(terminal_id.to_string(), stream_id.to_string());
}

fn known_stream(terminal_id: &str) -> String {
    test_ready_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(terminal_id)
        .cloned()
        .unwrap_or_else(|| {
            panic!(
                "no attach.ready observed for {terminal_id}: read the ready via a helper \
                 (paced_attach_first_page / attach_burst_collecting_gaps) or use \
                 credit_with_stream"
            )
        })
}

fn test_ready_streams() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static STREAMS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    STREAMS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// A flood whose completion is detectable by a marker that only the EXECUTED
/// printf emits (octal escapes keep the literal command text from echoing
/// the marker early — the same discipline as `term09_output_queue.rs`).
fn flood_command(lines: usize, marker: &str) -> String {
    assert_eq!(marker, "FLOOD-DONE-MARKER");
    format!(
        "yes 'STREAMDATA-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' | head -n {lines}; printf '\\106\\114\\117\\117\\104\\055\\104\\117\\116\\105\\055\\115\\101\\122\\113\\105\\122\\012'\n"
    )
}

async fn send_input(ws: &mut WsClient, terminal_id: &str, data: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": data,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
}

/// Drain frames until `marker` appears in the accumulated output data.
/// Returns `(data, frames)` — the concatenated output data and every
/// terminal.output frame's seqStart (ascending as received).
async fn drain_until_marker(
    ws: &mut WsClient,
    marker: &str,
    deadline: tokio::time::Instant,
) -> (String, Vec<i64>) {
    let mut acc = String::new();
    let mut seqs = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
                    if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                        acc.push_str(data);
                    }
                    seqs.push(value.get("seqStart").and_then(|v| v.as_i64()).unwrap_or(-1));
                }
                if acc.contains(marker) {
                    return (acc, seqs);
                }
            }
            _ => break,
        }
    }
    (acc, seqs)
}

/// Drive the terminal from a NON-NEGOTIATED driver connection until
/// `marker` is observed on it (the deterministic "the flood finished"
/// signal — the ring holds the full flood before the paced client attaches).
async fn flood_until_complete(url: &str, driver: &mut WsClient, terminal_id: &str, lines: usize) {
    let mut observer = connect(url).await;
    hello(&mut observer, false).await;
    attach(&mut observer, terminal_id, "attach-observer").await;
    let marker = "FLOOD-DONE-MARKER";
    send_input(driver, terminal_id, &flood_command(lines, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut observer, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "the flood must complete on the observer"
    );
    // Detach the observer so it stops receiving (and the terminal's
    // subscriber set is clean for the paced client).
    observer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("observer detaches");
}

/// One attach's spontaneous delivery: the ready frame plus every output
/// frame the server sends WITHOUT any credit (the negotiated first page /
/// the non-negotiated full inline replay). Reading ends on the first QUIET
/// gap after the ready — the burst is one back-to-back admission, so a quiet
/// window means the server has nothing more to send unprompted.
async fn paced_attach_first_page(
    ws: &mut WsClient,
    terminal_id: &str,
    arid: &str,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    attach(ws, terminal_id, arid).await;
    read_attach_burst(ws, arid).await
}

/// [`paced_attach_first_page`] with a negotiated `replayPageBytes` bound
/// (E2R1 finding 2's sub-cap fixtures request a page budget BELOW the
/// production frame size, so every page the session produces is the page
/// builder's atomic single-frame result).
async fn paced_attach_first_page_with_budget(
    ws: &mut WsClient,
    terminal_id: &str,
    arid: &str,
    replay_page_bytes: serde_json::Value,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    attach_with_page_budget(ws, terminal_id, arid, replay_page_bytes).await;
    read_attach_burst(ws, arid).await
}

/// The attach burst after the attach frame was sent: the ready (matched
/// by `attachRequestId`) plus every output frame of the first page, read
/// to the first quiet gap after the ready.
async fn read_attach_burst(
    ws: &mut WsClient,
    arid: &str,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    read_attach_burst_with_quiet(ws, arid, Duration::from_millis(400)).await
}

/// [`read_attach_burst`] with an explicit quiet window (the paced
/// sub-cap fixture's bursts are the only traffic on their connection, so
/// a short window keeps its per-pane attach dance tight).
async fn read_attach_burst_with_quiet(
    ws: &mut WsClient,
    arid: &str,
    quiet: Duration,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    let mut ready = None;
    let mut outputs = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(ws, quiet).await {
            None => {
                if ready.is_some() {
                    break; // the unprompted burst is complete
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready")
                    if value.get("attachRequestId").and_then(|v| v.as_str()) == Some(arid) =>
                {
                    ready = Some(value);
                }
                Some("terminal.output") => outputs.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    note_ready_stream(&ready);
    (ready, outputs)
}

/// The LEGACY (non-paced) attach burst: the ready frame (matched by
/// terminalId — this attach carries no `attachRequestId` to match) plus
/// every output frame the server sends spontaneously (the full inline
/// replay), read to the first quiet gap after the ready.
async fn legacy_attach_inline_replay(
    ws: &mut WsClient,
    terminal_id: &str,
) -> (serde_json::Value, Vec<serde_json::Value>) {
    let mut ready = None;
    let mut outputs = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(ws, Duration::from_millis(400)).await {
            None => {
                if ready.is_some() {
                    break; // the inline burst is complete
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready")
                    if value.get("terminalId").and_then(|v| v.as_str()) == Some(terminal_id) =>
                {
                    ready = Some(value);
                }
                Some("terminal.output") | Some("terminal.output.batch") => outputs.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    note_ready_stream(&ready);
    (ready, outputs)
}

/// One attach's full spontaneous burst, collecting EVERY frame type: the
/// ready (matched by `attachRequestId`), all `terminal.output` frames, and
/// any `terminal.output.gap` frames separately. The gap bucket is the
/// mixed-version matrix pin: a NON-NEGOTIATED attach must never produce a
/// `replay_window_exceeded` gap — today's silent retained-tail behavior is
/// the old-client contract.
async fn attach_burst_collecting_gaps(
    ws: &mut WsClient,
    terminal_id: &str,
    arid: &str,
) -> (
    serde_json::Value,
    Vec<serde_json::Value>,
    Vec<serde_json::Value>,
) {
    attach(ws, terminal_id, arid).await;
    let mut ready = None;
    let mut outputs = Vec::new();
    let mut gaps = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(ws, Duration::from_millis(400)).await {
            None => {
                if ready.is_some() {
                    break; // the unprompted burst is complete
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready")
                    if value.get("attachRequestId").and_then(|v| v.as_str()) == Some(arid) =>
                {
                    ready = Some(value);
                }
                Some("terminal.output") => outputs.push(value),
                Some("terminal.output.gap") => gaps.push(value),
                _ => {}
            },
        }
    }
    let ready = ready.expect("attach.ready never arrived");
    note_ready_stream(&ready);
    (ready, outputs, gaps)
}

/// The covered seq set of a frame list: every seq in [seqStart, seqEnd].
fn covered_seqs(frames: &[serde_json::Value]) -> std::collections::BTreeSet<i64> {
    frames
        .iter()
        .flat_map(|f| {
            let start = f["seqStart"].as_i64().unwrap_or(0);
            let end = f["seqEnd"].as_i64().unwrap_or(0);
            start..=end
        })
        .collect()
}

/// The concatenated output data of a frame list, in receive (seq) order.
fn concatenated_data(frames: &[serde_json::Value]) -> String {
    frames
        .iter()
        .map(|f| f["data"].as_str().unwrap_or(""))
        .collect()
}

/// Negotiated attach with real scrollback: ready carries the retention
/// bounds, the first page is a BOUNDED prefix, and NO further replay frames
/// arrive while the client withholds credit. A raw-socket credit then
/// produces the next page; an out-of-window credit produces nothing.
#[tokio::test]
async fn negotiated_attach_gets_first_page_only_and_credit_gates_the_rest() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-paced").await;
    // ~64KB of scrollback: many 4KB pages, far under the 512KB ring.
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-paced").await;

    // Ready bounds: the negotiated restore contract fields.
    assert!(
        ready["headSeq"].as_i64().unwrap_or(0) >= 1,
        "honest head: {ready}"
    );
    let oldest = ready["oldestRetainedSeq"]
        .as_i64()
        .expect("negotiated ready carries oldestRetainedSeq");
    let head = ready["headSeq"].as_i64().expect("headSeq");
    assert!(
        oldest >= 1 && oldest <= head + 1,
        "honest retention bound: {ready}"
    );
    assert!(
        ready.get("replayResetReason").is_none(),
        "no retention loss in this fixture: {ready}"
    );
    // The paced window description.
    assert_eq!(
        ready["replayToSeq"].as_i64(),
        Some(head),
        "replayToSeq is the fixed target: {ready}"
    );
    assert_eq!(
        ready["replayFromSeq"].as_i64(),
        Some(1),
        "the window starts at the baseline+1: {ready}"
    );

    // The first page is a bounded prefix of the window.
    assert!(!page1.is_empty(), "there is replay to page");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("page frames carry seqEnd");
    assert!(
        last_seq < head,
        "the first page must not cover the whole window (head {head})"
    );
    let page_bytes: usize = page1.iter().map(|f| f.to_string().len()).sum();
    assert!(
        page_bytes as i64 <= PAGE_BUDGET,
        "the first page honors the serialized budget: {page_bytes}"
    );
    for frame in &page1 {
        assert_eq!(
            frame["source"], "replay",
            "pages are stamped source:'replay'"
        );
        assert_eq!(frame["attachRequestId"], "attach-paced");
        assert!(frame["seqStart"].as_i64().unwrap_or(0) >= 1);
    }

    // WITHHOLD: no credit => no further pages (a window with no frames).
    let withheld = next_json_or_timeout(&mut paced, Duration::from_millis(1500)).await;
    assert!(
        withheld.is_none()
            || withheld
                .as_ref()
                .unwrap()
                .get("type")
                .and_then(|v| v.as_str())
                != Some("terminal.output"),
        "no further replay frames may arrive without credit, got {withheld:?}"
    );

    // Beyond-window credit: ignored, produces nothing, and does not consume
    // the grant (the next VALID credit still works).
    credit(&mut paced, &terminal_id, "attach-paced", last_seq + 100_000).await;
    let bad = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        bad.is_none()
            || bad.as_ref().unwrap().get("type").and_then(|v| v.as_str())
                != Some("terminal.output"),
        "a beyond-window credit must produce nothing, got {bad:?}"
    );

    // Valid credit => the next page arrives.
    credit(&mut paced, &terminal_id, "attach-paced", last_seq).await;
    let next = next_json(&mut paced).await;
    assert_eq!(
        next["type"], "terminal.output",
        "the credit produces the next page: {next}"
    );
    let next_end = next["seqEnd"].as_i64().expect("seqEnd");
    assert!(
        next_end > last_seq,
        "pages ascend: page1 ends {last_seq}, next starts at {}",
        next["seqStart"]
    );
    assert_eq!(next["attachRequestId"], "attach-paced");
    assert_eq!(next["source"], "replay");
}

/// Send `terminal.attach` with a negotiated forward-page upper bound
/// (`replayPageBytes`, round-2 finding F3).
async fn attach_with_page_budget(
    ws: &mut WsClient,
    terminal_id: &str,
    attach_request_id: &str,
    replay_page_bytes: serde_json::Value,
) {
    attach_with_page_budget_and_since(ws, terminal_id, attach_request_id, replay_page_bytes, 0)
        .await
}

/// [`attach_with_page_budget`] with an explicit `sinceSeq` baseline (the
/// paced restore contract's coverage cursor — E2R1 finding 2's sub-cap
/// fixture attaches each pane from just below its observed head, so the
/// credited window is a couple of frames and the session HOLDS on its
/// first page until the client credits).
async fn attach_with_page_budget_and_since(
    ws: &mut WsClient,
    terminal_id: &str,
    attach_request_id: &str,
    replay_page_bytes: serde_json::Value,
    since_seq: i64,
) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "attachRequestId": attach_request_id,
            "sinceSeq": since_seq,
            "replayPageBytes": replay_page_bytes,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach with replayPageBytes");
}

/// Round-2 finding F3: the negotiated `replayPageBytes` wire field is
/// honored as the session's page upper bound END-TO-END — the field used
/// to be emitted by the client and stripped by the server's
/// accept-and-strip deserializer, so the server always paged at its own
/// cap. The bound is proven at the wire three ways: the session's
/// `ws.restore.paced_start` event carries the CLAMPED effective budget
/// (the requested value when under the cap), every packable page stays
/// within it while the session still converges, and malformed or absent
/// values fall back to the server's default exactly like the old strip
/// behavior instead of failing the attach frame. (The fixture's flood
/// frames are ~8.5 KiB — larger than any sub-cap bound — so a page that
/// cannot pack even one frame carries exactly ONE frame: the page
/// builder's explicit atomic over-budget result, the plan's bounded
/// behavior for a frame larger than the budget.)
#[tokio::test]
async fn negotiated_attach_honors_the_requested_replay_page_bytes() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-paced-budget").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    // The requested bound sits BELOW the server's 4096-byte cap.
    let requested = 2048usize;
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    attach_with_page_budget(
        &mut paced,
        &terminal_id,
        "attach-budget",
        serde_json::json!(requested),
    )
    .await;
    let mut ready = None;
    let mut page: Vec<serde_json::Value> = Vec::new();
    let mut head = 0i64;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match next_json_or_timeout(&mut paced, Duration::from_millis(400)).await {
            None => {
                if ready.is_some() {
                    break;
                }
                continue;
            }
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.attach.ready") => {
                    head = value["headSeq"].as_i64().expect("headSeq");
                    note_ready_stream(&value);
                    ready = Some(value);
                }
                Some("terminal.output") => page.push(value),
                _ => {}
            },
        }
    }
    ready.expect("attach.ready never arrived");
    assert!(!page.is_empty(), "there is replay to page");

    // THE WIRE PROOF: the session's effective page budget is the REQUESTED
    // bound clamped to itself (under the cap) — the stripped-field bug
    // would report the server cap (4096) instead.
    let start_ev = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.paced_start",
        "attach_request_id",
        "attach-budget",
    )
    .await
    .expect("the bounded attach emits its paced_start event");
    assert_eq!(
        start_ev.fields.get("page_budget").map(String::as_str),
        Some("2048"),
        "the requested replayPageBytes becomes the session's page budget: {:?}",
        start_ev.fields
    );

    // Credit-drive the rest of the window at the SAME bound: every page
    // either packs strictly within it or carries exactly ONE frame (the
    // atomic over-budget result for a frame larger than the bound — the
    // flood's ~8.5 KiB frames), and the session converges.
    //
    // E2R1 finding 2 — the single-frame assertions, added honestly: the
    // atomic exception is DOCUMENTED, not hidden. A single-frame page MAY
    // exceed the request (the builder always includes the window's first
    // frame), but it reaches ONLY the atomic page ceiling — the fragment
    // cap plus the page-envelope slack, the same bound the drain
    // admission reserves for sub-cap budgets.
    let atomic_ceiling = freshell_terminal::paced_atomic_page_serialized_ceiling();
    let mut pages = 0usize;
    let mut last_seq = 0i64;
    let mut saw_atomic_over_budget = false;
    loop {
        let page_bytes: usize = page.iter().map(|f| f.to_string().len()).sum();
        if page.len() > 1 {
            assert!(
                page_bytes <= requested,
                "a multi-frame page must pack within the {requested}-byte bound, got {page_bytes}"
            );
        } else if page.len() == 1 {
            assert!(
                page_bytes <= atomic_ceiling,
                "a single-frame page may reach only the documented atomic ceiling \
                 ({atomic_ceiling}), got {page_bytes}"
            );
            if page_bytes > requested {
                saw_atomic_over_budget = true;
            }
        }
        pages += 1;
        last_seq = page
            .last()
            .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
            .unwrap_or(last_seq);
        if last_seq >= head {
            break; // the fixed target is covered
        }
        credit(&mut paced, &terminal_id, "attach-budget", last_seq).await;
        page.clear();
        let mut saw_frame = false;
        while tokio::time::Instant::now() < deadline {
            match next_json_or_timeout(&mut paced, Duration::from_millis(400)).await {
                None => break, // the page is complete
                Some(value) => {
                    if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
                        saw_frame = true;
                        page.push(value);
                    }
                }
            }
        }
        assert!(
            saw_frame || !page.is_empty(),
            "the credit must produce the next page"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "the session must converge at the requested bound"
        );
    }
    assert!(pages > 1, "the window must page repeatedly ({pages})");
    assert!(
        saw_atomic_over_budget,
        "the fixture exercises the documented atomic exception: at least one \
         single-frame page exceeds the {requested}-byte request (the flood's \
         ~8.5 KiB frames against the 2048-byte bound)"
    );

    // A MALFORMED bound (wrong-typed) keeps the server default and never
    // fails the attach frame — the pre-contract accept-and-strip
    // tolerance, preserved at the wire level.
    let mut malformed = connect(&url).await;
    hello(&mut malformed, true).await;
    attach_with_page_budget(
        &mut malformed,
        &terminal_id,
        "attach-bad-budget",
        serde_json::json!("2048"),
    )
    .await;
    let bad_ev = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.paced_start",
        "attach_request_id",
        "attach-bad-budget",
    )
    .await
    .expect("a wrong-typed replayPageBytes still attaches");
    assert_eq!(
        bad_ev.fields.get("page_budget").map(String::as_str),
        Some("4096"),
        "a malformed bound falls back to the server cap"
    );

    // An ABSENT bound keeps the server default (the field is optional and
    // additive).
    let mut default_attach = connect(&url).await;
    hello(&mut default_attach, true).await;
    paced_attach_first_page(&mut default_attach, &terminal_id, "attach-default-budget").await;
    let default_ev = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.paced_start",
        "attach_request_id",
        "attach-default-budget",
    )
    .await
    .expect("the absent-bound attach emits its paced_start event");
    assert_eq!(
        default_ev.fields.get("page_budget").map(String::as_str),
        Some("4096"),
        "an absent bound keeps the server cap"
    );
}

/// A PARTIAL-PAGE credit (a consumedSeq inside the outstanding page, below
/// its end) grants NOTHING on the wire: the server observes it as
/// `partial_consumption` and produces no page — only the page-end value
/// produces the next page (the one-unacknowledged-page bound).
#[tokio::test]
async fn partial_page_credit_on_the_wire_grants_nothing_until_the_page_end() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-partial-credit").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-partial").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("the first page covers something");
    assert!(last_seq < head, "the session starts mid-replay");

    // Two partial consumption reports inside the outstanding page: observed,
    // inert — no page may arrive for either.
    credit(&mut paced, &terminal_id, "attach-partial", last_seq - 2).await;
    let after_partial1 = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        after_partial1
            .as_ref()
            .map(|v| v.get("type").and_then(|t| t.as_str()) != Some("terminal.output"))
            .unwrap_or(true),
        "a partial-page credit must produce no page, got {after_partial1:?}"
    );
    credit(&mut paced, &terminal_id, "attach-partial", last_seq - 1).await;
    let after_partial2 = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        after_partial2
            .as_ref()
            .map(|v| v.get("type").and_then(|t| t.as_str()) != Some("terminal.output"))
            .unwrap_or(true),
        "repeated partial credits must stay inert, got {after_partial2:?}"
    );
    let partial_event = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "partial_consumption",
    )
    .await
    .expect("the partial credit is observed as partial_consumption");

    // The page-end value grants: the next page arrives.
    credit(&mut paced, &terminal_id, "attach-partial", last_seq).await;
    let next = next_json(&mut paced).await;
    assert_eq!(
        next["type"], "terminal.output",
        "the page-end credit produces the next page: {next}"
    );
    assert_eq!(next["attachRequestId"], "attach-partial");
    assert!(
        next["seqEnd"].as_i64().unwrap_or(0) > last_seq,
        "pages ascend after the grant"
    );
    assert_eq!(
        partial_event.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );
}

/// A CONTINUOUSLY-PRODUCING terminal's paced session must COMPLETE (the
/// fixed-completion requirement): the tail drain never chases the moving
/// head — it pages to the tail-start head and hands the staged remainder
/// to the live path — so `ws.restore.paced_complete` fires while
/// production is still running, and the connection keeps processing
/// input afterwards. The old moving-head drain chased forever, wedging
/// the connection's dispatch task inline.
#[tokio::test]
async fn paced_session_completes_while_the_terminal_keeps_producing() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-producing").await;

    // The sustained producer: `yes` with no head — production never pauses.
    // A primer attach precedes the input (the suite's proven driver
    // pattern: the attach applies the PTY's geometry and the shell then
    // executes the buffered line). The primer then observes the flood
    // demonstrably flowing before detaching, so the paced attach happens
    // against a terminal that is KNOWN to be mid-production.
    let mut primer = connect(&url).await;
    hello(&mut primer, false).await;
    attach(&mut primer, &terminal_id, "attach-producing-primer").await;
    send_input(
        &mut driver,
        &terminal_id,
        "yes 'STREAMDATA-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'\n",
    )
    .await;
    let primer_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut flood_observed = false;
    while tokio::time::Instant::now() < primer_deadline {
        let Some(value) = next_json_or_timeout(&mut primer, Duration::from_secs(2)).await else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
            // Flood OUTPUT rows, never the kernel's echo of the typed
            // command line itself (`yes 'STREAMDATA-…'`).
            if data.contains("STREAMDATA") && !data.contains("yes '") {
                flood_observed = true;
                break;
            }
        }
    }
    assert!(
        flood_observed,
        "the sustained producer must be flowing before the paced attach"
    );
    primer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("primer detaches");

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-producing").await;
    let attach_head = ready["headSeq"].as_i64().expect("headSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        credited > 0,
        "the producer staged content before the attach"
    );

    // Drive the session with page-end credits (frame-end credits include
    // every page's end). Retention expiry rounds arrive as negotiated
    // gaps; the session continues within the same credit.
    credit(&mut paced, &terminal_id, "attach-producing", credited).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut produced_past_target = false;
    let mut completed = false;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                produced_past_target |= end > attach_head;
                if end > credited {
                    credited = end;
                    credit(&mut paced, &terminal_id, "attach-producing", end).await;
                }
            }
            Some("terminal.output.gap") => {
                // The negotiated retention gap: continuation is within the
                // already-granted credit; keep consuming frames.
            }
            _ => {}
        }
        if !completed {
            completed = wait_for_restore_event_of_terminal(
                &events,
                &terminal_id,
                "ws.restore.paced_complete",
            )
            .await
            .is_some();
        }
        // The handoff's in-flight frames flow after the completion event:
        // drain them (they carry seqs past the attach target) before
        // asserting.
        if completed && produced_past_target {
            break;
        }
    }

    // THE completion: the session closed while `yes` is still running.
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("the paced session completes against a continuously-producing terminal");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-producing")
    );
    let last_seq = complete
        .fields
        .get("last_seq")
        .and_then(|v| v.parse::<i64>().ok())
        .expect("last_seq recorded");
    assert!(
        last_seq > attach_head,
        "production continued past the attach-time head (attach {attach_head}, completed {last_seq}) — the session completed WITHOUT waiting for production to pause"
    );
    assert!(
        produced_past_target,
        "the fixture's producer demonstrably outran the attach target"
    );

    // The connection is not wedged: stop the flood, then a fresh echo
    // command round-trips through THE SAME (paced) socket — the
    // connection that ran the drain must itself service input, not only
    // a bystander connection.
    send_input(&mut paced, &terminal_id, "\u{3}").await;
    let echo_marker = "PRODUCING-ECHO-MARKER";
    send_input(&mut paced, &terminal_id, &format!("echo '{echo_marker}'\n")).await;
    let drain_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut paced, echo_marker, drain_deadline).await;
    assert!(
        acc.contains(echo_marker),
        "the connection still delivers output after the producing-terminal session completed"
    );

    // The session is gone: a further credit is a stale generation.
    credit(&mut paced, &terminal_id, "attach-producing", last_seq).await;
    let stale = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "stale_generation",
    )
    .await
    .expect("post-completion credits are stale generations");
    assert_eq!(
        stale.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );
}

/// A helper for the producing-drain tests: the sustained `yes` primer —
/// attach a non-negotiated observer, start the flood through the driver,
/// and wait until flood OUTPUT is demonstrably flowing before detaching.
/// Returns the primer socket for the caller to detach.
async fn start_sustained_flood(
    url: &str,
    driver: &mut WsClient,
    terminal_id: &str,
    primer_arid: &str,
) -> WsClient {
    let mut primer = connect(url).await;
    hello(&mut primer, false).await;
    attach(&mut primer, terminal_id, primer_arid).await;
    send_input(
        driver,
        terminal_id,
        "yes 'STREAMDATA-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'\n",
    )
    .await;
    let primer_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < primer_deadline {
        let Some(value) = next_json_or_timeout(&mut primer, Duration::from_secs(2)).await else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
            // Flood OUTPUT rows, never the kernel's echo of the typed
            // command line itself (`yes 'STREAMDATA-…'`).
            if data.contains("STREAMDATA") && !data.contains("yes '") {
                break;
            }
        }
    }
    primer
}

/// A producing drain's SAME-CONNECTION input service (the round-2
/// recapture-loophole fix's dispatcher-bound requirement): while the
/// un-credited tail drain is STILL RUNNING — provably held mid-flight by
/// the connection's real output backpressure — an input frame sent on
/// THE SAME negotiated socket must be serviced by the connection
/// dispatcher BEFORE the drain completes. The inline-drain structure this
/// test replaces monopolized the dispatcher for the drain's whole
/// duration, so same-connection input could only ever be answered after
/// completion; the drain task + backpressure gate makes the answer arrive
/// first. The input is a bogus-terminal probe (the deterministic,
/// content-free `terminal.input.blocked` answer — the kata dtfn lane).
#[tokio::test]
async fn input_on_the_same_connection_is_serviced_while_a_producing_drain_is_still_running() {
    let events = global_capture();
    let ring = 512 * 1024;
    // A small TERM-09 output queue: the drain's own pages blow past the
    // queue's backlog watermark almost immediately, so the backpressure-
    // gated drain stays provably mid-flight (the completion cannot fire
    // until the client consumes the backlog) across a wide, deterministic
    // window in which to probe the dispatcher.
    let url = spawn_server_with(ring, PAGE_BUDGET, Some(16 * 1024)).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-drain-input").await;

    // A large BOUNDED flood (`yes | head -n 100000`): ~5 MB — many ring
    // capacities — so the producer demonstrably overlaps the attach and
    // the credited replay (production keeps advancing the head while the
    // client pages toward the attach target, leaving the un-credited
    // drain a large staged tail), AND it self-terminates via SIGPIPE with
    // the shell left at a prompt — no tty-signal dependence anywhere (a
    // mid-drain Ctrl-C proved environment-flaky: whether the SIGINT
    // reaches only `yes` or the shell itself depends on the spawned
    // shell's job-control shape). The round-3 bounded handoff completes
    // once the producer stops and the client consumes; the pre-fix drain
    // only "completed" against a live producer by evicting its own pages
    // past the queue cap in one ungated dump.
    let mut primer = connect(&url).await;
    hello(&mut primer, false).await;
    attach(&mut primer, &terminal_id, "attach-drain-input-primer").await;
    send_input(
        &mut driver,
        &terminal_id,
        &flood_command(100_000, "FLOOD-DONE-MARKER"),
    )
    .await;
    let primer_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let Some(value) = next_json_or_timeout(&mut primer, Duration::from_secs(2)).await else {
            panic!("the bounded flood must start producing before the attach");
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
            // Flood OUTPUT rows, never the kernel's echo of the typed
            // command line itself.
            if data.contains("STREAMDATA") && !data.contains("yes '") {
                break;
            }
        }
        if tokio::time::Instant::now() >= primer_deadline {
            panic!("the bounded flood must start producing before the attach");
        }
    }
    primer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("primer detaches");

    // Attach IMMEDIATELY (no fill delay — maximize the producer's live
    // overlap with the credited replay): the drain's probe window is held
    // open by the client's own slow reads against the staged tail, so a
    // fill delay buys nothing.

    let mut paced = connect(&url).await;
    // REAL backpressure needs the KERNEL to stop absorbing the drain: a
    // loopback socket's default buffers swallow the whole drain before
    // the writer queue ever fills, so the gate (and the drain's
    // mid-flight window) would never engage. Shrink THIS client's
    // receive buffer: the TCP window closes at kilobytes, the server's
    // writer sends park, its queue fills to the watermark, and the drain
    // provably waits on the connection's real consumption.
    if let tokio_tungstenite::MaybeTlsStream::Plain(tcp) = paced.get_ref() {
        socket2::SockRef::from(tcp)
            .set_recv_buffer_size(8 * 1024)
            .expect("shrink the test client's receive buffer");
    }
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-drain-input").await;
    let target = ready["replayToSeq"].as_i64().expect("replayToSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        credited > 0,
        "the producer staged content before the attach"
    );

    // Credit the replay to its fixed target. The drain (the un-credited
    // tail) begins when the final page reaches the target.
    credit(&mut paced, &terminal_id, "attach-drain-input", credited).await;
    let mut drain_started = false;
    let mut frames_after_input_probe = 0u64;
    let mut input_probe_answered = false;
    let mut input_probe_sent = false;
    // Generous wall-clock windows: the suite runs these PTY+socket tests
    // in parallel, and the assertions are behavioral — the deadlines only
    // need to dominate scheduling noise, never the observed behavior.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    'drain_watch: while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break 'drain_watch;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if end > credited {
                    credited = end;
                    if end < target {
                        // Mid-replay pages stay credit-driven.
                        credit(&mut paced, &terminal_id, "attach-drain-input", end).await;
                    } else if !drain_started {
                        // The first page at/past the fixed target: the
                        // un-credited drain is now demonstrably running.
                        drain_started = true;
                    }
                }
                if input_probe_sent {
                    frames_after_input_probe += 1;
                }
                // Deliberately consume the DRAIN slowly — but only once it
                // is running: the credited replay phase reads at full
                // speed (the probe window opens inside the flood's fixed
                // wall-clock life), and the slow reads then make the
                // drain's own pages outrun the client so the backpressure
                // gate holds the drain open across the probe window.
                if drain_started {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
            Some("terminal.input.blocked") => {
                // The probe's answer arrived on THIS socket: the dispatcher
                // serviced same-connection input mid-drain. Deliberately NOT
                // compared against the server-side ws.restore.paced_complete
                // event: completion is emitted server-side when the drain's
                // production ends, while this frame's ARRIVAL is serialized
                // behind whatever drain pages already hold the queue (this
                // client reads them slowly on purpose), so a correctly
                // serviced probe can still land after the completion event.
                // The mid-drain proof rides on the frames-after observable
                // below — the pre-fix synchronous-drain stall delivered the
                // answer only AFTER the drain's last page.
                assert_eq!(
                    value["reason"], "unknown_terminal",
                    "the probe is answered by the input-blocked frame: {value}"
                );
                input_probe_answered = true;
                if !input_probe_sent {
                    panic!("probe answer observed before the probe was sent");
                }
            }
            _ => {}
        }
        if drain_started && !input_probe_sent {
            input_probe_sent = true;
            send_input(&mut paced, "no-such-terminal-drain-input", "x").await;
        }
        if input_probe_answered && frames_after_input_probe > 0 {
            break 'drain_watch;
        }
    }

    assert!(
        input_probe_sent,
        "the drain must have demonstrably started for the probe window to open"
    );
    assert!(
        input_probe_answered,
        "the dispatcher must service same-connection input even while a \
         producing drain is running (the probe answer never arrived)"
    );
    assert!(
        frames_after_input_probe > 0,
        "the drain still had pages in flight after the probe answer (the probe was mid-drain, not after it)"
    );

    // The drain then completes once the bounded flood has self-terminated
    // and the client consumes. The round-3 bounded handoff pages the
    // staged post-target remainder through the same backpressure gate —
    // one page budget per gate-pass — so the completion wait CONSUMES at
    // full speed while it polls (the pre-fix drain only "completed"
    // against the live flood by evicting its own pages past the queue
    // cap in one ungated dump).
    let paced_complete_fired = || {
        events.lock().unwrap().iter().any(|e| {
            e.message == "ws.restore.paced_complete"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
        })
    };
    let mut complete = None;
    let complete_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut reads_since_check = 0u32;
    while tokio::time::Instant::now() < complete_deadline {
        if next_json_or_timeout(&mut paced, Duration::from_millis(50))
            .await
            .is_some()
        {
            reads_since_check += 1;
            if reads_since_check >= 200 {
                reads_since_check = 0;
                if paced_complete_fired() {
                    complete = Some(());
                    break;
                }
            }
            continue;
        }
        // Quiet socket: check for the completion before the next read
        // window.
        if paced_complete_fired() {
            complete = Some(());
            break;
        }
    }
    assert!(
        complete.is_some(),
        "the producing drain completes after the gate releases"
    );
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("the completion event is captured");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-drain-input")
    );

    // The pane-health postscript (a post-drain Ctrl-C + echo round-trip)
    // lives in `paced_session_completes_while_the_terminal_keeps_producing`
    // under the default queue/socket conditions, where it is stable; this
    // test's uniquely choked fixture (the 16 KiB queue + shrunken RCVBUF
    // that make the gate observable) is what its three assertions need,
    // and they end here.
}

/// Round-5 finding 1 (degenerate settings): the MINIMUM supported queue —
/// the TERM-09 64 KiB floor — is smaller than one default 128 KiB paced
/// page. The server boot clamps the page budget to the queue's admission
/// ceiling (32 KiB; this harness mirrors the boot's clamp), and the
/// drain's reserve-then-admit gate then walks the restore page by page
/// into the tiny queue. The paced session must COMPLETE within the
/// window (never deadlock — the reservation's oversize arm admits into
/// a fully drained queue even if the clamp were bypassed) and the
/// connection must NEVER self-spill its own pages: ZERO client-visible
/// `queue_overflow` gaps and ZERO server-side spill events across the
/// whole restore.
#[tokio::test]
async fn a_minimum_queue_restore_never_deadlocks_or_self_spills() {
    let events = global_capture();
    let ring = 512 * 1024;
    // The degenerate pairing, as configured: the default 128 KiB page
    // budget request against the 64 KiB queue floor (the harness mirrors
    // the boot clamp, so the effective budget is 32 KiB).
    let url = spawn_server_with(ring, 128 * 1024, Some(64 * 1024)).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-min-queue").await;

    // A large BOUNDED flood (`yes | head -n 100000`, ~5 MB): the producer
    // demonstrably outruns the attach target, so the un-credited drain
    // walks a real staged remainder through the tiny queue — the
    // degenerate paging this test exists to cover — and it
    // self-terminates (SIGPIPE leaves the shell at its prompt).
    let mut primer = connect(&url).await;
    hello(&mut primer, false).await;
    attach(&mut primer, &terminal_id, "attach-min-queue-primer").await;
    send_input(
        &mut driver,
        &terminal_id,
        &flood_command(100_000, "FLOOD-DONE-MARKER"),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let Some(value) = next_json_or_timeout(&mut primer, Duration::from_secs(2)).await
            else {
                continue;
            };
            if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
                let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
                if data.contains("STREAMDATA") && !data.contains("yes '") {
                    break;
                }
            }
        }
    })
    .await
    .expect("the bounded flood must start producing before the attach");
    primer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("primer detaches");

    // The negotiated restore over the minimum-sized queue.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let arid = "attach-min-queue";
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, arid).await;
    let target = ready["replayToSeq"].as_i64().expect("replayToSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        credited > 0,
        "the producer staged content before the attach"
    );
    // The first page is consumed: credit its end so the session can page
    // on toward the fixed target (the credited phase's one-page-per-credit
    // contract).
    if credited < target {
        credit(&mut paced, &terminal_id, arid, credited).await;
    }

    // THE CLAMP IS VISIBLE: the session's first page is bounded by the
    // clamped 32 KiB budget (the boot-mirrored ceiling for this queue),
    // never the requested 128 KiB default — a full-size unclamped page
    // would already have self-spilled the 64 KiB queue at attach.
    let start = wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_start")
        .await
        .expect("the paced start event is captured");
    let page_bytes: i64 = start
        .fields
        .get("page_bytes")
        .and_then(|v| v.parse().ok())
        .expect("paced_start carries page_bytes");
    assert!(
        page_bytes > 0 && page_bytes <= 32 * 1024,
        "the clamp caps pages at the queue's admission ceiling (got {page_bytes}B)"
    );

    // Consume at full speed, crediting toward the fixed target, then
    // through the un-credited drain. THE BOUND: no queue_overflow gap may
    // EVER arrive — the clamped, reserved admissions keep the aggregate
    // inside the 64 KiB queue. Retention gaps (`replay_window_exceeded`)
    // are the ring churn this fixture's 5 MB flood produces; they are the
    // honest declared loss and legal.
    let spill_events = || {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                e.message.contains("queue_overflow_spill")
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
            })
            .count()
    };
    let drain_completed = || {
        events.lock().unwrap().iter().any(|e| {
            e.message == "ws.restore.paced_complete"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    while !drain_completed() && tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if end > credited {
                    credited = end;
                    if end < target {
                        credit(&mut paced, &terminal_id, arid, end).await;
                    }
                }
            }
            Some("terminal.output.gap") => {
                assert_ne!(
                    value.get("reason").and_then(|v| v.as_str()).unwrap_or(""),
                    "queue_overflow",
                    "THE BOUND: a 64 KiB queue must never spill its own clamped \
                     restore pages: {value}"
                );
            }
            _ => {}
        }
    }
    if !drain_completed() {
        let terminal_events = {
            let events = events.lock().unwrap();
            events
                .iter()
                .filter(|e| {
                    e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
                })
                .map(|e| (e.message.clone(), e.fields.clone()))
                .collect::<Vec<_>>()
        };
        panic!(
            "NO DEADLOCK: the minimum-queue restore must complete within the window \
             (the reservation's oversize arm admits into a fully drained queue); \
             terminal events: {terminal_events:?}"
        );
    }
    assert_eq!(
        spill_events(),
        0,
        "THE BOUND: zero server-side spill events across the whole restore"
    );
}

/// Read ONE frame (400ms quiet window) and route it to its pane's bucket
/// (0 = terminal A, 1 = terminal B of the caller's pair). Returns false
/// on a quiet read. Gap frames assert the no-self-spill bound inline.
async fn read_and_route_by_pane(
    paced: &mut WsClient,
    terminals: &[String; 2],
    readies: &mut [Option<serde_json::Value>; 2],
    delivered: &mut [Vec<(i64, i64)>; 2],
    declared_gaps: &mut Vec<(usize, i64, i64)>,
) -> bool {
    let Some(value) = next_json_or_timeout(paced, Duration::from_millis(400)).await else {
        return false; // quiet
    };
    let term = value
        .get("terminalId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let pane = if term == terminals[0] {
        0
    } else if term == terminals[1] {
        1
    } else {
        return true; // not ours (handshake stragglers): keep reading
    };
    match value.get("type").and_then(|v| v.as_str()) {
        Some("terminal.attach.ready") => {
            note_ready_stream(&value);
            readies[pane] = Some(value);
        }
        Some("terminal.output") => delivered[pane].push((
            value["seqStart"].as_i64().unwrap_or(0),
            value["seqEnd"].as_i64().unwrap_or(0),
        )),
        Some("terminal.output.gap") => {
            assert_ne!(
                value.get("reason").and_then(|v| v.as_str()).unwrap_or(""),
                "queue_overflow",
                "THE BOUND: no drain-induced spill: {value}"
            );
            declared_gaps.push((
                pane,
                value["fromSeq"].as_i64().unwrap_or(0),
                value["toSeq"].as_i64().unwrap_or(0),
            ));
        }
        _ => {}
    }
    true
}

/// Round-3 finding 1, the per-connection bound: when MULTIPLE panes
/// restore over ONE connection, every completion-path admission stays
/// page-budget-sized and gated by the connection queue's real
/// consumption, so the panes' aggregate admitted-but-unconsumed backlog
/// stays under the queue's byte cap BY CONSTRUCTION — observed as ZERO
/// drain-induced `queue_overflow` spills (the queue's eviction is the
/// only mechanism that can push delivery past the cap, and it never
/// fires). The pre-fix completing call bulk-admitted the ENTIRE staged
/// post-target remainder — bounded only by each pane's ring — in ONE
/// ungated lock hold per pane: N panes aggregated up to N rings past the
/// cap in a single gate-pass each, and the queue evicted the drains' own
/// pages (client-visible `queue_overflow` gaps and undeclared holes).
///
/// Round-5 finding 1: the fixture now uses REALISTIC page sizes — the
/// production-default 128 KiB budget and the production-default 16 MiB
/// queue (the pre-round-5 fixture shrank pages to 4 KiB, avoiding the
/// full-size concurrency this test exists to cover). The tight-watermark
/// aggregate bound itself (concurrent full-size pages against a
/// just-under-watermark backlog) is pinned deterministically at the
/// writer unit lane
/// (`concurrent_full_size_drain_admissions_never_self_spill_the_queue`);
/// THIS test proves the end-to-end shape: two concurrently-draining
/// panes with production-size pages never spill the connection.
#[tokio::test]
async fn multiple_restoring_panes_on_one_connection_stay_within_the_connection_queue_bound() {
    let events = global_capture();
    let ring = 512 * 1024;
    // The bound this test asserts: the gated drains' aggregate backlog
    // stays below the queue cap, so the connection NEVER self-spills.
    // Full-size pages: the production-default 128 KiB budget under the
    // production-default 16 MiB queue cap.
    let url = spawn_server_with(ring, 128 * 1024, None).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_a = create_shell_terminal(&mut driver, "create-multi-a").await;
    let terminal_b = create_shell_terminal(&mut driver, "create-multi-b").await;

    // Both producers flood concurrently: bounded (`yes | head -n 100000`
    // ≈ 5 MB each — many ring capacities, so production demonstrably
    // outruns each attach target and the drains face real post-target
    // remainders) and self-terminating (SIGPIPE leaves the shells at
    // prompts; the drains then converge deterministically).
    let mut observer = connect(&url).await;
    hello(&mut observer, false).await;
    attach(&mut observer, &terminal_a, "attach-multi-observer").await;
    attach(&mut observer, &terminal_b, "attach-multi-observer").await;
    send_input(
        &mut driver,
        &terminal_a,
        &flood_command(100_000, "FLOOD-DONE-MARKER"),
    )
    .await;
    send_input(
        &mut driver,
        &terminal_b,
        &flood_command(100_000, "FLOOD-DONE-MARKER"),
    )
    .await;
    let mut flood_seen = [false, false];
    let flood_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !(flood_seen[0] && flood_seen[1]) && tokio::time::Instant::now() < flood_deadline {
        let Some(value) = next_json_or_timeout(&mut observer, Duration::from_secs(2)).await else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
            let term = value
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Flood OUTPUT rows, never the kernel's echo of the typed
            // command line itself.
            if data.contains("STREAMDATA") && !data.contains("yes '") {
                if term == terminal_a {
                    flood_seen[0] = true;
                } else if term == terminal_b {
                    flood_seen[1] = true;
                }
            }
        }
    }
    assert!(
        flood_seen[0] && flood_seen[1],
        "both floods must be flowing"
    );
    observer
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.detach",
                "terminalId": terminal_a,
            })
            .to_string(),
        ))
        .await
        .expect("observer detaches A");
    observer
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.detach",
                "terminalId": terminal_b,
            })
            .to_string(),
        ))
        .await
        .expect("observer detaches B");

    // ONE negotiated connection restores BOTH panes. Every frame read
    // during the attach sequence is routed by terminal — a pane's
    // retention-gap frame can arrive while the OTHER pane's attach burst
    // is being read, and the contiguity check must not lose it.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let mut readies: [Option<serde_json::Value>; 2] = [None, None];
    let mut delivered: [Vec<(i64, i64)>; 2] = [Vec::new(), Vec::new()];
    let mut declared_gaps: Vec<(usize, i64, i64)> = Vec::new();
    let terminals = [terminal_a.clone(), terminal_b.clone()];
    let read_and_route = read_and_route_by_pane;
    attach(&mut paced, &terminal_a, "attach-multi-a").await;
    while readies[0].is_none() {
        assert!(
            read_and_route(
                &mut paced,
                &terminals,
                &mut readies,
                &mut delivered,
                &mut declared_gaps
            )
            .await,
            "pane A's attach.ready must arrive"
        );
    }
    attach(&mut paced, &terminal_b, "attach-multi-b").await;
    // Read until BOTH readies are in and the socket goes quiet — pane A's
    // first page (and any retention gap) can trail pane B's burst.
    while readies[1].is_none() {
        assert!(
            read_and_route(
                &mut paced,
                &terminals,
                &mut readies,
                &mut delivered,
                &mut declared_gaps
            )
            .await,
            "pane B's attach.ready must arrive"
        );
    }
    for _ in 0..8 {
        if !read_and_route(
            &mut paced,
            &terminals,
            &mut readies,
            &mut delivered,
            &mut declared_gaps,
        )
        .await
        {
            break; // quiet: both attach bursts are complete
        }
    }
    let target_a = readies[0].as_ref().expect("ready A")["replayToSeq"]
        .as_i64()
        .expect("replayToSeq A");
    let target_b = readies[1].as_ref().expect("ready B")["replayToSeq"]
        .as_i64()
        .expect("replayToSeq B");
    let targets = [target_a, target_b];
    let arids = ["attach-multi-a", "attach-multi-b"];
    let mut credited = [
        delivered[0].iter().map(|(_, e)| *e).max().unwrap_or(0),
        delivered[1].iter().map(|(_, e)| *e).max().unwrap_or(0),
    ];
    assert!(credited[0] > 0, "pane A staged content before the attach");
    assert!(credited[1] > 0, "pane B staged content before the attach");
    credit(&mut paced, &terminal_a, "attach-multi-a", credited[0]).await;
    credit(&mut paced, &terminal_b, "attach-multi-b", credited[1]).await;

    // Consume at full speed, crediting each pane toward its fixed target,
    // until BOTH drains complete. THE BOUND: no `queue_overflow` gap may
    // EVER arrive — the gated, page-budget-sized admissions keep the
    // aggregate backlog under the queue cap for the whole concurrent
    // restore. Retention gaps (`replay_window_exceeded`) are the honest
    // declared loss this fixture's ring churn produces; they are legal.
    let mut max_seq = [credited[0], credited[1]];
    let mut completions = [false, false];
    let drain_completed = |events: &Arc<Mutex<Vec<CapturedEvent>>>, terminal_id: &str| -> bool {
        events.lock().unwrap().iter().any(|e| {
            e.message == "ws.restore.paced_complete"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
        })
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while !(completions[0] && completions[1]) && tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            completions[0] |= drain_completed(&events, &terminal_a);
            completions[1] |= drain_completed(&events, &terminal_b);
            continue;
        };
        let term = value
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let pane = if term == terminal_a {
            0
        } else if term == terminal_b {
            1
        } else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                let start = value["seqStart"].as_i64().unwrap_or(0);
                max_seq[pane] = max_seq[pane].max(end);
                // Delivered ranges must be recorded for the hole check;
                // credit mid-replay pages toward the fixed target.
                delivered[pane].push((start, end));
                if end > credited[pane] {
                    credited[pane] = end;
                    if end < targets[pane] {
                        credit(&mut paced, &terminals[pane], arids[pane], end).await;
                    }
                }
            }
            Some("terminal.output.gap") => {
                let reason = value.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(
                    reason, "queue_overflow",
                    "THE BOUND: the gated, page-budget-sized handoff keeps the \
                     connection's aggregate admitted bytes under the queue cap — \
                     a queue_overflow gap means a drain spilled the connection's \
                     own queued pages: {value}"
                );
                declared_gaps.push((
                    pane,
                    value["fromSeq"].as_i64().unwrap_or(0),
                    value["toSeq"].as_i64().unwrap_or(0),
                ));
            }
            _ => {}
        }
        completions[0] |= drain_completed(&events, &terminal_a);
        completions[1] |= drain_completed(&events, &terminal_b);
    }
    assert!(completions[0], "pane A's drain completes within the window");
    assert!(completions[1], "pane B's drain completes within the window");

    // The completion events fire at ADMISSION: the final pages/chunks may
    // still be in flight on the socket. Drain until quiet before the
    // contiguity check.
    let quiet_drain = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut quiet_streak = 0u8;
    while tokio::time::Instant::now() < quiet_drain && quiet_streak < 3 {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(300)).await else {
            quiet_streak += 1;
            continue;
        };
        quiet_streak = 0;
        let term = value
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let pane = if term == terminal_a {
            0
        } else if term == terminal_b {
            1
        } else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                let start = value["seqStart"].as_i64().unwrap_or(0);
                max_seq[pane] = max_seq[pane].max(end);
                delivered[pane].push((start, end));
            }
            Some("terminal.output.gap") => {
                let reason = value.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(
                    reason, "queue_overflow",
                    "THE BOUND: no drain-induced spill, even in the in-flight tail: {value}"
                );
                declared_gaps.push((
                    pane,
                    value["fromSeq"].as_i64().unwrap_or(0),
                    value["toSeq"].as_i64().unwrap_or(0),
                ));
            }
            _ => {}
        }
    }

    // Production demonstrably outran both attach targets (the completing
    // calls faced real post-target remainders).
    assert!(
        max_seq[0] > target_a,
        "pane A's producer outran its attach target"
    );
    assert!(
        max_seq[1] > target_b,
        "pane B's producer outran its attach target"
    );

    // No undeclared holes: every delivered hole lies inside the pane's
    // DECLARED LOSS — the merged union of its retention-gap intervals
    // (adjacent declared gaps tile, exactly like the client's
    // knownLostRanges merging).
    for pane in [0usize, 1usize] {
        let mut gap_ranges: Vec<(i64, i64)> = declared_gaps
            .iter()
            .filter(|(gap_pane, _, _)| *gap_pane == pane)
            .map(|(_, from, to)| (*from, *to))
            .collect();
        gap_ranges.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::new();
        for (from, to) in gap_ranges {
            match merged.last_mut() {
                Some((_, last_to)) if from <= *last_to + 1 => {
                    *last_to = (*last_to).max(to);
                }
                _ => merged.push((from, to)),
            }
        }
        let mut ranges = delivered[pane].clone();
        ranges.sort_unstable();
        let mut prev_end: Option<i64> = None;
        for (start, end) in &ranges {
            if *start <= 0 {
                continue;
            }
            if let Some(prev) = prev_end {
                if *start > prev + 1 {
                    let hole = (prev + 1, *start - 1);
                    let declared = merged
                        .iter()
                        .any(|(from, to)| hole.0 >= *from && hole.1 <= *to);
                    assert!(
                        declared,
                        "pane {pane} has an undeclared seq hole {hole:?} (declared loss {merged:?})"
                    );
                }
            }
            prev_end = Some(prev_end.map_or(*end, |p| p.max(*end)));
        }
    }
}

/// E2R1 finding 2(b) — the multi-pane zero-spill canary extended with
/// SUB-CAP page requests: the end-to-end shape. Multiple panes restore
/// over ONE connection with `replayPageBytes` far below the production
/// frame size (128 bytes), so every page the session produces is the
/// builder's ATOMIC single-frame result (~4-8.5 KiB, the documented
/// exception to the requested bound). At the canary's own production
/// sizing this proves the whole chain: the sub-cap request is honored
/// as every session's budget, the atomic pages flow and converge, the
/// concurrent drains complete against real post-target remainders, and
/// the connection never self-spills (`queue_overflow` never appears).
///
/// The TIGHT-WATERMARK aggregate bound — the reservation must account
/// max(requested budget, the atomic page ceiling) so concurrent
/// sub-cap drains cannot overbook the admission gate — is pinned
/// deterministically at the writer unit lane
/// (`concurrent_sub_cap_drain_admissions_never_under_reserve_the_atomic_page`),
/// exactly the split the round-5 canary itself uses for its full-size
/// twin (an end-to-end test at a queue small enough to weaponize every
/// legal in-flight shape times out on fixture noise, not on the bound).
#[tokio::test]
async fn sub_cap_page_requests_restore_end_to_end_at_the_atomic_page_bound() {
    const PANES: usize = 2;
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server_with(ring, PAGE_BUDGET, None).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let mut terminals: Vec<String> = Vec::new();
    for pane in 0..PANES {
        terminals.push(create_shell_terminal(&mut driver, &format!("create-subcap-{pane}")).await);
    }
    let arids: Vec<String> = (0..PANES)
        .map(|pane| format!("attach-subcap-{pane}"))
        .collect();

    // The canary's flood discipline: the observer attaches before any
    // flood exists, both panes flood concurrently (bounded,
    // self-terminating), production demonstrably outruns every attach
    // target, and the observer detaches before the restore.
    let mut observer = connect(&url).await;
    hello(&mut observer, false).await;
    for terminal in &terminals {
        attach(&mut observer, terminal, "attach-subcap-observer").await;
    }
    for terminal in &terminals {
        send_input(
            &mut driver,
            terminal,
            &flood_command(100_000, "FLOOD-DONE-MARKER"),
        )
        .await;
    }
    let mut flood_seen = [false; PANES];
    let flood_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !flood_seen.iter().all(|seen| *seen) && tokio::time::Instant::now() < flood_deadline {
        let Some(value) = next_json_or_timeout(&mut observer, Duration::from_secs(2)).await else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let data = value.get("data").and_then(|d| d.as_str()).unwrap_or("");
            let term = value
                .get("terminalId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if data.contains("STREAMDATA") && !data.contains("yes '") {
                if let Some(pane) = terminals
                    .iter()
                    .position(|terminal| terminal.as_str() == term)
                {
                    flood_seen[pane] = true;
                }
            }
        }
    }
    assert!(
        flood_seen.iter().all(|seen| *seen),
        "both floods must be flowing before the restore"
    );
    for terminal in &terminals {
        observer
            .send(WsMessage::Text(
                serde_json::json!({
                    "type": "terminal.detach",
                    "terminalId": terminal,
                })
                .to_string(),
            ))
            .await
            .expect("observer detaches");
    }
    drop(observer);

    // ONE negotiated connection restores BOTH panes with the sub-cap
    // budget. Each attach's first page is read before the next attach.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let mut targets = [0i64; PANES];
    let mut delivered: Vec<Vec<(i64, i64)>> = vec![Vec::new(); PANES];
    let mut credited = [0i64; PANES];
    for pane in 0..PANES {
        let (ready, page) = paced_attach_first_page_with_budget(
            &mut paced,
            &terminals[pane],
            &arids[pane],
            serde_json::json!(128),
        )
        .await;
        targets[pane] = ready["replayToSeq"].as_i64().expect("replayToSeq");
        for frame in &page {
            delivered[pane].push((
                frame["seqStart"].as_i64().unwrap_or(0),
                frame["seqEnd"].as_i64().unwrap_or(0),
            ));
        }
        credited[pane] = page
            .iter()
            .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
            .max()
            .unwrap_or(0);
        assert!(
            credited[pane] > 0,
            "pane {pane}'s first page carries content"
        );
    }
    for pane in 0..PANES {
        credit(&mut paced, &terminals[pane], &arids[pane], credited[pane]).await;
    }

    // Consume at full speed, crediting each pane toward its fixed target
    // and then through the concurrent drains, until BOTH complete. THE
    // BOUND (the canary's): no `queue_overflow` gap may EVER arrive.
    // Retention gaps (`replay_window_exceeded`) are the honest declared
    // loss this fixture's ring churn produces; they are legal.
    let mut declared_gaps: Vec<(usize, i64, i64)> = Vec::new();
    let mut max_seq = [0i64; PANES];
    // The sub-cap contract's load-bearing evidence: the sessions page
    // single frames whose serialized size EXCEEDS the 128-byte request —
    // the documented atomic exception, real on the wire.
    let mut saw_frame_over_budget = false;
    let drain_completed = |terminal_id: &str| -> bool {
        events.lock().unwrap().iter().any(|e| {
            e.message == "ws.restore.paced_complete"
                && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id)
        })
    };
    let pane_of = |term: &str| -> Option<usize> {
        terminals
            .iter()
            .position(|terminal| terminal.as_str() == term)
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "both sub-cap drains must complete within the window"
        );
        // Completion is checked only when the socket goes QUIET: the
        // shared capture vec is process-global, and scanning it per
        // frame would starve this client's reads.
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(2)).await else {
            if terminals.iter().all(|terminal| drain_completed(terminal)) {
                break;
            }
            continue;
        };
        let term = value
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some(pane) = pane_of(&term) else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let start = value["seqStart"].as_i64().unwrap_or(0);
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if value.to_string().len() > 128 {
                    saw_frame_over_budget = true;
                }
                max_seq[pane] = max_seq[pane].max(end);
                delivered[pane].push((start, end));
                // Credit each page toward the pane's fixed target; the
                // FINAL page (end >= target) is not credited — the credit
                // that produced it already started the pane's drain.
                if end > credited[pane] && end < targets[pane] {
                    credited[pane] = end;
                    credit(&mut paced, &terminals[pane], &arids[pane], end).await;
                } else if end > credited[pane] {
                    credited[pane] = end;
                }
            }
            Some("terminal.output.gap") => {
                let reason = value.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(
                    reason, "queue_overflow",
                    "THE BOUND: the gated sub-cap drains must never spill the \
                     connection's own queued pages: {value}"
                );
                declared_gaps.push((
                    pane,
                    value["fromSeq"].as_i64().unwrap_or(0),
                    value["toSeq"].as_i64().unwrap_or(0),
                ));
            }
            _ => {}
        }
    }

    // Drain until quiet before the contiguity check (the completion events
    // fire at admission; the final pages may still be in flight).
    let quiet_drain = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut quiet_streak = 0u8;
    while tokio::time::Instant::now() < quiet_drain && quiet_streak < 3 {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(300)).await else {
            quiet_streak += 1;
            continue;
        };
        quiet_streak = 0;
        let term = value
            .get("terminalId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let Some(pane) = pane_of(&term) else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => delivered[pane].push((
                value["seqStart"].as_i64().unwrap_or(0),
                value["seqEnd"].as_i64().unwrap_or(0),
            )),
            Some("terminal.output.gap") => {
                let reason = value.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(
                    reason, "queue_overflow",
                    "THE BOUND: no spill, even in the in-flight tail: {value}"
                );
                declared_gaps.push((
                    pane,
                    value["fromSeq"].as_i64().unwrap_or(0),
                    value["toSeq"].as_i64().unwrap_or(0),
                ));
            }
            _ => {}
        }
    }

    assert!(
        saw_frame_over_budget,
        "the sub-cap sessions page atomic frames that exceed the 128-byte request \
         (the documented exception, real on the wire)"
    );
    for pane in 0..PANES {
        let start_ev = wait_for_restore_event(
            &events,
            &terminals[pane],
            "ws.restore.paced_start",
            "attach_request_id",
            &arids[pane],
        )
        .await
        .expect("the sub-cap attach emits its paced_start event");
        assert_eq!(
            start_ev.fields.get("page_budget").map(String::as_str),
            Some("128"),
            "the 128-byte replayPageBytes request is pane {pane}'s session budget"
        );
        assert!(
            max_seq[pane] > targets[pane],
            "pane {pane}'s producer outran its attach target (the drain faced a real remainder)"
        );
        // No undeclared holes: every delivered hole lies inside the pane's
        // declared retention loss (the canary's contiguity contract).
        let mut gap_ranges: Vec<(i64, i64)> = declared_gaps
            .iter()
            .filter(|(gap_pane, _, _)| *gap_pane == pane)
            .map(|(_, from, to)| (*from, *to))
            .collect();
        gap_ranges.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::new();
        for (from, to) in gap_ranges {
            match merged.last_mut() {
                Some((_, last_to)) if from <= *last_to + 1 => {
                    *last_to = (*last_to).max(to);
                }
                _ => merged.push((from, to)),
            }
        }
        let mut ranges = delivered[pane].clone();
        ranges.sort_unstable();
        let mut prev_end: Option<i64> = None;
        for (start, end) in &ranges {
            if *start <= 0 {
                continue;
            }
            if let Some(prev) = prev_end {
                if *start > prev + 1 {
                    let hole = (prev + 1, *start - 1);
                    let declared = merged
                        .iter()
                        .any(|(from, to)| hole.0 >= *from && hole.1 <= *to);
                    assert!(
                        declared,
                        "pane {pane} has an undeclared seq hole {hole:?} (declared loss {merged:?})"
                    );
                }
            }
            prev_end = Some(prev_end.map_or(*end, |p| p.max(*end)));
        }
    }
}
/// A producing drain's completion must be BOUNDED and COUNTABLE (the
/// round-2 recapture-loophole fix): the drain completes against a
/// sustained producer with a page count bounded by the ring capacity
/// (the drain target is captured once; no moving-head recapture can grow
/// the count), every delivered seq range is contiguous except across
/// explicitly declared bounds-carrying retention gaps, and production
/// demonstrably continued past the attach target at completion time.
#[tokio::test]
async fn producing_drain_completes_within_a_countable_page_bound_with_no_undeclared_jumps() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-bounded-drain").await;

    let mut primer = start_sustained_flood(
        &url,
        &mut driver,
        &terminal_id,
        "attach-bounded-drain-primer",
    )
    .await;
    primer
        .send(WsMessage::Text(
            serde_json::json!({ "type": "terminal.detach", "terminalId": terminal_id }).to_string(),
        ))
        .await
        .expect("primer detaches");

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-bounded-drain").await;
    let target = ready["replayToSeq"].as_i64().expect("replayToSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        credited > 0,
        "the producer staged content before the attach"
    );

    // Everything the session delivers, in receive order: (seqStart, seqEnd)
    // and every explicitly declared gap interval.
    let mut delivered: Vec<(i64, i64)> = Vec::new();
    let mut declared_gaps: Vec<(i64, i64)> = Vec::new();
    let mut produced_past_target = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    credit(&mut paced, &terminal_id, "attach-bounded-drain", credited).await;
    let mut completed = false;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                let start = value["seqStart"].as_i64().unwrap_or(0);
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                delivered.push((start, end));
                produced_past_target |= end > target;
                if end > credited {
                    credited = end;
                    credit(&mut paced, &terminal_id, "attach-bounded-drain", end).await;
                }
            }
            Some("terminal.output.gap") => {
                assert!(
                    value["reason"] == "replay_window_exceeded"
                        || value["reason"] == "handoff_boundary_reached",
                    "the producing-drain fixture only ever declares retention gaps and \
                     the round-4 fixed-boundary delivery gaps: {value}"
                );
                declared_gaps.push((
                    value["fromSeq"].as_i64().unwrap_or(0),
                    value["toSeq"].as_i64().unwrap_or(0),
                ));
                // A declared gap is also the negotiated continuation
                // cursor: keep crediting the resumed front's pages.
            }
            _ => {}
        }
        if !completed {
            completed = events.lock().unwrap().iter().any(|e| {
                e.message == "ws.restore.paced_complete"
                    && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
            });
        }
        if completed && produced_past_target {
            // Drain the in-flight handoff frames before asserting.
            if delivered.last().map(|(_, e)| *e).unwrap_or(0) > target {
                break;
            }
        }
    }

    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("the producing drain completes within the deadline");
    let pages: u64 = complete
        .fields
        .get("pages")
        .and_then(|v| v.parse::<u64>().ok())
        .expect("pages recorded");
    // THE countable bound: the session's pages are bounded by the ring
    // capacity scaled by the page budget (each page carries real content
    // toward a FIXED target; retention expiry shrinks the drain range,
    // never grows it). A recapturing chase grows the page count without
    // bound while production runs.
    let bound: u64 = 8 * (ring as u64 / PAGE_BUDGET as u64) + 64;
    assert!(
        pages <= bound,
        "the session's page count is bounded by ring capacity ({pages} pages, bound {bound})"
    );
    assert!(
        produced_past_target,
        "the fixture's producer demonstrably outran the attach target"
    );

    // No silent forward jumps: the delivered ranges tile contiguously
    // from the first delivered seq, and every hole between consecutive
    // ranges lies inside an explicitly declared gap interval.
    let mut ranges = delivered.clone();
    ranges.sort_unstable();
    let mut prev_end: Option<i64> = None;
    for (start, end) in &ranges {
        if *start <= 0 {
            continue;
        }
        if let Some(prev) = prev_end {
            if *start > prev + 1 {
                let hole = (prev + 1, *start - 1);
                let declared = declared_gaps
                    .iter()
                    .any(|(from, to)| hole.0 >= *from && hole.1 <= *to);
                assert!(
                    declared,
                    "undeclared seq hole {hole:?} between delivered ranges (gaps: {declared_gaps:?})"
                );
            }
        }
        prev_end = Some(prev_end.map_or(*end, |p| p.max(*end)));
    }

    // Cleanup: stop the flood.
    send_input(&mut paced, &terminal_id, "\u{3}").await;
}

/// Live output produced DURING the paced replay is delivered strictly after
/// the pages covering it, in seq order, with no loss or duplication — the
/// hard "no overtaking" invariant, end to end.
#[tokio::test]
async fn live_output_during_paced_replay_never_overtakes_the_pages() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-live-race").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    let marker1 = "FLOOD-DONE-MARKER";
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-live").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let first_page_last = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        last_seq < head,
        "the session starts mid-replay (head {head}, first page ends {last_seq}, frames {})",
        page1.len()
    );

    // MORE live output while the replay is in flight (deferred — staged).
    // A non-negotiated observer attaches (inline replay + direct live) and
    // drives the flood to completion — the deterministic "it finished" signal.
    let mut midflood = connect(&url).await;
    hello(&mut midflood, false).await;
    attach(&mut midflood, &terminal_id, "attach-midflood").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut midflood, &terminal_id, &flood_command(300, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (mid_acc, _) = drain_until_marker(&mut midflood, marker2, deadline).await;
    assert!(
        mid_acc.contains(marker2),
        "the mid flood completes on its own observer"
    );
    drop(midflood);

    // Credit through to completion; the tail delivers the staged range
    // spontaneously once the cursor reaches the target.
    let mut received: Vec<(i64, String)> = page1
        .iter()
        .map(|f| {
            (
                f["seqStart"].as_i64().unwrap_or(0),
                f["data"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = last_seq;
    // Un-pause the session: the first page is the one outstanding page, so
    // credit it before waiting for the next.
    credit(&mut paced, &terminal_id, "attach-live", first_page_last).await;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            received.push((
                value["seqStart"].as_i64().unwrap_or(0),
                value["data"].as_str().unwrap_or("").to_string(),
            ));
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-live", end).await;
            }
            let acc: String = received.iter().map(|(_, d)| d.as_str()).collect();
            if acc.contains(marker2) {
                break;
            }
        }
    }
    let acc: String = received.iter().map(|(_, d)| d.as_str()).collect();
    assert!(
        acc.contains(marker1) && acc.contains(marker2),
        "the session delivers both floods"
    );

    // The hard invariant: strictly ascending seqs, no duplicates, and every
    // delivered frame lies at or after the FIRST page's range (nothing the
    // pages cover is re-delivered, and no live frame jumped the pages).
    let seqs: Vec<i64> = received.iter().map(|(s, _)| *s).collect();
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(seqs.len(), sorted.len(), "no duplicate seqStarts");
    assert_eq!(seqs, sorted, "delivery is strictly in seq order");
    assert!(seqs[0] >= 1, "the first page starts at the baseline+1");
    // Every seq from the attach baseline to the end is covered exactly once.
    for expected in seqs[0]..=*seqs.last().unwrap() {
        assert!(
            seqs.contains(&expected),
            "no seq holes: {expected} missing from {:?}",
            &seqs[..seqs.len().min(20)]
        );
    }
}

/// Retention expiry MID-REPLAY: the negotiated `terminal.output.gap` with
/// reason `replay_window_exceeded`, the exact lost interval, the task-2
/// bounds fields, and continuation from the new baseline through to the
/// session's target.
#[tokio::test]
async fn mid_replay_retention_expiry_emits_the_exact_negotiated_gap_and_continues() {
    // Small ring so a withheld session loses its middle to eviction.
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-expiry").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-expiry").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("the first page covers something");
    assert!(last_seq < head);

    // Evict the middle of the replay window while the client withholds.
    // The evictor attaches (non-negotiated — inline replay + live) to
    // observe its own flood's completion deterministically.
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-evictor").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut evictor, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(acc.contains(marker2), "the evicting flood completes");
    drop(evictor);

    // Credit: the next needed frames were evicted => the negotiated gap.
    credit(&mut paced, &terminal_id, "attach-expiry", last_seq).await;
    let gap = loop {
        let value = next_json(&mut paced).await;
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output.gap") => break value,
            Some("terminal.output") => continue, // tail leakage of pre-eviction pages
            other => panic!("expected the retention gap, got {other:?} ({value})"),
        }
    };
    assert_eq!(
        gap["reason"], "replay_window_exceeded",
        "the gap names retention loss: {gap}"
    );
    assert_eq!(
        gap["fromSeq"].as_i64(),
        Some(last_seq + 1),
        "the lost interval starts at the credited cursor+1: {gap}"
    );
    let gap_oldest = gap["oldestRetainedSeq"]
        .as_i64()
        .expect("negotiated gap carries oldestRetainedSeq");
    let gap_head = gap["headSeq"]
        .as_i64()
        .expect("negotiated gap carries headSeq");
    assert_eq!(
        gap["toSeq"].as_i64(),
        Some(gap_oldest - 1),
        "the lost interval ends just before the new ring front: {gap}"
    );
    assert!(gap_head >= head, "the bounds are current: {gap}");
    assert_eq!(gap["attachRequestId"], "attach-expiry");

    // Continuation from the new baseline: the next page starts at the ring
    // front and the session still reaches its original target + the live
    // tail (both markers).
    let mut received: Vec<i64> = Vec::new();
    let mut data = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = gap["toSeq"].as_i64().unwrap();
    while tokio::time::Instant::now() < deadline {
        let value = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await;
        let Some(value) = value else { break };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let seq = value["seqStart"].as_i64().unwrap_or(0);
            assert!(
                seq >= gap_oldest,
                "continuation starts at the new baseline (ring front {gap_oldest}), got seq {seq}"
            );
            received.push(seq);
            data.push_str(value["data"].as_str().unwrap_or(""));
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-expiry", end).await;
            }
            if data.contains(marker2) {
                break;
            }
        }
    }
    assert!(
        data.contains(marker2),
        "the session continues through the retained range to the live tail"
    );
    let mut sorted = received.clone();
    sorted.sort_unstable();
    assert_eq!(received, sorted, "continuation pages ascend");
}

/// A re-attach supersedes the old session: the old generation's credit is
/// ignored (stale), the new generation's credit drives its own pages.
#[tokio::test]
async fn reattach_supersedes_the_old_paced_session() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-supersede").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 500).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready1, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-1").await;
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-1 first page");
    assert!(last1 < ready1["headSeq"].as_i64().unwrap());

    // Re-attach (generation 2): a fresh ready + fresh first page; the
    // attach.ready supersede also discards gen-1's un-leased frames.
    let (ready2, page2) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-2").await;
    assert_eq!(ready2["attachRequestId"], "attach-gen-2");
    let last2 = page2
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-2 first page");
    assert!(
        page2.iter().all(|f| f["attachRequestId"] == "attach-gen-2"),
        "gen-2's pages are stamped with gen-2's id"
    );

    // The OLD generation's credit is stale: nothing arrives.
    credit(&mut paced, &terminal_id, "attach-gen-1", last1).await;
    let stale = next_json_or_timeout(&mut paced, Duration::from_millis(1200)).await;
    assert!(
        stale.is_none()
            || stale.as_ref().unwrap().get("type").and_then(|v| v.as_str())
                != Some("terminal.output"),
        "a stale-generation credit must be ignored, got {stale:?}"
    );

    // The NEW generation's credit drives its own session.
    credit(&mut paced, &terminal_id, "attach-gen-2", last2).await;
    let next = next_json(&mut paced).await;
    assert_eq!(next["type"], "terminal.output");
    assert_eq!(next["attachRequestId"], "attach-gen-2");
    assert!(
        next["seqEnd"].as_i64().unwrap_or(0) > last2,
        "gen-2's pages continue from its own cursor"
    );
}

/// The binding supersede rule covers EVERY successful re-attach, not just
/// the paced one: an arid-less LEGACY re-attach (the negotiated fallback
/// shape) must also cancel the connection's previous paced session for the
/// terminal — a credit for the superseded generation must produce NOTHING
/// (no `terminal.output`, no `terminal.output.batch`), and the connection
/// must keep working afterwards.
#[tokio::test]
async fn legacy_reattach_cancels_the_stale_paced_session() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-supersede").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    // Generation 1: the paced attach starts a session whose first page is
    // a bounded prefix (the session is ACTIVE, mid-replay).
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready1, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-gen-1").await;
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("gen-1 first page");
    assert!(
        last1 < ready1["headSeq"].as_i64().unwrap(),
        "the session is mid-replay (supersede-able)"
    );

    // The arid-less LEGACY re-attach: the whole window replays inline.
    attach_without_arid(&mut paced, &terminal_id).await;
    let (ready2, outputs) = legacy_attach_inline_replay(&mut paced, &terminal_id).await;
    assert!(
        ready2
            .get("attachRequestId")
            .and_then(|v| v.as_str())
            .is_none(),
        "the re-attach carried no attachRequestId: {ready2}"
    );
    let head = ready2["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "the legacy re-attach replays the whole window inline"
    );

    // The superseded generation's credit (its arid + in-window consumedSeq):
    // it must be ignored — no output frame of ANY kind may be produced.
    credit(&mut paced, &terminal_id, "attach-gen-1", last1).await;
    let stale = next_json_or_timeout(&mut paced, Duration::from_millis(1500)).await;
    let is_output_frame = |v: &serde_json::Value| {
        matches!(
            v.get("type").and_then(|t| t.as_str()),
            Some("terminal.output") | Some("terminal.output.batch")
        )
    };
    assert!(
        stale.as_ref().map(|v| !is_output_frame(v)).unwrap_or(true),
        "a credit for the session superseded by the legacy re-attach must \
         produce nothing, got {stale:?}"
    );

    // The connection is not wedged by the cancel: live output keeps
    // flowing to the re-attached (legacy) subscriber.
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut paced, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after the superseded credit"
    );
}

/// A credit on a NON-NEGOTIATED connection is inert: no pacing machinery
/// engages, inline delivery continues to work exactly as before.
#[tokio::test]
async fn credit_on_a_non_negotiated_connection_is_inert() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-plain-credit").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs) = paced_attach_first_page(&mut plain, &terminal_id, "attach-plain").await;
    // Non-negotiated: the FULL inline replay arrived immediately.
    let head = ready["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "a non-negotiated attach gets the whole replay inline"
    );
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "no contract fields for a plain connection"
    );

    // The inert credit: live output keeps flowing inline afterwards.
    credit(&mut plain, &terminal_id, "attach-plain", max_seq).await;
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after an inert credit"
    );
}

/// A disconnect mid-replay leaves the terminal RUNNING and clean: a
/// subsequent (non-negotiated) attach gets the full replay and live output —
/// no leak, no wedge.
#[tokio::test]
async fn disconnect_mid_replay_leaves_the_terminal_running_and_reattachable() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-disconnect").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-doomed").await;
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert!(
        last_seq < ready["headSeq"].as_i64().unwrap(),
        "mid-replay before the drop"
    );
    drop(paced); // the socket dies mid-replay (no detach, no credit)

    tokio::time::sleep(Duration::from_millis(300)).await;

    // A fresh non-negotiated connection attaches and gets the full replay.
    let mut fresh = connect(&url).await;
    hello(&mut fresh, false).await;
    let (ready2, outputs) = paced_attach_first_page(&mut fresh, &terminal_id, "attach-after").await;
    let head = ready2["headSeq"].as_i64().unwrap();
    let max_seq = outputs
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .unwrap_or(0);
    assert_eq!(
        max_seq, head,
        "the full replay is intact after the dropped paced session"
    );

    // And live output still flows.
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut fresh, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows after the re-attach"
    );
}

/// The `ws.restore.*` observability contract, pinned end-to-end on the real
/// dispatch: `ws.restore.paced_start` carries its identifiers/measurements
/// (including `maxReplayBytes`), `ws.restore.paced_complete` closes the
/// session, and all FOUR `ws.restore.credit` verdicts (accepted /
/// stale_generation / beyond_window / non_negotiated) are emitted with their
/// status field — and NO event ever carries terminal CONTENT (identifiers
/// and measurements only).
#[tokio::test]
async fn restore_observability_events_are_emitted_content_free() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-observability").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // The negotiated attach carries a maxReplayBytes request (the TERM-07
    // seam) — it must ride the paced_start event.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    paced
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.attach",
                "terminalId": terminal_id,
                "intent": "viewport_hydrate",
                "cols": 80,
                "rows": 24,
                "attachRequestId": "attach-ev",
                "sinceSeq": 0,
                "maxReplayBytes": 262144,
            })
            .to_string(),
        ))
        .await
        .expect("send attach with maxReplayBytes");
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-ev").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let last_seq = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page");
    let page_bytes: u64 = page1.iter().map(|f| f.to_string().len() as u64).sum();

    // paced_start: identifiers + measurements, maxReplayBytes included.
    let start_ev =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_start")
            .await
            .expect("ws.restore.paced_start is emitted on the negotiated attach");
    assert_eq!(
        start_ev.fields.get("attach_request_id").map(String::as_str),
        Some("attach-ev")
    );
    assert_eq!(
        start_ev.fields.get("requested_since").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        start_ev.fields.get("effective_since").map(String::as_str),
        Some("0")
    );
    assert_eq!(
        start_ev.fields.get("target").map(String::as_str),
        Some(head.to_string().as_str()),
        "target is the attach-time head"
    );
    assert_eq!(
        start_ev.fields.get("max_replay_bytes").map(String::as_str),
        Some("Some(262144)"),
        "the TERM-07 seam value rides the event (Debug of Option<i64>)"
    );
    assert_eq!(
        start_ev.fields.get("page_bytes").map(String::as_str),
        Some(page_bytes.to_string().as_str()),
        "page_bytes is the first page's real serialized size"
    );

    // beyond_window: a consumedSeq past the last-sent page's end is ignored.
    credit(&mut paced, &terminal_id, "attach-ev", last_seq + 100_000).await;
    let beyond = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "beyond_window",
    )
    .await
    .expect("the beyond-window credit is observed");
    assert_eq!(
        beyond.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );
    assert_eq!(
        beyond
            .fields
            .get("consumed_seq")
            .and_then(|v| v.parse::<i64>().ok()),
        Some(last_seq + 100_000)
    );

    // stale_generation: a credit for an attachRequestId no active session
    // holds is a stale generation.
    credit(&mut paced, &terminal_id, "attach-bogus", last_seq).await;
    let stale = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "stale_generation",
    )
    .await
    .expect("the stale-generation credit is observed");
    assert_eq!(
        stale.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );

    // accepted: a valid credit produces the next page...
    credit(&mut paced, &terminal_id, "attach-ev", last_seq).await;
    let accepted = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "accepted",
    )
    .await
    .expect("the valid credit is observed as accepted");
    assert_eq!(
        accepted
            .fields
            .get("consumed_seq")
            .and_then(|v| v.parse::<i64>().ok()),
        Some(last_seq)
    );
    // ...and the page actually arrives (the event describes real behavior).
    let next = next_json(&mut paced).await;
    assert_eq!(next["type"], "terminal.output");

    // Drive the session to completion; the tail drains un-credited and the
    // registry's atomic clear completes the session.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut credited = next["seqEnd"].as_i64().unwrap_or(last_seq);
    credit(&mut paced, &terminal_id, "attach-ev", credited).await;
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output") {
            let end = value["seqEnd"].as_i64().unwrap_or(0);
            if end > credited {
                credited = end;
                credit(&mut paced, &terminal_id, "attach-ev", end).await;
            }
        }
    }
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("ws.restore.paced_complete closes the session");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-ev")
    );
    assert_eq!(
        complete.fields.get("last_seq").map(String::as_str),
        Some(credited.to_string().as_str()),
        "last_seq is the session's final cursor"
    );
    assert!(
        complete
            .fields
            .get("pages")
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|pages| pages >= 2),
        "pages counts every page the session produced"
    );

    // non_negotiated: a credit from a connection that never negotiated the
    // paced capability is inert and observed as such.
    credit(&mut driver, &terminal_id, "attach-ev", 0).await;
    let non_negotiated = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "non_negotiated",
    )
    .await
    .expect("the non-negotiated connection's credit is observed as inert");
    assert_eq!(
        non_negotiated.fields.get("terminal_id").map(String::as_str),
        Some(terminal_id.as_str())
    );

    // Identifiers/measurements only: NO terminal content ever leaks into a
    // ws.restore.* event for this terminal (the flood payload and its
    // marker must be absent from every event field).
    let captured = events.lock().unwrap();
    for event in captured.iter().filter(|e| {
        e.message.starts_with("ws.restore.")
            && e.fields.get("terminal_id").map(String::as_str) == Some(terminal_id.as_str())
    }) {
        for (name, value) in &event.fields {
            assert!(
                !value.contains("STREAMDATA") && !value.contains("FLOOD-DONE-MARKER"),
                "terminal content leaked into ws.restore.{name}={value}"
            );
        }
    }
}

// ── Mixed-version compatibility matrix (responsive-terminal-restore,
// task-008): old client → new server on the real socket ──────────────────

/// Old client → new server, ATTACH on large scrollback (matrix cell 1): a
/// non-negotiated attach sees the FULL inline replay in one unprompted
/// burst — far beyond one paced page budget, so pacing provably never
/// engaged — with NO new ready fields, NO gap frames, contiguous coverage,
/// and a raw credit send that is inert (observed as
/// `ws.restore.credit status=non_negotiated`, producing nothing).
#[tokio::test]
async fn non_negotiated_attach_on_large_scrollback_stays_legacy_inline_and_credits_are_inert() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-large").await;
    // ~64KB of scrollback: many 4KB pages had pacing (wrongly) engaged.
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs, gaps) =
        attach_burst_collecting_gaps(&mut plain, &terminal_id, "attach-legacy-large").await;

    // NO new ready fields for the non-negotiated connection.
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "an old client's attach.ready must not gain contract fields: {ready}"
    );
    assert!(
        ready.get("replayResetReason").is_none(),
        "an old client's attach.ready must not carry a reset reason: {ready}"
    );
    let head = ready["headSeq"].as_i64().expect("headSeq");

    // The whole window arrived unprompted: contiguous coverage to the head,
    // and the burst is far beyond one page budget (no pages, no credit gate).
    let burst_bytes: usize = outputs.iter().map(|f| f.to_string().len()).sum();
    assert!(
        burst_bytes as i64 > PAGE_BUDGET,
        "the unprompted burst ({burst_bytes}B) must exceed one page budget \
         ({PAGE_BUDGET}B) — a paced first page would have been bounded"
    );
    let seqs = covered_seqs(&outputs);
    assert_eq!(
        seqs.iter().min(),
        Some(&1),
        "the inline replay starts at the window baseline"
    );
    assert_eq!(
        seqs.iter().max(),
        Some(&head),
        "the inline replay reaches the head ({head})"
    );
    let mut contiguous: Vec<i64> = seqs.iter().copied().collect();
    contiguous.dedup();
    assert_eq!(
        contiguous.len() as i64,
        head,
        "the inline replay is contiguous with no holes"
    );
    assert!(
        gaps.is_empty(),
        "an old client's attach burst must contain no gap frames: {gaps:?}"
    );

    // The raw credit send: inert. Observed as the non_negotiated verdict...
    credit(&mut plain, &terminal_id, "attach-legacy-large", head).await;
    let _inert = wait_for_restore_event(
        &events,
        &terminal_id,
        "ws.restore.credit",
        "status",
        "non_negotiated",
    )
    .await
    .expect("a non-negotiated connection's credit must be classified non_negotiated");

    // ...and it produces nothing.
    let after = next_json_or_timeout(&mut plain, Duration::from_millis(1200)).await;
    assert!(
        after
            .as_ref()
            .map(|v| v.get("type").and_then(|t| t.as_str()) != Some("terminal.output"))
            .unwrap_or(true),
        "an inert credit must produce no output, got {after:?}"
    );

    // Live output keeps flowing after the inert credit (the connection is
    // not wedged by the refused pacing machinery).
    let marker = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker, deadline).await;
    assert!(
        acc.contains(marker),
        "live output flows normally after an inert credit"
    );
}

/// Old client + retention loss → NO new gap (matrix cell 2): a
/// non-negotiated attach whose `sinceSeq` predates the retained history
/// receives the retained tail SILENTLY — today's behavior, never the
/// negotiated `replay_window_exceeded` gap — on a real server with an
/// evicted ring.
#[tokio::test]
async fn non_negotiated_attach_after_retention_loss_gets_the_retained_tail_silently() {
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-legacy-evict").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // Evict the ring front: a non-negotiated evictor drives a bigger flood
    // to completion (its own inline replay + live tail observe the marker).
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-evictor-legacy").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(acc.contains(marker2), "the evicting flood completes");
    drop(evictor);

    // The old client attaches with sinceSeq 0 — predating the retained ring.
    let mut plain = connect(&url).await;
    hello(&mut plain, false).await;
    let (ready, outputs, gaps) =
        attach_burst_collecting_gaps(&mut plain, &terminal_id, "attach-legacy-evict").await;

    // THE matrix pin: no `replay_window_exceeded` may reach an old client —
    // the retention loss is reported the way today's server does: silently.
    assert!(
        gaps.is_empty(),
        "an old client must never receive the newly introduced retention gap: {gaps:?}"
    );
    assert!(
        ready.get("oldestRetainedSeq").is_none(),
        "an old client's attach.ready must not gain contract fields: {ready}"
    );
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let replay_from = ready["replayFromSeq"].as_i64().expect("replayFromSeq");
    assert!(
        replay_from > 1,
        "the fixture must have evicted the ring front: {ready}"
    );

    // The retained tail arrives silently: exactly [replay_from, head],
    // starting at the ring front, contiguous, no phantom pre-eviction bytes.
    let seqs = covered_seqs(&outputs);
    assert!(!seqs.is_empty(), "there is a retained tail to deliver");
    assert_eq!(
        seqs.iter().min(),
        Some(&replay_from),
        "the silent tail starts at the ring front: {ready}"
    );
    assert_eq!(
        seqs.iter().max(),
        Some(&head),
        "the silent tail reaches the head"
    );
    let mut contiguous: Vec<i64> = seqs.iter().copied().collect();
    contiguous.dedup();
    assert_eq!(
        contiguous.len() as i64,
        head - replay_from + 1,
        "the silent tail is contiguous with no holes"
    );

    // Live output continues after the silent retained tail (no stall).
    let marker3 = "FLOOD-DONE-MARKER";
    send_input(&mut driver, &terminal_id, &flood_command(30, marker3)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let (acc, _) = drain_until_marker(&mut plain, marker3, deadline).await;
    assert!(
        acc.contains(marker3),
        "live output flows normally after the silent retained tail"
    );
}

/// Mixed connections on ONE terminal (matrix cell 4): a negotiated client and
/// a non-negotiated client attached to the SAME terminal simultaneously —
/// the negotiated one gets paced pages (credit-gated), the non-negotiated
/// one gets the legacy inline replay; no cross-talk in either direction, and
/// both converge to the SAME frame content (identical seq coverage and
/// identical concatenated data — equality modulo pacing/batching shape).
#[tokio::test]
async fn mixed_negotiated_and_legacy_attachments_converge_without_cross_talk() {
    let events = global_capture();
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-mixed").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 400).await;

    // The negotiated client attaches first: one bounded page, mid-replay.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (paced_ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-mix-paced").await;
    let head = paced_ready["headSeq"].as_i64().expect("headSeq");
    let last1 = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("the first page covers something");
    assert!(
        last1 < head,
        "the negotiated session is mid-replay (head {head})"
    );

    // The legacy twin attaches to the SAME terminal while the paced session
    // is mid-replay: the FULL window arrives inline, immediately.
    let mut legacy = connect(&url).await;
    hello(&mut legacy, false).await;
    let (legacy_ready, legacy_outputs, legacy_gaps) =
        attach_burst_collecting_gaps(&mut legacy, &terminal_id, "attach-mix-legacy").await;
    assert!(
        legacy_gaps.is_empty(),
        "the legacy twin must see no gap frames: {legacy_gaps:?}"
    );
    assert!(
        legacy_ready.get("oldestRetainedSeq").is_none(),
        "the legacy twin's ready must stay pre-contract: {legacy_ready}"
    );
    let legacy_seqs = covered_seqs(&legacy_outputs);
    assert_eq!(
        legacy_seqs.iter().max(),
        Some(&head),
        "the legacy twin gets the whole window inline"
    );

    // No cross-talk, direction 1: the other connection's attach must NOT
    // cancel the negotiated session — its credit still produces its page...
    credit(&mut paced, &terminal_id, "attach-mix-paced", last1).await;
    let next = next_json(&mut paced).await;
    assert_eq!(
        next["type"], "terminal.output",
        "the negotiated session survives the legacy attach: {next}"
    );
    assert_eq!(next["attachRequestId"], "attach-mix-paced");

    // No cross-talk, direction 2: while the negotiated session withholds,
    // the legacy attach must not leak pages to it (the next unprompted
    // frame on the negotiated side is only the one its own credit bought).
    let mut paced_frames = page1.clone();
    let next_end = next["seqEnd"].as_i64().unwrap_or(last1);
    paced_frames.push(next);
    let mut credited = next_end;
    // Credit every consumed frame's end — a page may span several frames
    // (or one atomic over-budget frame per page), and the NEXT page is
    // produced only on a credit inside the delivered window.
    credit(&mut paced, &terminal_id, "attach-mix-paced", credited).await;
    let mut saw_head = credited >= head;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_secs(5)).await else {
            assert!(
                saw_head,
                "the paced replay stalled before its target (head {head}, credited {credited})"
            );
            break;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("terminal.output") {
            continue;
        }
        assert_eq!(
            value["attachRequestId"], "attach-mix-paced",
            "only the negotiated session's own pages arrive: {value}"
        );
        let end = value["seqEnd"].as_i64().unwrap_or(0);
        saw_head |= end >= head;
        paced_frames.push(value);
        if end > credited {
            credited = end;
            credit(&mut paced, &terminal_id, "attach-mix-paced", end).await;
        }
    }
    let complete =
        wait_for_restore_event_of_terminal(&events, &terminal_id, "ws.restore.paced_complete")
            .await
            .expect("the negotiated session reaches paced_complete");
    assert_eq!(
        complete.fields.get("attach_request_id").map(String::as_str),
        Some("attach-mix-paced")
    );

    // Convergence: identical seq coverage and identical concatenated data —
    // the paced side (pages, credit-gated) and the legacy side (one inline
    // burst) delivered the same terminal content, modulo pacing shape.
    let paced_seqs = covered_seqs(&paced_frames);
    assert_eq!(paced_seqs, legacy_seqs, "both sides cover the same seqs");
    assert_eq!(
        paced_seqs.iter().min(),
        Some(&1),
        "both sides cover from the window baseline"
    );
    assert_eq!(
        paced_seqs.iter().max(),
        Some(&head),
        "both sides reach the head"
    );
    let paced_data = concatenated_data(&paced_frames);
    let legacy_data = concatenated_data(&legacy_outputs);
    assert_eq!(
        paced_data, legacy_data,
        "both sides delivered byte-identical content"
    );
}

/// E2R1 finding 1 (a) + finding 4: a natural exit mid-restore sequences
/// behind the session's normal CREDITED completion — and the ordering is
/// asserted over the FULL frame stream. A CREDITING client drives the
/// whole deferred range one page per credit in ascending order, and
/// terminal.exit is the LAST frame: exactly one exit, every output frame
/// (and the final marker produced past the attach target) precedes it,
/// and NOTHING follows it — the test keeps reading for a deterministic
/// quiet window after the exit and any frame that arrived would fail the
/// asserts. (The old test broke on the FIRST exit, so its output arm
/// could never observe a post-exit frame — the stated claim was
/// unproven. The pre-fix behavior this replaces: the exit-drain removed
/// the still-credited session and dumped its whole window uncredited.)
#[tokio::test]
async fn natural_exit_mid_restore_sequences_final_output_before_terminal_exit() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-exit-mid-restore").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    // Negotiate a paced attach and do NOT credit yet: the session sits
    // in the credited phase, its deferral armed, with the replay window
    // still open when the shell exits.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-exit").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page frames");
    assert!(
        credited < head,
        "the session is mid-restore when the shell exits (page end {credited}, head {head})"
    );

    // The shell produces one FINAL marker line and exits naturally. The
    // octal escapes keep the echoed command from printing the marker early.
    send_input(
        &mut paced,
        &terminal_id,
        "printf '\\106\\111\\116\\101\\114\\055\\115\\101\\122\\113\\105\\122\\012'; exit\n",
    )
    .await;

    // The client already consumed the first page before the exit — its
    // continuation credit is due NOW. From here the flow is pure
    // credit-pacing: each credit grants the next page through the whole
    // deferred range, and the exit sequences behind the credited
    // completion.
    credit(&mut paced, &terminal_id, "attach-exit", credited).await;

    // Collect EVERY frame until a deterministic quiet window closes AFTER
    // the exit (finding 4: the ordering is asserted over the FULL frame
    // stream — the old test broke on the first exit, so its output arm
    // could never observe a post-exit frame).
    let mut saw_exit = false;
    let mut exits = 0usize;
    let mut acc = String::new();
    let mut seqs: Vec<i64> = Vec::new();
    let mut output_frames = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let window = if saw_exit {
            Duration::from_millis(750)
        } else {
            Duration::from_secs(5)
        };
        let Some(value) = next_json_or_timeout(&mut paced, window).await else {
            if saw_exit {
                break; // quiet AFTER the exit: the stream is provably complete
            }
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                assert!(!saw_exit, "no output may follow terminal.exit: {value}");
                seqs.push(value["seqStart"].as_i64().unwrap_or(0));
                if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                    acc.push_str(data);
                }
                output_frames += 1;
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if end > credited {
                    credited = end;
                    credit(&mut paced, &terminal_id, "attach-exit", end).await;
                }
            }
            Some("terminal.exit") => {
                saw_exit = true;
                exits += 1;
                assert_eq!(
                    exits, 1,
                    "exactly one terminal.exit may ever arrive: {value}"
                );
            }
            _ => {}
        }
    }
    assert!(
        saw_exit,
        "terminal.exit must arrive — the staged exit delivers at the session's \
         CREDITED completion (pages flow only on credits)"
    );
    assert!(
        acc.contains("FINAL-MARKER"),
        "the deferred final output is delivered before the exit (got {output_frames} frames)"
    );
    assert!(
        output_frames > 1,
        "the deferred range paged before the exit ({output_frames} frames)"
    );
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(
        seqs, sorted,
        "every delivered frame precedes the exit in ascending seq order"
    );
    // exit is the LAST frame: the loop only breaks on a quiet window
    // AFTER the exit — any frame that arrived in it failed the asserts
    // above, so reaching here proves nothing followed the exit.
}

/// E2R1 finding 1 (b): the pacing contract PINNED at the exit boundary.
/// A client that WITHHOLDS credits after a natural exit mid-restore
/// receives NO further pages and NO exit — asserted as absence over a
/// deterministic window — and the flow RESUMES on the next credit (the
/// deferred final output pages only on credits, and the exit sequences
/// behind the session's credited completion). The pre-fix behavior this
/// guards against: the exit-drain removed the still-credited session and
/// dumped its whole window (plus the exit) uncredited, as fast as the
/// socket accepted it.
#[tokio::test]
async fn natural_exit_mid_restore_withholding_client_gets_no_pages_and_no_exit_until_it_credits() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-exit-withhold").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    // Negotiate a paced attach and do NOT credit: the session sits in
    // the credited phase, its deferral armed, mid-restore.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-exit-hold").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page frames");
    assert!(
        credited < head,
        "the session is mid-restore when the shell exits"
    );

    // The shell produces one FINAL marker line and exits naturally.
    send_input(
        &mut paced,
        &terminal_id,
        "printf '\\106\\111\\116\\101\\114\\055\\115\\101\\122\\113\\105\\122\\012'; exit\n",
    )
    .await;

    // THE WITHHOLD: no credits. Over a deterministic window, NOTHING may
    // arrive — no page, no gap, no exit. (Give the exit a moment to
    // stage, then hold: the window covers both.)
    let hold_deadline = tokio::time::Instant::now() + Duration::from_millis(2_000);
    while tokio::time::Instant::now() < hold_deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(250)).await else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => panic!(
                "no page may flow while the client withholds credits \
                 (the deferred final output pages ONLY on credits): {value}"
            ),
            Some("terminal.output.gap") => {
                panic!("no gap may flow while the client withholds credits: {value}")
            }
            Some("terminal.exit") => panic!(
                "no exit may arrive while pages remain undelivered — the exit \
                 sequences behind the session's CREDITED completion: {value}"
            ),
            _ => {}
        }
    }

    // RESUME ON CREDIT: the first credit pages the deferred range, and
    // the flow converges — the marker, then the exit LAST (the same
    // full-stream ordering as the crediting case).
    credit(&mut paced, &terminal_id, "attach-exit-hold", credited).await;
    let mut saw_exit = false;
    let mut exits = 0usize;
    let mut acc = String::new();
    let mut seqs: Vec<i64> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let window = if saw_exit {
            Duration::from_millis(750)
        } else {
            Duration::from_secs(5)
        };
        let Some(value) = next_json_or_timeout(&mut paced, window).await else {
            if saw_exit {
                break;
            }
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                assert!(!saw_exit, "no output may follow terminal.exit: {value}");
                seqs.push(value["seqStart"].as_i64().unwrap_or(0));
                if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                    acc.push_str(data);
                }
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if end > credited {
                    credited = end;
                    credit(&mut paced, &terminal_id, "attach-exit-hold", end).await;
                }
            }
            Some("terminal.exit") => {
                saw_exit = true;
                exits += 1;
                assert_eq!(exits, 1, "exactly one terminal.exit: {value}");
            }
            _ => {}
        }
    }
    assert!(
        saw_exit,
        "the flow resumes on credit and the exit arrives last"
    );
    assert!(
        acc.contains("FINAL-MARKER"),
        "the deferred final output resumed on credit and was delivered"
    );
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted, "the resumed pages ascend");
}

/// E2R1 finding 1 (c): retention expiry while the exit-staged session
/// WAITS on credits. The ring's front evicts the credited window's next
/// needed frames while the client withholds; the client's next credit
/// reports the EXACT bounds-carrying gap, the continuation pages only on
/// credits through the retained window, and the exit is the LAST frame.
#[tokio::test]
async fn natural_exit_mid_restore_retention_expiry_reports_the_exact_gap_then_exit() {
    // Small ring so a withheld session loses its middle to eviction.
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-exit-expiry").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // Negotiate a paced attach and do NOT credit: the session sits in
    // the credited phase, mid-restore.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) = paced_attach_first_page(&mut paced, &terminal_id, "attach-exit-exp").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page frames");
    assert!(
        credited < head,
        "the session is mid-restore when the ring churns"
    );

    // Evict the middle of the replay window while the client withholds
    // (the evictor attaches non-negotiated and observes its own flood's
    // completion deterministically).
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-exit-evictor").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut evictor, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (evictor_acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(
        evictor_acc.contains(marker2),
        "the evicting flood completes"
    );
    drop(evictor);

    // The shell now produces one FINAL marker line and exits naturally,
    // staging the exit behind the still-armed session. The exit must
    // NOT deliver anything while the client withholds.
    send_input(
        &mut paced,
        &terminal_id,
        "printf '\\106\\111\\116\\101\\114\\062\\055\\115\\101\\122\\113\\105\\122\\012'; exit\n",
    )
    .await;
    let hold_deadline = tokio::time::Instant::now() + Duration::from_millis(1_500);
    while tokio::time::Instant::now() < hold_deadline {
        let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(250)).await else {
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") | Some("terminal.output.gap") | Some("terminal.exit") => {
                panic!(
                    "nothing may flow while the client withholds credits — the exact \
                 gap reports only on the next credit: {value}"
                )
            }
            _ => {}
        }
    }

    // THE CREDIT: the next needed frames were evicted, so the drive's
    // FIRST product is the EXACT negotiated gap — never a silent
    // forward jump — and the continuation then pages from the ring
    // front on credits, to the marker and the exit LAST.
    credit(&mut paced, &terminal_id, "attach-exit-exp", credited).await;
    let gap = next_json_or_timeout(&mut paced, Duration::from_secs(5))
        .await
        .expect("the credit reports the retention gap");
    assert_eq!(
        gap.get("type").and_then(|v| v.as_str()),
        Some("terminal.output.gap"),
        "the credit's first product is the exact retention gap: {gap}"
    );
    assert_eq!(
        gap["reason"], "replay_window_exceeded",
        "the gap names retention loss: {gap}"
    );
    assert_eq!(
        gap["fromSeq"].as_i64(),
        Some(credited + 1),
        "the lost interval starts at the credited cursor+1: {gap}"
    );
    let gap_oldest = gap["oldestRetainedSeq"]
        .as_i64()
        .expect("oldestRetainedSeq");
    assert_eq!(
        gap["toSeq"].as_i64(),
        Some(gap_oldest - 1),
        "the lost interval ends just before the new ring front: {gap}"
    );
    assert_eq!(gap["attachRequestId"], "attach-exit-exp");

    // Continuation on credits: the pages start at the ring front, the
    // final marker is delivered, and the exit is the LAST frame (the
    // full-stream ordering).
    let mut saw_exit = false;
    let mut exits = 0usize;
    let mut acc = String::new();
    let mut seqs: Vec<i64> = Vec::new();
    let mut continued = credited.max(gap_oldest - 1);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while tokio::time::Instant::now() < deadline {
        let window = if saw_exit {
            Duration::from_millis(750)
        } else {
            Duration::from_secs(5)
        };
        let Some(value) = next_json_or_timeout(&mut paced, window).await else {
            if saw_exit {
                break;
            }
            continue;
        };
        match value.get("type").and_then(|v| v.as_str()) {
            Some("terminal.output") => {
                assert!(!saw_exit, "no output may follow terminal.exit: {value}");
                let start = value["seqStart"].as_i64().unwrap_or(0);
                assert!(
                    start >= gap_oldest,
                    "the continuation starts at the new baseline (ring front \
                     {gap_oldest}), got seq {start}"
                );
                seqs.push(start);
                if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                    acc.push_str(data);
                }
                let end = value["seqEnd"].as_i64().unwrap_or(0);
                if end > continued {
                    continued = end;
                    credit(&mut paced, &terminal_id, "attach-exit-exp", end).await;
                }
            }
            Some("terminal.exit") => {
                saw_exit = true;
                exits += 1;
                assert_eq!(exits, 1, "exactly one terminal.exit: {value}");
            }
            _ => {}
        }
    }
    assert!(
        saw_exit,
        "the exact gap is followed by the continuation and the exit arrives last"
    );
    assert!(
        acc.contains("FINAL2-MARKER"),
        "the retained window pages through the final marker on credits"
    );
    let mut sorted = seqs.clone();
    sorted.sort_unstable();
    assert_eq!(seqs, sorted, "the continuation pages ascend");
}

/// E2R2 finding (the exit-arming race), test-side page reader: read the
/// ONE page a credit grants (its frames arrive back-to-back; a quiet gap
/// closes the page — nothing further flows without a credit). Carries
/// INVARIANT 2's read-side guard: a terminal.exit observed while the page
/// that reaches the armed exit head is still uncredited IS the
/// premature-exit violation under test — panic with the frame. Gaps are
/// collected, not fatal (the retention fixture's first credit reports
/// the exact gap before its continuation frames).
async fn read_credited_page(
    ws: &mut WsClient,
    quiet: Duration,
) -> (String, i64, Vec<serde_json::Value>) {
    let mut acc = String::new();
    let mut max_seq_end = 0i64;
    let mut gaps = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "a credit must grant its page"
        );
        let window = if acc.is_empty() && gaps.is_empty() {
            Duration::from_secs(5)
        } else {
            quiet
        };
        match next_json_or_timeout(ws, window).await {
            Some(value) => match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.output") => {
                    if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                        acc.push_str(data);
                    }
                    max_seq_end = max_seq_end.max(value["seqEnd"].as_i64().unwrap_or(0));
                }
                Some("terminal.output.gap") => gaps.push(value),
                Some("terminal.exit") => panic!(
                    "invariant 2 violated: terminal.exit delivered while the page \
                     reaching the armed exit head was still uncredited (the exit \
                     must ride the CREDIT that acknowledges that page): {value}"
                ),
                _ => {}
            },
            None => {
                assert!(
                    !acc.is_empty() || !gaps.is_empty(),
                    "the credit must produce a page or a gap"
                );
                return (acc, max_seq_end, gaps);
            }
        }
    }
}

/// The quiet-window hold: while the client withholds the credit for a page
/// it has READ, no PACING-CONTRACT frame may arrive — no page, no gap, and
/// in particular no terminal.exit. Unrelated control-plane broadcasts
/// (the exit's terminal.meta.updated retire, sessions.changed, ...) are
/// not pacing frames and pass through, exactly as in the crediting-
/// promptly tests.
async fn assert_quiet_hold(ws: &mut WsClient, ms: u64, what: &str) {
    let hold = tokio::time::Instant::now() + Duration::from_millis(ms);
    while tokio::time::Instant::now() < hold {
        if let Some(value) = next_json_or_timeout(ws, Duration::from_millis(250)).await {
            match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.output") => panic!(
                    "no page may flow while credits are withheld ({what}): {value}"
                ),
                Some("terminal.output.gap") => panic!(
                    "no gap may flow while credits are withheld ({what}): {value}"
                ),
                Some("terminal.exit") => panic!(
                    "terminal.exit must ride the credit that acknowledges the page                      reaching the armed exit head ({what}): {value}"
                ),
                _ => {}
            }
        }
    }
}

/// E2R2 finding, required test (b) — THE PREMATURE-EXIT ORDERING, over the
/// real socket with EXPLICITLY controlled credit timing (the
/// parser-consumption boundary is the thing under test; the crediting-
/// promptly tests cannot see this race). The exit stages mid-restore, the
/// credits walk the pages to the one that reaches the frozen exit head,
/// and THAT PAGE IS READ BUT NOT CREDITED: no exit may deliver on the
/// drive that emitted it. Only the credit acknowledging that page may
/// deliver the exit — and it must be the client's last frame.
#[tokio::test]
async fn natural_exit_exit_page_read_uncredited_holds_the_exit_for_its_credit() {
    let ring = 512 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-exit-hold-credit").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 700).await;

    // Paced attach mid-restore; the first page is outstanding and NOT
    // credited yet.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-exit-holdc").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let mut credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page frames");
    assert!(
        credited < head,
        "the session is mid-restore when the shell exits"
    );

    // The shell produces one FINAL marker line and exits naturally while
    // the first page is uncredited (octal escapes keep the echoed command
    // from containing the literal marker). Replacing the login shell avoids
    // a later "logout" line that would make the marker page non-final.
    send_input(
        &mut paced,
        &terminal_id,
        "printf '\\106\\111\\116\\101\\114\\063\\055\\115\\101\\122\\113\\105\\122\\012'; exec /bin/true\n",
    )
    .await;
    // The withhold: nothing flows without credits (no page, no exit).
    assert_quiet_hold(&mut paced, 1_500, "after the exit staged").await;

    // Walk the pages ONE CREDIT AT A TIME: credit the outstanding first
    // page, read the page that credit grants, credit it in turn, until the
    // page carrying the literal marker — the page that reached the frozen
    // exit head. That page is then HELD uncredited: the parser-consumption
    // boundary.
    let marker = "FINAL3-MARKER";
    let mut pages = 0usize;
    credit(&mut paced, &terminal_id, "attach-exit-holdc", credited).await;
    let marker_page_end = loop {
        let (acc, page_end, gaps) =
            read_credited_page(&mut paced, Duration::from_millis(400)).await;
        assert!(
            gaps.is_empty(),
            "no retention loss in this fixture: {gaps:?}"
        );
        pages += 1;
        assert!(pages < 500, "the page walk must converge");
        if acc.contains(marker) {
            break page_end;
        }
        credit(&mut paced, &terminal_id, "attach-exit-holdc", page_end).await;
        credited = credited.max(page_end);
    };
    assert!(
        marker_page_end >= head,
        "the marker page reached the frozen head (page end {marker_page_end}, head {head})"
    );
    assert!(
        credited < marker_page_end,
        "the marker page is UN-CREDITED at the hold (credited {credited})"
    );

    // THE HOLD: the page reaching the armed exit head is read but not
    // credited — NO exit may deliver. (The pre-fix removal delivered it
    // here, straight off the drive that emitted the page.)
    assert_quiet_hold(
        &mut paced,
        1_500,
        "the exit page's parser-consumption boundary",
    )
    .await;

    // The acknowledging credit: the exit arrives NOW, and it is the
    // client's LAST frame (the full-stream ordering — a post-exit quiet
    // window proves nothing follows).
    credit(
        &mut paced,
        &terminal_id,
        "attach-exit-holdc",
        marker_page_end,
    )
    .await;
    let exit = next_json_or_timeout(&mut paced, Duration::from_secs(5))
        .await
        .expect("the exit rides the credit acknowledging the marker page");
    assert_eq!(
        exit.get("type").and_then(|v| v.as_str()),
        Some("terminal.exit"),
        "the acknowledging credit delivers the staged exit: {exit}"
    );
    let post_exit = tokio::time::Instant::now() + Duration::from_millis(1_000);
    while tokio::time::Instant::now() < post_exit {
        if let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(250)).await {
            match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.exit") => {
                    panic!("exactly one terminal.exit may ever arrive: {value}")
                }
                Some("terminal.output") | Some("terminal.output.gap") => panic!(
                    "no page or gap may follow terminal.exit (the exit is the                      terminal's last pacing frame): {value}"
                ),
                _ => {}
            }
        }
    }
}

/// E2R2 finding, required test (d) — RETENTION OVERRUN mid-wait: the ring
/// evicts the credited window's next-needed frames while the client
/// withholds, the exit then stages behind the armed deferral, and the next
/// credit reports the EXACT bounds-carrying gap before paging the retained
/// window — with the FINAL page (the one reaching the frozen exit head)
/// held uncredited across the parser-consumption boundary: the gap first,
/// the pages on credits, and the exit only on the credit that
/// acknowledges the final page.
#[tokio::test]
async fn natural_exit_retention_gap_then_held_final_page_delivers_exit_on_its_credit() {
    let ring = 12 * 1024;
    let url = spawn_server(ring).await;
    let mut driver = connect(&url).await;
    hello(&mut driver, false).await;
    let terminal_id = create_shell_terminal(&mut driver, "create-exit-gap-hold").await;
    flood_until_complete(&url, &mut driver, &terminal_id, 100).await;

    // Paced attach mid-restore; the first page is outstanding, uncredited.
    let mut paced = connect(&url).await;
    hello(&mut paced, true).await;
    let (ready, page1) =
        paced_attach_first_page(&mut paced, &terminal_id, "attach-exit-gaph").await;
    let head = ready["headSeq"].as_i64().expect("headSeq");
    let credited = page1
        .iter()
        .map(|f| f["seqEnd"].as_i64().unwrap_or(0))
        .max()
        .expect("first page frames");
    assert!(
        credited < head,
        "the session is mid-restore when the ring churns"
    );

    // Evict the credited window's middle while the client withholds.
    let mut evictor = connect(&url).await;
    hello(&mut evictor, false).await;
    attach(&mut evictor, &terminal_id, "attach-exit-gap-evictor").await;
    let marker2 = "FLOOD-DONE-MARKER";
    send_input(&mut evictor, &terminal_id, &flood_command(400, marker2)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (evictor_acc, _) = drain_until_marker(&mut evictor, marker2, deadline).await;
    assert!(
        evictor_acc.contains(marker2),
        "the evicting flood completes"
    );
    drop(evictor);

    // The exit stages behind the still-armed deferral; the withhold holds.
    // Replace the login shell so its "logout" line cannot follow the marker.
    send_input(
        &mut paced,
        &terminal_id,
        "printf '\\106\\111\\116\\101\\114\\064\\055\\115\\101\\122\\113\\105\\122\\012'; exec /bin/true\n",
    )
    .await;
    assert_quiet_hold(&mut paced, 1_500, "after the exit staged behind the gap").await;

    // THE CREDIT: the first product is the EXACT bounds-carrying gap.
    credit(&mut paced, &terminal_id, "attach-exit-gaph", credited).await;
    let marker = "FINAL4-MARKER";
    let mut gap_seen: Option<serde_json::Value> = None;
    let mut pages = 0usize;
    let mut cursor = credited;
    let marker_page_end = loop {
        let (acc, page_end, gaps) =
            read_credited_page(&mut paced, Duration::from_millis(400)).await;
        if let Some(gap) = gaps.first() {
            let first = gap_seen.replace(gap.clone());
            assert!(
                first.is_none(),
                "exactly one retention gap may report: {gap_seen:?}"
            );
            assert_eq!(
                gap.get("type").and_then(|v| v.as_str()),
                Some("terminal.output.gap"),
                "the overrun reports as the negotiated gap: {gap}"
            );
            assert_eq!(
                gap["reason"], "replay_window_exceeded",
                "the gap names retention loss: {gap}"
            );
            assert_eq!(
                gap["fromSeq"].as_i64(),
                Some(credited + 1),
                "the lost interval starts at the credited cursor+1: {gap}"
            );
            let gap_oldest = gap["oldestRetainedSeq"]
                .as_i64()
                .expect("oldestRetainedSeq");
            assert_eq!(
                gap["toSeq"].as_i64(),
                Some(gap_oldest - 1),
                "the lost interval ends just before the new ring front: {gap}"
            );
            assert_eq!(gap["attachRequestId"], "attach-exit-gaph");
            cursor = cursor.max(gap_oldest - 1);
        }
        pages += 1;
        assert!(pages < 500, "the page walk must converge");
        let start_ok = acc.is_empty() || gap_seen.is_some();
        assert!(
            start_ok,
            "frames without a gap would be a silent forward jump"
        );
        if acc.contains(marker) {
            break page_end;
        }
        credit(&mut paced, &terminal_id, "attach-exit-gaph", page_end).await;
        cursor = cursor.max(page_end);
    };
    assert!(
        gap_seen.is_some(),
        "the retention gap reported before the continuation"
    );
    assert!(
        cursor < marker_page_end,
        "the marker page is UN-CREDITED at the hold (cursor {cursor})"
    );

    // THE HOLD: the final page (reaching the frozen exit head) is read but
    // not credited — no exit may deliver on the drive that emitted it.
    assert_quiet_hold(
        &mut paced,
        1_500,
        "the final page's parser-consumption boundary",
    )
    .await;

    // The acknowledging credit: the exit arrives and is the last frame.
    credit(
        &mut paced,
        &terminal_id,
        "attach-exit-gaph",
        marker_page_end,
    )
    .await;
    let exit = next_json_or_timeout(&mut paced, Duration::from_secs(5))
        .await
        .expect("the exit rides the credit acknowledging the final page");
    assert_eq!(
        exit.get("type").and_then(|v| v.as_str()),
        Some("terminal.exit"),
        "the acknowledging credit delivers the staged exit: {exit}"
    );
    let post_exit = tokio::time::Instant::now() + Duration::from_millis(1_000);
    while tokio::time::Instant::now() < post_exit {
        if let Some(value) = next_json_or_timeout(&mut paced, Duration::from_millis(250)).await {
            match value.get("type").and_then(|v| v.as_str()) {
                Some("terminal.exit") => panic!("exactly one terminal.exit may ever arrive: {value}"),
                Some("terminal.output") | Some("terminal.output.gap") => panic!(
                    "no page or gap may follow terminal.exit (the exit is the                      terminal's last pacing frame): {value}"
                ),
                _ => {}
            }
        }
    }
}

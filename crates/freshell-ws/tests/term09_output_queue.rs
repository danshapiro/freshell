//! Integration tests for TERM-09's bounded per-client output queue (legacy
//! parity: `server/terminal-stream/client-output-queue.ts`'s
//! `ClientOutputQueue` + `broker.ts`'s catastrophic-backpressure closure).
//!
//! These run a REAL axum server (ephemeral loopback port), a REAL PTY
//! (`TerminalRegistry`), and REAL `tokio-tungstenite` WS clients -- one that
//! deliberately stops reading while a terminal floods output (the slow
//! client), and one that keeps reading throughout (the fast client). This
//! exercises the actual per-connection byte-fair delivery queue owned by the
//! connection socket writer (`crate::terminal`'s `connection_writer`), not a
//! mock.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::backpressure::Term09Config;
use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// PTY floods in this file are heavy (tens of MB of PTY traffic plus
/// per-frame JSON serialization). Serialize the flood tests within this
/// binary: concurrent floods starve each other's production and drain
/// rates, and a reader starved past a stall window legitimately trips the
/// very liveness decisions under test — the failures would be contention,
/// not behavior. An async mutex: the guard is held across `.await`s for
/// the whole test.
static FLOOD_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn flood_test_serial() -> tokio::sync::MutexGuard<'static, ()> {
    FLOOD_TEST_LOCK.lock().await
}

// ── capturing tracing layer (dev-only test facility, the paced_replay.rs
// pattern). PROCESS-GLOBAL by deliberate choice: the spawned in-process
// axum server emits its diagnostics from the connection task, and a
// thread-local `set_default` capture is UNSOUND for callsites shared with
// sibling threads — tracing-core caches each callsite's Interest
// process-wide on first registration, so a subscriber-less sibling thread
// executing a shared emission site first caches `Interest::never` and the
// event! macro short-circuits before any dispatch. One global subscriber
// sees every thread's events; every read below MUST filter by message name
// because ALL tests in this binary share the vec.
// ─────────────────────────────────────────────────────────────────────────

use std::sync::Mutex;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;

#[derive(Debug, Clone, Default)]
struct CapturedEvent {
    message: String,
    fields: std::collections::BTreeMap<String, String>,
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: std::collections::BTreeMap<String, String>,
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
    events: std::sync::Arc<Mutex<Vec<CapturedEvent>>>,
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
fn global_capture() -> std::sync::Arc<Mutex<Vec<CapturedEvent>>> {
    static EVENTS: std::sync::OnceLock<std::sync::Arc<Mutex<Vec<CapturedEvent>>>> =
        std::sync::OnceLock::new();
    std::sync::Arc::clone(EVENTS.get_or_init(|| {
        let events = std::sync::Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            events: std::sync::Arc::clone(&events),
        };
        // Level-filter the process-global registry to WARN (task-010b
        // hygiene): an unfiltered registry enables every callsite
        // process-wide — including any future debug site — a latent perf
        // and determinism footgun on the flood path. Every event this
        // binary's assertions read is warn-level
        // (`ws.terminal_stream.catastrophic_close`, and the sibling
        // `ws.terminal_stream.queue_overflow_spill`), so the filter
        // disables nothing the tests read while every sub-WARN callsite
        // short-circuits before dispatch.
        let subscriber = tracing_subscriber::registry()
            .with(layer)
            .with(tracing_subscriber::filter::LevelFilter::WARN);
        tracing::subscriber::set_global_default(subscriber)
            .expect("this test binary installs exactly one global subscriber");
        events
    }))
}

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

async fn spawn_server(term09: Term09Config) -> String {
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
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 64 * 1024 * 1024,
        term09,
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

type TestWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// Connect with the OS default socket buffers (a normal, well-behaved
/// client).
async fn connect_plain(url: &str) -> TestWs {
    let addr = ws_url_to_addr(url);
    let std_stream = std::net::TcpStream::connect(addr).expect("tcp connect");
    std_stream.set_nonblocking(true).expect("nonblocking");
    let stream = tokio::net::TcpStream::from_std(std_stream).expect("tokio TcpStream::from_std");
    let (ws, _resp) = tokio_tungstenite::client_async(url, stream)
        .await
        .expect("ws handshake");
    ws
}

/// Connect with a DELIBERATELY tiny `SO_RCVBUF` (a few KB) so a peer that
/// stops reading creates GENUINE, deterministic TCP-level backpressure on
/// loopback almost immediately -- rather than relying on default OS buffer
/// auto-tuning (which can silently absorb a multi-MB flood on a fast machine
/// and make the "slow client" scenario flaky/non-reproducible).
async fn connect_with_tiny_recv_buffer(url: &str, recv_buf_bytes: usize) -> TestWs {
    let addr = ws_url_to_addr(url);
    let socket = socket2::Socket::new(
        socket2::Domain::for_address(addr),
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )
    .expect("create socket");
    socket
        .set_recv_buffer_size(recv_buf_bytes)
        .expect("set SO_RCVBUF");
    socket.connect(&addr.into()).expect("connect");
    socket.set_nonblocking(true).expect("nonblocking");
    let std_stream: std::net::TcpStream = socket.into();
    let stream = tokio::net::TcpStream::from_std(std_stream).expect("tokio TcpStream::from_std");
    let (ws, _resp) = tokio_tungstenite::client_async(url, stream)
        .await
        .expect("ws handshake");
    ws
}

fn ws_url_to_addr(url: &str) -> std::net::SocketAddr {
    let without_scheme = url.strip_prefix("ws://").expect("ws:// url");
    let host_port = without_scheme.split('/').next().expect("host:port");
    host_port.parse().expect("valid socket addr")
}

async fn connect_and_complete_handshake(url: &str) -> TestWs {
    let mut ws = connect_plain(url).await;
    complete_handshake(&mut ws).await;
    ws
}

async fn complete_handshake(ws: &mut TestWs) {
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
        assert!(matches!(msg, WsMessage::Text(_)));
    }
}

/// Same as [`complete_handshake`], but the hello carries a capabilities
/// object (the restore-contract negotiation tests need it).
async fn complete_handshake_with_capabilities(ws: &mut TestWs, capabilities: serde_json::Value) {
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
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        assert!(matches!(msg, WsMessage::Text(_)));
    }
}

async fn create_shell_terminal(ws: &mut TestWs, request_id: &str) -> String {
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
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
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
            Ok(Some(Ok(_))) => {}
            other => panic!("expected terminal.created, got {other:?}"),
        }
    }
    panic!("terminal.created never arrived");
}

async fn attach(ws: &mut TestWs, terminal_id: &str, attach_request_id: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "attachRequestId": attach_request_id,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.attach");
}

/// A fast, high-volume flood built from `yes | head` (no per-line fork/exec,
/// unlike a `for`+`printf` loop) so the total byte volume can comfortably
/// exceed typical loopback TCP buffer auto-tuning (a few MB) within a test's
/// time budget -- the volume needs to overwhelm BOTH the sender's and the
/// non-reading receiver's kernel socket buffers before our own app-level
/// `OutputQueue` ever sees real backpressure.
///
/// The trailing marker is emitted via `printf` OCTAL ESCAPES rather than its
/// literal ASCII text. A PTY's line discipline echoes back typed INPUT
/// verbatim (independent of whether the shell has executed anything yet),
/// so if the marker string appeared literally in the command we SEND, a
/// reader would observe it in the input echo immediately -- long before the
/// real (multi-MB) command output exists -- and falsely conclude the flood
/// had already completed. Octal-escaping means the literal command text
/// never contains the marker substring; only the DECODED, ACTUALLY-EXECUTED
/// `printf` output does, after everything ahead of it in the pipe has been
/// produced.
fn flood_command(lines: usize, marker: &str) -> String {
    assert_eq!(
        marker, "FLOOD-DONE-MARKER",
        "marker must match its hardcoded octal escapes below"
    );
    format!(
        "yes 'STREAMDATA-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' | head -n {lines}; printf '\\106\\114\\117\\117\\104\\055\\104\\117\\116\\105\\055\\115\\101\\122\\113\\105\\122\\012'\n"
    )
}

/// Concatenate the `data` payload of every `terminal.output`/`terminal.output.batch`
/// frame seen until either `marker` appears in the accumulated text or the
/// deadline elapses. Returns `(accumulated_text, gap_seen, closed)`.
async fn drain_until_marker_or_deadline(
    ws: &mut TestWs,
    marker: &str,
    deadline: tokio::time::Instant,
) -> (String, bool, bool) {
    let mut acc = String::new();
    let mut gap_seen = false;
    let mut closed = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("terminal.output") | Some("terminal.output.batch") => {
                            if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                                acc.push_str(data);
                            }
                        }
                        Some("terminal.output.gap") => gap_seen = true,
                        _ => {}
                    }
                }
                if acc.contains(marker) {
                    break;
                }
            }
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => {
                closed = true;
                break;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => {
                closed = true;
                break;
            }
            Err(_) => break, // timed out
        }
    }
    (acc, gap_seen, closed)
}

/// Core TERM-09 proof: a slow client that stops reading while a terminal
/// floods output does NOT prevent a concurrently-attached fast client from
/// receiving the complete flood promptly (bounded memory + "fast-client
/// completion" from the Playwright validation text). The slow client is
/// resumed afterward and must observe either a `terminal.output.gap` (queue
/// eviction fired) or a closed connection (catastrophic backpressure fired)
/// -- legacy's "slow-client gap/recovery or documented close".
#[tokio::test]
async fn slow_client_does_not_block_fast_client_and_is_bounded() {
    let _flood_guard = flood_test_serial().await;
    let term09 = Term09Config {
        queue_max_bytes: 8 * 1024,
        catastrophic_buffered_bytes: 32 * 1024,
        catastrophic_stall_ms: 300,
    };
    let url = spawn_server(term09).await;

    // Create the terminal from its own connection.
    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-1").await;

    // Slow client: a tiny SO_RCVBUF makes it a genuine, deterministic slow
    // reader on loopback (see `connect_with_tiny_recv_buffer`), then it
    // NEVER reads again until we deliberately resume it below.
    let mut slow = connect_with_tiny_recv_buffer(&url, 4096).await;
    complete_handshake(&mut slow).await;
    attach(&mut slow, &terminal_id, "attach-slow").await;

    // Fast client: attaches and keeps reading throughout.
    let mut fast = connect_and_complete_handshake(&url).await;
    attach(&mut fast, &terminal_id, "attach-fast").await;

    // Let both attach.ready frames settle before flooding.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let marker = "FLOOD-DONE-MARKER";
    // ~90 bytes/line * 300_000 lines =~ 27 MB -- large enough to overwhelm
    // typical loopback TCP socket buffer auto-tuning on BOTH ends, so the
    // non-reading slow client genuinely creates server-side backpressure
    // instead of the flood being silently absorbed by the kernel.
    let flood = flood_command(300_000, marker);
    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood,
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    // The FAST client must see the flood complete promptly, regardless of
    // the slow client never draining anything. 60 s wall-clock margin
    // (task-010b, the task-10 retune precedent): structurally identical to
    // the fast-client drain that starved past its 20 s deadline when the
    // full-workspace gate ran on a loaded shared box (1.9 s isolated).
    // The deadline only bounds failure diagnosis — the marker breaks the
    // loop the moment the flood completes — never the pass-path wall time.
    let fast_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let (fast_acc, _fast_gap, fast_closed) =
        drain_until_marker_or_deadline(&mut fast, marker, fast_deadline).await;
    assert!(
        !fast_closed,
        "the fast, actively-reading client must never be closed by another client's stall"
    );
    assert!(
        fast_acc.contains(marker),
        "the fast client must see the flood complete; got {} bytes without the marker",
        fast_acc.len()
    );

    // NOW resume the slow client and observe the TERM-09 policy in effect:
    // either it received a queue-overflow gap, or it was already closed
    // (catastrophic backpressure). Both are acceptable per the acceptance
    // text ("slow-client gap/recovery or documented close"). 30 s (3x)
    // resume margin (task-010b): a stuck-client resume wait structurally
    // identical to the gap-negotiation test's, whose class starved past
    // its original bound under full-workspace gate load; the gap-or-close
    // it waits for already exists server-side.
    let slow_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let (_slow_acc, slow_gap, slow_closed) =
        drain_until_marker_or_deadline(&mut slow, marker, slow_deadline).await;
    assert!(
        slow_gap || slow_closed,
        "a slow client that missed a flood past the queue cap must observe either \
         a terminal.output.gap (drop-oldest fired) or a closed connection \
         (catastrophic backpressure fired); observed neither"
    );
}

/// What a throttled drain observed: accumulated output text, total output
/// payload bytes, every `terminal.output.gap` frame (full JSON, in delivery
/// order), every delivered output frame's `[seqStart..seqEnd]` range (in
/// delivery order), and whether the connection ended.
struct ThrottledDrain {
    text: String,
    output_bytes: usize,
    gaps: Vec<serde_json::Value>,
    frame_seqs: Vec<(i64, i64)>,
    closed: bool,
}

/// Read terminal output at a bounded BYTE rate — a slow-but-PROGRESSING
/// consumer (the incident's shape: a real browser on a slow path that keeps
/// draining, never a dead socket). After every `chunk_bytes` of output
/// payload received, pause `chunk_pause`, so the sustained drain rate is
/// ~`chunk_bytes / chunk_pause`. Stops at `marker`, connection end, or the
/// deadline (whichever first).
async fn drain_throttled_until_marker(
    ws: &mut TestWs,
    marker: &str,
    chunk_bytes: usize,
    chunk_pause: Duration,
    deadline: tokio::time::Instant,
) -> ThrottledDrain {
    let mut report = ThrottledDrain {
        text: String::new(),
        output_bytes: 0,
        gaps: Vec::new(),
        frame_seqs: Vec::new(),
        closed: false,
    };
    let mut received_since_pause = 0usize;
    // Rolling tail for marker detection: a marker can only arrive in fresh
    // data (possibly straddling a frame boundary), so scanning the whole
    // accumulated text per message would be quadratic — at incident-scale
    // flood sizes that alone throttles the drain and masquerades as server
    // slowness. The tail spans several marker lengths; a few hundred bytes
    // bounds the scan at O(1) per message.
    let mut tail = String::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                match value.get("type").and_then(|v| v.as_str()) {
                    Some("terminal.output") | Some("terminal.output.batch") => {
                        let data_len = value
                            .get("data")
                            .and_then(|v| v.as_str())
                            .map(str::len)
                            .unwrap_or(0);
                        if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                            report.text.push_str(data);
                            tail.push_str(data);
                        }
                        let seq_start = value.get("seqStart").and_then(|v| v.as_i64());
                        let seq_end = value.get("seqEnd").and_then(|v| v.as_i64());
                        if let (Some(start), Some(end)) = (seq_start, seq_end) {
                            report.frame_seqs.push((start, end));
                        }
                        report.output_bytes += data_len;
                        received_since_pause += data_len;
                        if received_since_pause >= chunk_bytes {
                            received_since_pause = 0;
                            tokio::time::sleep(chunk_pause).await;
                        }
                    }
                    Some("terminal.output.gap") => report.gaps.push(value),
                    _ => {}
                }
                if tail.len() > 4 * marker.len() {
                    let keep = tail.len() - 2 * marker.len();
                    tail.drain(..keep);
                }
                if tail.contains(marker) {
                    break;
                }
            }
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => {
                report.closed = true;
                break;
            }
            Ok(Some(Ok(_))) => {}
            Err(_) => break, // timed out
        }
    }
    report
}

/// Responsive-terminal-restore Workstream 3, the incident shape: a burst far
/// larger than the SPILL bound, drained by a slow-but-progressing client.
/// The production incident (~21-25 MB backlog) disconnected the client under
/// the old defaults (disconnect 16 MiB fired strictly before spill 32 MiB
/// could evict); under the new defaults the same pressure must SPILL oldest
/// output with an exact generation-scoped gap and KEEP THE CONNECTION OPEN,
/// while the client keeps making successful sends and receives well over the
/// old disconnect threshold (>16 MiB) across a >10 s pressure window.
#[tokio::test]
async fn incident_backlog_spills_instead_of_disconnecting() {
    let _flood_guard = flood_test_serial().await;
    // The real default configuration — this test pins the shipped defaults,
    // not an injected variant.
    let term09 = Term09Config::default();
    let url = spawn_server(term09).await;

    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-incident").await;

    // The victim: a normal client that reads continuously but slowly
    // (~1 MiB/s), like a browser on a congested path. It is never stuck —
    // its socket keeps accepting writes the whole time.
    let mut victim = connect_and_complete_handshake(&url).await;
    attach(&mut victim, &terminal_id, "attach-incident").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let marker = "FLOOD-DONE-MARKER";
    // ~90 bytes/line * 400_000 lines =~ 40 MB — comfortably past the spill
    // bound (16 MiB) so eviction genuinely fires, while the ~1 MiB/s drain
    // keeps the client sending successfully across a >10 s pressure window.
    let flood = flood_command(400_000, marker);
    let started = tokio::time::Instant::now();
    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood,
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    let deadline = started + Duration::from_secs(60);
    let report = drain_throttled_until_marker(
        &mut victim,
        marker,
        256 * 1024,
        Duration::from_millis(250),
        deadline,
    )
    .await;
    let elapsed = started.elapsed();

    assert!(
        !report.closed,
        "a slow-but-progressing client must survive incident-scale pressure: \
         the spill bound (eviction + gap) relieves it strictly before any \
         pressure-related disconnect"
    );
    assert!(
        report.text.contains(marker),
        "the flood tail must be delivered after the spill; got {} bytes without \
         the marker",
        report.output_bytes
    );
    assert!(
        elapsed >= Duration::from_secs(10),
        "the pressure window must span the full old stall window (10s); observed {elapsed:?}"
    );
    assert!(
        report.output_bytes > 16 * 1024 * 1024,
        "the client must receive more than the OLD disconnect threshold \
         (>16 MiB) while under pressure; got {} bytes",
        report.output_bytes
    );
    assert!(
        !report.gaps.is_empty(),
        "a burst larger than the spill bound must produce an eviction gap"
    );
    for gap in &report.gaps {
        assert_eq!(
            gap["reason"], "queue_overflow",
            "the observed loss is the queue-overflow (spill) gap: {gap}"
        );
        assert_eq!(
            gap["terminalId"], terminal_id,
            "gap addresses this terminal"
        );
        let from = gap["fromSeq"].as_i64().expect("fromSeq");
        let to = gap["toSeq"].as_i64().expect("toSeq");
        assert!(from >= 1 && from <= to, "exact coalesced interval: {gap}");
        for (start, end) in &report.frame_seqs {
            assert!(
                *end < from || *start > to,
                "evicted bytes are never delivered: frame [{start}..{end}] must \
                 not intersect gap [{from}..{to}]"
            );
        }
    }
    let mut seqs = report.frame_seqs.iter();
    if let Some(mut last) = seqs.next() {
        for next in seqs {
            assert!(
                next.0 > last.1,
                "delivered frames stay in strict sequence order across gaps: \
                 {last:?} then {next:?}"
            );
            last = next;
        }
    }
}

/// Drain-progress liveness, end to end: a client that keeps making successful
/// socket sends must NEVER be closed by the catastrophic monitor, even while
/// its pending bytes sit continuously OVER the disconnect threshold.
///
/// The monitor's byte dimension is only observable when the queue may hold
/// more than the threshold, which the boot validation forbids for real
/// configurations (spill must sit strictly below disconnect). This test
/// therefore deliberately injects the OLD inverted shape (queue bound above
/// the disconnect threshold) straight into `WsState` — the one shape in which
/// over-threshold pending bytes can persist — and proves the monitor keys on
/// SEND PROGRESS, not on the byte count: the old sustained-bytes-only
/// decision closed exactly this client.
///
/// Flake hardening (task-010, task-007 review Minor 1 direction): the
/// original tuning (8 MiB queue against a ~2 MiB/s drain) needed bash
/// production to outpace the drain by a FULL 8 MiB before the first
/// eviction — a margin that disappears under CI load, where PTY production
/// drops to near the drain rate and the gap-evidence assertion fails with
/// the queue never overflowing. The queue bound now sits just above the
/// threshold (the minimal inversion this test exists to inject), the drain
/// matches the incident test's demonstrated ~1 MiB/s accumulation regime,
/// and the stall window is widened to 5 s so a loaded runner's scheduling
/// gaps cannot masquerade as a genuine >2 s send silence. Every assertion
/// is unchanged; only the reachability margins were re-derived.
#[tokio::test]
async fn slow_but_progressing_client_survives_over_threshold_backlog() {
    let _flood_guard = flood_test_serial().await;
    // Inverted ON PURPOSE (see doc comment): 2 MiB queue > 1 MiB threshold.
    // The 5 s stall window keeps the decision observable while a loaded
    // runner cannot fake a >2 s send silence; the harness's 30 s ping
    // interval keeps the per-send write timeout at 60 s, far beyond the
    // window, so only the monitor's decision can close this connection.
    let term09 = Term09Config {
        queue_max_bytes: 2 * 1024 * 1024,
        catastrophic_buffered_bytes: 1024 * 1024,
        catastrophic_stall_ms: 5_000,
    };
    let url = spawn_server(term09).await;

    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-progress").await;

    let mut victim = connect_and_complete_handshake(&url).await;
    attach(&mut victim, &terminal_id, "attach-progress").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let marker = "FLOOD-DONE-MARKER";
    // ~27 MB at ~1 MiB/s drain: the queue pins at its 2 MiB bound — over the
    // 1 MiB threshold continuously for many multiples of the 5 s stall
    // window — while every frame the writer leases completes a successful
    // send. The overflow (and its exact gap) is reachable even when a
    // loaded runner slows PTY production to the drain rate.
    let flood = flood_command(300_000, marker);
    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood,
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    // Deadline sized for a ~630 KB/s effective drain under CI load (the
    // per-frame JSON parsing contends with everything else on the runner):
    // ~27 MB then needs ~45 s, so 75 s keeps >1.5x headroom.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(75);
    let report = drain_throttled_until_marker(
        &mut victim,
        marker,
        128 * 1024,
        Duration::from_millis(125),
        deadline,
    )
    .await;

    assert!(
        !report.closed,
        "a client with continuous successful sends must stay connected even \
         with pending bytes over the threshold for the whole stall window"
    );
    assert!(
        report.text.contains(marker),
        "the progressing client must see the flood complete; got {} bytes",
        report.output_bytes
    );
    assert!(
        !report.gaps.is_empty(),
        "the 2 MiB queue must evict (gap) against a ~27 MB flood at this \
         drain rate; the overflow is repaired by the exact gap, not by hanging up"
    );
}

/// Eviction and supersede are NOT send progress: a connection whose queue
/// bytes shrink only via eviction and a superseding attach — with zero
/// completed socket sends across the stall window — must still be closed by
/// the catastrophic monitor. Byte reductions alone must never masquerade as
/// liveness.
#[tokio::test]
async fn eviction_and_supersede_without_sends_still_close() {
    let _flood_guard = flood_test_serial().await;
    // Install the process-global capture BEFORE the server spawns: the
    // catastrophic_close event below is emitted by the connection task the
    // moment the monitor fires, and an event emitted before the subscriber
    // exists is lost for good (tracing dispatch is not replayed).
    let events = global_capture();
    let captured_from = events.lock().expect("capture lock").len();
    // The queue may hold bytes over the threshold, making the monitor's
    // window observable. A small cap makes the first eviction an observable
    // synchronization point even when the PTY producer is heavily contended.
    // The 30 s harness ping interval keeps the per-send write timeout at
    // 60 s — far beyond the monitor window.
    let term09 = Term09Config {
        queue_max_bytes: 256 * 1024,
        catastrophic_buffered_bytes: 32 * 1024,
        catastrophic_stall_ms: 2_000,
    };
    let url = spawn_server(term09).await;

    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-stuck").await;

    // The stuck client: tiny SO_RCVBUF and it NEVER reads. Its queue fills,
    // then EVICTS continuously (bytes shrinking without any send), and its
    // in-flight frame wedges once the kernel buffers fill (zero sends).
    let mut stuck = connect_with_tiny_recv_buffer(&url, 4096).await;
    complete_handshake(&mut stuck).await;
    attach(&mut stuck, &terminal_id, "attach-stuck").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let marker = "FLOOD-DONE-MARKER";
    // ~60 MB leaves ample output to refill the queue after supersede.
    let flood = flood_command(600_000, marker);

    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood,
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    // Wait for an actual eviction before superseding. A fixed sleep can run
    // before the contended PTY has produced any output, so it cannot prove
    // that this scenario exercised queue overflow.
    let spill_deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        if events
            .lock()
            .expect("capture lock")
            .iter()
            .skip(captured_from)
            .any(|e| e.message == "ws.terminal_stream.queue_overflow_spill")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < spill_deadline,
            "the stuck client's queue did not evict within 300 s; the PTY \
             flood may not be producing or the writer may not be receiving it"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Re-attach the stuck client: the superseding attach DISCARDS
    // its entire queued output (a byte reduction that is NOT a send). The
    // monitor may honestly reset on the below-threshold fall, but the still-
    // producing flood refills the queue and the window must close the
    // connection — eviction/supersede alone must never keep it alive.
    attach(&mut stuck, &terminal_id, "attach-stuck-supersede").await;

    // Keep the socket unread until the monitor decides. Reading after a
    // fixed four-second sleep, before a contended producer refills the queue,
    // lets socket sends complete and resets the very no-send window this
    // test intends to prove.
    let decision_deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        if events
            .lock()
            .expect("capture lock")
            .iter()
            .skip(captured_from)
            .any(|e| e.message == "ws.terminal_stream.catastrophic_close")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < decision_deadline,
            "the monitor made no decision within 300 s after eviction and \
             supersede while the stuck socket remained unread"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // NOW resume reading: the connection should already be terminated (the
    // catastrophic monitor fired while we were silent). Attribution does
    // NOT come from observing a Close frame: this socket is deliberately
    // backpressured to saturation, so the monitor's 4008 CloseFrame cannot
    // be delivered — the teardown surfaces as a bare stream end or error.
    // The decision is proven server-side by the capture assert below
    // (exactly one ws.terminal_stream.catastrophic_close event); a write-
    // timeout or keepalive close would produce none.
    //
    // After the decision, a 120 s delivery cap catches a wedged teardown.
    let close_deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        assert!(
            tokio::time::Instant::now() < close_deadline,
            "the monitor decided but the now-reading client did not see \
             stream termination within 120 s"
        );
        // The loop's only non-panic exit is the close observation itself:
        // every other path is a stall-cap panic carrying the failure's
        // exact context, so the connection-must-close requirement is
        // enforced structurally.
        match tokio::time::timeout(Duration::from_millis(50), stuck.next()).await {
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(_))) => {}
            Err(_) => continue, // tick elapsed with no frame: re-check progress
        }
    }

    // Task-007 review M3 (landed by task-010): the catastrophic-close event
    // must be diagnosable from the log line ALONE. `sends_in_window` is the
    // per-occurrence evidence — completed sends DURING the deciding window
    // for THIS close, structurally zero (any send resets the window) — while
    // `total_sends` (the renamed lifetime `sends` counter) carries the
    // connection's whole history. The stuck client here completed sends
    // (its attach handshake) BEFORE the window, so the two fields must
    // disagree: window evidence 0, lifetime total >= 1.
    let close_events: Vec<_> = events
        .lock()
        .expect("capture lock")
        .iter()
        .skip(captured_from)
        .filter(|e| e.message == "ws.terminal_stream.catastrophic_close")
        .cloned()
        .collect();
    assert_eq!(
        close_events.len(),
        1,
        "the monitor's close must emit exactly one catastrophic_close event: {close_events:?}"
    );
    let close = &close_events[0];
    assert_eq!(
        close.fields.get("sends_in_window").map(String::as_str),
        Some("0"),
        "the deciding window for THIS occurrence was send-silent — the \
         per-occurrence evidence must say so directly: {close:?}"
    );
    let total_sends: u64 = close
        .fields
        .get("total_sends")
        .expect("the lifetime counter is carried as total_sends")
        .parse()
        .expect("total_sends renders as a plain integer");
    assert!(
        total_sends >= 1,
        "the stuck client completed its attach handshake before the wedge, \
         so the lifetime counter must be nonzero — the field pair is what \
         distinguishes wedge-after-progress from never-sent: {close:?}"
    );
    assert_eq!(
        close.fields.get("window_ms").map(String::as_str),
        Some("2000"),
        "the injected stall window is reported"
    );
    assert_eq!(
        close.fields.get("threshold").map(String::as_str),
        Some("32768"),
        "the injected threshold is reported"
    );
    let pending: usize = close
        .fields
        .get("pending_bytes")
        .expect("pending bytes at fire time")
        .parse()
        .expect("pending_bytes renders as a plain integer");
    assert!(
        pending > 32 * 1024,
        "the monitor only fires over-threshold: {close:?}"
    );
}

/// Read frames until the first `terminal.output.gap` arrives, returning its
/// JSON. Callers resume a previously-stuck client: the delivery queue serves
/// the terminal's pending gap ahead of its remaining frames, so the gap
/// surfaces within the stuck backlog.
async fn first_gap_frame(ws: &mut TestWs, deadline: tokio::time::Instant) -> serde_json::Value {
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value.get("type").and_then(|v| v.as_str()) == Some("terminal.output.gap") {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => break,
        }
    }
    panic!("no terminal.output.gap arrived before the deadline");
}

/// Restore-contract negotiation gating, end to end on real sockets + a real
/// PTY (responsive-terminal-restore): two slow clients attach to the SAME
/// flooding terminal — one whose hello negotiated `pacedTerminalReplayV1`,
/// one not. The negotiated client's queue-overflow gap carries
/// `headSeq`/`oldestRetainedSeq` resolved from the registry at
/// gap-emission time; the non-negotiated client's gap omits BOTH keys —
/// byte-identical to the pre-contract wire.
#[tokio::test]
async fn queue_overflow_gap_bounds_follow_negotiation() {
    let _flood_guard = flood_test_serial().await;
    // Tiny queue so overflow fires almost immediately; catastrophic
    // backpressure threshold far above it so the connection stays OPEN and
    // the observed loss is the queue-overflow gap (not a 4008 close).
    let term09 = Term09Config {
        queue_max_bytes: 8 * 1024,
        catastrophic_buffered_bytes: 8 * 1024 * 1024,
        catastrophic_stall_ms: 60_000,
    };
    let url = spawn_server(term09).await;

    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-gap").await;

    // Negotiated slow client: tiny SO_RCVBUF. It reads NOTHING from flood
    // start until the fast client below has seen the flood complete — the
    // deterministic TERM-09 slow-reader shape (a client that reads along can
    // keep the writer draining and no overflow ever fires).
    let mut paced = connect_with_tiny_recv_buffer(&url, 4096).await;
    complete_handshake_with_capabilities(
        &mut paced,
        serde_json::json!({ "pacedTerminalReplayV1": true }),
    )
    .await;
    attach(&mut paced, &terminal_id, "attach-paced").await;

    // Non-negotiated slow client on the SAME terminal, same stuck shape.
    let mut plain = connect_with_tiny_recv_buffer(&url, 4096).await;
    complete_handshake(&mut plain).await;
    attach(&mut plain, &terminal_id, "attach-plain").await;

    // A fast, always-reading client proves when the flood has fully run.
    let mut fast = connect_and_complete_handshake(&url).await;
    attach(&mut fast, &terminal_id, "attach-fast").await;

    // Let the attach.ready frames settle before flooding.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let marker = "FLOOD-DONE-MARKER";
    // ~90 bytes/line * 20_000 lines =~ 1.8 MB: comfortably overruns both
    // stuck clients' 8 KB writer queues long before the 60 s send timeout.
    let flood = flood_command(20_000, marker);
    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood,
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    // Wait for the flood to COMPLETE on the fast client: by then both stuck
    // clients' queues have overflowed and their queue-overflow gaps exist.
    // 60 s wall-clock margin (task-010b, the task-10 retune precedent):
    // this drain measures 1.9 s isolated but starved past its 20 s
    // deadline when the full-workspace gate ran `cargo test --workspace`
    // on a loaded shared box. The deadline only bounds failure diagnosis —
    // the marker breaks the loop the moment the flood completes — never
    // the pass-path wall time.
    let fast_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let (fast_acc, _fast_gap, fast_closed) =
        drain_until_marker_or_deadline(&mut fast, marker, fast_deadline).await;
    assert!(
        !fast_closed && fast_acc.contains(marker),
        "the fast client must see the flood complete before the slow clients resume"
    );

    // NOW resume each stuck client and capture its first queue-overflow gap.
    // Same loaded-gate margin as the fast-client drain above (the gaps
    // already exist server-side once the flood completes; the deadline only
    // bounds how long we wait to observe them through the resumed
    // backlog).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let paced_gap = first_gap_frame(&mut paced, deadline).await;
    assert_eq!(
        paced_gap["reason"], "queue_overflow",
        "the negotiated client's observed loss is the queue-overflow gap: {paced_gap}"
    );
    let paced_head = paced_gap["headSeq"]
        .as_i64()
        .expect("negotiated gap carries headSeq");
    let paced_oldest = paced_gap["oldestRetainedSeq"]
        .as_i64()
        .expect("negotiated gap carries oldestRetainedSeq");
    assert!(paced_head >= 1, "honest current head: {paced_gap}");
    assert!(
        paced_oldest >= 1 && paced_oldest <= paced_head + 1,
        "oldestRetainedSeq is an honest retention bound (front of the ring, \
         head+1 when empty): {paced_gap}"
    );

    let plain_gap = first_gap_frame(&mut plain, deadline).await;
    assert_eq!(
        plain_gap["reason"], "queue_overflow",
        "the non-negotiated client's observed loss is the queue-overflow gap: {plain_gap}"
    );
    assert!(
        plain_gap.get("headSeq").is_none() && plain_gap.get("oldestRetainedSeq").is_none(),
        "a non-negotiated gap must not gain any new key: {plain_gap}"
    );
}

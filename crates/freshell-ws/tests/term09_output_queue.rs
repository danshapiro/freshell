//! Integration tests for TERM-09's bounded per-client output queue (legacy
//! parity: `server/terminal-stream/client-output-queue.ts`'s
//! `ClientOutputQueue` + `broker.ts`'s catastrophic-backpressure closure).
//!
//! These run a REAL axum server (ephemeral loopback port), a REAL PTY
//! (`TerminalRegistry`), and REAL `tokio-tungstenite` WS clients -- one that
//! deliberately stops reading while a terminal floods output (the slow
//! client), and one that keeps reading throughout (the fast client). This
//! exercises the actual `ConnectionOutputQueue` wired into
//! `crate::terminal::run`, not a mock.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::backpressure::Term09Config;
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

async fn spawn_server(term09: Term09Config) -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
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
    let term09 = Term09Config {
        queue_max_bytes: 8 * 1024,
        catastrophic_buffered_bytes: 32 * 1024,
        catastrophic_stall_ms: 300,
        send_stall_window_ms: 50,
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
    // the slow client never draining anything.
    let fast_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
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
    // text ("slow-client gap/recovery or documented close").
    let slow_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let (_slow_acc, slow_gap, slow_closed) =
        drain_until_marker_or_deadline(&mut slow, marker, slow_deadline).await;
    assert!(
        slow_gap || slow_closed,
        "a slow client that missed a flood past the queue cap must observe either \
         a terminal.output.gap (drop-oldest fired) or a closed connection \
         (catastrophic backpressure fired); observed neither"
    );
}

/// Narrow-gap regression test (the gap `backpressure.rs` documented pre-fix):
/// a client whose receive window closes COMPLETELY mid-flood leaves one
/// `send().await` blocked indefinitely. Pre-fix the connection loop parked
/// inside that one send, the catastrophic ticker could never tick again,
/// and the peer was never closed. Post-fix every loop send is bounded by
/// `send_stall_window_ms`, the un-accepted output stays held (counted toward
/// the catastrophic threshold), and the monitor closes the wedged
/// connection 4008 within roughly the stall budget. Fast-client completion
/// is already asserted by the test above; this one asserts the wedged
/// connection's close/decision is real and client-observable.
///
/// Two realities this test's configuration must respect:
///
/// * One serialized `terminal.output` frame can reach the fragment budget
///   (`TERMINAL_STREAM_BATCH_MAX_BYTES`, 16 KiB default; `framing.rs`). A
///   queue cap at/below one frame self-evicts on EVERY `push`
///   (`OutputQueue::evict_overflow`): queue depth then sits near ZERO and
///   the catastrophic monitor can never observe sustained pressure. So the
///   cap here holds MANY whole frames (256 KiB) with the threshold (32 KiB)
///   comfortably below the saturated queue depth.
/// * A peer whose TCP receive window never re-opens CANNOT observe the close
///   while it refuses to read: the 4008 close frame (and, after teardown,
///   the FIN) are TCP-ordered BEHIND the kernel-buffered flood bytes the
///   peer never ACKs -- exactly as legacy's `ws.close(4008, 'Catastrophic
///   backpressure')` is invisible to a never-reading socket
///   (`broker.ts:1123`; legacy's answer for a QUIET dead socket is the
///   keepalive's `ws.terminate()`, a different path). The client-observable
///   form of "documented close" (the checklist's "gap/recovery or
///   documented close") surfaces only once the peer resumes reading and
///   drains the backlog to the close/EOF. So this test first waits OUT the
///   stall budget WITHOUT reading (keeping the wedge so the monitor fires),
///   then resumes draining and requires the close (or stream end) to
///   surface promptly.
#[tokio::test]
async fn indefinitely_blocked_output_send_still_gets_catastrophic_close() {
    let term09 = Term09Config {
        queue_max_bytes: 256 * 1024,
        // Threshold far below the queue cap yet above a couple of frames, so
        // sustained wedged pressure (queue + held) definitely exceeds it.
        catastrophic_buffered_bytes: 32 * 1024,
        catastrophic_stall_ms: 400,
        send_stall_window_ms: 25,
    };
    let url = spawn_server(term09).await;

    let mut creator = connect_and_complete_handshake(&url).await;
    let terminal_id = create_shell_terminal(&mut creator, "create-wedge").await;

    // The wedged client: tiny SO_RCVBUF so the window closes fast and
    // deterministically; it does not read again until the grace below ends.
    let mut wedged = connect_with_tiny_recv_buffer(&url, 4096).await;
    complete_handshake(&mut wedged).await;
    attach(&mut wedged, &terminal_id, "attach-wedge").await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    creator
        .send(WsMessage::Text(
            serde_json::json!({
                "type": "terminal.input",
                "terminalId": terminal_id,
                "data": flood_command(300_000, "FLOOD-DONE-MARKER"),
            })
            .to_string(),
        ))
        .await
        .expect("send flood input");

    // Phase 1: hold the wedge (read NOTHING) well past the point the
    // catastrophic monitor must have fired: ~400ms sustained over-threshold
    // pressure (reached once the kernel's few-MB send buffer fills, early in
    // a 27MB flood) + the 100ms tick cadence + margin. Reading here would
    // re-open the window and reset the monitor before it could fire.
    tokio::time::sleep(Duration::from_secs(4)).await;

    // Phase 2: resume reading. If the monitor fired, the connection was
    // torn down; the queued backlog drains and the stream ends (or a 4008
    // Close frame surfaces) promptly. If it did NOT fire (the pre-fix
    // behavior), the now-unwedged client instead keeps receiving output/gap
    // frames and the stream stays OPEN until this deadline -- a loud
    // regression signal.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut close_frame = None;
    let mut stream_ended = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), wedged.next()).await {
            Ok(Some(Ok(WsMessage::Close(frame)))) => {
                close_frame = frame;
                break;
            }
            Ok(Some(Ok(_))) => {} // queued backlog/gaps: keep draining
            Ok(Some(Err(_))) | Ok(None) => {
                stream_ended = true;
                break;
            }
            Err(_) => break, // per-read timeout: check deadline
        }
    }

    assert!(
        close_frame.is_some() || stream_ended,
        "a client whose receive window closes completely must be closed by \
         the catastrophic monitor in bounded time (pre-fix the loop parked \
         inside one blocked send and the close NEVER came)"
    );
    if let Some(frame) = close_frame {
        assert_eq!(
            frame.code,
            tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(4008),
            "close code must match legacy"
        );
        assert_eq!(&*frame.reason, "Catastrophic backpressure");
    }
}

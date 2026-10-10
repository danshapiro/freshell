//! Integration tests for the SAFE-03 WS Origin policy (`crates/freshell-ws/src/origin.rs`).
//!
//! These run a REAL axum server on an ephemeral loopback port + a REAL
//! `tokio-tungstenite` client, so they exercise the actual `/ws` upgrade path
//! (`ws_handler` -> `handle_socket`), not just the pure `evaluate_origin`
//! function unit-tested in `origin.rs`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
        allowed_origins: Arc::new(allowed_origins),
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

/// Encode one small masked text frame for a client-side WebSocket stream.
/// This deliberately pipelines a valid hello behind the HTTP upgrade request
/// so the server has unread client data when it applies the Origin reject.
fn masked_client_text_frame(payload: &[u8]) -> Vec<u8> {
    assert!(
        payload.len() < 126,
        "test hello must fit the short frame form"
    );
    let mask = [0x11, 0x22, 0x33, 0x44];
    let mut frame = Vec::with_capacity(2 + mask.len() + payload.len());
    frame.push(0x81); // FIN + text
    frame.push(0x80 | payload.len() as u8); // masked client payload
    frame.extend(mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % mask.len()]),
    );
    frame
}

/// Parse one unmasked server frame, returning `None` until all bytes arrive.
fn parse_server_frame(bytes: &[u8]) -> Option<(u8, &[u8], usize)> {
    if bytes.len() < 2 {
        return None;
    }
    let first = bytes[0];
    let opcode = first & 0x0f;
    if opcode == 0x8 {
        assert_ne!(first & 0x80, 0, "server close frame must set FIN");
        assert_eq!(first & 0x70, 0, "server close frame must not set RSV bits");
        assert!(
            bytes[1] & 0x7f <= 125,
            "server close frame payload must be at most 125 bytes"
        );
    }
    assert_eq!(bytes[1] & 0x80, 0, "server frames must not be masked");
    let (payload_len, header_len) = match bytes[1] & 0x7f {
        short @ 0..=125 => (short as usize, 2usize),
        126 => {
            if bytes.len() < 4 {
                return None;
            }
            (u16::from_be_bytes([bytes[2], bytes[3]]) as usize, 4usize)
        }
        127 => {
            if bytes.len() < 10 {
                return None;
            }
            let payload_len =
                u64::from_be_bytes(bytes[2..10].try_into().expect("eight-byte length"));
            (
                usize::try_from(payload_len).expect("test frame length fits usize"),
                10usize,
            )
        }
        _ => unreachable!("WebSocket payload length is seven bits"),
    };
    if opcode == 0x8 {
        assert_ne!(
            payload_len, 1,
            "server close payload must be empty or include a code"
        );
    }
    let end = header_len.checked_add(payload_len)?;
    (bytes.len() >= end).then_some((opcode, &bytes[header_len..end], end))
}

#[test]
#[should_panic(expected = "server close frame must set FIN")]
fn origin_close_parser_rejects_fragmented_close() {
    let _ = parse_server_frame(&[0x08, 0x02, 0x0f, 0xab]);
}

#[test]
#[should_panic(expected = "server close frame must not set RSV bits")]
fn origin_close_parser_rejects_rsv_close() {
    let _ = parse_server_frame(&[0xc8, 0x02, 0x0f, 0xab]);
}

#[test]
#[should_panic(expected = "server close frame payload must be at most 125 bytes")]
fn origin_close_parser_rejects_extended_length() {
    let _ = parse_server_frame(&[0x88, 126]);
}

#[test]
#[should_panic(expected = "server close payload must be empty or include a code")]
fn origin_close_parser_rejects_one_byte_payload() {
    let _ = parse_server_frame(&[0x88, 0x01, 0x00]);
}

/// A client may write its hello as soon as it has emitted the upgrade request,
/// before it has read the server's 101. The reject path must still deliver the
/// exact close frame rather than dropping the socket with unread hello bytes.
async fn pipelined_origin_rejection_close(addr: &str, origin: &str) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect raw websocket client");
    let hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    })
    .to_string();
    let request = format!(
        "GET /ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n",
        generate_key(),
    );
    let hello_frame = masked_client_text_frame(hello.as_bytes());
    let mut pipelined_request = Vec::with_capacity(request.len() + hello_frame.len());
    pipelined_request.extend_from_slice(request.as_bytes());
    pipelined_request.extend_from_slice(&hello_frame);
    stream
        .write_all(&pipelined_request)
        .await
        .expect("write upgrade request and pipelined hello together");
    stream.flush().await.expect("flush pipelined client bytes");

    tokio::time::timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        let mut read_buf = [0u8; 4096];
        let mut frame_offset = None;
        loop {
            if let Some(offset) = frame_offset {
                let mut cursor = offset;
                while let Some((opcode, payload, consumed)) = parse_server_frame(&bytes[cursor..]) {
                    cursor += consumed;
                    if opcode == 0x8 {
                        assert!(
                            payload.len() >= 2,
                            "origin close must carry an application code"
                        );
                        let code = u16::from_be_bytes([payload[0], payload[1]]);
                        let reason =
                            String::from_utf8(payload[2..].to_vec()).expect("UTF-8 close reason");
                        return (code, reason);
                    }
                }
            }

            let read = stream
                .read(&mut read_buf)
                .await
                .expect("read upgrade response and websocket frames");
            assert_ne!(
                read, 0,
                "peer closed before delivering the Origin rejection close frame"
            );
            bytes.extend_from_slice(&read_buf[..read]);
            if frame_offset.is_none() {
                frame_offset = bytes
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|index| {
                        let response = String::from_utf8_lossy(&bytes[..index]);
                        assert!(
                            response.starts_with("HTTP/1.1 101"),
                            "expected websocket upgrade, got {response:?}"
                        );
                        index + 4
                    });
            }
        }
    })
    .await
    .expect("timed out waiting for the Origin rejection close frame")
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
async fn pipelined_hello_still_receives_exact_origin_rejection_close() {
    let (addr, _url) = spawn_server(freshell_ws::origin::default_allowed_origins()).await;
    let (code, reason) = pipelined_origin_rejection_close(&addr, "not-a-url").await;
    assert_eq!(code, 4011);
    assert_eq!(reason, "Origin not allowed");
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

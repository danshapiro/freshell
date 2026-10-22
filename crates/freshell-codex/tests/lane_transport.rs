//! Plan 2026-10-20-codex-proxy-ws-frame-cap.md §5.4 — fresh-lane transport
//! coverage for [`freshell_codex::transport::TungsteniteTransport`]:
//! real loopback sockets (ephemeral ports only), the production lane config
//! end-to-end, and the over-cap causality seam. `#![cfg(feature =
//! "real-transport")]` because the transport is the real-IO backend (same
//! gating as the other real-socket suites in this crate).
#![cfg(feature = "real-transport")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::accept_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use freshell_codex::app_server::WsTransport;
use freshell_codex::transport::TungsteniteTransport;
use freshell_codex::ws_config::{lane_ws_config, ws_config_with_caps};

const RECV_TIMEOUT: Duration = Duration::from_secs(10);

/// The lane's large-frame class (plan §4.1): comfortably OVER tungstenite's
/// 16 MiB default `max_frame_size` (under which full-thread reads die
/// silently today) and comfortably under the 64 MiB lane cap.
const LANE_LARGE_MESSAGE_BYTES: usize = 20 * 1024 * 1024;

// ── test peers (accept side) ────────────────────────────────────────────────────────

/// A loopback WS server accepting ONE connection per dial and echoing every
/// message back. Accepts with the same config the client under test runs with,
/// so a large message round-trips without the peer's own read cap rejecting it.
async fn spawn_echo_peer(config: WebSocketConfig) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let Ok(ws) = accept_async_with_config(stream, Some(config)).await else {
                    return;
                };
                let (mut sink, mut stream) = ws.split();
                while let Some(Ok(msg)) = stream.next().await {
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    ws_url
}

/// A loopback WS server accepting ONE connection and immediately sending one
/// fixed greeting frame (then draining, so the socket stays alive until the
/// client under test has read — or failed reading — the greeting).
async fn spawn_greeting_peer(config: WebSocketConfig, greeting: String) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(ws) = accept_async_with_config(stream, Some(config)).await else {
            return;
        };
        let (mut sink, mut stream) = ws.split();
        if sink.send(Message::Text(greeting)).await.is_err() {
            return;
        }
        while let Some(Ok(_)) = stream.next().await {}
    });
    ws_url
}

// ── plan §5.4: lane round-trip at the production lane config ───────────────────────

#[tokio::test]
async fn lane_transport_round_trips_a_20_mib_message_with_the_production_lane_config() {
    // `TungsteniteTransport::connect` is the production path: its read caps
    // come from `lane_ws_config()` (the independent 64 MiB lane constant). A
    // 20 MiB message — over tungstenite's old 16 MiB default — must round-trip
    // byte-identical against a peer accepting with the same lane config.
    let ws_url = spawn_echo_peer(lane_ws_config()).await;
    let transport = TungsteniteTransport::connect(&ws_url)
        .await
        .expect("lane transport should connect to the echo peer");

    let large = "x".repeat(LANE_LARGE_MESSAGE_BYTES);
    transport
        .send(large.clone())
        .await
        .expect("send should accept a 20 MiB message");

    let received = timeout(RECV_TIMEOUT, transport.recv())
        .await
        .expect("timed out waiting for the echoed message")
        .expect("the echo stream ended before the message arrived");
    assert_eq!(
        received.len(),
        LANE_LARGE_MESSAGE_BYTES,
        "the echoed message must arrive complete"
    );
    assert_eq!(
        received, large,
        "the 20 MiB round trip must be byte-identical"
    );
}

// ── plan §5.4: over-cap causality, production-visible ───────────────────────────────

#[tokio::test]
async fn lane_transport_recv_records_the_capacity_error_cause_on_an_over_cap_frame() {
    // `recv` still collapses every error to `None` for callers (the public
    // `CodexAppServerError::Closed` mapping is unchanged), but the error arm
    // now warns in production AND retains the cause on the seam: an over-cap
    // response must be diagnosable as the CAPACITY error from the configured
    // size limit — not an unrelated disconnect.
    let ws_url = spawn_greeting_peer(lane_ws_config(), "x".repeat(2048)).await;
    let transport = TungsteniteTransport::connect_with_config(
        &ws_url,
        ws_config_with_caps(1024, 1024), // tiny injected lane cap for the test
    )
    .await
    .expect("lane transport should connect with the injected config");

    assert_eq!(
        transport.last_recv_error(),
        None,
        "no cause may be recorded before a recv error"
    );

    let received = timeout(RECV_TIMEOUT, transport.recv())
        .await
        .expect("timed out waiting for recv");
    assert_eq!(
        received, None,
        "an over-cap read still collapses to None for callers (Closed mapping unchanged)"
    );

    let cause = transport
        .last_recv_error()
        .expect("the recv error arm must record its cause");
    assert!(
        cause.contains("Message too long: 2048 > 1024"),
        "the recorded cause must be the Capacity error carrying the real size numbers and the configured limit, got: {cause}"
    );
}

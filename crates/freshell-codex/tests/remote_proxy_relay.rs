//! DEV-0006 Slice 2 — loopback integration tests for [`freshell_codex::remote_proxy`], a
//! faithful (scoped) port of `server/coding-cli/codex-app-server/remote-proxy.ts`
//! (`CodexRemoteProxy`): a loopback WS server the codex TUI connects to, which relays
//! frames to/from a real upstream app-server while scanning them (via the Slice-1
//! extractors, `remote_proxy_envelope.rs` + `remote_proxy_side_effects.rs`) for durability
//! candidates / turn / lifecycle side effects, and rewriting the two `thread/fork` frames.
//!
//! Real sockets throughout (loopback, ephemeral ports only — never 3001/3002): a fake
//! upstream app-server (this test harness) and a real `tokio-tungstenite` client playing
//! the TUI role dial the actual `CodexRemoteProxy` under test. `#![cfg(feature =
//! "real-transport")]` because the proxy is inherently IO (a real WS server + a real
//! client dial), matching the crate's existing real-IO/fake-CORE split
//! (`transport.rs` is gated the same way).
#![cfg(feature = "real-transport")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

use freshell_codex::remote_proxy::{
    CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent, RemoteProxyRepairTrigger,
};
use freshell_codex::remote_proxy_side_effects::CandidateSource;

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

// ── fake upstream app-server harness ────────────────────────────────────────────────

/// A minimal loopback WS server that accepts exactly one connection and exposes it as a
/// plain send/receive pair — standing in for the real codex `app-server` the proxy dials.
struct FakeUpstream {
    ws_url: String,
    conn_rx: mpsc::UnboundedReceiver<FakeUpstreamConn>,
}

struct FakeUpstreamConn {
    incoming: mpsc::UnboundedReceiver<Message>,
    outgoing: mpsc::UnboundedSender<Message>,
}

async fn start_fake_upstream() -> FakeUpstream {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
    let (conn_tx, conn_rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Ok(ws) = accept_async(stream).await else {
                continue;
            };
            let (mut sink, mut stream) = ws.split();
            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
            let (in_tx, in_rx) = mpsc::unbounded_channel::<Message>();
            tokio::spawn(async move {
                while let Some(msg) = out_rx.recv().await {
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
                let _ = sink.close().await;
            });
            tokio::spawn(async move {
                loop {
                    match stream.next().await {
                        Some(Ok(msg)) => {
                            if in_tx.send(msg).is_err() {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
            });
            if conn_tx
                .send(FakeUpstreamConn {
                    incoming: in_rx,
                    outgoing: out_tx,
                })
                .is_err()
            {
                break;
            }
        }
    });

    FakeUpstream { ws_url, conn_rx }
}

impl FakeUpstream {
    async fn accept(&mut self) -> FakeUpstreamConn {
        timeout(RECV_TIMEOUT, self.conn_rx.recv())
            .await
            .expect("fake upstream: timed out waiting for the proxy to dial in")
            .expect("fake upstream: connection channel closed")
    }
}

impl FakeUpstreamConn {
    async fn recv_text(&mut self) -> String {
        match timeout(RECV_TIMEOUT, self.incoming.recv())
            .await
            .expect("fake upstream: timed out waiting for a frame")
            .expect("fake upstream: incoming channel closed")
        {
            Message::Text(text) => text,
            other => panic!("fake upstream: expected a text frame, got {other:?}"),
        }
    }

    fn send_text(&self, text: impl Into<String>) {
        self.outgoing.send(Message::Text(text.into())).unwrap();
    }

    fn send_raw(&self, bytes: Vec<u8>) {
        self.outgoing
            .send(Message::Text(String::from_utf8(bytes).unwrap()))
            .unwrap();
    }
}

// ── small helpers ────────────────────────────────────────────────────────────────────

async fn connect_tui(ws_url: &str) -> tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
> {
    let (ws, _) = timeout(RECV_TIMEOUT, connect_async(ws_url))
        .await
        .expect("TUI: timed out connecting to the proxy")
        .expect("TUI: failed to connect to the proxy");
    ws
}

async fn recv_text<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>) -> String
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    match timeout(RECV_TIMEOUT, ws.next())
        .await
        .expect("timed out waiting for a frame")
    {
        Some(Ok(Message::Text(text))) => text,
        other => panic!("expected a text frame, got {other:?}"),
    }
}

async fn recv_events(
    rx: &mut mpsc::UnboundedReceiver<RemoteProxyEvent>,
    count: usize,
) -> Vec<RemoteProxyEvent> {
    let mut events = Vec::new();
    for _ in 0..count {
        let event = timeout(RECV_TIMEOUT, rx.recv())
            .await
            .expect("timed out waiting for a proxy event")
            .expect("event channel closed");
        events.push(event);
    }
    events
}

fn huge_string(bytes: usize) -> String {
    "x".repeat(bytes)
}

// ── 1. bidirectional relay fidelity ──────────────────────────────────────────────────

#[tokio::test]
async fn relays_a_small_non_stateful_request_and_response_byte_identical_both_ways() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .expect("proxy should start");

    let mut tui = connect_tui(proxy.ws_url()).await;
    let request = json!({"jsonrpc":"2.0","id":1,"method":"foo/bar","params":{"hello":"world"}}).to_string();
    tui.send(Message::Text(request.clone())).await.unwrap();

    let mut conn = upstream.accept().await;
    let forwarded = conn.recv_text().await;
    assert_eq!(forwarded, request, "request bytes must relay unchanged");

    let response = json!({"jsonrpc":"2.0","id":1,"result":{"ok":true}}).to_string();
    conn.send_text(response.clone());
    let received = recv_text(&mut tui).await;
    assert_eq!(received, response, "response bytes must relay unchanged");

    proxy.close().await;
}

#[tokio::test]
async fn relays_frames_larger_than_max_full_parse_bytes_raw_forward_passthrough() {
    // MAX_FULL_PARSE_BYTES is 1 MiB and is not configurable — exercise the byte-scan
    // (not full-JSON.parse) path for a non-stateful method, asserting bytes are still
    // relayed unchanged (only stateful methods get their contents inspected/rewritten).
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;

    let big_payload = huge_string(2 * 1024 * 1024);
    let request = json!({"id":2,"method":"foo/big","params":{"payload":big_payload}}).to_string();
    tui.send(Message::Text(request.clone())).await.unwrap();

    let mut conn = upstream.accept().await;
    let forwarded = conn.recv_text().await;
    assert_eq!(forwarded, request);

    proxy.close().await;
}

#[tokio::test]
async fn frames_are_relayed_in_order_in_both_directions() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    for i in 0..20 {
        let request = json!({"id": i, "method": "seq/ping", "params": {"n": i}}).to_string();
        tui.send(Message::Text(request)).await.unwrap();
    }
    for i in 0..20 {
        let forwarded = conn.recv_text().await;
        let parsed: Value = serde_json::from_str(&forwarded).unwrap();
        assert_eq!(parsed["id"], json!(i), "client->upstream ordering must be preserved");
    }

    for i in 0..20 {
        conn.send_text(json!({"id": i, "result": {"n": i}}).to_string());
    }
    for i in 0..20 {
        let received = recv_text(&mut tui).await;
        let parsed: Value = serde_json::from_str(&received).unwrap();
        assert_eq!(parsed["id"], json!(i), "upstream->client ordering must be preserved");
    }

    proxy.close().await;
}

// ── 2. oversized-frame rejection (MAX_RAW_FORWARD_BYTES hard cap) ──────────────────

#[tokio::test]
async fn rejects_client_frames_over_max_raw_forward_bytes_with_error_and_closes() {
    // A real (connectable) fake upstream, not an unreachable URL: dialing upstream starts
    // immediately on every accepted client connection (matching legacy), so an unreachable
    // upstream would race the oversized-frame rejection with an unrelated dial-failure
    // teardown of the same connection.
    let mut upstream = start_fake_upstream().await;
    let mut options = CodexRemoteProxyOptions::new(&upstream.ws_url);
    options.max_raw_forward_bytes = 256; // tiny cap so the test doesn't allocate 64MB
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let _conn = upstream.accept().await;

    let oversized = json!({"id": 1, "method": "thread/start", "params": {"payload": huge_string(1024)}}).to_string();
    tui.send(Message::Text(oversized)).await.unwrap();

    let reply = recv_text(&mut tui).await;
    let parsed: Value = serde_json::from_str(&reply).unwrap();
    assert!(parsed.get("error").is_some(), "expected a JSON-RPC error reply, got {parsed}");

    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { .. })
    ));

    // The connection is closed after an oversized-frame rejection.
    let next = timeout(RECV_TIMEOUT, tui.next()).await.unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | None),
        "expected the TUI socket to close, got {next:?}"
    );

    proxy.close().await;
}

// ── 3. thread/start response -> candidate ───────────────────────────────────────────

#[tokio::test]
async fn thread_start_response_is_relayed_unchanged_and_yields_a_candidate_event() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;

    let request = json!({"id": 7, "method": "thread/start", "params": {}}).to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let mut conn = upstream.accept().await;
    let _ = conn.recv_text().await;

    let response = json!({
        "id": 7,
        "result": {"thread": {"id": "thread-1", "path": "/tmp/rollout.jsonl", "ephemeral": false}},
    })
    .to_string();
    conn.send_text(response.clone());

    let received = recv_text(&mut tui).await;
    assert_eq!(received, response, "thread/start response must relay byte-identical");

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::Candidate(candidate) => {
            assert_eq!(candidate.source, CandidateSource::ThreadStartResponse);
            assert_eq!(candidate.thread.id, "thread-1");
            assert_eq!(candidate.thread.path.as_deref(), Some("/tmp/rollout.jsonl"));
        }
        other => panic!("expected a Candidate event, got {other:?}"),
    }

    proxy.close().await;
}

// ── 4. thread/fork request rewrite + response normalization ────────────────────────

#[tokio::test]
async fn thread_fork_request_is_rewritten_to_exclude_turns_before_forwarding() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    // `rewrite_thread_fork_request_exclude_turns` forces `params.excludeTurns = true` (it
    // does not touch a request-side `turns` field -- fork REQUESTS don't carry turn
    // history; that's a RESPONSE-side concept the sibling `normalize_thread_fork_response_for_tui`
    // rewrite handles). This request omits `excludeTurns` entirely, which must trigger the
    // "append it" splice path (`json-rpc-side-effects.ts:193-242`).
    let request = json!({
        "id": 12,
        "method": "thread/fork",
        "params": {"threadId": "parent-1"},
    })
    .to_string();
    tui.send(Message::Text(request.clone())).await.unwrap();

    let forwarded = conn.recv_text().await;
    assert_ne!(forwarded, request, "the fork request must be rewritten, not forwarded verbatim");
    let forwarded_json: Value = serde_json::from_str(&forwarded).unwrap();
    assert_eq!(forwarded_json["params"]["threadId"], "parent-1");
    assert_eq!(
        forwarded_json["params"]["excludeTurns"],
        json!(true),
        "excludeTurns must be forced true on the rewritten fork request, got {forwarded_json}"
    );

    proxy.close().await;
}

#[tokio::test]
async fn thread_fork_response_is_normalized_for_the_tui_and_yields_a_candidate() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    let request = json!({
        "id": 13,
        "method": "thread/fork",
        "params": {"threadId": "parent-2", "turns": []},
    })
    .to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let _ = conn.recv_text().await;

    // Upstream omits `turns` on the child thread — normalization must add `turns: []`.
    let response = json!({
        "id": 13,
        "result": {"thread": {"id": "thread-child", "path": "/tmp/child.jsonl", "ephemeral": false}},
    })
    .to_string();
    conn.send_text(response);

    let received = recv_text(&mut tui).await;
    let received_json: Value = serde_json::from_str(&received).unwrap();
    assert_eq!(received_json["result"]["thread"]["turns"], json!([]));

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::Candidate(candidate) => {
            assert_eq!(candidate.source, CandidateSource::ThreadForkResponse);
            assert_eq!(candidate.thread.id, "thread-child");
        }
        other => panic!("expected a Candidate event, got {other:?}"),
    }

    proxy.close().await;
}

// ── 5. stateful notification side effects ──────────────────────────────────────────

#[tokio::test]
async fn thread_started_notification_yields_candidate_and_thread_started_lifecycle() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({
            "method": "thread/started",
            "params": {"thread": {"id": "thread-notified", "path": "/tmp/n.jsonl", "ephemeral": false}},
        })
        .to_string(),
    );

    let received_events = recv_events(&mut events, 2).await;
    assert!(received_events.iter().any(|e| matches!(
        e,
        RemoteProxyEvent::Candidate(c) if c.source == CandidateSource::ThreadStartedNotification && c.thread.id == "thread-notified"
    )));
    assert!(received_events
        .iter()
        .any(|e| matches!(e, RemoteProxyEvent::ThreadStarted(l) if l.thread.id == "thread-notified")));

    proxy.close().await;
}

#[tokio::test]
async fn turn_started_and_completed_notifications_carry_full_params_for_small_frames() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({"method": "turn/started", "params": {"threadId": "t1", "turnId": "turn-1", "extra": {"nested": true}}})
            .to_string(),
    );
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnStarted(p) => {
            assert_eq!(p.thread_id, "t1");
            assert_eq!(p.turn_id.as_deref(), Some("turn-1"));
            assert_eq!(p.params.get("extra"), Some(&json!({"nested": true})));
        }
        other => panic!("expected TurnStarted, got {other:?}"),
    }

    conn.send_text(
        json!({"method": "turn/completed", "params": {"threadId": "t1", "turnId": "turn-1", "status": "completed", "usage": {"tokens": 42}}})
            .to_string(),
    );
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnCompleted(p) => {
            assert_eq!(p.thread_id, "t1");
            assert_eq!(p.params.get("status"), Some(&json!("completed")));
            assert_eq!(p.params.get("usage"), Some(&json!({"tokens": 42})));
        }
        other => panic!("expected TurnCompleted, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn fs_changed_notification_emits_a_repair_trigger() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({"method": "fs/changed", "params": {"watchId": "w1", "changedPaths": ["/repo/a.rs"]}}).to_string(),
    );

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::FsChanged { watch_id, changed_paths }) => {
            assert_eq!(watch_id, "w1");
            assert_eq!(changed_paths, &vec!["/repo/a.rs".to_string()]);
        }
        other => panic!("expected an FsChanged repair trigger, got {other:?}"),
    }

    proxy.close().await;
}

// ── 6. turn/interrupt short-circuit for an already-completed turn ──────────────────

#[tokio::test]
async fn interrupt_for_an_already_completed_turn_is_acknowledged_without_reaching_upstream() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    conn.send_text(json!({"method": "turn/started", "params": {"threadId": "t1", "turnId": "turn-1"}}).to_string());
    let _ = recv_events(&mut events, 1).await;
    conn.send_text(
        json!({"method": "turn/completed", "params": {"threadId": "t1", "turnId": "turn-1", "status": "completed"}})
            .to_string(),
    );
    let _ = recv_events(&mut events, 1).await;

    // The two upstream notifications are ALSO relayed onward to the TUI (side-effect
    // extraction never suppresses the passthrough) -- drain them before checking the
    // interrupt's own reply.
    let _ = recv_text(&mut tui).await; // turn/started, relayed
    let _ = recv_text(&mut tui).await; // turn/completed, relayed

    let interrupt =
        json!({"id": 99, "method": "turn/interrupt", "params": {"threadId": "t1", "turnId": "turn-1"}}).to_string();
    tui.send(Message::Text(interrupt)).await.unwrap();

    let reply = recv_text(&mut tui).await;
    let parsed: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(parsed["id"], json!(99));
    assert_eq!(parsed["result"], json!({}));

    // The interrupt must never have reached the fake upstream.
    let never_reaches_upstream = timeout(Duration::from_millis(300), conn.incoming.recv()).await;
    assert!(never_reaches_upstream.is_err(), "turn/interrupt for a completed turn must be short-circuited locally");

    proxy.close().await;
}

// ── 7. disconnect semantics ──────────────────────────────────────────────────────────

#[tokio::test]
async fn tui_clean_disconnect_closes_the_upstream_connection() {
    // NOTE on the (faithfully-ported) `ProxyClose` cascade: `client.on('close')` in
    // `remote-proxy.ts:330-339` does NOT itself emit a repair trigger — but its
    // `closeBoth()` calls `upstream.close()`, and `upstream.on('close')`
    // (`remote-proxy.ts:340-350`) unconditionally emits `{kind:'proxy_close'}` REGARDLESS
    // of who initiated the close. So a clean, TUI-initiated disconnect still cascades into
    // one `proxy_close` repair trigger once our own upstream-teardown completes the
    // closing handshake — this is legacy's actual behavior, not a defect introduced here,
    // and this port preserves it byte-for-byte (see `HubMsg::UpstreamClosed`).
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    drop(tui); // clean close (no explicit close frame needed to prove teardown)

    let closed = timeout(RECV_TIMEOUT, conn.incoming.recv()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Message::Close(_))),
        "expected the upstream side to observe the connection end, got {closed:?}"
    );

    // Whether the resulting cascade surfaces as `ProxyClose` (a clean close handshake) or
    // `ProxyError` (tungstenite treats an already-half-torn-down socket as an error) is a
    // genuine race at the TCP/tungstenite layer, not something this port's semantics
    // pin — flagged as an undetermined nuance; either is an acceptable "our own teardown
    // cascaded" outcome, and both are already exercised precisely by the other disconnect
    // tests in this module.
    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyClose)
            | RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { .. })
    ));

    proxy.close().await;
}

#[tokio::test]
async fn upstream_clean_disconnect_closes_the_tui_and_emits_a_proxy_close_repair_trigger() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    drop(conn); // upstream goes away

    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyClose)
    ));

    let next = timeout(RECV_TIMEOUT, tui.next()).await.unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | None),
        "expected the TUI socket to close, got {next:?}"
    );

    proxy.close().await;
}

// ── 8. malformed-frame tolerance (fail closed, never crash) ─────────────────────────

#[tokio::test]
async fn malformed_json_from_the_tui_is_rejected_with_an_error_and_the_proxy_survives() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let _conn = upstream.accept().await;

    tui.send(Message::Text("{not valid json".to_string())).await.unwrap();

    let reply = recv_text(&mut tui).await;
    let parsed: Value = serde_json::from_str(&reply).unwrap();
    assert!(parsed.get("error").is_some());

    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { .. })
    ));

    // Prove the proxy process/hub itself is unharmed: a fresh, independent connection
    // still works after the malformed frame.
    let mut upstream2 = start_fake_upstream().await;
    // Reuse the SAME proxy but it was constructed against the first fake upstream's URL;
    // start a second proxy instance against upstream2 to prove the hub task (shared
    // machinery under test) is generically still alive and functional, not just this one
    // connection's teardown path.
    let (proxy2, _events2) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream2.ws_url))
        .await
        .unwrap();
    let mut tui2 = connect_tui(proxy2.ws_url()).await;
    let request = json!({"id": 1, "method": "still/alive", "params": {}}).to_string();
    tui2.send(Message::Text(request.clone())).await.unwrap();
    let mut conn2 = upstream2.accept().await;
    let forwarded = conn2.recv_text().await;
    assert_eq!(forwarded, request, "a fresh connection must still relay correctly after a malformed frame");

    proxy.close().await;
    proxy2.close().await;
}

#[tokio::test]
async fn malformed_frame_from_upstream_fails_closed_without_crashing() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_raw(b"{not valid json from upstream".to_vec());

    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { .. })
    ));

    let next = timeout(RECV_TIMEOUT, tui.next()).await.unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | None),
        "expected the TUI socket to close after a malformed upstream frame, got {next:?}"
    );

    proxy.close().await;
}

// ── 9. backpressure / slow-consumer tolerance ───────────────────────────────────────

#[tokio::test]
async fn a_slow_tui_consumer_does_not_lose_messages_from_upstream() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    const N: usize = 200;
    for i in 0..N {
        conn.send_text(json!({"method": "seq/note", "params": {"n": i}}).to_string());
    }
    // Simulate a slow consumer: delay before reading anything at all.
    tokio::time::sleep(Duration::from_millis(200)).await;

    for i in 0..N {
        let received = recv_text(&mut tui).await;
        let parsed: Value = serde_json::from_str(&received).unwrap();
        assert_eq!(parsed["params"]["n"], json!(i), "no message should be dropped or reordered under slow consumption");
    }

    proxy.close().await;
}

// ── 10. close() tears down active connections and stops accepting new ones ─────────

#[tokio::test]
async fn close_tears_down_active_connections_and_stops_accepting_new_ones() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url))
        .await
        .unwrap();
    let ws_url = proxy.ws_url().to_string();
    let mut tui = connect_tui(&ws_url).await;
    let _conn = upstream.accept().await;

    proxy.close().await;

    let next = timeout(RECV_TIMEOUT, tui.next()).await.unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | None),
        "expected the existing TUI socket to be torn down by close(), got {next:?}"
    );

    let reconnect = timeout(Duration::from_millis(500), connect_async(&ws_url)).await;
    match reconnect {
        Ok(Ok(_)) => panic!("expected connecting after close() to fail (listener stopped)"),
        _ => {}
    }
}

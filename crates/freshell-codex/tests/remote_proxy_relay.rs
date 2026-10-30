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

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{
    accept_async, accept_async_with_config, connect_async, connect_async_with_config,
};

use freshell_codex::remote_proxy::{
    CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent, RemoteProxyRepairTrigger,
};
use freshell_codex::remote_proxy_side_effects::CandidateSource;
use freshell_codex::ws_config::proxy_ws_config;

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
    start_fake_upstream_inner(None).await
}

/// Like [`start_fake_upstream`], but the accepted peer-side sockets get the
/// PROXY read caps: the large-frame tests relay frames over the production
/// policy, which a default-capped (16 MiB frame) peer would reject on read
/// (plan §4.2: the new tests' client/peer sides use the shared configs).
async fn start_large_frame_upstream() -> FakeUpstream {
    start_fake_upstream_inner(Some(proxy_ws_config())).await
}

async fn start_fake_upstream_inner(ws_config: Option<WebSocketConfig>) -> FakeUpstream {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
    let (conn_tx, conn_rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Ok(ws) = (match ws_config {
                Some(config) => accept_async_with_config(stream, Some(config)).await,
                None => accept_async(stream).await,
            }) else {
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
                while let Some(Ok(msg)) = stream.next().await {
                    if in_tx.send(msg).is_err() {
                        break;
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

async fn connect_tui(
    ws_url: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    connect_tui_with_ws_config(ws_url, WebSocketConfig::default()).await
}

/// Connect with explicit read caps — the large-frame tests need this: a
/// default-capped (16 MiB frame) test client would reject the very frames the
/// tests assert on (plan §4.2). `disable_nagle = false` matches bare
/// `connect_async` exactly.
async fn connect_tui_with_ws_config(
    ws_url: &str,
    config: WebSocketConfig,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (ws, _) = timeout(
        RECV_TIMEOUT,
        connect_async_with_config(ws_url, Some(config), false),
    )
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
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .expect("proxy should start");

    let mut tui = connect_tui(proxy.ws_url()).await;
    let request =
        json!({"jsonrpc":"2.0","id":1,"method":"foo/bar","params":{"hello":"world"}}).to_string();
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
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
        assert_eq!(
            parsed["id"],
            json!(i),
            "client->upstream ordering must be preserved"
        );
    }

    for i in 0..20 {
        conn.send_text(json!({"id": i, "result": {"n": i}}).to_string());
    }
    for i in 0..20 {
        let received = recv_text(&mut tui).await;
        let parsed: Value = serde_json::from_str(&received).unwrap();
        assert_eq!(
            parsed["id"],
            json!(i),
            "upstream->client ordering must be preserved"
        );
    }

    proxy.close().await;
}

// ── 1b. large-frame relay at the production cap policy (plan §5.1, §5.2) ────────────

/// A single-frame payload comfortably OVER tungstenite's 16 MiB default
/// `max_frame_size` (the incident class: the 17.8 MB `plugin/list` response)
/// and comfortably under the 256 MiB production policy.
const LARGE_FRAME_BYTES: usize = 20 * 1024 * 1024;

#[tokio::test]
async fn relays_an_oversized_upstream_frame_with_production_default_options() {
    // Plan §5.1, upstream direction — the incident's exact shape: a real peer
    // app-server answers a request with a single 20 MiB text frame, and the
    // proxy (production-default options, NO cap injection) must relay it. This
    // proves the DIAL side is configured; a bare (16 MiB) upstream reader dies
    // with a tungstenite Capacity error and tears the relay down.
    let mut upstream = start_large_frame_upstream().await;
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui_with_ws_config(proxy.ws_url(), proxy_ws_config()).await;

    let request = json!({"id": 1, "method": "foo/bar", "params": {}}).to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let mut conn = upstream.accept().await;
    let _ = conn.recv_text().await;

    let response =
        json!({"id": 1, "result": {"payload": huge_string(LARGE_FRAME_BYTES)}}).to_string();
    conn.send_text(response.clone());
    let received = recv_text(&mut tui).await;
    assert_eq!(
        received, response,
        "a 20 MiB upstream frame must relay byte-identical"
    );

    proxy.close().await;
}

#[tokio::test]
async fn relays_an_oversized_client_frame_with_production_default_options() {
    // Plan §5.2, client direction — proves the TUI-facing ACCEPT side is
    // configured: without it, the proxy's own 16 MiB default read cap kills
    // the client frame at ingest and the upstream peer never sees it.
    let mut upstream = start_large_frame_upstream().await;
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui_with_ws_config(proxy.ws_url(), proxy_ws_config()).await;

    let request =
        json!({"id": 3, "method": "foo/big", "params": {"payload": huge_string(LARGE_FRAME_BYTES)}})
            .to_string();
    tui.send(Message::Text(request.clone())).await.unwrap();

    let mut conn = upstream.accept().await;
    let forwarded = conn.recv_text().await;
    assert_eq!(
        forwarded, request,
        "a 20 MiB client frame must relay byte-identical"
    );

    proxy.close().await;
}

// ── 2. oversized-frame rejection (MAX_CODEX_FRAME_BYTES hard cap) ──────────────────

#[tokio::test]
async fn rejects_client_frames_over_max_raw_forward_bytes_with_error_and_closes() {
    // A real (connectable) fake upstream, not an unreachable URL: dialing upstream starts
    // immediately on every accepted client connection (matching legacy), so an unreachable
    // upstream would race the oversized-frame rejection with an unrelated dial-failure
    // teardown of the same connection.
    let mut upstream = start_fake_upstream().await;
    let mut options = CodexRemoteProxyOptions::new(&upstream.ws_url, true);
    options.max_raw_forward_bytes = 256; // tiny cap so the test doesn't allocate 64MB
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let _conn = upstream.accept().await;

    let oversized =
        json!({"id": 1, "method": "thread/start", "params": {"payload": huge_string(1024)}})
            .to_string();
    tui.send(Message::Text(oversized)).await.unwrap();

    let reply = recv_text(&mut tui).await;
    let parsed: Value = serde_json::from_str(&reply).unwrap();
    assert!(
        parsed.get("error").is_some(),
        "expected a JSON-RPC error reply, got {parsed}"
    );

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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    assert_eq!(
        received, response,
        "thread/start response must relay byte-identical"
    );

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

async fn assert_resume_response_observation(history_bytes: usize) {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, false))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let request = json!({"id":"resume-current", "method":"thread/resume", "params":{"threadId":"requested-root"}}).to_string();
    tui.send(Message::Text(request.clone())).await.unwrap();
    let mut conn = upstream.accept().await;
    assert_eq!(conn.recv_text().await, request);
    // The actual returned identity differs from the request. Extraction must
    // surface provider evidence; the host owns the subsequent exact-root gate.
    let response = json!({"id":"resume-current", "result":{"thread":{"id":"actually-loaded-root", "path":"/tmp/owned-native-history.jsonl",
        "ephemeral":false,"turns":[{"items":[{"text":huge_string(history_bytes)}]}]}}}).to_string();
    conn.send_text(response.clone());
    assert_eq!(recv_text(&mut tui).await, response);
    let observed = recv_events(&mut events, 1).await;
    match &observed[0] {
        RemoteProxyEvent::Candidate(candidate) => {
            assert_eq!(candidate.source, CandidateSource::ThreadResumeResponse);
            assert_eq!(candidate.thread.id, "actually-loaded-root");
            assert_eq!(
                candidate.thread.path.as_deref(),
                Some("/tmp/owned-native-history.jsonl")
            );
            assert!(!candidate.thread.ephemeral);
        }
        other => panic!("expected actual loaded native resume candidate, got {other:?}"),
    }
    assert!(
        events.try_recv().is_err(),
        "resume response does not fabricate a started notification"
    );
    proxy.close().await;
}

#[tokio::test]
async fn thread_resume_response_without_started_notification_yields_actual_loaded_candidate() {
    assert_resume_response_observation(8).await;
}

#[tokio::test]
async fn large_thread_resume_response_preserves_bytes_and_bounded_loaded_candidate() {
    assert_resume_response_observation(1024 * 1024 + 4096).await;
}

#[tokio::test]
async fn thread_resume_error_unmatched_and_invalid_results_relay_without_identity_candidates() {
    for fault in [
        "error",
        "unknown-id",
        "unrelated",
        "missing-thread",
        "empty-id",
        "malformed-id",
        "error-and-result",
        "large-error",
        "large-empty",
    ] {
        let mut upstream = start_fake_upstream().await;
        let (proxy, mut events) =
            CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, false))
                .await
                .unwrap();
        let mut tui = connect_tui(proxy.ws_url()).await;
        let request = json!({"id":1,"method":if fault=="unrelated" {"thread/read"} else {"thread/resume"},"params":{"threadId":"requested-root"}}).to_string();
        tui.send(Message::Text(request.clone())).await.unwrap();
        let mut conn = upstream.accept().await;
        assert_eq!(conn.recv_text().await, request);
        let mut response =
            json!({"id":1,"result":{"thread":{"id":"unqualified-root","ephemeral":false}}});
        match fault {
            "error" | "large-error" => {
                response.as_object_mut().unwrap().remove("result");
                response["error"] = json!({"code":-1,"message":if fault=="large-error" {huge_string(1024*1024+4096)} else {"native load failed".into()}});
            }
            "unknown-id" => response["id"] = json!(999),
            "missing-thread" => response["result"] = json!({}),
            "empty-id" | "large-empty" => {
                response["result"]["thread"]["id"] = json!("");
                if fault == "large-empty" {
                    response["result"]["thread"]["turns"] =
                        json!([{"text":huge_string(1024*1024+4096)}]);
                }
            }
            "malformed-id" => response["result"]["thread"]["id"] = json!(42),
            "error-and-result" => {
                response["error"] = json!({"code":-1,"message":"ambiguous failed load"})
            }
            _ => {}
        }
        let response = response.to_string();
        conn.send_text(response.clone());
        assert_eq!(recv_text(&mut tui).await, response, "{fault}");
        // A correlated valid response is an ordered event barrier: any prior
        // invalid candidate would be observed first instead of this root.
        let barrier = json!({"id":2,"method":"thread/resume","params":{"threadId":"loaded-root"}})
            .to_string();
        tui.send(Message::Text(barrier.clone())).await.unwrap();
        assert_eq!(conn.recv_text().await, barrier);
        let result =
            json!({"id":2,"result":{"thread":{"id":"loaded-root","ephemeral":false}}}).to_string();
        conn.send_text(result.clone());
        assert_eq!(recv_text(&mut tui).await, result);
        let observed = recv_events(&mut events, 1).await;
        assert!(
            matches!(&observed[0], RemoteProxyEvent::Candidate(candidate) if candidate.thread.id=="loaded-root" && candidate.source==CandidateSource::ThreadResumeResponse),
            "{fault}: {observed:?}"
        );
        assert!(
            events.try_recv().is_err(),
            "{fault}: unexpected extra identity event"
        );
        proxy.close().await;
    }
}

#[tokio::test]
async fn thread_resume_keeps_ephemeral_native_evidence_explicit_for_the_host_refusal() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, false))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    tui.send(Message::Text(
        json!({"id":1,"method":"thread/resume","params":{"threadId":"expected-root"}}).to_string(),
    ))
    .await
    .unwrap();
    let mut conn = upstream.accept().await;
    conn.recv_text().await;
    let response =
        json!({"id":1,"result":{"thread":{"id":"actual-ephemeral-root","ephemeral":true}}})
            .to_string();
    conn.send_text(response.clone());
    assert_eq!(recv_text(&mut tui).await, response);
    let observed = recv_events(&mut events, 1).await;
    assert!(
        matches!(&observed[0], RemoteProxyEvent::Candidate(candidate) if candidate.thread.id=="actual-ephemeral-root" && candidate.thread.ephemeral && candidate.source==CandidateSource::ThreadResumeResponse)
    );
    proxy.close().await;
}

// ── 4. thread/fork request rewrite + response normalization ────────────────────────

#[tokio::test]
async fn thread_fork_request_is_rewritten_to_exclude_turns_before_forwarding() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    // S5.c: release the identity gate up front — this test exercises fork rewrite, not the gate.
    proxy.mark_candidate_persisted();
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
    assert_ne!(
        forwarded, request,
        "the fork request must be rewritten, not forwarded verbatim"
    );
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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    // S5.c: release the identity gate up front — this test exercises fork rewrite, not the gate.
    proxy.mark_candidate_persisted();
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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    assert!(received_events.iter().any(
        |e| matches!(e, RemoteProxyEvent::ThreadStarted(l) if l.thread.id == "thread-notified")
    ));

    proxy.close().await;
}

#[tokio::test]
async fn turn_started_and_completed_notifications_carry_full_params_for_small_frames() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
async fn small_turn_notifications_extract_inline_turn_ids() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({"method": "turn/started", "params": {"threadId": "t1", "turn": {"id": "inline-start"}}})
            .to_string(),
    );
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnStarted(event) => {
            assert_eq!(event.turn_id.as_deref(), Some("inline-start"));
            assert_eq!(event.params["turn"]["id"], json!("inline-start"));
        }
        other => panic!("expected TurnStarted, got {other:?}"),
    }

    conn.send_text(
        json!({"method": "turn/completed", "params": {"threadId": "t1", "turn": {"id": "inline-complete", "status": "completed"}}})
            .to_string(),
    );
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnCompleted(event) => {
            assert_eq!(event.turn_id.as_deref(), Some("inline-complete"));
            assert_eq!(event.params["turn"]["status"], json!("completed"));
        }
        other => panic!("expected TurnCompleted, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn oversized_turn_notifications_extract_inline_turn_ids() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;
    let padding = huge_string(2 * 1024 * 1024);

    let started = json!({
        "method": "turn/started",
        "params": {"threadId": "t1", "turn": {"id": "inline-large-start"}, "padding": padding},
    })
    .to_string();
    assert!(started.len() > 1024 * 1024);
    conn.send_text(started);
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnStarted(event) => {
            assert_eq!(event.turn_id.as_deref(), Some("inline-large-start"));
        }
        other => panic!("expected TurnStarted, got {other:?}"),
    }

    let completed = json!({
        "method": "turn/completed",
        "params": {
            "threadId": "t1",
            "turn": {"id": "inline-large-complete", "status": "completed"},
            "padding": padding,
        },
    })
    .to_string();
    assert!(completed.len() > 1024 * 1024);
    conn.send_text(completed);
    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::TurnCompleted(event) => {
            assert_eq!(event.turn_id.as_deref(), Some("inline-large-complete"));
            assert_eq!(event.params.get("status"), Some(&json!("completed")));
        }
        other => panic!("expected TurnCompleted, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn fs_changed_notification_emits_a_repair_trigger() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({"method": "fs/changed", "params": {"watchId": "w1", "changedPaths": ["/repo/a.rs"]}}).to_string(),
    );

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::FsChanged {
            watch_id,
            changed_paths,
        }) => {
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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    conn.send_text(
        json!({"method": "turn/started", "params": {"threadId": "t1", "turnId": "turn-1"}})
            .to_string(),
    );
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
    assert!(
        never_reaches_upstream.is_err(),
        "turn/interrupt for a completed turn must be short-circuited locally"
    );

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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let _conn = upstream.accept().await;

    tui.send(Message::Text("{not valid json".to_string()))
        .await
        .unwrap();

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
    let (proxy2, _events2) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream2.ws_url, true))
            .await
            .unwrap();
    let mut tui2 = connect_tui(proxy2.ws_url()).await;
    let request = json!({"id": 1, "method": "still/alive", "params": {}}).to_string();
    tui2.send(Message::Text(request.clone())).await.unwrap();
    let mut conn2 = upstream2.accept().await;
    let forwarded = conn2.recv_text().await;
    assert_eq!(
        forwarded, request,
        "a fresh connection must still relay correctly after a malformed frame"
    );

    proxy.close().await;
    proxy2.close().await;
}

#[tokio::test]
async fn malformed_frame_from_upstream_fails_closed_without_crashing() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
        assert_eq!(
            parsed["params"]["n"],
            json!(i),
            "no message should be dropped or reordered under slow consumption"
        );
    }

    proxy.close().await;
}

// ── 10. approval-request sniffing (decisions 5/6/7) ─────────────────────────────────

/// Polls briefly and asserts NO proxy event arrives — used to prove non-approval
/// frames and unknown-id responses stay event-silent.
async fn assert_no_event(rx: &mut mpsc::UnboundedReceiver<RemoteProxyEvent>) {
    let res = timeout(Duration::from_millis(300), rx.recv()).await;
    assert!(res.is_err(), "expected no proxy event, got {res:?}");
}

#[tokio::test]
async fn approval_request_frame_emits_approval_requested_and_relays_verbatim() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    let frame = json!({
        "jsonrpc": "2.0",
        "id": 41,
        "method": "item/commandExecution/requestApproval",
        "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
    })
    .to_string();
    conn.send_text(frame.clone());

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::ApprovalRequested(params) => {
            assert_eq!(params.request_id, "41");
            assert_eq!(params.method, "item/commandExecution/requestApproval");
            assert_eq!(params.thread_id.as_deref(), Some("thread-1"));
        }
        other => panic!("expected ApprovalRequested, got {other:?}"),
    }

    let relayed = recv_text(&mut tui).await;
    assert_eq!(
        relayed, frame,
        "the approval request must relay to the client byte-identical"
    );

    proxy.close().await;
}

#[tokio::test]
async fn non_approval_server_request_is_relayed_without_events() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    let frame = json!({
        "jsonrpc": "2.0",
        "id": 41,
        "method": "item/tool/call",
        "params": {"threadId": "thread-1"},
    })
    .to_string();
    conn.send_text(frame.clone());

    let relayed = recv_text(&mut tui).await;
    assert_eq!(
        relayed, frame,
        "automated server request must relay verbatim"
    );
    assert_no_event(&mut events).await;

    proxy.close().await;
}

#[tokio::test]
async fn approval_response_emits_approval_resolved_and_forwards_upstream() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );
    let _ = recv_events(&mut events, 1).await; // ApprovalRequested
    let _ = recv_text(&mut tui).await; // the relayed approval request

    let response =
        json!({"jsonrpc": "2.0", "id": 41, "result": {"decision": "approved"}}).to_string();
    tui.send(Message::Text(response.clone())).await.unwrap();

    let received_events = recv_events(&mut events, 1).await;
    assert_eq!(
        received_events[0],
        RemoteProxyEvent::ApprovalResolved {
            request_id: "41".to_string()
        }
    );

    let forwarded = conn.recv_text().await;
    assert_eq!(
        forwarded, response,
        "the approval response must forward upstream unchanged"
    );

    proxy.close().await;
}

#[tokio::test]
async fn client_response_with_unknown_id_emits_nothing() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    let response = json!({"id": 999, "result": {}}).to_string();
    tui.send(Message::Text(response.clone())).await.unwrap();

    let forwarded = conn.recv_text().await;
    assert_eq!(forwarded, response);
    assert_no_event(&mut events).await;

    proxy.close().await;
}

#[tokio::test]
async fn approval_request_without_thread_id_yields_none() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::ApprovalRequested(params) => {
            assert_eq!(params.request_id, "41");
            assert_eq!(params.thread_id, None);
        }
        other => panic!("expected ApprovalRequested, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn legacy_approval_reads_conversation_id() {
    // Decision 7 / audit A3: legacy methods carry params.conversationId, not
    // params.threadId (codex-rs v1.rs:126-158).
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "execCommandApproval",
            "params": {"conversationId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::ApprovalRequested(params) => {
            assert_eq!(params.request_id, "42");
            assert_eq!(params.method, "execCommandApproval");
            assert_eq!(params.thread_id.as_deref(), Some("thread-1"));
        }
        other => panic!("expected ApprovalRequested, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn error_response_also_resolves() {
    // Decision 5a / audit A5: a client {id, error} response resolves identically to
    // {id, result} — codex handles errors via process_error.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );
    let _ = recv_events(&mut events, 1).await; // ApprovalRequested
    let _ = recv_text(&mut tui).await; // the relayed approval request

    let response =
        json!({"jsonrpc": "2.0", "id": 41, "error": {"code": -1, "message": "denied"}}).to_string();
    tui.send(Message::Text(response.clone())).await.unwrap();

    let received_events = recv_events(&mut events, 1).await;
    assert_eq!(
        received_events[0],
        RemoteProxyEvent::ApprovalResolved {
            request_id: "41".to_string()
        }
    );

    let forwarded = conn.recv_text().await;
    assert_eq!(forwarded, response);

    proxy.close().await;
}

#[tokio::test]
async fn client_frame_with_id_and_method_never_resolves() {
    // Decision 5d: response matching REQUIRES method-absence — a client REQUEST whose
    // id numerically collides with a pending server approval must not resolve it.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );
    let _ = recv_events(&mut events, 1).await; // ApprovalRequested
    let _ = recv_text(&mut tui).await; // the relayed approval request

    let colliding_request =
        json!({"jsonrpc": "2.0", "id": 41, "method": "thread/start", "params": {}}).to_string();
    tui.send(Message::Text(colliding_request.clone()))
        .await
        .unwrap();

    let forwarded = conn.recv_text().await;
    assert_eq!(
        forwarded, colliding_request,
        "the colliding client REQUEST must forward upstream unchanged"
    );
    assert_no_event(&mut events).await;

    proxy.close().await;
}

#[tokio::test]
async fn server_request_resolved_notification_resolves() {
    // Decision 5c: the upstream `serverRequest/resolved` notification (fields
    // {thread_id, request_id} under camelCase serde rename — codex
    // v2/notification.rs:53-56 @0.146.0) resolves the pending approval.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );
    let _ = recv_events(&mut events, 1).await; // ApprovalRequested
    let _ = recv_text(&mut tui).await; // the relayed approval request

    let notification = json!({
        "method": "serverRequest/resolved",
        "params": {"threadId": "thread-1", "requestId": "41"},
    })
    .to_string();
    conn.send_text(notification.clone());

    let received_events = recv_events(&mut events, 1).await;
    assert_eq!(
        received_events[0],
        RemoteProxyEvent::ApprovalResolved {
            request_id: "41".to_string()
        }
    );

    let relayed = recv_text(&mut tui).await;
    assert_eq!(
        relayed, notification,
        "the resolved notification must relay to the client verbatim"
    );

    proxy.close().await;
}

#[tokio::test]
async fn upstream_reconnect_clears_pending_approvals() {
    // Decision 5b: upstream teardown drains ALL pending approvals — the restarted
    // app-server's per-process id counter starts at 0 again and stale ids would collide.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text(
        json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "thread-1", "command": "rm -rf /tmp/x"},
        })
        .to_string(),
    );
    let _ = recv_events(&mut events, 1).await; // ApprovalRequested
    let _ = recv_text(&mut tui).await; // the relayed approval request

    drop(conn); // upstream goes away (the harness's disconnect simulation)

    let received_events = recv_events(&mut events, 2).await;
    assert!(
        received_events.iter().any(|e| matches!(
            e,
            RemoteProxyEvent::ApprovalResolved { request_id } if request_id == "41"
        )),
        "expected the drained pending approval to resolve, got {received_events:?}"
    );

    proxy.close().await;
}

#[tokio::test]
async fn unknown_server_request_method_is_logged_not_belled() {
    // Decision 6: an unrecognized server->client request method is debug-logged and
    // relayed — never treated as an approval.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    let frame = json!({"jsonrpc": "2.0", "id": 43, "method": "some/future/method", "params": {}})
        .to_string();
    conn.send_text(frame.clone());

    let relayed = recv_text(&mut tui).await;
    assert_eq!(relayed, frame, "unknown server request must relay verbatim");
    assert_no_event(&mut events).await;

    proxy.close().await;
}

// ── 11. close() tears down active connections and stops accepting new ones ─────────

#[tokio::test]
async fn close_tears_down_active_connections_and_stops_accepting_new_ones() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, _events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream.ws_url, true))
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
    if let Ok(Ok(_)) = reconnect {
        panic!("expected connecting after close() to fail (listener stopped)");
    }
}

// ── 12. over-cap rejection at the transport boundary: classified Capacity
//         triggers with their own rate limit + generic-pair suppression
//         (plan 2026-10-20-codex-proxy-ws-frame-cap.md §4.3.1, tests §5.3/§5.8) ───────

/// Options with transport caps == hub policy at exact equality (plan §4.1):
/// the over-cap boundary tests inject one small cap for all three so frames
/// die at the transport, from the frame header, without allocating MiBs.
/// Mirrors candidate_gate.rs's `gate_options` injection pattern.
fn equality_options(upstream: &str, cap: usize) -> CodexRemoteProxyOptions {
    let mut options = CodexRemoteProxyOptions::new(upstream, true);
    options.max_raw_forward_bytes = cap;
    options.max_ws_frame_bytes = cap;
    options.max_ws_message_bytes = cap;
    options
}

/// Reads until the socket ends and asserts NO text frame (no JSON-RPC error
/// reply) arrives first. The STYLE of the close is deliberately NOT asserted
/// (plan §5.3: the teardown's `WriterMsg::Close` behavior is expressly
/// unchanged) — a close frame, a raw transport error, or a silent stream end
/// are all accepted as the end.
async fn assert_socket_ends_without_a_text_frame<S>(ws: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    for _ in 0..8 {
        match timeout(RECV_TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for the socket to end")
        {
            Some(Ok(Message::Text(text))) => panic!(
                "the proxy must not answer an over-cap frame with a JSON-RPC reply, got: {text:.512}"
            ),
            Some(Ok(_)) => continue, // close/control frames: keep draining to the end
            Some(Err(_)) | None => return, // the socket ended; style deliberately unpinned
        }
    }
}

#[tokio::test]
async fn over_cap_upstream_frame_at_transport_equality_is_rejected_with_a_classified_capacity_trigger(
) {
    // Plan §5.3(i), upstream direction (the incident direction) at production
    // equality — transport caps == hub policy, all 1 MiB: a 2 MiB upstream
    // response frame is rejected by the TRANSPORT from its frame header (never
    // buffered, never relayed), producing the DISTINCT classified Capacity
    // trigger, a connection close, and NO JSON-RPC error reply to the client
    // (at equality the hub's JSON-RPC rejection is unreachable).
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(equality_options(&upstream.ws_url, 1024 * 1024))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    let request = json!({"id": 1, "method": "foo/bar", "params": {}}).to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let _ = conn.recv_text().await;

    // A 2 MiB single frame: rejected at the header against the 1 MiB caps. The
    // exact size makes the classified trigger's error text assertable verbatim.
    conn.send_text("x".repeat(2 * 1024 * 1024));

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("upstream connection failed on the WebSocket capacity limit"),
                "the classified Capacity trigger must distinctly identify the capacity failure, got: {message}"
            );
            assert!(
                message.contains("Message too long: 2097152 > 1048576"),
                "the trigger must embed the ACTUAL error text (real sizes + configured limit), got: {message}"
            );
        }
        other => panic!("expected a classified Capacity ProxyError trigger, got {other:?}"),
    }

    // The connection closes with NO JSON-RPC error reply to the client.
    assert_socket_ends_without_a_text_frame(&mut tui).await;
    // Nothing else fires for this teardown — the generic errored pair is
    // suppressed behind the classified line; the client leg ends silently.
    assert_no_event(&mut events).await;

    proxy.close().await;
}

#[tokio::test]
async fn over_cap_client_frame_at_transport_equality_is_rejected_with_a_classified_capacity_trigger(
) {
    // Plan §5.3 client-direction mirror at production equality: an oversized
    // CLIENT frame dies at the TUI-facing ACCEPT transport (from its header)
    // with the classified trigger and NO JSON-RPC error reply. The existing
    // 256-byte test pins the hub's client-direction rejection under injected
    // ASYMMETRY; at equality the transport fires first — do not conflate.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(equality_options(&upstream.ws_url, 1024 * 1024))
            .await
            .unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    // The test client's own transport (tungstenite defaults) writes the 2 MiB
    // frame fine; the proxy's accept side rejects it from the header. The
    // send may fail once the teardown lands — the rejection is the point.
    let _ = tui.send(Message::Text("x".repeat(2 * 1024 * 1024))).await;

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("client connection failed on the WebSocket capacity limit"),
                "the client-direction classified trigger must identify the capacity failure, got: {message}"
            );
            assert!(
                message.contains("Message too long: 2097152 > 1048576"),
                "the trigger must embed the ACTUAL error text, got: {message}"
            );
        }
        other => panic!("expected a classified Capacity ProxyError trigger, got {other:?}"),
    }

    // No JSON-RPC error reply reaches the client before its socket ends.
    assert_socket_ends_without_a_text_frame(&mut tui).await;

    // The teardown window after the classified line must stay silent. The
    // hub's close also closes the UPSTREAM writer; the peer echoes the close
    // (observed here) and a real app-server then closes its socket — which
    // is what ends the proxy's upstream read loop and surfaces at the hub
    // as `UpstreamClosed`. That arm must NOT add the generic ProxyClose
    // half of the teardown pair (§4.3.1c: the classified line IS the record
    // for this connection). The harness holds the peer socket open via
    // `conn`, so complete the peer side the way the §7 disconnect tests do.
    let closed = timeout(RECV_TIMEOUT, conn.incoming.recv()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Message::Close(_))),
        "the fake upstream must observe the teardown, got {closed:?}"
    );
    drop(conn);
    assert_no_event(&mut events).await;

    proxy.close().await;
}

#[tokio::test]
async fn over_cap_upstream_frame_with_transport_over_hub_asymmetry_hits_the_raw_forward_cap_guard()
{
    // Plan §5.3(ii) — hub belt-and-suspenders pinned independently of the
    // transport: transport caps 4 MiB > hub policy 1 MiB, so the 2 MiB frame
    // reaches the hub and takes the upstream-path rejection
    // (`raw_forward_cap_exceeded`): trigger + close, and still NO JSON-RPC
    // error reply (the upstream rejection path never writes to the client).
    let mut upstream = start_fake_upstream().await;
    let mut options = CodexRemoteProxyOptions::new(&upstream.ws_url, true);
    options.max_raw_forward_bytes = 1024 * 1024;
    options.max_ws_frame_bytes = 4 * 1024 * 1024;
    options.max_ws_message_bytes = 4 * 1024 * 1024;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut tui = connect_tui(proxy.ws_url()).await;
    let mut conn = upstream.accept().await;

    let request = json!({"id": 1, "method": "foo/bar", "params": {}}).to_string();
    tui.send(Message::Text(request)).await.unwrap();
    let _ = conn.recv_text().await;

    conn.send_text("x".repeat(2 * 1024 * 1024));

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert_eq!(
                *message,
                "Codex remote proxy rejected an unsafe upstream frame: raw_forward_cap_exceeded.",
                "the hub's belt-and-suspenders guard must own the rejection when the transport cap is higher"
            );
        }
        other => panic!("expected the hub raw_forward_cap_exceeded trigger, got {other:?}"),
    }

    assert_socket_ends_without_a_text_frame(&mut tui).await;

    proxy.close().await;
}

#[tokio::test]
async fn over_cap_reconnect_cycles_emit_at_most_one_classified_trigger_per_interval() {
    // Plan §4.3.1b/c boundedness, scoped to this task's triggers: a >cap
    // reconnect cycle emits ONE classified line per interval per proxy — the
    // generic teardown pair is suppressed behind it — and the limiter re-arms
    // once the injected interval (700 ms — comfortably above this test's own
    // two 300 ms negative polls) elapses. Each cycle drops its TUI abruptly
    // so the client leg ERRORS during teardown (the incident's exact pair
    // shape), not clean-closes.
    let mut upstream = start_fake_upstream().await;
    let mut options = equality_options(&upstream.ws_url, 1024 * 1024);
    options.capacity_trigger_min_interval_ms = 700;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();

    // Cycle 1: the classified trigger fires.
    let tui1 = connect_tui(proxy.ws_url()).await;
    let conn1 = upstream.accept().await;
    conn1.send_text("x".repeat(2 * 1024 * 1024));
    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        &received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message })
            if message.contains("upstream connection failed on the WebSocket capacity limit")
    ));
    drop(tui1); // abrupt: the client leg errors (Other) during teardown — suppressed
    assert_no_event(&mut events).await;

    // Cycle 2 (within the interval): the classified trigger is rate-limited and
    // the generic pair suppressed — but the connection still tears down.
    let tui2 = connect_tui(proxy.ws_url()).await;
    let mut conn2 = upstream.accept().await;
    conn2.send_text("x".repeat(2 * 1024 * 1024));
    // Wait for the hub to process the (rate-limited, silent) Capacity error
    // BEFORE dropping the TUI: the teardown it causes is what makes the client
    // leg error, so causality guarantees the classified mark is set first —
    // the same order the real incident's pair always has.
    let closed = timeout(RECV_TIMEOUT, conn2.incoming.recv()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Message::Close(_))),
        "the fake upstream must observe the teardown of the suppressed cycle, got {closed:?}"
    );
    drop(tui2);
    assert_no_event(&mut events).await;

    // Once the interval elapses, the next cycle's classified trigger fires again.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let tui3 = connect_tui(proxy.ws_url()).await;
    let conn3 = upstream.accept().await;
    conn3.send_text("x".repeat(2 * 1024 * 1024));
    let received_events = recv_events(&mut events, 1).await;
    assert!(matches!(
        &received_events[0],
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message })
            if message.contains("failed on the WebSocket capacity limit")
    ));

    drop(tui3);
    proxy.close().await;
}

#[tokio::test]
async fn classified_capacity_trigger_text_embeds_the_actual_error_and_configured_limit() {
    // Plan §5.8: an injected tiny transport cap (1024) forces a Capacity error
    // on a 2048-byte frame; the distinct trigger text embeds the ACTUAL
    // tungstenite error ("Message too long: ..." with the real size numbers —
    // which itself carries the configured limit) and invents no size claim.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(equality_options(&upstream.ws_url, 1024))
        .await
        .unwrap();
    let _tui = connect_tui(proxy.ws_url()).await;
    let conn = upstream.accept().await;

    conn.send_text("x".repeat(2048));

    let received_events = recv_events(&mut events, 1).await;
    match &received_events[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("failed on the WebSocket capacity limit"),
                "the trigger must be the distinct classified line, got: {message}"
            );
            assert!(
                message.contains("Message too long: 2048 > 1024"),
                "the trigger must embed the actual error text with the real size numbers and the configured limit, got: {message}"
            );
        }
        other => panic!("expected the classified Capacity trigger, got {other:?}"),
    }

    proxy.close().await;
}

// ── 13. growth canary at hub ingest: per-proxy rate limit, division of
//         coverage, and limiter independence (plan §4.3.2, tests §5.7) ─────────

/// Options for the canary tests: production-equality caps at 1 MiB (transport
/// == hub policy, plan §4.1), a 512 KiB growth-canary threshold sitting in the
/// growth zone BELOW the cap, and BOTH rate-limit intervals stretched to 60 s
/// so each whole test runs inside a single interval of each limiter (mirrors
/// `candidate_gate.rs`'s keep-inert injection pattern).
fn canary_options(upstream: &str) -> CodexRemoteProxyOptions {
    let mut options = equality_options(upstream, 1024 * 1024);
    options.canary_warn_bytes = 512 * 1024;
    options.canary_min_warn_interval_ms = 60_000;
    options.capacity_trigger_min_interval_ms = 60_000;
    options
}

/// A valid JSON-RPC response frame of EXACTLY `total_bytes` bytes. The
/// canary-zone traffic (over the 512 KiB threshold, under the 1 MiB caps)
/// must be a well-formed envelope so it passes the hub's scan and relays
/// instead of dying on the malformed-frame path — the canary observes real
/// traffic, it does not get fed garbage.
fn upstream_result_frame_of(total_bytes: usize) -> String {
    let with_empty = json!({"id": 1, "result": {"pad": ""}}).to_string();
    assert!(
        total_bytes > with_empty.len(),
        "frame target {total_bytes} is smaller than the envelope scaffold"
    );
    json!({"id": 1, "result": {"pad": "x".repeat(total_bytes - with_empty.len())}}).to_string()
}

/// The over-cap single-frame death (the incident shape): with equality caps at
/// 1 MiB the 2 MiB frame is rejected by the transport from its header — before
/// any payload buffers — and never reaches hub ingest. The exact size keeps
/// the classified trigger's embedded error text assertable.
const OVER_CAP_DEATH_FRAME_BYTES: usize = 2 * 1024 * 1024;

#[tokio::test]
async fn canary_zone_reconnect_loop_yields_at_most_one_warning_line_per_interval() {
    // Plan §5.7(a): several connect / send / teardown cycles within the
    // interval stay bounded — the growth canary and the classified Capacity
    // trigger each emit at most one line per interval PER PROXY (not per
    // connection), and the generic teardown pair is suppressed behind the
    // classified line (Task 004, §4.3.1c). The loop runs in the UPSTREAM
    // direction (the incident shape, where the bound holds across all
    // trigger variants): each cycle first carries canary-zone traffic
    // (768 KiB: over the threshold, under the caps) and then dies on an
    // over-cap frame, so a per-connection or unrate-limited canary would
    // emit one line per cycle. Expected total across three cycles: exactly
    // the two first lines (canary + classified), nothing else — not 2x the
    // cycles.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(canary_options(&upstream.ws_url))
        .await
        .unwrap();

    for cycle in 0..3 {
        let mut tui = connect_tui(proxy.ws_url()).await;
        let mut conn = upstream.accept().await;
        conn.send_text(upstream_result_frame_of(768 * 1024));
        conn.send_text("x".repeat(OVER_CAP_DEATH_FRAME_BYTES));

        if cycle == 0 {
            let received = recv_events(&mut events, 2).await;
            match &received[0] {
                RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message,
                }) => {
                    assert!(
                        message.contains("growth-canary"),
                        "cycle 0's first line must be the growth-canary warning, got: {message}"
                    );
                    assert!(
                        message.contains("786432 bytes") && message.contains("524288"),
                        "the canary warning must state the frame size and the threshold, got: {message}"
                    );
                }
                other => panic!("expected the growth-canary warning first, got {other:?}"),
            }
            match &received[1] {
                RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError {
                    message,
                }) => {
                    assert!(
                        message.contains("failed on the WebSocket capacity limit"),
                        "cycle 0's second line must be the classified Capacity trigger, got: {message}"
                    );
                }
                other => panic!("expected the classified Capacity trigger second, got {other:?}"),
            }
            // The canary is warn-only: the 768 KiB frame still relays.
            let relayed = recv_text(&mut tui).await;
            assert_eq!(
                relayed.len(),
                768 * 1024,
                "the canary must not reject or alter the frame"
            );
        } else {
            // Within the interval: the canary and the classified trigger are
            // both rate-limited and the generic pair is suppressed — the
            // whole cycle is silent.
            assert_no_event(&mut events).await;
        }

        // Wait for the teardown to reach the fake upstream, then drop the
        // TUI abruptly — the client leg's generic error stays suppressed
        // behind the classified mark (the incident's exact pair shape).
        let closed = timeout(RECV_TIMEOUT, conn.incoming.recv()).await.unwrap();
        assert!(
            matches!(closed, None | Some(Message::Close(_))),
            "the fake upstream must observe the teardown of cycle {cycle}, got {closed:?}"
        );
        drop(tui);
        assert_no_event(&mut events).await;
    }

    proxy.close().await;
}

#[tokio::test]
async fn over_cap_frame_fires_the_capacity_trigger_not_the_hub_canary() {
    // Plan §5.7(b) — division of coverage: at production equality an over-cap
    // frame is rejected by the TRANSPORT from its header and never reaches
    // hub ingest, so the over-cap zone belongs to the classified, rate-limited
    // Capacity trigger (§4.3.1) and the hub canary must stay silent for it —
    // even though the 2 MiB frame would also exceed the 512 KiB canary
    // threshold had it reached the hub. The contrast leg pins the other side
    // of the division: a canary-zone frame that DOES reach ingest still warns
    // within the same interval — the over-cap death consumed the Capacity
    // limiter only, never the canary's (the limiters are separate, §4.3.1a).
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(canary_options(&upstream.ws_url))
        .await
        .unwrap();

    // Leg 1: the over-cap death — the classified Capacity trigger, NO canary.
    let tui1 = connect_tui(proxy.ws_url()).await;
    let mut conn1 = upstream.accept().await;
    conn1.send_text("x".repeat(OVER_CAP_DEATH_FRAME_BYTES));

    let received = recv_events(&mut events, 1).await;
    match &received[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("upstream connection failed on the WebSocket capacity limit"),
                "the over-cap frame must produce the classified Capacity trigger, got: {message}"
            );
        }
        other => panic!("expected the classified Capacity trigger, got {other:?}"),
    }
    // The canary stays silent for the over-cap frame — and no generic pair.
    assert_no_event(&mut events).await;
    let closed = timeout(RECV_TIMEOUT, conn1.incoming.recv()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Message::Close(_))),
        "the fake upstream must observe the teardown, got {closed:?}"
    );
    drop(tui1);
    assert_no_event(&mut events).await;

    // Leg 2, same interval: a canary-zone frame reaches ingest and warns.
    // (_tui2 stays bound so the connection is alive through the warning.)
    let _tui2 = connect_tui(proxy.ws_url()).await;
    let conn2 = upstream.accept().await;
    conn2.send_text(upstream_result_frame_of(768 * 1024));
    let received = recv_events(&mut events, 1).await;
    match &received[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("growth-canary") && message.contains("786432 bytes"),
                "the canary-zone frame must warn even though the Capacity limiter already fired this interval, got: {message}"
            );
        }
        other => panic!("expected the growth-canary warning, got {other:?}"),
    }

    proxy.close().await;
}

#[tokio::test]
async fn canary_warning_does_not_suppress_the_first_over_cap_capacity_trigger() {
    // Plan §5.7(c) — limiter independence (§4.3.1a): a growth sequence
    // inherently crosses the canary BEFORE the cap, so the canary warning
    // must never consume the Capacity trigger's first line: an under-cap
    // over-threshold frame (canary warns), followed WITHIN the interval by an
    // over-cap frame, STILL produces the classified Capacity trigger. Also
    // pins: the canary is warn-only (the flagged frame relays), and frames
    // below the canary threshold never warn.
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(canary_options(&upstream.ws_url))
        .await
        .unwrap();

    // Phase 1: the canary-zone frame — the canary warns, the frame relays.
    let mut tui1 = connect_tui(proxy.ws_url()).await;
    let mut conn1 = upstream.accept().await;
    conn1.send_text(upstream_result_frame_of(768 * 1024));
    let received = recv_events(&mut events, 1).await;
    match &received[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("growth-canary"),
                "the canary-zone frame must warn, got: {message}"
            );
            assert!(
                message.contains("786432 bytes") && message.contains("524288"),
                "the canary warning must state the frame size and the threshold, got: {message}"
            );
        }
        other => panic!("expected the growth-canary warning, got {other:?}"),
    }
    assert_no_event(&mut events).await;
    let relayed = recv_text(&mut tui1).await;
    assert_eq!(
        relayed.len(),
        768 * 1024,
        "the canary must not reject or alter the frame"
    );

    // Phase 2, WITHIN the interval: the over-cap death — the classified
    // Capacity trigger STILL fires (a shared limiter would have swallowed
    // the first over-cap diagnostic).
    conn1.send_text("x".repeat(OVER_CAP_DEATH_FRAME_BYTES));
    let received = recv_events(&mut events, 1).await;
    match &received[0] {
        RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::ProxyError { message }) => {
            assert!(
                message.contains("failed on the WebSocket capacity limit")
                    && message.contains("Message too long: 2097152 > 1048576"),
                "the first over-cap frame after a canary warning must still produce the full classified Capacity trigger, got: {message}"
            );
        }
        other => panic!("expected the classified Capacity trigger, got {other:?}"),
    }
    let closed = timeout(RECV_TIMEOUT, conn1.incoming.recv()).await.unwrap();
    assert!(
        matches!(closed, None | Some(Message::Close(_))),
        "the fake upstream must observe the teardown, got {closed:?}"
    );
    drop(tui1);
    assert_no_event(&mut events).await;

    // Phase 3: a BELOW-threshold frame never warns (and still relays).
    let mut tui2 = connect_tui(proxy.ws_url()).await;
    let conn2 = upstream.accept().await;
    conn2.send_text(upstream_result_frame_of(64 * 1024));
    assert_no_event(&mut events).await;
    let relayed = recv_text(&mut tui2).await;
    assert_eq!(
        relayed.len(),
        64 * 1024,
        "the below-threshold frame must relay"
    );

    proxy.close().await;
}

// ── 14. the live repair-trigger loop stays fixed (name-reliability plan
//         2026-10-21, Task 12 Step 0) ────────────────────────────────────────────

/// The live log's repair-trigger flood (~1.6 lines per second per codex pane,
/// "upstream connection errored." then "client connection errored.") was one
/// loop per pane: the TUI polls `plugin/list`, whose ~17.8 MB response
/// exceeded the proxy's old 16 MiB transport default, so the upstream read
/// failed, the hub tore the connection down, and the TUI reconnected and
/// polled again. This is the size of that response.
const INCIDENT_PLUGIN_LIST_BYTES: usize = 17_800_000;

/// How long the reconnecting TUI runs. The old caps looped roughly every
/// second on loopback, so this window would have seen several cycles.
const RECONNECT_LOOP_WINDOW: Duration = Duration::from_secs(5);

/// An upstream app-server that answers EVERY request on EVERY connection with
/// the incident-sized `plugin/list` response (its sockets read at the proxy
/// caps, like a real app-server's uncapped reader). Counts accepted
/// connections.
async fn start_plugin_list_upstream() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&accepted);
    let response = Arc::new(
        json!({"id": 1, "result": {"data": huge_string(INCIDENT_PLUGIN_LIST_BYTES)}}).to_string(),
    );
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            counter.fetch_add(1, Ordering::SeqCst);
            let response = Arc::clone(&response);
            tokio::spawn(async move {
                let Ok(mut ws) = accept_async_with_config(stream, Some(proxy_ws_config())).await
                else {
                    return;
                };
                while let Some(Ok(message)) = ws.next().await {
                    if matches!(message, Message::Text(_))
                        && ws
                            .send(Message::Text(response.as_ref().clone()))
                            .await
                            .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    (format!("ws://{}:{}", addr.ip(), addr.port()), accepted)
}

/// What the reconnecting TUI saw by the end of its window.
struct TuiLoopReport {
    connects: usize,
    responses: usize,
    /// The connection open at the deadline (closed by the caller after it has
    /// drained the proxy's events, so the test's own teardown is not counted).
    open: Option<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
}

/// The incident TUI: poll `plugin/list` every 500 ms and reconnect at once
/// whenever the socket ends, until `window` elapses.
async fn run_reconnecting_plugin_list_tui(proxy_url: &str, window: Duration) -> TuiLoopReport {
    let deadline = tokio::time::Instant::now() + window;
    let mut report = TuiLoopReport {
        connects: 0,
        responses: 0,
        open: None,
    };
    let poll = json!({"id": 1, "method": "plugin/list", "params": {}}).to_string();
    while tokio::time::Instant::now() < deadline {
        let mut ws = connect_tui_with_ws_config(proxy_url, proxy_ws_config()).await;
        report.connects += 1;
        let mut next_poll = tokio::time::Instant::now();
        loop {
            if tokio::time::Instant::now() >= deadline {
                report.open = Some(ws);
                return report;
            }
            if tokio::time::Instant::now() >= next_poll {
                if ws.send(Message::Text(poll.clone())).await.is_err() {
                    break;
                }
                next_poll += Duration::from_millis(500);
            }
            let wake = next_poll.min(deadline);
            match tokio::time::timeout_at(wake, ws.next()).await {
                Err(_) => continue,
                Ok(Some(Ok(Message::Text(text)))) => {
                    if text.len() >= INCIDENT_PLUGIN_LIST_BYTES {
                        report.responses += 1;
                    }
                }
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) | Ok(None) => break,
            }
        }
    }
    report
}

#[tokio::test]
async fn incident_shaped_polling_tui_keeps_one_connection_and_logs_no_repair_trigger() {
    // Production-default options (no cap injection): the 17.8 MB response
    // relays, so the TUI is never disconnected, never reconnects, and the
    // proxy reports nothing. With the old 16 MiB transport cap the same
    // TUI reconnected every cycle (the loop the live log recorded).
    let (upstream_url, accepted) = start_plugin_list_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(&upstream_url, true))
            .await
            .unwrap();

    let report = run_reconnecting_plugin_list_tui(proxy.ws_url(), RECONNECT_LOOP_WINDOW).await;

    let mut triggers = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let RemoteProxyEvent::RepairTrigger(trigger) = event {
            triggers.push(trigger);
        }
    }
    assert_eq!(
        (report.connects, accepted.load(Ordering::SeqCst)),
        (1, 1),
        "the TUI keeps one connection (and the proxy one upstream dial) for the whole window \
         (repair triggers seen: {triggers:?})"
    );
    assert!(
        report.responses >= 2,
        "the TUI must actually receive the incident-sized response (got {} in {:?})",
        report.responses,
        RECONNECT_LOOP_WINDOW
    );
    assert_eq!(
        triggers,
        Vec::<RemoteProxyRepairTrigger>::new(),
        "an incident-sized response must not produce repair triggers"
    );

    if let Some(mut ws) = report.open {
        let _ = ws.close(None).await;
    }
    proxy.close().await;
}

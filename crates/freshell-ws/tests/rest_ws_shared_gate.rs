//! Kata enn3 pin: the WS terminal.create door and the freshagent REST create
//! door share ONE SpawnGate instance — a single global concurrency budget,
//! never two parallel budgets. Real axum server on an ephemeral loopback
//! port serving BOTH routers (the same merge shape as
//! freshell-server/src/main.rs), real WS client, real REST calls, real PTYs.
//!
//! The scenario: saturate the single permit from OUTSIDE both doors, prove
//! BOTH doors starve (REST 503 SPAWN_TIMEOUT, WS PTY_SPAWN_FAILED with the
//! pinned message), release the permit, prove BOTH doors recover. If anyone
//! ever splits the budget into two gate instances, the starved-door
//! assertions fail (each door would succeed on its own budget).
//!
//! RESTORE-ONLY scope on the WS side (user decision, PR #552): only
//! `restore:true` WS creates consult the gate — interactive creates bypass
//! it entirely. The WS creates in this test are therefore `restore:true`;
//! the REST door gates EVERY create (agent/programmatic traffic can burst).

mod common;

use std::sync::Arc;
use std::time::Duration;

use freshell_freshagent::spawn_gate::SpawnGate;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

#[tokio::test(flavor = "multi_thread")]
async fn ws_and_rest_creates_share_one_spawn_budget() {
    // ONE gate, 1 permit, generous queue; short permit-wait timeout so the
    // starved REST door fails fast and deterministically (the WS restore
    // door waits unbounded-cancel-aware since graceful restore/resume S1,
    // so its starvation is proven by a queue-depth probe on the SAME gate
    // instance, not by timeout death).
    let gate = Arc::new(SpawnGate::new(1, 64));

    let cfg = freshell_ws::create_limit::CreateProtectConfig {
        spawn_timeout_ms: 300,
        ..Default::default()
    };
    let (ws_url, base_url, auth_token, registry) =
        spawn_combined_server(cfg, Arc::clone(&gate)).await;

    // 1) Saturate the ONLY permit from OUTSIDE both doors. (The acquire is
    //    cancellable via a watch channel; the sender must stay alive across
    //    the await — a dropped sender reads as Cancelled.)
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let held = gate
        .acquire(Duration::from_secs(1), &mut cancel_rx)
        .await
        .expect("hold the permit");

    // 2) REST door is starved -> 503 SPAWN_TIMEOUT (REST keeps the timed
    //    Interactive acquire).
    let client = reqwest_like_post(&base_url, "/api/tabs", &auth_token).await;
    assert_eq!(client.status, 503, "REST starved: {}", client.body);
    assert_eq!(client.json["code"], serde_json::json!("SPAWN_TIMEOUT"));

    // 3) WS door waits on the SAME budget: with the external permit held,
    //    the restore create parks on the gate queue. `queued_total` is
    //    CUMULATIVE (step 2's starved REST acquire already incremented it),
    //    so snapshot before sending and poll for the +1 delta — same gate
    //    instance, so the WS door demonstrably waits on the SAME budget.
    let queued_before = gate.queued_total();
    let mut starved_ws = ws_connect_and_send_create(&ws_url, &auth_token, "req-starved").await;
    for _ in 0..200 {
        if gate.queued_total() == queued_before + 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        queued_before + 1,
        "the WS restore create must queue on the SAME gate budget"
    );

    // 4) Release the permit: BOTH doors recover through the one budget.
    //    The PARKED WS create consumes the released permit and SPAWNS —
    //    that is the recovery proof (A13-N1).
    drop(held);
    let ws_reply = ws_await_reply(&mut starved_ws, "req-starved").await;
    assert_eq!(
        ws_reply["type"],
        serde_json::json!("terminal.created"),
        "the formerly-starved WS create recovers after release: {ws_reply}"
    );
    // REST recovery: it acquires after the WS create settles and releases.
    let client = reqwest_like_post(&base_url, "/api/tabs", &auth_token).await;
    assert_eq!(client.status, 200, "REST recovered: {}", client.body);
    let ws_reply = ws_create_and_await_reply(&ws_url, &auth_token, "req-recovered").await;
    assert_eq!(
        ws_reply["type"],
        serde_json::json!("terminal.created"),
        "{ws_reply}"
    );

    // Cleanup: kill EVERY spawned terminal (the formerly-starved WS
    // create's PTY included — no stray un-killed PTY).
    assert_eq!(
        registry.kill_all(),
        3,
        "exactly the three recovered creates spawned"
    );
}

/// The combined production shape: `freshell_ws::router` merged with
/// `freshell_freshagent::router` (as `freshell-server/src/main.rs` does),
/// with the SAME `SpawnGate` Arc wired into both doors and the SAME
/// auth token / broadcast bus / terminal registry shared across them.
/// Body modeled on `common::spawn_server_with_create_protect`.
/// Returns `(ws_url, base_url, auth_token, registry)` — the registry is
/// returned so the test can kill the real PTYs it spawns.
async fn spawn_combined_server(
    cfg: freshell_ws::create_limit::CreateProtectConfig,
    gate: Arc<SpawnGate>,
) -> (String, String, String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
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
        registry: registry.clone(),
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
        create_protect: cfg,
        // THE pin under test: the WS door holds the SAME Arc as the REST door.
        spawn_gate: Arc::clone(&gate),
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

    // The REST door: same auth token + broadcast bus + terminal registry as
    // the WS door, and — the pin — the SAME gate instance.
    let fresh_agent_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    )
    .with_terminal_registry(registry.clone());
    fresh_agent_state.set_spawn_gate(
        Arc::clone(&gate),
        Duration::from_millis(cfg.spawn_timeout_ms),
    );

    let app = freshell_ws::router(state).merge(freshell_freshagent::router(fresh_agent_state));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    (
        format!("ws://{addr}/ws"),
        format!("http://{addr}"),
        common::AUTH_TOKEN.to_string(),
        registry,
    )
}

/// A parsed minimal HTTP response.
struct RestResponse {
    status: u16,
    body: String,
    json: serde_json::Value,
}

/// Minimal hand-rolled HTTP/1.1 POST over a raw `TcpStream` (freshell-ws has
/// no HTTP-client dev-dependency, and adding one is out of scope — validated
/// in the plan). `Connection: close` + read-to-EOF keeps the parse trivial;
/// axum's `Json` responses carry `Content-Length`, never chunked encoding.
/// Body is the same shell-create shape the REST gate tests use
/// (`crates/freshell-freshagent/src/terminal_tabs.rs::shell_create_body`).
async fn reqwest_like_post(base_url: &str, path: &str, token: &str) -> RestResponse {
    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let body = serde_json::json!({
        "mode": "shell",
        "cwd": std::env::temp_dir().to_string_lossy(),
    })
    .to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        len = body.len(),
    );

    let mut stream = TcpStream::connect(host).await.expect("connect to server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write HTTP request");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut raw))
        .await
        .expect("HTTP response within deadline")
        .expect("read HTTP response");
    let text = String::from_utf8(raw).expect("utf8 HTTP response");

    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP header/body separator");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code in status line")
        .parse()
        .expect("numeric status code");
    let json = serde_json::from_str(response_body.trim()).unwrap_or(serde_json::Value::Null);
    RestResponse {
        status,
        body: response_body.to_string(),
        json,
    }
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Fresh WS connection: hello (4-frame handshake — `config_fallback` is None
/// in this harness), then ONE shell `terminal.create` sent WITHOUT awaiting
/// its reply — the starved-door probe needs the create parked on the gate
/// while the test inspects `queued_total`. Shape copied from
/// `tests/create_protection.rs::send_create_and_await_reply`.
async fn ws_connect_and_send_create(ws_url: &str, auth_token: &str, request_id: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": auth_token,
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

    // restore:true — the WS path that consults the spawn gate (PR #552
    // restore-only scope; shell-mode restore plain-succeeds when a permit
    // is free, see tests/create_protection.rs).
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
            "restore": true,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    ws
}

/// Await the first `terminal.created`/`error` frame for `request_id`.
async fn ws_await_reply(ws: &mut TestWs, request_id: &str) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let ty = value.get("type").and_then(|v| v.as_str());
                let rid = value.get("requestId").and_then(|v| v.as_str());
                if (ty == Some("terminal.created") || ty == Some("error"))
                    && rid == Some(request_id)
                {
                    return value;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected reply for {request_id}, got {other:?}"),
        }
    }
    panic!("no reply for {request_id}");
}

/// [`ws_connect_and_send_create`] + [`ws_await_reply`] in one shot — the
/// non-parked (recovered) create shape.
async fn ws_create_and_await_reply(
    ws_url: &str,
    auth_token: &str,
    request_id: &str,
) -> serde_json::Value {
    let mut ws = ws_connect_and_send_create(ws_url, auth_token, request_id).await;
    ws_await_reply(&mut ws, request_id).await
}

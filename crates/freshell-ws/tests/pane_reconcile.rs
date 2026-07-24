//! Reconciliation-handshake wire tests (design §9.1) — raw-WS
//! (tokio-tungstenite) integration against an in-process axum server,
//! following the `hello_timeout.rs` / `session_identity_frames.rs` harness
//! convention: ephemeral loopback ports, never a fixed one.
//!
//! Covered here (crate-level, wire):
//! * 9.1.1 negotiation — no capability → no `ready.capabilities`, handshake
//!   shape unchanged; capability → advertised.
//! * 9.1.3 cardinality + opacity over the wire.
//! * 9.1.4 idempotency — (a) same request twice → identical verdicts;
//!   (b) create → disconnect before reading `terminal.created` → reconnect →
//!   re-present without `terminalId` → `attach` (row 1, the Incident-2
//!   regression at protocol level).
//! * 9.1.7 limits — 201 panes → `RECONCILE_TOO_LARGE` carrying the
//!   `reconcileId`.
//! * 9.1.8 trust boundary — contradicting claim → server ref + corrected.
//! * 9.1.10 single-flight create-dedupe — negotiated connection adopts the
//!   existing live terminal for a key; a non-negotiating connection keeps the
//!   legacy spawn path.
//! * inertness — a non-negotiating connection's `pane.reconcile.request` is
//!   accept-and-strip ignored.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

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

struct Server {
    url: String,
    registry: freshell_terminal::TerminalRegistry,
    identity: freshell_ws::identity::TerminalIdentityRegistry,
}

/// Real axum server on an ephemeral loopback port. Returns handles to the
/// SHARED registry + identity registry so tests can seed generations
/// deterministically (the §9.1 headless convention).
async fn spawn_server() -> Server {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();

    let state = WsState {
        identity: identity.clone(),
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

    Server {
        url: format!("ws://{addr}/ws"),
        registry,
        identity,
    }
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello (optionally negotiating `paneReconcileV1`), consuming the
/// 4-frame handshake. Returns the socket and the parsed `ready` frame.
async fn connect(url: &str, pane_reconcile_v1: bool) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let mut hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    if pane_reconcile_v1 {
        hello["capabilities"] = serde_json::json!({ "paneReconcileV1": true });
    }
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");

    let mut ready = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("ready") {
                ready = value;
            }
        }
    }
    assert!(!ready.is_null(), "handshake must contain ready");
    (ws, ready)
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..30u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 30 messages");
}

fn reconcile_request(reconcile_id: &str, panes: serde_json::Value) -> WsMessage {
    WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": reconcile_id,
            "panes": panes,
        })
        .to_string(),
    )
}

fn headless(server: &Server, id: &str, key: Option<&str>, mode: &str, created_at: i64) {
    server
        .registry
        .register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: id.to_string(),
            stream_id: format!("S-{id}"),
            mode: mode.to_string(),
            resume_session_id: None,
            create_request_id: key.map(str::to_string),
            created_at: Some(created_at),
        });
}

// --- 9.1.1 negotiation --------------------------------------------------------

#[tokio::test]
async fn hello_without_capability_gets_unchanged_ready_and_with_it_gets_advertised() {
    let server = spawn_server().await;

    // Frozen-client shape: no capability → `ready` carries NO capabilities
    // key at all (byte-level inertness of the advertisement).
    let (_ws, ready) = connect(&server.url, false).await;
    assert!(
        ready.get("capabilities").is_none(),
        "non-negotiating ready must not carry capabilities: {ready}"
    );

    let (_ws, ready) = connect(&server.url, true).await;
    assert_eq!(
        ready["capabilities"],
        serde_json::json!({ "paneReconcileV1": true })
    );
}

// --- inertness ------------------------------------------------------------------

#[tokio::test]
async fn non_negotiating_connection_gets_no_reconcile_response() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, false).await;

    ws.send(reconcile_request(
        "rec-inert",
        serde_json::json!([{ "paneKey": "p", "kind": "terminal", "createRequestId": "cr-x" }]),
    ))
    .await
    .expect("send request");
    // A ping after the request: if the very next frame is the pong, the
    // request was accept-and-strip ignored (nothing was sent for it).
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");

    let frame = next_frame_of_type(&mut ws, "pong").await;
    assert_eq!(frame["type"], "pong");
}

// --- 9.1.3 cardinality + opacity ------------------------------------------------

#[tokio::test]
async fn reconcile_round_trip_preserves_cardinality_order_and_hostile_pane_keys() {
    let server = spawn_server().await;
    headless(&server, "T-live", Some("cr-live"), "claude", 1_000);
    server
        .identity
        .upsert("T-live", Some("claude"), Some("s-live"), None, 1);

    let (mut ws, _ready) = connect(&server.url, true).await;
    let hostile = "tab\"3:\\pane {}</script> 💥";
    ws.send(reconcile_request(
        "rec-1",
        serde_json::json!([
            { "paneKey": hostile, "kind": "terminal", "mode": "claude", "createRequestId": "cr-live" },
            { "paneKey": "p2", "kind": "terminal", "mode": "shell", "createRequestId": "cr-shell" },
            { "paneKey": "p3" }
        ]),
    ))
    .await
    .expect("send request");

    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert_eq!(result["reconcileId"], "rec-1");
    assert_eq!(result["bootId"], "boot-test");
    assert_eq!(result["serverInstanceId"], "srv-test");
    let verdicts = result["verdicts"].as_array().expect("verdicts array");
    assert_eq!(verdicts.len(), 3, "N panes in → N verdicts out");
    assert_eq!(verdicts[0]["paneKey"], hostile);
    assert_eq!(verdicts[0]["verdict"], "attach");
    assert_eq!(verdicts[0]["terminalId"], "T-live");
    assert_eq!(
        verdicts[0]["sessionRef"],
        serde_json::json!({ "provider": "claude", "sessionId": "s-live" })
    );
    assert_eq!(verdicts[1]["paneKey"], "p2");
    assert_eq!(verdicts[1]["verdict"], "fresh");
    assert_eq!(verdicts[2]["paneKey"], "p3");
    assert_eq!(verdicts[2]["verdict"], "invalid");
}

// --- 9.1.4 idempotency -----------------------------------------------------------

#[tokio::test]
async fn same_request_twice_on_one_socket_returns_identical_verdicts() {
    let server = spawn_server().await;
    headless(&server, "T-i", Some("cr-i"), "claude", 1_000);
    server
        .identity
        .upsert("T-i", Some("claude"), Some("s-i"), None, 1);

    let (mut ws, _ready) = connect(&server.url, true).await;
    let panes = serde_json::json!([
        { "paneKey": "pk", "kind": "terminal", "mode": "claude", "createRequestId": "cr-i" }
    ]);
    ws.send(reconcile_request("rec-a", panes.clone()))
        .await
        .expect("send");
    let first = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    ws.send(reconcile_request("rec-a", panes))
        .await
        .expect("send again");
    let second = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert_eq!(first["verdicts"], second["verdicts"]);
}

/// 9.1.4(b) — the Incident-2 regression at protocol level: respawn verdict →
/// `terminal.create` → disconnect BEFORE reading `terminal.created` →
/// reconnect → re-present the pane WITHOUT a terminalId → row 1 `attach` to
/// the already-spawned terminal (never a second spawn).
#[tokio::test]
async fn interrupted_create_converges_to_attach_on_the_next_reconcile() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true).await;

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "cr-interrupted",
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send create");
    // Disconnect WITHOUT reading terminal.created (the interruption point).
    drop(ws);

    // The spawn is discoverable via the write-ahead key stamp — poll the
    // SHARED registry until the create lands (bounded).
    let mut spawned = None;
    for _ in 0..100u8 {
        if let Some(id) = server
            .registry
            .newest_live_by_create_request_id("cr-interrupted")
        {
            spawned = Some(id);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let spawned = spawned.expect("terminal.create must have spawned a keyed terminal");

    // Reconnect and re-present from persisted state only (no terminalId).
    let (mut ws, _ready) = connect(&server.url, true).await;
    ws.send(reconcile_request(
        "rec-2",
        serde_json::json!([
            { "paneKey": "pk", "kind": "terminal", "mode": "shell", "createRequestId": "cr-interrupted" }
        ]),
    ))
    .await
    .expect("send request");
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert_eq!(result["verdicts"][0]["verdict"], "attach");
    assert_eq!(result["verdicts"][0]["terminalId"], spawned.as_str());

    server.registry.kill(&spawned);
}

// --- 9.1.7 limits ----------------------------------------------------------------

#[tokio::test]
async fn over_cap_request_is_answered_with_reconcile_too_large() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true).await;

    let panes: Vec<serde_json::Value> = (0..201)
        .map(|i| {
            serde_json::json!({
                "paneKey": format!("p{i}"),
                "kind": "terminal",
                "createRequestId": format!("cr-{i}")
            })
        })
        .collect();
    ws.send(reconcile_request("rec-too-big", serde_json::json!(panes)))
        .await
        .expect("send request");

    let error = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(error["code"], "RECONCILE_TOO_LARGE");
    assert_eq!(
        error["requestId"], "rec-too-big",
        "the error must carry the reconcileId for correlation"
    );
}

// --- 9.1.8 trust boundary ---------------------------------------------------------

#[tokio::test]
async fn contradicting_claim_is_answered_with_server_ref_and_corrected() {
    let server = spawn_server().await;
    headless(&server, "T-tb", Some("cr-tb"), "claude", 1_000);
    server
        .identity
        .upsert("T-tb", Some("claude"), Some("s-server"), None, 1);

    let (mut ws, _ready) = connect(&server.url, true).await;
    ws.send(reconcile_request(
        "rec-tb",
        serde_json::json!([{
            "paneKey": "pk",
            "kind": "terminal",
            "mode": "claude",
            "createRequestId": "cr-tb",
            "terminalId": "T-tb",
            "sessionRef": { "provider": "claude", "sessionId": "s-client-guess" }
        }]),
    ))
    .await
    .expect("send request");

    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let verdict = &result["verdicts"][0];
    assert_eq!(verdict["verdict"], "attach");
    assert_eq!(
        verdict["sessionRef"],
        serde_json::json!({ "provider": "claude", "sessionId": "s-server" })
    );
    assert_eq!(verdict["corrected"], true);
}

// --- 9.1.10 single-flight create-dedupe --------------------------------------------

/// Change #1 (the council's two-tab double-respawn blocker): on a
/// `paneReconcileV1` connection, a `terminal.create` for a key that already
/// has a live terminal ADOPTS it — `terminal.created` names the EXISTING
/// terminalId and nothing is spawned. Exactly one live PTY per key.
#[tokio::test]
async fn negotiated_create_for_existing_key_adopts_instead_of_spawning() {
    let server = spawn_server().await;
    let (mut ws1, _ready) = connect(&server.url, true).await;

    ws1.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "cr-adopt",
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send create 1");
    let created1 = next_frame_of_type(&mut ws1, "terminal.created").await;
    let first_id = created1["terminalId"].as_str().expect("id").to_string();

    // Second reconciling connection (the second browser tab) fires the SAME
    // createRequestId — both were told `respawn` for the same key.
    let (mut ws2, _ready) = connect(&server.url, true).await;
    ws2.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": "cr-adopt",
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send create 2");
    let created2 = next_frame_of_type(&mut ws2, "terminal.created").await;
    assert_eq!(
        created2["terminalId"].as_str(),
        Some(first_id.as_str()),
        "the adopt branch must name the EXISTING terminal, not spawn a second"
    );
    assert_eq!(created2["requestId"], "cr-adopt");

    // ≤ 1 live PTY for the key — the data-loss shape stays closed.
    assert_eq!(
        server.registry.newest_live_by_create_request_id("cr-adopt"),
        Some(first_id.clone())
    );
    let inventory = server.registry.inventory();
    let live_for_key = inventory
        .iter()
        .filter(|t| t.terminal_id == first_id)
        .count();
    assert_eq!(live_for_key, 1);
    assert_eq!(
        inventory.len(),
        1,
        "exactly one terminal exists after both creates"
    );

    server.registry.kill(&first_id);
}

/// The other half of change #1's fence: a NON-negotiating (frozen-client)
/// connection keeps the legacy spawn path byte-for-byte — same requestId,
/// second spawn (today's behavior, untouched).
#[tokio::test]
async fn frozen_client_create_path_is_unchanged_no_dedupe() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, false).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "cr-legacy",
        "mode": "shell",
        "shell": "system",
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send create 1");
    let created1 = next_frame_of_type(&mut ws, "terminal.created").await;
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send create 2");
    let created2 = next_frame_of_type(&mut ws, "terminal.created").await;

    let id1 = created1["terminalId"].as_str().expect("id1").to_string();
    let id2 = created2["terminalId"].as_str().expect("id2").to_string();
    assert_ne!(
        id1, id2,
        "the frozen client's blind re-create behavior must be unchanged"
    );

    server.registry.kill(&id1);
    server.registry.kill(&id2);
}

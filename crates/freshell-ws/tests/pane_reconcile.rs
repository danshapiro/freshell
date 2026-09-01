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
//! * gate refusal (reconnect-revive Task 2) — a non-negotiating connection's
//!   `pane.reconcile.request` is answered with an explicit terminal
//!   `error{RECONCILE_NOT_NEGOTIATED}` carrying the `reconcileId`, so the
//!   client's bounded boot-result wait resolves instantly instead of wedging
//!   every pane pending-verdict. Pre-reconcile ("frozen") clients never send
//!   the request, so the code can never reach them (§3 inertness).

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

/// Test probe that answers `exists` from a scripted sequence (pops from the
/// Vec, repeats the last answer forever) — how the deferral tests simulate an
/// index that warms up (or never does) between derivations.
struct FlippingProbe {
    answers: std::sync::Mutex<std::collections::VecDeque<freshell_ws::existence::SessionExistence>>,
    last: std::sync::Mutex<freshell_ws::existence::SessionExistence>,
}

impl FlippingProbe {
    fn new(answers: Vec<freshell_ws::existence::SessionExistence>) -> Self {
        let last = *answers.last().expect("at least one scripted answer");
        Self {
            answers: std::sync::Mutex::new(answers.into_iter().collect()),
            last: std::sync::Mutex::new(last),
        }
    }
}

impl freshell_ws::existence::SessionExistenceProbe for FlippingProbe {
    fn exists(
        &self,
        _provider: &str,
        _session_id: &str,
    ) -> freshell_ws::existence::SessionExistence {
        match self.answers.lock().unwrap().pop_front() {
            Some(answer) => answer,
            None => *self.last.lock().unwrap(),
        }
    }

    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        false
    }
}

/// Real axum server on an ephemeral loopback port. Returns handles to the
/// SHARED registry + identity registry so tests can seed generations
/// deterministically (the §9.1 headless convention).
async fn spawn_server() -> Server {
    spawn_server_with(|_| {}).await
}

/// [`spawn_server`] with a state mutator (e.g. shrink the deferral budget so
/// the warming tests never wait a real 2s).
async fn spawn_server_with(mutate: impl FnOnce(&mut WsState)) -> Server {
    spawn_server_with_probe(
        std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        mutate,
    )
    .await
}

/// [`spawn_server_with`] with an injected existence probe (design §5.1: the
/// disk-truth input is a test fake).
async fn spawn_server_with_probe(
    probe: freshell_ws::existence::SharedExistenceProbe,
    mutate: impl FnOnce(&mut WsState),
) -> Server {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();

    let mut state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: identity.clone(),
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
        registry: registry.clone(),
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
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };
    mutate(&mut state);

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

/// One-pane request whose only recoverable identity is a structured claim —
/// existence-probe-driven rows (5/warming) are reached deterministically.
fn reconcile_request_with_session_ref(provider: &str, session_id: &str) -> WsMessage {
    reconcile_request(
        "rec-warming",
        serde_json::json!([{
            "paneKey": "pk-warm",
            "kind": "terminal",
            "mode": provider,
            "createRequestId": format!("cr-{session_id}"),
            "sessionRef": { "provider": provider, "sessionId": session_id }
        }]),
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

// --- gate refusal (reconnect-revive Task 2) ------------------------------------

#[tokio::test]
async fn non_negotiating_connection_gets_explicit_reconcile_refusal() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, false).await;

    ws.send(reconcile_request(
        "rec-inert",
        serde_json::json!([{ "paneKey": "p", "kind": "terminal", "createRequestId": "cr-x" }]),
    ))
    .await
    .expect("send request");
    // A ping after the request proves the refusal is terminal for the
    // REQUEST, not the connection: the health marker is still answered.
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");

    let refusal = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(refusal["code"], "RECONCILE_NOT_NEGOTIATED");
    assert_eq!(
        refusal["requestId"], "rec-inert",
        "the refusal carries the reconcileId so the client correlates it and falls back instantly"
    );
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

/// Council rule 6 (sessionRef-level single-flight, reconcile side): a live
/// terminal spawned under createRequestId A and identity-stamped with
/// sessionRef {claude, sess-x} answers a reconcile claim from
/// createRequestId B (a different client) with attach{terminalId of A's
/// terminal} — never a second writer for the same session file (D8).
#[tokio::test]
async fn different_create_request_id_same_session_ref_gets_attach_to_winner() {
    let server = spawn_server().await;
    // Seed: headless terminal live in the registry, identity-stamped with
    // sessionRef {claude, sess-x} (the existing seeding pattern).
    headless(&server, "T-winner", Some("cr-WINNER"), "claude", 1_000);
    server
        .identity
        .upsert("T-winner", Some("claude"), Some("sess-x"), None, 1);

    let (mut ws, _ready) = connect(&server.url, true).await;
    ws.send(reconcile_request(
        "rec-xclient",
        serde_json::json!([{
            "paneKey": "pk-x",
            "kind": "terminal",
            "mode": "claude",
            "createRequestId": "cr-OTHER",
            "sessionRef": { "provider": "claude", "sessionId": "sess-x" }
        }]),
    ))
    .await
    .expect("send request");

    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "attach");
    assert_eq!(v["terminalId"], "T-winner");
    assert_eq!(
        v["sessionRef"],
        serde_json::json!({ "provider": "claude", "sessionId": "sess-x" })
    );
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

/// Landing-sync update: change #1's fence originally kept a NON-negotiating
/// (frozen-client) connection's blind same-requestId re-create spawning a
/// SECOND terminal, unchanged by the (capability-gated) paneReconcileV1
/// adopt path. The server-wide `create_dedupe` guard woven in during the
/// rust-tauri-port landing sync is deliberately NOT capability-gated --
/// its own motivating case (module doc, `crate::create_dedupe`) is
/// precisely this frozen client's blind resend-with-same-requestId on
/// reconnect, which previously spawned a duplicate PTY and orphaned the
/// original as a detached background session. So the frozen client's
/// legacy WIRE SHAPE stays byte-for-byte unchanged (no capability
/// negotiated, no `pane.reconcile.*` traffic), but its blind re-create is
/// now answered from the dedupe guard with the EXISTING terminal, same as
/// every other connection kind.
#[tokio::test]
async fn frozen_client_create_path_is_deduped_same_as_negotiating_clients() {
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
    assert_eq!(
        id1, id2,
        "the frozen client's blind re-create is deduped by create_dedupe just like any other connection"
    );
    assert_eq!(
        server.registry.inventory().len(),
        1,
        "exactly one terminal exists after both creates"
    );

    server.registry.kill(&id1);
}

// --- 9.1.6 index warming: error{index_warming} + bounded single deferral ----------

/// warming-never-completes (council red test): a probe pinned to Unknown
/// forever must yield error{index_warming} after ONE bounded deferral —
/// never a hang, never a fake fresh/dead_session.
#[tokio::test]
async fn warming_never_completes_yields_error_index_warming() {
    // Server with deferral budget shrunk for tests (50ms) and the default
    // NoIndexProbe (always Unknown for known providers).
    let server = spawn_server_with(|state| state.reconcile_deferral_budget_ms = 50).await;
    let (mut ws, _ready) = connect(&server.url, true).await;
    let started = std::time::Instant::now();
    ws.send(reconcile_request_with_session_ref("claude", "sess-1"))
        .await
        .expect("send request");
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "bounded, single deferral"
    );
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "error");
    assert_eq!(v["reason"], "index_warming");
    assert!(
        v.get("retryAfterMs").is_none(),
        "retry is deleted from the wire"
    );
}

/// A known provider with no home on this machine is NOT warming — it gets
/// the honest provider_unavailable label, immediately (no 2s deferral).
#[tokio::test]
async fn provider_unavailable_is_immediate_and_honest() {
    // A single scripted answer repeats forever — "always ProviderUnavailable".
    let probe = FlippingProbe::new(vec![
        freshell_ws::existence::SessionExistence::ProviderUnavailable,
    ]);
    // Deliberately LARGE budget: proves no deferral happens for this reason.
    let server = spawn_server_with_probe(std::sync::Arc::new(probe), |state| {
        state.reconcile_deferral_budget_ms = 30_000
    })
    .await;
    let (mut ws, _ready) = connect(&server.url, true).await;
    let started = std::time::Instant::now();
    ws.send(reconcile_request_with_session_ref("codex", "sess-9"))
        .await
        .expect("send request");
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "provider_unavailable must never trigger the warming deferral"
    );
    let v = &result["verdicts"][0];
    assert_eq!(v["verdict"], "error");
    assert_eq!(v["reason"], "provider_unavailable");
}

/// The deferral is real: index warms during the wait -> the SECOND derivation
/// answers with the warm verdict, not error.
#[tokio::test]
async fn warming_resolves_during_deferral_rederives() {
    // Fake probe: first call Unknown, subsequent calls Absent (never observed
    // -> per existing rules the verdict for a never-observed identity is
    // fresh{identity_never_observed}).
    let probe = FlippingProbe::new(vec![
        freshell_ws::existence::SessionExistence::Unknown,
        freshell_ws::existence::SessionExistence::Absent,
    ]);
    let server = spawn_server_with_probe(std::sync::Arc::new(probe), |state| {
        state.reconcile_deferral_budget_ms = 50
    })
    .await;
    let (mut ws, _ready) = connect(&server.url, true).await;
    ws.send(reconcile_request_with_session_ref("claude", "sess-2"))
        .await
        .expect("send request");
    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    assert_ne!(result["verdicts"][0]["verdict"], "error");
}

// --- waveC integration pin: idle-reap (#539) x reconcile verdicts (C2) ---------

/// A detached terminal reaped by the idle sweep (#539 `enforce_idle_kills`,
/// DEV-0009 meaningful-activity clock) while its pane is mid-reconcile must
/// converge to a clean `respawn` verdict on the next reconcile round — never
/// `attach` to the reaped id, never a wedge. Pins the cross-PR seam: the reap
/// marks the terminal not-live, so the verdict scan
/// (`newest_live_by_create_request_id` / `is_live`) falls through to the
/// recovery rows instead of handing the client a dead terminal.
#[tokio::test]
async fn idle_reaped_terminal_mid_reconcile_converges_to_respawn_not_attach() {
    // Disk truth: the session still exists -> the recovery row is respawn.
    let probe = FlippingProbe::new(vec![freshell_ws::existence::SessionExistence::Present]);
    let server = spawn_server_with_probe(std::sync::Arc::new(probe), |_| {}).await;

    // A detached shell terminal whose meaningful-activity clock is 20 minutes
    // stale — eligible for the sweep (registry default autoKillIdleMinutes=15).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    // ITEM-3: agent modes now get a 24 h idle hard cap (not the configured
    // threshold), so the reap side of this seam is driven with a plain
    // shell terminal; the
    // pane still re-presents as claude (verdict logic only consults disk
    // truth + liveness — the reaped row is gone either way).
    headless(
        &server,
        "T-reaped",
        Some("cr-reaped"),
        "shell",
        now_ms - 20 * 60_000,
    );
    assert!(
        server.registry.is_live("T-reaped"),
        "precondition: the terminal is live before the sweep"
    );

    // Client connects negotiated (mid-reconcile state: it still believes in
    // T-reaped), then the sweep fires before its request lands.
    let (mut ws, _ready) = connect(&server.url, true).await;
    let killed = server.registry.enforce_idle_kills();
    assert_eq!(
        killed,
        vec!["T-reaped".to_string()],
        "the idle sweep must actually reap the stale detached terminal"
    );
    assert!(!server.registry.is_live("T-reaped"));

    // The pane re-presents pointing at the reaped terminal.
    ws.send(reconcile_request(
        "rec-reap",
        serde_json::json!([{
            "paneKey": "pk-reap",
            "kind": "terminal",
            "mode": "claude",
            "createRequestId": "cr-reaped",
            "terminalId": "T-reaped",
            "sessionRef": { "provider": "claude", "sessionId": "sess-reaped" }
        }]),
    ))
    .await
    .expect("send request");

    let result = next_frame_of_type(&mut ws, "pane.reconcile.result").await;
    let v = &result["verdicts"][0];
    assert_eq!(
        v["verdict"], "respawn",
        "a reaped-mid-reconcile terminal must yield a clean respawn, got: {v}"
    );
    assert_eq!(v["sessionRef"]["sessionId"], "sess-reaped");
}

/// ITEM-3 regression pin: the idle sweep must NOT reap a detached
/// agent-mode terminal that is stale past the configured threshold but
/// within the 24 h agent hard cap — agent CLIs are legitimately PTY-silent
/// during long LLM calls and long tool runs (`terminal.killed by="idle"`
/// forensics). Past the cap they ARE reaped (ledger A14 backstop).
#[tokio::test]
async fn idle_sweep_spares_detached_agent_terminals() {
    let probe = FlippingProbe::new(vec![freshell_ws::existence::SessionExistence::Present]);
    let server = spawn_server_with_probe(std::sync::Arc::new(probe), |_| {}).await;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    // 20 minutes stale vs the 15-minute default — reap-eligible by clock.
    headless(
        &server,
        "T-amp-busy",
        Some("cr-amp-busy"),
        "amplifier",
        now_ms - 20 * 60_000,
    );

    let killed = server.registry.enforce_idle_kills();

    assert!(
        killed.is_empty(),
        "a running agent-mode terminal must be spared, got {killed:?}"
    );
    assert!(server.registry.is_live("T-amp-busy"));
}

//! Task 13 (AUTO-01 spine): `ui.layout.sync` ingestion.
//!
//! A REAL `/ws` connection (the `session_identity_frames.rs` harness
//! convention) sends the client's layout mirror frame; the socket loop's
//! `ClientMessage::UiLayoutSync` dispatch arm must REPLACE that CONNECTION'S
//! server-side `LayoutStore` snapshot (`update_from_ui`) -- the port of the
//! dedicated `case 'ui.layout.sync'` arm's `this.layoutStore.updateFromUi(m,
//! ws.connectionId || 'unknown')` (`server/ws-handler.ts:2024-2027`).
//! Intentional divergence: the store keeps one snapshot PER connection
//! (Node keeps a single last-writer-wins snapshot), so by-id agent-API
//! operations resolve pane/tab ids from EVERY connected client. A closed
//! connection's snapshot is marked STALE and RETAINED (never primary while a
//! live client exists) — the client's layout mirror is change-gated and never
//! re-syncs on a silent reconnect, so hard eviction would leave that client's
//! ids unresolvable for an unbounded window. A stale entry is dropped only
//! when a live sync covers every one of its pane ids (lossless supersede).
//!
//! No reply frame exists (Node sends none), so a `ping`/`pong` round-trip on
//! the SAME connection is the ordering barrier: the serve loop dispatches
//! inbound frames sequentially, so by the time `pong` arrives the layout
//! frame sent before the `ping` has been fully ingested.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_freshagent::layout_store::LayoutStore;
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

/// Real axum server on an ephemeral loopback port. Returns the ws URL, the
/// http base URL (the fresh-agent REST router is merged in, sharing the SAME
/// layout store — the `freshell-server` wiring), plus the `LayoutStore`
/// handle cloned into `WsState::layout` (the store is `Arc`-backed, so
/// asserting on this handle observes the socket path's ingestion).
async fn spawn_server() -> (String, String, LayoutStore) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let layout = LayoutStore::default();

    // The REST agent surface (`PATCH /api/panes/:id` etc.) sharing the same
    // layout store, exactly like `freshell-server/src/main.rs`'s wiring.
    let rest_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    )
    .with_layout(layout.clone());
    let rest_router = freshell_freshagent::router(rest_state);

    let state = WsState {
        layout: layout.clone(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
        )),
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
    };

    let router = freshell_ws::router(state).merge(rest_router);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (
        format!("ws://{addr}/ws", addr = addr),
        format!("http://{addr}", addr = addr),
        layout,
    )
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the 4-frame handshake (`config_fallback` is None
/// in this harness): ready -> settings.updated -> perf.logging ->
/// terminal.inventory.
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
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
    let inventory = next_frame_of_type(&mut ws, "terminal.inventory").await;
    assert!(
        !inventory.is_null(),
        "handshake must contain terminal.inventory"
    );
    ws
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
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
    panic!("no {wanted} frame within 20 messages");
}

/// **RED for Task 13**: a `ui.layout.sync` client frame must populate the
/// shared server-side `LayoutStore` -- `has_snapshot()` flips true,
/// `list_tabs()` reflects the payload's tab rows + active tab, and the source
/// connection id is stamped. No reply frame is asserted because none exists
/// (the `pong` barrier proves dispatch completed).
#[tokio::test]
async fn ui_layout_sync_frame_populates_the_shared_layout_store() {
    let (url, _http, layout) = spawn_server().await;
    let mut ws = connect_and_hello(&url).await;
    assert!(
        !layout.has_snapshot(),
        "harness sanity: the store starts empty"
    );

    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "ui.layout.sync",
            "tabs": [{"id": "t1", "title": "Work"}],
            "activeTabId": "t1",
            "layouts": {"t1": {"type": "leaf", "id": "p1", "content": {
                "kind": "terminal", "mode": "shell",
                "createRequestId": "r1", "status": "running"
            }}},
            "activePane": {"t1": "p1"},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 123
        })
        .to_string(),
    ))
    .await
    .expect("send ui.layout.sync");

    // Ordering barrier: the serve loop dispatches this connection's frames
    // sequentially, so the pong proves the layout frame was handled.
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");
    next_frame_of_type(&mut ws, "pong").await;

    assert!(
        layout.has_snapshot(),
        "ui.layout.sync must REPLACE the shared layout snapshot"
    );
    let (tabs, active) = layout.list_tabs();
    assert_eq!(tabs.len(), 1, "one tab row: {tabs:?}");
    assert_eq!(tabs[0]["id"], serde_json::json!("t1"));
    assert_eq!(tabs[0]["title"], serde_json::json!("Work"));
    assert_eq!(tabs[0]["activePaneId"], serde_json::json!("p1"));
    assert_eq!(active.as_deref(), Some("t1"));
    assert!(
        layout.source_connection_id().is_some(),
        "ingestion must stamp the source connection id"
    );
}

/// Send one `ui.layout.sync` frame (single tab/pane) on an open connection and
/// barrier on ping/pong so ingestion is proven complete.
async fn sync_single_pane(ws: &mut TestWs, tab_id: &str, pane_id: &str, ts: i64) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "ui.layout.sync",
            "tabs": [{"id": tab_id, "title": format!("Tab {tab_id}")}],
            "activeTabId": tab_id,
            "layouts": {tab_id: {"type": "leaf", "id": pane_id, "content": {
                "kind": "terminal", "mode": "shell",
                "createRequestId": format!("r-{pane_id}"), "status": "running"
            }}},
            "activePane": {tab_id: pane_id},
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": ts
        })
        .to_string(),
    ))
    .await
    .expect("send ui.layout.sync");
    ws.send(WsMessage::Text(
        serde_json::json!({ "type": "ping" }).to_string(),
    ))
    .await
    .expect("send ping");
    next_frame_of_type(ws, "pong").await;
}

/// Multi-client layout store (the cross-client pane-rename fix): two REAL WS
/// connections sync DIFFERENT layouts (pane/tab ids are client-local); the
/// REST agent surface must resolve pane ids from the NON-last-writer
/// connection, and a closed connection's snapshot must be RETAINED as stale
/// (silent-reconnect window) until a live sync covers all of its pane ids.
/// This intentionally diverges from Node's single last-writer-wins snapshot
/// (`server/agent-api/layout-store.ts`).
///
/// The disconnect phase is sequenced around POSITIVE barriers: conn-1 is
/// re-synced LAST so it is primary, and the close is proven processed by the
/// primary flipping to conn-2 (stale-never-primary) plus
/// `stale_entry_count() == 1` — only then is retention asserted. A bare
/// "`p1` still resolvable" check alone would pass vacuously before the server
/// even processed the close.
#[tokio::test]
async fn two_client_syncs_coexist_rest_resolves_non_primary_ids_and_disconnect_retains_stale() {
    let (url, http, layout) = spawn_server().await;

    let mut ws1 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws1, "t1", "p1", 100).await;
    let mut ws2 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws2, "t2", "p2", 200).await; // ws2 = last writer

    // REST rename of ws1's pane (the NON-last-writer) must succeed.
    let client = reqwest::Client::new();
    let resp = client
        .patch(format!("{http}/api/panes/p1"))
        .header("x-auth-token", AUTH_TOKEN)
        .header("content-type", "application/json")
        .body(serde_json::json!({ "name": "Cross Client" }).to_string())
        .send()
        .await
        .expect("PATCH /api/panes/p1");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body")).expect("json body");
    assert_eq!(
        body["data"]["tabId"],
        serde_json::json!("t1"),
        "pane id from the non-last-writer connection must resolve: {body}"
    );
    assert_eq!(body["data"]["paneId"], serde_json::json!("p1"));

    // Primary (default) reads still answer from the last writer.
    let (tabs, active) = layout.list_tabs();
    assert_eq!(tabs.len(), 1, "list_tabs reads the primary snapshot only");
    assert_eq!(tabs[0]["id"], serde_json::json!("t2"));
    assert_eq!(active.as_deref(), Some("t2"));

    // (1) Re-sync conn-1 LAST so it becomes the primary: `list_tabs()`
    // answering t1 is the precondition the disconnect barrier flips.
    sync_single_pane(&mut ws1, "t1", "p1", 300).await;
    let (tabs, _) = layout.list_tabs();
    assert_eq!(
        tabs[0]["id"],
        serde_json::json!("t1"),
        "conn-1's re-sync must make it the primary"
    );

    // (2) Close conn-1 and wait for the POSITIVE disconnect-processed
    // barriers: its entry goes stale, and — stale-never-primary — the primary
    // flips back to conn-2's t2 (poll: disconnect handling is async).
    ws1.close(None).await.expect("close ws1");
    drop(ws1);
    let mut disconnect_processed = false;
    for _ in 0..100u8 {
        let (tabs, _) = layout.list_tabs();
        if layout.stale_entry_count() == 1 && tabs[0]["id"] == serde_json::json!("t2") {
            disconnect_processed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        disconnect_processed,
        "the close must mark conn-1's entry stale and flip the primary to t2"
    );

    // (3) Retention: the disconnected client's ids still resolve (the
    // silent-reconnect window).
    assert!(
        layout.get_pane_snapshot("p1").is_some(),
        "a closed connection's snapshot must be retained as stale"
    );

    // (4) A THIRD connection (the reconnected client) syncs conn-1's EXACT
    // layout — covering all of the stale entry's pane ids — which supersedes
    // it losslessly. (conn-2's sync never contains p1, so under the subset
    // rule it must NOT be the superseder.)
    let mut ws3 = connect_and_hello(&url).await;
    sync_single_pane(&mut ws3, "t1", "p1", 400).await;
    let mut superseded = false;
    for _ in 0..100u8 {
        if layout.stale_entry_count() == 0 {
            superseded = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        superseded,
        "a live sync covering every stale pane id must evict the stale entry"
    );
    assert_eq!(layout.client_entry_count(), 2, "conn-2 + conn-3 remain");

    // Both surviving connections' ids keep resolving; the reconnected client
    // is the last writer, so default reads answer t1.
    assert!(layout.get_pane_snapshot("p1").is_some());
    assert!(layout.get_pane_snapshot("p2").is_some());
    let (tabs, _) = layout.list_tabs();
    assert_eq!(tabs[0]["id"], serde_json::json!("t1"));
}
// -- Ported regression pins from the df1 AUTO-01 work, run against the
// merged (main-side evolved) implementation. Spliced after main-side tests
// by the df1 main-sync merge (PR #638 advance).

mod common;

use common::TestWs as CommonTestWs;
use common::{connect_and_capture_inventory, spawn_server_with_specs_and_state};
use serde_json::json;

fn layout_sync_frame(tabs: serde_json::Value, layouts: serde_json::Value) -> serde_json::Value {
    let active_tab_id = tabs[0]["id"].clone();
    json!({
        "type": "ui.layout.sync",
        "tabs": tabs,
        "activeTabId": active_tab_id,
        "layouts": layouts,
        "activePane": { active_tab_id.as_str().unwrap_or(""): "pane_1" },
        "paneTitles": {},
        "paneTitleSetByUser": {},
        "timestamp": 1_720_000_000_000_i64,
    })
}

async fn send_json(ws: &mut CommonTestWs, frame: serde_json::Value) {
    ws.send(WsMessage::Text(frame.to_string()))
        .await
        .expect("send");
}

#[tokio::test]
async fn ui_layout_sync_updates_the_shared_layout_store() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // Frame from the REAL client middleware shape: nested split with a legacy
    // `agent-chat` leaf that the store must normalize on ingest.
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_r", "title": "Remote" }]),
            json!({
                "tab_r": {
                    "type": "split",
                    "id": "split_1",
                    "direction": "horizontal",
                    "sizes": [60, 40],
                    "children": [
                        {
                            "type": "leaf",
                            "id": "pane_1",
                            "content": {
                                "kind": "agent-chat",
                                "provider": "claude",
                                "createRequestId": "req-1",
                                "status": "idle",
                                "resumeSessionId": "11111111-1111-4111-8111-111111111111",
                            },
                        },
                        {
                            "type": "leaf",
                            "id": "pane_2",
                            "content": { "kind": "terminal", "terminalId": "term_2", "mode": "shell" },
                        },
                    ],
                }
            }),
        ),
    )
    .await;

    // The ingest is synchronous on the read loop; send a ping so its `pong`
    // proves the sync frame was processed before we read the store.
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let _pong = common::next_frame_of_type(&mut ws, "pong").await;

    let store = state.layout.clone();
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["tabs"], json!([{ "id": "tab_r", "title": "Remote" }]));
    assert_eq!(snap["activeTabId"], json!("tab_r"));
    let tree = &snap["layouts"]["tab_r"];
    assert_eq!(tree["type"], json!("split"));
    assert_eq!(tree["sizes"], json!([60, 40]));
    assert!(serde_json::to_string(tree)
        .expect("serialize")
        .contains("\"fresh-agent\""));
    assert!(!serde_json::to_string(tree)
        .expect("serialize")
        .contains("\"agent-chat\""));
    assert_eq!(
        tree["children"][0]["content"]["sessionRef"],
        json!({ "provider": "claude", "sessionId": "11111111-1111-4111-8111-111111111111" })
    );
    // Derived titles seeded on ingest ("Shell" for the modeless terminal).
    assert_eq!(snap["paneTitles"]["tab_r"]["pane_2"], json!("Shell"));
    assert_eq!(snap["timestamp"], json!(1_720_000_000_000_i64));
    assert!(store.source_connection_id().is_some());
}

#[tokio::test]
async fn ui_layout_sync_last_write_wins_across_connections() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws_a, _i1) = connect_and_capture_inventory(&url).await;
    let (mut ws_b, _i2) = connect_and_capture_inventory(&url).await;

    send_json(
        &mut ws_a,
        layout_sync_frame(
            json!([{ "id": "tab_from_a", "title": "A" }]),
            json!({ "tab_from_a": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal" } } }),
        ),
    )
    .await;
    send_json(&mut ws_a, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws_a, "pong").await;
    let store = state.layout.clone();
    assert_eq!(
        store.get_normalized_snapshot(None)["activeTabId"],
        json!("tab_from_a")
    );
    let source_after_a = store.source_connection_id().expect("source recorded");

    send_json(
        &mut ws_b,
        layout_sync_frame(
            json!([{ "id": "tab_from_b", "title": "B" }]),
            json!({ "tab_from_b": { "type": "leaf", "id": "pane_1", "content": { "kind": "browser", "url": "https://docs.example.com/x", "devToolsOpen": false } } }),
        ),
    )
    .await;
    send_json(&mut ws_b, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws_b, "pong").await;

    // Legacy semantics: the second client's mirror REPLACES the whole
    // snapshot; the winning connection is recorded (AUTO-14's substrate).
    let snap = store.get_normalized_snapshot(None);
    assert_eq!(snap["activeTabId"], json!("tab_from_b"));
    assert!(snap["layouts"].get("tab_from_a").is_none());
    assert_eq!(
        snap["paneTitles"]["tab_from_b"]["pane_1"],
        json!("docs.example.com")
    );
    let source_after_b = store.source_connection_id().expect("source recorded");
    assert_ne!(source_after_a, source_after_b);
}

#[tokio::test]
async fn ui_layout_sync_ingest_never_replies() {
    let (url, _registry, _state) = spawn_server_with_specs_and_state(vec![]).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_q", "title": "Q" }]),
            json!({ "tab_q": { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal" } } }),
        ),
    )
    .await;
    // No frame may arrive until we provoke one (ping -> pong): legacy's
    // ui.layout.sync case `return`s without sending anything. The VERY NEXT
    // frame must be the pong — reading raw (not `next_frame_of_type`, which
    // would hide an interleaved ack/error) is what proves silence.
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("next frame within timeout")
        .expect("stream not ended")
        .expect("no ws error");
    let WsMessage::Text(text) = msg else {
        panic!("expected the pong TEXT frame as the very next frame, got {msg:?}")
    };
    let value: serde_json::Value = serde_json::from_str(&text).expect("json frame");
    assert_eq!(
        value["type"],
        json!("pong"),
        "the first post-sync frame must be the pong (any ack/error would arrive first)"
    );
}

#[tokio::test]
async fn ui_layout_sync_is_served_back_through_rest_on_the_same_process() {
    let (url, _registry, state) = spawn_server_with_specs_and_state(vec![]).await;
    // Mount the fresh-agent REST router against a FreshAgentState sharing the
    // SAME layout store the WS dispatch feeds — the exact wiring
    // freshell-server's main.rs production composition has (one store per
    // process, threaded via `.with_layout(...)`). NOTE: `WsState::state()`
    // wires `layout: Default::default()` separately from the fresh-agent
    // state's own store, so mounting `state.fresh_opencode.fresh_agent()`
    // here would read a DIFFERENT store and this endpoint would answer empty.
    let rest_state = freshell_freshagent::FreshAgentState::new(
        state.auth_token.clone(),
        state.broadcast_tx.clone(),
    )
    .with_layout(state.layout.clone());
    let rest_router = freshell_freshagent::router(rest_state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, rest_router).await;
    });

    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        layout_sync_frame(
            json!([{ "id": "tab_ws", "title": "WS-fed tab" }]),
            json!({
                "tab_ws": {
                    "type": "split",
                    "id": "split_ws",
                    "direction": "horizontal",
                    "sizes": [33, 67],
                    "children": [
                        { "type": "leaf", "id": "pane_1", "content": { "kind": "terminal", "terminalId": "term_ws", "mode": "shell" } },
                        { "type": "leaf", "id": "pane_2", "content": { "kind": "editor", "filePath": "/tmp/ws.md" } },
                    ],
                }
            }),
        ),
    )
    .await;
    send_json(&mut ws, json!({ "type": "ping" })).await;
    let _ = common::next_frame_of_type(&mut ws, "pong").await;

    // The authoritative layout is now observable over REST — browser, CLI,
    // and MCP all read THIS (AUTO-01's whole point).
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://{addr}/api/layout/snapshot"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/layout/snapshot");
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    let data = &body["data"];
    assert_eq!(
        data["tabs"],
        json!([{ "id": "tab_ws", "title": "WS-fed tab" }])
    );
    assert_eq!(data["activeTabId"], json!("tab_ws"));
    let tree = &data["layouts"]["tab_ws"];
    assert_eq!(tree["type"], json!("split"));
    assert_eq!(tree["id"], json!("split_ws"));
    assert_eq!(tree["sizes"], json!([33, 67]));
    assert_eq!(data["activePane"]["tab_ws"], json!("pane_1"));
    assert_eq!(data["paneTitles"]["tab_ws"]["pane_1"], json!("Shell"));
    assert_eq!(data["paneTitles"]["tab_ws"]["pane_2"], json!("ws.md"));

    let resp = client
        .get(format!("http://{addr}/api/panes?tabId=tab_ws"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/panes");
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    assert_eq!(
        body["data"]["panes"],
        // Legacy-exact rows: absent fields are OMITTED (never null keys), and
        // the row shape carries NO tabId (`listPanes`, layout-store.ts:341-355).
        json!([
            { "id": "pane_1", "index": 0, "kind": "terminal", "terminalId": "term_ws", "title": "Shell" },
            { "id": "pane_2", "index": 1, "kind": "editor", "title": "ws.md" },
        ])
    );

    let resp = client
        .get(format!("http://{addr}/api/tabs"))
        .header("x-auth-token", common::AUTH_TOKEN)
        .send()
        .await
        .expect("GET /api/tabs");
    let body: serde_json::Value =
        serde_json::from_str(&resp.text().await.expect("body text")).expect("json body");
    assert_eq!(
        body["data"],
        json!({
            "tabs": [{ "id": "tab_ws", "title": "WS-fed tab", "activePaneId": "pane_1" }],
            "activeTabId": "tab_ws",
        })
    );
}

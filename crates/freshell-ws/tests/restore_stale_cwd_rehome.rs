//! kata ywwf: a replayed terminal.create whose persisted cwd was deleted must
//! re-home to the validated default instead of dying in MCP config injection.
//!
//! Pre-fix red: the reply is `error { code: PTY_SPAWN_FAILED, "Cannot
//! inject MCP config for OpenCode: cwd directory does not exist" }`.
//! Post-fix green: `terminal.created`, with `cwd` echoing the validated
//! default dir (NOT the deleted one). Interactive creates keep the deliberate
//! clear-error path (the control test pins that unchanged behavior).
//!
//! Harness: the `resume_validation_gate.rs` convention — REAL axum server +
//! REAL tokio-tungstenite client on an ephemeral loopback port, with
//! `defaultCwd` injected into the boot settings (`common::test_settings_value()`
//! mutated before state construction) so the re-home target is a live temp
//! dir (deterministic; no process-global HOME mutation — `resolve_create_cwd`
//! metadata-checks `default_cwd` already).

mod common;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

/// Real server with a sleeper `opencode` CLI spec and `defaultCwd` pointed at
/// a live temp dir — the validated re-home target the replayed create must
/// fall back to once its persisted cwd is gone.
async fn spawn_server_with_default_cwd(
    default_cwd: &std::path::Path,
) -> (String, freshell_terminal::TerminalRegistry) {
    // F7/V9 choke point: amplifier creates write stub dirs — never the real home.
    let _ = common::isolate_amplifier_home();

    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let mut settings_value = common::test_settings_value();
    settings_value["defaultCwd"] = json!(default_cwd.to_string_lossy());
    let settings =
        Arc::new(serde_json::from_value(settings_value).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        host_stats: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: common::handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({ "freshAgent": { "enabled": false } }),
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![common::sleeper_cli_spec("opencode")]),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        shutdown_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        create_dedupe: Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: Arc::new(freshell_ws::existence::NoIndexProbe::default()),
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

    (format!("ws://{addr}/ws"), registry)
}

/// Create a fresh temp dir that exists RIGHT NOW — the caller deletes it to
/// model the kata's deleted prior-home/initialCwd.
fn live_temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-ywwf-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

async fn send_json(ws: &mut common::TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// Read frames until either a `terminal.created` or an `error` correlated to
/// `request_id` arrives (bounded). Same shape as
/// `resume_validation_gate.rs::next_created_or_error`.
async fn next_created_or_error(ws: &mut common::TestWs, request_id: &str) -> Value {
    for _ in 0..40u8 {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a reply to {request_id}"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: Value = serde_json::from_str(text).expect("json frame");
            let frame_type = value["type"].as_str().unwrap_or("");
            if (frame_type == "terminal.created" || frame_type == "error")
                && value["requestId"] == json!(request_id)
            {
                return value;
            }
        }
    }
    panic!("no terminal.created/error for {request_id} within 40 messages");
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_create_with_deleted_cwd_rehomes_instead_of_failing_spawn() {
    // Fallback target: a validated defaultCwd in a live temp dir.
    let default_dir = live_temp_dir("default");
    let (ws_url, registry) = spawn_server_with_default_cwd(&default_dir).await;

    // The pane's persisted initialCwd: live now (phase 1), deleted before the
    // post-restart replay (phase 2).
    let deleted_dir = live_temp_dir("prior-home");
    let deleted_cwd = deleted_dir.to_string_lossy().to_string();

    // Phase 1: the pre-restart create runs with the (then-live) cwd. With the
    // sleeper CLI this spawn registers no server-known session id, so the
    // phase-2 replay's sessionRef is necessarily test-invented — which also
    // keeps the D7 live-guard from tripping and lets the replay reach MCP
    // injection.
    let (mut ws1, _inventory) = common::connect_and_capture_inventory(&ws_url).await;
    send_json(
        &mut ws1,
        &json!({
            "type": "terminal.create",
            "requestId": "phase-1",
            "mode": "opencode",
            "shell": "system",
            "cwd": deleted_cwd,
        }),
    )
    .await;
    let phase1 = next_created_or_error(&mut ws1, "phase-1").await;
    assert_eq!(
        phase1["type"],
        json!("terminal.created"),
        "phase-1 create with a live cwd must succeed; got {phase1}"
    );
    assert_eq!(phase1["cwd"], json!(deleted_cwd));
    drop(ws1); // the epoch boundary (server restart / connection drop)

    // The TestServer home reset: the persisted cwd is gone by replay time.
    std::fs::remove_dir_all(&deleted_dir).expect("delete the prior home dir");
    assert!(!deleted_dir.exists(), "the replayed cwd must be gone");

    // Phase 2: exactly what a post-restart client replays — restore=true with
    // the persisted sessionRef and the (now stale) initialCwd.
    let (mut ws2, _inventory) = common::connect_and_capture_inventory(&ws_url).await;
    send_json(
        &mut ws2,
        &json!({
            "type": "terminal.create",
            "requestId": "replay-1",
            "mode": "opencode",
            "shell": "system",
            "cwd": deleted_cwd,
            "restore": true,
            "sessionRef": {
                "provider": "opencode",
                "sessionId": "ywwf-test-invented-session",
            },
        }),
    )
    .await;
    let reply = next_created_or_error(&mut ws2, "replay-1").await;

    // Pre-fix red: `error { code: PTY_SPAWN_FAILED, "Cannot inject MCP config
    // for OpenCode: cwd directory does not exist: <deleted>..." }`.
    // Post-fix green: `terminal.created` echoing the validated default dir.
    assert_eq!(
        reply["type"],
        json!("terminal.created"),
        "replayed create must re-home instead of failing the spawn; got {reply}"
    );
    assert_eq!(
        reply["cwd"],
        json!(default_dir.to_string_lossy()),
        "the replayed create must re-home to the validated default dir, not the deleted one"
    );

    assert_eq!(registry.kill_all(), 2, "phase-1 and replayed phase-2 PTYs");
}

#[tokio::test(flavor = "multi_thread")]
async fn interactive_create_with_deleted_cwd_keeps_the_deliberate_error() {
    // Control: without restore/recoveryIntent, the same dead cwd must still
    // produce PTY_SPAWN_FAILED — the "clear errors over fallbacks" behavior
    // for interactive creates is unchanged.
    let default_dir = live_temp_dir("default");
    let (ws_url, registry) = spawn_server_with_default_cwd(&default_dir).await;

    let deleted_dir = live_temp_dir("prior-home");
    let deleted_cwd = deleted_dir.to_string_lossy().to_string();
    std::fs::remove_dir_all(&deleted_dir).expect("delete the prior home dir");

    let (mut ws, _inventory) = common::connect_and_capture_inventory(&ws_url).await;
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "interactive-1",
            "mode": "opencode",
            "shell": "system",
            "cwd": deleted_cwd,
        }),
    )
    .await;
    let reply = next_created_or_error(&mut ws, "interactive-1").await;

    assert_eq!(
        reply["type"],
        json!("error"),
        "interactive create with a dead cwd must keep the clear error; got {reply}"
    );
    assert_eq!(reply["code"], json!("PTY_SPAWN_FAILED"));
    let message = reply["message"].as_str().expect("error carries a message");
    assert!(
        message.contains("cwd directory does not exist"),
        "interactive create must surface the MCP-injection missing-cwd error verbatim; got: {message}"
    );
    assert!(
        message.contains(&deleted_cwd),
        "the error must name the offending cwd; got: {message}"
    );

    assert_eq!(registry.kill_all(), 0, "the rejected create spawns nothing");
}

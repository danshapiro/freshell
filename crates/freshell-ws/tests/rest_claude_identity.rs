#![cfg(unix)]
//! kata hbsa regression suite: REST-created claude panes carry full session
//! identity (Required Outcomes P1/2/4). Isolation rules (AGENTS.md + the
//! live 3002 server): temp-dir signal root via ClaudeSignalWatcher::new,
//! temp-dir lock-free PaneLedger::new, synchronous drains only.

mod common;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

struct Harness {
    base_url: String,   // http://{addr}
    ws: common::TestWs, // connected + hello'd
    registry: freshell_terminal::TerminalRegistry,
    ws_state: WsState,
    ledger: Arc<freshell_ws::pane_ledger::PaneLedger>,
    ledger_dir: std::path::PathBuf,
    signal_root: std::path::PathBuf,
}

/// Unique temp dir (pid + nanos, per pane_ledger_restore.rs:13-24).
fn unique_temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rest-claude-identity-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// The combined production shape (PORT, not new design): the body of
/// `rest_ws_shared_gate.rs`'s `spawn_combined_server` with
/// `common::spawn_server_with_ledger`'s WsState-with-real-ledger
/// construction folded in, returning the extra handles named in `Harness`.
/// ONE `TerminalIdentityRegistry` and ONE `Arc<PaneLedger>` shared by
/// `WsState` and the `LedgerPaneIdentityBinder` handed to `FreshAgentState`
/// — mirroring `freshell-server/src/main.rs`'s wiring.
async fn spawn_merged_server() -> Harness {
    let _ = common::isolate_amplifier_home();
    let ledger_dir = unique_temp_dir("ledger");
    let signal_root = unique_temp_dir("signals");

    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
        ledger_dir.clone(),
    )));
    let cli_commands = Arc::new(vec![common::sleeper_cli_spec("claude")]);

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::clone(&ledger),
        identity: identity.clone(),
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
        cli_commands: Arc::clone(&cli_commands),
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

    // The REST door: same auth token + broadcast bus + terminal registry as
    // the WS door, with the read-side identity lookup AND the write-side
    // pane-identity binder wired over the SAME identity/ledger instances
    // (main.rs:297-310's shape).
    let fresh_agent_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    )
    .with_cli_commands(Arc::clone(&cli_commands))
    .with_terminal_registry(registry.clone())
    .with_session_identity(Arc::new(identity.clone()))
    .with_pane_identity_binder(Arc::new(
        freshell_ws::pane_identity_binder::LedgerPaneIdentityBinder::new(
            identity.clone(),
            Arc::clone(&ledger),
            None,
        ),
    ));

    let app =
        freshell_ws::router(state.clone()).merge(freshell_freshagent::router(fresh_agent_state));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let ws_url = format!("ws://{addr}/ws");
    let (ws, _inventory) = common::connect_and_capture_inventory(&ws_url).await;

    Harness {
        base_url: format!("http://{addr}"),
        ws,
        registry,
        ws_state: state,
        ledger,
        ledger_dir,
        signal_root,
    }
}

/// A parsed minimal HTTP response.
struct RestResponse {
    status: u16,
    body: String,
    json: serde_json::Value,
}

/// Minimal hand-rolled HTTP/1.1 POST over a raw `TcpStream` (ported verbatim
/// from `rest_ws_shared_gate.rs::reqwest_like_post`, body parameterized).
async fn raw_post_tabs(base_url: &str, body_json: &serde_json::Value) -> RestResponse {
    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let body = body_json.to_string();
    let request = format!(
        "POST /api/tabs HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        token = common::AUTH_TOKEN,
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

/// POST /api/tabs with the given body; returns `(terminal_id, session_id)`:
/// terminal_id from the response body's `data.terminalId` (the REST HTTP body
/// carries ONLY {tabId, paneId, terminalId} — paneContent.sessionRef travels
/// on the broadcast ui.command frame, not the body), session_id from the
/// harness's registry row (`identity_probe_rows` -> `resume_session_id`).
/// Panics with the full body / row set on any miss.
async fn rest_create_claude_with_body(h: &Harness, body: serde_json::Value) -> (String, String) {
    let resp = raw_post_tabs(&h.base_url, &body).await;
    assert_eq!(resp.status, 200, "REST create failed: {}", resp.body);
    let tid = resp.json["data"]["terminalId"]
        .as_str()
        .unwrap_or_else(|| panic!("REST body carries data.terminalId: {}", resp.body))
        .to_string();
    let rows = h.registry.identity_probe_rows();
    let sid = rows
        .iter()
        .find(|r| r.terminal_id == tid)
        .unwrap_or_else(|| panic!("registry row for {tid} missing: {rows:?}"))
        .resume_session_id
        .clone()
        .unwrap_or_else(|| panic!("registry row for {tid} has no resume_session_id: {rows:?}"));
    (tid, sid)
}

/// Fresh REST claude create: POST /api/tabs {"mode":"claude","cwd":<temp dir>}.
async fn rest_create_claude(h: &Harness) -> (String, String) {
    rest_create_claude_with_body(
        h,
        json!({
            "mode": "claude",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await
}

/// [`rest_create_claude`] with a `sessionRef` field added to the body — the
/// REST resume direction. Same raw-POST helper, same return shape.
async fn rest_create_claude_with_session_ref(h: &Harness, sid: &str) -> (String, String) {
    rest_create_claude_with_body(
        h,
        json!({
            "mode": "claude",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await
}

/// Read frames until either an `error` or a `terminal.created` correlated to
/// `request_id` arrives. Panics if a `terminal.created` for the request shows
/// up — that IS the duplicate spawn the guard forbids. Ported verbatim from
/// `live_session_ref_guard.rs`.
async fn expect_refusal_for(ws: &mut common::TestWs, request_id: &str) -> serde_json::Value {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            match value["type"].as_str() {
                Some("terminal.created") if value["requestId"] == json!(request_id) => {
                    panic!("duplicate spawn: create must be refused, got {value}");
                }
                Some("error") if value["requestId"] == json!(request_id) => {
                    return value;
                }
                _ => {}
            }
        }
    }
    panic!("no error frame for {request_id} within 20 messages");
}

/// Poll `cond` every 50ms until it holds or `deadline` elapses (panic).
async fn wait_until(deadline: Duration, mut cond: impl FnMut() -> bool, what: &str) {
    let end = tokio::time::Instant::now() + deadline;
    while tokio::time::Instant::now() < end {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

fn cleanup(h: &Harness) {
    std::fs::remove_dir_all(&h.ledger_dir).ok();
    std::fs::remove_dir_all(&h.signal_root).ok();
}

/// 4a — a REST-created claude pane has a USABLE RESUME IDENTITY that does
/// not depend on any signal file existing: preallocated id in the registry
/// row (readable at create time — the rung-0 feed), identity row, and a
/// durable Bound ledger binding — with the signal directory EMPTY throughout.
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_claude_pane_has_durable_resume_identity_without_signals() {
    let h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;
    uuid::Uuid::parse_str(&sid).expect("canonical UUID");

    // "even if every signal file is destroyed by an external actor":
    // there are zero signal files — identity must already be complete.
    assert_eq!(std::fs::read_dir(&h.signal_root).unwrap().count(), 0);

    // identity row (A13 arm 1 + signal-drain prerequisite)
    let row = h
        .ws_state
        .identity
        .get(&tid)
        .expect("identity row exists at create");
    assert_eq!(row.provider.as_deref(), Some("claude"));
    assert_eq!(row.session_id.as_deref(), Some(sid.as_str()));

    // registry row (GET /api/terminals rung 0)
    let reg = h
        .registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == tid)
        .expect("registry row");
    assert_eq!(reg.resume_session_id.as_deref(), Some(sid.as_str()));

    // durable ledger binding, and it survives a "restart" (fresh PaneLedger
    // over the same dir re-reads disk — the pane_ledger_restore.rs idiom).
    let binding = h.ledger.load_binding("claude", &sid).expect("Bound row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid.as_str()));
    let reread = freshell_ws::pane_ledger::PaneLedger::new(Some(h.ledger_dir.clone()));
    assert!(
        reread.load_binding("claude", &sid).is_some(),
        "binding durable across restart"
    );

    h.registry.kill(&tid);
    cleanup(&h);
}

/// 4b — A13: a WS resume (terminal.create restore:true + wire sessionRef)
/// of a session that is LIVE inside a REST-created pane is REFUSED loudly.
/// This is the exact drill violation: two live claude CLIs on one session id.
#[tokio::test(flavor = "multi_thread")]
async fn ws_resume_of_session_live_in_rest_pane_is_refused_a13() {
    let mut h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;

    h.ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": "req-a13-rest-live-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": sid },
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let err = expect_refusal_for(&mut h.ws, "req-a13-rest-live-1").await;
    assert_eq!(
        err["code"],
        json!("RESTORE_UNAVAILABLE"),
        "exact wire code: {err}"
    );
    assert!(
        err["message"].as_str().unwrap().contains(&sid),
        "message names the live session: {err}"
    );

    // no duplicate spawn: the REST pane is still the only claude terminal
    let rows = h.registry.identity_probe_rows();
    assert_eq!(
        rows.len(),
        1,
        "no second claude CLI on session {sid}: {rows:?}"
    );
    assert_eq!(rows[0].terminal_id, tid);

    h.registry.kill(&tid);
    cleanup(&h);
}

/// 4c — the SessionStart signal for a REST pane is CONSUMED (Acted), not
/// retained forever: the confirmation no-op arm requires the identity row
/// that REST creates now write.
#[tokio::test(flavor = "multi_thread")]
async fn rest_pane_session_start_signal_is_consumed_not_retained() {
    let h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;

    let watcher = freshell_ws::claude_signal::ClaudeSignalWatcher::new(h.signal_root.clone());
    std::fs::write(
        h.signal_root.join(format!("{tid}__1.json")),
        format!(r#"{{"session_id":"{sid}","source":"startup","hook_event_name":"SessionStart"}}"#),
    )
    .expect("write signal file");

    freshell_ws::claude_signal::drain_and_rebind_claude(&h.ws_state, &watcher).await;
    tokio::task::yield_now().await;

    // Acted (same-id confirmation no-op) => file deleted. Before this fix
    // the pane had no identity row => Retain forever (the drill's retained
    // signal in ~/.freshell/session-signals/claude/).
    assert_eq!(
        std::fs::read_dir(&h.signal_root).unwrap().count(),
        0,
        "signal consumed, not retained"
    );
    // identity unchanged by the confirmation
    assert_eq!(
        h.ws_state.identity.get(&tid).unwrap().session_id.as_deref(),
        Some(sid.as_str())
    );

    h.registry.kill(&tid);
    cleanup(&h);
}

/// Ledger A2 regression: REST pane EXIT retires identity. Without retire, a
/// dead REST pane stays live-looking (session directory `is_running: true`,
/// session_directory.rs:716-766) and a late SessionStart with a NEW id skips
/// the `current.retired -> Acted` arm and durably rebinds the dead pane
/// (claude_signal.rs:253-342).
#[tokio::test(flavor = "multi_thread")]
async fn dead_rest_pane_is_retired_and_late_signal_does_not_rebind_it() {
    let h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;

    h.registry.kill(&tid);
    // The exit hook drives binder.retire_pane_identity asynchronously: poll
    // (bounded, <=5s) until the identity row for `tid` reports retired (the
    // same retired-row probe the WS kill-path tests use).
    wait_until(
        Duration::from_secs(5),
        || h.ws_state.identity.get(&tid).is_some_and(|row| row.retired),
        "identity row retired after REST pane exit",
    )
    .await;

    // Late signal carrying a NEW session id for the dead pane:
    let watcher = freshell_ws::claude_signal::ClaudeSignalWatcher::new(h.signal_root.clone());
    const NEW_SID: &str = "29a53649-9999-4888-8777-666655554444";
    std::fs::write(
        h.signal_root.join(format!("{tid}__2.json")),
        format!(
            r#"{{"session_id":"{NEW_SID}","source":"startup","hook_event_name":"SessionStart"}}"#
        ),
    )
    .expect("write signal file");
    freshell_ws::claude_signal::drain_and_rebind_claude(&h.ws_state, &watcher).await;

    // Retired no-op arm: signal consumed; NO rebind of the dead pane, NO
    // durable ledger row naming the dead terminal.
    assert_eq!(
        std::fs::read_dir(&h.signal_root).unwrap().count(),
        0,
        "signal consumed via the retired arm, not retained"
    );
    assert!(
        h.ledger.load_binding("claude", NEW_SID).is_none(),
        "no durable binding to a dead terminal id"
    );
    // the dead pane's identity keeps its ORIGINAL session id (no rebind)
    assert_eq!(
        h.ws_state.identity.get(&tid).unwrap().session_id.as_deref(),
        Some(sid.as_str()),
        "retired pane identity untouched by the late signal"
    );
    cleanup(&h);
}

/// Resume direction (Required Outcome 2): a REST claude create WITH a
/// sessionRef now writes the identity row and a durable ledger binding
/// (previously: live registry row only — died at restart).
#[tokio::test(flavor = "multi_thread")]
async fn rest_claude_resume_create_writes_identity_row_and_ledger_binding() {
    let h = spawn_merged_server().await;
    // Fresh REST pane mints S, then kill it so S is no longer live-owned.
    let (tid1, sid) = rest_create_claude(&h).await;
    h.registry.kill(&tid1);
    // wait until the row leaves Running AND the identity row is retired so
    // the D7 guard's two arms both admit the resume (bounded deadline).
    wait_until(
        Duration::from_secs(5),
        || {
            let row_gone_or_exited = h.registry.identity_probe_rows().iter().all(|r| {
                r.terminal_id != tid1 || r.status != freshell_protocol::TerminalRunStatus::Running
            });
            let identity_retired = h
                .ws_state
                .identity
                .get(&tid1)
                .is_some_and(|row| row.retired);
            row_gone_or_exited && identity_retired
        },
        "REST pane fully dead (registry row not Running, identity retired)",
    )
    .await;

    // REST resume of S: POST /api/tabs {"mode":"claude","sessionRef":{...}}.
    let (tid2, sid2) = rest_create_claude_with_session_ref(&h, &sid).await;
    assert_eq!(sid2, sid);
    let row = h
        .ws_state
        .identity
        .get(&tid2)
        .expect("resume writes the identity row");
    assert_eq!(row.session_id.as_deref(), Some(sid.as_str()));
    let binding = h
        .ledger
        .load_binding("claude", &sid)
        .expect("resume writes the binding row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid2.as_str()));

    h.registry.kill(&tid2);
    cleanup(&h);
}

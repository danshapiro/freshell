#![cfg(unix)]
//! kata hbsa Required Outcome 3 pins: a REST-created codex/opencode pane
//! ends with BOTH the identity row and a durable Bound ledger row, end to
//! end across the freshagent/ws crate boundary. (The exploration found the
//! drain arms and the sweep pinned separately on opposite sides of that
//! boundary, but no end-to-end pin — the exact blind spot the claude gap
//! survived in.)
//!
//! Harness copied from `rest_claude_identity.rs`'s merged REST+WS server
//! (tests/ files don't share code except `common`; the codex-locator wiring
//! makes this copy non-identical, so it stays local per the extraction
//! rule), extended with the codex locator shared into BOTH `WsState` and
//! `FreshAgentState` plus the 150 ms locator sweep — mirroring
//! `freshell-server/src/main.rs`'s production wiring and
//! `common::spawn_server_with_specs_activity_and_codex_locator`.
//!
//! Isolation rules (AGENTS.md + the live 3002 server): temp-dir ledger via
//! `PaneLedger::new(Some(..))` (never `new_locked`), temp-dir signal and
//! sessions roots, `common::isolate_amplifier_home()`, no `HOME` mutation.

mod common;

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use freshell_ws::pane_ledger::RowState;
use freshell_ws::WsState;

struct Harness {
    base_url: String, // http://{addr}
    /// Held open so the server keeps at least one WS peer alive for the
    /// duration (parity with the production shape); the pins themselves
    /// assert on state handles, not wire frames.
    _ws: common::TestWs,
    registry: freshell_terminal::TerminalRegistry,
    ws_state: WsState,
    ledger: Arc<freshell_ws::pane_ledger::PaneLedger>,
    ledger_dir: std::path::PathBuf,
    signal_root: std::path::PathBuf,
}

/// Unique temp dir (pid + nanos, per pane_ledger_restore.rs:13-24).
fn unique_temp_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rest-locator-identity-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// The `rest_claude_identity.rs::spawn_merged_server` shape: ONE
/// `TerminalIdentityRegistry` and ONE `Arc<PaneLedger>` shared by `WsState`
/// and the `LedgerPaneIdentityBinder` handed to `FreshAgentState`
/// (main.rs's wiring), parameterized with the CLI specs this file needs and
/// an OPTIONAL codex locator root. When `codex_sessions_root` is `Some`, the
/// SAME `Arc<CodexLocator>` is wired into `WsState.codex_locator` AND
/// `FreshAgentState::with_codex_locator` (main.rs:390-411's production
/// shape: REST creates arm it, the WS-side sweep drains it), and the 150 ms
/// locator sweep is spawned exactly as
/// `common::spawn_server_with_specs_activity_and_codex_locator` does.
async fn spawn_merged_server(
    cli_specs: Vec<freshell_platform::CliCommandSpec>,
    codex_sessions_root: Option<std::path::PathBuf>,
) -> Harness {
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
    let cli_commands = Arc::new(cli_specs);
    let codex_locator = codex_sessions_root
        .map(|root| Arc::new(freshell_sessions::codex_locator::CodexLocator::new(root)));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::clone(&ledger),
        identity: identity.clone(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_cancels: Default::default(),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
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
        codex_locator: codex_locator.clone(),
        // The identity/ledger lane under test never touches the activity
        // hub (apply_codex_identity's hub block is `if let Some`); None
        // keeps the harness minimal, same as rest_claude_identity.rs.
        activity: None,
        session_existence: Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    // The REST door: same auth token + broadcast bus + terminal registry as
    // the WS door, with the read-side identity lookup AND the write-side
    // pane-identity binder wired over the SAME identity/ledger instances,
    // plus the SAME codex locator Arc (main.rs:297-310 + 390-411's shape).
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
    ))
    .with_codex_locator(codex_locator.clone());

    if codex_locator.is_some() {
        // Mirrors main.rs's sweep wiring; 150 ms re-declared because
        // main.rs's LOCATOR_SWEEP_INTERVAL is private to the server binary
        // (the common::spawn_server_with_specs_activity_and_codex_locator
        // precedent).
        freshell_ws::codex_association::spawn_codex_locator_sweep(
            state.clone(),
            Duration::from_millis(150),
        );
    }

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
        _ws: ws,
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

/// Minimal hand-rolled HTTP/1.1 POST over a raw `TcpStream` (ported from
/// `rest_claude_identity.rs::raw_post_tabs`, path parameterized).
async fn raw_post(base_url: &str, path: &str, body_json: &serde_json::Value) -> RestResponse {
    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let body = body_json.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\n\
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

/// Fresh REST create: POST /api/tabs {"mode":<mode>,"cwd":<temp dir>} (no
/// sessionRef — identity is in flight). Returns `(terminal_id, pane_id)`
/// from the response body's `data` (the REST HTTP body carries
/// {tabId, paneId, terminalId}).
async fn rest_create(h: &Harness, mode: &str) -> (String, String) {
    let resp = raw_post(
        &h.base_url,
        "/api/tabs",
        &json!({ "mode": mode, "cwd": std::env::temp_dir().to_string_lossy() }),
    )
    .await;
    assert_eq!(resp.status, 200, "REST create failed: {}", resp.body);
    let tid = resp.json["data"]["terminalId"]
        .as_str()
        .unwrap_or_else(|| panic!("REST body carries data.terminalId: {}", resp.body))
        .to_string();
    let pane_id = resp.json["data"]["paneId"]
        .as_str()
        .unwrap_or_else(|| panic!("REST body carries data.paneId: {}", resp.body))
        .to_string();
    (tid, pane_id)
}

/// POST /api/panes/{pane_id}/send-keys {"data":<data>} — the REST input
/// surface whose Enter feeds the codex locator's `note_submit`
/// (terminal_tabs.rs's send_keys route; ordering pinned in-crate by
/// `send_keys_enter_feeds_codex_locator`).
async fn send_keys(h: &Harness, pane_id: &str, data: &str) {
    let resp = raw_post(
        &h.base_url,
        &format!("/api/panes/{pane_id}/send-keys"),
        &json!({ "data": data }),
    )
    .await;
    assert_eq!(resp.status, 200, "REST send-keys failed: {}", resp.body);
}

/// One plugin-shaped opencode signal file (`<terminal_id>__<nonce>.json`
/// with a timestamp-first nonce — copied from `opencode_switch_rebind.rs`).
fn write_opencode_signal(root: &std::path::Path, terminal_id: &str, seq: u64, session_id: &str) {
    std::fs::create_dir_all(root).unwrap();
    let name = format!("{terminal_id}__{seq:014}-000001-1.json");
    std::fs::write(
        root.join(name),
        format!(r#"{{"session_id":"{session_id}","source":"opencode-tui-plugin"}}"#),
    )
    .unwrap();
}

/// The codex rollout session_meta first line (non-fork shape), exactly what
/// the real codex CLI writes — copied from `codex_fork_rebind.rs`'s
/// `session_meta_line` fixture with `forked_from: None`.
fn session_meta_line(thread_id: &str, cwd: &str) -> String {
    json!({
        "timestamp": "2026-07-27T12:00:00.000Z",
        "type": "session_meta",
        "payload": { "id": thread_id, "session_id": thread_id, "cwd": cwd },
    })
    .to_string()
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

/// REQ 3 pin (signal lane): a fresh REST opencode pane, first-bound by its
/// TUI-plugin signal, ends with the identity row + a durable Bound ledger
/// binding — and the Task 5 binder's create-time pending marker is consumed
/// by the resolution (`resolve_pending`'s binding-first order). Drives
/// opencode's first-bind arbitration arm (opencode_signal.rs D1.2 arm (0a))
/// exactly as the plugin would, via the pub drain (no sweep-timer race).
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_opencode_pane_binds_identity_row_and_ledger() {
    let h = spawn_merged_server(vec![common::sleeper_cli_spec("opencode")], None).await;
    let (tid, _pane_id) = rest_create(&h, "opencode").await;

    // The Task 5 binder wrote the pending marker at create (the
    // MARKER_MODES arm of register_create_identity): identity is still in
    // flight, so there is a durable marker and NO premature identity row.
    let marker = h
        .ledger
        .pending_for_terminal(&tid)
        .expect("pending marker for locator-resolved provider at create");
    assert_eq!(marker.mode, "opencode");
    assert!(
        h.ws_state.identity.get(&tid).is_none(),
        "no premature identity row before the signal resolves"
    );

    // Forge the plugin signal and drive the opencode drain synchronously.
    // VALID `ses_` + alphanumeric shape (is_valid_opencode_session_id
    // rejects underscores/hyphens; opencode_switch_rebind.rs uses
    // `ses_` + 26 alphanumerics).
    const S: &str = "ses_restopencodepin00000000001";
    let watcher = freshell_ws::opencode_signal::OpencodeSignalWatcher::new(h.signal_root.clone());
    write_opencode_signal(&h.signal_root, &tid, 1, S);
    freshell_ws::opencode_signal::drain_and_rebind_opencode(&h.ws_state, &watcher).await;
    tokio::task::yield_now().await;

    // Identity row (the A13/signal-drain home).
    let row = h.ws_state.identity.get(&tid).expect("identity row");
    assert_eq!(row.provider.as_deref(), Some("opencode"));
    assert_eq!(row.session_id.as_deref(), Some(S));
    // Durable Bound ledger row naming this terminal.
    let binding = h
        .ledger
        .load_binding("opencode", S)
        .expect("Bound ledger row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid.as_str()));
    assert_eq!(binding.state, RowState::Bound);
    // resolve_pending consumed the create-time marker (binding-first order).
    assert!(
        h.ledger.pending_for_terminal(&tid).is_none(),
        "resolve_pending consumed the pending marker"
    );
    // Acted signal is deleted (act-then-delete, D1.1 — drain disposition
    // unchanged, per the #578/#579 pins).
    assert_eq!(
        std::fs::read_dir(&h.signal_root).unwrap().count(),
        0,
        "acted-on signal file consumed"
    );

    h.registry.kill(&tid);
    cleanup(&h);
}

/// REQ 3 pin (locator lane): a fresh REST codex pane resolved by the codex
/// locator sweep ends with the identity row + a durable Bound ledger
/// binding, with the Task 5 pending marker consumed.
///
/// FULL-LOCATOR version (the brief's decision rule): `codex_fork_rebind.rs`
/// shows the locator-specific harness is well under 100 lines (fake-codex
/// spec + session_meta fixture + the Enter/rollout dance ≈ 60 lines beyond
/// the merged harness this file already carries) — AND the sketched
/// fallback is not implementable without production changes anyway: every
/// resolution-tail entry point is crate-private (`ledger_resolve_identity`
/// pane_ledger.rs:878, `drain_and_associate` codex_association.rs:93,
/// `adopt_codex_identity` codex_identity.rs:60); the only public codex
/// drain IS the locator sweep (`spawn_codex_locator_sweep`).
///
/// Codex identity is Enter-anchored (codex_association.rs): the submit is
/// fed through the REST send-keys surface (`note_submit`, pinned in-crate
/// by terminal_tabs.rs's `send_keys_enter_feeds_codex_locator`), then the
/// forged rollout is correlated by the 150 ms sweep — the two-Enter
/// determinism dance copied from `codex_fork_rebind.rs` steps 2a-2e.
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_codex_pane_binds_identity_row_and_ledger() {
    const T: &str = "019fa7aa-1111-4222-8333-000000000073";

    let sessions_root = unique_temp_dir("codex-sessions");
    let sessions_day = sessions_root.join("2026").join("07").join("27");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sleeper fake codex, no app-server), so pin OFF.
    // (Added at the 2026-07-30 merge of origin/main: this test predates the flip.)
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");

    let h = spawn_merged_server(
        vec![common::sleeper_cli_spec("codex")],
        Some(sessions_root.clone()),
    )
    .await;

    // 1. REST create {mode:"codex"} — arms the shared locator (in-crate pin:
    //    REST codex create must arm) and writes the pending marker.
    let (tid, pane_id) = rest_create(&h, "codex").await;
    let marker = h
        .ledger
        .pending_for_terminal(&tid)
        .expect("pending marker for locator-resolved provider at create");
    assert_eq!(marker.mode, "codex");
    assert!(
        h.ws_state.identity.get(&tid).is_none(),
        "no premature identity row before the sweep resolves"
    );

    // 2. First REST Enter: takes the FIRST-submit re-snapshot and opens the
    //    2 s adoption window — the rollout must NOT exist yet.
    send_keys(&h, &pane_id, "\r").await;
    // 2b. Let that first window resolve with zero candidates (2 s deadline +
    //     150 ms sweep, with margin) — codex_fork_rebind.rs's determinism
    //     dance.
    tokio::time::sleep(Duration::from_secs(3)).await;

    // 3. NOW forge the rollout the sweep correlates (payload.cwd matches the
    //    pane's cwd — the same temp_dir the create carried).
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout = sessions_day.join(format!("rollout-2026-07-27T12-00-00-{T}.jsonl"));
    std::fs::write(&rollout, format!("{}\n", session_meta_line(T, &cwd)))
        .expect("write rollout fixture");

    // 4. Second Enter re-opens the window WITHOUT re-snapshotting; the
    //    rollout is deterministically the sole new candidate.
    send_keys(&h, &pane_id, "\r").await;

    // 5. Await the sweep (bounded poll, <=5s) until the identity row lands.
    wait_until(
        Duration::from_secs(5),
        || h.ws_state.identity.get(&tid).is_some(),
        "codex locator adoption of the REST pane",
    )
    .await;

    let row = h.ws_state.identity.get(&tid).expect("identity row");
    assert_eq!(row.provider.as_deref(), Some("codex"));
    assert_eq!(row.session_id.as_deref(), Some(T));
    let binding = h.ledger.load_binding("codex", T).expect("Bound ledger row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid.as_str()));
    assert_eq!(binding.state, RowState::Bound);
    assert!(
        h.ledger.pending_for_terminal(&tid).is_none(),
        "resolve_pending consumed the pending marker"
    );

    h.registry.kill(&tid);
    std::fs::remove_dir_all(&sessions_root).ok();
    cleanup(&h);
}

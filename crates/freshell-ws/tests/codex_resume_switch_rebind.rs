//! Task 2 integration — codex in-TUI thread/resume rebind + restart coverage.
//!
//! Two scenarios over the REAL Rust WS server (real `PaneLedger`,
//! `codex_locator: None` — the kata's expired-window state), each driving the
//! TUI against the pane's `--remote` proxy URL:
//!
//! 1. **resume_switch_after_window_expiry_adopts_and_converges_everywhere**:
//!    a pane UNBOUND at resume time (no locator wired ⇒ startup window
//!    expired without a bind) adopts the resumed durable thread as its FIRST
//!    identity through the D-RESUME arm — `terminal.session.associated` with
//!    NO `previousSessionId`, then `terminal.meta.updated`; the pane ledger
//!    binds, registry meta follows, the sidecar record carries the new id,
//!    and a RESTORE create spawns `codex resume <id>`.
//! 2. **repeat_resume_switches_supersede_and_restart_resumes_the_latest**:
//!    bind A via `thread/start`, then `thread/resume` → B (supersede A), → C
//!    (supede B); a server restart against the SAME ledger dir resumes the
//!    chain terminus C (never A); a dead-id restore (rollout deleted, probe
//!    Absent) demotes to a fresh spawn — no `resume` argv at all.
//!
//! This binary OWNS process env (`CODEX_CMD`, `CODEX_HOME`,
//! `FAKE_CODEX_APP_SERVER_BEHAVIOR`, `CODEX_ARGV_CAPTURE_PATH`,
//! `FRESHELL_CODEX_MANAGED_LAUNCH`) — the `resume_validation_gate.rs` /
//! `codex_sidecar_reattach_e2e.rs` convention: env mutation is
//! process-global, and nothing else in this binary reads these vars. The
//! codex launch manager global is SET-ONCE per process, so the scenarios
//! are serialized on ONE never-dropped runtime (the `restore_storm.rs`
//! ground rule) and swap the test-owned reconciler/store through statics
//! the one installed factory closes over.
//!
//! PROCESS SAFETY: kills ONLY pids this test spawned — panes via
//! `registry.kill`. Loopback ephemeral ports only — never 3001/3002. Temp
//! stores only — the machine's live sidecars stay structurally unreachable.
//!
//! Linux-only: the managed-launch sidecar identity evidence is
//! `/proc`-based (`verify_sidecar_identity` is Unverifiable elsewhere).
#![cfg(target_os = "linux")]

mod common;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_codex::launch_lifecycle::{
    set_codex_proxy_event_sink, set_global_codex_launch_manager_for_tests,
    CodexTerminalLaunchManager,
};
use freshell_codex::{
    select_codex_runtime, set_codex_sidecar_store, CodexSidecarStore, SidecarReconciler,
};

use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};
use freshell_ws::pane_ledger::{PaneLedger, RetiredReason, RowState};
use freshell_ws::WsState;

const RECV_TIMEOUT: Duration = Duration::from_secs(20);

// ─── ledger supersession assertion (F5) ─────────────────────────────────────

/// Assert the ledger's supersession chain: the old session's row is
/// `Retired` with `retired_reason == Superseded` and `superseded_by` pointing
/// to the new session; the new session's row is `Bound`. Mirrors
/// `opencode_switch_rebind.rs::assert_ledger_superseded` (the codex
/// provider variant).
fn assert_codex_ledger_superseded(
    ledger: &PaneLedger,
    old_session_id: &str,
    new_session_id: &str,
    label: &str,
) {
    let old = ledger
        .load_binding("codex", old_session_id)
        .unwrap_or_else(|| panic!("[{label}] ledger must hold a row for {old_session_id}"));
    assert_eq!(
        old.state,
        RowState::Retired,
        "[{label}] the superseded session's row must be Retired"
    );
    assert_eq!(
        old.retired_reason,
        Some(RetiredReason::Superseded),
        "[{label}] the superseded session's row must be retired as Superseded"
    );
    assert_eq!(
        old.superseded_by,
        Some(freshell_protocol::SessionLocator {
            provider: "codex".to_string(),
            session_id: new_session_id.to_string(),
        }),
        "[{label}] the superseded row must link to the new session"
    );
    let new = ledger
        .load_binding("codex", new_session_id)
        .unwrap_or_else(|| panic!("[{label}] ledger must hold a row for {new_session_id}"));
    assert_eq!(
        new.state,
        RowState::Bound,
        "[{label}] the new session's row must be Bound"
    );
}

// ─── the set-once global manager over a swappable test reconciler/store ──────

static TEST_RECONCILER: Mutex<Option<Arc<SidecarReconciler>>> = Mutex::new(None);
static TEST_STORE: Mutex<Option<Arc<CodexSidecarStore>>> = Mutex::new(None);

fn install_global_manager() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let manager = CodexTerminalLaunchManager::new(Box::new(|plan| {
            let reconciler = TEST_RECONCILER.lock().unwrap().clone();
            let store = TEST_STORE.lock().unwrap().clone();
            Box::pin(async move {
                select_codex_runtime(reconciler.as_ref(), store.as_ref(), plan).await
            })
        }));
        assert!(
            set_global_codex_launch_manager_for_tests(manager),
            "this binary must be the first global() toucher in its process"
        );
    });
}

fn swap_test_reconciler(
    reconciler: Option<Arc<SidecarReconciler>>,
    store: Option<Arc<CodexSidecarStore>>,
) {
    *TEST_RECONCILER.lock().unwrap() = reconciler;
    *TEST_STORE.lock().unwrap() = store;
}

fn reattach_rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("resume-switch runtime")
    })
}

fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn ensure_mcp_deps_resolvable() {
    static DONE: OnceLock<()> = OnceLock::new();
    DONE.get_or_init(|| {
        let has_tsx =
            |root: &std::path::Path| root.join("node_modules/tsx/dist/loader.mjs").is_file();
        let is_freshell_root = |dir: &std::path::Path| {
            std::fs::read_to_string(dir.join("package.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .is_some_and(|pkg| pkg.get("name").and_then(|n| n.as_str()) == Some("freshell"))
        };
        let cwd = std::env::current_dir().expect("cwd");
        let mut nearest = cwd.clone();
        let mut dir = cwd.as_path();
        for _ in 0..5 {
            if is_freshell_root(dir) {
                nearest = dir.to_path_buf();
                break;
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
        if has_tsx(&nearest) {
            return;
        }
        let mut dir = nearest.as_path();
        while let Some(parent) = dir.parent() {
            if is_freshell_root(parent) && has_tsx(parent) {
                std::env::set_current_dir(parent)
                    .expect("chdir to the dependency-bearing parent checkout");
                return;
            }
            dir = parent;
        }
        panic!(
            "no freshell checkout with node_modules/tsx found at or above {} — \
             the codex create door cannot resolve its MCP injection here",
            nearest.display()
        );
    });
}

// ─── codex CLI spec + fixture dispatcher (copied from codex_sidecar_reattach_e2e.rs) ──

fn codex_cli_spec() -> freshell_platform::CliCommandSpec {
    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }
    freshell_platform::CliCommandSpec {
        name: "codex".into(),
        label: "Codex CLI".into(),
        env_var: Some("CODEX_CMD".into()),
        default_cmd: "codex".into(),
        resume_args: Some(s(&["resume", "{{sessionId}}"])),
        model_args: Some(s(&["--model", "{{model}}"])),
        sandbox_args: Some(s(&["--sandbox", "{{sandbox}}"])),
        ..Default::default()
    }
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .expect("fake-app-server fixture exists")
}

fn codex_dispatcher() -> &'static std::path::PathBuf {
    static DISPATCHER: OnceLock<std::path::PathBuf> = OnceLock::new();
    DISPATCHER.get_or_init(|| {
        let fixture = fixture_path();
        let dispatcher = std::env::temp_dir().join(format!(
            "freshell-codex-resume-switch-dispatcher-{}.mjs",
            std::process::id()
        ));
        let script = format!(
            "#!/usr/bin/env node\n\
             import fs from 'node:fs'\n\
             const args = process.argv.slice(2)\n\
             if (args.includes('app-server')) {{\n\
               await import('file://{fixture}')\n\
             }} else {{\n\
               fs.writeFileSync(process.env.CODEX_ARGV_CAPTURE_PATH, JSON.stringify(args))\n\
               setInterval(() => undefined, 1000)\n\
             }}\n",
            fixture = fixture.display()
        );
        std::fs::write(&dispatcher, script).expect("write dispatcher");
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dispatcher).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dispatcher, perms).unwrap();
        dispatcher
    })
}

// ─── TUI helpers (copied from codex_sidecar_reattach_e2e.rs) ──────────────────

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return serde_json::from_str(&raw).expect("captured argv is a JSON array");
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "spawned codex child never wrote its argv capture at {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn resume_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "resume" && w[1] == session_id)
}

async fn wait_for_rpc_id(tui: &mut TestWs, id: i64) -> serde_json::Value {
    loop {
        let msg = tokio::time::timeout(RECV_TIMEOUT, tui.next())
            .await
            .expect("rpc reply through the proxy within timeout")
            .expect("proxy stream open")
            .expect("no ws error");
        if let WsMessage::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json frame");
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
        }
    }
}

/// Dial the pane's `--remote` proxy URL, complete `initialize`/`initialized`,
/// then send `thread/resume {threadId}` and return its response frame.
async fn tui_resume_via_proxy(proxy_url: &str, thread_id: &str) -> serde_json::Value {
    let (mut tui, _) = tokio_tungstenite::connect_async(proxy_url)
        .await
        .expect("fake TUI dials the --remote proxy URL");
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).to_string(),
    ))
    .await
    .expect("send initialize");
    let init = wait_for_rpc_id(&mut tui, 1).await;
    assert!(
        init.get("result").is_some(),
        "initialize through the relay failed: {init}"
    );
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "method": "initialized"}).to_string(),
    ))
    .await
    .expect("send initialized");
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/resume", "params": {"threadId": thread_id}})
            .to_string(),
    ))
    .await
    .expect("send thread/resume");
    wait_for_rpc_id(&mut tui, 2).await
}

/// Dial the pane's `--remote` proxy URL, complete `initialize`/`initialized`,
/// then send `thread/start` and return its response frame.
async fn tui_thread_start_via_proxy(proxy_url: &str) -> serde_json::Value {
    let (mut tui, _) = tokio_tungstenite::connect_async(proxy_url)
        .await
        .expect("fake TUI dials the --remote proxy URL");
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).to_string(),
    ))
    .await
    .expect("send initialize");
    let init = wait_for_rpc_id(&mut tui, 1).await;
    assert!(
        init.get("result").is_some(),
        "initialize through the relay failed: {init}"
    );
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "method": "initialized"}).to_string(),
    ))
    .await
    .expect("send initialized");
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 2, "method": "thread/start", "params": {}}).to_string(),
    ))
    .await
    .expect("send thread/start");
    wait_for_rpc_id(&mut tui, 2).await
}

// ─── scenario helpers ────────────────────────────────────────────────────────

fn capture_path(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "freshell-codex-resume-switch-argv-{name}-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

fn scenario_cwd(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-codex-resume-switch-{name}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scenario cwd");
    dir
}

fn empty_reconciler() -> (
    tempfile::TempDir,
    Arc<CodexSidecarStore>,
    Arc<SidecarReconciler>,
) {
    let dir = tempfile::tempdir().expect("tempdir for the sidecar store");
    let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
    let (reconciler, report) = SidecarReconciler::boot_reconcile(store.clone());
    assert_eq!(report.held, 0, "an empty store holds nothing at boot");
    (dir, store, Arc::new(reconciler))
}

/// Compute the canonical rollout path for a thread id under CODEX_HOME,
/// mirroring the fixture's `getRolloutSessionDir` + `rolloutFilename` (UTC
/// date, `encodeURIComponent` — a no-op for the simple alnum ids this test uses).
fn canonical_rollout_path(codex_home: &std::path::Path, thread_id: &str) -> std::path::PathBuf {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (year, month, day) = days_to_ymd((secs / 86400) as i64);
    codex_home
        .join("sessions")
        .join(format!("{year:04}"))
        .join(format!("{month:02}"))
        .join(format!("{day:02}"))
        .join(format!("rollout-{thread_id}.jsonl"))
}

/// Howard Hinnant's days-from-epoch → (year, month, day) (UTC).
fn days_to_ymd(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Write a session_meta first line (the shape the real codex rollout writer
/// produces and the Rust indexer parses — requires `id` + `cwd`).
fn write_session_meta(path: &std::path::Path, thread_id: &str, cwd: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create rollout dir");
    }
    let line = json!({
        "timestamp": "2026-09-06T12:00:00.000Z",
        "type": "session_meta",
        "payload": { "id": thread_id, "session_id": thread_id, "cwd": cwd },
    })
    .to_string();
    std::fs::write(path, format!("{line}\n")).expect("write session_meta");
}

/// Send a `terminal.create` and return the `terminal.created` frame's
/// terminalId. `extra` merges into the create body (sessionRef, restore, …).
async fn create_codex_terminal(
    ws: &mut common::TestWs,
    request_id: &str,
    cwd: &str,
    extra: Option<serde_json::Value>,
) -> String {
    let mut body = json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "cwd": cwd,
    });
    if let Some(extra) = extra {
        if let Some(obj) = body.as_object_mut() {
            if let Some(extra_obj) = extra.as_object() {
                for (k, v) in extra_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
    }
    ws.send(WsMessage::Text(body.to_string()))
        .await
        .expect("send terminal.create");
    let created = common::next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (20 s budget), returning the parsed frame.
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    next_associated_frame_for_session(ws, terminal_id, None, label).await
}

/// Like [`next_associated_frame`] but additionally filters on `session_id`
/// (skips associated frames for other sessions — the `thread/started`
/// notification after `thread/start` re-adopts the SAME id and emits a
/// duplicate associated frame that would otherwise be picked up by the
/// wrong wait).
async fn next_associated_frame_for_session(
    ws: &mut common::TestWs,
    terminal_id: &str,
    session_id: Option<&str>,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                        && session_id
                            .map(|sid| value["sessionRef"]["sessionId"] == sid)
                            .unwrap_or(true)
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 20s");
}

/// Read frames until `terminal.meta.updated` for `terminal_id` with the given
/// session id arrives (20 s budget).
async fn next_meta_updated(
    ws: &mut common::TestWs,
    terminal_id: &str,
    session_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.meta.updated" {
                        if let Some(upserts) = value["upsert"].as_array() {
                            for row in upserts {
                                if row["terminalId"] == terminal_id
                                    && row["sessionId"] == session_id
                                {
                                    return value;
                                }
                            }
                        }
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => {
                panic!("[{label}] ws ended/errored/timed out awaiting meta.updated: {other:?}")
            }
        }
    }
    panic!("[{label}] no terminal.meta.updated for {terminal_id}/{session_id} within 20s");
}

/// Bounded-wait NEGATIVE helper: assert NO matching frame arrives within
/// `window` (the startup-window-expired baseline).
async fn assert_no_associated_within(ws: &mut common::TestWs, window: Duration, label: &str) {
    let deadline = tokio::time::Instant::now() + window;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated" {
                        panic!("[{label}] unexpected associated frame: {value}");
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => {}
        }
    }
}

/// The registry's `resume_session_id` for a terminal (meta probe).
fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// Poll the sidecar store until the record owned by `terminal_id` carries a
/// `session_id` (the `note_session_id` call lags the associated broadcast by
/// a few ms). `None` on deadline.
fn poll_sidecar_session_id(
    store: &CodexSidecarStore,
    terminal_id: &str,
    budget: Duration,
) -> Option<String> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        let sid = store
            .load_all()
            .into_iter()
            .find(|r| r.terminal_id.as_deref() == Some(terminal_id))
            .and_then(|r| r.session_id);
        if sid.is_some() {
            return sid;
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A read-only `PaneLedger` constructed over `dir` — its construction-time scan
/// sees whatever is on disk (the restart-leg authoritative chain read).
fn read_only_ledger(dir: &std::path::Path) -> PaneLedger {
    PaneLedger::new(Some(dir.to_path_buf()))
}

/// Spawn a server with a REAL pane ledger AND the codex proxy router task
/// (the candidate → identity routing lane). `common::spawn_server_with_ledger`
/// does NOT spawn the proxy router; without it, `RemoteProxyEvent::Candidate`
/// is never consumed and no `terminal.session.associated` frame is emitted.
/// This helper closes that gap: it installs the proxy event sink globally,
/// spawns the router task, and returns the ws URL + registry + ledger Arc.
async fn spawn_server_with_ledger_and_proxy(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_dir: &std::path::Path,
    tabs_persist_dir: Option<&std::path::Path>,
) -> (String, freshell_terminal::TerminalRegistry, Arc<PaneLedger>) {
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();
    let pane_ledger = Arc::new(PaneLedger::new(Some(ledger_dir.to_path_buf())));

    let state = WsState {
        pane_ledger: Arc::clone(&pane_ledger),
        layout: Default::default(),
        terminal_meta: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-resume-switch".to_string()),
        boot_id: Arc::new("boot-resume-switch".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
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
        tabs: tabs_persist_dir
            .map(|dir| freshell_ws::tabs::TabsRegistry::with_persist_dir(dir.to_path_buf()))
            .unwrap_or_default(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(cli_commands),
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

    // Install the proxy event channel and spawn the router task (the
    // candidate → identity routing lane — without this, no
    // terminal.session.associated frame is emitted for proxy candidates).
    let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
    set_codex_proxy_event_sink(proxy_tx);
    let _router_task =
        freshell_ws::codex_proxy_route::spawn_codex_proxy_router(state.clone(), proxy_rx);

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, pane_ledger)
}

// ─── fn1: resume switch after window expiry ─────────────────────────────────

/// Kata acceptance bullet (a) + the incident shape: pane UNBOUND at resume
/// time. The startup locator window "expired" (no locator wired) without a
/// bind; a simulated in-TUI/app-server `thread/resume` switch converges
/// terminal, pane, ledger, and sidecar on the durable thread.
#[test]
fn resume_switch_after_window_expiry_adopts_and_converges_everywhere() {
    reattach_rt().block_on(async {
        let _g = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        // DEV-0006 S5.e: unset = managed launch ON (the lane under test).
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

        // 1. Arrange: temp CODEX_HOME; durable fixture writes ON; behavior
        //    seeds threadResumeThreadId + threadResumeRolloutPath.
        let codex_home = tempfile::tempdir().expect("codex home");
        std::env::set_var("CODEX_HOME", codex_home.path());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");

        let cwd = scenario_cwd("fn1").to_string_lossy().to_string();
        let durable_id = "thread-durable";
        let rollout_path = canonical_rollout_path(codex_home.path(), durable_id);
        write_session_meta(&rollout_path, durable_id, &cwd);

        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({
                "threadResumeThreadId": durable_id,
                "threadResumeRolloutPath": rollout_path.to_string_lossy(),
            })
            .to_string(),
        );

        // Empty reconciler + store: claim finds nothing, falls through to
        // fresh spawn (the sidecar the managed launch boots).
        let (_store_dir, store, reconciler) = empty_reconciler();
        swap_test_reconciler(Some(reconciler), Some(store.clone()));
        // Set the process-global sidecar store so the SPAWNED runtime (not
        // just the reattach path) writes durable records into the test's
        // store — without this, SpawnedCodexAppServerRuntime::new() resolves
        // a disabled store and note_session_id is a no-op.
        set_codex_sidecar_store(store.clone());

        // 2. Spawn the server with the real ledger; codex_locator: None is
        //    CORRECT (no locator ⇒ startup window can never bind ⇒ expired).
        //    A tabs persist dir is wired so fn1 step 7 can push a tabs.sync
        //    frame and read the persisted snapshot back (acceptance bullet a
        //    names the tabs-sync snapshot among the convergence targets).
        let ledger_dir = tempfile::tempdir().expect("ledger dir");
        let tabs_dir = tempfile::tempdir().expect("tabs persist dir");
        let (url, registry, server_ledger) = spawn_server_with_ledger_and_proxy(
            vec![codex_cli_spec()],
            ledger_dir.path(),
            Some(tabs_dir.path()),
        )
        .await;
        let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

        let capture = capture_path("fn1-bind");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let terminal_id = create_codex_terminal(&mut ws, "req-fn1", &cwd, None).await;

        // 3. Baseline: NO associated frame (startup window expired without a
        //    bind) and the terminal carries no sessionRef.
        assert_no_associated_within(&mut ws, Duration::from_secs(2), "fn1-baseline").await;
        assert!(
            registry_resume_id(&registry, &terminal_id).is_none(),
            "fn1 baseline: registry meta must carry no resume_session_id"
        );

        // 4. Play the TUI: read the proxy URL from the captured argv, dial
        //    it, send thread/resume.
        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();
        assert!(
            proxy_url.starts_with("ws://127.0.0.1:"),
            "the --remote URL must be the loopback proxy: {proxy_url}"
        );

        let resume_reply = tui_resume_via_proxy(&proxy_url, durable_id).await;
        assert!(
            resume_reply.get("result").is_some(),
            "thread/resume must succeed: {resume_reply}"
        );

        // 5. Assert ordered frames: associated (NO previousSessionId) THEN
        //    meta.updated.
        let associated =
            next_associated_frame(&mut ws, &terminal_id, "fn1-resume-associated").await;
        assert_eq!(
            associated["sessionRef"]["provider"], "codex",
            "fn1: {associated}"
        );
        assert_eq!(
            associated["sessionRef"]["sessionId"], durable_id,
            "fn1: {associated}"
        );
        assert!(
            associated.get("previousSessionId").is_none()
                || associated["previousSessionId"].is_null(),
            "fn1: a first bind carries no previousSessionId: {associated}"
        );
        let meta = next_meta_updated(&mut ws, &terminal_id, durable_id, "fn1-resume-meta").await;
        assert!(
            meta["upsert"].as_array().is_some_and(|rows| rows
                .iter()
                .any(|r| r["provider"] == "codex" && r["sessionId"] == durable_id)),
            "fn1: meta.updated must carry codex/{durable_id}: {meta}"
        );

        // 6. Assert server homes: the live server's Arc<PaneLedger> resolve
        //    shows a bound row; registry meta resume_session_id == durable_id.
        assert!(
            server_ledger
                .lookup_by_session("codex", durable_id)
                .is_some(),
            "fn1: the pane ledger must have a bound row for codex/{durable_id}"
        );
        assert_eq!(
            registry_resume_id(&registry, &terminal_id).as_deref(),
            Some(durable_id),
            "fn1: registry meta resume_session_id must be {durable_id}"
        );

        // 7. Assert the sidecar record carries the new id (poll: note_session_id
        //    runs AFTER the associated broadcast, so the record update can
        //    lag the frame by a few ms).
        let record_session_id =
            poll_sidecar_session_id(&store, &terminal_id, Duration::from_secs(10));
        assert_eq!(
            record_session_id.as_deref(),
            Some(durable_id),
            "fn1: the sidecar record must carry session_id == {durable_id}"
        );

        // 8. RESTORE create (the client's post-reap re-issue) spawns argv
        //    whose LAST two entries are ["resume", "thread-durable"].
        registry.kill(&terminal_id);
        let restore_capture = capture_path("fn1-restore");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &restore_capture);
        let _terminal_id2 = create_codex_terminal(
            &mut ws,
            "req-fn1-restore",
            &cwd,
            Some(json!({
                "restore": true,
                "sessionRef": { "provider": "codex", "sessionId": durable_id },
            })),
        )
        .await;
        let restore_argv = wait_for_captured_argv(&restore_capture);
        assert!(
            resume_pair_position(&restore_argv, durable_id).is_some(),
            "fn1: restore create argv must contain `resume {durable_id}`: {restore_argv:?}"
        );
        let pos = resume_pair_position(&restore_argv, durable_id).unwrap();
        assert_eq!(
            pos + 2,
            restore_argv.len(),
            "fn1: resume pair must be last: {restore_argv:?}"
        );

        // 9. tabs-sync snapshot (acceptance bullet a — "tabs snapshot" among
        //    the convergence targets): push a tabs.sync frame whose pane
        //    payload carries sessionRef codex:thread-durable, then read the
        //    persisted tabs-sync snapshot from the server-side persist dir
        //    and assert it contains the binding. The provider==mode gate
        //    (tabs_persist_validation.rs:248-275) requires sessionRef.provider
        //    == mode, so both are "codex".
        let tabs_push = json!({
            "type": "tabs.sync.push",
            "deviceId": "dev-fn1",
            "deviceLabel": "fn1-test",
            "clientInstanceId": "client-fn1",
            "snapshotRevision": 1,
            "records": [{
                "tabKey": "dev-fn1:tab-fn1",
                "tabId": "tab-fn1",
                "tabName": "fn1",
                "status": "open",
                "revision": 1,
                "updatedAt": 1,
                "createdAt": 1,
                "titleSetByUser": false,
                "paneCount": 1,
                "panes": [{
                    "paneId": "pane-fn1",
                    "kind": "terminal",
                    "payload": {
                        "mode": "codex",
                        "shell": "system",
                        "sessionRef": {
                            "provider": "codex",
                            "sessionId": durable_id
                        }
                    }
                }]
            }]
        });
        ws.send(WsMessage::Text(tabs_push.to_string()))
            .await
            .expect("send tabs.sync.push");
        let ack = common::next_frame_of_type(&mut ws, "tabs.sync.ack").await;
        assert_eq!(
            ack["accepted"],
            json!(true),
            "fn1: tabs.sync.push must be accepted: {ack}"
        );
        let persisted = freshell_ws::tabs_persist::read_generation(tabs_dir.path(), "dev-fn1", 0)
            .expect("read persisted tabs generation")
            .expect("accepted tabs.sync.push must persist a generation");
        let persisted_pane = persisted["records"][0]["panes"][0].clone();
        assert_eq!(
            persisted_pane["payload"]["mode"], "codex",
            "fn1: persisted pane mode must be codex: {persisted_pane}"
        );
        assert_eq!(
            persisted_pane["payload"]["sessionRef"]["provider"], "codex",
            "fn1: persisted sessionRef provider must be codex: {persisted_pane}"
        );
        assert_eq!(
            persisted_pane["payload"]["sessionRef"]["sessionId"], durable_id,
            "fn1: persisted sessionRef sessionId must be {durable_id}: {persisted_pane}"
        );

        // Cleanup.
        registry.kill(&_terminal_id2);
        swap_test_reconciler(None, None);
        set_codex_sidecar_store(Arc::new(CodexSidecarStore::disabled()));
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
        std::env::remove_var("CODEX_HOME");
    });
}

// ─── fn2: repeat switches supersede + restart resumes the latest ─────────────

/// Kata acceptance bullets (c) + (d): repeat-switch supersession (A→B→C) +
/// restart resumes the exact durable thread in the same logical pane.
#[test]
fn repeat_resume_switches_supersede_and_restart_resumes_the_latest() {
    reattach_rt().block_on(async {
        let _g = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

        let codex_home = tempfile::tempdir().expect("codex home");
        std::env::set_var("CODEX_HOME", codex_home.path());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");

        let cwd = scenario_cwd("fn2").to_string_lossy().to_string();
        const A: &str = "thread-a";
        const B: &str = "thread-b";
        const C: &str = "thread-c";

        // Pre-write rollouts for A (threadStartRolloutPath), B, C (default
        // paths — the fixture computes them from the thread id when
        // threadResumeRolloutPath is unset, so thread/resume returns
        // params.threadId with the canonical path).
        let rollout_a = canonical_rollout_path(codex_home.path(), A);
        let rollout_b = canonical_rollout_path(codex_home.path(), B);
        let rollout_c = canonical_rollout_path(codex_home.path(), C);
        write_session_meta(&rollout_a, A, &cwd);
        write_session_meta(&rollout_b, B, &cwd);
        write_session_meta(&rollout_c, C, &cwd);

        // Behavior: threadStart seeds A (with its rollout path); thread/resume
        // uses params.threadId (threadResumeThreadId unset) and the default
        // path (threadResumeRolloutPath unset).
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({
                "threadStartThreadId": A,
                "threadStartRolloutPath": rollout_a.to_string_lossy(),
            })
            .to_string(),
        );

        let (_store_dir, store, reconciler) = empty_reconciler();
        swap_test_reconciler(Some(reconciler), Some(store.clone()));
        // Set the process-global sidecar store so the SPAWNED runtime (not
        // just the reattach path) writes durable records into the test's
        // store — without this, SpawnedCodexAppServerRuntime::new() resolves
        // a disabled store and note_session_id is a no-op.
        set_codex_sidecar_store(store.clone());

        let ledger_dir = tempfile::tempdir().expect("ledger dir");
        let (url, registry, server_ledger) =
            spawn_server_with_ledger_and_proxy(vec![codex_cli_spec()], ledger_dir.path(), None)
                .await;
        let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

        let capture = capture_path("fn2-bind");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let terminal_id = create_codex_terminal(&mut ws, "req-fn2", &cwd, None).await;

        // 1. Bind A first: TUI drives thread/start through the proxy.
        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();

        let start_reply = tui_thread_start_via_proxy(&proxy_url).await;
        assert!(
            start_reply.get("result").is_some(),
            "thread/start must succeed: {start_reply}"
        );
        let adopted_a = next_associated_frame(&mut ws, &terminal_id, "fn2-bind-A").await;
        assert_eq!(
            adopted_a["sessionRef"]["sessionId"], A,
            "fn2: thread/start must adopt A: {adopted_a}"
        );
        assert!(
            adopted_a.get("previousSessionId").is_none()
                || adopted_a["previousSessionId"].is_null(),
            "fn2: first bind carries no previousSessionId: {adopted_a}"
        );
        assert_eq!(
            registry_resume_id(&registry, &terminal_id).as_deref(),
            Some(A),
            "fn2: registry meta must be A after thread/start"
        );

        // 2. thread/resume → B: previousSessionId A, ledger RETIRED A.
        let resume_b = tui_resume_via_proxy(&proxy_url, B).await;
        assert!(
            resume_b.get("result").is_some(),
            "thread/resume to B must succeed: {resume_b}"
        );
        let rebound_b =
            next_associated_frame_for_session(&mut ws, &terminal_id, Some(B), "fn2-resume-B").await;
        assert_eq!(
            rebound_b["sessionRef"]["sessionId"], B,
            "fn2: resume must move the pane to B: {rebound_b}"
        );
        assert_eq!(
            rebound_b["previousSessionId"], A,
            "fn2: resume to B must carry previousSessionId A: {rebound_b}"
        );
        assert_eq!(
            registry_resume_id(&registry, &terminal_id).as_deref(),
            Some(B),
            "fn2: registry meta must be B after resume"
        );
        let _ = next_meta_updated(&mut ws, &terminal_id, B, "fn2-resume-B-meta").await;

        // F5: ledger supersession row-state — A is Retired/Superseded by B.
        assert_codex_ledger_superseded(&server_ledger, A, B, "fn2/resume-B");

        // 3. thread/resume → C: previousSessionId B, ledger RETIRED B.
        let resume_c = tui_resume_via_proxy(&proxy_url, C).await;
        assert!(
            resume_c.get("result").is_some(),
            "thread/resume to C must succeed: {resume_c}"
        );
        let rebound_c =
            next_associated_frame_for_session(&mut ws, &terminal_id, Some(C), "fn2-resume-C").await;
        assert_eq!(
            rebound_c["sessionRef"]["sessionId"], C,
            "fn2: resume must move the pane to C: {rebound_c}"
        );
        assert_eq!(
            rebound_c["previousSessionId"], B,
            "fn2: resume to C must carry previousSessionId B: {rebound_c}"
        );
        assert_eq!(
            registry_resume_id(&registry, &terminal_id).as_deref(),
            Some(C),
            "fn2: registry meta must be C after resume"
        );

        // The live server's ledger resolves C as the bound row.
        assert!(
            server_ledger.lookup_by_session("codex", C).is_some(),
            "fn2: the pane ledger must have a bound row for codex/{C}"
        );

        // F5: ledger supersession row-state — B is Retired/Superseded by C.
        assert_codex_ledger_superseded(&server_ledger, B, C, "fn2/resume-C");

        // 4. Restart leg: kill the pane, spawn a SECOND server against the
        //    SAME ledger_dir (two servers pointed at the same dir model a
        //    restart). A fresh read-only PaneLedger over the dir resolves the
        //    ledger's authoritative chain to C. A restore-style terminal.create
        //    — the client carries the persisted sessionRef {codex, C} —
        //    produces spawn argv with ["resume", "thread-c"] as its final pair
        //    and NEVER ["resume", "thread-a"].
        registry.kill(&terminal_id);
        let restore_capture = capture_path("fn2-restore");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &restore_capture);

        // Fresh read-only ledger: the authoritative chain resolves to C.
        let ro_ledger = read_only_ledger(ledger_dir.path());
        assert!(
            ro_ledger.lookup_by_session("codex", C).is_some(),
            "fn2: read-only ledger must resolve codex/{C} after the supersession chain"
        );

        // Second server against the same ledger dir.
        let (url2, registry2, _ledger2) =
            spawn_server_with_ledger_and_proxy(vec![codex_cli_spec()], ledger_dir.path(), None)
                .await;
        let (mut ws2, _inv2) = common::connect_and_capture_inventory(&url2).await;

        let terminal_id2 = create_codex_terminal(
            &mut ws2,
            "req-fn2-restore",
            &cwd,
            Some(json!({
                "restore": true,
                "sessionRef": { "provider": "codex", "sessionId": C },
            })),
        )
        .await;
        let restore_argv = wait_for_captured_argv(&restore_capture);
        assert!(
            resume_pair_position(&restore_argv, C).is_some(),
            "fn2: restore create argv must contain `resume {C}`: {restore_argv:?}"
        );
        assert!(
            resume_pair_position(&restore_argv, A).is_none(),
            "fn2: restore create argv must NOT resume the superseded A: {restore_argv:?}"
        );
        assert!(
            resume_pair_position(&restore_argv, B).is_none(),
            "fn2: restore create argv must NOT resume the superseded B: {restore_argv:?}"
        );
        let c_pos = resume_pair_position(&restore_argv, C).unwrap();
        assert_eq!(
            c_pos + 2,
            restore_argv.len(),
            "fn2: resume pair must be last: {restore_argv:?}"
        );

        // 5. Failure-state pin: with the resumed path DELETED from
        //    CODEX_HOME, the restore gate demotes to a fresh spawn — assert
        //    argv lacks ["resume", ...] entirely for a dead id.
        //    The default harness (NoIndexProbe) returns Unknown ⇒ the gate
        //    proceeds (fail-open); a dead-id demote requires a probe that
        //    returns Absent. We spawn a custom server with a StubProbe(Absent)
        //    for this leg (mirroring resume_validation_gate.rs's
        //    positive-absence leg).
        registry2.kill(&terminal_id2);
        let _ = std::fs::remove_file(&rollout_c);

        let dead_capture = capture_path("fn2-dead");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &dead_capture);
        let (url3, reg3) =
            spawn_server_with_absent_probe(vec![codex_cli_spec()], ledger_dir.path(), "codex", C)
                .await;
        let (mut ws3, _inv3) = common::connect_and_capture_inventory(&url3).await;
        let _dead_terminal = create_codex_terminal(
            &mut ws3,
            "req-fn2-dead",
            &cwd,
            Some(json!({
                "restore": true,
                "sessionRef": { "provider": "codex", "sessionId": C },
            })),
        )
        .await;
        let dead_argv = wait_for_captured_argv(&dead_capture);
        assert!(
            resume_pair_position(&dead_argv, C).is_none(),
            "fn2: a dead-id restore must NOT produce `resume {C}`: {dead_argv:?}"
        );
        assert!(
            dead_argv.iter().all(|a| a != "resume"),
            "fn2: a dead-id restore must lack any `resume` token: {dead_argv:?}"
        );
        reg3.kill(&_dead_terminal);

        // Cleanup.
        swap_test_reconciler(None, None);
        set_codex_sidecar_store(Arc::new(CodexSidecarStore::disabled()));
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
        std::env::remove_var("CODEX_HOME");
    });
}

// ─── custom server with an Absent probe (failure-state pin) ──────────────────

/// A `SessionExistenceProbe` that returns `Absent` for a specific
/// (provider, session_id) pair and `Unknown` for everything else — the
/// resume_validation_gate.rs StubProbe convention.
struct AbsentForProbe {
    provider: String,
    session_id: String,
}

impl SessionExistenceProbe for AbsentForProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        if provider == self.provider && session_id == self.session_id {
            SessionExistence::Absent
        } else {
            SessionExistence::Unknown
        }
    }
    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        false
    }
}

/// Spawn a server with a real pane ledger AND a custom existence probe that
/// returns `Absent` for `(provider, session_id)` — the failure-state leg
/// requires the gate to demote to a fresh spawn. Returns the ws URL and
/// registry (the state is consumed by the router).
async fn spawn_server_with_absent_probe(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_dir: &std::path::Path,
    provider: &str,
    session_id: &str,
) -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();
    let pane_ledger = Arc::new(PaneLedger::new(Some(ledger_dir.to_path_buf())));

    let probe = Arc::new(AbsentForProbe {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    });

    let state = WsState {
        pane_ledger: Arc::clone(&pane_ledger),
        layout: Default::default(),
        terminal_meta: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test-absent".to_string()),
        boot_id: Arc::new("boot-test-absent".to_string()),
        settings,
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(cli_commands),
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
        session_existence: probe,
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

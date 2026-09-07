//! da92 end-to-end — codex pane restore reattaches to a surviving sidecar
//! through the WS door (codex sidecar lifecycle, Task 8).
//!
//! Three scenarios over the REAL Rust WS server, each sending the frozen
//! restore create (`terminal.create {mode:'codex', shell:'system', cwd,
//! restore:true, sessionRef:{provider:'codex', sessionId}}`) and playing the
//! TUI against the pane's `--remote` proxy URL:
//!
//! 1. **Reattach**: a tracked, verified SURVIVOR (this test's own fake
//!    app-server child, mid-turn shape via `loadedThreadIds`) is claimed for
//!    the restore — the TUI's `thread/resume` lands on the SURVIVOR (its op
//!    log records it), its pid is untouched, and its durable record gains the
//!    new terminal id at adopt.
//! 2. **Fresh fallback**: no tracked survivor ⇒ today's spawn path is
//!    byte-compatible (the managed `--remote` 4-tuple + bel pair + resume
//!    pair last) and a NEW fixture instance serves the plan (its op log
//!    records the traffic).
//! 3. **da92 control**: the scripted `-32600` "active writer" rejection is
//!    confined to the fresh path — the same `thread/resume` that SUCCEEDS
//!    against a claimed survivor comes back as the incident-shaped error.
//! 4. **Disk fork-lane fan-out**: after a proxy-bound pane's in-TUI fork is
//!    picked up by the DISK lane (`tick_forks` → `rebind_codex_identity`), the
//!    durable sidecar record's `session_id` (the restart-time
//!    `claim_for_session` key) must have advanced to the fork child.
//!
//! This binary OWNS process env (`CODEX_CMD`, `CODEX_HOME`,
//! `FAKE_CODEX_APP_SERVER_BEHAVIOR`, `FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES`,
//! `CODEX_ARGV_CAPTURE_PATH`) — the `resume_validation_gate.rs` convention:
//! env mutation is process-global, and nothing else in this binary reads
//! these vars. The codex launch manager global is SET-ONCE per process, so
//! the scenarios are serialized on ONE never-dropped runtime (the
//! `restore_storm.rs` ground rule — the manager's lazily-armed teardown
//! worker must outlive every test fn) and swap the test-owned
//! reconciler/store through statics the one installed factory closes over.
//!
//! PROCESS SAFETY: kills ONLY pids this test spawned — the survivor fixture
//! child (reaped by the reattach teardown path, with an explicit own-child
//! kill fallback) and panes via `registry.kill`. Loopback ephemeral ports
//! only — never 3001/3002. Temp stores only — the machine's live sidecars
//! stay structurally unreachable.
//!
//! Linux-only: reattach identity evidence is `/proc`-based
//! (`verify_sidecar_identity` is Unverifiable elsewhere, so no claim path
//! exists off-Linux) and the tracked-spawn detach arm is Linux-gated.
#![cfg(target_os = "linux")]

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
    proc_cmdline, proc_starttime, select_codex_runtime, set_codex_sidecar_store,
    CodexSidecarRecord, CodexSidecarStore, SidecarReconciler, SidecarRecordState,
    CODEX_SIDECAR_OWNERSHIP_ENV, SIDECAR_RECORD_VERSION,
};
use freshell_sessions::codex_locator::CodexLocator;
use freshell_ws::WsState;

const AUTH_TOKEN: &str = "e2e-codex-sidecar-reattach-token";
const RECV_TIMEOUT: Duration = Duration::from_secs(20);

// ─── the set-once global manager over a swappable test reconciler/store ──────

static TEST_RECONCILER: Mutex<Option<Arc<SidecarReconciler>>> = Mutex::new(None);
static TEST_STORE: Mutex<Option<Arc<CodexSidecarStore>>> = Mutex::new(None);

/// Install the ONE process-wide launch manager (set-once): its factory
/// re-reads the statics per plan and dispatches through the REAL production
/// selection ([`select_codex_runtime`] — claim a verified survivor for resume
/// plans, else spawn), so each serialized scenario swaps in its own
/// reconciler/store.
fn install_global_manager() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let manager = CodexTerminalLaunchManager::new(Box::new(|plan| {
            // Clone the handles OUT of the statics before the await — std
            // MutexGuards must never cross an await point.
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

/// One tokio runtime for the WHOLE binary, never dropped (the
/// `restore_storm.rs` ground rule): the global manager's lazily-armed
/// teardown worker must outlive every test fn, so tests are
/// `#[test] fn .. { reattach_rt().block_on(async { .. }) }`.
fn reattach_rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("reattach runtime")
    })
}

/// Serialize the scenarios: process env + the reconciler/store statics are
/// process-global, so exactly one scenario runs at a time.
fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The codex create door injects the freshell MCP server into the TUI argv
/// (`mcp_inject.rs::server_command_args`), resolving `tsx` from the freshell
/// repo root nearest the process CWD. A `.worktrees/` checkout carries no
/// `node_modules` of its own — the committed fixture already resolves `ws`
/// from the parent checkout via node's upward walk, and this shim gives the
/// MCP resolver the same reach: when the cwd-nearest freshell root lacks
/// `node_modules/tsx`, chdir to the nearest ANCESTOR freshell root that has
/// it (the parent checkout). Process-global exactly like the env this binary
/// already owns; a no-op on a dependency-bearing checkout. The injected args
/// only ever reach the fake dispatcher, which ignores them.
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
        // The root `mcp_inject::find_repo_root` would resolve from this cwd
        // (walk up, max 5, first `package.json` named "freshell").
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
            return; // normal checkout: nothing to do
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

// ─── harness (copied with attribution from codex_managed_launch_e2e.rs) ──────

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

/// The shipped codex CLI spec shape (`server/index.ts:231-255`, mirrored from
/// `codex_managed_launch_e2e.rs::codex_cli_spec`), so the resolver takes the
/// REAL codex branch (notification pair, `--remote` when a proxy URL is
/// present, `resume {{sessionId}}`, `CODEX_CMD` override).
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

/// Write the node dispatcher that plays BOTH codex roles (copied with
/// attribution from `codex_managed_launch_e2e.rs::write_codex_dispatcher`):
/// - argv contains `app-server` → run the committed fake app-server fixture
///   (the manager-spawned sidecar; reads `FAKE_CODEX_APP_SERVER_BEHAVIOR`).
/// - otherwise (the TUI launch) → dump argv JSON to
///   `$CODEX_ARGV_CAPTURE_PATH` and stay alive until the test kills the pane.
fn codex_dispatcher() -> &'static std::path::PathBuf {
    static DISPATCHER: OnceLock<std::path::PathBuf> = OnceLock::new();
    DISPATCHER.get_or_init(|| {
        let fixture = fixture_path();
        let dispatcher = std::env::temp_dir().join(format!(
            "freshell-codex-reattach-e2e-dispatcher-{}.mjs",
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

async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-reattach-e2e".to_string()),
        boot_id: Arc::new("boot-reattach-e2e".to_string()),
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![codex_cli_spec()]),
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
        // `NoIndexProbe` answers Unknown ⇒ the resume-validation gate
        // proceeds (fail-open), the codex_session_ref_resume.rs handshake
        // convention.
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
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

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_and_handshake(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");
    // Drain the 4-frame handshake (ready → settings.updated → perf.logging →
    // terminal.inventory; config_fallback is None in this harness).
    for _ in 0..4u8 {
        let _ = tokio::time::timeout(RECV_TIMEOUT, ws.next())
            .await
            .expect("handshake frame within timeout")
            .expect("stream open")
            .expect("no ws error");
    }
    ws
}

/// Send the frozen restore create (§17 field-for-field:
/// `{"type":"terminal.create","requestId":…,"mode":"codex","shell":"system",
/// "cwd":…,"restore":true,"sessionRef":{"provider":"codex","sessionId":…}}`)
/// and return the `terminal.created` frame (panicking on an `error` frame
/// for diagnosis).
async fn create_codex_restore_terminal(
    ws: &mut TestWs,
    request_id: &str,
    cwd: &str,
    session_id: &str,
) -> serde_json::Value {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "codex",
            "shell": "system",
            "cwd": cwd,
            "restore": true,
            "sessionRef": { "provider": "codex", "sessionId": session_id },
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    loop {
        let msg = tokio::time::timeout(RECV_TIMEOUT, ws.next())
            .await
            .expect("terminal.created within timeout")
            .expect("stream open")
            .expect("no ws error");
        if let WsMessage::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json frame");
            match value["type"].as_str() {
                Some("terminal.created") if value["requestId"] == json!(request_id) => {
                    return value;
                }
                Some("error") => panic!("terminal.create failed: {value}"),
                _ => {}
            }
        }
    }
}

/// Poll the capture file the dispatcher writes until it appears, then parse
/// the argv (JSON array — the dispatcher shape).
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

// ─── the survivor: this test's OWN fake app-server child ─────────────────────

/// Allocate a loopback ephemeral ws URL (bind 127.0.0.1:0, read, release).
fn bind_loopback_ws_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    format!("ws://127.0.0.1:{port}")
}

/// Spawn the SURVIVOR fixture on an ephemeral loopback port with a
/// per-instance behavior JSON (Command env overrides the inherited process
/// env, so the survivor's knobs never touch the dispatcher-spawned sidecars').
/// `kill_on_drop(true)` is the leak backstop — an assertion failure anywhere
/// still reaps this test's own child. Returns (child, pid, listen ws url).
async fn spawn_survivor(
    ownership_id: &str,
    behavior: &serde_json::Value,
) -> (tokio::process::Child, u32, String) {
    let listen_ws_url = bind_loopback_ws_url();
    let mut child = tokio::process::Command::new("node")
        .arg(fixture_path())
        .arg("--listen")
        .arg(&listen_ws_url)
        .env(CODEX_SIDECAR_OWNERSHIP_ENV, ownership_id)
        .env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn this test's own survivor fixture");
    let pid = child.id().expect("live survivor pid");
    // Wait for the WS listener: by then exec has long completed, so the
    // /proc evidence captured afterwards is really the fixture's (the Task 7
    // no-post-fork-flake convention).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Ok((probe, _response))) = tokio::time::timeout(
            Duration::from_secs(1),
            tokio_tungstenite::connect_async(&listen_ws_url),
        )
        .await
        {
            drop(probe);
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("survivor fixture exited before listening: {status}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "survivor fixture WS never came up"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    (child, pid, listen_ws_url)
}

// ─── the TUI: dial the proxy, initialize, thread/resume ──────────────────────

/// Read frames until the JSON-RPC response for `id` arrives.
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

/// Play the TUI: dial the pane's `--remote` proxy URL, complete
/// `initialize`/`initialized`, then send `thread/resume {threadId}` and
/// return its response frame (result OR error — the caller asserts which).
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

// ─── non-panicking evidence/cleanup polls (asserts run AFTER cleanup) ─────────

/// Poll the fixture's `appendThreadOperationLogPath` op log for a
/// `thread/resume` entry with `thread_id` (the fixture appends AFTER
/// responding, so the RPC reply can beat the disk write). `None` on deadline.
fn poll_thread_resume_logged(
    path: &std::path::Path,
    thread_id: &str,
    budget: Duration,
) -> Option<serde_json::Value> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            for line in raw.lines() {
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                    if entry["method"] == json!("thread/resume")
                        && entry["threadId"] == json!(thread_id)
                    {
                        return Some(entry);
                    }
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Poll the store until `ownership_id`'s record carries a terminal id.
/// `None` on deadline. (Adopt completes before `terminal.created` is emitted,
/// so this returns almost immediately on the green path.)
fn poll_record_terminal_id(
    store: &CodexSidecarStore,
    ownership_id: &str,
    budget: Duration,
) -> Option<String> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        let terminal_id = store
            .load_all()
            .into_iter()
            .find(|r| r.ownership_id == ownership_id)
            .and_then(|r| r.terminal_id);
        if terminal_id.is_some() {
            return terminal_id;
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Poll until `pid` reads gone from `/proc` (`proc_starttime` is `None` for
/// reaped AND zombie states). `true` = gone within the budget.
async fn poll_pid_gone(pid: u32, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if proc_starttime(pid as i32).is_none() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Poll until the pane's proxy URL refuses connections (sidecar teardown
/// closes the proxy listener first) — the deterministic "teardown ran" gate
/// for the dispatcher-spawned sidecars whose pids this test never sees.
async fn poll_proxy_refused(proxy_url: &str, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        match tokio::time::timeout(
            Duration::from_secs(1),
            tokio_tungstenite::connect_async(proxy_url),
        )
        .await
        {
            Ok(Err(_)) => return true,
            Ok(Ok((probe, _))) => drop(probe),
            Err(_elapsed) => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// An empty reconciler over a fresh temp store (the no-tracked-survivor
/// scenarios' claim source: `claim_for_session` finds nothing, the selection
/// falls through to today's spawn path).
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

fn scenario_cwd(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-codex-reattach-e2e-{name}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scenario cwd");
    dir
}

fn capture_path(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "freshell-codex-reattach-e2e-argv-{name}-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    path
}

// ─── scenario 1: reattach to the surviving sidecar ────────────────────────────

#[test]
fn restore_reattaches_tui_to_surviving_sidecar_preserving_in_flight_turn() {
    reattach_rt().block_on(async {
        let _serial = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        // DEV-0006 S5.e: unset = managed launch ON (the leg under test).
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");
        // The SURVIVOR carries its behavior per-instance (Command env); the
        // process-global knob stays unset so a (wrong) fresh spawn would
        // write NO op log — the red/green discriminator.
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");

        let session_id = "0199da92-e2e-reattach-thread";
        let ownership_id = "codex-sidecar-da920e2e-0001-4aaa-8aaa-aaaaaaaaaaaa";
        let log_a = std::env::temp_dir().join(format!(
            "freshell-codex-reattach-e2e-oplog-a-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&log_a);

        // (1) The SURVIVOR: this test's own fixture child, mid-turn shape
        // (`loadedThreadIds` reports the session as loaded), op log A.
        let (mut survivor, survivor_pid, survivor_ws_url) = spawn_survivor(
            ownership_id,
            &json!({
                "appendThreadOperationLogPath": log_a,
                "loadedThreadIds": [session_id],
            }),
        )
        .await;
        let survivor_starttime =
            proc_starttime(survivor_pid as i32).expect("live survivor has a starttime");

        // Its verified record in a temp store; the reconciler holds it.
        let dir = tempfile::tempdir().expect("tempdir for the sidecar store");
        let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
        store
            .write(&CodexSidecarRecord {
                record_version: SIDECAR_RECORD_VERSION,
                ownership_id: ownership_id.to_string(),
                pid: survivor_pid,
                starttime: survivor_starttime,
                cmdline: proc_cmdline(survivor_pid as i32).expect("live survivor has a cmdline"),
                ws_url: survivor_ws_url.clone(),
                session_id: Some(session_id.to_string()),
                terminal_id: None,
                server_instance_id: "srv-prev-gen".to_string(),
                created_at: 1_700_000_000_000,
                updated_at: 1_700_000_000_001,
                state: SidecarRecordState::Active,
            })
            .expect("write survivor record");
        let (reconciler, report) = SidecarReconciler::boot_reconcile(store.clone());
        assert_eq!(report.held, 1, "the survivor is held at boot");
        let reconciler = Arc::new(reconciler);
        // Hand the factory this scenario's reconciler + store: the selection
        // claims the verified survivor for the resume plan and mints the
        // reattach runtime. (TDD red, Task 8 Step 2: with this wiring absent
        // the plan spawned fresh and the survivor's op log stayed empty.)
        swap_test_reconciler(Some(reconciler.clone()), Some(store.clone()));

        // (2) The restore create through the WS door.
        let (ws_url, registry) = spawn_server().await;
        let mut ws = connect_and_handshake(&ws_url).await;
        let capture = capture_path("reattach");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let cwd = scenario_cwd("reattach");
        let created = create_codex_restore_terminal(
            &mut ws,
            "req-reattach",
            cwd.to_str().unwrap(),
            session_id,
        )
        .await;
        let terminal_id = created["terminalId"].as_str().unwrap().to_string();

        // (3a) The captured TUI argv: `--remote ws://127.0.0.1:<proxy>` +
        // the `resume <sid>` pair.
        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();
        assert!(
            proxy_url.starts_with("ws://127.0.0.1:"),
            "the --remote URL must be the loopback proxy: {proxy_url}"
        );
        assert!(
            resume_pair_position(&argv, session_id).is_some(),
            "TUI argv must contain `resume {session_id}`: {argv:?}"
        );

        // (3b) Evidence collection — non-panicking, so cleanup ALWAYS runs
        // (red and green alike) and no test-spawned process can leak.
        let resume_reply = tui_resume_via_proxy(&proxy_url, session_id).await;
        let logged = poll_thread_resume_logged(&log_a, session_id, RECV_TIMEOUT);
        let survivor_alive_same_incarnation =
            proc_starttime(survivor_pid as i32) == Some(survivor_starttime);
        let record_terminal_id =
            poll_record_terminal_id(&store, ownership_id, Duration::from_secs(10));
        let unclaimed = reconciler.unclaimed_len();

        // Cleanup: kill ONLY pids this test spawned. The pane kill queues the
        // reattached sidecar's teardown, which reaps the survivor (this
        // test's own child); if that never ran (the red shape), kill our own
        // child directly.
        registry.kill(&terminal_id);
        if !poll_pid_gone(survivor_pid, Duration::from_secs(8)).await {
            let _ = survivor.start_kill();
        }
        let _ = survivor.wait().await;
        let _ = poll_proxy_refused(&proxy_url, Duration::from_secs(8)).await;
        swap_test_reconciler(None, None);
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");

        // (3c) Asserts.
        assert!(
            resume_reply.get("result").is_some(),
            "thread/resume must SUCCEED against the claimed survivor: {resume_reply}"
        );
        let logged = logged.unwrap_or_else(|| {
            panic!(
                "the SURVIVOR's op log never recorded thread/resume for {session_id} — \
                 the pane is NOT wired to the surviving sidecar"
            )
        });
        assert_eq!(
            logged["listenUrl"],
            json!(survivor_ws_url),
            "thread/resume must have been served by the SURVIVOR's listener: {logged}"
        );
        assert!(
            survivor_alive_same_incarnation,
            "the surviving sidecar (pid {survivor_pid}) must still be alive, same incarnation"
        );
        assert_eq!(
            record_terminal_id.as_deref(),
            Some(terminal_id.as_str()),
            "the survivor's record must gain the new terminal id at adopt"
        );
        assert_eq!(unclaimed, 0, "the one-shot claim was consumed");
    });
}

// ─── scenario 2: no tracked survivor → today's fresh-spawn path ───────────────

#[test]
fn restore_falls_back_to_fresh_sidecar_without_tracked_survivor() {
    reattach_rt().block_on(async {
        let _serial = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

        // EMPTY reconciler: the claim runs for real, finds nothing, and the
        // selection falls through to today's spawn path.
        let (_dir, store, reconciler) = empty_reconciler();
        swap_test_reconciler(Some(reconciler), Some(store));

        // The dispatcher-spawned sidecar reads the process-global behavior:
        // op log B records which listener served the traffic.
        let session_id = "0199da92-e2e-fresh-fallback-thread";
        let log_b = std::env::temp_dir().join(format!(
            "freshell-codex-reattach-e2e-oplog-b-{}.jsonl",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&log_b);
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({ "appendThreadOperationLogPath": log_b }).to_string(),
        );

        let (ws_url, registry) = spawn_server().await;
        let mut ws = connect_and_handshake(&ws_url).await;
        let capture = capture_path("fresh");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let cwd = scenario_cwd("fresh");
        let created =
            create_codex_restore_terminal(&mut ws, "req-fresh", cwd.to_str().unwrap(), session_id)
                .await;
        let terminal_id = created["terminalId"].as_str().unwrap().to_string();

        // Byte-compatible with today's managed resume argv (the S5.e golden
        // shape, codex_managed_launch_e2e.rs Phase 3): the `--remote`
        // 4-tuple, the bel notification pair, the resume pair LAST.
        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();
        assert!(
            proxy_url.starts_with("ws://127.0.0.1:"),
            "the --remote URL must be the loopback proxy: {proxy_url}"
        );
        assert_eq!(
            &argv[2..4],
            &["-c".to_string(), "features.apps=false".to_string()],
            "argv: {argv:?}"
        );
        assert_eq!(
            &argv[4..6],
            &["-c".to_string(), "tui.notification_method=bel".to_string()],
            "argv: {argv:?}"
        );
        let position = resume_pair_position(&argv, session_id)
            .unwrap_or_else(|| panic!("argv must contain `resume {session_id}`: {argv:?}"));
        assert_eq!(
            position + 2,
            argv.len(),
            "resume pair must be last: {argv:?}"
        );

        // Evidence, then cleanup, then asserts (the scenario-1 discipline).
        let resume_reply = tui_resume_via_proxy(&proxy_url, session_id).await;
        let logged = poll_thread_resume_logged(&log_b, session_id, RECV_TIMEOUT);

        registry.kill(&terminal_id);
        let torn_down = poll_proxy_refused(&proxy_url, Duration::from_secs(8)).await;
        swap_test_reconciler(None, None);
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");

        assert!(
            resume_reply.get("result").is_some(),
            "thread/resume must succeed on the fresh path: {resume_reply}"
        );
        assert!(
            logged.is_some(),
            "the NEW fixture instance's op log (log-B) must record thread/resume \
             for {session_id} — today's fresh-spawn path serves the plan"
        );
        assert!(
            torn_down,
            "pane kill must tear the fresh sidecar's proxy down"
        );
    });
}

// ─── scenario 3: the da92 control — -32600 confined to the fresh path ─────────

#[test]
fn active_writer_collision_surfaces_minus32600_only_on_the_fresh_path() {
    reattach_rt().block_on(async {
        let _serial = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

        // EMPTY reconciler + the scripted active-writer rejection: the
        // incident's failure mode, now confined to the no-survivor path (the
        // reattach scenario above proves the same resume SUCCEEDS when a
        // survivor exists).
        let (_dir, store, reconciler) = empty_reconciler();
        swap_test_reconciler(Some(reconciler), Some(store));

        let session_id = "0199da92-e2e-active-writer-thread";
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32600, "message": "thread already has an active writer" }
                    }
                }
            })
            .to_string(),
        );

        let (ws_url, registry) = spawn_server().await;
        let mut ws = connect_and_handshake(&ws_url).await;
        let capture = capture_path("writer");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let cwd = scenario_cwd("writer");
        let created =
            create_codex_restore_terminal(&mut ws, "req-writer", cwd.to_str().unwrap(), session_id)
                .await;
        let terminal_id = created["terminalId"].as_str().unwrap().to_string();

        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();

        // Evidence, then cleanup, then asserts.
        let resume_reply = tui_resume_via_proxy(&proxy_url, session_id).await;

        registry.kill(&terminal_id);
        let _ = poll_proxy_refused(&proxy_url, Duration::from_secs(8)).await;
        swap_test_reconciler(None, None);
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");

        let error = resume_reply
            .get("error")
            .unwrap_or_else(|| panic!("the fresh path must surface the scripted rejection: {resume_reply}"));
        assert_eq!(
            error["code"],
            json!(-32600),
            "the incident's error code: {resume_reply}"
        );
        // codex uses -32600 generically for many rejections (reports/V1.md);
        // the code alone is not the incident signature — the message is.
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|m| m.contains("active writer")),
            "the -32600 message must carry the active-writer signature: {resume_reply}"
        );
    });
}

// ─── scenario 4: the disk fork lane advances the durable sidecar record ───────

/// Compute the canonical rollout path for a thread id under CODEX_HOME,
/// mirroring the fixture's `getRolloutSessionDir` + `rolloutFilename` (UTC
/// date, `encodeURIComponent` — a no-op for these ids). Copied with
/// attribution from `codex_resume_switch_rebind.rs`.
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

/// Howard Hinnant's days-from-epoch → (year, month, day) (UTC). Copied with
/// attribution from `codex_resume_switch_rebind.rs`.
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
/// produces and the Rust indexer parses — requires `id` + `cwd`). Copied
/// with attribution from `codex_resume_switch_rebind.rs`.
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

/// Write the session_meta of an in-TUI USER fork child: `forked_from_id`
/// lineage + `thread_source: "user"` + `originator: "codex-tui"` — the
/// verified 019fa613 shape (the locator-tests writer's fork variant,
/// `write_rollout_full(..., forked_from, Some("user"))`).
fn write_fork_session_meta(path: &std::path::Path, thread_id: &str, cwd: &str, forked_from: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create rollout dir");
    }
    let line = json!({
        "timestamp": "2026-09-06T12:05:00.000Z",
        "type": "session_meta",
        "payload": {
            "id": thread_id,
            "session_id": thread_id,
            "cwd": cwd,
            "forked_from_id": forked_from,
            "originator": "codex-tui",
            "thread_source": "user",
            "source": "cli",
        },
    })
    .to_string();
    std::fs::write(path, format!("{line}\n")).expect("write fork session_meta");
}

/// A plain managed codex create (no restore/sessionRef) through the WS door,
/// returning the `terminal.created` frame's terminalId. Sibling of
/// [`create_codex_restore_terminal`] for the fresh-bind flow (the
/// `codex_resume_switch_rebind.rs::create_codex_terminal` shape).
async fn create_codex_terminal(ws: &mut TestWs, request_id: &str, cwd: &str) -> String {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "codex",
            "shell": "system",
            "cwd": cwd,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");
    loop {
        let msg = tokio::time::timeout(RECV_TIMEOUT, ws.next())
            .await
            .expect("terminal.created within timeout")
            .expect("stream open")
            .expect("no ws error");
        if let WsMessage::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json frame");
            match value["type"].as_str() {
                Some("terminal.created") if value["requestId"] == json!(request_id) => {
                    return value["terminalId"]
                        .as_str()
                        .expect("terminal.created carries terminalId")
                        .to_string();
                }
                Some("error") => panic!("terminal.create failed: {value}"),
                _ => {}
            }
        }
    }
}

/// Dial the pane's `--remote` proxy URL, complete `initialize`/`initialized`,
/// then send `thread/start` and return its response frame. Copied with
/// attribution from `codex_resume_switch_rebind.rs`.
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

/// Scan WS text frames until a `terminal.session.associated` for
/// `terminal_id` carrying `sessionRef.sessionId == session_id` arrives
/// (skips associated frames for other sessions). Copied with attribution
/// from `codex_resume_switch_rebind.rs::next_associated_frame_for_session`.
async fn next_associated_frame_for_session(
    ws: &mut TestWs,
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
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                        && value["sessionRef"]["sessionId"] == session_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated for {terminal_id}/{session_id} within 20s");
}

/// Write a `terminal.input` (Enter) through the WS door — the cob/codex
/// `note_possible_submit` seam feeds `note_fork_submit` on this exact shape.
/// Copied with attribution from `tests/common/mod.rs::send_input`.
async fn send_input(ws: &mut TestWs, terminal_id: &str, data: &str) {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": data,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
}

/// Await the duplicate `terminal.session.associated` for `session_id` that
/// the fixture's post-`thread/start` `thread/started` broadcast provokes (the
/// router re-adopts the SAME id — D-03 lets same-id through, the adopt tail
/// re-runs and re-emits the frame; `codex_resume_switch_rebind.rs`'s
/// `next_associated_frame_for_session` exists for exactly this duplicate),
/// then settle a fixed margin so the duplicate adopt's `watch_fork(A)`
/// RE-REGISTRATION (repoint codex_proxy_route.rs, awaited after the
/// broadcast within the same route task) has flushed. Each registration
/// re-snapshots the locator's `known_files`: a fork rollout written before
/// the LAST registration lands is swallowed into the snapshot and permanently
/// excluded — never rebinding (observed as a ~50% harness miss pre-fix).
async fn wait_for_duplicate_adopt_settle(ws: &mut TestWs, terminal_id: &str, session_id: &str) {
    let _dup =
        next_associated_frame_for_session(ws, terminal_id, session_id, "fork/dup-adopt").await;
    tokio::time::sleep(Duration::from_millis(500)).await;
}

/// Poll the sidecar store until the record owned by `terminal_id` carries a
/// `session_id`, returning it (`None` on deadline). The fan-out runs beside
/// the associated broadcast, so the record can lag by a few ms. Copied with
/// attribution from `codex_resume_switch_rebind.rs`.
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

/// The registry's `resume_session_id` for a terminal (meta probe). Copied
/// with attribution from `codex_resume_switch_rebind.rs`.
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

/// [`spawn_server`] variant with the disk fork lane live: a real
/// `CodexLocator` rooted at `codex_sessions_root` (the `<CODEX_HOME>/sessions`
/// tree), its 150 ms sweep (`spawn_codex_locator_sweep`), and the codex
/// proxy-event router (candidate → adopt arm → `watch_fork` registration).
async fn spawn_server_with_locator_and_proxy(
    codex_sessions_root: &std::path::Path,
) -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let codex_locator = Arc::new(CodexLocator::new(codex_sessions_root.to_path_buf()));

    let state = WsState {
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-reattach-e2e".to_string()),
        boot_id: Arc::new("boot-reattach-e2e".to_string()),
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![codex_cli_spec()]),
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
        codex_locator: Some(Arc::clone(&codex_locator)),
        activity: None,
        // `NoIndexProbe` answers Unknown ⇒ the resume-validation gate
        // proceeds (fail-open), the codex_session_ref_resume.rs handshake
        // convention.
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    // Install the proxy event channel and spawn the router task (the
    // candidate → identity routing lane — without it, RemoteProxyEvent::
    // Candidate is never consumed and no terminal.session.associated frame
    // is emitted). The sink is process-global and replace-per-call; only
    // this scenario's router task consumes it in this binary.
    let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
    set_codex_proxy_event_sink(proxy_tx);
    let _router_task =
        freshell_ws::codex_proxy_route::spawn_codex_proxy_router(state.clone(), proxy_rx);

    // Mirrors main.rs's sweep wiring; 150 ms is re-declared here because
    // main.rs's LOCATOR_SWEEP_INTERVAL is private to the server binary.
    freshell_ws::codex_association::spawn_codex_locator_sweep(
        state.clone(),
        Duration::from_millis(150),
    );

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

/// Disk-lane fork rebind must advance the durable sidecar record's
/// session_id: it is the restart-time claim key (`claim_for_session`).
#[test]
fn disk_fork_rebind_advances_the_sidecar_record() {
    reattach_rt().block_on(async {
        let _serial = test_lock().lock().await;
        install_global_manager();
        ensure_mcp_deps_resolvable();
        std::env::set_var("CODEX_CMD", codex_dispatcher());
        // DEV-0006 S5.e: unset = managed launch ON (the sidecar store only
        // exists in this lane).
        std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

        // Temp CODEX_HOME — the disk fork lane's sessions root.
        let codex_home = tempfile::tempdir().expect("codex home");
        std::env::set_var("CODEX_HOME", codex_home.path());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");

        const A: &str = "thread-a";
        // UUID-shaped: the disk lane's identity probe hard-gates on
        // `is_uuid_shaped` (the proxy candidate path doesn't, so A can keep
        // the readable label).
        const B: &str = "019fa613-bbb1-4ccc-8ddd-00000000000b";
        let cwd = scenario_cwd("forksidecar").to_string_lossy().to_string();

        // Pre-write A's rollout (the fixture echoes its path via
        // threadStartRolloutPath); the fork watch's registration-time
        // snapshot then captures it as known — only NEW files are fork
        // candidates.
        let rollout_a = canonical_rollout_path(codex_home.path(), A);
        write_session_meta(&rollout_a, A, &cwd);
        std::env::set_var(
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            json!({
                "threadStartThreadId": A,
                "threadStartRolloutPath": rollout_a.to_string_lossy(),
            })
            .to_string(),
        );

        // Empty reconciler: the claim finds nothing and the selection falls
        // through to the fresh-spawn path (the sidecar under test).
        let (_store_dir, store, reconciler) = empty_reconciler();
        swap_test_reconciler(Some(reconciler), Some(store.clone()));
        // Set the process-global sidecar store so the SPAWNED runtime writes
        // durable records into this test's store — without this,
        // `SpawnedCodexAppServerRuntime::new()` resolves a disabled store and
        // note_session_id is a no-op (the codex_resume_switch_rebind.rs
        // convention).
        set_codex_sidecar_store(store.clone());

        let sessions_root = codex_home.path().join("sessions");
        let (ws_url, registry) = spawn_server_with_locator_and_proxy(&sessions_root).await;
        let mut ws = connect_and_handshake(&ws_url).await;

        let capture = capture_path("forkbind");
        std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);
        let terminal_id = create_codex_terminal(&mut ws, "req-forkbind", &cwd).await;

        // 1. Bind A through the proxy: TUI thread/start with the behavior
        //    knobs (the adopt arm registers watch_fork(A) + note_session_id(A)).
        let argv = wait_for_captured_argv(&capture);
        assert_eq!(argv[0], "--remote", "argv: {argv:?}");
        let proxy_url = argv[1].clone();
        assert!(
            proxy_url.starts_with("ws://127.0.0.1:"),
            "the --remote URL must be the loopback proxy: {proxy_url}"
        );
        let start_reply = tui_thread_start_via_proxy(&proxy_url).await;
        assert!(
            start_reply.get("result").is_some(),
            "thread/start must succeed: {start_reply}"
        );
        let adopted =
            next_associated_frame_for_session(&mut ws, &terminal_id, A, "fork/bind-A").await;
        assert_eq!(
            adopted["sessionRef"]["sessionId"], A,
            "thread/start must adopt A: {adopted}"
        );
        // Pre-fork baseline: the adopt arm's note_session_id already put A in
        // the durable record, so the post-fork assertion below can only fail
        // on the fork lane's own gap.
        let record_before = poll_sidecar_session_id(&store, &terminal_id, Duration::from_secs(10));
        assert_eq!(
            record_before.as_deref(),
            Some(A),
            "the adopt arm must already note A in the sidecar record"
        );

        // 2. Simulate the in-TUI fork the DISK lane owns: await the duplicate
        //    thread/started re-adopt + settle (its watch re-registration
        //    re-snapshots known_files — a fork rollout written before the
        //    last registration lands is excluded forever), send a real Enter
        //    through the WS door (the Enter-anchored fork-scan window), then
        //    materialize the fork child rollout — id B, forked_from_id A,
        //    thread_source "user".
        wait_for_duplicate_adopt_settle(&mut ws, &terminal_id, A).await;
        send_input(&mut ws, &terminal_id, "\r").await;
        let rollout_b = sessions_root
            .join("2026")
            .join("07")
            .join("27")
            .join(format!("rollout-2026-07-27T12-05-00-{B}.jsonl"));
        write_fork_session_meta(&rollout_b, B, &cwd, A);

        // 3. Wait out the fork sweep tick: tick_forks → rebind_codex_identity
        //    moves the pane identity (the pre-existing lane behavior).
        let rebound =
            next_associated_frame_for_session(&mut ws, &terminal_id, B, "fork/rebind-B").await;
        assert_eq!(
            rebound["sessionRef"]["sessionId"], B,
            "the rebind must move the pane to the fork child: {rebound}"
        );
        assert_eq!(
            rebound["previousSessionId"], A,
            "the rebind must carry previousSessionId == A: {rebound}"
        );
        assert_eq!(
            registry_resume_id(&registry, &terminal_id).as_deref(),
            Some(B),
            "registry meta resume_session_id must follow the fork rebind to B"
        );

        // 4. Evidence for the gap under test, collected (non-panicking)
        //    BEFORE cleanup: the durable sidecar record — the restart-time
        //    `claim_for_session` key — must have advanced to B.
        let record_after = poll_sidecar_session_id(&store, &terminal_id, Duration::from_secs(10));

        // Cleanup: kill ONLY pids this test spawned.
        registry.kill(&terminal_id);
        let _ = poll_proxy_refused(&proxy_url, Duration::from_secs(8)).await;
        swap_test_reconciler(None, None);
        set_codex_sidecar_store(Arc::new(CodexSidecarStore::disabled()));
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
        std::env::remove_var("CODEX_HOME");

        assert_eq!(
            record_after.as_deref(),
            Some(B),
            "the fork lane's rebind must advance the sidecar record's session_id \
             to the new thread (the restart-time reattach key)"
        );
    });
}

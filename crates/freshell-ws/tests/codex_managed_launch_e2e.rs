//! DEV-0006 S5.e e2e legs: `terminal.create {mode:'codex'}` over the REAL Rust WS
//! server, capturing the spawned child argv. The managed-launch default is ON, so
//! the legs are inverted from the S4 shape:
//!
//! - **Default (`FRESHELL_CODEX_MANAGED_LAUNCH` unset)**: managed launch — the first
//!   four argv tokens are `--remote ws://127.0.0.1:<port> -c features.apps=false`,
//!   the app-server sidecar is spawned, the proxy is listening, and the relay works
//!   (a fake TUI dials the `--remote` URL and completes an `initialize` round-trip
//!   against the spawned fake app-server through the proxy).
//! - **Explicit `"0"` opt-out**: the plain-CLI argv — the bel notification pair, NO
//!   `--remote` (the retired G-X0 shape, now the opt-out shape).
//! - **Managed resume**: default (unset) + `resumeSessionId` — the managed `--remote`
//!   argv with the `resume <id>` pair riding LAST (the S5.e "resume golden" at the
//!   integration level — G-X2 already pins the resolver level).
//!
//! Host-gated `#[ignore]` (needs `node` + the repo's `node_modules/ws`), opt-in like
//! `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS`. It mutates process env (`CODEX_CMD`,
//! `FRESHELL_CODEX_MANAGED_LAUNCH`, `CODEX_ARGV_CAPTURE_PATH`) and the codex launch
//! manager is a process-global singleton, so run it alone:
//!
//! ```sh
//! cargo test -p freshell-ws --test codex_managed_launch_e2e -- --ignored --test-threads=1
//! ```
//!
//! Loopback ephemeral ports only — never 3001/3002.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "e2e-codex-managed-launch-token";
const RECV_TIMEOUT: Duration = Duration::from_secs(20);
const SYNTHETIC_FRESHELL_TOKEN: &str = "synthetic-managed-codex-context-token";
const FRESHELL_CONTEXT_ENV_KEYS: [&str; 6] = [
    "FRESHELL",
    "FRESHELL_URL",
    "FRESHELL_TOKEN",
    "FRESHELL_TERMINAL_ID",
    "FRESHELL_TAB_ID",
    "FRESHELL_PANE_ID",
];

/// The dispatcher and fake app-server intentionally capture only this
/// allowlisted process surface. Context values are synthetic test data and
/// assertions below never print either captured environment map.
#[derive(Deserialize)]
struct CapturedCodexProcess {
    argv: Vec<String>,
    env: BTreeMap<String, String>,
}

/// Restore the process-global test seam without ever formatting its values.
/// The fixture owns only synthetic context, but this keeps an ambient server
/// environment intact even when an assertion aborts the test early.
struct TestEnvRestore {
    values: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl TestEnvRestore {
    fn capture(keys: &[&'static str]) -> Self {
        Self {
            values: keys
                .iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect(),
        }
    }
}

impl Drop for TestEnvRestore {
    fn drop(&mut self) {
        for (key, value) in self.values.drain(..) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

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
/// `cli_launch_goldens.rs::specs()`), so the resolver takes the REAL codex branch
/// (notification pair, `--remote` when a proxy URL is present, `CODEX_CMD` override).
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

/// Write the node dispatcher that plays BOTH codex roles:
/// - argv contains `app-server` → run the committed fake app-server fixture
///   (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`) — the sidecar.
/// - otherwise (the TUI launch) → dump complete argv plus only the six allowed
///   Freshell environment fields to `$CODEX_ARGV_CAPTURE_PATH`, then stay alive
///   so the pane keeps running until the test kills it.
fn write_codex_dispatcher() -> std::path::PathBuf {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .expect("fake-app-server fixture exists");
    let dispatcher = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-dispatcher-{}.mjs",
        std::process::id()
    ));
    let script = format!(
        "#!/usr/bin/env node\n\
         import fs from 'node:fs'\n\
         const args = process.argv.slice(2)\n\
         if (args.includes('app-server')) {{\n\
           await import('file://{fixture}')\n\
         }} else {{\n\
           fs.writeFileSync(process.env.CODEX_ARGV_CAPTURE_PATH, JSON.stringify({{\n\
             argv: args,\n\
             env: {{\n\
               FRESHELL: process.env.FRESHELL,\n\
               FRESHELL_URL: process.env.FRESHELL_URL,\n\
               FRESHELL_TOKEN: process.env.FRESHELL_TOKEN,\n\
               FRESHELL_TERMINAL_ID: process.env.FRESHELL_TERMINAL_ID,\n\
               FRESHELL_TAB_ID: process.env.FRESHELL_TAB_ID,\n\
               FRESHELL_PANE_ID: process.env.FRESHELL_PANE_ID,\n\
             }},\n\
           }}))\n\
           setInterval(() => undefined, 1000)\n\
         }}\n",
        fixture = fixture.display()
    );
    std::fs::write(&dispatcher, script).expect("write dispatcher");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dispatcher).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dispatcher, perms).unwrap();
    }
    dispatcher
}

async fn spawn_server() -> (
    String,
    freshell_terminal::TerminalRegistry,
    freshell_ws::WsState,
) {
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
        server_instance_id: Arc::new("srv-e2e".to_string()),
        boot_id: Arc::new("boot-e2e".to_string()),
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
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, state)
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

/// Create a codex terminal and return the `terminal.created` frame (or the `error`
/// frame, panicking with it for diagnosis).
async fn create_codex_terminal(
    ws: &mut TestWs,
    request_id: &str,
    cwd: &str,
    tab_id: Option<&str>,
    pane_id: Option<&str>,
) -> serde_json::Value {
    let mut create = json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "cwd": cwd,
    });
    if let Some(tab_id) = tab_id {
        create["tabId"] = json!(tab_id);
    }
    if let Some(pane_id) = pane_id {
        create["paneId"] = json!(pane_id);
    }
    ws.send(WsMessage::Text(create.to_string()))
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

/// Create a codex terminal with a `sessionRef` (the canonical WS-path resume
/// carrier, same shape as `codex_session_ref_resume.rs`'s create message) and
/// return the `terminal.created` frame (or the `error` frame, panicking with it
/// for diagnosis).
async fn create_codex_terminal_resume(
    ws: &mut TestWs,
    request_id: &str,
    cwd: &str,
    resume_session_id: &str,
) -> serde_json::Value {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "codex",
            "shell": "system",
            "cwd": cwd,
            "restore": true,
            "sessionRef": { "provider": "codex", "sessionId": resume_session_id },
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

/// Poll a dispatcher or fake-app-server capture until it appears.
fn wait_for_captured_process(path: &std::path::Path) -> CapturedCodexProcess {
    let deadline = std::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return serde_json::from_str(&raw).expect("captured process is JSON");
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

fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    wait_for_captured_process(path).argv
}

fn resume_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "resume" && w[1] == session_id)
}

/// Extract each complete Codex `-c` pair that configures the Freshell MCP
/// server. Keeping the flag with its value protects ordering checks below.
fn freshell_mcp_pairs(argv: &[String]) -> Vec<(String, String)> {
    argv.windows(2)
        .filter(|pair| pair[0] == "-c" && pair[1].starts_with("mcp_servers.freshell."))
        .map(|pair| (pair[0].clone(), pair[1].clone()))
        .collect()
}

fn managed_env_vars_config() -> String {
    let names = freshell_platform::mcp_inject::FRESHELL_MCP_CONTEXT_ENV_VARS
        .iter()
        .map(|name| format!("{name:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("mcp_servers.freshell.env_vars=[{names}]")
}

fn mcp_recipe_pairs(pairs: &[(String, String)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .filter(|(_, value)| {
            value.starts_with("mcp_servers.freshell.command=")
                || value.starts_with("mcp_servers.freshell.args=")
        })
        .cloned()
        .collect()
}

fn assert_spawned_pair_parity(
    tui: &CapturedCodexProcess,
    sidecar: &CapturedCodexProcess,
    expected_terminal_id: &str,
    expected_tab_id: Option<&str>,
    expected_pane_id: Option<&str>,
) {
    let tui_pairs = freshell_mcp_pairs(&tui.argv);
    let sidecar_pairs = freshell_mcp_pairs(&sidecar.argv);
    let expected_env_vars = managed_env_vars_config();

    for pairs in [&tui_pairs, &sidecar_pairs] {
        assert!(
            pairs
                .iter()
                .any(|(flag, value)| flag == "-c" && value == &expected_env_vars),
            "managed Freshell MCP config must include the exact static env_vars pair"
        );
    }

    let tui_recipe = mcp_recipe_pairs(&tui_pairs);
    let sidecar_recipe = mcp_recipe_pairs(&sidecar_pairs);
    assert!(
        !tui_recipe.is_empty() && tui_recipe == sidecar_recipe,
        "the TUI and newly spawned app-server must receive the same Freshell MCP command recipe"
    );

    let app_server_index = sidecar
        .argv
        .iter()
        .position(|arg| arg == "app-server")
        .expect("sidecar argv includes app-server");
    assert!(
        sidecar
            .argv
            .windows(2)
            .enumerate()
            .filter(|(_, pair)| pair[0] == "-c")
            .all(|(index, _)| index < app_server_index),
        "all sidecar configuration pairs must precede app-server"
    );

    let expected_keys = FRESHELL_CONTEXT_ENV_KEYS
        .iter()
        .copied()
        .filter(|key| match *key {
            "FRESHELL_TAB_ID" => expected_tab_id.is_some(),
            "FRESHELL_PANE_ID" => expected_pane_id.is_some(),
            _ => true,
        })
        .collect::<Vec<_>>();
    assert!(
        tui.env == sidecar.env
            && tui.env.len() == expected_keys.len()
            && expected_keys.iter().all(|key| tui.env.contains_key(*key)),
        "the TUI and newly spawned app-server must have equal allowlisted Freshell environments"
    );
    for capture in [tui, sidecar] {
        assert!(
            capture
                .env
                .get("FRESHELL_TERMINAL_ID")
                .is_some_and(|id| id == expected_terminal_id),
            "the spawned pair must receive the created terminal id"
        );
        match expected_tab_id {
            Some(tab_id) => assert!(
                capture
                    .env
                    .get("FRESHELL_TAB_ID")
                    .is_some_and(|id| id == tab_id),
                "the spawned pair must receive the requested tab id"
            ),
            None => assert!(
                !capture.env.contains_key("FRESHELL_TAB_ID"),
                "headless replacement launches intentionally omit tab id"
            ),
        }
        match expected_pane_id {
            Some(pane_id) => assert!(
                capture
                    .env
                    .get("FRESHELL_PANE_ID")
                    .is_some_and(|id| id == pane_id),
                "the spawned pair must receive the requested pane id"
            ),
            None => assert!(
                !capture.env.contains_key("FRESHELL_PANE_ID"),
                "headless replacement launches intentionally omit pane id"
            ),
        }
    }

    for argv in [&tui.argv, &sidecar.argv] {
        assert!(
            !argv
                .iter()
                .any(|arg| arg.contains(SYNTHETIC_FRESHELL_TOKEN)),
            "synthetic Freshell token must never be serialized into argv"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "host-gated e2e (needs node + repo node_modules); mutates process env — run alone with --ignored --test-threads=1"]
async fn codex_terminal_create_argv_default_managed_and_flag_zero_optout() {
    let _environment = TestEnvRestore::capture(&[
        "AUTH_TOKEN",
        "CODEX_ARGV_CAPTURE_PATH",
        "CODEX_CMD",
        "FAKE_CODEX_APP_SERVER_ARG_LOG",
        "FRESHELL_CODEX_MANAGED_LAUNCH",
        "FRESHELL_URL",
        "PORT",
    ]);
    let dispatcher = write_codex_dispatcher();
    let tmp_cwd = std::env::temp_dir().join(format!("freshell-codex-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_cwd).unwrap();
    std::env::set_var("CODEX_CMD", &dispatcher);
    std::env::set_var("PORT", "23123");
    std::env::set_var("FRESHELL_URL", "http://127.0.0.1:23123");
    std::env::set_var("AUTH_TOKEN", SYNTHETIC_FRESHELL_TOKEN);
    // DEV-0006 S5.e: the managed-launch default is ON, so "unset" IS the managed
    // leg. (Phase 1 is the default; Phase 2 opts out with "0"; Phase 3 resumes
    // under the default.)
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    let (ws_url, registry, state) = spawn_server().await;
    let mut ws = connect_and_handshake(&ws_url).await;

    // ── Phase 1: default (unset) must plan the managed launch (--remote 4-tuple
    // ── + live relay) ─────────────────────────────────────────────────────────────
    let default_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-default-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&default_capture);
    let default_sidecar_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-sidecar-default-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&default_sidecar_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &default_capture);
    std::env::set_var("FAKE_CODEX_APP_SERVER_ARG_LOG", &default_sidecar_capture);

    let created = create_codex_terminal(
        &mut ws,
        "req-default",
        tmp_cwd.to_str().unwrap(),
        Some("tab-e2e-fresh"),
        Some("pane-e2e-fresh"),
    )
    .await;
    let default_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let default_tui = wait_for_captured_process(&default_capture);
    let default_sidecar = wait_for_captured_process(&default_sidecar_capture);
    let default_argv = &default_tui.argv;

    assert_spawned_pair_parity(
        &default_tui,
        &default_sidecar,
        &default_terminal_id,
        Some("tab-e2e-fresh"),
        Some("pane-e2e-fresh"),
    );

    // The first four tokens (terminal-registry.ts:295-307; DEV-0006 live capture).
    assert_eq!(default_argv[0], "--remote", "argv: {default_argv:?}");
    let remote_ws_url = default_argv[1].clone();
    assert!(
        remote_ws_url.starts_with("ws://127.0.0.1:"),
        "the --remote URL must be the loopback proxy: {remote_ws_url}"
    );
    assert_eq!(
        &default_argv[2..4],
        &["-c".to_string(), "features.apps=false".to_string()]
    );
    // The bel notification pair still follows (byte order per G-X1).
    assert_eq!(
        &default_argv[4..6],
        &["-c".to_string(), "tui.notification_method=bel".to_string()],
        "argv: {default_argv:?}"
    );

    // The proxy accepts a TUI connection and relays to the spawned fake app-server:
    // a real initialize round-trip proves sidecar alive + proxy listening + relay.
    let (mut tui, _) = tokio_tungstenite::connect_async(&remote_ws_url)
        .await
        .expect("fake TUI dials the --remote proxy URL");
    tui.send(WsMessage::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).to_string(),
    ))
    .await
    .unwrap();
    let reply = loop {
        let msg = tokio::time::timeout(RECV_TIMEOUT, tui.next())
            .await
            .expect("initialize reply through the proxy within timeout")
            .expect("proxy stream open")
            .unwrap();
        if let WsMessage::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            if value.get("id") == Some(&json!(1)) {
                break value;
            }
        }
    };
    assert!(
        reply.get("result").is_some(),
        "initialize through the relay failed: {reply}"
    );
    // Kill the pane; the exit hook tears the managed launch down.
    registry.kill(&default_terminal_id);

    // ── Phase 2: explicit "0" must keep the plain-CLI shape (opt-out) ─────────────
    let off_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-off-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&off_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &off_capture);
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");

    let created =
        create_codex_terminal(&mut ws, "req-off", tmp_cwd.to_str().unwrap(), None, None).await;
    let off_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let off_argv = wait_for_captured_argv(&off_capture);

    assert!(
        !off_argv.iter().any(|a| a == "--remote"),
        "explicit \"0\" must launch the plain CLI (no --remote): {off_argv:?}"
    );
    assert_eq!(
        &off_argv[0..2],
        &["-c".to_string(), "tui.notification_method=bel".to_string()],
        "explicit \"0\" argv must keep the plain-CLI shape (retired G-X0): {off_argv:?}"
    );
    assert!(
        !freshell_mcp_pairs(&off_argv)
            .iter()
            .any(|(_, value)| value == &managed_env_vars_config()),
        "explicit opt-out must not add the managed-sidecar-only env_vars configuration"
    );
    registry.kill(&off_terminal_id);

    // ── Phase 3: managed resume — default (unset) + resumeSessionId; the resume
    // ── pair rides LAST (the S5.e resume golden at the integration level) ─────────
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");
    let resume_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-resume-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&resume_capture);
    let resume_sidecar_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-sidecar-resume-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&resume_sidecar_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &resume_capture);
    std::env::set_var("FAKE_CODEX_APP_SERVER_ARG_LOG", &resume_sidecar_capture);

    let created = create_codex_terminal_resume(
        &mut ws,
        "req-resume",
        tmp_cwd.to_str().unwrap(),
        "thread-e2e-resume",
    )
    .await;
    let resume_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let resume_tui = wait_for_captured_process(&resume_capture);
    let resume_sidecar = wait_for_captured_process(&resume_sidecar_capture);
    let resume_argv = &resume_tui.argv;
    assert_spawned_pair_parity(
        &resume_tui,
        &resume_sidecar,
        &resume_terminal_id,
        None,
        None,
    );
    assert_eq!(
        resume_argv[0], "--remote",
        "managed resume argv: {resume_argv:?}"
    );
    assert_eq!(
        &resume_argv[2..4],
        &["-c".to_string(), "features.apps=false".to_string()]
    );
    // The resume pair rides LAST (G-X2's resolver shape, now pinned live).
    let position = resume_pair_position(&resume_argv, "thread-e2e-resume")
        .expect("managed resume argv must contain `resume thread-e2e-resume`");
    assert_eq!(
        position + 2,
        resume_argv.len(),
        "resume pair must be last: {resume_argv:?}"
    );
    registry.kill(&resume_terminal_id);

    // ── Phase 4: headless auto-resume gets a newly spawned managed pair, but
    // ── intentionally has no layout ids ─────────────────────────────────────────
    let auto_resume_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-auto-resume-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&auto_resume_capture);
    let auto_resume_sidecar_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-sidecar-auto-resume-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&auto_resume_sidecar_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &auto_resume_capture);
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_ARG_LOG",
        &auto_resume_sidecar_capture,
    );

    let auto_resume_terminal_id = freshell_ws::terminal::respawn_agent_terminal(
        &state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "codex".into(),
            provider: "codex".into(),
            session_id: "thread-e2e-auto-resume".into(),
            create_request_id: "req-auto-resume".into(),
            cwd: Some(tmp_cwd.to_string_lossy().into_owned()),
        },
    )
    .await
    .expect("managed Codex auto-resume spawn");
    let auto_resume_tui = wait_for_captured_process(&auto_resume_capture);
    let auto_resume_sidecar = wait_for_captured_process(&auto_resume_sidecar_capture);
    let auto_resume_argv = &auto_resume_tui.argv;
    assert_spawned_pair_parity(
        &auto_resume_tui,
        &auto_resume_sidecar,
        &auto_resume_terminal_id,
        None,
        None,
    );
    assert!(
        resume_pair_position(auto_resume_argv, "thread-e2e-auto-resume").is_some(),
        "auto-resume argv must retain the Codex resume pair: {auto_resume_argv:?}"
    );
    registry.kill(&auto_resume_terminal_id);

    // ── Cleanup ───────────────────────────────────────────────────────────────────
    // `_environment` restores all process-global test seams on scope exit.
}

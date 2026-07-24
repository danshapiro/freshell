//! DEV-0006 S4 e2e leg (spec §5 "e2e leg (one)"): `terminal.create {mode:'codex'}` over
//! the REAL Rust WS server, capturing the spawned child argv.
//!
//! - **Flag ON** (`FRESHELL_CODEX_MANAGED_LAUNCH=1`): the first four argv tokens are
//!   `--remote ws://127.0.0.1:<port> -c features.apps=false`, the app-server sidecar is
//!   spawned, the proxy is listening, and the relay works (a fake TUI dials the
//!   `--remote` URL and completes an `initialize` round-trip against the spawned fake
//!   app-server through the proxy).
//! - **Flag OFF control**: today's argv — the bel notification pair, NO `--remote`
//!   (the shipped DEV-0006 deviation shape, golden G-X0).
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

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "e2e-codex-managed-launch-token";
const RECV_TIMEOUT: Duration = Duration::from_secs(20);

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
/// - otherwise (the TUI launch) → dump argv JSON to `$CODEX_ARGV_CAPTURE_PATH` and stay
///   alive so the pane keeps running until the test kills it.
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
           fs.writeFileSync(process.env.CODEX_ARGV_CAPTURE_PATH, JSON.stringify(args))\n\
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

async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-e2e".to_string()),
        boot_id: Arc::new("boot-e2e".to_string()),
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
        cli_commands: Arc::new(vec![codex_cli_spec()]),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
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

/// Create a codex terminal and return the `terminal.created` frame (or the `error`
/// frame, panicking with it for diagnosis).
async fn create_codex_terminal(ws: &mut TestWs, request_id: &str, cwd: &str) -> serde_json::Value {
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
                    return value;
                }
                Some("error") => panic!("terminal.create failed: {value}"),
                _ => {}
            }
        }
    }
}

/// Poll the capture file the dispatcher writes until it appears, then parse the argv.
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

#[tokio::test(flavor = "multi_thread")]
#[ignore = "host-gated e2e (needs node + repo node_modules); mutates process env — run alone with --ignored --test-threads=1"]
async fn codex_terminal_create_argv_flag_off_control_and_flag_on_managed_launch() {
    let dispatcher = write_codex_dispatcher();
    let tmp_cwd = std::env::temp_dir().join(format!("freshell-codex-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&tmp_cwd).unwrap();
    std::env::set_var("CODEX_CMD", &dispatcher);
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    let (ws_url, registry) = spawn_server().await;
    let mut ws = connect_and_handshake(&ws_url).await;

    // ── Phase 1: flag OFF control — today's argv, no --remote (G-X0 shape) ────────
    let off_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-off-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&off_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &off_capture);

    let created = create_codex_terminal(&mut ws, "req-off", tmp_cwd.to_str().unwrap()).await;
    let off_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let off_argv = wait_for_captured_argv(&off_capture);

    assert!(
        !off_argv.iter().any(|a| a == "--remote"),
        "flag OFF must launch the plain CLI (no --remote): {off_argv:?}"
    );
    assert_eq!(
        &off_argv[0..2],
        &["-c".to_string(), "tui.notification_method=bel".to_string()],
        "flag OFF argv must keep today's shape (G-X0): {off_argv:?}"
    );
    registry.kill(&off_terminal_id);

    // ── Phase 2: flag ON — managed launch (--remote 4-tuple + live relay) ─────────
    let on_capture = std::env::temp_dir().join(format!(
        "freshell-codex-e2e-argv-on-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&on_capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &on_capture);
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "1");

    let created = create_codex_terminal(&mut ws, "req-on", tmp_cwd.to_str().unwrap()).await;
    let on_terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let on_argv = wait_for_captured_argv(&on_capture);

    // The first four tokens (terminal-registry.ts:295-307; DEV-0006 live capture).
    assert_eq!(on_argv[0], "--remote", "argv: {on_argv:?}");
    let remote_ws_url = on_argv[1].clone();
    assert!(
        remote_ws_url.starts_with("ws://127.0.0.1:"),
        "the --remote URL must be the loopback proxy: {remote_ws_url}"
    );
    assert_eq!(
        &on_argv[2..4],
        &["-c".to_string(), "features.apps=false".to_string()]
    );
    // The bel notification pair still follows (byte order per G-X1).
    assert_eq!(
        &on_argv[4..6],
        &["-c".to_string(), "tui.notification_method=bel".to_string()],
        "argv: {on_argv:?}"
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

    // ── Cleanup: kill the pane; the exit hook tears the managed launch down ───────
    registry.kill(&on_terminal_id);
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
    std::env::remove_var("CODEX_CMD");
}

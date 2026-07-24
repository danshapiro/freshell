//! REGRESSION (2026-07-22 incident: "codex tabs lose their sessions on every
//! server restart"): the WS `terminal.create` resume derivation treated codex
//! SPECIALLY -- it read ONLY `create.resumeSessionId` and never consulted
//! `create.sessionRef`. The frozen client (post-Jul-20 rework) carries terminal
//! identity ONLY in `sessionRef` (`TerminalView.tsx:2782-2795`'s `sendCreate`
//! has no `resumeSessionId` field), so every codex create -- bounce restores
//! AND sidebar reopens -- spawned plain `codex` with no resume args, while
//! amplifier panes on the SAME client path (generic else-branch) resumed fine.
//!
//! Legacy parity anchor: `server/ws-handler.ts:2040-2047` derives the codex
//! resume id from the sessionRef too (via `planCodexCreateRestoreDecision`'s
//! `durable_session_ref_resume`), and the generic providers from
//! `requestedSessionRef.provider === mode ? sessionRef.sessionId :
//! m.resumeSessionId`.
//!
//! Three contracts, one process (this test mutates `CODEX_CMD` /
//! `CODEX_ARGV_CAPTURE_PATH`, so it runs as a single sequential test fn):
//!
//!   1. `sessionRef {provider:'codex', sessionId}` + `restore:true` -> the
//!      registry meta records the resume id AND the spawned argv contains
//!      `resume <id>` (FAILED before the fix -- the incident).
//!   2. `sessionRef` with a NON-matching provider -> NO resume (the
//!      provider==mode gate is preserved).
//!   3. Raw `resumeSessionId` (no sessionRef) -> still resumes (the legacy
//!      WS-path fallback is preserved).
//!
//! The fake codex is a plain `sh` script (no node dependency), so this runs in
//! the normal suite. Loopback ephemeral ports only -- never 3001/3002.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "e2e-codex-session-ref-resume-token";
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
/// `codex_managed_launch_e2e.rs`), so the resolver takes the REAL codex branch
/// (`resume_args: ["resume", "{{sessionId}}"]`, `CODEX_CMD` override).
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

/// Write a plain-`sh` fake codex: dump argv (one token per line, atomically via
/// tmp+mv) to `$CODEX_ARGV_CAPTURE_PATH`, then stay alive so the pane keeps
/// running until the test kills it.
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-session-ref-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
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
        server_instance_id: Arc::new("srv-codex-session-ref".to_string()),
        boot_id: Arc::new("boot-codex-session-ref".to_string()),
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
    // Drain the 4-frame handshake (ready -> settings.updated -> perf.logging ->
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

/// Send a `terminal.create` (extra fields merged in) and return the
/// `terminal.created` frame (panicking on an `error` frame for diagnosis).
async fn create_codex_terminal(
    ws: &mut TestWs,
    request_id: &str,
    extra: serde_json::Value,
) -> serde_json::Value {
    let mut msg = json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    if let (Some(base), Some(extra)) = (msg.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.create");
    loop {
        let frame = tokio::time::timeout(RECV_TIMEOUT, ws.next())
            .await
            .expect("terminal.created within timeout")
            .expect("stream open")
            .expect("no ws error");
        if let WsMessage::Text(text) = frame {
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

/// Poll the capture file the fake writes until it appears, then return the argv
/// tokens (one per line).
fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return raw.lines().map(str::to_string).collect();
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

fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|row| row.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

fn resume_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "resume" && w[1] == session_id)
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn codex_create_derives_resume_from_session_ref() {
    let fake = write_fake_codex();
    std::env::set_var("CODEX_CMD", &fake);
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    let (ws_url, registry) = spawn_server().await;
    let mut ws = connect_and_handshake(&ws_url).await;

    let capture_for = |phase: &str| {
        std::env::temp_dir().join(format!(
            "freshell-codex-session-ref-argv-{phase}-{}.txt",
            std::process::id()
        ))
    };

    // ── Phase 1 (THE incident shape): sessionRef {provider:'codex'} + restore
    // ── must resume. The frozen client's `sendCreate` carries identity ONLY
    // ── here -- no `resumeSessionId` field exists on that path.
    let session_id = "0199a3f2-codex-e2e-session";
    let capture = capture_for("session-ref");
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let created = create_codex_terminal(
        &mut ws,
        "req-session-ref",
        json!({
            "restore": true,
            "sessionRef": { "provider": "codex", "sessionId": session_id },
        }),
    )
    .await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    assert_eq!(
        registry_resume_id(&registry, &terminal_id).as_deref(),
        Some(session_id),
        "the registry meta must record the sessionRef-derived resume id \
         (incident 2026-07-22: this was None, so every codex bounce/reopen \
         spawned a fresh `codex`)"
    );
    let argv = wait_for_captured_argv(&capture);
    assert!(
        resume_pair_position(&argv, session_id).is_some(),
        "spawned codex argv must contain `resume {session_id}`: {argv:?}"
    );
    registry.kill(&terminal_id);

    // ── Phase 2: a sessionRef whose provider does NOT match the mode is
    // ── ignored (the provider==mode gate, `ws-handler.ts:2040-2047`).
    let capture = capture_for("wrong-provider");
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let created = create_codex_terminal(
        &mut ws,
        "req-wrong-provider",
        json!({
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": "claude-session-1" },
        }),
    )
    .await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    assert_eq!(
        registry_resume_id(&registry, &terminal_id),
        None,
        "a non-matching provider's sessionRef must NOT derive a codex resume id"
    );
    let argv = wait_for_captured_argv(&capture);
    assert!(
        !argv.iter().any(|a| a == "resume"),
        "no resume args for a non-matching sessionRef provider: {argv:?}"
    );
    registry.kill(&terminal_id);

    // ── Phase 3: the raw `resumeSessionId` fallback still works (legacy
    // ── accepts it on the WS path).
    let raw_id = "raw-resume-codex-1";
    let capture = capture_for("raw-resume");
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let created = create_codex_terminal(
        &mut ws,
        "req-raw-resume",
        json!({ "resumeSessionId": raw_id }),
    )
    .await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    assert_eq!(
        registry_resume_id(&registry, &terminal_id).as_deref(),
        Some(raw_id),
        "the raw resumeSessionId fallback must be preserved"
    );
    let argv = wait_for_captured_argv(&capture);
    assert!(
        resume_pair_position(&argv, raw_id).is_some(),
        "spawned codex argv must contain `resume {raw_id}`: {argv:?}"
    );
    registry.kill(&terminal_id);

    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
    std::env::remove_var("CODEX_CMD");
}

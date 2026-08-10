//! Plan-queue overflow -> RATE_LIMITED on the WS restore door (graceful
//! restore/resume S1, P2 backstop). Own binary: the installed global
//! manager here has concurrency 0 / queue cap 0 so the FIRST restore-class
//! plan overflows deterministically — restore_storm.rs's budget-2 manager
//! lives in a different process and can never collide with this installer.
//!
//! REAL axum server + REAL tokio-tungstenite client (the
//! restore_spawn_gate.rs harness convention).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::create_limit::CreateProtectConfig;
use freshell_ws::spawn_gate::SpawnGate;
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

/// A minimal always-present CLI spec (`/bin/sh` sleeper script) so non-shell
/// creates genuinely spawn — unique-per-call script path (counter beside the
/// pid), never the shared `{name}-{pid}` shape (the `1839b11e` ETXTBSY fix).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    static CALL: AtomicU64 = AtomicU64::new(0);
    let call = CALL.fetch_add(1, Ordering::SeqCst);
    let script_path = std::env::temp_dir().join(format!(
        "freshell-plan-queue-cap-sleeper-{name}-{pid}-{call}.sh",
        pid = std::process::id()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexec sleep 30\n").expect("write sleeper script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    freshell_platform::CliCommandSpec {
        name: name.to_string(),
        label: format!("{name}-label"),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Real server on an ephemeral loopback port with injectable protection
/// knobs. Returns (ws_url, registry, shutdown_notify, gate, shutdown_started).
async fn spawn_server(
    create_protect: CreateProtectConfig,
    gate: SpawnGate,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<SpawnGate>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let gate = std::sync::Arc::new(gate);
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let shutdown_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
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
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![
            sleeper_cli_spec("amplifier"),
            sleeper_cli_spec("claude"),
            sleeper_cli_spec("codex"),
        ]),
        shutdown: std::sync::Arc::clone(&shutdown),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect,
        spawn_gate: std::sync::Arc::clone(&gate),
        shutdown_started: std::sync::Arc::clone(&shutdown_started),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (
        format!("ws://{addr}/ws", addr = addr),
        registry,
        shutdown,
        gate,
        shutdown_started,
    )
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the handshake (`config_fallback` is None in
/// this harness, so the handshake is exactly 4 frames — the
/// `session_identity_frames.rs` convention).
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    // Nagle OFF on the test client: the two-creates-in-flight tests send
    // back-to-back small frames that must reach the server within the first
    // create's spawn-to-settled window; Nagle + delayed ACK on loopback
    // holds the second frame for ~3ms, longer than a whole settled create.
    if let tokio_tungstenite::MaybeTlsStream::Plain(stream) = ws.get_ref() {
        stream.set_nodelay(true).expect("set_nodelay");
    }
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

    for _ in 0..4u8 {
        let _ = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
    }
    ws
}

/// Send one text frame.
async fn send_text(ws: &mut TestWs, text: &str) {
    ws.send(WsMessage::Text(text.to_string()))
        .await
        .expect("send text frame");
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_json_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
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

/// `terminal.create` codex restore frame; identity rides in sessionRef (the
/// frozen client's shape — codex_session_ref_resume.rs precedent), so the
/// create derives a resume session id and is resume-planned PRE-GATE
/// (`LaunchClass::Restore`) — the plan queue is what this pin exercises.
fn codex_restore_frame(request_id: &str, session_id: &str) -> String {
    serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": session_id },
    })
    .to_string()
}

/// Fake codex runtime that must NEVER run: with concurrency 0 and queue cap
/// 0, the first restore-class plan overflows BEFORE any plan starts.
struct NeverRuntime {
    plans_started: Arc<AtomicU64>,
}

impl freshell_codex::launch_lifecycle::CodexLaunchRuntime for NeverRuntime {
    fn ensure_ready(
        &self,
        _cwd: Option<String>,
    ) -> freshell_codex::BoxFuture<
        '_,
        Result<freshell_codex::launch_lifecycle::CodexRuntimeReady, String>,
    > {
        self.plans_started.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Err("plan must never start under a 0/0 budget".to_string()) })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn plan_queue_overflow_maps_to_rate_limited_on_the_ws_restore_door() {
    // Install the 0-concurrency / 0-cap manager as THE process global; this
    // binary must be the first global() toucher in its process.
    let plans_started = Arc::new(AtomicU64::new(0));
    let factory_counter = Arc::clone(&plans_started);
    let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move || {
            Arc::new(NeverRuntime {
                plans_started: factory_counter.clone(),
            }) as Arc<dyn freshell_codex::launch_lifecycle::CodexLaunchRuntime>
        }),
        0,
        Duration::from_millis(50),
        0,
    );
    assert!(
        freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(manager),
        "queue-cap binary must be the first global() toucher in this process"
    );

    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // ONE codex restore create: the restore-class plan queue (cap 0)
    // overflows deterministically before any plan runs.
    let sid = uuid::Uuid::new_v4().to_string();
    send_text(&mut client, &codex_restore_frame("overflow-0", &sid)).await;

    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["requestId"], serde_json::json!("overflow-0"));
    assert_eq!(
        err["code"],
        serde_json::json!("RATE_LIMITED"),
        "plan-queue overflow must map to RATE_LIMITED (the ladder absorbs it): {err}"
    );

    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
    assert_eq!(
        plans_started.load(Ordering::SeqCst),
        0,
        "overflow happens BEFORE any plan runs — ensure_ready must never be called"
    );
}

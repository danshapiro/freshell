//! Shared integration-test harness for `freshell-ws` WS tests.
//!
//! Extracted verbatim from `attach_viewport_resize.rs` and
//! `session_identity_frames.rs`, whose harness sections were byte-identical
//! copies. Compiled into each test binary that declares `mod common;` —
//! helpers unused by a given binary are expected, hence the file-level
//! `dead_code` allow (the idiomatic pattern for `tests/common/mod.rs`).
#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

pub const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Launcher-assigned amplifier identity (F7/V9): tests that create
/// amplifier terminals now WRITE stub dirs into the amplifier home.
/// Isolate eagerly at this choke point so no test ever touches the real
/// `~/.amplifier`. `set_var` is process-global: use ONE shared value per
/// test process. Called by [`spawn_server_with_specs`] (the constructor
/// every existing amplifier-creating ws test flows through — V7) AND
/// directly by amplifier test files (defense in depth: 17 ws test files
/// build `WsState` inline and would silently bypass the constructor).
pub fn isolate_amplifier_home() -> std::path::PathBuf {
    static AMP_HOME: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    AMP_HOME
        .get_or_init(|| {
            let amp_home =
                std::env::temp_dir().join(format!("freshell-ws-amp-home-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&amp_home);
            std::env::set_var("FRESHELL_AMPLIFIER_HOME", &amp_home);
            amp_home
        })
        .clone()
}

pub fn test_settings_value() -> serde_json::Value {
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

/// A minimal always-present CLI spec (`/bin/sh` sleeper script) so a
/// `mode:"amplifier"` create genuinely spawns — the same recording-script
/// convention as `freshell-freshagent`'s Slice 3a tests, minus the argv file
/// (these tests assert on wire frames, not argv).
pub fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-identity-frames-sleeper-{name}-{}.sh",
        std::process::id()
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
        // Required for the fresh-claude preallocation path: `LaunchIntent::Start`
        // THROWS without `create_session_args` (`cli_launch.rs:436-441`), same
        // shape as the real claude spec (`cli_launch_goldens.rs:50`).
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Real axum server on an ephemeral loopback port, with an `amplifier` CLI
/// spec registered so resume creates spawn a real (sleeper) PTY. Returns the
/// ws URL + the shared registry (for cleanup kills).
pub async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    spawn_server_with_specs(vec![
        sleeper_cli_spec("amplifier"),
        sleeper_cli_spec("claude"),
    ])
    .await
}

#[allow(dead_code)] // not every test binary uses the injectable variant
pub async fn spawn_server_with_specs(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (String, freshell_terminal::TerminalRegistry) {
    // F7/V9 choke point: BEFORE anything can reach an amplifier create.
    let _ = isolate_amplifier_home();
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
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
        cli_commands: Arc::new(cli_commands),
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

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry)
}

/// [`spawn_server_with_specs`], additionally handing back the receiver half
/// of `WsState.auto_resume_tx` (Lane D1) so tests can drain the CrashEvents
/// the PTY exit hook sends — the "take_auto_resume_rx" accessor of this
/// free-function harness. Identical `WsState` otherwise.
pub async fn spawn_server_with_specs_and_auto_resume_rx(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    tokio::sync::mpsc::UnboundedReceiver<freshell_ws::auto_resume::CrashEvent>,
) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let (auto_resume_tx, auto_resume_rx) = tokio::sync::mpsc::unbounded_channel();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx,
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
        cli_commands: Arc::new(cli_commands),
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
        auto_resume_rx,
    )
}

/// [`spawn_server_with_specs`], with the auto-resume hub SPAWNED (Task 5) on
/// an injected backoff schedule. Delays ride the spawn helper — NOT the
/// `FRESHELL_AUTO_RESUME_DELAYS_MS` env — because the harness is in-process
/// and a `std::env::set_var` would leak across parallel tests in the same
/// binary. Task 2's event tests keep using
/// [`spawn_server_with_specs_and_auto_resume_rx`] (hub OFF, rx taken by the
/// test).
pub async fn spawn_server_with_specs_and_auto_resume_hub(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    delays: Vec<u64>,
) -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let (auto_resume_tx, auto_resume_rx) = tokio::sync::mpsc::unbounded_channel();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx,
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
        cli_commands: Arc::new(cli_commands),
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

    freshell_ws::auto_resume::spawn_auto_resume_hub_with_delays(
        state.clone(),
        auto_resume_rx,
        delays,
    );

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry)
}

/// [`spawn_server_with_specs`], additionally handing back a CLONE of the
/// `WsState` so tests can drive connection-independent server-side seams
/// directly (Task 4: `respawn_agent_terminal`). Identical `WsState`
/// otherwise (the state is `Clone`; the router gets its own clone).
pub async fn spawn_server_with_specs_and_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (String, freshell_terminal::TerminalRegistry, WsState) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
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
        cli_commands: Arc::new(cli_commands),
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

    (format!("ws://{addr}/ws", addr = addr), registry, state)
}

/// [`spawn_server_with_specs`], with a REAL pane ledger rooted at
/// `ledger_dir` (P1.8 tests). Two servers pointed at the same dir model a
/// restart. Returns the server's own `Arc<PaneLedger>` too: with the
/// write-through in-memory index (Task 1 / V1.md), only writes routed
/// through the SERVER'S instance are visible to its reads — tests that
/// seed or poll the live server's ledger must use this Arc, while
/// durability assertions may still construct fresh read-only instances
/// (whose construction-time scan sees whatever is on disk). Uses the
/// lock-free `PaneLedger::new` (the flock single-writer guard is a
/// production `main.rs` concern — `new_locked`).
pub async fn spawn_server_with_ledger(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_dir: &std::path::Path,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>,
) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let pane_ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
        ledger_dir.to_path_buf(),
    )));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::clone(&pane_ledger),
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
        cli_commands: Arc::new(cli_commands),
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
        pane_ledger,
    )
}

/// Activity-enabled variant of [`spawn_server_with_specs`]: identical body,
/// except a real `ActivityHub` is constructed, tapped into the registry, and
/// handed to `WsState` (mirroring `freshell-server/src/main.rs`). Kept as a
/// SEPARATE function -- the default harness's `activity: None` is
/// load-bearing for the frame-ordering assumptions of existing tests.
#[allow(dead_code)] // not every test binary uses the activity variant
pub async fn spawn_server_with_specs_and_activity(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let activity_hub =
        freshell_ws::activity::ActivityHub::new(std::sync::Arc::clone(&broadcast_tx), None);
    registry.set_activity_observer(activity_hub.registry_observer());

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
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
        cli_commands: Arc::new(cli_commands),
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
        activity: Some(activity_hub.clone()),
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

    (format!("ws://{addr}/ws", addr = addr), registry)
}

/// [`spawn_server_with_specs_and_activity`], with the codex rollout LOCATOR
/// wired and its sweep spawned (Lane B2: fresh codex panes gain identity
/// server-side with NO client candidate frame). Identical body except two
/// deltas: `codex_locator` is `Some(CodexLocator)` rooted at
/// `codex_sessions_root` (tests pass `<CODEX_HOME>/sessions` — the same root
/// `codex_sessions_root()` resolves in the real server), and the locator
/// sweep is spawned before the router.
#[allow(dead_code)] // not every test binary uses the codex-locator variant
pub async fn spawn_server_with_specs_activity_and_codex_locator(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    codex_sessions_root: &std::path::Path,
) -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let activity_hub =
        freshell_ws::activity::ActivityHub::new(std::sync::Arc::clone(&broadcast_tx), None);
    registry.set_activity_observer(activity_hub.registry_observer());

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
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
        cli_commands: Arc::new(cli_commands),
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
        codex_locator: Some(std::sync::Arc::new(
            freshell_sessions::codex_locator::CodexLocator::new(codex_sessions_root.to_path_buf()),
        )),
        activity: Some(activity_hub.clone()),
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    // Mirrors main.rs's sweep wiring; 150 ms is re-declared here because
    // main.rs's LOCATOR_SWEEP_INTERVAL is private to the server binary.
    freshell_ws::codex_association::spawn_codex_locator_sweep(
        state.clone(),
        std::time::Duration::from_millis(150),
    );
    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry)
}

/// [`spawn_server`] variant with injectable `terminal.create` protection
/// knobs (rate limit + spawn gate). Identical `WsState` otherwise; returns
/// only the ws URL (most create-protection tests never need the registry).
pub async fn spawn_server_with_create_protect(
    cfg: freshell_ws::create_limit::CreateProtectConfig,
) -> String {
    spawn_server_with_create_protect_probes(cfg).await.0
}

/// [`spawn_server_with_create_protect`] variant that also returns the
/// registry and the gate handle (mirrors `restore_spawn_gate.rs`'s
/// `spawn_server` return shape) so timeout-free restore-side gate pins can
/// probe `queued_total()`/`cancellations()` and registry emptiness
/// (graceful restore/resume S1: gate `Timeout` is unreachable for the
/// restore class, so those pins assert queue-until-cancel instead).
pub async fn spawn_server_with_create_protect_probes(
    cfg: freshell_ws::create_limit::CreateProtectConfig,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<freshell_ws::spawn_gate::SpawnGate>,
) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    // NOTE: SpawnGate::new passes 0 through (no sanitizing) — the
    // zero-permit test in create_protection.rs depends on this.
    // (`from_config` stayed behind when the gate moved to
    // freshell-freshagent; it referenced this crate's CreateProtectConfig.)
    let gate = std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(
        cfg.spawn_concurrency,
        cfg.spawn_queue_cap,
    ));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
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
        cli_commands: Arc::new(Vec::new()),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: cfg,
        spawn_gate: std::sync::Arc::clone(&gate),
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

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry, gate)
}

pub type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, returning the socket AND the parsed `terminal.inventory`
/// handshake frame (the 4th handshake message; `config_fallback` is None in
/// this harness, so the handshake is exactly 4 frames).
pub async fn connect_and_capture_inventory(url: &str) -> (TestWs, serde_json::Value) {
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

    let mut inventory = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("terminal.inventory") {
                inventory = value;
            }
        }
    }
    assert!(
        !inventory.is_null(),
        "handshake must contain terminal.inventory"
    );
    (ws, inventory)
}

pub async fn create_shell_terminal(ws: &mut TestWs, request_id: &str) -> String {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "shell",
            "shell": "system",
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.create");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.created")
                    && value.get("requestId").and_then(|v| v.as_str()) == Some(request_id)
                {
                    return value
                        .get("terminalId")
                        .and_then(|v| v.as_str())
                        .expect("terminal.created carries terminalId")
                        .to_string();
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected terminal.created, got {other:?}"),
        }
    }
    panic!("terminal.created never arrived");
}

/// Concatenate the `data` payload of every `terminal.output`/`terminal.output.batch`
/// frame seen until either `marker` appears in the accumulated text or the
/// deadline elapses. Returns `(accumulated_text, gap_seen, closed)`.
pub async fn drain_until_marker_or_deadline(
    ws: &mut TestWs,
    marker: &str,
    deadline: tokio::time::Instant,
) -> (String, bool, bool) {
    let mut acc = String::new();
    let mut gap_seen = false;
    let mut closed = false;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("terminal.output") | Some("terminal.output.batch") => {
                            if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                                acc.push_str(data);
                            }
                        }
                        Some("terminal.output.gap") => gap_seen = true,
                        _ => {}
                    }
                }
                if acc.contains(marker) {
                    break;
                }
            }
            Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) => {
                closed = true;
                break;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => {
                closed = true;
                break;
            }
            Err(_) => break, // timed out
        }
    }
    (acc, gap_seen, closed)
}

pub async fn attach_with(
    ws: &mut TestWs,
    terminal_id: &str,
    attach_request_id: &str,
    intent: &str,
    cols: u16,
    rows: u16,
    expected_session_ref: Option<serde_json::Value>,
) {
    let mut msg = serde_json::json!({
        "type": "terminal.attach",
        "terminalId": terminal_id,
        "intent": intent,
        "cols": cols,
        "rows": rows,
        "attachRequestId": attach_request_id,
    });
    if let Some(sr) = expected_session_ref {
        msg["expectedSessionRef"] = sr;
    }
    ws.send(WsMessage::Text(msg.to_string()))
        .await
        .expect("send terminal.attach");
}

pub async fn wait_for_attach_ready(ws: &mut TestWs, attach_request_id: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if value.get("type").and_then(|v| v.as_str()) == Some("terminal.attach.ready")
                    && value.get("attachRequestId").and_then(|v| v.as_str())
                        == Some(attach_request_id)
                {
                    return;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected terminal.attach.ready, got {other:?}"),
        }
    }
    panic!("terminal.attach.ready never arrived for {attach_request_id}");
}

pub async fn send_input(ws: &mut TestWs, terminal_id: &str, data: &str) {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "terminal.input",
            "terminalId": terminal_id,
            "data": data,
        })
        .to_string(),
    ))
    .await
    .expect("send terminal.input");
}

/// Read text frames until one with `type == wanted` arrives (bounded).
pub async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
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

/// Non-null `sessionRef` accessor (robust to both omitted-key and explicit
/// null serializations).
pub fn session_ref_of(frame: &serde_json::Value) -> Option<serde_json::Value> {
    match frame.get("sessionRef") {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => None,
    }
}

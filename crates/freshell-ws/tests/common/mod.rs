//! Shared integration-test harness for `freshell-ws` WS tests.
//!
//! Extracted verbatim from `attach_viewport_resize.rs` and
//! `session_identity_frames.rs`, whose harness sections were byte-identical
//! copies. Compiled into each test binary that declares `mod common;` —
//! helpers unused by a given binary are expected, hence the file-level
//! `dead_code` allow (the idiomatic pattern for `tests/common/mod.rs`).
#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

pub const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Frame-receive / poll budget for the WS e2e suites. DEFLAKE (the-usual
/// test-flake-hardening): `auto_resume_e2e` and `restore_spawn_gate` flaked at
/// 5–10s budgets only under heavy machine load (evidence: run-state receipts
/// of the 2026-09 host-pressure-pane run; f3wp prior art f2c505e9f). Assertions
/// are unchanged; only the wait budget grew — a genuinely missing frame still
/// fails, ~25s later.
pub const FRAME_BUDGET: Duration = Duration::from_secs(30);

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

/// CFG-12: the live handshake-settings handle for harness `WsState`s. Seeded
/// from the SAME fixture tree as the frozen `settings` field (clean-boot byte
/// parity), but independently mutable behind the lock: a test writing through
/// it changes what the NEXT `/ws` connection's handshake resolves — exactly
/// like a `PATCH /api/settings`-committed value in production, where
/// freshell-server wires `SettingsStore::shared_settings_lock()` into the
/// same slot (`crates/freshell-server/src/main.rs`).
pub fn handshake_settings_lock() -> Arc<tokio::sync::RwLock<freshell_protocol::ServerSettings>> {
    Arc::new(tokio::sync::RwLock::new(
        serde_json::from_value(test_settings_value()).expect("valid settings fixture"),
    ))
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
///
/// Each call writes a **unique** script path (PID + atomic counter) so parallel
/// tests in the same binary never collide with ETXTBSY ("Text file busy") when
/// one test writes the script while another is executing a prior copy.
static SLEEPER_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let seq = SLEEPER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let script_path = std::env::temp_dir().join(format!(
        "freshell-identity-frames-sleeper-{name}-{}-{seq}.sh",
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
        effort_args: None,
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

/// [`spawn_server_with_specs`], additionally handing back the LIVE
/// handshake-settings lock wired into `WsState.handshake_settings` (CFG-12),
/// so a test can mutate the tree between connections and assert what each
/// `/ws` handshake resolves. The frozen `settings` field is seeded
/// independently — mirroring prod, where create-time derivations stay
/// boot-scoped (CFG-06's separate boundary).
#[allow(dead_code)] // not every test binary uses the shared-settings variant
pub async fn spawn_server_with_specs_and_shared_settings(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<tokio::sync::RwLock<freshell_protocol::ServerSettings>>,
) {
    let _ = isolate_amplifier_home();
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let handshake_settings = handshake_settings_lock();
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
        handshake_settings: Arc::clone(&handshake_settings),
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
        ownership: None,
        units: Default::default(),
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
        handshake_settings,
    )
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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

// ── unified agent names (Task 2): the naming-wired harness ──────────────────

/// A store-mirror naming fake for the ws integration tests (the freshagent
/// crate has its own in-crate recording sink; test fakes cannot be shared
/// across crates): `ensure_pending` fabricates the directory-basename
/// fallback record, `bind_pending` transfers the accepted name (registering
/// the redirect), `get` follows redirects, and `rename` records its input
/// verbatim. The activity/observation/acquisition seams answer the current
/// record (their acceptance policy is the real store's own).
pub struct NamingProbeSink {
    pub renames: std::sync::Mutex<Vec<freshell_freshagent::naming::RenameNameInput>>,
    records: std::sync::Mutex<
        std::collections::HashMap<String, freshell_protocol::session_names::SessionNameRecord>,
    >,
    redirects: std::sync::Mutex<
        std::collections::HashMap<String, freshell_protocol::session_names::SessionNameRef>,
    >,
}

impl Default for NamingProbeSink {
    fn default() -> Self {
        Self {
            renames: std::sync::Mutex::new(Vec::new()),
            records: std::sync::Mutex::new(std::collections::HashMap::new()),
            redirects: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

fn name_key(target: &freshell_protocol::session_names::SessionNameRef) -> String {
    freshell_freshagent::naming::name_ref_debug_key(target)
}

impl NamingProbeSink {
    fn resolve(
        &self,
        target: &freshell_protocol::session_names::SessionNameRef,
    ) -> freshell_protocol::session_names::SessionNameRef {
        let redirects = self.redirects.lock().unwrap();
        redirects
            .get(&name_key(target))
            .cloned()
            .unwrap_or_else(|| target.clone())
    }

    fn record_of(
        &self,
        target: &freshell_protocol::session_names::SessionNameRef,
    ) -> Option<freshell_protocol::session_names::SessionNameRecord> {
        let resolved = self.resolve(target);
        self.records
            .lock()
            .unwrap()
            .get(&name_key(&resolved))
            .cloned()
    }

    fn update_for(
        &self,
        record: freshell_protocol::session_names::SessionNameRecord,
        changed: bool,
    ) -> freshell_protocol::session_names::SessionNameUpdate {
        freshell_protocol::session_names::SessionNameUpdate {
            redirects: Vec::new(),
            record,
            document_generation: 1,
            changed,
            native_sync: None,
        }
    }
}

impl freshell_freshagent::naming::SessionNaming for NamingProbeSink {
    fn get(
        &self,
        refs: Vec<freshell_protocol::session_names::SessionNameRef>,
    ) -> freshell_freshagent::naming::NameFuture<
        Vec<freshell_protocol::session_names::SessionNameUpdate>,
    > {
        let updates = refs
            .iter()
            .filter_map(|target| self.record_of(target).map(|r| self.update_for(r, false)))
            .collect();
        Box::pin(async move { Ok(updates) })
    }

    fn ensure_pending(
        &self,
        input: freshell_freshagent::naming::PendingNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        use freshell_protocol::session_names::{NameSource, SessionNameRef};
        let target = SessionNameRef::Pending {
            id: input.handle.clone(),
        };
        if let Some(existing) = self.record_of(&target) {
            let update = self.update_for(existing, false);
            return Box::pin(async move { Ok(update) });
        }
        let fallback = input
            .cwd
            .as_deref()
            .and_then(|cwd| {
                cwd.rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| input.provider.display_label().to_string());
        let record = freshell_protocol::session_names::SessionNameRecord {
            name_ref: target.clone(),
            name: fallback,
            source: NameSource::Directory,
            revision: 1,
            manual_revision: None,
            renamed_at: None,
            legacy_origin: None,
        };
        let update = self.update_for(record.clone(), true);
        self.records
            .lock()
            .unwrap()
            .insert(name_key(&target), record);
        Box::pin(async move { Ok(update) })
    }

    fn bind_pending(
        &self,
        input: freshell_freshagent::naming::BindNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        use freshell_protocol::native_location::NativePersistence;
        if input.acquisition.persistence != NativePersistence::Verified {
            return Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::IdentityAmbiguous(
                    "prospective evidence cannot bind".into(),
                ))
            });
        }
        let mut record = self.record_of(&input.pending).unwrap_or_else(|| {
            freshell_protocol::session_names::SessionNameRecord {
                name_ref: input.target.clone(),
                name: "bound".into(),
                source: freshell_protocol::session_names::NameSource::Directory,
                revision: 1,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            }
        });
        record.name_ref = input.target.clone();
        record.revision += 1;
        let update = self.update_for(record.clone(), true);
        self.redirects
            .lock()
            .unwrap()
            .insert(name_key(&input.pending), input.target);
        self.records
            .lock()
            .unwrap()
            .insert(name_key(&update.record.name_ref), record);
        Box::pin(async move { Ok(update) })
    }

    fn rename(
        &self,
        input: freshell_freshagent::naming::RenameNameInput,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        use freshell_protocol::session_names::{NameIntent, NameSource};
        self.renames.lock().unwrap().push(input.clone());
        let Some(mut record) = self.record_of(&input.target) else {
            return Box::pin(async move {
                Err(freshell_freshagent::naming::NameError::NotFound(format!(
                    "no naming record for {}",
                    freshell_freshagent::naming::name_ref_debug_key(&input.target)
                )))
            });
        };
        record.name = input.name.clone();
        record.source = if input.intent == NameIntent::User {
            NameSource::Manual
        } else {
            NameSource::ProviderAi
        };
        record.revision += 1;
        let update = self.update_for(record.clone(), true);
        self.records
            .lock()
            .unwrap()
            .insert(name_key(&record.name_ref), record);
        Box::pin(async move { Ok(update) })
    }

    fn activity(
        &self,
        input: freshell_freshagent::naming::NameActivity,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        let answer = match self.record_of(&input.target) {
            Some(record) => Ok(self.update_for(record, false)),
            None => Err(freshell_freshagent::naming::NameError::NotFound(
                "no record".into(),
            )),
        };
        Box::pin(async move { answer })
    }

    fn observe_native(
        &self,
        input: freshell_freshagent::naming::NativeNameObservation,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        let answer = match self.record_of(&input.target) {
            Some(record) => Ok(self.update_for(record, false)),
            None => Err(freshell_freshagent::naming::NameError::NotFound(
                "no record".into(),
            )),
        };
        Box::pin(async move { answer })
    }

    fn record_acquisition(
        &self,
        target: freshell_protocol::session_names::SessionNameRef,
        _acquisition: freshell_protocol::native_location::NativeAcquisition,
    ) -> freshell_freshagent::naming::NameFuture<freshell_protocol::session_names::SessionNameUpdate>
    {
        let answer = match self.record_of(&target) {
            Some(record) => Ok(self.update_for(record, false)),
            None => Err(freshell_freshagent::naming::NameError::NotFound(
                "no record".into(),
            )),
        };
        Box::pin(async move { answer })
    }
}

/// [`spawn_server_with_specs`] with the ONE naming authority wired into the
/// shared identity registry (and the fresh-agent state sinks) the way
/// `freshell-server`'s `main` wires the real store. Returns the sink so
/// tests can pre-seed records and inspect renames.
pub async fn spawn_server_with_specs_and_naming(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<NamingProbeSink>,
) {
    let _ = isolate_amplifier_home();
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let sink = Arc::new(NamingProbeSink::default());
    identity.set_session_naming(sink.clone());

    let state = WsState {
        ownership: None,
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity,
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: {
            let fresh_codex = freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            );
            fresh_codex.set_session_naming(sink.clone());
            fresh_codex
        },
        fresh_claude: {
            let fresh_claude =
                freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
            fresh_claude.set_session_naming(sink.clone());
            fresh_claude
        },
        fresh_opencode: {
            let fresh_opencode = freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(
                    Arc::clone(&auth_token),
                    Arc::clone(&broadcast_tx),
                ),
            );
            fresh_opencode.set_session_naming(sink.clone());
            fresh_opencode
        },
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
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
        units: Default::default(),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry, sink)
}
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
        handshake_settings: handshake_settings_lock(),
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
        subagent_interest: Default::default(),
        host_stats: Default::default(),
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
        ownership: None,
        units: Default::default(),
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
/// an injected backoff schedule, plus the harness-default identity-grace
/// schedule (`vec![25, 25]` — tiny, so a genuinely identity-less crashing
/// pane still exercises the grace path cheaply; claude-driven tests never
/// engage it because their preallocated identity is present at the crash
/// decision). Delays ride the spawn helper — NOT the
/// `FRESHELL_AUTO_RESUME_DELAYS_MS` env — because the harness is in-process
/// and a `std::env::set_var` would leak across parallel tests in the same
/// binary. Task 2's event tests keep using
/// [`spawn_server_with_specs_and_auto_resume_rx`] (hub OFF, rx taken by the
/// test). Thin wrapper over [`spawn_server_with_specs_hub_and_state`]
/// dropping the returned state.
pub async fn spawn_server_with_specs_and_auto_resume_hub(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    delays: Vec<u64>,
) -> (String, freshell_terminal::TerminalRegistry) {
    let (url, registry, _state) =
        spawn_server_with_specs_hub_and_state(cli_commands, delays, vec![25, 25]).await;
    (url, registry)
}

/// [`spawn_server_with_specs`], with the auto-resume hub SPAWNED on injected
/// backoff AND identity-grace schedules (kata kmbs, Task 2), additionally
/// handing back a CLONE of the `WsState` (the
/// [`spawn_server_with_specs_and_state`] precedent) so tests can drive
/// connection-independent server-side seams directly — the grace-success e2e
/// upserts `state.identity` mid-grace. Same env-leak rationale as above.
pub async fn spawn_server_with_specs_hub_and_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    delays: Vec<u64>,
    identity_grace_delays: Vec<u64>,
) -> (String, freshell_terminal::TerminalRegistry, WsState) {
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
        handshake_settings: handshake_settings_lock(),
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
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(cli_commands),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        ping_interval_ms: 30_000,
        // DEFLAKE-keep (the-usual test-flake-hardening): the server-side hello
        // timeout stays 5s — no evidence it fired in the load flakes (2026-09
        // host-pressure-pane receipts); a separate door from the widened
        // client-side read budgets (see FRAME_BUDGET).
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
        ownership: None,
        units: Default::default(),
    };

    freshell_ws::auto_resume::spawn_auto_resume_hub_with_schedules(
        state.clone(),
        auto_resume_rx,
        delays,
        identity_grace_delays,
    );

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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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

/// [`spawn_server_with_ledger`], additionally handing back a CLONE of the
/// `WsState` (the `spawn_server_with_specs_and_state` pattern) so tests can
/// assert server-side surfaces the WS frames alone don't expose — e.g. the
/// in-memory identity registry's `session_ref_for` resolution after a kill
/// (the wedge-backstop stuck-recovery kill tests). Identical `WsState`
/// otherwise (the state is `Clone`; the router gets its own clone).
pub async fn spawn_server_with_ledger_and_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_dir: &std::path::Path,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>,
    WsState,
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
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
        state,
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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

/// [`spawn_server_with_specs_activity_and_codex_locator`], additionally
/// wiring the ONE `NamingProbeSink` naming authority into the identity
/// registry and the fresh states (the `spawn_server_with_specs_and_naming`
/// composition) and returning it — the unified-agent-names lane tests drive
/// the real CLI identity-transition lanes against a naming authority they can
/// seed and inspect.
#[allow(dead_code)] // not every test binary uses the naming+locator variant
pub async fn spawn_server_with_specs_activity_codex_locator_and_naming(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    codex_sessions_root: &std::path::Path,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<NamingProbeSink>,
    WsState,
) {
    let _ = isolate_amplifier_home();
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let sink = Arc::new(NamingProbeSink::default());
    identity.set_session_naming(sink.clone());

    let activity_hub =
        freshell_ws::activity::ActivityHub::new(std::sync::Arc::clone(&broadcast_tx), None);
    registry.set_activity_observer(activity_hub.registry_observer());

    let state = WsState {
        ownership: None,
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity,
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: {
            let fresh_codex = freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            );
            fresh_codex.set_session_naming(sink.clone());
            fresh_codex
        },
        fresh_claude: {
            let fresh_claude =
                freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
            fresh_claude.set_session_naming(sink.clone());
            fresh_claude
        },
        fresh_opencode: {
            let fresh_opencode = freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(
                    Arc::clone(&auth_token),
                    Arc::clone(&broadcast_tx),
                ),
            );
            fresh_opencode.set_session_naming(sink.clone());
            fresh_opencode
        },
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
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
        units: Default::default(),
    };

    // Mirrors main.rs's sweep wiring; 150 ms is re-declared here because
    // main.rs's LOCATOR_SWEEP_INTERVAL is private to the server binary.
    freshell_ws::codex_association::spawn_codex_locator_sweep(
        state.clone(),
        std::time::Duration::from_millis(150),
    );
    let router = freshell_ws::router(state.clone());
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
        sink,
        state,
    )
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
        handshake_settings: handshake_settings_lock(),
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
        ownership: None,
        units: Default::default(),
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
    connect_with_hello(
        url,
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        }),
    )
    .await
}

/// `connect_and_capture_inventory` variant whose hello carries the D8
/// provenance identity (`deviceId`/`clientInstanceId`) — the stamp source for
/// connection-scoped ledger rows.
pub async fn connect_and_capture_inventory_with_identity(
    url: &str,
    device_id: &str,
    client_instance_id: &str,
) -> (TestWs, serde_json::Value) {
    connect_with_hello(
        url,
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
            "deviceId": device_id,
            "clientInstanceId": client_instance_id,
        }),
    )
    .await
}

async fn connect_with_hello(url: &str, hello: serde_json::Value) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");

    let mut inventory = serde_json::Value::Null;
    // DEFLAKE (delta-r2 M1): ONE deadline per CALL (Instant::now() +
    // FRAME_BUDGET), each read wrapped in timeout(remaining.max(1ms), ...) —
    // the per-frame FRAME_BUDGET form multiplied the budget across the loop.
    // The 4-frame handshake cap stays as the secondary bound; panic strings
    // unchanged.
    let deadline = std::time::Instant::now() + FRAME_BUDGET;
    for _ in 0..4u8 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let msg = tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next())
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

    // DEFLAKE-keep (the-usual test-flake-hardening): the 10s outer budget and
    // 5s per-read here stay narrow — the suites using this helper did not
    // flake, and widening would only raise their failure latency (see
    // FRAME_BUDGET's doc comment for the widened set).
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
    // DEFLAKE-keep (the-usual test-flake-hardening): the 10s outer budget and
    // 5s per-read here stay narrow — the suites using this helper did not
    // flake, and widening would only raise their failure latency (see
    // FRAME_BUDGET's doc comment for the widened set).
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
    // DEFLAKE (delta-r2 M1): ONE deadline per CALL (Instant::now() +
    // FRAME_BUDGET), each read wrapped in timeout(remaining.max(1ms), ...) —
    // the per-frame FRAME_BUDGET form multiplied the budget across the 20-frame
    // loop (a genuinely missing frame fails in ≤ FRAME_BUDGET, restored
    // exactly). The 20-message cap stays as the secondary bound; panic strings
    // unchanged.
    let deadline = std::time::Instant::now() + FRAME_BUDGET;
    for _ in 0..20u8 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let msg = tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next())
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

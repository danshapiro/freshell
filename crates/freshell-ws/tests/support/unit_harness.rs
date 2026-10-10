//! A WsState-backed server with CODEX_CMD pointing at the realistic fake
//! (launcher + native for `app-server`, the TUI fake otherwise), isolated
//! HOME/CODEX_HOME/FRESHELL_HOME, and helpers to read the fake's manifests.
//! Built from `codex_managed_launch_e2e.rs::spawn_server`, with an enabled
//! owner registry, the pane-unit services (units on the selected backend,
//! records under `<home>/.freshell/units/`) and the unit lifecycle wired as
//! `freshell-server` wires it, including the REST lane (`/api/tabs`) over
//! the same unit directory and containment (`FreshAgentState::with_units`,
//! as `main.rs` builds it). Shared by every ws unit test file via
//! `#[path = "support/unit_harness.rs"] mod unit_harness;`.
#![allow(dead_code)]
#[path = "../../../freshell-codex/tests/support/fake_codex.rs"]
pub mod fake_codex;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const AUTH_TOKEN: &str = "unit-harness-token";
const FRAME_LIMIT: Duration = Duration::from_secs(20);

pub type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Hub = the real auto-resume hub runs (`spawn_auto_resume_hub_with_schedules`);
/// Capture = crash events are captured on `crash_rx` instead.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AutoResumeMode {
    Hub,
    Capture,
}

pub struct HarnessOpts {
    pub behavior: serde_json::Value,
    pub containment: Option<freshell_containment::Containment>,
    pub auto_resume: AutoResumeMode,
    /// The server-wide spawn gate both doors share (as at boot), and the
    /// REST door's permit wait. Default: an ungated REST door.
    pub spawn_gate: Option<(Arc<freshell_freshagent::spawn_gate::SpawnGate>, Duration)>,
    /// The REST lane's Codex TUI command (its CLI spec's default command,
    /// read instead of `CODEX_CMD`); the sidecar still runs `CODEX_CMD`.
    pub rest_codex_tui_cmd: Option<String>,
    /// The WebSocket doors' create protection (spawn permit wait included).
    pub create_protect: freshell_ws::create_limit::CreateProtectConfig,
    /// The REST lane's pane identity binder (`main.rs` installs the session
    /// identity registry's); its `register_create_identity` runs after a
    /// REST create's bind and before its late claim and commit.
    pub rest_identity_binder: Option<Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
    /// Wire an `ActivityHub` as `main.rs` does (the hub plus the registry's
    /// activity observer) and keep it in `WsState.activity`, so turn,
    /// idle and attention edges are produced.
    pub activity_hub: bool,
}

impl Default for HarnessOpts {
    fn default() -> Self {
        Self {
            behavior: json!({}),
            containment: None,
            auto_resume: AutoResumeMode::Hub,
            spawn_gate: None,
            rest_codex_tui_cmd: None,
            create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
            rest_identity_binder: None,
            activity_hub: false,
        }
    }
}

pub struct UnitHarness {
    pub url: String,
    /// `http://<addr>` of the same server (the REST lane).
    pub base_url: String,
    pub state: freshell_ws::WsState,
    pub codex_home: PathBuf,
    pub manifests: PathBuf,
    pub crash_rx:
        Option<tokio::sync::mpsc::UnboundedReceiver<freshell_ws::auto_resume::CrashEvent>>,
    /// The state root of the harness's own containment (`None` when the
    /// test passed its own).
    state_root: Option<PathBuf>,
    pub home: tempfile::TempDir,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

/// Process environment is shared: one harness at a time per test binary.
static HARNESS_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Writes the `codex` dispatcher: the realistic launcher (in front of a
/// separate native) for `app-server`, the TUI fake otherwise.
pub fn write_dispatcher(dir: &Path) -> PathBuf {
    let path = dir.join("codex");
    let script = format!(
        "#!/bin/bash\nif [[ \" $* \" == *\" app-server \"* ]]; then exec node {} \"$@\"; else exec node {} \"$@\"; fi\n",
        fake_codex::fixture_path("fake-codex-launcher.mjs").display(),
        fake_codex::fixture_path("fake-codex-tui.mjs").display(),
    );
    // Written by a child so no write descriptor of this process can make
    // the later exec fail with ETXTBSY.
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg("cat > \"$1\" && chmod 755 \"$1\"")
        .arg("sh")
        .arg(&path)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .take()
                .expect("stdin")
                .write_all(script.as_bytes())?;
            child.wait()
        })
        .expect("write the dispatcher");
    assert!(status.success(), "dispatcher written");
    path
}

/// The shipped codex CLI spec shape (`codex_managed_launch_e2e.rs`).
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
        effort_args: None,
        sandbox_args: Some(s(&["--sandbox", "{{sandbox}}"])),
        ..Default::default()
    }
}

fn test_settings_value() -> serde_json::Value {
    json!({
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

impl UnitHarness {
    /// Holds HARNESS_ENV for the test's lifetime (process env is shared).
    pub async fn start(opts: HarnessOpts) -> Self {
        let env_guard = HARNESS_ENV.lock().await;
        let home = tempfile::tempdir().expect("harness home");
        let codex_home = home.path().join(".codex");
        let freshell_dir = home.path().join(".freshell");
        let manifests = home.path().join("manifests");
        for dir in [&codex_home, &freshell_dir, &manifests] {
            std::fs::create_dir_all(dir).expect("harness dir");
        }
        let dispatcher = write_dispatcher(home.path());
        std::env::set_var("CODEX_CMD", &dispatcher);
        std::env::set_var("CODEX_HOME", &codex_home);
        std::env::set_var("HOME", home.path());
        std::env::set_var("FRESHELL_HOME", home.path());
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", opts.behavior.to_string());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
        std::env::set_var("FAKE_CODEX_MANIFEST_DIR", &manifests);
        std::env::set_var("FAKE_UNIT_RECORD_DIR", freshell_dir.join("units"));
        freshell_codex::sidecar_store::set_codex_sidecar_store(Arc::new(
            freshell_codex::sidecar_store::CodexSidecarStore::new_locked(Some(
                freshell_dir.join("rust-codex-sidecars"),
            )),
        ));

        let (containment, state_root) = match opts.containment {
            Some(containment) => (containment, None),
            None => (
                freshell_containment::Containment::select(freshell_containment::SelectOptions {
                    shim: None,
                    state_root: freshell_dir.clone(),
                }),
                Some(freshell_dir.clone()),
            ),
        };

        let auth_token = Arc::new(AUTH_TOKEN.to_string());
        let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(256).0);
        let settings =
            Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings"));
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry =
            freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
        let (auto_resume_tx, auto_resume_rx) = tokio::sync::mpsc::unbounded_channel();
        // As `main.rs` wires it: the hub, then the registry's activity tap.
        let activity = opts.activity_hub.then(|| {
            let hub = freshell_ws::activity::ActivityHub::new(Arc::clone(&broadcast_tx), None);
            registry.set_activity_observer(hub.registry_observer());
            hub
        });

        let state = freshell_ws::WsState {
            pane_ledger: Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            terminal_meta: Default::default(),
            auth_token: Arc::clone(&auth_token),
            server_instance_id: Arc::new("srv-unit-harness".to_string()),
            boot_id: Arc::new("boot-unit-harness".to_string()),
            settings,
            handshake_settings: Arc::new(tokio::sync::RwLock::new(
                serde_json::from_value(test_settings_value()).expect("valid settings"),
            )),
            broadcast_tx: Arc::clone(&broadcast_tx),
            auto_resume_tx,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                json!({ "freshAgent": { "enabled": false } }),
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
            create_protect: opts.create_protect,
            spawn_gate: opts
                .spawn_gate
                .as_ref()
                .map(|(gate, _)| Arc::clone(gate))
                .unwrap_or_else(|| Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64))),
            shutdown_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: None,
            codex_locator: None,
            activity,
            session_existence: Arc::new(freshell_ws::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms:
                freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
            ownership: Some(ownership),
            units: freshell_ws::unit_lifecycle::UnitServices {
                directory: freshell_containment::UnitDirectory::new(),
                containment,
            },
        };
        // As `freshell-server` wires it (Stage 2: LB-01, LB-25).
        freshell_ws::unit_lifecycle::wire(&state, &tokio::runtime::Handle::current());

        // The REST lane over the same registry, owner registry and units
        // (`main.rs`'s `with_units(..)`).
        let rest_codex_spec = match opts.rest_codex_tui_cmd.as_deref() {
            Some(cmd) => freshell_platform::CliCommandSpec {
                env_var: None,
                default_cmd: cmd.to_string(),
                ..codex_cli_spec()
            },
            None => codex_cli_spec(),
        };
        let mut fresh_agent_state = freshell_freshagent::FreshAgentState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
        )
        .with_terminal_registry(registry.clone())
        .with_ownership(state.ownership.clone().expect("an owner registry"))
        .with_cli_commands(Arc::new(vec![rest_codex_spec]))
        .with_units(
            state.units.directory.clone(),
            state.units.containment.clone(),
        );
        if let Some(binder) = opts.rest_identity_binder.clone() {
            fresh_agent_state = fresh_agent_state.with_pane_identity_binder(binder);
        }
        if let Some((gate, timeout)) = opts.spawn_gate.as_ref() {
            fresh_agent_state.set_spawn_gate(Arc::clone(gate), *timeout);
        }

        // The managed launches' proxy events (identity adoption) reach this
        // state's router, as at boot.
        let (proxy_events_tx, proxy_events_rx) = tokio::sync::mpsc::unbounded_channel();
        freshell_codex::launch_lifecycle::set_codex_proxy_event_sink(proxy_events_tx);
        freshell_ws::codex_proxy_route::spawn_codex_proxy_router(state.clone(), proxy_events_rx);

        let crash_rx = match opts.auto_resume {
            AutoResumeMode::Hub => {
                freshell_ws::auto_resume::spawn_auto_resume_hub_with_schedules(
                    state.clone(),
                    auto_resume_rx,
                    vec![100, 100],
                    vec![25, 25],
                );
                None
            }
            AutoResumeMode::Capture => Some(auto_resume_rx),
        };

        // The session handoff (`POST /api/sessions/handoff`), as `main.rs`
        // builds it over the same states.
        let handoff_runner = Arc::new(freshell_freshagent::SessionHandoffRunner::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            state.ownership.clone().expect("an owner registry"),
            registry.clone(),
            state.fresh_codex.clone(),
            state.fresh_claude.clone(),
            state.fresh_opencode.clone(),
            fresh_agent_state.clone(),
            Arc::clone(&state.cli_commands),
        ));
        let router = freshell_ws::router(state.clone())
            .merge(freshell_freshagent::router(fresh_agent_state))
            .merge(freshell_freshagent::session_handoff::handoff_router(
                handoff_runner,
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        Self {
            url: format!("ws://{addr}/ws"),
            base_url: format!("http://{addr}"),
            state,
            codex_home,
            manifests,
            crash_rx,
            state_root,
            home,
            _env: env_guard,
        }
    }

    /// Connects and completes the hello/ready handshake (`paneReconcileV1`
    /// and `terminalLifetimeClaimV1` negotiated).
    pub async fn connect(&self) -> TestWs {
        self.connect_with_inventory().await.0
    }

    /// [`Self::connect`], returning the handshake's `terminal.inventory`.
    pub async fn connect_with_inventory(&self) -> (TestWs, serde_json::Value) {
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&self.url)
            .await
            .expect("ws connect");
        ws.send(WsMessage::Text(
            json!({
                "type": "hello",
                "token": AUTH_TOKEN,
                "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
                "capabilities": { "paneReconcileV1": true, "terminalLifetimeClaimV1": true },
            })
            .to_string(),
        ))
        .await
        .expect("send hello");
        let inventory = self
            .next_matching(&mut ws, FRAME_LIMIT, |f| f["type"] == "terminal.inventory")
            .await
            .expect("the handshake ends with terminal.inventory");
        (ws, inventory)
    }

    /// Creates a Codex pane (a fresh one, or a restore of `resume`), attaches
    /// to it and returns its terminal id. Panics on a create error.
    pub async fn create_codex(
        &self,
        ws: &mut TestWs,
        request_id: &str,
        resume: Option<&str>,
    ) -> String {
        let mut create = json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "codex",
            "shell": "system",
            "cwd": self.home.path().display().to_string(),
        });
        if let Some(session_id) = resume {
            create["restore"] = json!(true);
            create["sessionRef"] = json!({ "provider": "codex", "sessionId": session_id });
        }
        self.send(ws, create).await;
        let created = self
            .next_matching(ws, FRAME_LIMIT, |f| {
                f["requestId"] == request_id
                    && (f["type"] == "terminal.created" || f["type"] == "error")
            })
            .await
            .expect("an answer to the create");
        assert_eq!(
            created["type"], "terminal.created",
            "create failed: {created}"
        );
        let terminal_id = created["terminalId"]
            .as_str()
            .expect("terminal.created carries terminalId")
            .to_string();
        let attach_request_id = format!("attach-{request_id}");
        self.send(
            ws,
            json!({
                "type": "terminal.attach",
                "terminalId": terminal_id,
                "intent": "viewport_hydrate",
                "cols": 120,
                "rows": 30,
                "attachRequestId": attach_request_id,
            }),
        )
        .await;
        self.next_matching(ws, FRAME_LIMIT, |f| {
            f["type"] == "terminal.attach.ready" && f["attachRequestId"] == attach_request_id
        })
        .await
        .expect("attached");
        terminal_id
    }

    pub async fn send(&self, ws: &mut TestWs, frame: serde_json::Value) {
        ws.send(WsMessage::Text(frame.to_string()))
            .await
            .expect("send frame");
    }

    /// The next frame satisfying `pred` within `limit` (others are dropped).
    pub async fn next_matching(
        &self,
        ws: &mut TestWs,
        limit: Duration,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match tokio::time::timeout(remaining, ws.next()).await {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    if pred(&value) {
                        return Some(value);
                    }
                }
                Ok(Some(Ok(_))) => {}
                _ => return None,
            }
        }
    }

    /// Waits within `limit` for `terminal_id`'s `terminal.exit` and for the
    /// Vacant `session.runtimeOwner` frame of `session_id`, and returns the
    /// `terminal.exit` frame. Both are published at Gone but through
    /// different channels (the terminal's own stream and the server-wide
    /// broadcast), so they can reach the client in either order; `on_frame`
    /// runs as each of the two arrives.
    pub async fn exit_and_vacant(
        &self,
        ws: &mut TestWs,
        limit: Duration,
        terminal_id: &str,
        session_id: &str,
        on_frame: impl Fn(),
    ) -> serde_json::Value {
        let deadline = tokio::time::Instant::now() + limit;
        let mut exit = None;
        let mut vacant = false;
        while exit.is_none() || !vacant {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let frame = self
                .next_matching(ws, remaining, |f| {
                    (f["type"] == "terminal.exit" && f["terminalId"] == terminal_id)
                        || (f["type"] == "session.runtimeOwner"
                            && f["sessionId"] == session_id
                            && f["ownerKind"] == "vacant")
                })
                .await
                .unwrap_or_else(|| {
                    panic!(
                        "terminal.exit (seen: {}) and the Vacant frame (seen: {vacant}) \
                         within {limit:?}",
                        exit.is_some()
                    )
                });
            on_frame();
            if frame["type"] == "terminal.exit" {
                exit = Some(frame);
            } else {
                vacant = true;
            }
        }
        exit.expect("terminal.exit")
    }

    /// POSTs `body` to the REST lane; returns the status and the JSON body
    /// (`Null` when it is not JSON). A hand-rolled HTTP/1.1 request (this
    /// crate has no HTTP client), as `rest_ws_shared_gate.rs` does.
    pub async fn post(&self, path: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host = self
            .base_url
            .strip_prefix("http://")
            .expect("base_url is http://{addr}");
        let body = body.to_string();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {host}\r\nx-auth-token: {AUTH_TOKEN}\r\n\
             Content-Type: application/json\r\nContent-Length: {len}\r\n\
             Connection: close\r\n\r\n{body}",
            len = body.len(),
        );
        let mut stream = tokio::net::TcpStream::connect(host)
            .await
            .expect("connect to the harness");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write the request");
        let mut raw = Vec::new();
        tokio::time::timeout(Duration::from_secs(60), stream.read_to_end(&mut raw))
            .await
            .expect("an HTTP response within 60 s")
            .expect("read the response");
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (head, body) = text
            .split_once("\r\n\r\n")
            .expect("an HTTP header/body separator");
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("an HTTP status code");
        (
            status,
            serde_json::from_str(body).unwrap_or(serde_json::Value::Null),
        )
    }

    /// Creates a Codex pane through the REST lane (`POST /api/tabs`; a
    /// restore of `resume` when given); returns the status and body.
    pub async fn rest_create_codex(&self, resume: Option<&str>) -> (u16, serde_json::Value) {
        let mut body = json!({
            "mode": "codex",
            "cwd": self.home.path().display().to_string(),
        });
        if let Some(session_id) = resume {
            body["sessionRef"] = json!({ "provider": "codex", "sessionId": session_id });
        }
        self.post("/api/tabs", body).await
    }

    /// Attaches `ws` to `terminal_id` (so its output and `terminal.exit`
    /// reach the socket).
    pub async fn attach(&self, ws: &mut TestWs, terminal_id: &str) {
        let attach_request_id = format!("attach-{terminal_id}");
        self.send(
            ws,
            json!({
                "type": "terminal.attach",
                "terminalId": terminal_id,
                "intent": "viewport_hydrate",
                "cols": 120,
                "rows": 30,
                "attachRequestId": attach_request_id,
            }),
        )
        .await;
        self.next_matching(ws, FRAME_LIMIT, |f| {
            f["type"] == "terminal.attach.ready" && f["attachRequestId"] == attach_request_id
        })
        .await
        .expect("attached");
    }

    /// Every native app-server manifest the fake wrote.
    pub fn native_manifests(&self) -> Vec<fake_codex::NativeManifest> {
        std::fs::read_dir(&self.manifests)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("native-") && name.ends_with(".json"))
            })
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .filter_map(|raw| serde_json::from_str(&raw).ok())
            .collect()
    }

    pub fn unit_for(&self, terminal_id: &str) -> freshell_containment::AgentUnit {
        self.state
            .units
            .by_terminal(terminal_id)
            .expect("the terminal's unit")
            .unit
    }

    pub fn native_pid(&self, terminal_id: &str) -> u32 {
        self.unit_for(terminal_id)
            .main()
            .expect("the unit's main is the native app-server")
            .pid()
    }

    pub fn native_manifest(&self, terminal_id: &str) -> fake_codex::NativeManifest {
        let pid = self.native_pid(terminal_id);
        let raw = std::fs::read_to_string(self.manifests.join(format!("native-{pid}.json")))
            .expect("the native's manifest");
        serde_json::from_str(&raw).expect("native manifest JSON")
    }

    pub fn lock(&self, thread_id: &str) -> PathBuf {
        fake_codex::thread_lock_path(&self.codex_home, thread_id)
    }
}

impl Drop for UnitHarness {
    /// Best effort, without waiting: the screens are killed, every process
    /// a native manifest pins (by pid and start time) is killed, and the
    /// harness's own systemd namespace slice is stopped.
    fn drop(&mut self) {
        self.state.registry.kill_all();
        for entry in std::fs::read_dir(&self.manifests)
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !(name.starts_with("native-") && name.ends_with(".json")) {
                continue;
            }
            if let Ok(manifest) = std::fs::read_to_string(entry.path())
                .map_err(|_| ())
                .and_then(|raw| {
                    serde_json::from_str::<fake_codex::NativeManifest>(&raw).map_err(|_| ())
                })
            {
                manifest.kill_all();
            }
        }
        if let Some(root) = self.state_root.as_deref() {
            freshell_containment::testing::stop_namespace_slice(root);
        }
    }
}

/// Holds Gone confirmation for `ms` after every unit kill in this process
/// (the containment's test hook) while alive, so a test can see what is
/// published before Gone. Tests that use a harness run one at a time (the
/// harness holds its environment lock); create this after the harness.
pub struct GoneDelay;

impl GoneDelay {
    pub fn set(ms: u64) -> Self {
        std::env::set_var("FRESHELL_TEST_HOOKS", "1");
        std::env::set_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS", ms.to_string());
        GoneDelay
    }
}

impl Drop for GoneDelay {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_TEST_UNIT_GONE_DELAY_MS");
        std::env::remove_var("FRESHELL_TEST_HOOKS");
    }
}

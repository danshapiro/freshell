//! Rigs that run the REAL claude sidecar (`crates/freshell-claude-sidecar/index.mjs`)
//! behind a real freshell-ws server, for the claude integration tests (design §11.3
//! and §11.5).
//!
//! - [`RigKind::Sim`] (RealSidecarSim): the sidecar over the CLI simulator
//!   (`test/fixtures/claude-cli-sim/query.mjs`, through the sidecar's
//!   `FRESHELL_CLAUDE_SDK_QUERY_MODULE` seam). The simulator matches the pinned CLI
//!   (`test/integration/providers/claude-cli-conformance.ts`) and records what
//!   the SDK side received in its ledger ([`ClaudeRig::ledger_rows`]).
//! - [`RigKind::Cli`] (RealSidecarCli): the sidecar over the pinned SDK and its
//!   bundled CLI, talking only to the local fake Anthropic endpoint
//!   (`test/integration/providers/claude-local-provider.mjs --serve`) with a dummy
//!   key. It never contacts the real API.
//!
//! Each rig's server is wired like production: one ownership coordinator shared by
//! the WS state and the claude lane (main.rs does the same).
//!
//! Each rig gets a throwaway HOME / CLAUDE_CONFIG_DIR / workspace, and its server's
//! [`freshell_freshagent::FreshClaudeState`] gives every sidecar exactly the rig's
//! environment (the `test-support` seam `with_sidecar_environment`), so nothing from
//! this process's environment (credentials, the developer's `~/.claude`) reaches the
//! sidecar and rigs never touch process-global env vars: tests run in parallel.
//!
//! A missing node, sidecar, simulator or pinned CLI panics with the reason. Nothing
//! is ever skipped.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

use super::{handshake_settings_lock, test_settings_value, TestWs, AUTH_TOKEN};

/// The repository root (the rigs read the sidecar, the simulator and the provider
/// from the source tree).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Budget for one expected frame. The real CLI boots in about a second; the budget
/// is generous for a loaded machine, and a genuinely missing frame still fails.
pub const RIG_FRAME_BUDGET: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RigKind {
    /// RealSidecarSim: the real `index.mjs` over the CLI simulator.
    Sim,
    /// RealSidecarCli: the real `index.mjs` over the pinned CLI and the local endpoint.
    Cli,
}

pub struct ClaudeRig {
    pub kind: RigKind,
    /// `ws://127.0.0.1:<port>/ws` of the rig's server (an ephemeral loopback port).
    pub url: String,
    /// The isolated workspace every session of this rig runs in.
    pub workspace: PathBuf,
    /// CLAUDE_CONFIG_DIR of the CLI (simulated or real): its transcripts land here.
    pub claude_config_dir: PathBuf,
    /// The simulator's ledger (JSONL; written by [`RigKind::Sim`] only).
    pub ledger: PathBuf,
    /// The rig server's claude lane, for the server-side truths a test checks
    /// (for example `has_live_session`).
    pub fresh_claude: freshell_freshagent::FreshClaudeState,
    /// The local fake Anthropic endpoint ([`RigKind::Cli`] only), killed on drop.
    _provider: Option<tokio::process::Child>,
    _root: tempfile::TempDir,
}

impl ClaudeRig {
    pub async fn start(kind: RigKind) -> Self {
        Self::start_with_env(kind, &[]).await
    }

    /// Start a rig whose sidecars also get `extra` (for example simulator knobs such
    /// as `FRESHELL_CLAUDE_SIM_PROGRAM` or `FRESHELL_CLAUDE_SIM_TIME_SCALE`).
    pub async fn start_with_env(kind: RigKind, extra: &[(&str, &str)]) -> Self {
        let node_version = require_node();
        let root = tempfile::Builder::new()
            .prefix("freshell-claude-rig-")
            .tempdir()
            .expect("create the rig's temp dir");
        let home = root.path().join("home");
        let workspace = root.path().join("workspace");
        let tmp = root.path().join("tmp");
        for directory in [&home, &workspace, &tmp] {
            std::fs::create_dir_all(directory).expect("create rig directories");
        }
        let claude_config_dir = home.join(".claude");
        let ledger = root.path().join("sim-ledger.jsonl");

        let mut environment: Vec<(String, String)> = vec![
            ("HOME".into(), path_string(&home)),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            ("TMPDIR".into(), path_string(&tmp)),
            ("LANG".into(), "C.UTF-8".into()),
            ("CLAUDE_CONFIG_DIR".into(), path_string(&claude_config_dir)),
        ];
        let mut provider = None;
        match kind {
            RigKind::Sim => {
                let simulator = repo_root().join("test/fixtures/claude-cli-sim/query.mjs");
                assert!(
                    simulator.is_file(),
                    "the CLI simulator is missing at {}",
                    simulator.display()
                );
                environment.extend([
                    (
                        "FRESHELL_CLAUDE_SDK_QUERY_MODULE".into(),
                        path_string(&simulator),
                    ),
                    ("FRESHELL_CLAUDE_SIM_LEDGER".into(), path_string(&ledger)),
                    ("FRESHELL_CLAUDE_SIM_TIME_SCALE".into(), "1".into()),
                ]);
            }
            RigKind::Cli => {
                require_pinned_cli();
                let (child, url) = start_local_provider().await;
                provider = Some(child);
                environment.extend([
                    ("XDG_CONFIG_HOME".into(), path_string(&home.join(".config"))),
                    ("XDG_CACHE_HOME".into(), path_string(&home.join(".cache"))),
                    (
                        "XDG_DATA_HOME".into(),
                        path_string(&home.join(".local/share")),
                    ),
                    ("ANTHROPIC_BASE_URL".into(), url),
                    (
                        "ANTHROPIC_API_KEY".into(),
                        format!("sk-local-{}", uuid::Uuid::new_v4()),
                    ),
                    // The sidecar strips ANTHROPIC_API_KEY from the SDK child unless the
                    // key was handed over on purpose (the managed-key path).
                    ("FRESHELL_CLAUDE_ONECLI_API_KEY".into(), "1".into()),
                    // Any egress other than the loopback endpoint hits a closed port.
                    ("HTTPS_PROXY".into(), "http://127.0.0.1:9".into()),
                    ("HTTP_PROXY".into(), "http://127.0.0.1:9".into()),
                    ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
                    (
                        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                        "1".into(),
                    ),
                    ("DISABLE_TELEMETRY".into(), "1".into()),
                    ("DISABLE_ERROR_REPORTING".into(), "1".into()),
                    ("DISABLE_AUTOUPDATER".into(), "1".into()),
                    ("CLAUDE_CODE_DISABLE_METRICS".into(), "1".into()),
                    ("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY".into(), "1".into()),
                ]);
            }
        }
        for (key, value) in extra {
            environment.retain(|(existing, _)| existing != key);
            environment.push(((*key).into(), (*value).into()));
        }

        let (url, fresh_claude) = spawn_rig_server(environment).await;
        eprintln!(
            "{}",
            json!({
                "severity": "info", "event": "claude_rig.started", "kind": format!("{kind:?}"),
                "url": url, "node": node_version, "root": path_string(root.path()),
            })
        );
        Self {
            kind,
            url,
            workspace,
            claude_config_dir,
            ledger,
            fresh_claude,
            _provider: provider,
            _root: root,
        }
    }

    /// A WS connection that has completed the handshake (`ready` seen).
    pub async fn connect(&self) -> RigConnection {
        let (mut ws, _) = tokio_tungstenite::connect_async(&self.url)
            .await
            .expect("connect to the rig's server");
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
        let mut connection = RigConnection {
            ws,
            workspace: self.workspace.clone(),
            frames: Vec::new(),
        };
        connection.wait_for("ready", |v| v["type"] == "ready").await;
        connection
    }

    /// The transcripts (`*.jsonl`) under this rig's CLAUDE_CONFIG_DIR/projects.
    pub fn transcripts(&self) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let Ok(projects) = std::fs::read_dir(self.claude_config_dir.join("projects")) else {
            return found;
        };
        for project in projects.flatten() {
            let Ok(entries) = std::fs::read_dir(project.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                    found.push(entry.path());
                }
            }
        }
        found.sort();
        found
    }

    /// [`Self::transcripts`] once at least one exists (the CLI writes a transcript
    /// shortly after a turn's first result, T3).
    pub async fn wait_for_transcripts(&self) -> Vec<PathBuf> {
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            let found = self.transcripts();
            if !found.is_empty() {
                return found;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no transcript appeared under {}",
                self.claude_config_dir.display()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The simulator's ledger rows of one kind (`query`, `boot`, `prompt`,
    /// `can_use_tool`, `emission`); see `test/fixtures/claude-cli-sim/query.mjs`.
    pub fn ledger_rows(&self, kind: &str) -> Vec<Value> {
        assert_eq!(
            self.kind,
            RigKind::Sim,
            "only the simulator writes a ledger"
        );
        let text = std::fs::read_to_string(&self.ledger).unwrap_or_default();
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).expect("ledger row is json"))
            .filter(|row| row["kind"] == kind)
            .collect()
    }
}

/// One client connection to a rig's server. Every frame it reads is kept in
/// [`Self::frames`], so a test can wait for one frame and later count others.
pub struct RigConnection {
    ws: TestWs,
    workspace: PathBuf,
    pub frames: Vec<Value>,
}

impl RigConnection {
    pub async fn send(&mut self, frame: Value) {
        self.ws
            .send(WsMessage::Text(frame.to_string()))
            .await
            .expect("send a frame to the rig's server");
    }

    /// The first frame (already read or still to come) matching `predicate`.
    pub async fn wait_for(&mut self, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        if let Some(hit) = self.frames.iter().find(|frame| predicate(frame)) {
            return hit.clone();
        }
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            let next = match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(message))) => message,
                Ok(Some(Err(error))) => panic!("ws error waiting for {what}: {error}"),
                Ok(None) => panic!("the server closed the socket waiting for {what}"),
                Err(_) => panic!(
                    "timed out waiting for {what}; frames: {}",
                    tail(&self.frames)
                ),
            };
            let WsMessage::Text(text) = next else {
                continue;
            };
            let frame: Value = serde_json::from_str(&text).expect("json frame");
            self.frames.push(frame.clone());
            if predicate(&frame) {
                return frame;
            }
        }
    }

    /// `freshAgent.create` for a freshclaude session in the rig's workspace; returns
    /// the session id from `freshAgent.created`.
    pub async fn create(&mut self, request_id: &str) -> String {
        let cwd = path_string(&self.workspace);
        self.send(json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "provider": "claude",
            "sessionType": "freshclaude",
            "cwd": cwd,
        }))
        .await;
        let answer = self
            .wait_for(&format!("the answer to create {request_id}"), |v| {
                v["requestId"] == request_id
                    && matches!(
                        v["type"].as_str(),
                        Some("freshAgent.created" | "freshAgent.create.failed" | "error")
                    )
            })
            .await;
        assert_eq!(
            answer["type"], "freshAgent.created",
            "create failed: {answer}"
        );
        answer["sessionId"]
            .as_str()
            .expect("created carries a sessionId")
            .to_string()
    }

    pub async fn send_text(&mut self, session_id: &str, request_id: &str, text: &str) {
        self.send(json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "requestId": request_id,
            "text": text,
        }))
        .await;
    }

    /// A send the way the browser client makes every send (`FreshAgentView`'s
    /// `sendFreshAgentSendFrame`): with a checkpoint intent, and with the owner pair
    /// (epoch, generation) of the latest `session.runtimeOwner` frame this
    /// connection read for the session's durable id, once there is one.
    pub async fn send_checkpointed_text(&mut self, session_id: &str, request_id: &str, text: &str) {
        let mut frame = json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "requestId": request_id,
            "checkpointIntent": { "logicalAttemptId": format!("attempt-{request_id}") },
            "text": text,
        });
        if let Some((epoch, generation)) = self.observed_owner(session_id) {
            frame["observedEpoch"] = json!(epoch);
            frame["observedGeneration"] = json!(generation);
        }
        self.send(frame).await;
    }

    /// The owner pair the client would hold for this pane's session: the latest
    /// `session.runtimeOwner` frame for the durable id its `session.init` named.
    fn observed_owner(&self, session_id: &str) -> Option<(u64, u64)> {
        let durable = self.frames.iter().rev().find_map(|v| {
            (v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.session.init"
                && v["event"]["sessionId"] == session_id)
                .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
                .flatten()
        })?;
        self.frames.iter().rev().find_map(|v| {
            (v["type"] == "session.runtimeOwner"
                && v["provider"] == "claude"
                && v["sessionId"] == durable.as_str())
            .then(|| Some((v["epoch"].as_u64()?, v["generation"].as_u64()?)))
            .flatten()
        })
    }

    /// Top-level `error` frames answering this request id, read so far.
    pub fn request_errors(&self, request_id: &str) -> Vec<Value> {
        self.frames
            .iter()
            .filter(|v| v["type"] == "error" && v["requestId"] == request_id)
            .cloned()
            .collect()
    }

    /// Keep reading frames for `quiet` and keep them in [`Self::frames`]: a bounded
    /// window for asserting that nothing more arrives (a second edge, say).
    pub async fn read_for(&mut self, quiet: Duration) {
        let deadline = tokio::time::Instant::now() + quiet;
        loop {
            match tokio::time::timeout_at(deadline, self.ws.next()).await {
                Ok(Some(Ok(WsMessage::Text(text)))) => {
                    self.frames
                        .push(serde_json::from_str(&text).expect("json frame"));
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(error))) => panic!("ws error while reading: {error}"),
                Ok(None) | Err(_) => return,
            }
        }
    }

    /// The first `freshAgent.event` whose inner event has this type.
    pub async fn wait_for_event(&mut self, event_type: &str) -> Value {
        self.wait_for(&format!("a {event_type} event"), |v| {
            v["type"] == "freshAgent.event" && v["event"]["type"] == event_type
        })
        .await
    }

    /// How many `freshAgent.event`s of this inner type this connection has read.
    pub fn events_seen(&self, event_type: &str) -> usize {
        self.frames
            .iter()
            .filter(|v| v["type"] == "freshAgent.event" && v["event"]["type"] == event_type)
            .count()
    }

    /// `freshAgent.kill`, then wait for `freshAgent.killed{success:true}`.
    pub async fn kill(&mut self, session_id: &str) {
        self.send(json!({
            "type": "freshAgent.kill",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
        }))
        .await;
        let killed = self
            .wait_for("freshAgent.killed", |v| v["type"] == "freshAgent.killed")
            .await;
        assert_eq!(killed["success"], true, "{killed}");
    }
}

fn tail(frames: &[Value]) -> String {
    let start = frames.len().saturating_sub(40);
    serde_json::to_string(&frames[start..]).unwrap_or_default()
}

fn path_string(path: &Path) -> String {
    path.to_str().expect("utf-8 path").to_string()
}

/// `node --version`, or a panic that says node is required.
fn require_node() -> String {
    let output = std::process::Command::new("node")
        .arg("--version")
        .output()
        .unwrap_or_else(|error| {
            panic!("the claude rigs need node on PATH to run the sidecar: {error}")
        });
    assert!(
        output.status.success(),
        "`node --version` failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Resolve the pinned SDK and its bundled CLI with the same resolver the real-CLI
/// contract suite uses; its PinnedClaudeMissingError (with the install hint) becomes
/// the panic message.
fn require_pinned_cli() {
    let provider = repo_root().join("test/integration/providers/claude-local-provider.mjs");
    let script = format!(
        "const m = await import({url}); const r = await m.resolvePinnedClaude(); \
         console.log(JSON.stringify({{ sdk: r.sdkVersion, cli: r.cliVersion }}))",
        url = serde_json::to_string(&format!("file://{}", path_string(&provider)))
            .expect("json string"),
    );
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .current_dir(repo_root())
        .output()
        .expect("run the pinned-CLI resolver");
    assert!(
        output.status.success(),
        "the pinned Claude CLI is not usable: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Start the local fake Anthropic endpoint (`--serve` prints `{"port","url"}` and
/// serves until its stdin closes). The child is killed when the rig drops.
async fn start_local_provider() -> (tokio::process::Child, String) {
    let script = repo_root().join("test/integration/providers/claude-local-provider.mjs");
    let mut child = tokio::process::Command::new("node")
        .arg(&script)
        .arg("--serve")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("start the local fake Anthropic endpoint");
    let stdout = child.stdout.take().expect("provider stdout");
    let mut lines = BufReader::new(stdout).lines();
    let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
        .await
        .expect("the local endpoint reports its address within 30 s")
        .expect("read the local endpoint's stdout")
        .expect("the local endpoint printed its address");
    let address: Value = serde_json::from_str(&line).expect("address json");
    let url = address["url"]
        .as_str()
        .expect("the endpoint's url")
        .to_string();
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "the endpoint must be loopback: {url}"
    );
    (child, url)
}

/// A freshell-ws server on an ephemeral loopback port (never 3001/3002) with fresh
/// agents enabled and a claude state whose sidecars get exactly `environment`.
async fn spawn_rig_server(
    environment: Vec<(String, String)>,
) -> (String, freshell_freshagent::FreshClaudeState) {
    let mut settings_value = test_settings_value();
    settings_value["freshAgent"]["enabled"] = json!(true);
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(256).0);
    let settings =
        Arc::new(serde_json::from_value(settings_value.clone()).expect("valid settings fixture"));
    let handshake_settings = handshake_settings_lock();
    *handshake_settings.write().await =
        serde_json::from_value(settings_value).expect("valid settings fixture");

    // The ONE ownership coordinator, wired into the WS state and the claude lane
    // the way main.rs wires it.
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let mut fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx))
        .with_sidecar_environment(environment);
    fresh_claude.set_ownership(Arc::clone(&ownership));
    let lane = fresh_claude.clone();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-claude-rig".to_string()),
        boot_id: Arc::new("boot-claude-rig".to_string()),
        settings,
        handshake_settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({ "freshAgent": { "enabled": true } }),
        ),
        fresh_claude,
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        checkpoint_send: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(Vec::new()),
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
        ownership: Some(ownership),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("ws://{addr}/ws"), lane)
}

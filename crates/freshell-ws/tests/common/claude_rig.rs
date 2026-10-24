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
//! the WS state and the claude lane (main.rs does the same), and the fresh-agent
//! snapshot REST route ([`ClaudeRig::snapshot`]) beside the WS endpoint.
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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

use super::process_probe::ProcessProbe;
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

/// What a rig's server is wired with beyond the default (no durable ledger, a
/// local claude lane, no handoff route).
#[derive(Debug, Clone, Default)]
pub struct RigOptions {
    /// Exercise the hosted kernel's in-memory lifecycle without a coordinator
    /// or identity sink; native files and dead-runtime memory are authoritative.
    pub unwired_runtime: bool,
    /// REST create/split/send/capture over the shared Claude runtime and layout.
    pub rest_api: bool,
    /// Extra sidecar environment (for example simulator knobs such as
    /// `FRESHELL_CLAUDE_SIM_PROGRAM`); a key here replaces the rig's own.
    pub env: Vec<(String, String)>,
    /// A real pane ledger under the rig's temp root, shared by the WS state and the
    /// claude lane's identity sink (`common::ledger_sink`), the way main.rs wires
    /// it: sessions leave durable binding rows a later resume reads back.
    pub durable_ledger: bool,
    /// Hold the next shutdown interruption-marker write until the lifecycle
    /// test releases it, leaving the real sidecar alive during that window.
    pub turn_interrupted_marker_gate: Option<Arc<super::ledger_sink::TurnInterruptedMarkerGate>>,
    /// The claude lane runs the way the hosted session host runs it: the lane
    /// selects the hosted Freshell MCP (`with_hosted_mcp`) and its sidecars see
    /// `FRESHELL_HOSTED_FRESH_AGENT=claude`, so the sidecar offers the fixed MCP
    /// recipe to `query()`.
    pub hosted_claude: bool,
    /// The session handoff route (`POST /api/sessions/handoff`) on the rig's
    /// server, driven by a runner over the same lanes (main.rs's wiring).
    pub handoff: bool,
    /// The ordinary Freshell MCP wiring main.rs installs (G19): the claude lane
    /// gets the rig server's own endpoint (its bound loopback port and
    /// [`AUTH_TOKEN`]) and a recipe provider answering what this cell holds at
    /// each sidecar launch (a test changes it to flip the setting).
    pub freshell_mcp: Option<RigFreshellMcp>,
}

/// What the rig's Freshell MCP recipe provider answers, changeable mid-test.
pub type RigFreshellMcp =
    Arc<std::sync::Mutex<freshell_freshagent::claude_freshell_mcp::ClaudeFreshellMcpResolution>>;

pub struct ClaudeRig {
    pub kind: RigKind,
    /// `ws://127.0.0.1:<port>/ws` of the rig's server (an ephemeral loopback port).
    pub url: String,
    /// `http://127.0.0.1:<port>` of the same server.
    pub http_url: String,
    /// The real pane ledger, when the rig has one ([`RigOptions::durable_ledger`]).
    pub pane_ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
    /// The isolated workspace every session of this rig runs in.
    pub workspace: PathBuf,
    /// CLAUDE_CONFIG_DIR of the CLI (simulated or real): its transcripts land here.
    pub claude_config_dir: PathBuf,
    /// The simulator's ledger (JSONL; written by [`RigKind::Sim`] only).
    pub ledger: PathBuf,
    /// The rig server's claude lane, for the server-side truths a test checks
    /// (for example `has_live_session`).
    pub fresh_claude: freshell_freshagent::FreshClaudeState,
    pub fresh_codex: freshell_freshagent::FreshCodexState,
    /// The local fake Anthropic endpoint ([`RigKind::Cli`] only), killed on drop.
    _provider: Option<tokio::process::Child>,
    /// What the server was started with, for [`Self::restart`].
    environment: Vec<(String, String)>,
    options: RigOptions,
    server: tokio::task::JoinHandle<()>,
    _root: tempfile::TempDir,
}

impl ClaudeRig {
    pub async fn start(kind: RigKind) -> Self {
        Self::start_with_env(kind, &[]).await
    }

    /// Start a rig whose sidecars also get `extra` (for example simulator knobs such
    /// as `FRESHELL_CLAUDE_SIM_PROGRAM` or `FRESHELL_CLAUDE_SIM_TIME_SCALE`).
    pub async fn start_with_env(kind: RigKind, extra: &[(&str, &str)]) -> Self {
        Self::start_with_options(
            kind,
            RigOptions {
                env: extra
                    .iter()
                    .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                    .collect(),
                ..RigOptions::default()
            },
        )
        .await
    }

    pub async fn start_with_options(kind: RigKind, options: RigOptions) -> Self {
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
        if options.hosted_claude {
            environment.push(("FRESHELL_HOSTED_FRESH_AGENT".into(), "claude".into()));
        }
        for (key, value) in &options.env {
            environment.retain(|(existing, _)| existing != key);
            environment.push((key.clone(), value.clone()));
        }
        let pane_ledger = options.durable_ledger.then(|| {
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                root.path().join("pane-ledger"),
            )))
        });

        let RigServer {
            url,
            http_url,
            fresh_claude,
            fresh_codex,
            server,
        } = spawn_rig_server(environment.clone(), &options, pane_ledger.clone()).await;
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
            http_url,
            pane_ledger,
            workspace,
            claude_config_dir,
            ledger,
            fresh_claude,
            fresh_codex,
            _provider: provider,
            environment,
            options,
            server,
            _root: root,
        }
    }

    /// Restart the rig's server the way a server restart does: the claude lane
    /// stops every sidecar (server shutdown), the server goes away, and a new
    /// one starts on a new port over the same transcript store and the same
    /// ledger directory, read back from disk. Connections to the old server
    /// are gone; connect again.
    pub async fn restart(&mut self) {
        self.fresh_claude.shutdown().await;
        self.server.abort();
        let pane_ledger = self.pane_ledger.as_ref().map(|_| {
            Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
                self._root.path().join("pane-ledger"),
            )))
        });
        let RigServer {
            url,
            http_url,
            fresh_claude,
            fresh_codex,
            server,
        } = spawn_rig_server(self.environment.clone(), &self.options, pane_ledger.clone()).await;
        eprintln!(
            "{}",
            json!({ "severity": "info", "event": "claude_rig.restarted", "url": url })
        );
        self.url = url;
        self.http_url = http_url;
        self.fresh_claude = fresh_claude;
        self.fresh_codex = fresh_codex;
        self.pane_ledger = pane_ledger;
        self.server = server;
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

    /// `POST <path>` on the rig's server with the auth token and a JSON body; the
    /// status and the JSON answer (`Null` when the body is not JSON).
    pub async fn post_json(&self, path: &str, body: &Value) -> (u16, Value) {
        Self::request_json_to("POST", &self.http_url, path, body).await
    }

    pub async fn request_json_to(
        method: &str,
        base_url: &str,
        path: &str,
        body: &Value,
    ) -> (u16, Value) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host = base_url
            .strip_prefix("http://")
            .expect("the rig serves http");
        let payload = body.to_string();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\nx-auth-token: {AUTH_TOKEN}\r\n\
             content-type: application/json\r\ncontent-length: {}\r\nConnection: close\r\n\r\n\
             {payload}",
            payload.len(),
        );
        let mut stream = tokio::net::TcpStream::connect(host)
            .await
            .expect("connect to the rig's server");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write the request");
        let mut raw = Vec::new();
        tokio::time::timeout(RIG_FRAME_BUDGET, stream.read_to_end(&mut raw))
            .await
            .expect("the rig's server answers in time")
            .expect("read the answer");
        let text = String::from_utf8(raw).expect("utf-8 answer");
        let (head, answer) = text.split_once("\r\n\r\n").expect("an http answer");
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("an http status");
        (
            status,
            serde_json::from_str(answer.trim()).unwrap_or(Value::Null),
        )
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

    /// `GET /api/fresh-agent/threads/freshclaude/claude/<thread_id>` (the route the
    /// browser's pane fetches its transcript from): the status and the JSON body.
    pub async fn snapshot(&self, thread_id: &str) -> (u16, Value) {
        let host = self
            .http_url
            .strip_prefix("http://")
            .expect("the rig serves http");
        let mut stream = tokio::net::TcpStream::connect(host)
            .await
            .expect("connect to the rig's HTTP address");
        let request = format!(
            "GET /api/fresh-agent/threads/freshclaude/claude/{thread_id} HTTP/1.1\r\n\
             Host: 127.0.0.1\r\nx-auth-token: {AUTH_TOKEN}\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("send the snapshot request");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .await
            .expect("read the snapshot response");
        let text = String::from_utf8(response).expect("a utf-8 response");
        let (head, body) = text
            .split_once("\r\n\r\n")
            .expect("an HTTP response with a body");
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("an HTTP status code");
        (
            status,
            serde_json::from_str(body.trim()).unwrap_or(Value::Null),
        )
    }

    /// The simulator's ledger rows of one kind (`query`, `boot`, `prompt`,
    /// `can_use_tool`, `control`, `emission`); see `test/fixtures/claude-cli-sim/query.mjs`.
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

    /// Record a binding row for `session_id` with `genesis` (core design §4.1)
    /// the way a lane that mints a session with no transcript yet writes it:
    /// a fresh-agent row with the rig's workspace as its cwd. Needs
    /// [`RigOptions::durable_ledger`].
    pub fn seed_pending_session(&self, session_id: &str, genesis: &Value) {
        self.pane_ledger
            .as_ref()
            .expect("seeding a binding row needs the rig's durable ledger")
            .record_fresh_agent_binding(&freshell_ws::pane_ledger::FreshAgentBindingWrite {
                provider: "claude",
                session_id,
                mode: "freshclaude",
                cwd: Some(self.workspace.to_str().expect("utf-8 path")),
                create_request_id: None,
                model: None,
                sandbox: None,
                permission_mode: None,
                effort: None,
                plugins: None,
                genesis: freshell_ws::pane_ledger::GenesisWrite::Set(genesis),
                supersedes: None,
                provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                observed_epoch: None,
                observed_generation: None,
                authoritative: false,
                now_ms: 1_000,
            })
            .expect("seed the binding row");
    }

    /// The transcript `<session_id>.jsonl` under this rig's CLAUDE_CONFIG_DIR,
    /// once the CLI wrote it.
    pub async fn wait_for_transcript(&self, session_id: &str) -> PathBuf {
        let name = format!("{session_id}.jsonl");
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            if let Some(path) = self
                .transcripts()
                .into_iter()
                .find(|path| path.file_name().and_then(|n| n.to_str()) == Some(name.as_str()))
            {
                return path;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no transcript {name}; found {:?}",
                self.transcripts()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Returns once the binding row of `session_id` no longer records a genesis
    /// (the lazy clear, core design §4.1). Needs [`RigOptions::durable_ledger`].
    pub async fn wait_for_genesis_cleared(&self, session_id: &str) {
        let ledger = self
            .pane_ledger
            .as_ref()
            .expect("a genesis lives in the rig's durable ledger");
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        while ledger.binding_genesis("claude", session_id).is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the genesis of {session_id} was never cleared"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The pids of the sidecar and the simulated CLI of the runtime that booted
    /// `session_id`, from its `boot` row.
    pub fn runtime_pids(&self, session_id: &str) -> [i64; 2] {
        let boot = self
            .ledger_rows("boot")
            .into_iter()
            .find(|row| row["sessionId"] == session_id)
            .unwrap_or_else(|| panic!("a boot row for {session_id}"));
        [
            boot["pid"].as_i64().expect("the sidecar's pid"),
            boot["cliPid"].as_i64().expect("the CLI's pid"),
        ]
    }

    /// The processes of the runtime that booted `session_id` (see
    /// [`Self::runtime_pids`]), observed from now on. Take them while that
    /// runtime runs: a later process that reuses one of the ids is then never
    /// mistaken for it.
    pub fn runtime_processes(&self, session_id: &str) -> RuntimeProcesses {
        let pids = self.runtime_pids(session_id);
        let probes = pids.map(|pid| {
            let probe = ProcessProbe::open(u32::try_from(pid).expect("a process id"));
            assert!(
                probe.running(),
                "process {pid} of {session_id}'s runtime runs when it is first observed"
            );
            probe
        });
        RuntimeProcesses { pids, probes }
    }

    /// The options of the `query()` calls the simulator recorded, in order.
    pub fn query_options(&self) -> Vec<Value> {
        self.ledger_rows("query")
            .into_iter()
            .map(|row| row["options"].clone())
            .collect()
    }

    /// The first recorded `query()` options matching `predicate`, once recorded.
    pub async fn wait_for_query(&self, what: &str, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
        loop {
            if let Some(options) = self.query_options().into_iter().find(|o| predicate(o)) {
                return options;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no query() call for {what}; recorded: {:?}",
                self.query_options()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// One finished turn per prompt (each `freshAgent.result`), each on disk
    /// before the next: the CLI flushes a transcript line 95-200 ms after its
    /// SDK frame (T3), and resumes, undo and fork read the transcript. Returns
    /// the durable id the first turn reported.
    pub async fn converse(
        &self,
        conn: &mut RigConnection,
        session_id: &str,
        prompts: &[&str],
    ) -> String {
        for (n, prompt) in prompts.iter().enumerate() {
            let results_before = conn.events_seen("freshAgent.result");
            conn.send_text(session_id, &format!("send-{n}"), prompt)
                .await;
            let deadline = tokio::time::Instant::now() + RIG_FRAME_BUDGET;
            while conn.events_seen("freshAgent.result") == results_before {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "turn {n} never finished"
                );
                conn.read_for(Duration::from_millis(50)).await;
            }
            let path = self
                .wait_for_transcript(&conn.init_session_id(session_id))
                .await;
            loop {
                let lines: Vec<Value> = std::fs::read_to_string(&path)
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect();
                let at = lines.iter().rposition(|line| {
                    line["type"] == "user" && line["message"]["content"][0]["text"] == *prompt
                });
                if at.is_some_and(|at| lines[at..].iter().any(|line| line["type"] == "assistant")) {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the turn for {prompt:?} never reached disk"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        conn.init_session_id(session_id)
    }

    /// The first sidecar this rig booted dies on its own (SIGKILL of the Node
    /// process): its session is untracked, the state a reload or a handoff
    /// resumes from. Returns once `conn` has read the exit.
    pub async fn kill_first_sidecar(&self, conn: &mut RigConnection) {
        let pid = self.ledger_rows("boot")[0]["pid"]
            .as_i64()
            .expect("the boot row names the sidecar's pid") as i32;
        // SAFETY: a plain signal to the sidecar this rig spawned.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        conn.wait_for("the sidecar's exit", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.error"
                && v["event"]["code"] == "SIDECAR_EXITED"
        })
        .await;
    }
}

/// A runtime's sidecar and simulated CLI, observed since they ran
/// ([`ClaudeRig::runtime_processes`]).
pub struct RuntimeProcesses {
    pids: [i64; 2],
    probes: [ProcessProbe; 2],
}

impl RuntimeProcesses {
    /// Returns once both processes have exited (a zombie has: it runs nothing
    /// and holds no pipes), or fails naming `what`.
    pub async fn wait_until_exited(&self, what: &str) {
        for (pid, probe) in self.pids.iter().zip(&self.probes) {
            assert!(
                probe.exits_within(RIG_FRAME_BUDGET).await,
                "{what}: process {pid} is still running"
            );
        }
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
        self.wait_for_since(0, what, predicate).await
    }

    /// A request acknowledgement must be newer than that request, even when
    /// this connection previously observed the same session and operation.
    pub async fn wait_for_since(
        &mut self,
        start: usize,
        what: &str,
        predicate: impl Fn(&Value) -> bool,
    ) -> Value {
        if let Some(hit) = self.frames[start..].iter().find(|frame| predicate(frame)) {
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

    /// `freshAgent.create` for a freshclaude session in the rig's workspace, with
    /// `extra` fields merged in (a resume, say); returns the answer:
    /// `freshAgent.created`, `freshAgent.create.failed` or a request `error`.
    pub async fn request_create(&mut self, request_id: &str, extra: Value) -> Value {
        let start = self.frames.len();
        let cwd = path_string(&self.workspace);
        let mut frame = json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "provider": "claude",
            "sessionType": "freshclaude",
            "cwd": cwd,
        });
        if let (Some(frame), Value::Object(extra)) = (frame.as_object_mut(), extra) {
            frame.extend(extra);
        }
        self.send(frame).await;
        self.wait_for_since(start, &format!("the answer to create {request_id}"), |v| {
            v["requestId"] == request_id
                && matches!(
                    v["type"].as_str(),
                    Some("freshAgent.created" | "freshAgent.create.failed" | "error")
                )
        })
        .await
    }

    /// `freshAgent.create` for a freshclaude session in the rig's workspace; returns
    /// the session id from `freshAgent.created`.
    pub async fn create(&mut self, request_id: &str) -> String {
        let answer = self.request_create(request_id, json!({})).await;
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

    /// The owner pair (epoch, generation) of the latest `session.runtimeOwner`
    /// frame this connection read for the durable id `durable`.
    pub fn owner_pair(&self, durable: &str) -> Option<(u64, u64)> {
        self.frames.iter().rev().find_map(|v| {
            (v["type"] == "session.runtimeOwner"
                && v["provider"] == "claude"
                && v["sessionId"] == durable)
                .then(|| Some((v["epoch"].as_u64()?, v["generation"].as_u64()?)))
                .flatten()
        })
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

    /// The pane reattaches to the durable `session_id` (a reload, or the first
    /// attach after a restart); returns once the attach is acknowledged.
    pub async fn attach(&mut self, session_id: &str) {
        let start = self.frames.len();
        self.send(json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }))
        .await;
        self.wait_for_since(start, "the attach acknowledgement", |v| {
            v["type"] == "freshAgent.event"
                && v["event"]["type"] == "freshAgent.session.snapshot"
                && v["event"]["sessionId"] == session_id
        })
        .await;
    }

    /// The durable claude id the first turn of the session `pane_id` names
    /// reported (`freshAgent.session.init`; its envelope carries the pane's id,
    /// and a create's event the sidecar's own id).
    pub fn init_session_id(&self, pane_id: &str) -> String {
        self.frames
            .iter()
            .find_map(|v| {
                (v["type"] == "freshAgent.event"
                    && v["event"]["type"] == "freshAgent.session.init"
                    && (v["sessionId"] == pane_id || v["event"]["sessionId"] == pane_id))
                    .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
                    .flatten()
            })
            .expect("the first turn reported the durable id")
    }

    /// `freshAgent.kill`, then wait for `freshAgent.killed{success:true}`.
    pub async fn kill(&mut self, session_id: &str) {
        let start = self.frames.len();
        self.send(json!({
            "type": "freshAgent.kill",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
        }))
        .await;
        let killed = self
            .wait_for_since(start, "freshAgent.killed", |v| {
                v["type"] == "freshAgent.killed" && v["sessionId"] == session_id
            })
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

struct RigServer {
    url: String,
    http_url: String,
    fresh_claude: freshell_freshagent::FreshClaudeState,
    fresh_codex: freshell_freshagent::FreshCodexState,
    server: tokio::task::JoinHandle<()>,
}

/// A freshell-ws server on an ephemeral loopback port (never 3001/3002) with fresh
/// agents enabled and a claude state whose sidecars get exactly `environment`,
/// wired as `options` asks.
async fn spawn_rig_server(
    environment: Vec<(String, String)>,
    options: &RigOptions,
    pane_ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
) -> RigServer {
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
    let epoch = pane_ledger.as_ref().and_then(|ledger| {
        ledger
            .reserve_boot_epoch()
            .expect("reserve the rig server's durable boot epoch")
    });
    let ownership = Arc::new(match epoch {
        Some(epoch) => freshell_ownership::RuntimeOwnershipRegistry::with_epoch(epoch),
        None => freshell_ownership::RuntimeOwnershipRegistry::new(),
    });
    let layout = if options.rest_api {
        let home = environment
            .iter()
            .find(|(key, _)| key == "HOME")
            .expect("rig HOME")
            .1
            .clone();
        freshell_freshagent::layout_store::LayoutStore::with_persistence(
            PathBuf::from(home).join(".freshell/rest-layout.json"),
        )
    } else {
        Default::default()
    };
    let mut fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx))
        .with_sidecar_environment(environment)
        .with_hosted_mcp(options.hosted_claude);
    if !options.unwired_runtime {
        fresh_claude.set_ownership(Arc::clone(&ownership));
    }
    if let Some(ledger) = pane_ledger.as_ref().filter(|_| !options.unwired_runtime) {
        let mut sink = super::ledger_sink::LedgerSink::with_ownership(
            Arc::clone(ledger),
            Some(Arc::clone(&ownership)),
        );
        if let Some(gate) = options.turn_interrupted_marker_gate.clone() {
            sink = sink.with_turn_interrupted_marker_gate(gate);
        }
        fresh_claude.set_identity_sink(Arc::new(sink));
    }
    let lane = fresh_claude.clone();
    let fresh_agent_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    )
    .with_layout(layout.clone());
    let registry = freshell_terminal::TerminalRegistry::new();
    let cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>> = Arc::new(Vec::new());

    let state = WsState {
        layout,
        terminal_meta: Default::default(),
        pane_ledger: pane_ledger
            .clone()
            .unwrap_or_else(|| Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled())),
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
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(fresh_agent_state.clone()),
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        checkpoint_send: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::clone(&cli_commands),
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
        ownership: Some(Arc::clone(&ownership)),
    };

    // The snapshot REST route (`GET /api/fresh-agent/threads/...`) the pane reads.
    let snapshots = freshell_freshagent::SnapshotState::new(
        Arc::clone(&auth_token),
        state.fresh_codex.clone(),
        freshell_freshagent::FreshAgentState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
        ),
        lane.clone(),
    );
    let mut router =
        freshell_ws::router(state.clone()).merge(freshell_freshagent::snapshot::router(snapshots));
    if options.rest_api {
        let enabled = state.fresh_codex.clone();
        fresh_agent_state
            .set_claude_rest_lane(Arc::new(
                freshell_freshagent::claude_rest_lane::ClaudeRestLane::new(
                    lane.clone(),
                    Arc::new(move || enabled.is_enabled()),
                ),
            ))
            .expect("install the rig's local Claude REST lane");
        let defaults = state.handshake_settings.clone();
        fresh_agent_state
            .set_rest_create_settings_reader(Arc::new(move || {
                let defaults = defaults.clone();
                Box::pin(async move { defaults.read().await.fresh_agent.clone() })
            }))
            .expect("install the rig's REST defaults reader");
        router = router.merge(freshell_freshagent::router(fresh_agent_state.clone()));
    }
    if options.handoff {
        let runner = Arc::new(freshell_freshagent::SessionHandoffRunner::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            Arc::clone(&ownership),
            registry.clone(),
            state.fresh_codex.clone(),
            state.fresh_claude.clone(),
            state.fresh_opencode.clone(),
            fresh_agent_state
                .with_ownership(Arc::clone(&ownership))
                .with_terminal_registry(registry)
                .with_cli_commands(Arc::clone(&cli_commands)),
            cli_commands,
        ));
        router = router.merge(freshell_freshagent::session_handoff::handoff_router(runner));
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    if let Some(resolution) = options.freshell_mcp.clone() {
        // main.rs wires the same two pieces from its bound port and token.
        assert!(lane.set_freshell_endpoint(
            freshell_freshagent::claude_freshell_mcp::FreshellEndpoint {
                url: format!("http://{addr}"),
                token: AUTH_TOKEN.to_string(),
            }
        ));
        let provider: freshell_freshagent::claude_freshell_mcp::ClaudeFreshellMcpProvider =
            Arc::new(move || {
                let answer = resolution.lock().expect("rig mcp resolution").clone();
                Box::pin(async move { answer })
            });
        assert!(lane.set_freshell_mcp_provider(provider));
    }
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    RigServer {
        url: format!("ws://{addr}/ws"),
        http_url: format!("http://{addr}"),
        fresh_claude: lane,
        fresh_codex: state.fresh_codex.clone(),
        server,
    }
}

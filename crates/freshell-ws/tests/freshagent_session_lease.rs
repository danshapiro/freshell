//! D8 for fresh agents (Task 12): two clients resuming the SAME durable session id with
//! DIFFERENT requestIds must produce exactly one sidecar. Losers get
//! `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }`; a loser
//! re-driving after the winner binds converges via the ADOPT arm (a `freshAgent.created`
//! naming the winner's durable session, no spawn). Expired holders are TREE-killed
//! (child + ownership sweep) before any release.
//!
//! Harness duplicated from `freshagent_claude_attach.rs` per the repo's per-test-file
//! convention, with the Step 1a fake-sidecar knobs: `FAKE_SIDECAR_CREATE_DELAY_MS`
//! (slow spawn), `FAKE_SIDECAR_FAIL_ONCE_MARKER` (first create exits nonzero),
//! `FAKE_SIDECAR_REQUEST_LOG` (JSONL `{pid, msg}` per inbound request — distinct pids ==
//! spawn count), `FAKE_SIDECAR_SPAWN_GRANDCHILD` (tagged decoy grandchild for the
//! kill-sweep test). The codex leg points `CODEX_CMD` at the e2e fake app-server.
//!
//! DESTRUCTIVE SUITE: the expired-lease path kills real processes by recorded pid —
//! run via `scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"`.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes every test in this file that mutates process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FAKE_SIDECAR_*` / `CODEX_CMD` / lease TTL),
/// mirroring `freshagent_claude_attach.rs`'s convention for the same hazard.
static LEASE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const ISOLATED_CODEX_ENV_KEYS: [&str; 5] = [
    "CODEX_HOME",
    "CODEX_CMD",
    "FAKE_CODEX_APP_SERVER_BEHAVIOR",
    "FAKE_CODEX_APP_SERVER_ARG_LOG",
    "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
];

struct IsolatedCodexEnv {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    dir: tempfile::TempDir,
}

impl IsolatedCodexEnv {
    fn install() -> Self {
        let dir = tempfile::tempdir().expect("create isolated Codex home");
        let previous = ISOLATED_CODEX_ENV_KEYS
            .iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect();
        std::env::set_var("CODEX_HOME", dir.path());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
        Self { previous, dir }
    }

    fn path(&self) -> &std::path::Path {
        self.dir.path()
    }
}

impl Drop for IsolatedCodexEnv {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[test]
fn isolated_codex_env_restores_every_mutated_variable_during_unwind() {
    let original: Vec<_> = ISOLATED_CODEX_ENV_KEYS
        .iter()
        .map(std::env::var_os)
        .collect();
    let mut installed_opt_in = None;
    let mut installed_home = None;

    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _lock = LEASE_ENV_LOCK.blocking_lock();
        let _env = IsolatedCodexEnv::install();
        installed_opt_in = std::env::var_os("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
        installed_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from);
        for (index, key) in ISOLATED_CODEX_ENV_KEYS.iter().enumerate() {
            std::env::set_var(key, format!("mutated-by-unwind-test-{index}"));
        }
        panic!("exercise panic-safe environment restoration");
    }));

    let after_unwind: Vec<_> = ISOLATED_CODEX_ENV_KEYS
        .iter()
        .map(std::env::var_os)
        .collect();
    // Restore eagerly before asserting so a RED run cannot contaminate another test process.
    for (key, value) in ISOLATED_CODEX_ENV_KEYS.iter().zip(original.iter()) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    assert!(unwind.is_err(), "the test closure must unwind");
    assert_eq!(installed_opt_in.as_deref(), Some(std::ffi::OsStr::new("1")));
    assert!(
        !installed_home.expect("guard installs CODEX_HOME").exists(),
        "the temporary Codex home must be removed during unwinding"
    );
    assert_eq!(after_unwind, original);
}

// ── fake claude sidecar with the Step 1a knobs ──────────────────────────────────────

const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import readline from 'node:readline'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const logPath = process.env.FAKE_SIDECAR_REQUEST_LOG || ''
function logReq(msg) {
  if (!logPath) return
  try { fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, msg }) + '\n') } catch {}
}

let counter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  logReq(msg)
  if (msg.type === 'create') {
    const failOnce = process.env.FAKE_SIDECAR_FAIL_ONCE_MARKER || ''
    if (failOnce && !fs.existsSync(failOnce)) {
      fs.writeFileSync(failOnce, '1')
      process.exit(1)
    }
    if (process.env.FAKE_SIDECAR_SPAWN_GRANDCHILD === '1') {
      // Detached decoy grandchild inheriting env (so /proc/<pid>/environ carries the
      // ownership tag the kill sweep scans for).
      const gc = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
      gc.unref()
      logReq({ type: 'grandchild', grandchildPid: gc.pid })
    }
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    const reply = () => {
      process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
      const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
      process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
    }
    const delayMs = Number(process.env.FAKE_SIDECAR_CREATE_DELAY_MS || 0)
    if (delayMs > 0) setTimeout(reply, delayMs)
    else reply()
  } else if (msg.type === 'send') {
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'busy' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// Fresh temp dir holding the knob-extended fake sidecar; installs the env vars.
/// Caller must hold [`LEASE_ENV_LOCK`] for the guard's lifetime.
struct FakeLeaseSidecarEnv {
    dir: std::path::PathBuf,
}

impl FakeLeaseSidecarEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-lease-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("FAKE_SIDECAR_REQUEST_LOG", dir.join("requests.jsonl"));
        Self { dir }
    }

    fn request_log_rows(&self) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join("requests.jsonl")) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("request log row parses"))
            .collect()
    }

    fn create_rows(&self) -> Vec<Value> {
        self.request_log_rows()
            .into_iter()
            .filter(|r| r["msg"]["type"] == "create")
            .collect()
    }

    /// Poll the request log until `pred` matches a row (or the budget expires).
    async fn await_log_row(&self, budget: Duration, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            if let Some(row) = self.request_log_rows().into_iter().find(&pred) {
                return row;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "request-log row did not appear within budget"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for FakeLeaseSidecarEnv {
    fn drop(&mut self) {
        for var in [
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_NODE",
            "FAKE_SIDECAR_REQUEST_LOG",
            "FAKE_SIDECAR_CREATE_DELAY_MS",
            "FAKE_SIDECAR_FAIL_ONCE_MARKER",
            "FAKE_SIDECAR_SPAWN_GRANDCHILD",
            "FRESHELL_FRESH_AGENT_LEASE_TTL_MS",
        ] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id())
}

// ── server harness (duplicated from freshagent_claude_attach.rs) ────────────────────

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": true, "providers": {} },
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

async fn spawn_server() -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
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
            serde_json::json!({ "freshAgent": { "enabled": true } }),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
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
    // Ephemeral loopback port only -- NEVER the self-hosted 3001/3002 ports.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    format!("ws://{addr}/ws")
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello. `negotiated` opts into the reconcile capabilities; `false` is the
/// frozen legacy-client shape (no capabilities at all).
async fn connect(url: &str, negotiated: bool) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let mut hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    if negotiated {
        hello["capabilities"] = serde_json::json!({
            "paneReconcileV1": true,
            "paneReconcileFreshAgentV1": true,
        });
    }
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            break;
        }
    }
    ws
}

async fn send_json(ws: &mut TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

async fn await_frame(
    ws: &mut TestWs,
    budget: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(budget, async {
        loop {
            let msg = ws
                .next()
                .await
                .expect("stream not ended")
                .expect("no ws error");
            let WsMessage::Text(text) = msg else {
                continue;
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if predicate(&value) {
                return value;
            }
        }
    })
    .await
    .expect("expected frame did not arrive within budget")
}

fn claude_create_resume(request_id: &str, durable: &str) -> Value {
    serde_json::json!({
        "type": "freshAgent.create",
        "requestId": request_id,
        "sessionType": "freshclaude",
        "provider": "claude",
        "cwd": "/tmp",
        "sessionRef": { "provider": "claude", "sessionId": durable },
    })
}

// ── the red tests ────────────────────────────────────────────────────────────────────

/// Two clients resuming the SAME durable session id with DIFFERENT requestIds: exactly
/// ONE sidecar spawns; the loser gets `SESSION_RESERVED { retryable: true }`; the
/// loser's re-drive after the winner binds is answered by the ADOPT arm (a
/// `freshAgent.created` naming the winner's durable session, spawn count STILL 1).
#[tokio::test]
async fn two_clients_same_freshagent_session_ref_yield_exactly_one_sidecar() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    std::env::set_var("FAKE_SIDECAR_CREATE_DELAY_MS", "3000"); // second create lands mid-resume

    let durable = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    send_json(&mut ws_a, &claude_create_resume("req-lease-a", durable)).await;
    // Gate on the sidecar RECEIVING the create (the winner provably holds the lease and
    // is mid-delay) before the loser fires.
    env.await_log_row(Duration::from_secs(10), |r| r["msg"]["type"] == "create")
        .await;

    send_json(&mut ws_b, &claude_create_resume("req-lease-b", durable)).await;
    let failed = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.create.failed" && v["requestId"] == "req-lease-b"
    })
    .await;
    assert_eq!(failed["code"], "SESSION_RESERVED");
    assert_eq!(failed["retryable"], true);

    // The winner binds.
    let created = await_frame(&mut ws_a, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-lease-a"
    })
    .await;
    assert!(created["sessionId"].is_string());

    // Loser re-sends the SAME create (~the client's 1s floor): the ADOPT arm answers it
    // naming the winner's durable session -- and NO second sidecar spawned.
    tokio::time::sleep(Duration::from_millis(200)).await;
    send_json(&mut ws_b, &claude_create_resume("req-lease-b", durable)).await;
    let adopted = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-lease-b"
    })
    .await;
    assert_eq!(
        adopted["sessionId"], durable,
        "the adopt arm must name the winner's durable session"
    );

    let create_rows = env.create_rows();
    let distinct_pids: std::collections::HashSet<i64> = create_rows
        .iter()
        .filter_map(|r| r["pid"].as_i64())
        .collect();
    assert_eq!(
        distinct_pids.len(),
        1,
        "exactly one sidecar may spawn (rows: {create_rows:?})"
    );
}

/// The winner dying mid-resume must RELEASE the lease so the loser's own create
/// acquires and succeeds.
#[tokio::test]
async fn winner_dies_mid_resume_releases_the_lease_for_the_loser() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    let marker = env.dir.join("fail-once-marker");
    std::env::set_var("FAKE_SIDECAR_FAIL_ONCE_MARKER", &marker);

    let durable = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    // Client A claims; its sidecar exits nonzero on the first create -> guard releases.
    send_json(&mut ws_a, &claude_create_resume("req-die-a", durable)).await;
    let failed = await_frame(&mut ws_a, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.create.failed" && v["requestId"] == "req-die-a"
    })
    .await;
    assert_ne!(
        failed["code"], "SESSION_RESERVED",
        "the winner's own failure is a real create failure, not a reservation"
    );

    // Client B claims the same sessionRef -> Acquired -> the (now-succeeding) spawn.
    send_json(&mut ws_b, &claude_create_resume("req-die-b", durable)).await;
    let created = await_frame(&mut ws_b, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-die-b"
    })
    .await;
    assert!(created["sessionId"].is_string());
}

/// DESIGN DECISION (owner ratification flagged in the plan's "Validated decisions"):
/// the fresh-agent lease is ALWAYS ON (runtime-level, not capability-gated) because the
/// two-writers JSONL corruption it prevents is real regardless of client generation. A
/// NON-negotiated (legacy) loser receives `SESSION_RESERVED { retryable: true }` (V4:
/// it feeds a MANUAL Retry button -- a visible, human-recoverable stall); re-sending the
/// same create after the winner binds (the manual-Retry shape) converges via the ADOPT
/// arm; sidecar spawn count stays 1.
#[tokio::test]
async fn lease_applies_to_legacy_clients_and_retry_converges() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    std::env::set_var("FAKE_SIDECAR_CREATE_DELAY_MS", "3000");

    let durable = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, false).await; // legacy: no capabilities in hello
    let mut ws_b = connect(&url, false).await;

    send_json(&mut ws_a, &claude_create_resume("req-legacy-a", durable)).await;
    env.await_log_row(Duration::from_secs(10), |r| r["msg"]["type"] == "create")
        .await;

    send_json(&mut ws_b, &claude_create_resume("req-legacy-b", durable)).await;
    let failed = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.create.failed" && v["requestId"] == "req-legacy-b"
    })
    .await;
    assert_eq!(failed["code"], "SESSION_RESERVED");
    assert_eq!(failed["retryable"], true);

    await_frame(&mut ws_a, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-legacy-a"
    })
    .await;

    // The manual-Retry shape: the same create re-sent after the winner bound.
    send_json(&mut ws_b, &claude_create_resume("req-legacy-b", durable)).await;
    let adopted = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-legacy-b"
    })
    .await;
    assert_eq!(adopted["sessionId"], durable);

    let distinct_pids: std::collections::HashSet<i64> = env
        .create_rows()
        .iter()
        .filter_map(|r| r["pid"].as_i64())
        .collect();
    assert_eq!(distinct_pids.len(), 1, "spawn count must stay 1");
}

/// Codex leg: a loser's create-with-resume for a thread the winner already owns must
/// ADOPT (a `freshAgent.created` naming the thread, NO second app-server spawn) and the
/// winner's session must still work afterwards -- pinning the `finish_create` eviction
/// guard (on base it REPLACED the winner's entry, orphaning the winner's sidecar).
#[tokio::test]
async fn codex_loser_create_resume_adopts_and_never_clobbers_the_winner() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let codex_home = IsolatedCodexEnv::install();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .expect("fake-app-server fixture exists");
    let arg_log = codex_home.path().join("app-server-args.json");
    std::env::set_var("CODEX_CMD", format!("node {}", fixture.display()));
    std::env::set_var("FAKE_CODEX_APP_SERVER_ARG_LOG", &arg_log);

    let thread = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    let codex_create = |request_id: &str| {
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "sessionType": "freshcodex",
            "provider": "codex",
            "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": thread },
        })
    };

    // Winner resumes thread T and binds.
    send_json(&mut ws_a, &codex_create("req-cx-a")).await;
    let created = await_frame(&mut ws_a, Duration::from_secs(20), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-cx-a"
    })
    .await;
    assert_eq!(created["sessionId"], thread);
    let argv_after_winner =
        std::fs::read_to_string(&arg_log).expect("winner's app-server wrote its arg log");

    // Loser sends create-with-resume for T with a different requestId.
    send_json(&mut ws_b, &codex_create("req-cx-b")).await;
    let adopted = await_frame(&mut ws_b, Duration::from_secs(20), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-cx-b"
    })
    .await;
    assert_eq!(
        adopted["sessionId"], thread,
        "the loser must be answered by adopting the winner's live thread"
    );

    // NO second app-server spawned: each spawn rewrites the arg log with a fresh
    // ephemeral --listen port, so identical content == no new spawn.
    let argv_after_loser = std::fs::read_to_string(&arg_log).expect("arg log still present");
    assert_eq!(
        argv_after_winner, argv_after_loser,
        "a second app-server spawn would have rewritten the arg log"
    );

    // The winner's session still works afterwards (send on T is accepted -- the
    // eviction guard never let the loser clobber the live entry).
    send_json(
        &mut ws_a,
        &serde_json::json!({
            "type": "freshAgent.send",
            "provider": "codex",
            "sessionId": thread,
            "sessionType": "freshcodex",
            "text": "still alive?",
            "requestId": "send-cx-a",
        }),
    )
    .await;
    let accepted = await_frame(&mut ws_a, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.send.accepted" && v["requestId"] == "send-cx-a"
    })
    .await;
    assert_eq!(accepted["sessionId"], thread);

    std::env::remove_var("CODEX_CMD");
    std::env::remove_var("FAKE_CODEX_APP_SERVER_ARG_LOG");
}

/// An EXPIRED lease must be TREE-killed before release: the decoy grandchild (which a
/// raw single-pid SIGKILL of the sidecar would orphan) must be dead BEFORE the second
/// client's create converges -- i.e. the ownership sweep ran and confirmed empty prior
/// to force-release.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn expired_lease_kill_sweeps_the_sidecar_tree_before_release() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    std::env::set_var("FRESHELL_FRESH_AGENT_LEASE_TTL_MS", "100");
    std::env::set_var("FAKE_SIDECAR_CREATE_DELAY_MS", "5000");
    std::env::set_var("FAKE_SIDECAR_SPAWN_GRANDCHILD", "1");

    let durable = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    // Client A claims + spawns (kill handle set), never completes within the 100ms TTL.
    send_json(&mut ws_a, &claude_create_resume("req-ttl-a", durable)).await;
    let grandchild = env
        .await_log_row(Duration::from_secs(10), |r| {
            r["msg"]["type"] == "grandchild"
        })
        .await;
    let gpid = grandchild["msg"]["grandchildPid"]
        .as_i64()
        .expect("grandchild pid logged");
    assert!(
        std::path::Path::new(&format!("/proc/{gpid}")).exists(),
        "decoy grandchild must be alive before expiry"
    );
    // Let the TTL expire, then client B contends -> ExpiredNeedsKill -> tree kill.
    tokio::time::sleep(Duration::from_millis(300)).await;
    send_json(&mut ws_b, &claude_create_resume("req-ttl-b", durable)).await;

    // The DECOY GRANDCHILD dies (ownership sweep / tree-kill) BEFORE client B's created
    // lands. NOTE: a dead-but-unreaped ZOMBIE keeps its /proc entry (it reparents to the
    // container's pid 1, which never reaps it), so "dead" is read from the stat STATE —
    // gone, Z, or X — not from /proc existence.
    let grandchild_dead = |pid: i64| -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return true; // gone entirely
        };
        matches!(
            stat.rsplit(')')
                .next()
                .and_then(|rest| rest.split_whitespace().next()),
            Some("Z") | Some("X") | None
        )
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if grandchild_dead(gpid) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "grandchild survived: a raw single-pid kill orphans the writer (V6)"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ...and only then does B's own resume converge (force-release + re-claim ONCE).
    let created = await_frame(&mut ws_b, Duration::from_secs(20), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-ttl-b"
    })
    .await;
    assert!(created["sessionId"].is_string());
}

// ── Task 13: lease at the attach-resume seams ────────────────────────────────────────

/// A loser ATTACH racing a winner's create-with-resume for the same durable id must get
/// `freshAgent.error { code: "SESSION_RESERVED" }` (NOT the lost-session frame), and its
/// re-attach after the winner binds must converge to the live session (the Task 10b
/// rebind + ack) — sidecar spawn count still 1.
#[tokio::test]
async fn loser_attach_after_winner_binds_converges_to_the_live_session() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    std::env::set_var("FAKE_SIDECAR_CREATE_DELAY_MS", "3000");

    let durable = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    // Winner: create-with-resume, slow spawn (holds the lease mid-flight).
    send_json(&mut ws_a, &claude_create_resume("req-att-a", durable)).await;
    env.await_log_row(Duration::from_secs(10), |r| r["msg"]["type"] == "create")
        .await;

    // Loser: attach for the SAME durable id mid-spawn.
    let attach = serde_json::json!({
        "type": "freshAgent.attach",
        "provider": "claude",
        "sessionId": durable,
        "sessionType": "freshclaude",
        "sessionRef": { "provider": "claude", "sessionId": durable },
    });
    send_json(&mut ws_b, &attach).await;
    let err = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == durable
            && v["event"]["type"] == "freshAgent.error"
    })
    .await;
    assert_eq!(
        err["event"]["code"], "SESSION_RESERVED",
        "the attach loser must be RESERVED, never lost (INVALID_SESSION_ID would kill the pane)"
    );

    // Winner binds.
    await_frame(&mut ws_a, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-att-a"
    })
    .await;

    // Loser re-attaches: normal attach behavior against the live session (the Task 10b
    // rebind + ack — an idle snapshot stamped with the durable id).
    send_json(&mut ws_b, &attach).await;
    await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == durable
            && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    let distinct_pids: std::collections::HashSet<i64> = env
        .create_rows()
        .iter()
        .filter_map(|r| r["pid"].as_i64())
        .collect();
    assert_eq!(distinct_pids.len(), 1, "sidecar spawn count must stay 1");
}

// ── Task 13 Step 1a: the harness-owned fake `opencode serve` ────────────────────────
//
// No ws-level fake existed (V9): `OPENCODE_CMD` names a single executable that the
// serve manager spawns as `<cmd> serve --hostname H --port P`, so the fake is a
// shebang'd Node script implementing exactly the endpoints the attach-resume path
// calls: `GET /global/health`, `GET /global/event` (SSE, held open), and
// `GET /session/:id` (with an env-driven in-flight delay knob + a JSONL audit log).

const FAKE_OPENCODE_SERVE_SOURCE: &str = r#"#!/usr/bin/env node
const http = require('node:http')
const fs = require('node:fs')
function argValue(name) {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
const hostname = argValue('--hostname') || '127.0.0.1'
const port = Number(argValue('--port'))
const audit = process.env.FAKE_OPENCODE_SERVE_AUDIT_LOG || ''
function log(row) {
  if (!audit) return
  try { fs.appendFileSync(audit, JSON.stringify({ pid: process.pid, t: Date.now(), ...row }) + '\n') } catch {}
}
const delayMs = Number(process.env.FAKE_OPENCODE_SERVE_SESSION_GET_DELAY_MS || 0)
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${hostname}:${port}`)
  log({ method: req.method, path: url.pathname })
  if (url.pathname === '/global/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (url.pathname === '/event' || url.pathname === '/global/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(':ok\n\n')
    return // held open
  }
  const m = url.pathname.match(/^\/session\/([^/]+)$/)
  if (m && req.method === 'GET') {
    const id = decodeURIComponent(m[1])
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, directory: '/tmp', title: 'fake opencode session' }))
    }
    if (delayMs > 0) setTimeout(reply, delayMs)
    else reply()
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
server.listen(port, hostname, () => { log({ event: 'listen', hostname, port }) })
"#;

struct FakeOpencodeServeEnv {
    dir: std::path::PathBuf,
}

impl FakeOpencodeServeEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-opencode-serve-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake serve temp dir");
        let script = dir.join("fake-opencode-serve");
        std::fs::write(&script, FAKE_OPENCODE_SERVE_SOURCE).expect("write fake serve");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake serve");
        }
        std::env::set_var("OPENCODE_CMD", &script);
        std::env::set_var("FAKE_OPENCODE_SERVE_AUDIT_LOG", dir.join("audit.jsonl"));
        Self { dir }
    }

    fn audit_rows(&self) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join("audit.jsonl")) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("audit row parses"))
            .collect()
    }

    async fn await_audit_row(&self, budget: Duration, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            if let Some(row) = self.audit_rows().into_iter().find(&pred) {
                return row;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "audit row did not appear within budget"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for FakeOpencodeServeEnv {
    fn drop(&mut self) {
        for var in [
            "OPENCODE_CMD",
            "FAKE_OPENCODE_SERVE_AUDIT_LOG",
            "FAKE_OPENCODE_SERVE_SESSION_GET_DELAY_MS",
        ] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Two clients attach-resuming the same durable `ses_*` id concurrently: exactly one
/// resume proceeds; the loser gets `freshAgent.error{SESSION_RESERVED}`; and the SHARED
/// `opencode serve` sidecar is never killed by the lease (it hosts other sessions).
#[tokio::test]
async fn opencode_attach_resume_is_serialized_without_touching_the_shared_sidecar() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    std::env::set_var("FAKE_OPENCODE_SERVE_SESSION_GET_DELAY_MS", "2500");

    let ses = "ses_lease_serialized_1";
    let url = spawn_server().await;
    let mut ws_a = connect(&url, true).await;
    let mut ws_b = connect(&url, true).await;

    let attach = serde_json::json!({
        "type": "freshAgent.attach",
        "provider": "opencode",
        "sessionId": ses,
        "sessionType": "freshopencode",
        "cwd": "/tmp",
    });

    // Client A: attach-resume; the fake holds its GET /session/:id in flight 2.5s.
    send_json(&mut ws_a, &attach).await;
    env.await_audit_row(Duration::from_secs(30), |r| {
        r["path"] == format!("/session/{ses}")
    })
    .await;
    let serve_pid = env
        .await_audit_row(Duration::from_secs(5), |r| r["event"] == "listen")
        .await["pid"]
        .as_i64()
        .expect("serve pid");

    // Client B: same durable id mid-resume -> SESSION_RESERVED (never lost).
    send_json(&mut ws_b, &attach).await;
    let err = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == ses
            && v["event"]["type"] == "freshAgent.error"
    })
    .await;
    assert_eq!(err["event"]["code"], "SESSION_RESERVED");

    // The winner's resume completes (idle snapshot).
    await_frame(&mut ws_a, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == ses
            && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    // Loser converges on re-attach (now tracked locally: snapshot, no error).
    send_json(&mut ws_b, &attach).await;
    await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["sessionId"] == ses
            && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    // The shared serve sidecar was never killed: same pid, still running (not Z/X).
    let stat = std::fs::read_to_string(format!("/proc/{serve_pid}/stat"))
        .expect("shared opencode serve must still be alive");
    let state = stat
        .rsplit(')')
        .next()
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or("?");
    assert!(
        state != "Z" && state != "X",
        "the shared opencode serve must never be killed by the lease (state: {state})"
    );

    // Exactly ONE resume reached the serve for this session id.
    let gets = env
        .audit_rows()
        .into_iter()
        .filter(|r| r["path"] == format!("/session/{ses}"))
        .count();
    assert_eq!(
        gets, 1,
        "the loser must never issue a second in-flight resume"
    );
}

/// ejh6: a `freshAgent.create` carrying `resumeSessionId` is rejected with
/// `freshAgent.create.failed{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text.
/// No sidecar spawn. Create has a requestId, so the rejection uses the
/// create-failed envelope.
#[tokio::test]
async fn legacy_reject_freshagent_create() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    let url = spawn_server().await;
    let mut ws = connect(&url, true).await;

    // ejh6 presence (finding 9): rejection fires for any string, including "".
    for (label, legacy, req_id) in [
        ("string", "legacy-durable-id", "req-fa-legacy-create"),
        ("empty-string", "", "req-fa-legacy-create-empty"),
    ] {
        send_json(
            &mut ws,
            &serde_json::json!({
                "type": "freshAgent.create",
                "requestId": req_id,
                "sessionType": "freshclaude",
                "provider": "claude",
                "cwd": "/tmp",
                "resumeSessionId": legacy,
            }),
        )
        .await;

        let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
            v["type"] == "freshAgent.create.failed" && v["requestId"].as_str() == Some(req_id)
        })
        .await;
        assert_eq!(
            failed["code"],
            serde_json::json!("FRESH_AGENT_CREATE_FAILED"),
            "{label}: create-failed family code: {failed}"
        );
        assert_eq!(
            failed["message"],
            serde_json::json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text: {failed}"
        );
        assert_eq!(failed["retryable"], serde_json::json!(false));
    }
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn for a rejected legacy create: {:?}",
        env.create_rows()
    );
}

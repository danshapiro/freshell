//! Task 13b (V7, binding): the terminal and fresh-agent resume domains are NOT
//! disjoint -- "Reopen as freshclaude / Claude CLI" makes the same `(provider,
//! sessionId)` reachable from BOTH kinds. Each side must see the other's live
//! sessions, or two lease maps both report "working" on one JSONL (the
//! one-writer doctrine's "silently wrong").
//!
//! Two directions, two guards:
//! 1. A `freshAgent.create` resuming S while a live terminal PTY owns S is refused
//!    with `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }`
//!    and ZERO sidecar spawns (the terminal may be closing -- retryable).
//! 2. A `terminal.create` whose wire sessionRef names S while a live sidecar owns S
//!    is refused with the D7 guard's EXISTING rejection frame
//!    (`error { code: "RESTORE_UNAVAILABLE" }`), same as a live PTY.
//!
//! Harness: the lease-suite fake claude sidecar (request-log knob) + the common
//! sleeper CLI spec so terminal claude creates genuinely spawn a Running PTY.
//! Run via `scripts/sandbox-test.sh` per the destructive-suite convention of the
//! sibling lease suite (shared file-level ruling; these two tests kill nothing).

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes the tests in this file: they mutate process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FAKE_SIDECAR_*`).
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── fake claude sidecar (request-log knob only; duplicated per-file per convention) ──

const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import readline from 'node:readline'
import fs from 'node:fs'

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
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

struct FakeSidecarEnv {
    dir: std::path::PathBuf,
}

impl FakeSidecarEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-cross-kind-liveness-{}",
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

    fn create_rows(&self) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join("requests.jsonl")) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).expect("request log row parses"))
            .filter(|r| r["msg"]["type"] == "create")
            .collect()
    }
}

impl Drop for FakeSidecarEnv {
    fn drop(&mut self) {
        for var in [
            "FRESHELL_CLAUDE_SIDECAR",
            "FRESHELL_CLAUDE_NODE",
            "FAKE_SIDECAR_REQUEST_LOG",
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

/// Sleeper CLI spec (duplicated from `tests/common/mod.rs` -- this file needs its own
/// server builder because the shared one disables `freshAgent.enabled`).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    // DEFLAKE (f3wp refresh): the path must be unique PER CALL, not per
    // process. Both tests in this binary build a `claude` spec, so a
    // `{name}-{pid}`-only path is SHARED between them -- and test 2's
    // `fs::write` then races test 1's still-running PTY spawn: Linux holds
    // deny-write on a file while it is being `execve`d, so under load the
    // write fails with ETXTBSY ("Text file busy"). A fresh per-call path
    // (nanos + thread id) can never collide with an in-flight exec.
    let script_path = std::env::temp_dir().join(format!(
        "freshell-cross-kind-sleeper-{name}-{}-{}.sh",
        std::process::id(),
        uuid_like_suffix()
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

/// DEFLAKE (f3wp refresh): two `sleeper_cli_spec` calls in one process must
/// never share a script path. With a `{name}-{pid}`-only path, test 2's
/// `fs::write` races test 1's still-in-flight `execve` of the SAME file --
/// Linux denies writes to a file mid-exec, so under load the write fails with
/// `ETXTBSY` ("Text file busy", observed 2026-07-28 under the f3wp 10x load).
#[test]
fn sleeper_cli_spec_paths_are_unique_per_call() {
    let first = sleeper_cli_spec("claude");
    let second = sleeper_cli_spec("claude");
    assert_ne!(
        first.default_cmd, second.default_cmd,
        "same-name specs in one process must not share a script path -- \
         a shared path lets a later write race an earlier spawn's execve (ETXTBSY)"
    );
}

fn test_settings_value() -> serde_json::Value {
    json!({
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

/// Server with BOTH kinds live: a sleeper `claude` terminal CLI spec AND the
/// fresh-agent runtimes (freshAgent enabled). Returns the ws URL + the registry.
async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();

    // The terminal-liveness probe the fresh-agent runtimes consult (Task 13b) --
    // the SAME join the D7 create-rung guard performs (identity owner + registry row).
    let terminal_liveness: freshell_freshagent::TerminalLivenessProbe = {
        let identity = identity.clone();
        let registry = registry.clone();
        Arc::new(move |provider: &str, session_id: &str| {
            let identity_owner_live =
                identity
                    .find_by_session(provider, session_id)
                    .is_some_and(|owner| {
                        registry.probe(&owner.terminal_id).is_some_and(|r| {
                            r.status == freshell_protocol::TerminalRunStatus::Running
                        })
                    });
            identity_owner_live
                || registry.directory().into_iter().any(|entry| {
                    entry.mode == provider
                        && entry.resume_session_id.as_deref() == Some(session_id)
                        && entry.status == freshell_protocol::TerminalRunStatus::Running
                })
        })
    };

    let mut fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
    fresh_claude.set_terminal_liveness(Arc::clone(&terminal_liveness));
    let mut fresh_codex = freshell_freshagent::FreshCodexState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
        json!({ "freshAgent": { "enabled": true } }),
    );
    fresh_codex.set_terminal_liveness(Arc::clone(&terminal_liveness));
    let mut fresh_opencode =
        freshell_freshagent::FreshOpencodeState::new(freshell_freshagent::FreshAgentState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
        ));
    fresh_opencode.set_terminal_liveness(Arc::clone(&terminal_liveness));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity,
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex,
        fresh_claude,
        fresh_opencode,
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![sleeper_cli_spec("claude")]),
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

    (format!("ws://{addr}/ws"), registry)
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "capabilities": { "paneReconcileV1": true, "paneReconcileFreshAgentV1": true },
    });
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

// ── the red tests ────────────────────────────────────────────────────────────────────

/// Direction 1 (V7 scenario B): a live terminal PTY owns `(claude, S)`; a
/// `freshAgent.create { resumeSessionId: S }` must be refused with
/// `SESSION_RESERVED { retryable: true }` and spawn ZERO sidecars.
#[tokio::test]
async fn freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let (url, _registry) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh claude terminal reaches Running, owning preallocated session S.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-owner-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-term-owner-1"
    })
    .await;
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude terminal carries a sessionRef")
        .to_string();

    // 2. A fresh-agent resume of the SAME session id (the "Reopen as freshclaude"
    //    abort-path shape) must be refused -- never a second writer on S's JSONL.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-cross-1",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": session_id,
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "freshAgent.create.failed" || v["type"] == "freshAgent.created")
            && v["requestId"] == "req-fa-cross-1"
    })
    .await;
    assert_eq!(
        failed["type"], "freshAgent.create.failed",
        "a live terminal PTY owns {session_id}: the fresh-agent resume must be refused, got {failed}"
    );
    assert_eq!(failed["code"], "SESSION_RESERVED");
    assert_eq!(
        failed["retryable"], true,
        "retryable -- the terminal may be closing"
    );

    // 3. ZERO sidecar spawns.
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn while the terminal owns the session: {:?}",
        env.create_rows()
    );
}

/// Direction 2: a live freshclaude sidecar owns `(claude, S)`; a `terminal.create`
/// whose wire sessionRef names S must be refused with the D7 guard's existing
/// rejection frame (`RESTORE_UNAVAILABLE`) and spawn no PTY.
#[tokio::test]
async fn terminal_create_is_refused_while_a_live_sidecar_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let durable = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let (url, registry) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh-agent resume of S goes live (the fake sidecar answers `created`).
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-1",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": durable,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-fa-owner-1"
    })
    .await;
    assert_eq!(env.create_rows().len(), 1, "the sidecar owns S now");

    // 2. A terminal.create restoring the SAME session id (the D7 direct
    //    wire-sessionRef rung) must be refused -- the sidecar is the one writer.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-cross-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "error" || v["type"] == "terminal.created")
            && v["requestId"] == "req-term-cross-1"
    })
    .await;
    assert_eq!(
        frame["type"], "error",
        "a live sidecar owns {durable}: terminal.create must be refused, got {frame}"
    );
    assert_eq!(frame["code"], "RESTORE_UNAVAILABLE");
    assert!(
        frame["message"]
            .as_str()
            .is_some_and(|m| m.contains(durable)),
        "message must name the live session: {frame}"
    );

    // 3. No PTY spawned `claude --resume S`.
    assert!(
        !registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(durable)
        }),
        "no terminal may own {durable} -- the sidecar is the one writer"
    );
}

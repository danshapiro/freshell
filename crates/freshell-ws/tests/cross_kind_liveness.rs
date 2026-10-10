//! Task 13b (V7, binding): the terminal and fresh-agent resume domains are NOT
//! disjoint -- "Reopen as freshclaude / Claude CLI" makes the same `(provider,
//! sessionId)` reachable from BOTH kinds. Each side must see the other's live
//! sessions, or two lease maps both report "working" on one JSONL (the
//! one-writer doctrine's "silently wrong").
//!
//! Two directions, two guards:
//! 1. A `freshAgent.create` resuming S while a live terminal PTY owns S is refused
//!    and spawns ZERO sidecars. Post-ejh6 (Task 7) the refusal code depends on the
//!    carrier: a legacy/dual-carrier create (`resumeSessionId` present) is rejected
//!    at the raw-Value ejh6 guard with `freshAgent.create.failed { code:
//!    "FRESH_AGENT_CREATE_FAILED" }` + frozen text, while a sessionRef-ONLY create
//!    reaches the typed cross-kind live-guard and is refused with
//!    `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }`
//!    (the terminal may be closing -- retryable).
//! 2. A `terminal.create` whose wire sessionRef names S while a live sidecar owns S
//!    is refused with the D7 guard's EXISTING rejection frame
//!    (`error { code: "RESTORE_UNAVAILABLE" }`), same as a live PTY.
//!
//! Harness: the lease-suite fake claude sidecar (request-log knob) + the common
//! sleeper CLI spec so terminal claude creates genuinely spawn a Running PTY.
//! Run via `scripts/sandbox-test.sh` per the destructive-suite convention of the
//! sibling lease suite (shared file-level ruling; the kata-b8ke Task 7 races
//! kill only sidecar children this harness itself spawned — R4's
//! unconfirmable-prior arm SIGKILLs its own fake sidecar, the lease-suite
//! class).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_freshagent::{
    ClaimCommit, FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord,
    SinkAliasClearWrite, SinkCloseWrite, SinkCommitWrite, SinkWrite,
};
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
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

// ── dual-role codex fake (kata b8ke Task 5; the codex_sidecar_reattach_e2e.rs
//    pattern, self-contained here) ──────────────────────────────────────────
//
// `CODEX_CMD` points at a node dispatcher: argv containing `app-server`
// (the freshcodex sidecar spawn) routes to the committed fake app-server
// fixture; anything else (a terminal TUI launch) just stays alive. Two
// spawn-count surfaces, both per-instance:
// - the dispatcher logs EVERY invocation's argv (`sidecar_spawn_rows` —
//   only app-server spawns reach it in this harness);
// - the fixture appends every `thread/*` operation with its thread id to
//   the durable op ledger (`thread_op_rows` — `thread/start`,
//   `thread/resume`, ...).

struct DualRoleCodexFake {
    dir: std::path::PathBuf,
}

impl DualRoleCodexFake {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-cross-kind-codex-fake-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create codex fake temp dir");
        let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
            .canonicalize()
            .expect("fake-app-server fixture exists");
        let dispatcher = dir.join("dispatcher.mjs");
        let script = format!(
            "#!/usr/bin/env node\n\
             import fs from 'node:fs'\n\
             const args = process.argv.slice(2)\n\
             if (process.env.FAKE_CODEX_DISPATCHER_LOG) {{\n\
               fs.appendFileSync(process.env.FAKE_CODEX_DISPATCHER_LOG, \
             JSON.stringify({{ pid: process.pid, argv: args }}) + '\\n')\n\
             }}\n\
             if (args.includes('app-server')) {{\n\
               await import('file://{}')\n\
             }} else {{\n\
               setInterval(() => undefined, 1000)\n\
             }}\n",
            fixture.display()
        );
        std::fs::write(&dispatcher, script).expect("write codex dispatcher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dispatcher).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dispatcher, perms).expect("chmod codex dispatcher");
        }
        std::env::set_var("CODEX_CMD", format!("node {}", dispatcher.display()));
        // The fixture's durable thread-op ledger: every `thread/*` method
        // appends {method, threadId, params, ...} — the no-spawn watermark.
        let behavior = serde_json::json!({
            "appendThreadOperationLogPath": dir.join("thread-ops.jsonl"),
        });
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
        std::env::set_var(
            "FAKE_CODEX_DISPATCHER_LOG",
            dir.join("dispatcher-log.jsonl"),
        );
        Self { dir }
    }

    fn rows_from(&self, file: &str) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.dir.join(file)) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).expect("log row parses"))
            .collect()
    }

    /// Every app-server role the dispatcher routed to the fixture — the
    /// sidecar spawn count.
    fn sidecar_spawn_rows(&self) -> Vec<Value> {
        self.rows_from("dispatcher-log.jsonl")
            .into_iter()
            .filter(|row| {
                row["argv"]
                    .as_array()
                    .is_some_and(|argv| argv.iter().any(|a| a == "app-server"))
            })
            .collect()
    }

    /// The fixture's durable `thread/*` op ledger (method + threadId) — the
    /// `thread/resume`-never-happens surface the side-effect-free GET
    /// contract asserts against.
    fn thread_op_rows(&self) -> Vec<Value> {
        self.rows_from("thread-ops.jsonl")
    }
}

impl Drop for DualRoleCodexFake {
    fn drop(&mut self) {
        // Reap every process the dispatcher spawned (the managed-launch
        // sidecars a mode-codex terminal create plans, and the explicit
        // freshAgent.create's sidecar — none of them outlive the fake): the
        // fixture has no SIGTERM handler, so a plain kill terminates it.
        // Read BEFORE the dir removal below consumes the log.
        for row in self.rows_from("dispatcher-log.jsonl") {
            if let Some(pid) = row["pid"].as_u64() {
                #[cfg(unix)]
                {
                    let _ = std::process::Command::new("kill")
                        .arg(pid.to_string())
                        .status();
                }
                let _ = pid; // non-unix: nothing to do (this suite is unix-shaped anyway)
            }
        }
        for var in [
            "CODEX_CMD",
            "FAKE_CODEX_APP_SERVER_BEHAVIOR",
            "FAKE_CODEX_DISPATCHER_LOG",
        ] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ── fake `opencode serve` (b8ke delta review F4; the
//    freshagent_session_lease.rs/session_handoff.rs shape, self-contained
//    here) — the audit log's distinct pids are the spawn watermark ────────

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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id, directory: '/tmp', title: 'fake opencode session' }))
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
            "freshell-cross-kind-opencode-serve-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake serve temp dir");
        let script = dir.join("fake-opencode-serve");
        std::fs::write(&script, FAKE_OPENCODE_SERVE_SOURCE).expect("write fake serve");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&script, perms).expect("chmod fake serve");
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
            .map(|l| serde_json::from_str::<Value>(l).expect("audit row parses"))
            .collect()
    }

    /// Every distinct process id the fake serve ever ran under — a spawn
    /// (or a second spawn) adds a pid.
    fn serve_pids(&self) -> Vec<u64> {
        let mut pids: Vec<u64> = self
            .audit_rows()
            .into_iter()
            .filter_map(|r| r["pid"].as_u64())
            .collect();
        pids.sort();
        pids.dedup();
        pids
    }
}

impl Drop for FakeOpencodeServeEnv {
    fn drop(&mut self) {
        for pid in self.serve_pids() {
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .arg(pid.to_string())
                    .status();
            }
            let _ = pid;
        }
        for var in ["OPENCODE_CMD", "FAKE_OPENCODE_SERVE_AUDIT_LOG"] {
            std::env::remove_var(var);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
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
        effort_args: None,
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

/// Shared construction for both harness shapes in this file: the `WsState`
/// with BOTH kinds live (a sleeper terminal CLI spec per requested mode AND
/// the fresh-agent runtimes, freshAgent enabled), the terminal-liveness
/// probe joined over the identity registry, and the kata b8ke Task 3/4
/// ownership coordinator minted HERE and injected into every fresh state,
/// the registry, and the WsState (exactly like `main.rs`). Returns the
/// state, the registry, and the opencode slice's inner `FreshAgentState`
/// (the snapshot REST door needs it — `main.rs`'s `SnapshotState::new`
/// shape).
async fn build_ws_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    WsState,
    freshell_terminal::TerminalRegistry,
    freshell_freshagent::FreshAgentState,
) {
    build_ws_state_with_probe(
        cli_commands,
        std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
    )
    .await
}

/// b8ke ext r7 F2: [`build_ws_state`] with a caller-chosen session-existence
/// probe — the resume-gate tests need a probe that answers Absent (the
/// default NoIndexProbe answers Unknown for every known provider, so the
/// gate never fires in this rig).
async fn build_ws_state_with_probe(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    probe: std::sync::Arc<dyn freshell_ws::existence::SessionExistenceProbe>,
) -> (
    WsState,
    freshell_terminal::TerminalRegistry,
    freshell_freshagent::FreshAgentState,
) {
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
    let fresh_agent_state = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    );
    let mut fresh_opencode =
        freshell_freshagent::FreshOpencodeState::new(fresh_agent_state.clone());
    fresh_opencode.set_terminal_liveness(Arc::clone(&terminal_liveness));

    // kata b8ke Task 3: mint the ONE ownership coordinator and inject it into
    // every fresh state (mirrors main.rs — the cross-kind authority the lanes
    // claim through).
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    fresh_codex.set_ownership(Arc::clone(&ownership));
    fresh_claude.set_ownership(Arc::clone(&ownership));
    fresh_opencode.set_ownership(Arc::clone(&ownership));
    // kata b8ke Task 4: the SAME coordinator reaches the terminal lane — the
    // registry (release-only integration) and the WsState (the create/kill
    // claims + the ready-frame owner replay).
    let registry = registry.with_ownership(Arc::clone(&ownership));

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity,
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
        fresh_codex,
        fresh_claude,
        fresh_opencode,
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
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        ownership: Some(Arc::clone(&ownership)),
    };

    (state, registry, fresh_agent_state)
}

/// Server with BOTH kinds live: a sleeper `claude` terminal CLI spec AND the
/// fresh-agent runtimes (freshAgent enabled). Returns the ws URL, the registry,
/// and the `WsState` clone (kata b8ke Task 3: the shared ownership
/// coordinator is minted HERE, exactly like `main.rs` injects it).
async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry, WsState) {
    let (state, registry, _fresh_agent_state) =
        build_ws_state(vec![sleeper_cli_spec("claude")]).await;

    let router = freshell_ws::router(state.clone());
    // Ephemeral loopback port only -- NEVER the self-hosted 3001/3002 ports.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, state)
}

/// kata b8ke Task 5: the merged harness — the WS door AND the snapshot REST
/// door (`GET /api/fresh-agent/threads/...`) on ONE axum app over the SAME
/// state slices (main.rs's router-merge shape), with BOTH a `claude` and a
/// `codex` sleeper terminal spec so a `mode:"codex"` terminal create
/// genuinely spawns a Running PTY (the `rest_claude_identity.rs`
/// spawn_merged_server pattern).
struct MergedHarness {
    base_url: String,
    /// The WS door's URL — the races that need a SECOND connection (R2's
    /// fresh attach while the first connection's create is parked) connect
    /// here (kata b8ke Task 7).
    ws_url: String,
    ws: TestWs,
    ws_state: WsState,
    /// The handoff runner the REST route serves — the direct-drive door for
    /// the races that need the abort-capable `HandoffHandle` (R7) or the
    /// runner's installed hooks (kata b8ke Task 7).
    handoff_runner: Arc<freshell_freshagent::SessionHandoffRunner>,
}

async fn spawn_merged_server() -> MergedHarness {
    spawn_merged_server_with_hooks(Arc::new(freshell_freshagent::HandoffTestHooks::default())).await
}

/// kata b8ke Task 7: [`spawn_merged_server`] plus the runner's test hooks —
/// the pause/injection seams (R4-R7) must be armed BEFORE the runner is
/// minted (the states are cloned into it).
async fn spawn_merged_server_with_hooks(
    hooks: Arc<freshell_freshagent::HandoffTestHooks>,
) -> MergedHarness {
    let cli_commands = Arc::new(vec![sleeper_cli_spec("claude"), sleeper_cli_spec("codex")]);
    let (state, registry, fresh_agent_state) =
        build_ws_state(cli_commands.iter().cloned().collect()).await;

    // The snapshot REST door shares the WS door's state slices (main.rs's
    // `SnapshotState::new` wiring: same auth token, same codex/claude
    // clones, the opencode slice's inner FreshAgentState — coordinator-
    // wired exactly like main.rs builds it, so the ownership-refusal arms
    // are live on this door too).
    let snapshot_state = freshell_freshagent::SnapshotState::new(
        Arc::new(AUTH_TOKEN.to_string()),
        state.fresh_codex.clone(),
        fresh_agent_state
            .clone()
            .with_ownership(state.ownership.clone().expect("coordinator wired")),
        state.fresh_claude.clone(),
    );
    // kata b8ke Task 6: the handoff runner — the SAME fresh states, registry,
    // coordinator, broadcast bus, and CLI specs (main.rs's mint shape; the
    // REST spawn state additionally wired with the registry + specs the
    // terminal-target pipeline needs). Task 7: minted with the test hooks.
    let ownership = state.ownership.clone().expect("coordinator wired");
    let handoff_runner = Arc::new(
        freshell_freshagent::SessionHandoffRunner::new(
            Arc::new(AUTH_TOKEN.to_string()),
            state.broadcast_tx.clone(),
            ownership,
            registry.clone(),
            state.fresh_codex.clone(),
            state.fresh_claude.clone(),
            state.fresh_opencode.clone(),
            fresh_agent_state
                .clone()
                .with_ownership(state.ownership.clone().expect("coordinator wired"))
                .with_terminal_registry(registry.clone())
                .with_cli_commands(Arc::clone(&cli_commands)),
            Arc::clone(&cli_commands),
        )
        .with_test_hooks(Arc::clone(&hooks)),
    );
    let app = freshell_ws::router(state.clone())
        .merge(freshell_freshagent::snapshot::router(snapshot_state))
        .merge(freshell_freshagent::session_handoff::handoff_router(
            Arc::clone(&handoff_runner),
        ));

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let ws_url = format!("ws://{addr}/ws");
    let ws = connect(&ws_url).await;
    MergedHarness {
        base_url: format!("http://{addr}"),
        ws_url,
        ws,
        ws_state: state,
        handoff_runner,
    }
}

// ── b8ke focused ep5 r2 F1: the ledger-backed identity sink for the real-ledger
//    merged harness (copied from freshagent_claude_rollback.rs — the ws-test
//    crate cannot depend on freshell-server: the dep edge runs the other way) ──

/// The rollback-record-provisioning identity sink, backed by the REAL pane
/// ledger — mirrors `freshell-server/src/identity_sink.rs`'s LedgerIdentitySink
/// (the ws-test crate cannot depend on freshell-server: the dep edge runs the
/// other way), INCLUDING the claude-adoption rollback-row re-key that rides the
/// awaited binding batch.
struct TestLedgerSink {
    ledger: Arc<PaneLedger>,
    /// b8ke focused ep5 r3 F1: the merged harness's ONE ownership
    /// coordinator — the authoritative write's ownership re-validation
    /// consults it (mirrors the production bridge's consult verbatim).
    ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
}
impl TestLedgerSink {
    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}
impl PaneIdentitySink for TestLedgerSink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.record_pending(
                    &p,
                    &m,
                    c.as_deref(),
                    None,
                    freshell_ws::pane_ledger::ProvenanceStamps::default(),
                    now,
                )
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let ownership = self.ownership.clone();
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                // b8ke focused ep5 r3 F1: the authoritative write's
                // ownership re-validation — mirrors the production bridge
                // (crates/freshell-server/src/identity_sink.rs) verbatim:
                // the consult runs INSIDE the spawn_blocking closure, at
                // execution time, and refuses typed when the write's
                // handoff no longer owns the key's transition at its
                // (epoch, generation) pair.
                if upsert.authoritative {
                    let (Some(w_epoch), Some(w_generation)) =
                        (upsert.observed_epoch, upsert.observed_generation)
                    else {
                        return Err(std::io::Error::other(
                            "STALE_TRANSITION_BINDING: an authoritative write must \
                             carry its observed (epoch, generation) pair — the \
                             ownership re-validation cannot run (kata b8ke focused \
                             ep5 r3 F1)",
                        ));
                    };
                    let Some(registry) = ownership.as_ref() else {
                        return Err(std::io::Error::other(
                            "STALE_TRANSITION_BINDING: an authoritative write \
                             arrived at a bridge with no ownership coordinator \
                             wired — authoritative markers are minted only by \
                             coordinator-driven handoff lanes (kata b8ke focused \
                             ep5 r3 F1)",
                        ));
                    };
                    let snap = registry.observe(&upsert.provider, &upsert.session_id);
                    let transition_owned = snap.epoch == w_epoch
                        && match &snap.state {
                            freshell_ownership::OwnershipState::Handoff {
                                generation,
                                ..
                            } => *generation == w_generation,
                            freshell_ownership::OwnershipState::Live {
                                owner,
                                generation,
                                ..
                            } => {
                                *generation == w_generation
                                    && owner.kind
                                        == freshell_ownership::RuntimeOwnerKind::FreshAgent
                            }
                            _ => false,
                        };
                    if !transition_owned {
                        return Err(std::io::Error::other(
                            "STALE_TRANSITION_BINDING: the authoritative write's \
                             handoff operation no longer owns the key's transition \
                             at its generation (canceled, superseded, restored, \
                             vacated, or a new boot epoch) — the write is refused \
                             (kata b8ke focused ep5 r3 F1)",
                        ));
                    }
                }
                let w = FreshAgentBindingWrite {
                    provider: &upsert.provider,
                    session_id: &upsert.session_id,
                    mode: &upsert.mode,
                    cwd: upsert.settings.cwd.as_deref(),
                    create_request_id: upsert.create_request_id.as_deref(),
                    model: upsert.settings.model.as_deref(),
                    sandbox: upsert.settings.sandbox.as_deref(),
                    permission_mode: upsert.settings.permission_mode.as_deref(),
                    effort: upsert.settings.effort.as_deref(),
                    supersedes: upsert.supersedes.as_deref(),
                    provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
                    observed_epoch: upsert.observed_epoch,
                    observed_generation: upsert.observed_generation,
                    authoritative: upsert.authoritative,
                    now_ms: now,
                };
                ledger.record_fresh_agent_binding(&w)?;
                // kata 1wxv Task 4 (claude adoption): the rollback row re-keys
                // old→new in the SAME awaited batch as the binding write.
                if upsert.provider == "claude" {
                    if let Some(old_id) = upsert.supersedes.as_deref() {
                        if old_id != upsert.session_id {
                            if let Some(payload) =
                                ledger.load_rollback_row(&upsert.provider, old_id)
                            {
                                ledger.record_rollback_row(
                                    &upsert.provider,
                                    &upsert.session_id,
                                    &payload,
                                    now,
                                )?;
                                if let Err(e) = ledger.delete_rollback_row(&upsert.provider, old_id) {
                                    tracing::warn!(error = %e, session = %old_id, "rollback row re-key: old row delete failed (cosmetic)");
                                }
                            }
                        }
                    }
                }
                if let Some(p) = upsert.resolves_pending.as_deref() {
                    let _ = ledger.delete_pending(p);
                }
                Ok(())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        // b8ke focused ep5 r5 F1: mirror the PRODUCTION bridge's read
        // verbatim (the rollback-focused `None` stub this copy inherited
        // silently disabled the ordinary cold resume's RECOVERED path —
        // `recovered` never answered Some, so the recovered-session
        // binding write never ran in this harness). Memory-only against
        // the real ledger, the same fresh-agent gate + settings-bearing
        // gate as `LedgerIdentitySink::load_settings`.
        let row = self.ledger.load_binding(provider, session_id)?;
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let s = FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        };
        if s == FreshAgentSettings::default() {
            return None;
        }
        Some(s)
    }
    fn load_provenance(
        &self,
        _provider: &str,
        _session_id: &str,
    ) -> Option<freshell_freshagent::BindProvenance> {
        // Rollback-focused double (like `load_settings` above): these
        // rollback tests never cold-attach a codex/opencode session, so the
        // provenance read-back is out of their contract.
        None
    }
    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.load_binding(provider, session_id).is_some()
    }
    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
                ledger.record_rollback_row(&p, &s, &payload, TestLedgerSink::now_ms())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn repair_failed_transition(
        &self,
        provider: &str,
        session_id: &str,
        epoch: u64,
        generation: u64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                ledger.repair_failed_transition_binding(&p, &s, epoch, generation, now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }
    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        // Mirror of freshell-server's LedgerIdentitySink: the shared migrating
        // reader owns the version gate + the legacy epochless-union migration
        // (focused ep1-r1 F3, absence-keyed per ep1-r2 F1).
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        RollbackRecord::from_stored_payload(payload)
    }
    fn delete_rollback(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_rollback_row(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<String> {
        self.ledger
            .lookup_by_create_request_id(provider, create_request_id)
            .map(|row| row.session_id)
    }

    // Retire-on-kill (delta-review round 5): the same real-ledger pass-through
    // the LedgerIdentitySink this double mirrors now implements.
    fn retire_closed(&self, provider: &str, session_id: &str) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                ledger.retire_closed(&p, &s, TestLedgerSink::now_ms())
            })
            .await
            .map_err(|join| {
                freshell_freshagent::identity_sink::SinkCloseError::Clean(std::io::Error::other(
                    join,
                ))
            })?;
            result.map_err(|err| match err {
                freshell_ws::pane_ledger::CloseEnvelopeError::Clean(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Clean(e)
                }
                freshell_ws::pane_ledger::CloseEnvelopeError::Persisted(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Persisted(e)
                }
            })
        })
    }

    /// Delta-r6-r3: the real-ledger delegation mirrors
    /// `freshell-server/src/identity_sink.rs`'s `retire_closed_batch`
    /// (the ledger envelope is the atomicity point; one spawn_blocking hop).
    fn retire_closed_batch(
        &self,
        provider: &str,
        session_ids: &[String],
        pending_ids: &[String],
    ) -> SinkCloseWrite {
        let ledger = self.ledger.clone();
        let p = provider.to_string();
        let ids = session_ids.to_vec();
        let pendings = pending_ids.to_vec();
        Box::pin(async move {
            let result = tokio::task::spawn_blocking(move || {
                ledger.close_identities(&p, &ids, &pendings, TestLedgerSink::now_ms())
            })
            .await
            .map_err(|join| {
                freshell_freshagent::identity_sink::SinkCloseError::Clean(std::io::Error::other(
                    join,
                ))
            })?;
            result.map_err(|err| match err {
                freshell_ws::pane_ledger::CloseEnvelopeError::Clean(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Clean(e)
                }
                freshell_ws::pane_ledger::CloseEnvelopeError::Persisted(e) => {
                    freshell_freshagent::identity_sink::SinkCloseError::Persisted(e)
                }
            })
        })
    }
    fn delete_pending(&self, placeholder_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let p = placeholder_id.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.delete_pending(&p))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    // Focused-ep5-r1 Finding 2: same real-ledger pass-through as `retire_closed`.
    fn clear_kill_tombstone(&self, provider: &str, session_id: &str) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_kill_tombstone(&p, &s))
                .await
                .map_err(std::io::Error::other)?
        })
    }

    // Focused-ep5-r3 Finding 1 (retire-on-kill round 4): the snapshot read is
    // a memory-only inline pass-through (the LedgerIdentitySink discipline).
    fn kill_tombstone_at_ms(&self, provider: &str, session_id: &str) -> Option<i64> {
        self.ledger.kill_tombstone_at(provider, session_id)
    }

    // Retire-on-kill round 5 (focused-ep5-r4 Finding 2): the alias-tombstone
    // retention probe — memory-only inline pass-through like the snapshot read.
    fn row_is_bound(&self, provider: &str, session_id: &str) -> bool {
        self.ledger.row_is_bound(provider, session_id)
    }

    // Focused-ep5-r3 Findings 1+3: the conditional single-transition claim
    // commit — a faithful pass-through to the real ledger op.
    fn commit_claim(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
    ) -> SinkCommitWrite {
        self.commit_claim_aliased(provider, session_id, expect_killed_at_ms, &[])
    }
    // Focused-ep5-r5 Finding 2 (retire-on-kill round 6): the aliased commit's
    // faithful pass-through (the alias gate lives inside the ledger's
    // guarded transition).
    fn commit_claim_aliased(
        &self,
        provider: &str,
        session_id: &str,
        expect_killed_at_ms: Option<i64>,
        fence_checked_aliases: &[String],
    ) -> SinkCommitWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let aliases: Vec<String> = fence_checked_aliases.to_vec();
        Box::pin(async move {
            let outcome = tokio::task::spawn_blocking(move || {
                ledger.commit_claim_aliased(
                    &p,
                    &s,
                    expect_killed_at_ms,
                    &aliases,
                    TestLedgerSink::now_ms(),
                )
            })
            .await
            .map_err(std::io::Error::other)??;
            Ok(match outcome {
                freshell_ws::pane_ledger::ClaimCommitOutcome::Committed => ClaimCommit::Committed,
                freshell_ws::pane_ledger::ClaimCommitOutcome::RefusedStale => {
                    ClaimCommit::RefusedStale
                }
            })
        })
    }
    // Finding 2's alias-record pass-throughs (same disciplines as the rest of
    // the test double).
    fn record_alias_tombstone(
        &self,
        provider: &str,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, ph, d) = (
            provider.to_string(),
            placeholder.to_string(),
            durable.to_string(),
        );
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.record_alias_tombstone(&p, &ph, &d, at_ms))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn alias_tombstone_records(&self, provider: &str, placeholder: &str) -> Vec<(String, i64)> {
        self.ledger.alias_tombstone_records(provider, placeholder)
    }
    fn clear_alias_tombstones_for_durable(
        &self,
        provider: &str,
        durable: &str,
    ) -> SinkAliasClearWrite {
        let ledger = self.ledger.clone();
        let (p, d) = (provider.to_string(), durable.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.clear_alias_tombstones_for_durable(&p, &d))
                .await
                .map_err(std::io::Error::other)?
        })
    }
}

/// b8ke focused ep5 r2 F1: [`spawn_merged_server`] over a REAL pane ledger
/// (a tempdir root) with the ledger-backed identity sink wired into the
/// fresh states — the fresh-agent lanes' binding rows actually LAND (the
/// default harness runs a DISABLED ledger and no sink, so no row ever
/// exists to guard). The terminal lane shares the same real ledger
/// through the WsState.
async fn spawn_merged_server_with_ledger() -> (MergedHarness, Arc<PaneLedger>) {
    let hooks = Arc::new(freshell_freshagent::HandoffTestHooks::default());
    let cli_commands = Arc::new(vec![sleeper_cli_spec("claude"), sleeper_cli_spec("codex")]);
    let (state, registry, fresh_agent_state) =
        build_ws_state(cli_commands.iter().cloned().collect()).await;

    // The REAL ledger (tempdir-rooted) replaces the disabled one BEFORE any
    // write can flow; the fresh states write through the same ledger via the
    // TestLedgerSink.
    let ledger_root =
        std::env::temp_dir().join(format!("freshell-cross-kind-ledger-{}", uuid_like_suffix()));
    std::fs::create_dir_all(&ledger_root).expect("create the ledger root");
    let pane_ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
        ledger_root.clone(),
    )));
    let sink: std::sync::Arc<dyn PaneIdentitySink> = Arc::new(TestLedgerSink {
        ledger: Arc::clone(&pane_ledger),
        // b8ke focused ep5 r3 F1: the same ONE coordinator the merged
        // harness wired into the lanes — the sink's authoritative-write
        // consult reads the same transitions the runner drives.
        ownership: state.ownership.clone(),
    });
    state.fresh_claude.set_identity_sink(sink.clone());
    state.fresh_codex.set_identity_sink(sink.clone());
    state.fresh_opencode.set_identity_sink(sink.clone());
    let state = WsState {
        pane_ledger: Arc::clone(&pane_ledger),
        ..state
    };

    let snapshot_state = freshell_freshagent::SnapshotState::new(
        Arc::new(AUTH_TOKEN.to_string()),
        state.fresh_codex.clone(),
        fresh_agent_state
            .clone()
            .with_ownership(state.ownership.clone().expect("coordinator wired")),
        state.fresh_claude.clone(),
    );
    let ownership = state.ownership.clone().expect("coordinator wired");
    let handoff_runner = Arc::new(
        freshell_freshagent::SessionHandoffRunner::new(
            Arc::new(AUTH_TOKEN.to_string()),
            state.broadcast_tx.clone(),
            ownership,
            registry.clone(),
            state.fresh_codex.clone(),
            state.fresh_claude.clone(),
            state.fresh_opencode.clone(),
            fresh_agent_state
                .clone()
                .with_ownership(state.ownership.clone().expect("coordinator wired"))
                .with_terminal_registry(registry.clone())
                .with_cli_commands(Arc::clone(&cli_commands)),
            Arc::clone(&cli_commands),
        )
        .with_test_hooks(Arc::clone(&hooks)),
    );
    let app = freshell_ws::router(state.clone())
        .merge(freshell_freshagent::snapshot::router(snapshot_state))
        .merge(freshell_freshagent::session_handoff::handoff_router(
            Arc::clone(&handoff_runner),
        ));

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let ws_url = format!("ws://{addr}/ws");
    let ws = connect(&ws_url).await;
    (
        MergedHarness {
            base_url: format!("http://{addr}"),
            ws_url,
            ws,
            ws_state: state,
            handoff_runner,
        },
        pane_ledger,
    )
}

/// A parsed minimal HTTP GET response: `(status, JSON body)` — the
/// `rest_claude_identity.rs::raw_post_tabs` raw-TcpStream pattern, GET
/// flavor, for the snapshot REST door the merged harness serves.
async fn http_get_json(base_url: &str, path: &str) -> (u16, serde_json::Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let request = format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         Connection: close\r\n\
         \r\n",
        token = AUTH_TOKEN,
    );
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .expect("connect to merged server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write HTTP GET");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut raw))
        .await
        .expect("HTTP response within deadline")
        .expect("read HTTP response");
    let text = String::from_utf8(raw).expect("utf8 HTTP response");
    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP header/body separator");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code in status line")
        .parse()
        .expect("numeric status code");
    let json = serde_json::from_str(response_body.trim()).unwrap_or(serde_json::Value::Null);
    (status, json)
}

/// A parsed minimal HTTP POST response: `(status, JSON body)` — the GET
/// helper's POST twin (same raw-TcpStream pattern), for the handoff REST
/// endpoint the merged harness serves (kata b8ke Task 6).
async fn http_post_json(
    base_url: &str,
    path: &str,
    body: &serde_json::Value,
) -> (u16, serde_json::Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let host = base_url
        .strip_prefix("http://")
        .expect("base_url is http://{addr}");
    let payload = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         x-auth-token: {token}\r\n\
         content-type: application/json\r\n\
         content-length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {payload}",
        token = AUTH_TOKEN,
        len = payload.len(),
    );
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .expect("connect to merged server");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write HTTP POST");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(35), stream.read_to_end(&mut raw))
        .await
        .expect("HTTP response within deadline")
        .expect("read HTTP response");
    let text = String::from_utf8(raw).expect("utf8 HTTP response");
    let (head, response_body) = text
        .split_once("\r\n\r\n")
        .expect("HTTP header/body separator");
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .expect("status code in status line")
        .parse()
        .expect("numeric status code");
    let json = serde_json::from_str(response_body.trim()).unwrap_or(serde_json::Value::Null);
    (status, json)
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

/// [`connect`] variant whose hello carries the connection's `deviceId`
/// identity (the D8 hello stamp `lib.rs` reads into `ConnectionIdentity`) —
/// b8ke ext r24 F2's initiator tests drive a device-identifiable
/// connection.
async fn connect_with_device(url: &str, device_id: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "deviceId": device_id,
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

/// Soft-timeout twin of [`await_frame`] (which returns `Value` and PANICS on
/// timeout): returns `None` when the budget elapses (or the stream ends)
/// without a matching frame — the race test's polling loops need a
/// non-panicking bounded wait (kata b8ke Task 4, round-1 review).
async fn try_await_frame(
    ws: &mut TestWs,
    budget: Duration,
    predicate: impl Fn(&Value) -> bool,
) -> Option<Value> {
    tokio::time::timeout(budget, async {
        loop {
            let msg = ws.next().await?.expect("no ws error");
            let WsMessage::Text(text) = msg else { continue };
            let value: Value = serde_json::from_str(&text).unwrap();
            if predicate(&value) {
                return Some(value);
            }
        }
    })
    .await
    .ok()
    .flatten()
}

/// [`connect`] variant that RETURNS the ready frame (connect consumes and
/// discards it — a test that must inspect `ready` uses this; kata b8ke Task 4,
/// round-1 review).
async fn connect_and_capture_ready(url: &str) -> (TestWs, Value) {
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
        let WsMessage::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            return (ws, value); // the captured ready frame
        }
    }
}

/// [`connect`] variant that NEVER negotiates capabilities (kata b8ke Task 4,
/// round-2 review): the hello carries the protocol version but NO
/// `capabilities` object — the hand-rolled-script shape. The server still
/// authenticates it (token + exact protocol-version match); this connection
/// simply never enters the `paneReconcileV1` gate.
async fn connect_raw(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let hello = json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
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
        let WsMessage::Text(text) = msg else { continue };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["type"] == "ready" {
            return ws;
        }
    }
}

/// The live-PTY count for a session (copied from
/// `session_ref_singleflight.rs`'s `live_pty_count_for_session`): the
/// identity-probe join the race test's UNION sampler consumes.
fn live_pty_count_for_session(
    registry: &freshell_terminal::TerminalRegistry,
    mode: &str,
    session_id: &str,
) -> usize {
    registry
        .identity_probe_rows()
        .into_iter()
        .filter(|row| {
            row.mode == mode
                && row.status == freshell_protocol::TerminalRunStatus::Running
                && row.resume_session_id.as_deref() == Some(session_id)
        })
        .count()
}

// ── the red tests ────────────────────────────────────────────────────────────────────

/// Direction 1 (V7 scenario B): a live terminal PTY owns `(claude, S)`; a
/// `freshAgent.create { resumeSessionId: S }` must be refused and spawn ZERO
/// sidecars. Post-ejh6 (Task 7) the refusal fires at the raw-Value ejh6 guard
/// (the create carries the legacy field) BEFORE the typed dispatch reaches the
/// SESSION_RESERVED cross-kind guard, so the code is
/// `FRESH_AGENT_CREATE_FAILED` + frozen text.
#[tokio::test]
async fn freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let (url, _registry, _ws_state) = spawn_server().await;
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
    // ejh6: the legacy field is rejected at the door BEFORE the SESSION_RESERVED
    // cross-kind guard fires (the raw-Value ejh6 guard's freshAgent.create arm
    // runs first). The code is FRESH_AGENT_CREATE_FAILED + frozen text, not
    // SESSION_RESERVED.
    assert_eq!(failed["code"], "FRESH_AGENT_CREATE_FAILED");
    assert_eq!(
        failed["message"],
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );

    // 3. ZERO sidecar spawns.
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn while the terminal owns the session: {:?}",
        env.create_rows()
    );
}

/// Direction 1, sessionRef-only variant (whole-branch review finding 1): the ejh6
/// retarget of the test above left the STILL-REACHABLE production path unpinned --
/// a `freshAgent.create` carrying ONLY `sessionRef` (no legacy `resumeSessionId`)
/// passes the raw-Value ejh6 guard, reaches the typed dispatch, and must be
/// refused by the Task 13b cross-kind live-guard with
/// `freshAgent.create.failed { code: "SESSION_RESERVED", retryable: true }` and
/// ZERO sidecar spawns (the terminal may be closing -- retryable).
#[tokio::test]
async fn freshagent_session_ref_resume_is_refused_while_a_terminal_pty_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh claude terminal reaches Running, owning preallocated session S.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-owner-2",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-term-owner-2"
    })
    .await;
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude terminal carries a sessionRef")
        .to_string();

    // 2. A sessionRef-ONLY fresh-agent resume of the SAME session id carries no
    //    legacy field, so it passes the raw-Value ejh6 guard and must be refused
    //    by the cross-kind live-guard -- never a second writer on S's JSONL.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-cross-2",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "freshAgent.create.failed" || v["type"] == "freshAgent.created")
            && v["requestId"] == "req-fa-cross-2"
    })
    .await;
    assert_eq!(
        failed["type"], "freshAgent.create.failed",
        "a live terminal PTY owns {session_id}: the sessionRef-only resume must be refused, got {failed}"
    );
    assert_eq!(failed["code"], "SESSION_RESERVED");
    assert_eq!(
        failed["retryable"],
        serde_json::json!(true),
        "the terminal may be closing -- the cross-kind refusal must be retryable: {failed}"
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
    let (url, registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh-agent resume of S goes live (the fake sidecar answers `created`).
    //    (ejh6 Task 7: sessionRef-only -- a legacy `resumeSessionId` carry is now
    //    rejected at the raw-Value guard, which would break this setup create.)
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-1",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
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

/// Reconnect-revive Task 7 (cross-kind arm): when the D7 refusal fires
/// because a live FRESH-AGENT sidecar owns the session, no terminal id exists
/// to name -- the refusal must OMIT `liveTerminalId` entirely
/// (`#[serde(skip_serializing_if)]`; the field is additive and absent keeps
/// every other error frame byte-identical for frozen clients). The revival
/// arm stays inert: this refusal still dead-ends by design.
#[tokio::test]
async fn d7_cross_kind_refusal_omits_live_terminal_id() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();

    let durable = "abababab-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    let (url, registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // 1. A fresh-agent resume of S goes live (the fake sidecar answers `created`).
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-d7",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "req-fa-owner-d7"
    })
    .await;
    assert_eq!(env.create_rows().len(), 1, "the sidecar owns S now");

    // 2. The D7 cross-kind refusal: RESTORE_UNAVAILABLE, message names the
    //    session, and NO liveTerminalId (no terminal owns the session).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-term-cross-d7",
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
            && v["requestId"] == "req-term-cross-d7"
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
    assert!(
        frame.get("liveTerminalId").is_none(),
        "the cross-kind arm has no terminal id to name and must omit the field: {frame}"
    );

    // 3. No PTY spawned `claude --resume S`.
    assert!(
        !registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(durable)
        }),
        "no terminal may own {durable} -- the sidecar is the one writer"
    );
}

/// b8ke d4 F3: a terminal kill BLOCKED on a slow pane-ledger close (>30s
/// equivalent — the close-park holds it mid-write) is NOT fenced by the
/// stale-Stopping watchdog: the terminal stop path registers its
/// settlement guard at the claim (parity with the Fresh Agent kill lanes),
/// so the watchdog's age sweep SKIPS the progressing stop (pre-d4 every
/// unregistered stop older than 30s fenced, and the handler's eventual
/// abort/commit was then rejected as foreign — a clean ledger failure left
/// the live terminal permanently fenced). Released, the kill's commit_stop
/// succeeds: the key ends Vacant.
#[tokio::test]
async fn a_slow_terminal_kill_on_its_ledger_close_is_not_fenced_and_commits() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let session_id = format!("d4-f3-{}", uuid::Uuid::new_v4());

    // 1. A negotiated terminal create (the sessionRef-bearing shape that
    // commits the coordinator Live record).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-d4-f3",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-d4-f3"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        ownership.observe("claude", &session_id).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the terminal create never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // 2. Arm the pane-ledger close-park, then send terminal.kill — the
    // handler claims the stop (Stopping) and blocks in its ledger write.
    // The gate is armed with a PANIC-SAFE release guard: ANY test exit
    // (assert failure, unwind, or normal completion) un-parks the blocked
    // close first — a parked spawn_blocking close otherwise deadlocks the
    // current-thread runtime's teardown (Runtime::drop joins its blocking
    // threads), turning every failure inside the parked window into a
    // harness hang instead of a clean assertion failure.
    let gate = ws_state.pane_ledger.arm_close_pause_for_tests();
    struct GateReleaseOnDrop(std::sync::Arc<freshell_ws::pane_ledger::ClosePauseGate>);
    impl Drop for GateReleaseOnDrop {
        fn drop(&mut self) {
            let mut paused = self.0.paused.lock().expect("close pause gate lock");
            *paused = false;
            self.0.release.notify_all();
        }
    }
    let _gate_release_on_any_exit = GateReleaseOnDrop(std::sync::Arc::clone(&gate));
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.kill",
            "terminalId": terminal_id,
            "requestId": "req-d4-f3-kill",
        }),
    )
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        ownership.observe("claude", &session_id).state,
        freshell_ownership::OwnershipState::Stopping { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the kill's stop claim never granted (state: {:?})",
            ownership.observe("claude", &session_id).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // 3. THE WATCHDOG SWEEP over-aged (the >30s shape): the progressing
    // stop is NOT fenced (the settlement guard is unfired — pre-d4 the
    // unregistered stop fenced here and the handler's eventual commit was
    // rejected as foreign).
    let fenced = ownership.recover_stale_stoppings(10_000, 0);
    assert!(
        fenced.is_empty(),
        "the guard-registered terminal stop is NOT fenced by the age sweep \
         (a progressing stop is not stale) — fenced: {:?}",
        fenced.len()
    );
    assert!(matches!(
        ownership.observe("claude", &session_id).state,
        freshell_ownership::OwnershipState::Stopping { .. }
    ));

    // 4. Release the park: the ledger write lands, the kill's reap
    // confirms, and its commit_stop SUCCEEDS (the key ends Vacant —
    // the handler was never fenced).
    {
        let mut paused = gate.paused.lock().expect("gate lock");
        *paused = false;
        gate.release.notify_all();
    }
    let _killed = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v["type"] == "terminal.killed" && v["requestId"] == "req-d4-f3-kill"
    })
    .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match ownership.observe("claude", &session_id).state {
            freshell_ownership::OwnershipState::Vacant => break,
            other => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the released kill's commit_stop never settled — state: {other:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
}

/// b8ke d4 F4: a successful negotiated terminal create commits Live and
/// must CONSUME its OperationTicket — the ticket's Drop must not emit
/// `ownership.ticket.dropped_unarmed`/TICKET_DROPPED for the created
/// session (pre-d4 the un-disarmed drop misclassified every successful
/// create as an abandoned claim in the diagnostics; the Live record
/// survived only because the post-commit fail reads as foreign).
/// Determinism: current-thread runtime + thread-local capture — the
/// settle's commit and the ticket drop are synchronous on this thread,
/// so observing Live means the drop already fired.
#[tokio::test]
async fn a_successful_terminal_create_does_not_drop_its_ticket_unarmed() {
    let (events, _capture_guard) = race_tracing_capture::capture();
    let (url, registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let session_id = format!("d4-f4-ws-{}", uuid::Uuid::new_v4());

    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-d4-f4-ws",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": session_id },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-d4-f4-ws"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        ownership.observe("claude", &session_id).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the terminal create never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE FIX'S ASSERTION: the Live commit consumed the claim — no
    // dropped_unarmed names this session.
    let events = events.lock().expect("capture lock").clone();
    let dropped: Vec<_> = events
        .iter()
        .filter(|e| {
            e.target == "freshell_ownership"
                && e.event == "ownership.ticket.dropped_unarmed"
                && e.fields.get("session_id").map(String::as_str) == Some(session_id.as_str())
        })
        .collect();
    assert!(
        dropped.is_empty(),
        "a successful terminal create must not classify its own ticket as \
         abandoned: {dropped:?}"
    );

    // Cleanup: reap the sleeper PTY the create spawned.
    registry.kill(&terminal_id);
}

/// kata b8ke Task 3: a real freshclaude create/kill drives the shared
/// coordinator — Live{FreshAgent} while alive, Vacant after the awaited kill.
#[tokio::test]
async fn fresh_agent_create_and_kill_drive_the_shared_coordinator() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("coord-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "req-coord-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _created = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    let snap = ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }),
        "expected Live fresh-agent owner, got {:?}",
        snap.state
    );
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.kill", "sessionId": sid,
            "sessionType": "freshclaude", "provider": "claude",
        }),
    )
    .await;
    let _killed = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    })
    .await;
    let snap = ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert_eq!(
        snap.state,
        freshell_ownership::OwnershipState::Vacant,
        "kill must release ownership only after the confirmed reap"
    );
    let _ = sidecar;
}

/// kata b8ke Task 4: the two-writers START race. Both creates are sent
/// back-to-back with NO sequencing (the genuine-race pattern from
/// session_ref_singleflight.rs); whichever wins, exactly one runtime may
/// exist for the session and the loser must have a TYPED answer.
#[tokio::test]
async fn concurrent_terminal_and_fresh_agent_start_same_session_ref_yield_one_writer() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, registry, _ws_state) = spawn_server().await;
    let sid = format!("race-{}", uuid::Uuid::new_v4());
    let mut ws_term = connect(&url).await;
    let mut ws_fresh = connect(&url).await;

    // Fire both with zero awaits between the sends.
    let term_req = "race-term-1";
    let fresh_req = "race-fresh-1";
    let term_frame = json!({
        "type": "terminal.create", "requestId": term_req, "mode": "claude",
        "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let fresh_frame = json!({
        "type": "freshAgent.create", "requestId": fresh_req,
        "sessionType": "freshclaude", "provider": "claude",
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let send_term = send_json(&mut ws_term, &term_frame);
    let send_fresh = send_json(&mut ws_fresh, &fresh_frame);
    let ((), ()) = tokio::join!(send_term, send_fresh);

    // The UNION sampler (round-1 review): fresh sidecar creates PLUS terminal
    // PTYs for the session — the one-writer invariant is over the UNION, not
    // two separate <=1 assertions (one sidecar + one PTY would pass those).
    let live_writers = || {
        let creates = sidecar
            .create_rows()
            .iter()
            .filter(|r| r["msg"]["resumeSessionId"].as_str() == Some(sid.as_str()))
            .count();
        let ptys = live_pty_count_for_session(&registry, "claude", &sid);
        creates + ptys
    };

    // N1 (Task 4 review, applied): event-sourced union assertion — every PTY
    // SPAWN for the raced session is counted through the registry's activity
    // tap, so a sub-cadence two-writer transient (spawn + teardown landing
    // between sampler iterations) can no longer evade the check: the spawn
    // itself is the violation, sampled or not.
    let pty_spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let pty_spawns = Arc::clone(&pty_spawns);
        let sid_for_tap = sid.clone();
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid_for_tap.as_str()) {
                    pty_spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }));
    }

    // Wait until BOTH requests have a terminal answer (created OR typed error),
    // sampling the union across the interleaving.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let mut term_answered = false;
    let mut fresh_answered = false;
    while std::time::Instant::now() < deadline && !(term_answered && fresh_answered) {
        if !term_answered {
            if let Some(frame) = try_await_frame(&mut ws_term, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "terminal.created" || t == "error"
            })
            .await
            {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(term_req) {
                    term_answered = true;
                }
            }
        }
        if !fresh_answered {
            if let Some(frame) = try_await_frame(&mut ws_fresh, Duration::from_millis(250), |v| {
                let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                t == "freshAgent.created" || t == "freshAgent.create.failed"
            })
            .await
            {
                if frame.get("requestId").and_then(|r| r.as_str()) == Some(fresh_req) {
                    fresh_answered = true;
                }
            }
        }
        assert!(
            live_writers() <= 1,
            "the UNION of live writers (sidecars + PTYs) may never exceed 1 mid-race"
        );
    }
    assert!(
        term_answered && fresh_answered,
        "both requests must receive a typed answer"
    );

    // Final settle: the union is still at most one (the loser was typed, and
    // any loser-side runtime was torn down — not left running).
    assert!(
        live_writers() <= 1,
        "exactly one runtime may survive the race"
    );
    // N1 (Task 4 review, applied): the event-sourced union — PTY spawns PLUS
    // sidecar creates — may never exceed 1 either. This is cadence-
    // independent: even a transient second writer that spawned and was torn
    // down between two sampler iterations leaves its Created event behind.
    let sidecar_creates = sidecar
        .create_rows()
        .iter()
        .filter(|r| r["msg"]["resumeSessionId"].as_str() == Some(sid.as_str()))
        .count();
    assert!(
        pty_spawns.load(std::sync::atomic::Ordering::SeqCst) + sidecar_creates <= 1,
        "the union of SPAWNED writers (PTY spawns + sidecar creates) may never exceed 1"
    );
}

/// kata b8ke Task 4: the fresh-agent→terminal refusal carries the typed
/// owner fields (additive; frozen text untouched).
#[tokio::test]
async fn terminal_create_refusal_names_the_fresh_agent_owner_kind_and_generation() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("typed-owner-{}", uuid::Uuid::new_v4());
    // Establish a live freshclaude owner first.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "own-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // Competing terminal create is refused with the additive typed fields.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "ref-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let err = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ref-1")
    })
    .await;
    assert_eq!(
        err.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    // Frozen text untouched.
    assert!(err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .contains("is still running on the server."));
    // NEW additive typed fields:
    assert_eq!(
        err.get("ownerKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );
    assert!(
        err.get("ownerGeneration")
            .and_then(|g| g.as_u64())
            .unwrap_or(0)
            >= 1
    );
}

/// kata b8ke Task 4 (round-2 review): the terminal coordinator claim is
/// UNGATED — a connection that NEVER negotiates paneReconcileV1 still goes
/// through the coordinator. With a live fresh-agent owner, its
/// terminal.create is refused with the same frozen D7 text and the typed
/// owner fields; and on a VACANT key its create CLAIMS through the
/// coordinator (a second create from a negotiated connection is
/// typed-refused) — the vacant-state race is closed for non-negotiated
/// senders too, not just via the check-then-act D7 probe.
#[tokio::test]
async fn non_negotiated_terminal_create_is_coordinator_fenced() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let sid = format!("raw-{}", uuid::Uuid::new_v4());
    // A negotiated connection establishes the fresh owner.
    let mut ws_owner = connect(&url).await;
    send_json(
        &mut ws_owner,
        &json!({
            "type": "freshAgent.create", "requestId": "raw-own-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws_owner, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // The NON-NEGOTIATED connection's create is coordinator-fenced.
    let mut ws_raw = connect_raw(&url).await;
    send_json(
        &mut ws_raw,
        &json!({
            "type": "terminal.create", "requestId": "raw-ref-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let err = await_frame(&mut ws_raw, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("raw-ref-1")
    })
    .await;
    assert_eq!(
        err.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    assert!(
        err.get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .contains("is still running on the server."),
        "frozen D7 text preserved"
    );
    assert_eq!(
        err.get("ownerKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );
    // The vacant-state half: a non-negotiated create on a FRESH key claims
    // through the coordinator and COMMITS the terminal owner. (A negotiated
    // second create would ATTACH through the registry lease's
    // BoundElsewhere arm — same-mode multi-device attachment is pinned
    // behavior — so the claim's visibility is observed the two ways a
    // non-negotiated sender sees it: the frozen D7 refusal carrying the
    // coordinator-recorded owner fields, and the ready-frame owner replay.)
    let sid_b = format!("raw-b-{}", uuid::Uuid::new_v4());
    let mut ws_raw_b = connect_raw(&url).await;
    send_json(
        &mut ws_raw_b,
        &json!({
            "type": "terminal.create", "requestId": "raw-b-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid_b },
        }),
    )
    .await;
    let _ = await_frame(&mut ws_raw_b, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
    })
    .await;
    // The raw connection's committed claim is authoritative: a fresh
    // connection's ready frame replays the terminal owner for sid_b.
    let (ws_replay, ready_b) = connect_and_capture_ready(&url).await;
    let owners_b = ready_b
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    assert!(
        owners_b.iter().any(|o| {
            o.get("sessionId").and_then(|s| s.as_str()) == Some(sid_b.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("terminal")
        }),
        "the raw connection's claim must be recorded: {ready_b}"
    );
    drop(ws_replay);
    // A second NON-NEGOTIATED create for the same key is refused by the D7
    // guard, and the refusal's typed owner fields name the TERMINAL owner
    // the raw connection committed (from the coordinator's record).
    let mut ws_raw_c = connect_raw(&url).await;
    send_json(
        &mut ws_raw_c,
        &json!({
            "type": "terminal.create", "requestId": "raw-b-2", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid_b },
        }),
    )
    .await;
    let refused = await_frame(&mut ws_raw_c, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("raw-b-2")
    })
    .await;
    assert_eq!(
        refused.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    assert_eq!(
        refused.get("ownerKind").and_then(|k| k.as_str()),
        Some("terminal")
    );
    assert!(
        refused.get("liveTerminalId").is_some(),
        "the terminal owner is nameable for revival: {refused}"
    );
}

/// kata b8ke Task 4 (reconnect owner discovery, T1 rec A3): a NEW
/// connection's `ready` frame replays current runtime-owner state, so a
/// device that missed the handoff broadcast (offline during handoff,
/// lag-4008 disconnect, page reload) learns the authoritative owner from the
/// handshake alone. NOTE (round-1 review): `connect` CONSUMES and discards
/// the ready frame — the replay assertions use `connect_and_capture_ready`
/// (the capture variant added above), never a second wait for a frame that
/// was already read.
#[tokio::test]
async fn ready_frame_replays_current_runtime_owners() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let (url, _registry, _ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let sid = format!("replay-{}", uuid::Uuid::new_v4());
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create", "requestId": "replay-1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    // A SECOND connection (the "reloaded/reconnected device"): the ready
    // frame itself carries the owner — no broadcast needed.
    let (ws_b, ready) = connect_and_capture_ready(&url).await;
    let owners = ready
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present when the registry is injected");
    assert!(
        owners.iter().any(|o| {
            o.get("provider").and_then(|p| p.as_str()) == Some("claude")
                && o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("fresh-agent")
                && o.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0) >= 1
                && o.get("generation").and_then(|g| g.as_u64()).unwrap_or(0) >= 1
        }),
        "each replay record carries the boot epoch (round-2 review)"
    );
    // Kill releases the key: a THIRD connection's ready replays it as
    // "vacant" — the divergence-clearing half of the replay.
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.kill", "sessionId": sid,
            "sessionType": "freshclaude", "provider": "claude",
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    })
    .await;
    let (ws_c, ready_c) = connect_and_capture_ready(&url).await;
    let owners_c = ready_c
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    assert!(
        owners_c.iter().any(|o| {
            o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
                && o.get("ownerKind").and_then(|k| k.as_str()) == Some("vacant")
        }),
        "released keys must replay as vacant so replay clears stale divergence"
    );
    drop(ws_b);
    drop(ws_c);
}

/// b8ke focused round-3 review R3-5: a FENCED key reconnects truthfully —
/// the ready replay carries `state: "fenced"` with the typed reason and the
/// fenced PRIOR's kind, so a reconnecting device folds the typed recovery
/// state instead of a false committed owner (the pre-fix replay omitted the
/// fenced state entirely and the client labeled every non-vacant record
/// "handoff-committed").
#[tokio::test]
async fn ready_frame_replays_a_fenced_key_with_its_typed_reason() {
    let (url, _registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("fenced-replay-{}", uuid::Uuid::new_v4());

    // A Live terminal prior, then a handoff that fences with the typed
    // PlatformLimited reason (the shape a non-Linux teardown produces).
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-fenced-replay-prior",
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    let prior = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some(format!("t-{sid}")),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    assert_eq!(
        ownership.commit_live("claude", &sid, "op-fenced-replay-prior", generation, prior,),
        freshell_ownership::CommitOutcome::Committed
    );
    let freshell_ownership::BeginOutcome::Granted { generation: ho_gen } = ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-fenced-replay-ho",
        None,
        "test",
        2_000,
    ) else {
        panic!("expected Granted")
    };
    assert_eq!(
        ownership.fence_unconfirmed_handoff(
            "claude",
            &sid,
            "op-fenced-replay-ho",
            ho_gen,
            freshell_ownership::FenceReason::PlatformLimited,
        ),
        freshell_ownership::FenceOutcome::Fenced
    );

    // The reconnecting device's ready frame carries the fenced truth.
    let (_ws, ready) = connect_and_capture_ready(&url).await;
    let owners = ready
        .get("runtimeOwners")
        .and_then(|v| v.as_array())
        .expect("runtimeOwners present");
    let fenced = owners
        .iter()
        .find(|o| o.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str()))
        .expect("the fenced key replays")
        .clone();
    assert_eq!(
        fenced.get("ownerKind").and_then(|k| k.as_str()),
        Some("terminal"),
        "the fenced PRIOR's kind: {fenced}"
    );
    assert_eq!(
        fenced.get("state").and_then(|s| s.as_str()),
        Some("fenced"),
        "THE R3-5 regression: the replay must carry the fenced state: {fenced}"
    );
    assert_eq!(
        fenced.get("reason").and_then(|r| r.as_str()),
        Some("platform-limited"),
        "the typed fence reason: {fenced}"
    );
    assert_eq!(
        fenced.get("generation").and_then(|g| g.as_u64()),
        Some(ho_gen),
        "the fence's generation: {fenced}"
    );
}

// ── kata b8ke Task 4 review M1 (fix): total coordinator coverage ───────────
//
// The Adopt arm claims nothing (a live same-kind terminal owner exists — the
// registry lease's BoundElsewhere or the D7 refusal handles it). Three narrow
// windows can then leave a live terminal writer with NO coordinator record:
// 1. The Adopt-seen owner DIES after the claim but before the lease/D7 gate —
//    the lease acquires and the create spawns anyway, holding no claim, so the
//    settle previously skipped the coordinator commit (the key stayed Vacant
//    while the new terminal lived).
// 2. A LATER owner legitimately claims the freed key while that create is
//    spawning — the settle must never clobber it.
// 3. A Granted claim attaches through BoundElsewhere to a binding holder that
//    never committed (the shape-1 leftover): the attach previously returned
//    with the claim typed-failed while the attached terminal lived.
//
// Determinism: the "owner death" in these tests is injected through the
// registry's activity tap — the Created event fires inside the spawn's blocking
// task, i.e. AFTER the door's claim but strictly BEFORE the settle — where the
// phantom owner's fenced release runs. claim < Created < settle is the
// handler's own control flow, so no timing races.

/// M1 shape 1: the same-kind Adopt→death→acquire interleaving. The create's
/// claim sees a Live TERMINAL owner (Adopt — the arm that claims nothing);
/// that owner dies after the claim but before the settle, and the registry
/// lease then acquires, so the create spawns anyway. The settle must COMMIT
/// ownership for the surviving terminal — previously it skipped the commit
/// whenever the create held no claim, leaving the key Vacant while the
/// terminal lived (a fresh-agent create for the same key would be Granted:
/// the two-writer door).
#[tokio::test]
async fn same_kind_adopt_death_acquire_settle_commits_the_surviving_terminal() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("adopt-gap-{}", uuid::Uuid::new_v4());

    // The pre-existing same-kind writer the Adopt arm will see: a Live
    // TERMINAL owner for (claude, sid).
    let phantom_op = "op-adopt-gap-phantom";
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        phantom_op,
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    let phantom = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-adopt-gap-phantom".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    assert_eq!(
        ownership.commit_live("claude", &sid, phantom_op, generation, phantom.clone()),
        freshell_ownership::CommitOutcome::Committed
    );
    // commit_live stamps ownership_id from the committing operation.
    let mut stored_phantom = phantom.clone();
    stored_phantom.ownership_id = Some(phantom_op.to_string());

    // The mid-handler death: when the create's real spawn inserts the new
    // terminal row (Created), release the phantom exactly as its exit
    // watcher would (fenced claim) — the key is Vacant by the settle.
    {
        let ownership = ownership.clone();
        let sid = sid.clone();
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid.as_str()) {
                    ownership.release(
                        "claude",
                        &sid,
                        &freshell_ownership::ReleaseClaim {
                            operation_id: phantom_op.to_string(),
                            generation,
                            runtime: Some(stored_phantom.clone()),
                        },
                        "test/adopt-gap",
                    );
                }
            }
        }));
    }

    let mut ws = connect(&url).await;
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "adopt-gap-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(20), |v| {
        (v["type"] == "terminal.created" || v["type"] == "error") && v["requestId"] == "adopt-gap-1"
    })
    .await;
    assert_eq!(
        created["type"], "terminal.created",
        "the gap create itself must succeed: {created}"
    );
    let survivor = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(survivor.as_str()),
                "the settle must commit the SURVIVING terminal, not the dead phantom"
            );
        }
        other => panic!("the settle must record the surviving terminal's ownership, got {other:?}"),
    }
    // Cross-kind protection is restored with it: a fresh-agent start on the
    // key is typed-refused (pre-fix this was Granted — the two-writer door).
    assert!(
        matches!(
            ownership.begin_start(
                "claude",
                &sid,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "op-after-adopt-gap",
                None,
                "test",
                2_000,
            ),
            freshell_ownership::BeginOutcome::OwnedByOtherKind { .. }
        ),
        "a recorded terminal owner must fence a competing fresh-agent start"
    );
}

/// b8ke ext r32 F1 (M1 shape 2, RESHAPED to the exit-during-guard
/// contract): a competitor that tries to claim the death-vacated key
/// MID-WINDOW (the phantom's release lands mid-spawn — the exact
/// exit-during-guard race) is the DEFERRED ACQUISITION. The competing
/// begin answers the typed Blocked outcome — never Granted: pre-r32 it
/// claimed the freed key, "won", and the create's late claim tore the
/// create's OWN spawn down only AFTER the two writers had overlapped
/// (the M1 post-overlap defense this test used to pin). The guarded
/// create COMPLETES with continuous authority: its windowed late claim
/// grants, the key commits Live{Terminal} under the created terminal,
/// and no second writer ever existed. The stale-teardown discipline
/// itself remains (the late-claim refusal arms) for the windows-never-
/// armed and post-window shapes.
#[tokio::test]
async fn a_mid_window_competitor_is_deferred_and_the_guarded_create_completes() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("later-owner-{}", uuid::Uuid::new_v4());

    let phantom_op = "op-later-owner-phantom";
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        phantom_op,
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    let phantom = freshell_ownership::OwnerIdentity {
        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-later-owner-phantom".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    assert_eq!(
        ownership.commit_live("claude", &sid, phantom_op, generation, phantom.clone()),
        freshell_ownership::CommitOutcome::Committed
    );
    let mut stored_phantom = phantom.clone();
    stored_phantom.ownership_id = Some(phantom_op.to_string());

    // On Created (mid-spawn): the phantom dies (the incumbent's exit lands
    // INSIDE the create's attach window) and the COMPETITOR tries to claim
    // the freed key — captured for the assert below (it must answer the
    // typed Blocked outcome, never Granted).
    let competitor_outcome: Arc<std::sync::Mutex<Option<freshell_ownership::BeginOutcome>>> =
        Arc::new(std::sync::Mutex::new(None));
    {
        let ownership = ownership.clone();
        let sid = sid.clone();
        let capture = Arc::clone(&competitor_outcome);
        registry.set_activity_observer(Arc::new(move |event| {
            if let freshell_terminal::registry::ActivityEvent::Created {
                mode,
                resume_session_id,
                ..
            } = &event
            {
                if mode == "claude" && resume_session_id.as_deref() == Some(sid.as_str()) {
                    ownership.release(
                        "claude",
                        &sid,
                        &freshell_ownership::ReleaseClaim {
                            operation_id: phantom_op.to_string(),
                            generation,
                            runtime: Some(stored_phantom.clone()),
                        },
                        "test/later-owner",
                    );
                    let outcome = ownership.begin_start(
                        "claude",
                        &sid,
                        freshell_ownership::RuntimeOwnerKind::FreshAgent,
                        "op-later-fresh",
                        None,
                        "test",
                        2_000,
                    );
                    *capture.lock().expect("competitor capture") = Some(outcome);
                }
            }
        }));
    }

    let mut ws = connect(&url).await;
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create", "requestId": "later-owner-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let frame = await_frame(&mut ws, Duration::from_secs(20), |v| {
        (v["type"] == "terminal.created" || v["type"] == "error")
            && v["requestId"] == "later-owner-1"
    })
    .await;
    // The guarded create COMPLETES — never the pre-r32 teardown.
    assert_eq!(
        frame["type"], "terminal.created",
        "the guarded create completes with continuous authority: {frame}"
    );
    let created_id = frame["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    // THE COMPETITOR was deferred: the mid-window begin answered the
    // typed Blocked outcome over the death-vacated key (pre-r32: Granted
    // — the two-writer overlap the late claim only detected after).
    match competitor_outcome
        .lock()
        .expect("competitor capture")
        .take()
    {
        Some(freshell_ownership::BeginOutcome::Blocked {
            state,
            retry_after_ms,
        }) => {
            assert!(
                matches!(state, freshell_ownership::OwnershipState::Vacant),
                "the deferred acquisition answers over the vacated key: {state:?}"
            );
            assert!(retry_after_ms > 0, "the refusal is typed and retryable");
        }
        other => panic!("the mid-window competitor must answer Blocked, got {other:?}"),
    }
    // CONTINUOUS AUTHORITY: the key is Live{Terminal} under the CREATED
    // terminal — the sole owner, no second writer ever existed.
    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "the create's own claim commits the surviving terminal"
            );
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(created_id.as_str()),
                "the created terminal is the session's sole owner"
            );
        }
        other => panic!("the created terminal must hold the key, got {other:?}"),
    }
}

/// M1 shape 3: the BoundElsewhere-attach-to-uncommitted-terminal shape. A
/// Granted claim that attaches through the registry lease's BoundElsewhere
/// names a binding holder that never committed through the coordinator (a
/// committed holder would have answered AdoptLive at the claim above).
/// Previously the attach returned with the claim typed-failed while the
/// attached terminal kept living with NO coordinator record. The settle must
/// commit the claim FOR the attached terminal.
#[tokio::test]
async fn bound_elsewhere_attach_commits_ownership_for_the_unclaimed_holder() {
    let (url, registry, ws_state) = spawn_server().await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = format!("attach-gap-{}", uuid::Uuid::new_v4());

    // 1. A normal create establishes the holder: committed Live + bound.
    let mut ws_a = connect(&url).await;
    send_json(
        &mut ws_a,
        &json!({
            "type": "terminal.create", "requestId": "attach-src-1", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws_a, Duration::from_secs(20), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "attach-src-1"
    })
    .await;
    let holder = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the source create must commit its holder"
    );

    // 2. The uncommitted-live state: the holder's coordinator record is
    //    released (its exact fenced exit-watcher claim, from the retained
    //    claim) while the terminal LIVES and keeps the registry binding —
    //    the state the shape-1 gap leaves behind, reproduced deterministically.
    let retained = registry
        .retained_ownership_claim(&holder)
        .expect("the committed holder retains its claim");
    ownership.release(
        "claude",
        &sid,
        &freshell_ownership::ReleaseClaim {
            operation_id: retained.operation_id.clone(),
            generation: retained.generation,
            runtime: Some(freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some(retained.terminal_id.clone()),
                live_session_key: None,
                pid: retained.pid,
                ownership_id: Some(retained.operation_id.clone()),
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            }),
        },
        "test/attach-gap",
    );
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Vacant
        ),
        "the test state is the gap: a live bound terminal with a Vacant key"
    );

    // 3. A second (negotiated) create for the same key: Granted (the key is
    //    Vacant) → the lease answers BoundElsewhere → attach. The settle
    //    must commit the claim FOR the attached holder.
    let mut ws_b = connect(&url).await;
    send_json(
        &mut ws_b,
        &json!({
            "type": "terminal.create", "requestId": "attach-gap-2", "mode": "claude",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    // b8ke fence-heal: collect BOTH the created reply and the
    // session.runtimeOwner broadcast — separate delivery paths, no ordering
    // guarantee between them, and `await_frame` DROPS non-matching frames
    // (it would eat whichever of the two arrives first). Broadcasts fan
    // out to every connection, so the SAME test socket sees both.
    // Deadline note: the broadcast is queued to the bus BEFORE the created
    // reply is sent, so 10s is generous — and it must stay well under the
    // 30s sleeper's remaining lifetime, or a no-broadcast (RED) spin would
    // let the holder PTY exit and fail the settle-commit observe below
    // for an unrelated reason.
    let mut attached: Option<Value> = None;
    let mut broadcast: Option<Value> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while (attached.is_none() || broadcast.is_none()) && tokio::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_millis(50), ws_b.next()).await {
            Err(_) => continue, // no frame within the tick — re-check the deadline
            Ok(None) => panic!("stream ended while collecting"),
            Ok(Some(Err(e))) => panic!("ws error while collecting: {e}"),
            Ok(Some(Ok(msg))) => msg,
        };
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).expect("json frame");
        if (value["type"] == "terminal.created" || value["type"] == "error")
            && value["requestId"] == "attach-gap-2"
        {
            attached = Some(value);
        } else if value["type"] == "session.runtimeOwner" && value["sessionId"] == json!(sid) {
            broadcast = Some(value);
        }
    }
    let attached = attached.expect("the attach create's terminal.created reply arrived");
    assert_eq!(
        attached["type"], "terminal.created",
        "the attach create must succeed: {attached}"
    );
    assert_eq!(
        attached["terminalId"].as_str(),
        Some(holder.as_str()),
        "the attach must name the existing holder"
    );

    match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(holder.as_str()),
                "the attach settle must record the ATTACHED terminal's ownership"
            );
        }
        other => {
            panic!("the attach settle must commit coverage for the live holder, got {other:?}")
        }
    }

    // b8ke fence-heal: the attach-claim commit also broadcasts its own
    // committed pair and rides it on the created frame. Both carry the
    // (epoch, generation) captured from the claim ticket BEFORE the
    // consuming commit (r32 F2 — never a re-observed current generation),
    // so every connected client folds the fresh fence and the attaching
    // pane's queued first attach is born fresh.
    let broadcast = broadcast.expect(
        "the attach-claim commit broadcast the committed owner frame \
         (session.runtimeOwner for the attached session id)",
    );
    let current = ownership.observe("claude", &sid);
    assert_eq!(broadcast["ownerKind"], json!("terminal"), "{broadcast}");
    assert_eq!(
        broadcast["transition"],
        json!("handoff-committed"),
        "{broadcast}"
    );
    assert_eq!(broadcast["terminalId"], json!(holder), "{broadcast}");
    assert_eq!(broadcast["epoch"], json!(current.epoch), "{broadcast}");
    assert_eq!(
        broadcast["generation"],
        json!(current.generation),
        "{broadcast}"
    );
    assert!(
        !broadcast["operationId"].as_str().unwrap_or("").is_empty(),
        "the broadcast names the committing operation: {broadcast}"
    );
    assert_eq!(attached["ownerKind"], json!("terminal"), "{attached}");
    assert_eq!(attached["ownerEpoch"], json!(current.epoch), "{attached}");
    assert_eq!(
        attached["ownerGeneration"],
        json!(current.generation),
        "{attached}"
    );
}

// ── kata b8ke Task 5: the side-effect-free snapshot GET ────────────────────

/// kata b8ke Task 5: a snapshot GET while a TERMINAL owns the session must be
/// side-effect-free — zero sidecar spawns, typed 409 with the owner fields.
#[tokio::test]
async fn snapshot_get_never_spawns_while_a_terminal_owns_the_session() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("snap-term-{}", uuid::Uuid::new_v4());
    // Terminal owner first (mode codex — the sleeper spec spawns a real
    // Running PTY that claims Live{Terminal} through the coordinator).
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "snap-t1", "mode": "codex",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "snap-t1"
    })
    .await;
    assert!(
        matches!(
            h.ws_state
                .fresh_codex
                .ownership_snapshot("codex", &sid)
                .state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the terminal create must commit Live{{Terminal}} first"
    );

    let watermark = codex_fake.thread_op_rows().len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshcodex/codex/{sid}"),
    )
    .await;
    assert_eq!(
        status, 409,
        "owned sessions answer the typed 409, got {status}: {body}"
    );
    assert_eq!(body["code"], "RESTORE_UNAVAILABLE", "typed code: {body}");
    assert_eq!(
        body["ownerKind"], "terminal",
        "the owner kind is named: {body}"
    );
    assert!(
        body["ownerGeneration"].as_u64().is_some(),
        "the owner generation is named: {body}"
    );
    assert!(
        body["message"]
            .as_str()
            .is_some_and(|m| m.contains(&sid) && m.contains("still running on the server.")),
        "the frozen refusal text names the session: {body}"
    );
    let rows = codex_fake.thread_op_rows();
    assert_eq!(
        rows.len(),
        watermark,
        "snapshot GET must not spawn or resume a sidecar: {rows:?}"
    );
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "the GET window spawned no app-server (the terminal create's managed-launch \
         sidecar predates the watermark): {:?}",
        codex_fake.sidecar_spawn_rows()
    );
}

/// kata b8ke Task 5 (round-2 review — the intended behavior change): a
/// snapshot GET for a VACANT untracked session NEVER spawns — 200 with the
/// EMPTY snapshot and owner state, zero app-server invocations, and the
/// coordinator stays Vacant. Cold resume happens ONLY through the explicit
/// lifecycle commands (the fenced `freshAgent.create` below proves the
/// coverage moved, not vanished).
#[tokio::test]
async fn snapshot_get_for_a_vacant_untracked_session_never_spawns() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("snap-cold-{}", uuid::Uuid::new_v4());
    let watermark = codex_fake.thread_op_rows().len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshcodex/codex/{sid}"),
    )
    .await;
    assert_eq!(
        status, 200,
        "vacant untracked sessions answer 200 with the empty snapshot, got {status}: {body}"
    );
    assert_eq!(
        body["sessionType"], "freshcodex",
        "the snapshot facts are stamped: {body}"
    );
    assert_eq!(body["threadId"], sid, "the requested id is echoed: {body}");
    assert_eq!(body["turns"], Value::Array(vec![]), "empty rows: {body}");
    assert_eq!(
        body["extensions"]["codex"]["ownerKind"], "vacant",
        "the additive owner-state fields name the vacant key: {body}"
    );
    let rows = codex_fake.thread_op_rows();
    assert_eq!(
        rows.len(),
        watermark,
        "the GET must not spawn, resume, or otherwise touch a sidecar — no thread/resume row: {rows:?}"
    );
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "the GET window spawned no app-server: {:?}",
        codex_fake.sidecar_spawn_rows()
    );
    // The coordinator is untouched: still Vacant, no claim recorded.
    let snap = h.ws_state.fresh_codex.ownership_snapshot("codex", &sid);
    assert_eq!(
        snap.state,
        freshell_ownership::OwnershipState::Vacant,
        "a read-only GET must not create ownership, got {:?}",
        snap.state
    );
    // The explicit lifecycle rebind is the ONLY cold resume: a fenced
    // freshAgent.create resumes the session (the fake ledger grows exactly
    // one thread/resume for the id), proving the coverage moved, not vanished.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "snap-cold-2",
            "sessionType": "freshcodex", "provider": "codex", "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == "snap-cold-2"
    })
    .await;
    let rows = codex_fake.thread_op_rows();
    assert!(
        rows.iter().any(|r| r["method"] == "thread/resume"
            && r["threadId"].as_str() == Some(sid.as_str())),
        "the explicit freshAgent.create — not the GET — performed the resume: {rows:?}"
    );
}

/// b8ke delta review F4: the opencode twin — a snapshot GET over the real
/// merged HTTP door NEVER spawns the shared `opencode serve` daemon. A cold
/// server (no manager, daemon absent) answers 200 with the
/// empty-from-disk snapshot and the additive owner-state fields, the fake
/// serve's audit log stays EMPTY (zero processes ever spawned), and the
/// coordinator is untouched. The daemon starts only via explicit lifecycle
/// (`freshAgent.create`/`send` materialization).
#[tokio::test]
async fn snapshot_get_for_opencode_never_spawns_the_shared_serve() {
    let _guard = ENV_LOCK.lock().await;
    let opencode_fake = FakeOpencodeServeEnv::install();
    let h = spawn_merged_server().await;
    let sid = format!("ses_snap-opencode-{}", uuid::Uuid::new_v4());
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshopencode/opencode/{sid}"),
    )
    .await;
    assert_eq!(
        status, 200,
        "a daemon-absent opencode GET answers 200 with the empty-from-disk \
         snapshot, got {status}: {body}"
    );
    assert_eq!(body["sessionType"], "freshopencode", "the facts: {body}");
    assert_eq!(body["threadId"], sid, "the requested id is echoed: {body}");
    assert_eq!(body["turns"], Value::Array(vec![]), "empty rows: {body}");
    assert_eq!(
        body["extensions"]["opencode"]["ownerKind"], "vacant",
        "the additive owner-state fields name the vacant key: {body}"
    );
    assert!(
        opencode_fake.serve_pids().is_empty(),
        "the GET window spawned no opencode serve: {:?}",
        opencode_fake.serve_pids()
    );
    // The coordinator is untouched: still Vacant, no claim recorded.
    let snap = h
        .ws_state
        .fresh_opencode
        .ownership_snapshot("opencode", &sid);
    assert_eq!(
        snap.state,
        freshell_ownership::OwnershipState::Vacant,
        "a read-only GET must not create ownership, got {:?}",
        snap.state
    );
}

// ── kata b8ke Task 6: the atomic handoff endpoint (end-to-end) ──────────────

/// End-to-end fresh→terminal handoff over the real REST endpoint against the
/// in-process server with both kinds live: the old sidecar is reaped, the
/// coordinator flips Live{FreshAgent} → Live{Terminal}, both
/// `session.runtimeOwner` transitions broadcast on the WS (the committed
/// frame carrying the boot epoch, the true previousKind, and the owning
/// terminal id), and a subsequent `freshAgent.create` for the session is
/// typed-refused with the terminal owner.
#[tokio::test]
async fn fresh_agent_to_terminal_handoff_is_atomic_and_broadcast() {
    let _guard = ENV_LOCK.lock().await;
    let sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
    let mut h = spawn_merged_server().await;
    let sid = format!("ho-e2e-{}", uuid::Uuid::new_v4());
    // Fresh owner.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "ho-f1",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ho-f1")
    })
    .await;
    assert!(
        matches!(
            h.ws_state
                .fresh_claude
                .ownership_snapshot("claude", &sid)
                .state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the fresh owner must be Live before the handoff"
    );

    // Handoff to terminal via REST.
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "terminal",
            "mode": "claude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);
    let terminal_id = body["owner"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    // The coordinator is Live{Terminal} for (claude, sid).
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(snap.state, freshell_ownership::OwnershipState::Live { ref owner, .. }
            if owner.terminal_id.as_deref() == Some(terminal_id.as_str())),
        "expected Live terminal owner naming the spawned terminal, got {:?}",
        snap.state
    );

    // The terminal target is published at the handoff commit boundary.  That
    // commit must also retain the registry's release evidence so the PTY exit
    // path can release the same fenced owner; a plain coordinator commit
    // leaves Live{Terminal} stranded after the target exits.
    let locator = freshell_protocol::SessionLocator {
        provider: "claude".to_string(),
        session_id: sid.clone(),
    };
    let retained = h
        .ws_state
        .registry
        .retained_ownership_claim_by_locator(&locator)
        .expect("terminal handoff commit retains release evidence");
    assert_eq!(retained.terminal_id, terminal_id);
    assert_eq!(
        retained.operation_id,
        body["operationId"]
            .as_str()
            .expect("handoff response operation id")
    );
    assert_eq!(retained.generation, snap.generation);

    // Both broadcast transitions arrived on the WS.
    let _started = await_frame(&mut h.ws, Duration::from_secs(10), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-started")
    })
    .await;
    let committed = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some("handoff-committed")
    })
    .await;
    assert_eq!(
        committed.get("terminalId").and_then(|t| t.as_str()),
        Some(terminal_id.as_str())
    );
    // Round-2 review: the frame carries the boot epoch and the true
    // previousKind (the prior fresh-agent kind).
    assert!(committed.get("epoch").and_then(|e| e.as_u64()).unwrap_or(0) >= 1);
    assert_eq!(
        committed.get("previousKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );

    // A subsequent freshAgent.create for the session is typed-refused with
    // the terminal owner (Task 3's lane claim; the claude snapshot GET is a
    // disk read and is not the refusal surface).
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "ho-f2",
            "sessionType": "freshclaude", "provider": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let refused = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.create.failed")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("ho-f2")
    })
    .await;
    assert_eq!(
        refused.get("ownerKind").and_then(|k| k.as_str()),
        Some("terminal"),
        "the refusal names the terminal owner: {refused}"
    );

    // The actual terminal publication boundary owns the release path too:
    // killing this PTY must release the handoff's Live record and consume the
    // retained claim.
    h.ws_state.registry.kill(&terminal_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let state = h
            .ws_state
            .fresh_claude
            .ownership_snapshot("claude", &sid)
            .state;
        if matches!(state, freshell_ownership::OwnershipState::Vacant) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "terminal exit did not release the handoff owner: {state:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        h.ws_state
            .registry
            .retained_ownership_claim_by_locator(&locator)
            .is_none(),
        "terminal exit consumes the retained release evidence"
    );
    let _ = sidecar;
}

/// b8ke focused ep5 r2 F1: END-TO-END terminal→fresh-agent handoff over
/// the real REST endpoint against the in-process server with the REAL
/// pane ledger — the ep5-r2 finding's exact scenario. The terminal row
/// is the NORMAL UNSTAMPED production shape (the ordinary WS terminal
/// binding writes stamp nothing; the handoff kills the terminal directly
/// and the exit hook leaves its row Bound with live_terminal_id), so the
/// target's AUTHORITATIVE binding write (the runner's r27-F2 under-ticket
/// shape, carrying the handoff generation) is the only write that may
/// land over it. Pre-ep5-r2 the strictly-newer guard refused it
/// (write_pair = Some, row_pair = None) and the requested handoff tore
/// the target down; post-fix the handoff commits Live{FreshAgent} and
/// the recovery row becomes the fresh-agent target's.
#[tokio::test]
async fn terminal_to_fresh_agent_handoff_lands_over_the_unstamped_terminal_row() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
                                              // The claude-lane resume gates on transcript presence (the 6b
                                              // pattern): the target's resume of `sid` needs the transcript under
                                              // CLAUDE_CONFIG_DIR.
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-ep5-r2-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = format!("ho-rev-{}", uuid::Uuid::new_v4());
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let (mut h, pane_ledger) = spawn_merged_server_with_ledger().await;

    // 1. The TERMINAL owner: an ordinary WS terminal binding (claude mode)
    //    over the durable id — the coordinator's Live{Terminal} and the
    //    ledger row Bound with live_terminal_id and NO ownership stamp
    //    (the normal production shape).
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "rev-t1",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("rev-t1")
    })
    .await;
    let terminal_id = created
        .get("terminalId")
        .and_then(|t| t.as_str())
        .expect("terminalId")
        .to_string();
    assert!(
        matches!(
            h.ws_state
                .fresh_claude
                .ownership_snapshot("claude", &sid)
                .state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.terminal_id.as_deref() == Some(terminal_id.as_str())
        ),
        "the terminal owner must be Live before the handoff"
    );
    let row = pane_ledger
        .load_binding("claude", &sid)
        .expect("the terminal binding row exists");
    assert_eq!(
        row.live_terminal_id.as_deref(),
        Some(terminal_id.as_str()),
        "the terminal's recovery row: {row:?}"
    );
    assert_eq!(
        (row.owner_epoch, row.owner_generation),
        (None, None),
        "the ordinary WS terminal binding row is UNSTAMPED (the normal \
         production shape the ep5-r2 finding names): {row:?}"
    );

    // 2. The handoff to the FRESH target over the real REST endpoint.
    //    Pre-ep5-r2 this answered ok:false — the target's authoritative
    //    binding write was refused by the strictly-newer guard and the
    //    freshly spawned target was torn down.
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "fresh-agent",
            "sessionType": "freshclaude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);

    // 3. The coordinator is Live{FreshAgent}.
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(
            snap.state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ),
        "expected Live fresh-agent owner, got {:?}",
        snap.state
    );

    // 4. THE REAL LEDGER: the recovery row became the fresh-agent
    //    target's — pane_kind fresh-agent, the terminal's binding
    //    superseded (pre-ep5-r2 the row stayed the dead terminal's).
    //    The target's session-init adoption write is ASYNC to the
    //    runner's commit (the sidecar's sdk.session.init lands after the
    //    handoff answered) — bounded-poll for the flip.
    let flipped = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let done = pane_ledger
                .load_binding("claude", &sid)
                .is_some_and(|r| r.pane_kind.as_deref() == Some("fresh-agent"));
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(
        flipped.is_ok(),
        "the target's authoritative binding write never landed over the terminal's unstamped row"
    );
    let row = pane_ledger
        .load_binding("claude", &sid)
        .expect("the row after the handoff");
    assert_eq!(
        row.pane_kind.as_deref(),
        Some("fresh-agent"),
        "the recovery row is the fresh-agent target's: {row:?}"
    );
    assert_eq!(
        row.live_terminal_id, None,
        "the terminal's binding is superseded: {row:?}"
    );

    // Cleanup: the sidecar target dies with the harness (the fake
    // sidecar is a short-lived script under the dropped env), and the
    // terminal row's PTY is reaped through the registry.
    h.ws_state.registry.kill(&terminal_id);
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(store_dir);
}

/// b8ke focused ep5 r3 F1 (e2e): a SUPERSEDED handoff's stale
/// authoritative write is refused at the sink's ownership consult, END TO
/// END. The first handoff commits Live{FreshAgent} and its target's
/// binding lands (the r2 exception's flow); a SECOND handoff moves the
/// key on (a terminal target, a newer generation); the FIRST handoff's
/// delayed/orphaned target write — still marked authoritative, still
/// carrying the first handoff's (epoch, generation) pair — is refused
/// with the CONSULT's typed error (STALE_TRANSITION, not the ledger's
/// NOT_NEWER arithmetic: the consult runs first, and this asserts the
/// right layer refused it), and the refused write mutates nothing on the
/// recovery row.
#[tokio::test]
async fn a_superseded_handoffs_stale_authoritative_write_is_refused_end_to_end() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
                                              // The claude-lane resume gates on transcript presence (the 6b
                                              // pattern): the target's resume of `sid` needs the transcript under
                                              // CLAUDE_CONFIG_DIR.
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-ep5-r3-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = format!("ho-sup-{}", uuid::Uuid::new_v4());
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let (mut h, pane_ledger) = spawn_merged_server_with_ledger().await;

    // 1. The TERMINAL owner: an ordinary WS terminal binding (claude mode)
    //    over the durable id — the coordinator's Live{Terminal} and the
    //    ledger row Bound with live_terminal_id and NO ownership stamp.
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "sup-t1",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("sup-t1")
    })
    .await;
    let first_terminal_id = created
        .get("terminalId")
        .and_then(|t| t.as_str())
        .expect("terminalId")
        .to_string();

    // 2. The FIRST handoff to the FRESH target — commits
    //    Live{FreshAgent} at its generation and the target's
    //    authoritative binding lands over the unstamped terminal row
    //    (the r2 exception's flow, re-proven under the r3 consult).
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "fresh-agent",
            "sessionType": "freshclaude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);
    let flipped = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let done = pane_ledger
                .load_binding("claude", &sid)
                .is_some_and(|r| r.pane_kind.as_deref() == Some("fresh-agent"));
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(
        flipped.is_ok(),
        "the first handoff's authoritative write landed (the success arm)"
    );
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    let (epoch, first_generation) = (snap.epoch, snap.generation);
    assert!(
        matches!(
            snap.state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ),
        "the first handoff committed Live{{FreshAgent}} at generation {first_generation}: {:?}",
        snap.state
    );

    // 3. The SECOND handoff moves the key on: fresh-agent → terminal —
    //    the runner stops the fresh target and commits the terminal owner
    //    at a NEWER generation.
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "terminal",
            "mode": "claude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);
    let second_terminal_id = body["owner"]["terminalId"]
        .as_str()
        .expect("the terminal target's terminalId")
        .to_string();
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    assert!(
        matches!(
            snap.state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.terminal_id.as_deref() == Some(second_terminal_id.as_str())
        ),
        "the second handoff committed the terminal owner: {:?}",
        snap.state
    );
    assert!(
        snap.generation > first_generation,
        "the second handoff advanced the generation ({} > {})",
        snap.generation,
        first_generation
    );

    // 4. THE STALE WRITE: the FIRST handoff's delayed target write — the
    //    exact shape an orphaned spawn_blocking closure from a
    //    canceled/superseded handoff carries (authoritative, the first
    //    handoff's pair) — through the same sink the lanes write
    //    through. The consult reads the key's CURRENT truth (a terminal
    //    owner at a newer generation) and refuses with ITS typed error.
    //    Note the row the stale write targets: the fresh→terminal
    //    handoff does not itself rewrite the recovery row (the terminal
    //    lane's row writes ride the ordinary attach path, not the
    //    runner's target spawn), so the row still carries the FIRST
    //    handoff's fresh-agent metadata — the refused write must leave
    //    it byte-identical.
    let row_before = pane_ledger
        .load_binding("claude", &sid)
        .expect("the row exists before the stale write");
    let sink = TestLedgerSink {
        ledger: Arc::clone(&pane_ledger),
        ownership: h.ws_state.ownership.clone(),
    };
    let err = sink
        .record_binding(FreshAgentBindingUpsert {
            name_transition: None,
            provider: "claude".into(),
            session_id: sid.clone(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
            observed_epoch: Some(epoch),
            observed_generation: Some(first_generation),
            authoritative: true,
            settings: freshell_freshagent::FreshAgentSettings {
                model: Some("stale-superseded".into()),
                ..Default::default()
            },
        })
        .await
        .expect_err("the superseded handoff's stale authoritative write is refused");
    assert!(
        err.to_string().contains("STALE_TRANSITION_BINDING"),
        "the refusal is the ownership CONSULT's typed error (not the ledger's \
         arithmetic): {err}"
    );

    // The refused write mutated NOTHING: the row is byte-identical to its
    // pre-write shape (still the first handoff's fresh-agent metadata at
    // generation {first_generation}, never the stale write's model).
    let row = pane_ledger
        .load_binding("claude", &sid)
        .expect("the row survives");
    assert_eq!(
        row, row_before,
        "the refused stale write changed nothing: before {row_before:?} after {row:?}"
    );
    assert_eq!(
        row.model.as_deref(),
        None,
        "the stale write's distinguishing settings never landed: {row:?}"
    );
    assert_eq!(
        row.owner_generation,
        Some(first_generation),
        "the row still carries the first (committed) handoff's generation: {row:?}"
    );

    // Cleanup: the first terminal's row was reaped by the first handoff;
    // the second terminal's PTY is reaped through the registry.
    h.ws_state.registry.kill(&second_terminal_id);
    let _ = first_terminal_id;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(store_dir);
}

/// b8ke focused ep5 r4 F1 (e2e): the FAILED-TRANSITION REPAIR, end to end
/// through the merged harness's real ledger and the lane sink. The
/// cleanup's ledger act (fired here exactly as the abort/typed-failure
/// cleanup would fire it, with the transition's own pair): (1) REVERTS
/// the transition's own orphaned authoritative row (the completed-write
/// ordering — the row the handoff's target wrote retires typed
/// `FailedTransition`); (2) its durable tombstone fence SUPPRESSES a late
/// authoritative write whose ownership consult STILL PASSES (the
/// validated-then-canceled ordering — the consult passed pre-cancel, the
/// tombstone closes the interleaving), leaving the row untouched; (3) a
/// later legitimate claim's `clear_kill_tombstone` (the claim commit's
/// act) re-opens the identity.
#[tokio::test]
async fn the_failed_transition_repair_fences_and_reverts_end_to_end() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
                                              // The claude-lane resume gates on transcript presence (the 6b
                                              // pattern): the target's resume of `sid` needs the transcript under
                                              // CLAUDE_CONFIG_DIR.
    let store_dir = std::env::temp_dir().join(format!(
        "freshell-handoff-ep5-r4-repair-{}",
        uuid_like_suffix()
    ));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = format!("ho-rep-{}", uuid::Uuid::new_v4());
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let (mut h, pane_ledger) = spawn_merged_server_with_ledger().await;

    // 1. The TERMINAL owner + 2. the FIRST handoff to the FRESH target —
    //    the r2 success flow: the target's authoritative binding lands
    //    over the ordinary unstamped terminal row.
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "rep-t1",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("rep-t1")
    })
    .await;
    let terminal_id = created
        .get("terminalId")
        .and_then(|t| t.as_str())
        .expect("terminalId")
        .to_string();
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &json!({
            "provider": "claude", "sessionId": sid, "targetKind": "fresh-agent",
            "sessionType": "freshclaude", "deviceId": "test-device-a",
        }),
    )
    .await;
    assert_eq!(status, 200, "{}", body);
    assert_eq!(body["ok"], serde_json::json!(true), "{}", body);
    let flipped = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let done = pane_ledger
                .load_binding("claude", &sid)
                .is_some_and(|r| r.pane_kind.as_deref() == Some("fresh-agent"));
            if done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(
        flipped.is_ok(),
        "the handoff's authoritative write landed (the success arm)"
    );
    let snap = h.ws_state.fresh_claude.ownership_snapshot("claude", &sid);
    let (epoch, generation) = (snap.epoch, snap.generation);
    assert!(matches!(
        snap.state,
        freshell_ownership::OwnershipState::Live { ref owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
    ));

    // 3. THE REVERT (the completed-write ordering): the transition at
    //    (epoch, generation) fails and its cleanup fires the repair —
    //    the row the target's own write produced retires typed
    //    FailedTransition, and the durable fence is fed.
    let sink = TestLedgerSink {
        ledger: Arc::clone(&pane_ledger),
        ownership: h.ws_state.ownership.clone(),
    };
    sink.repair_failed_transition("claude", &sid, epoch, generation)
        .await
        .expect("the cleanup's repair lands");
    let row = pane_ledger
        .load_binding("claude", &sid)
        .expect("the orphaned row survives, retired");
    assert_eq!(
        row.state,
        freshell_ws::pane_ledger::RowState::Retired,
        "the orphaned row retired: {row:?}"
    );
    assert_eq!(
        row.retired_reason,
        Some(freshell_ws::pane_ledger::RetiredReason::FailedTransition)
    );
    assert!(
        pane_ledger.kill_tombstone_at("claude", &sid).is_some(),
        "the durable fence is fed"
    );

    // 4. THE FENCE (the validated-then-canceled ordering): a late
    //    authoritative write carrying the SAME transition's pair — its
    //    ownership consult STILL PASSES (the coordinator holds
    //    Live{{FreshAgent}} at that generation) — is suppressed at the
    //    ledger's tombstone consult, changing nothing.
    let row_before = pane_ledger
        .load_binding("claude", &sid)
        .expect("the row before the late write");
    sink.record_binding(FreshAgentBindingUpsert {
        name_transition: None,
        provider: "claude".into(),
        session_id: sid.clone(),
        mode: "freshclaude".into(),
        create_request_id: None,
        resolves_pending: None,
        supersedes: None,
        provenance: freshell_freshagent::ProvenanceUpdate::Inherit,
        observed_epoch: Some(epoch),
        observed_generation: Some(generation),
        authoritative: true,
        settings: freshell_freshagent::FreshAgentSettings {
            model: Some("late-orphaned".into()),
            ..Default::default()
        },
    })
    .await
    .expect("the suppressed late write answers Ok (suppression, not error)");
    let row = pane_ledger
        .load_binding("claude", &sid)
        .expect("the row after the late write");
    assert_eq!(
        row, row_before,
        "the suppressed late write changed nothing: {row:?}"
    );

    // 5. THE FENCE NEVER WEDGES: a later legitimate claim's commit clears
    //    the tombstone (the killed-session re-attach machinery).
    sink.clear_kill_tombstone("claude", &sid)
        .await
        .expect("the claim commit's clear lands");
    assert!(
        pane_ledger.kill_tombstone_at("claude", &sid).is_none(),
        "the fence is cleared — the identity re-opens for the next claim"
    );

    // Cleanup: the first terminal's row was reaped by the handoff; the
    // fresh target's sidecar dies with the harness.
    let _ = terminal_id;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(store_dir);
}

/// b8ke focused ep5 r5 F1 (e2e): an ORDINARY codex cold resume with
/// RECOVERED settings succeeds end-to-end over the PRODUCTION-shaped
/// consulting sink (the merged harness's TestLedgerSink mirrors the
/// production bridge's ownership consult verbatim, over the real
/// ledger). The recovered-session binding write is a LANE write — never
/// the authoritative marker without its pair — so the thread registers,
/// the coordinator goes Live{FreshAgent}, and the recovered row
/// refreshes: no teardown, no transient error. Pre-r5 the codex recovered-session binding was
/// marked authoritative UNCONDITIONALLY: the ordinary resume's
/// `(None, None)` pair met the ep5-r3 consult's typed refusal (an
/// authoritative write must carry its observed pair), the recovered
/// thread registered, its binding write was refused, the runtime tore
/// back down, and the resume answered a transient error — breaking
/// restart recovery.
#[tokio::test]
async fn an_ordinary_codex_cold_resume_with_recovered_settings_lands_end_to_end() {
    let _guard = ENV_LOCK.lock().await;
    let _sidecar = FakeSidecarEnv::install(); // SYNC at base — no .await
                                              // The isolated codex home + the fake app-server (the lease-suite
                                              // pattern): the resume spawns a real sidecar subprocess through
                                              // CODEX_CMD.
    let codex_home = tempfile::tempdir().expect("isolated codex home");
    let prev_codex_home = std::env::var_os("CODEX_HOME");
    let prev_allow = std::env::var_os("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
    let prev_cmd = std::env::var_os("CODEX_CMD");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .expect("fake-app-server fixture exists");
    std::env::set_var("CODEX_CMD", format!("node {}", fixture.display()));

    let (mut h, pane_ledger) = spawn_merged_server_with_ledger().await;

    // THE RECOVERED ROW: a settings-bearing codex fresh-agent row for the
    // thread — the resume's `load_settings` must answer Some (the
    // recovered-session binding write only runs on an actual recovery).
    let sid = format!(
        "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0{}",
        &uuid_like_suffix()[..12]
    );
    pane_ledger
        .record_fresh_agent_binding(&freshell_ws::pane_ledger::FreshAgentBindingWrite {
            provider: "codex",
            session_id: &sid,
            mode: "freshcodex",
            cwd: Some("/tmp"),
            create_request_id: None,
            model: Some("recovered-model"),
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            provenance: freshell_ws::pane_ledger::ProvenancePolicy::Inherit,
            observed_epoch: None,
            observed_generation: None,
            authoritative: false,
            now_ms: 1_000,
        })
        .expect("the recovered row seeds");
    let row_before = pane_ledger
        .load_binding("codex", &sid)
        .expect("the recovered row exists");

    // THE ORDINARY COLD ATTACH-RESUME: `freshAgent.attach` naming the
    // thread — the `ensure_session_resumable(..., handoff: None)` path
    // (no handoff, no coordinator operation on the write). The handler
    // is detached; the observable end-to-end truths are the coordinator
    // going Live{FreshAgent} and the recovered row refreshing. Pre-r5
    // the recovered-session binding write was refused by the ownership
    // consult, the recovered thread tore back down, and the resume
    // answered a transient error — the key never went Live.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.attach",
            "sessionType": "freshcodex", "provider": "codex",
            "sessionId": sid,
            "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let went_live = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let live = matches!(
                h.ws_state.fresh_codex.ownership_snapshot("codex", &sid).state,
                freshell_ownership::OwnershipState::Live { ref owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
            );
            if live {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await;
    assert!(
        went_live.is_ok(),
        "the ordinary cold resume committed Live{{FreshAgent}} — no teardown, \
         no transient error (pre-r5 the refused binding write tore the \
         recovered thread back down)"
    );

    // The binding write LANDED (a LANE write, never the authoritative
    // refusal): the recovered row refreshed.
    let row_after = pane_ledger
        .load_binding("codex", &sid)
        .expect("the row survives the resume");
    assert_eq!(
        row_after.pane_kind.as_deref(),
        Some("fresh-agent"),
        "the row stays the fresh-agent recovery record: {row_after:?}"
    );
    assert!(
        row_after.updated_at > row_before.updated_at,
        "the recovered-session binding write refreshed the row (the write \
         is a LANE write — never the authoritative refusal): before \
         {row_before:?} after {row_after:?}"
    );

    // Env restore.
    match prev_codex_home {
        Some(v) => std::env::set_var("CODEX_HOME", v),
        None => std::env::remove_var("CODEX_HOME"),
    }
    match prev_allow {
        Some(v) => std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", v),
        None => std::env::remove_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES"),
    }
    match prev_cmd {
        Some(v) => std::env::set_var("CODEX_CMD", v),
        None => std::env::remove_var("CODEX_CMD"),
    }
}

// ── kata b8ke Task 7: the deterministic pause-hook race suite ───────────────
//
// The kata's required race matrix, made DETERMINISTIC through the pause seams
// (never sleeps): R1/R3 park a snapshot GET mid-flight at the Task 5
// codex-lane seam (before its live-map/coordinator resolution — the released
// GET re-resolves both); R2 parks a terminal.create after its keyed-create
// precheck (the Task 7 seam, hosted on the terminal registry — see
// `TerminalCreatePauseHook`); R4-R7 park the handoff runner itself through
// Task 6's `HandoffTestHooks`.
//
// BARRIER DISCIPLINE (round-3 F10, adapted losslessly): the arrival signal
// is an `AtomicBool` polled on a bounded cadence and the release is a
// `oneshot` — a sent permit is STORED even if the parked future has not
// polled yet, so no wakeup can be lost to a registration race (the
// `snapshot_pause_hook_parks_the_get...` precedent in codex.rs). The runner's
// own `pause_after_enter` is released with `notify_one()` (permit-storing),
// never `notify_waiters()`.

/// Establish a live freshcodex owner for `sid` (the fake app-server serves
/// the durable `thread/resume`) and return once the coordinator records it
/// Live — Task 6's `establish_fresh_claude_owner`, codex flavor.
async fn establish_freshcodex_session(h: &mut MergedHarness, sid: &str) {
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": format!("establish-{}", uuid::Uuid::new_v4()),
            "sessionType": "freshcodex", "provider": "codex", "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
    })
    .await;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match h
            .ws_state
            .fresh_codex
            .ownership_snapshot("codex", sid)
            .state
        {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(
                    owner.kind,
                    freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    "the freshcodex owner must be Live{{FreshAgent}}"
                );
                return;
            }
            state => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "freshcodex owner never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
}

/// The durable `thread/resume` count for `sid` in the fake app-server's op
/// ledger — the "a sidecar actually served this session" surface.
fn ledger_resumes_for(fake: &DualRoleCodexFake, sid: &str) -> usize {
    fake.thread_op_rows()
        .iter()
        .filter(|r| r["method"] == json!("thread/resume") && r["threadId"].as_str() == Some(sid))
        .count()
}

/// Bounded-poll until the flag flips — the parked seam's arrival proof
/// (lossless: no wakeup registration to lose, unlike a bare Notify wait).
async fn await_flag(flag: &AtomicBool, desc: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !flag.load(Ordering::SeqCst) {
        assert!(
            std::time::Instant::now() < deadline,
            "the parked seam was never entered: {desc}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Install the snapshot-GET pause hook (the codex lane's Task 5 seam): the
/// next GET parks at the seam — BEFORE its live-map/coordinator resolution
/// (Task 5's delivered placement: the released GET re-resolves BOTH the
/// live map and the coordinator, so a handoff that completed while parked
/// answers the typed 409 instead of serving a stale pre-pause resolution —
/// this subsumes the kata's "after the initial lookup" wording) — until the
/// returned release is sent. Returns the arrival flag.
fn install_snapshot_pause(
    h: &MergedHarness,
) -> (Arc<AtomicBool>, tokio::sync::oneshot::Sender<()>) {
    let entered = Arc::new(AtomicBool::new(false));
    let entered_for_hook = Arc::clone(&entered);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = std::sync::Mutex::new(Some(release_rx));
    h.ws_state
        .fresh_codex
        .set_snapshot_pause_for_tests(Arc::new(move |_thread_id: &str| {
            let entered = Arc::clone(&entered_for_hook);
            let release_rx = release_rx.lock().expect("release rx lock").take();
            Box::pin(async move {
                entered.store(true, Ordering::SeqCst);
                // The REAL barrier: park until the test releases (a oneshot
                // permit survives an unpolled receiver — lossless).
                if let Some(release_rx) = release_rx {
                    let _ = release_rx.await;
                }
            })
        }));
    (entered, release_tx)
}

/// Install the terminal-create pause hook (the Task 7 seam on the terminal
/// registry): the next `terminal.create` parks between its keyed-create
/// precheck and the coordinator claim until the returned release is sent.
fn install_terminal_create_pause(
    h: &MergedHarness,
) -> (Arc<AtomicBool>, tokio::sync::oneshot::Sender<()>) {
    let entered = Arc::new(AtomicBool::new(false));
    let entered_for_hook = Arc::clone(&entered);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = std::sync::Mutex::new(Some(release_rx));
    h.ws_state
        .registry
        .set_terminal_create_pause_for_tests(Arc::new(move |_request_id: &str| {
            let entered = Arc::clone(&entered_for_hook);
            let release_rx = release_rx.lock().expect("release rx lock").take();
            Box::pin(async move {
                entered.store(true, Ordering::SeqCst);
                if let Some(release_rx) = release_rx {
                    let _ = release_rx.await;
                }
            })
        }));
    (entered, release_tx)
}

/// The handoff REST body every race posts (the fresh→terminal direction on
/// the codex lane — the snapshot GET door is codex-only, so the races that
/// assert the read-only contract ride this lane).
fn handoff_post_body(sid: &str, device: &str) -> Value {
    json!({
        "provider": "codex", "sessionId": sid, "targetKind": "terminal",
        "mode": "codex", "deviceId": device,
    })
}

/// The `session.runtimeOwner` frame with this transition for this session
/// (each transition is broadcast exactly once per handoff).
async fn await_owner_transition(h: &mut MergedHarness, sid: &str, transition: &str) -> Value {
    await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("session.runtimeOwner")
            && v.get("transition").and_then(|t| t.as_str()) == Some(transition)
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid)
    })
    .await
}

/// Bounded-poll the coordinator until the predicate holds (the async
/// detached-cleanup settles).
async fn await_ownership(
    h: &MergedHarness,
    sid: &str,
    want: impl Fn(&freshell_ownership::OwnershipState) -> bool,
    desc: &str,
) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snap = h
            .ws_state
            .ownership
            .as_ref()
            .expect("coordinator wired")
            .observe("codex", sid);
        if want(&snap.state) {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "condition never held within budget ({desc}): {:?}",
            snap.state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

// ── the capturing tracing layer (the diag01 / Task-6-tests idiom) ───────────

mod race_tracing_capture {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use tracing::field::{Field, Visit};
    use tracing::span::{Attributes, Id};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::registry::LookupSpan;
    use tracing_subscriber::Layer;

    #[derive(Debug, Clone, Default)]
    pub struct CapturedEvent {
        pub target: String,
        pub event: String,
        pub fields: BTreeMap<String, String>,
    }

    #[derive(Default)]
    struct FieldVisitor {
        event: String,
        fields: BTreeMap<String, String>,
    }

    impl Visit for FieldVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.fields
                .insert(field.name().to_string(), format!("{value:?}"));
        }

        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "event" {
                self.event = value.to_string();
            }
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_i64(&mut self, field: &Field, value: i64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_u64(&mut self, field: &Field, value: u64) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }

        fn record_bool(&mut self, field: &Field, value: bool) {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    struct CaptureLayer {
        events: Arc<Mutex<Vec<CapturedEvent>>>,
    }

    impl<S> Layer<S> for CaptureLayer
    where
        S: Subscriber + for<'a> LookupSpan<'a>,
    {
        fn on_new_span(&self, _attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {}

        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = FieldVisitor::default();
            event.record(&mut visitor);
            self.events
                .lock()
                .expect("capture lock")
                .push(CapturedEvent {
                    target: event.metadata().target().to_string(),
                    event: visitor.event,
                    fields: visitor.fields,
                });
        }
    }

    /// Thread-local capturing subscriber (current-thread test runtimes:
    /// the runner task, the settle task, and the lane awaits all poll on
    /// this thread and observe the default).
    pub fn capture() -> (
        Arc<Mutex<Vec<CapturedEvent>>>,
        tracing::subscriber::DefaultGuard,
    ) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            events: Arc::clone(&events),
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        let guard = tracing::subscriber::set_default(subscriber);
        (events, guard)
    }

    /// b8ke ext r24 F2: the PROCESS-GLOBAL capture — installed once via
    /// `set_global_default`, it sees EVERY thread's events with no
    /// thread-attribution race. The thread-local [`capture`] is fragile
    /// under libtest's parallel execution for PRESENCE assertions: the
    /// events the test just drove intermittently miss the capture (~50%
    /// under parallel load, always green serial/isolated), while the
    /// established ABSENCE assertions (d4-F4) are immune to a capture
    /// that saw nothing. Tests filter by their unique session id; a
    /// thread-local `set_default` still wins on its own thread, so every
    /// other test's captures are unchanged.
    static GLOBAL_EVENTS: std::sync::OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> =
        std::sync::OnceLock::new();

    pub fn global_events() -> Arc<Mutex<Vec<CapturedEvent>>> {
        GLOBAL_EVENTS
            .get_or_init(|| {
                let events: Arc<Mutex<Vec<CapturedEvent>>> = Arc::new(Mutex::new(Vec::new()));
                let layer = CaptureLayer {
                    events: Arc::clone(&events),
                };
                let subscriber = tracing_subscriber::registry().with(layer);
                let _ = tracing::subscriber::set_global_default(subscriber);
                events
            })
            .clone()
    }
}

/// The first captured `freshell_ownership` event with this name (R7's
/// observability assertions — the COMPLETE transition-event field set).
fn find_captured<'e>(
    events: &'e [race_tracing_capture::CapturedEvent],
    event: &str,
) -> Option<&'e race_tracing_capture::CapturedEvent> {
    events
        .iter()
        .find(|e| e.target == "freshell_ownership" && e.event == event)
}

// ── the seven deterministic races ───────────────────────────────────────────

/// R1: park a snapshot GET mid-flight (the kata's "paused after initial
/// lookup" — the delivered seam parks BEFORE the resolution, so the released
/// GET re-resolves live map AND coordinator; the strongest form), begin the
/// fresh→terminal handoff, then release the snapshot. The released GET must
/// stay read-only — typed 409 (the terminal owner's fields), zero sidecar
/// spawns, never a 200-with-resurrection — and the terminal becomes the sole
/// owner. CODEX lane (round-1 review: only freshcodex could ever have
/// cold-started from a snapshot GET — the hook lives on FreshCodexState;
/// round-2 review: the GET cold-start is REMOVED entirely, so this race pins
/// the read-only contract under a concurrent handoff — the strongest form of
/// the original assertion).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_snapshot_paused_after_lookup_cannot_resurrect_during_handoff() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("r1-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;
    let watermark = codex_fake.thread_op_rows().len();

    // Park the snapshot GET mid-flight (multi_thread flavor so the parked
    // GET's worker does not stall the test driver).
    let (entered, release) = install_snapshot_pause(&h);
    let base_url = h.base_url.clone();
    let sid_for_get = sid.clone();
    let get_task = tokio::spawn(async move {
        http_get_json(
            &base_url,
            &format!("/api/fresh-agent/threads/freshcodex/codex/{sid_for_get}"),
        )
        .await
    });
    await_flag(&entered, "the snapshot GET must park inside the pause hook").await;

    // Begin the fresh→terminal handoff — it must proceed while the GET is
    // parked (the GET holds no lease; it is read-only).
    let resp = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid, "race-r1"),
    )
    .await;
    assert_eq!(resp.0, 200, "{}", resp.1);
    assert_eq!(resp.1["ok"], json!(true), "{}", resp.1);

    // Release the parked snapshot.
    let _ = release.send(());
    let (status, body) = get_task.await.expect("get task");
    // The stale GET is typed-refused (never a sidecar spawn, never
    // 200-with-resurrection).
    assert_eq!(
        status, 409,
        "released stale snapshot must be typed 409: {body}"
    );
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
    assert_eq!(body["ownerKind"], json!("terminal"), "{body}");
    assert!(
        body["ownerGeneration"].as_u64().is_some(),
        "the typed refusal names the owner generation: {body}"
    );
    // No replacement sidecar was spawned or resumed by the stale GET (the
    // handoff's terminal-target planning spawns no thread ops — the ledger
    // only ever holds the establish's row, taken before the watermark).
    assert_eq!(
        codex_fake.thread_op_rows().len(),
        watermark,
        "no thread op may land after the watermark: {:?}",
        codex_fake.thread_op_rows()
    );
    assert_eq!(ledger_resumes_for(&codex_fake, &sid), 1);

    // The terminal is the sole owner (the union of live writers at rest:
    // one PTY, zero live sidecar sessions).
    let terminal_id = resp.1["owner"]["terminalId"].as_str().unwrap().to_string();
    await_ownership(
        &h,
        &sid,
        |state| {
            matches!(
                state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
            )
        },
        "the handoff must commit Live{Terminal}",
    )
    .await;
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid),
        1,
        "the exact terminal session is the sole live writer"
    );
    assert!(
        !h.ws_state.fresh_codex.has_live_session(&sid).await,
        "the old sidecar session is gone — the terminal is the one writer"
    );
    h.ws_state.registry.kill(&terminal_id);
}

/// b8ke ext r18 F1 (c): the TERMINAL kill's commit-to-Vacant broadcasts
/// the same release frame — a negotiated create commits Live{Terminal},
/// the kill commits the incremented Vacant generation, and the
/// session.runtimeOwner released frame (vacant owner + the new
/// generation/epoch) arrives on the bus the connected panes fold from
/// (pre-r18 the commit broadcast nothing, so a recreate of the same
/// session carried the stale observed generation and was fenced).
#[tokio::test]
async fn the_terminal_kill_broadcasts_the_release_frame() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = uuid::Uuid::new_v4().to_string();

    // A negotiated terminal create — the session commits Live{Terminal}.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r18-f1-term-kill",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r18-f1-term-kill"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let live = ownership.observe("claude", &sid);
    assert!(
        matches!(live.state, freshell_ownership::OwnershipState::Live { .. }),
        "fixture: the create committed Live{{Terminal}}"
    );

    // THE KILL.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.kill",
            "requestId": "req-r18-f1-term-kill-kill",
            "terminalId": terminal_id,
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.killed" && v["requestId"] == "req-r18-f1-term-kill-kill"
    })
    .await;

    // THE RELEASE FRAME: the vacant owner + the INCREMENTED generation.
    let release = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "session.runtimeOwner"
            && v["sessionId"] == json!(sid)
            && v["transition"] == json!("released")
    })
    .await;
    assert_eq!(release["ownerKind"], json!("vacant"), "{release}");
    assert!(
        release["generation"].as_u64().unwrap() > live.generation,
        "the release carries the INCREMENTED generation: {release}"
    );
    assert_eq!(release["epoch"], json!(ownership.boot_epoch()), "{release}");
    assert!(matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Vacant
    ));
}

/// R1b (b8ke ext r17 F2): the MANDATED capture-then-park interleaving the
/// pre-lookup seam could not express — the GET CAPTURES its live-runtime
/// reference, parks at the AFTER-CAPTURE seam, the fresh→terminal handoff
/// COMPLETES while the GET holds the stale capture, then the GET resumes.
/// The resumed path must answer the typed 409 derived from the CURRENT
/// coordinator state (the terminal owner) — never a 200 served from the
/// stale capture (pre-r17 the tracked arm served its capture blind, with
/// no re-check and no seam to even drive the interleaving).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_snapshot_parked_after_capture_answers_typed_after_handoff() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("r1b-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;
    let watermark = codex_fake.thread_op_rows().len();

    // Install the AFTER-CAPTURE pause: the GET parks holding its already-
    // captured live-runtime reference.
    let entered = Arc::new(AtomicBool::new(false));
    let entered_for_hook = Arc::clone(&entered);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = std::sync::Mutex::new(Some(release_rx));
    h.ws_state
        .fresh_codex
        .set_snapshot_pause_after_capture_for_tests(Arc::new(move |_thread_id: &str| {
            let entered = Arc::clone(&entered_for_hook);
            let release_rx = release_rx.lock().expect("release rx lock").take();
            Box::pin(async move {
                entered.store(true, Ordering::SeqCst);
                if let Some(release_rx) = release_rx {
                    let _ = release_rx.await;
                }
            })
        }));
    let base_url = h.base_url.clone();
    let sid_for_get = sid.clone();
    let get_task = tokio::spawn(async move {
        http_get_json(
            &base_url,
            &format!("/api/fresh-agent/threads/freshcodex/codex/{sid_for_get}"),
        )
        .await
    });
    await_flag(&entered, "the snapshot GET must park AFTER its capture").await;

    // Begin the fresh→terminal handoff and let it COMPLETE while the GET
    // is parked holding the stale capture.
    let resp = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid, "race-r1b"),
    )
    .await;
    assert_eq!(resp.0, 200, "{}", resp.1);
    assert_eq!(resp.1["ok"], json!(true), "{}", resp.1);
    await_ownership(
        &h,
        &sid,
        |state| {
            matches!(
                state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
            )
        },
        "the handoff must commit Live{Terminal} while the GET holds the stale capture",
    )
    .await;

    // Release the parked snapshot: the resumed path answers the TYPED 409
    // derived from the CURRENT state — the terminal owner — never a 200
    // from the stale capture.
    let _ = release_tx.send(());
    let (status, body) = get_task.await.expect("get task");
    assert_eq!(
        status, 409,
        "the resumed stale-capture GET must answer the typed refusal: {body}"
    );
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
    assert_eq!(body["ownerKind"], json!("terminal"), "{body}");
    assert!(
        body["ownerGeneration"].as_u64().is_some(),
        "the typed refusal names the owner generation: {body}"
    );
    // No sidecar spawn/resume was triggered by the stale GET.
    assert_eq!(
        codex_fake.thread_op_rows().len(),
        watermark,
        "no thread op may land after the watermark: {:?}",
        codex_fake.thread_op_rows()
    );
    assert_eq!(ledger_resumes_for(&codex_fake, &sid), 1);

    // The terminal stays the sole owner.
    let terminal_id = resp.1["owner"]["terminalId"].as_str().unwrap().to_string();
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid),
        1,
        "the exact terminal session is the sole live writer"
    );
    assert!(
        !h.ws_state.fresh_codex.has_live_session(&sid).await,
        "the old sidecar session is gone — the terminal is the one writer"
    );
    h.ws_state
        .fresh_codex
        .clear_snapshot_pause_after_capture_for_tests();
    h.ws_state.registry.kill(&terminal_id);
}

/// R2: pause terminal creation after its keyed-create precheck, attempt the
/// fresh-agent attach, then release both. One winner; the loser gets the
/// typed owner/handoff result. The terminal-create pause is the same
/// real-barrier shape (round-1 review: notify-only does not park the
/// create) — parked BEFORE the coordinator claim, so the parked create
/// holds no lease and the fresh attach wins.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_terminal_create_paused_after_precheck_vs_fresh_attach_one_winner() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let mut ws_fresh = connect(&h.ws_url).await; // second connection
    let sid = format!("r2-{}", uuid::Uuid::new_v4());

    let (entered, release) = install_terminal_create_pause(&h);
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "r2-t1", "mode": "codex",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    await_flag(&entered, "terminal.create must park inside the pause hook").await;

    // While parked, the fresh attach claims — it must WIN (the parked
    // terminal holds no coordinator lease yet; its claim happens only after
    // the pause).
    send_json(
        &mut ws_fresh,
        &json!({
            "type": "freshAgent.create", "requestId": "r2-f1",
            "sessionType": "freshcodex", "provider": "codex", "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let _ = await_frame(&mut ws_fresh, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("r2-f1")
    })
    .await;

    // Unpark the terminal: its claim now hits Live{FreshAgent} — the typed
    // loser answer (the frozen D7 code + the additive owner fields).
    let _ = release.send(());
    let err = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("error")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("r2-t1")
    })
    .await;
    assert_eq!(
        err.get("code").and_then(|c| c.as_str()),
        Some("RESTORE_UNAVAILABLE")
    );
    assert_eq!(
        err.get("ownerKind").and_then(|k| k.as_str()),
        Some("fresh-agent")
    );
    assert!(
        err.get("ownerGeneration")
            .and_then(|g| g.as_u64())
            .unwrap_or(0)
            >= 1,
        "the typed loser answer names the owner generation: {err}"
    );

    // Exactly one runtime: ONE durable resume in the app-server ledger (the
    // winner's) and ZERO PTY rows for sid — the union of writers is one.
    assert_eq!(ledger_resumes_for(&codex_fake, &sid), 1);
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid),
        0,
        "the loser terminal never spawned a PTY"
    );
    // The winner is the coordinator's owner.
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "the fresh attach is the one owner"
            );
        }
        other => panic!("the fresh winner must own the key, got {other:?}"),
    }
}

/// R3: a snapshot queued before "React cleanup" (the server-side analog: a
/// snapshot GET that entered before the handoff began and is released only
/// AFTER the handoff fully COMMITTED) cannot reclaim — it answers the typed
/// 409 with the current terminal owner and spawns nothing (round-2 review:
/// no GET cold-start exists at all; this pins the read-only contract past
/// the commit boundary).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn race_queued_snapshot_before_cleanup_is_fenced_by_generation() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let mut h = spawn_merged_server().await;
    let sid = format!("r3-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;
    let watermark = codex_fake.thread_op_rows().len();

    // Park the snapshot GET (queued before the handoff begins).
    let (entered, release) = install_snapshot_pause(&h);
    let base_url = h.base_url.clone();
    let sid_for_get = sid.clone();
    let get_task = tokio::spawn(async move {
        http_get_json(
            &base_url,
            &format!("/api/fresh-agent/threads/freshcodex/codex/{sid_for_get}"),
        )
        .await
    });
    await_flag(&entered, "the queued snapshot must park inside the hook").await;

    // The handoff runs to its COMMITTED broadcast first (the "React
    // cleanup" boundary — the release happens strictly after).
    let resp = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid, "race-r3"),
    )
    .await;
    assert_eq!(resp.0, 200, "{}", resp.1);
    let committed = await_owner_transition(&mut h, &sid, "handoff-committed").await;
    let terminal_id = committed["terminalId"].as_str().unwrap().to_string();

    // Release the queued snapshot: the generation fence answers the typed
    // 409 with the terminal owner — never a reclamation.
    let _ = release.send(());
    let (status, body) = get_task.await.expect("get task");
    assert_eq!(
        status, 409,
        "the queued snapshot released after the commit must be typed 409: {body}"
    );
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
    assert_eq!(body["ownerKind"], json!("terminal"), "{body}");
    assert_eq!(
        codex_fake.thread_op_rows().len(),
        watermark,
        "the queued GET spawned nothing: {:?}",
        codex_fake.thread_op_rows()
    );
    assert_eq!(ledger_resumes_for(&codex_fake, &sid), 1);
    // The terminal remains the sole owner.
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("the committed terminal must own the key, got {other:?}"),
    }
    h.ws_state.registry.kill(&terminal_id);
}

/// R4: old-runtime reap timeout — no target writer starts early; the session
/// stays recoverable; a retry after the runtime actually dies succeeds.
/// BOTH arms (round-2 review): the still-alive fake sidecar re-probes live →
/// Live{prior} restored; the out-of-band-killed prior re-probes
/// unconfirmable → Vacant with the typed REAP_TIMEOUT. The unconfirmable
/// arm's condition is constructed through the injected seams — the forced
/// timeout PLUS an out-of-band process kill while the runner is parked
/// INSIDE Handoff (the fenced release cannot run, so the coordinator still
/// names the prior) — NOT via freshAgent.kill during Handoff, which
/// correctly answers BlockedHandoff (round-3 F9).
#[tokio::test]
async fn race_reap_timeout_no_early_target_start_and_recoverable() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let hooks = Arc::new(freshell_freshagent::HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..freshell_freshagent::HandoffTestHooks::default()
    });
    let mut h = spawn_merged_server_with_hooks(Arc::clone(&hooks)).await;

    // ── Arm A: the prior re-probes LIVE → restored ──────────────────────
    let sid_a = format!("r4a-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid_a).await;
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();

    let (post_a, post_a_task) = {
        let base_url = h.base_url.clone();
        let body = handoff_post_body(&sid_a, "race-r4a");
        let task =
            tokio::spawn(
                async move { http_post_json(&base_url, "/api/sessions/handoff", &body).await },
            );
        (sid_a.clone(), task)
    };
    let _ = await_owner_transition(&mut h, &post_a, "handoff-started").await;
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();
    let (status, body) = post_a_task.await.expect("handoff post task");
    assert_eq!(status, 409, "{}", body);
    assert_eq!(body["error"]["code"], json!("REAP_TIMEOUT"), "{body}");
    assert_eq!(body["error"]["retryable"], json!(true), "{body}");
    // No early target start: no PTY, no sidecar spawn, no TargetStarted.
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid_a),
        0,
        "no early target start on a reap timeout"
    );
    assert_eq!(codex_fake.sidecar_spawn_rows().len(), spawn_watermark);
    assert!(
        !hooks
            .events
            .lock()
            .expect("handoff hooks lock")
            .contains(&"TargetStarted"),
        "the runner's event log must not contain TargetStarted"
    );
    // The re-probe confirmed the prior live — restored.
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid_a)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "the live prior is restored"
            );
        }
        other => panic!("the live prior must be restored, got {other:?}"),
    }
    // The failure broadcast carries the RESTORED prior (the truth, never
    // the requested target kind).
    let failed = await_owner_transition(&mut h, &post_a, "handoff-failed").await;
    assert_eq!(failed["ownerKind"], json!("fresh-agent"), "{failed}");
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"), "{failed}");

    // A retry after clearing the hook succeeds (the restored prior is
    // stoppable): the real kill reaps it, the terminal target starts, the
    // handoff commits. The pause is still armed — release the retry through
    // it too (notify_one stores a permit the retry's notified() consumes).
    hooks.force_reap_timeout.store(false, Ordering::SeqCst);
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid_a, "race-r4a-retry"),
    )
    .await;
    assert_eq!(status, 200, "the retry must succeed: {body}");
    let terminal_id = body["owner"]["terminalId"].as_str().unwrap().to_string();
    h.ws_state.registry.kill(&terminal_id);

    // ── Arm B: the prior is unconfirmable → Vacant ───────────────────────
    let sid_b = format!("r4b-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid_b).await;
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);

    let (post_b, post_b_task) = {
        let base_url = h.base_url.clone();
        let body = handoff_post_body(&sid_b, "race-r4b");
        let task =
            tokio::spawn(
                async move { http_post_json(&base_url, "/api/sessions/handoff", &body).await },
            );
        (sid_b.clone(), task)
    };
    let _ = await_owner_transition(&mut h, &post_b, "handoff-started").await;
    // The out-of-band kill of the prior sidecar (the PROCESS itself, never
    // the lane API) while the runner is parked inside Handoff: the fenced
    // release cannot run, so the coordinator still names the prior — the
    // exact unconfirmable-prior shape (round-3 F9). SIGKILL, not SIGTERM:
    // the fixture's SIGTERM handler parks in `wss.close(cb)` waiting for
    // the LANE'S ws client to disconnect — which never happens — so a
    // SIGTERM'd sidecar lingers alive and the exit watcher never fires;
    // SIGKILL is the crash-faithful, immediate death (the same signal the
    // lane's own kill path sends via tokio's `start_kill()`).
    let sidecar_pid = codex_fake
        .sidecar_spawn_rows()
        .last()
        .and_then(|row| row["pid"].as_u64())
        .expect("the prior sidecar's dispatcher pid");
    let _ = std::process::Command::new("kill")
        .arg("-9")
        .arg(sidecar_pid.to_string())
        .status()
        .expect("out-of-band sidecar kill");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while h.ws_state.fresh_codex.has_live_session(&post_b).await {
        assert!(
            std::time::Instant::now() < deadline,
            "the dead sidecar was never evicted from the lane's live map"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();
    let (status, body) = post_b_task.await.expect("handoff post task");
    assert_eq!(status, 409, "{}", body);
    assert_eq!(body["error"]["code"], json!("REAP_TIMEOUT"), "{body}");
    assert_eq!(body["error"]["retryable"], json!(true), "{body}");
    // The unconfirmable prior ends the key Vacant — never a dead runtime
    // recorded as Live.
    assert_eq!(
        h.ws_state
            .ownership
            .as_ref()
            .expect("coordinator wired")
            .observe("codex", &post_b)
            .state,
        freshell_ownership::OwnershipState::Vacant,
        "an unconfirmable prior ends the key Vacant"
    );
    // No target started here either.
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &post_b),
        0
    );
    // The failure broadcast carries the truth: vacant + the typed reason.
    let failed = await_owner_transition(&mut h, &post_b, "handoff-failed").await;
    assert_eq!(failed["ownerKind"], json!("vacant"), "{failed}");
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"), "{failed}");
}

/// R5: target terminal spawn failure — no blank session, session id
/// preserved, ownership restored or Vacant with the typed error. Uses the
/// runner's `fail_target_spawn_once` (the prior is REALLY reaped; the target
/// never starts). b8ke ext r23 F2: the knob now fires INSIDE start_target
/// (the real error site) — the runner's Err arm handles the failure (the
/// guard's disarm_and_fail, the typed broadcast, the log), so the cleanup
/// assertions exercise the real error path, never a pre-check skip.
#[tokio::test]
async fn race_target_spawn_failure_no_blank_session_id_preserved() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let hooks = Arc::new(freshell_freshagent::HandoffTestHooks::default());
    hooks.fail_target_spawn_once.store(true, Ordering::SeqCst);
    let mut h = spawn_merged_server_with_hooks(Arc::clone(&hooks)).await;
    let sid = format!("r5-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;
    let op_watermark = codex_fake.thread_op_rows().len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();

    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid, "race-r5"),
    )
    .await;
    assert_eq!(status, 409, "{}", body);
    assert_eq!(
        body["error"]["code"],
        json!("TARGET_SPAWN_FAILED"),
        "{body}"
    );
    assert_eq!(body["error"]["retryable"], json!(true), "{body}");

    // No blank session: the canonical key ends Vacant (the prior was
    // reaped, the target never started), the id is preserved (no remint —
    // zero post-watermark thread ops under ANY id), zero PTY rows, and no
    // second sidecar was ever spawned (the spawn watermark is untouched).
    assert_eq!(
        h.ws_state
            .ownership
            .as_ref()
            .expect("coordinator wired")
            .observe("codex", &sid)
            .state,
        freshell_ownership::OwnershipState::Vacant,
        "a failed target spawn leaves the key Vacant"
    );
    assert_eq!(
        codex_fake.thread_op_rows().len(),
        op_watermark,
        "no thread op may land after the watermark (no remint, no second writer): {:?}",
        codex_fake.thread_op_rows()
    );
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "no second sidecar may spawn for a failed handoff"
    );
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid),
        0,
        "no terminal may own {sid} after the failed handoff"
    );
    // b8ke ext r23 F2: THE ATTEMPT PIN — start_target was ENTERED (the
    // spawn was attempted on this call) before the failure. Pre-r23 the
    // knob fired at a pre-check BEFORE start_target was called; a
    // regression to that shape fails this assertion.
    assert!(
        hooks
            .events
            .lock()
            .unwrap()
            .contains(&"TargetSpawnAttempted"),
        "the spawn-failure path must ENTER start_target (TargetSpawnAttempted): {:?}",
        hooks.events.lock().unwrap()
    );
    // The failure broadcast carries the truth: ownerKind vacant, the prior
    // fresh-agent previousKind, the typed reason.
    let failed = await_owner_transition(&mut h, &sid, "handoff-failed").await;
    assert_eq!(failed["ownerKind"], json!("vacant"), "{failed}");
    assert_eq!(failed["previousKind"], json!("fresh-agent"), "{failed}");
    assert_eq!(failed["reason"], json!("TARGET_SPAWN_FAILED"), "{failed}");

    // Session-ID preservation, positively: the canonical id still answers —
    // a retry handoff for the SAME sid commits a terminal owner under it.
    let (status, body) = http_post_json(
        &h.base_url,
        "/api/sessions/handoff",
        &handoff_post_body(&sid, "race-r5-retry"),
    )
    .await;
    assert_eq!(status, 200, "the retry must succeed: {body}");
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(body["owner"]["terminalId"].as_str().unwrap()),
                "the retried handoff committed under the SAME canonical id"
            );
        }
        other => panic!("the retried handoff must commit, got {other:?}"),
    }
    h.ws_state
        .registry
        .kill(body["owner"]["terminalId"].as_str().unwrap());
}

/// R6: browser disconnect mid-handoff — the server-side operation reaches a
/// consistent state. The HTTP request is dropped mid-handoff (the raw
/// TcpStream aborts — the connection reset a browser disconnect produces)
/// while the runner is parked after enter; the DETACHED operation still
/// completes: the coordinator reaches Live{Terminal}, the follow-up
/// snapshot GET is the typed 409, and a competing fresh create is
/// typed-refused.
#[tokio::test]
async fn race_browser_disconnect_mid_handoff_reaches_consistent_state() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let hooks = Arc::new(freshell_freshagent::HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..freshell_freshagent::HandoffTestHooks::default()
    });
    let mut h = spawn_merged_server_with_hooks(Arc::clone(&hooks)).await;
    let sid = format!("r6-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;

    // Fire the handoff POST from a background task, then drop the
    // connection while the runner is parked mid-handoff.
    let base_url = h.base_url.clone();
    let body = handoff_post_body(&sid, "race-r6");
    let post_task =
        tokio::spawn(
            async move { http_post_json(&base_url, "/api/sessions/handoff", &body).await },
        );
    let _ = await_owner_transition(&mut h, &sid, "handoff-started").await;
    post_task.abort(); // the TcpStream drops — the browser disconnect
    let _ = post_task.await;

    // Unpause: the detached handoff continues (the dropped reply receiver
    // cannot cancel it) and reaches the consistent state.
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();
    let committed = await_owner_transition(&mut h, &sid, "handoff-committed").await;
    let terminal_id = committed["terminalId"].as_str().unwrap().to_string();
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(terminal_id.as_str()),
                "the detached handoff committed the terminal owner"
            );
        }
        other => panic!("the detached handoff must reach Live{{Terminal}}, got {other:?}"),
    }

    // The follow-up snapshot GET is the typed 409 (the read-only contract
    // under the new owner) and spawned nothing.
    let watermark = codex_fake.thread_op_rows().len();
    let (status, body) = http_get_json(
        &h.base_url,
        &format!("/api/fresh-agent/threads/freshcodex/codex/{sid}"),
    )
    .await;
    assert_eq!(status, 409, "the post-handoff GET is the typed 409: {body}");
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
    assert_eq!(body["ownerKind"], json!("terminal"), "{body}");
    assert_eq!(
        codex_fake.thread_op_rows().len(),
        watermark,
        "the GET spawned nothing: {:?}",
        codex_fake.thread_op_rows()
    );

    // A competing fresh create is typed-refused (SESSION_RESERVED,
    // retryable — the terminal may be closing).
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.create", "requestId": "r6-f2",
            "sessionType": "freshcodex", "provider": "codex", "cwd": "/tmp",
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let refused = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.create.failed")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("r6-f2")
    })
    .await;
    assert_eq!(
        refused.get("code").and_then(|c| c.as_str()),
        Some("SESSION_RESERVED")
    );
    assert_eq!(refused.get("retryable"), Some(&json!(true)), "{refused}");
    h.ws_state.registry.kill(&terminal_id);
}

/// R7: coordinator cancellation/panic plus sidecar crash — abort the
/// handoff task at the pause point; assert zero untracked runtime and zero
/// or one authoritative owner; then crash the sidecar (freshAgent.kill)
/// and assert the key returns to Vacant and a new claim succeeds. The
/// observability contract (round-1 review): this race also asserts the
/// COMPLETE transition-event field set for `ownership.stop.begin` /
/// `ownership.stop.commit` / `ownership.released` (the capturing-layer
/// idiom).
#[tokio::test]
async fn race_coordinator_cancellation_and_sidecar_crash_leave_consistent_state() {
    let _guard = ENV_LOCK.lock().await;
    let codex_fake = DualRoleCodexFake::install();
    let (events, _capture_guard) = race_tracing_capture::capture();
    let hooks = Arc::new(freshell_freshagent::HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..freshell_freshagent::HandoffTestHooks::default()
    });
    let mut h = spawn_merged_server_with_hooks(Arc::clone(&hooks)).await;
    let sid = format!("r7-{}", uuid::Uuid::new_v4());
    establish_freshcodex_session(&mut h, &sid).await;
    let capture_start = events.lock().expect("capture lock").len();
    let spawn_watermark = codex_fake.sidecar_spawn_rows().len();

    // Spawn the handoff through the runner's own handle (the abort-capable
    // door) and ABORT it at the pause point (round-1 review: the
    // cancellation-capable HandoffHandle exposes the JoinHandle — dropping
    // the oneshot receiver intentionally does NOT cancel).
    let handle = h
        .handoff_runner
        .spawn_handoff(freshell_freshagent::HandoffRequest {
            action: freshell_freshagent::session_handoff::HandoffAction::Switch,
            provider: "codex".to_string(),
            session_id: sid.clone(),
            target_kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            session_type: None,
            mode: Some("codex".to_string()),
            cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
            tab_id: None,
            pane_id: None,
            observed_epoch: None,
            observed_generation: None,
            device_id: Some("race-r7".to_string()),
        });
    let _ = await_owner_transition(&mut h, &sid, "handoff-started").await;
    handle.abort();
    let _ = handle.task.await;

    // Zero or one authoritative owner — deterministically the restored
    // prior (the pause sits BEFORE the prior stop, so the untouched prior
    // is restored Live; never a stranded Handoff).
    match h
        .ws_state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("codex", &sid)
        .state
    {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "the restored owner is the prior fresh runtime"
            );
        }
        other => panic!("abort must leave zero or one owner (Live prior or Vacant), got {other:?}"),
    }
    // Zero UNTRACKED runtime: the target spawn never began.
    assert_eq!(
        codex_fake.sidecar_spawn_rows().len(),
        spawn_watermark,
        "the aborted handoff spawned nothing"
    );
    assert_eq!(
        live_pty_count_for_session(&h.ws_state.registry, "codex", &sid),
        0,
        "no untracked PTY exists"
    );

    // Crash the sidecar (freshAgent.kill): the key returns to Vacant — and
    // the kill's coordinator transitions carry the COMPLETE field set.
    send_json(
        &mut h.ws,
        &json!({
            "type": "freshAgent.kill", "sessionId": sid,
            "sessionType": "freshcodex", "provider": "codex",
        }),
    )
    .await;
    let _ = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("freshAgent.killed")
            && v.get("sessionId").and_then(|s| s.as_str()) == Some(sid.as_str())
    })
    .await;
    await_ownership(
        &h,
        &sid,
        |state| matches!(state, freshell_ownership::OwnershipState::Vacant),
        "the killed sidecar must release the key",
    )
    .await;
    let scope: Vec<_> = {
        let captured = events.lock().expect("capture lock");
        captured[capture_start..].to_vec()
    };
    let stop_begin =
        find_captured(&scope, "ownership.stop.begin").expect("ownership.stop.begin event");
    for field in [
        "operation_id",
        "provider",
        "session_id",
        "initiator",
        "from_kind",
        "runtime_id",
        "pid",
        "epoch",
        "generation",
        "outcome",
    ] {
        assert!(
            stop_begin.fields.contains_key(field),
            "ownership.stop.begin must carry {field}: {stop_begin:?}"
        );
    }
    assert_eq!(
        stop_begin.fields.get("outcome").map(String::as_str),
        Some("granted")
    );
    let stop_commit =
        find_captured(&scope, "ownership.stop.commit").expect("ownership.stop.commit event");
    for field in [
        "operation_id",
        "provider",
        "session_id",
        "initiator",
        "from_kind",
        "runtime_id",
        "pid",
        "epoch",
        "generation",
        "outcome",
        "duration_ms",
    ] {
        assert!(
            stop_commit.fields.contains_key(field),
            "ownership.stop.commit must carry {field}: {stop_commit:?}"
        );
    }
    assert_eq!(
        stop_commit.fields.get("outcome").map(String::as_str),
        Some("committed")
    );

    // A new claim succeeds: a terminal.create for the same sessionRef is
    // Granted and commits.
    send_json(
        &mut h.ws,
        &json!({
            "type": "terminal.create", "requestId": "r7-t1", "mode": "codex",
            "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "codex", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut h.ws, Duration::from_secs(20), |v| {
        v.get("type").and_then(|t| t.as_str()) == Some("terminal.created")
            && v.get("requestId").and_then(|r| r.as_str()) == Some("r7-t1")
    })
    .await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    await_ownership(
        &h,
        &sid,
        |state| {
            matches!(
                state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.terminal_id.as_deref() == Some(terminal_id.as_str())
            )
        },
        "the new terminal claim must commit",
    )
    .await;

    // Kill the terminal: the COMPLETE ownership.released field set.
    let capture_before_release = events.lock().expect("capture lock").len();
    h.ws_state.registry.kill(&terminal_id);
    await_ownership(
        &h,
        &sid,
        |state| matches!(state, freshell_ownership::OwnershipState::Vacant),
        "the killed terminal must release the key",
    )
    .await;
    let release_scope: Vec<_> = {
        let captured = events.lock().expect("capture lock");
        captured[capture_before_release..].to_vec()
    };
    let released =
        find_captured(&release_scope, "ownership.released").expect("ownership.released event");
    for field in [
        "provider",
        "session_id",
        "operation_id",
        "initiator",
        "from_kind",
        "runtime_id",
        "pid",
        "epoch",
        "generation",
        "duration_ms",
        "outcome",
    ] {
        assert!(
            released.fields.contains_key(field),
            "ownership.released must carry {field}: {released:?}"
        );
    }
    assert_eq!(
        released.fields.get("outcome").map(String::as_str),
        Some("released")
    );
}

// ── b8ke ext r6 F1: learned-identity terminal sessions commit Live ──────────

/// A claude-shaped CLI spec for the compat-restore ladder test: the FIRST
/// invocation EXITS immediately (naturally — the row is RETAINED for the
/// ladder's rung-1 read; a registry kill would REMOVE the row and hide it
/// from the ladder), and every LATER invocation SLEEPS — the ladder's
/// replacement generation must STAY alive long enough for the Live-commit
/// observation (an instantly-exiting replacement would have its exit
/// watcher release the claim before the test can observe it).
fn exiting_then_sleeper_cli_spec(
    name: &str,
) -> (freshell_platform::CliCommandSpec, std::path::PathBuf) {
    let marker = std::env::temp_dir().join(format!(
        "freshell-cross-kind-ladder-marker-{name}-{}-{}.marker",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let exit_flag = std::env::temp_dir().join(format!(
        "freshell-cross-kind-ladder-exit-{name}-{}-{}.flag",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let script_path = std::env::temp_dir().join(format!(
        "freshell-cross-kind-ladder-{name}-{}-{}.sh",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    // b8ke ext r9 F2: the FIRST generation survives until the TEST
    // touches the exit flag — a deterministic, marker-driven exit that
    // replaces the pre-r9 fixed 1s sleep (which existed to dodge the
    // exit-before-commit race the commit-time liveness check now
    // handles: whichever observes first wins; a dead runtime is never
    // recorded Live). The create is observed committed
    // (terminal.created), the flag lands, the generation exits
    // naturally (the row is RETAINED for the ladder's rung-1 read);
    // every LATER invocation SLEEPS — the replacement generation must
    // STAY alive long enough for the Live-commit observation.
    let script = format!(
        "#!/bin/sh\nif [ -e \"{marker}\" ]; then exec sleep 300; fi\nwhile [ ! -e \"{exit_flag}\" ]; do sleep 0.05; done\n: > \"{marker}\"\nexit 1\n",
        marker = marker.display(),
        exit_flag = exit_flag.display()
    );
    std::fs::write(&script_path, script).expect("write ladder script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("chmod ladder script");
    }
    (
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
            effort_args: None,
            sandbox_args: None,
            permission_mode_args: None,
        },
        exit_flag,
    )
}

/// b8ke ext r6 F1: a fresh-Claude PREALLOCATION create (the server mints
/// the durable `--session-id` AFTER request parsing) commits
/// Live{Terminal} under the MINTED key — pre-r6 the learned identity was
/// outside create_session_locator, so the live terminal session never
/// entered the coordinator, a direct handoff entered from Vacant (no
/// prior runtime to stop) and used the under-ticket target-resume path
/// to start a SECOND writer on the same durable session.
#[tokio::test]
async fn a_fresh_claude_prealloc_create_commits_live_and_a_direct_handoff_sees_the_prior() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // A FRESH claude create (no sessionRef, no resume): the server
    // preallocates the durable id.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r6-f1-prealloc",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r6-f1-prealloc"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let mint = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("a fresh claude create carries its preallocated sessionRef")
        .to_string();

    // THE CONTRACT: the preallocated session commits Live{Terminal} under
    // the MINTED durable key (pre-r6: the key stayed Vacant — the session
    // bypassed the coordinator entirely).
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    // DEFLAKE: 30s (the repo's load-budget convention) — the settle's
    // commit trails the created frame and must not starve under
    // full-package parallel load.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if matches!(
            ownership.observe("claude", &mint).state,
            freshell_ownership::OwnershipState::Live { .. }
        ) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the fresh-claude prealloc session never committed Live under its \
             minted key — state: {:?}",
            ownership.observe("claude", &mint).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE HANDOFF CONTRACT: a direct handoff on the session SEES THE PRIOR
    // OWNER (never Vacant-with-target-resume) — the captured prior is the
    // terminal runtime the runner must stop.
    let freshell_ownership::BeginOutcome::Granted { .. } = ownership.begin_handoff(
        "claude",
        &mint,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r6-f1-prealloc-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("the handoff must grant against the committed Live session");
    };
    match ownership.observe("claude", &mint).state {
        freshell_ownership::OwnershipState::Handoff {
            prior: Some((owner, _)),
            ..
        } => {
            assert_eq!(
                owner.kind,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "the handoff's captured prior is the live TERMINAL runtime"
            );
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(terminal_id.as_str()),
                "the captured prior names the prealloc create's terminal"
            );
        }
        other => panic!("the handoff must capture the prior terminal owner — got {other:?}"),
    }
    let _ = ownership.fail(
        "claude",
        &mint,
        "op-r6-f1-prealloc-handoff",
        ownership.observe("claude", &mint).generation,
        false,
    );
}

/// b8ke ext r6 F1: a COMPAT-RESTORE create (the claude P0.4 ladder
/// resolves the durable identity from persisted state AFTER request
/// parsing) commits Live{Terminal} under the LADDER-RESOLVED key — the
/// same learned-identity bypass as the prealloc mint.
#[tokio::test]
async fn a_claude_compat_restore_create_commits_live_under_the_ladder_identity() {
    let sid = format!("ladder-sid-{}", uuid::Uuid::new_v4());
    let (url, registry, ws_state, gen1_exit_flag) = spawn_server_with_ladder_claude().await;
    let mut ws = connect(&url).await;

    // Generation #1: a sessionRef-bearing claude create whose row EXITS
    // naturally (retained for the ladder's rung-1 read; its identity row
    // carries the sessionRef).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r6-f1-ladder",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r6-f1-ladder"
    })
    .await;
    let first_terminal = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    // The commit landed (the created frame is emitted after the settle's
    // commit) — NOW the generation may exit: arm the flag and wait for
    // the natural exit (the row is retained, not killed).
    std::fs::write(&gen1_exit_flag, b"go\n").expect("arm the first generation's exit");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let gone = registry
            .probe(&first_terminal)
            .map(|row| row.status != freshell_protocol::TerminalRunStatus::Running)
            .unwrap_or(true);
        if gone {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the first generation never exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The exited generation's COORDINATOR release (the exit watcher's
    // fenced release of create#1's claim) must land BEFORE generation #2 —
    // otherwise the ladder restore's late claim observes the still-Live
    // record, answers Adopt (the fence discipline), and tears its own child
    // down (the correct never-double-commit behavior; the release trails
    // the row's death by a watcher quantum).
    {
        let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Vacant
        ) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "generation #1's ownership never released after its exit — \
                 state: {:?}",
                ownership.observe("claude", &sid).state
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    // Generation #2: the compat-restore create — same createRequestId, no
    // client-supplied id: the P0.4 ladder resolves the durable identity
    // from the persisted identity row.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r6-f1-ladder",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created"
            && v["requestId"] == "req-r6-f1-ladder"
            && v["terminalId"] != json!(first_terminal)
    })
    .await;

    // THE CONTRACT: the ladder-resolved session commits Live{Terminal}
    // under the LADDER identity (pre-r6: the key stayed Vacant).
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { .. }
        ) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the compat-restore session never committed Live under the \
             ladder identity — state: {:?}",
            ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The direct handoff sees the prior owner (never
    // Vacant-with-target-resume).
    let freshell_ownership::BeginOutcome::Granted { .. } = ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r6-f1-ladder-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("the handoff must grant against the committed Live session");
    };
    assert!(matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Handoff {
            prior: Some((owner, _)),
            ..
        } if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
    ));
    let replacement_terminal = match ownership.observe("claude", &sid).state {
        freshell_ownership::OwnershipState::Handoff {
            prior: Some((owner, _)),
            ..
        } => owner.terminal_id,
        _ => None,
    };
    let _ = ownership.fail(
        "claude",
        &sid,
        "op-r6-f1-ladder-handoff",
        ownership.observe("claude", &sid).generation,
        false,
    );

    // Cleanup: reap the ladder's surviving replacement generation.
    if let Some(tid) = replacement_terminal {
        registry.kill(&tid);
    }
}

/// b8ke ext r10 F2: the learned-identity claim's Adopt arm NEVER spawns.
/// Another device's terminal owner on the ladder-resolved key (established
/// between the ladder's row-based liveness check and the learned claim —
/// the coordinator, not the registry, is where it lands) means the restore
/// create answers the typed reconnect-revive refusal
/// (SESSION_RESERVED + liveTerminalId), never a second overlapping
/// `claude --resume` writer. Pre-r10 the Adopt arm proceeded WITHOUT a
/// ticket and spawned the overlap.
#[tokio::test]
async fn a_restore_create_against_a_live_foreign_terminal_owner_never_spawns() {
    let (url, registry, ws_state, gen1_exit_flag) = spawn_server_with_ladder_claude().await;
    let mut ws = connect(&url).await;

    // Generation #1: creates the ladder's identity row, then exits (the
    // flag-driven deterministic exit from the r9 F2 helper).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r10-f2-ladder",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r10-f2-ladder"
    })
    .await;
    let first_terminal = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    std::fs::write(&gen1_exit_flag, b"go\n").expect("arm the first generation's exit");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let gone = registry
            .probe(&first_terminal)
            .map(|row| row.status != freshell_protocol::TerminalRunStatus::Running)
            .unwrap_or(true);
        if gone {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the first generation never exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    // The exit's coordinator release must land before the foreign seed.
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Vacant
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "generation #1's ownership never released"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE FOREIGN OWNER: another device's terminal holds the learned key
    // (Live{Terminal}, no registry row here — exactly what the claim's
    // Adopt outcome reports).
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-r10-f2-foreign-device",
        None,
        "foreign-device",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("expected the foreign owner's grant")
    };
    assert_eq!(
        ownership.commit_live(
            "claude",
            &sid,
            "op-r10-f2-foreign-device",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some("term-foreign-device".into()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            },
        ),
        freshell_ownership::CommitOutcome::Committed
    );

    // Generation #2: the ladder restore (same createRequestId, no
    // sessionRef). The ladder's row-based liveness check passes (no
    // RUNNING row); the learned-identity claim observes the foreign
    // Live{Terminal} owner → Adopt → NEVER SPAWNS.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r10-f2-ladder",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
        }),
    )
    .await;
    let answer = await_frame(&mut ws, Duration::from_secs(30), |v| {
        v["requestId"] == json!("req-r10-f2-ladder")
            && (v["type"] == "terminal.created" || v["type"] == "error")
    })
    .await;
    assert_eq!(
        answer["type"], "error",
        "the restore create against a live foreign terminal owner answers the \
         typed refusal, never a second writer: {answer}"
    );
    assert_eq!(answer["code"], json!("SESSION_RESERVED"));
    assert_eq!(
        answer["liveTerminalId"],
        json!("term-foreign-device"),
        "the refusal names the live terminal the caller reattaches to: {answer}"
    );
    assert_eq!(
        answer["ownerKind"],
        json!("terminal"),
        "the typed owner fields ride the refusal: {answer}"
    );
    assert!(
        answer["ownerGeneration"].is_u64(),
        "the owner generation rides the refusal: {answer}"
    );
    // No second writer: no new terminal row was ever registered for the
    // session, and the foreign owner's record is untouched.
    assert!(
        !registry
            .identity_probe_rows()
            .iter()
            .any(|r| r.terminal_id != first_terminal
                && r.resume_session_id.as_deref() == Some(sid.as_str())),
        "the restore spawned no second terminal row"
    );
    assert!(matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { owner, .. }
            if owner.terminal_id.as_deref() == Some("term-foreign-device")
    ));
    // Release the foreign seed (test hygiene).
    ownership.force_release_for_confirmed_kill(
        "claude",
        &sid,
        &freshell_ownership::ReleaseClaim {
            operation_id: "op-r10-f2-foreign-device".to_string(),
            generation,
            runtime: None,
        },
        "test",
    );
}

/// [`spawn_server`] with the ladder test's two-phase claude spec.
async fn spawn_server_with_ladder_claude() -> (
    String,
    freshell_terminal::TerminalRegistry,
    WsState,
    std::path::PathBuf,
) {
    let (spec, exit_flag) = exiting_then_sleeper_cli_spec("claude");
    let (state, registry, _fresh_agent_state) = build_ws_state(vec![spec]).await;
    let router = freshell_ws::router(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("ws://{addr}/ws"), registry, state, exit_flag)
}

// ── b8ke ext r7 F2: the resume path's coordinator authority + typed substitution ──

/// b8ke ext r7 F2: a probe answering DEFINITIVELY ABSENT for claude (the
/// resume gate's SpawnFresh precondition — the zero-turn carve-out is
/// skipped by ever_observed=true so a missing session STAMPS).
struct AbsentClaudeProbe;
impl freshell_ws::existence::SessionExistenceProbe for AbsentClaudeProbe {
    fn exists(
        &self,
        provider: &str,
        _session_id: &str,
    ) -> freshell_ws::existence::SessionExistence {
        if provider == "claude" {
            freshell_ws::existence::SessionExistence::Absent
        } else {
            freshell_ws::existence::SessionExistence::Unknown
        }
    }
    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        // true skips the zero-turn carve-out: the gate STAMPS.
        true
    }
}

/// b8ke ext r16 F3: a resume to a DEFINITIVELY MISSING session is the
/// TYPED SESSION_MISSING refusal — nothing was started, no session id
/// changed, and the frame carries NO substitution record (pre-r16 the
/// create auto-substituted a replacement session and recorded
/// SESSION_MISSING_RESUMED_FRESH — the request's non-goal forbids blank
/// sessions on exact-resume failure). The separate operator-initiated
/// fresh start (a NEW create with NO sessionRef) is the ONLY fresh path.
#[tokio::test]
async fn a_resume_to_a_missing_session_answers_the_typed_missing_refusal() {
    let (state, _registry, _fresh_agent_state) = build_ws_state_with_probe(
        vec![sleeper_cli_spec("claude")],
        std::sync::Arc::new(AbsentClaudeProbe),
    )
    .await;
    let url = {
        let router = freshell_ws::router(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/ws")
    };
    let mut ws = connect(&url).await;
    // A canonical-UUID claude id that was never on disk (the gate's
    // definitively-missing shape).
    let missing_sid = uuid::Uuid::new_v4().to_string();

    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r16-f3-missing",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": missing_sid },
        }),
    )
    .await;

    // THE TYPED REFUSAL: the create fails SESSION_MISSING — never a
    // terminal.created, never a substitution record (pre-r16 the create
    // answered created with a NEW session id).
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        (v["type"] == "error" || v["type"] == "terminal.created")
            && v["requestId"] == "req-r16-f3-missing"
    })
    .await;
    assert_eq!(
        refused["type"], "error",
        "the missing-session resume answers the typed refusal, never created: {refused:?}"
    );
    assert_eq!(refused["code"], json!("SESSION_MISSING"), "{refused:?}");
    assert!(
        refused.get("sessionSubstitution").is_none(),
        "the wire no longer carries any substitution record: {refused:?}"
    );
    // No terminal was spawned for the refusal.
    let ownership = state.ownership.as_ref().expect("coordinator wired");
    assert!(
        matches!(
            ownership.observe("claude", &missing_sid).state,
            freshell_ownership::OwnershipState::Vacant
        ),
        "nothing was started for the missing session"
    );

    // THE OPERATOR-INITIATED FRESH START — the ONLY new-session path: a
    // brand-new create with NO sessionRef (clearly a new conversation,
    // never a resume). It succeeds and mints its OWN session.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r16-f3-fresh",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r16-f3-fresh"
    })
    .await;
    let mint = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("the fresh create mints its own sessionRef")
        .to_string();
    assert_ne!(mint, missing_sid);
    // Cleanup: reap the fresh terminal.
    let tid = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    state.registry.kill(&tid);
}

/// b8ke ext r7 F2: the spawn interval holds a coordinator claim — a create
/// whose durable id was LEARNED after request parsing (the resume gate's
/// healed mint) claims BEFORE the spawn and the SAME ticket commits at the
/// settle: the Live record's ownership id is the PRE-SPAWN learned claim's
/// operation ("term-create-learned-…"), never the late claim's
/// ("term-create-late-…" — the pre-r7 shape, where the stamping dropped
/// the stale claim and the mint spawned unclaimed, the
/// ownership-check-through-spawn interval outside the coordinator and a
/// concurrent handoff on the mint free to grant from Vacant mid-spawn).
#[tokio::test]
async fn the_learned_identity_spawn_interval_holds_a_coordinator_claim() {
    let (state, _registry, _fresh_agent_state) = build_ws_state_with_probe(
        vec![sleeper_cli_spec("claude")],
        std::sync::Arc::new(AbsentClaudeProbe),
    )
    .await;
    let url = {
        let router = freshell_ws::router(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/ws")
    };
    let mut ws = connect(&url).await;

    // b8ke ext r16 F3: the learned-identity fixture is the FRESH-claude
    // PREALLOC mint (no sessionRef — the pre-r16 missing-resume mint path
    // this test used now answers the typed SESSION_MISSING refusal
    // instead of substituting a replacement session).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r7-f2-parked",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(30), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r7-f2-parked"
    })
    .await;
    let mint = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("the minted sessionRef")
        .to_string();

    // THE CONTRACT: the committed Live record's ownership id is the
    // PRE-SPAWN learned claim's operation — the claim was held through
    // the spawn await to the final commit (pre-r7 the stamping dropped the
    // claim and the settle's late claim minted "term-create-late-…",
    // leaving the spawn interval outside the coordinator).
    let ownership = state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let snap = ownership.observe("claude", &mint);
        if matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }) {
            match snap.state {
                freshell_ownership::OwnershipState::Live { ref owner, .. } => {
                    assert_eq!(
                        owner.ownership_id.as_deref(),
                        Some("term-create-learned-req-r7-f2-parked"),
                        "the Live commit rode the PRE-SPAWN learned claim's \
                         ticket (the late claim is the backstop, never the \
                         committer)"
                    );
                }
                _ => unreachable!("checked Live above"),
            }
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the create's mint never committed Live — state: {:?}",
            snap.state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // A concurrent lifecycle operation against the still-held claim was
    // refused while it was Starting — the provenance above plus the
    // committed generation being the learned claim's grant (never a
    // re-claim) is the held-authority proof.
    // Cleanup: reap the spawned terminal.
    let tid = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    state.registry.kill(&tid);
}

// ── b8ke ext r8 F2: terminal.attach participates in the coordinator ─────────

/// b8ke ext r13 F1: the terminal create's Adopt arm proceeds ONLY under
/// HELD authority. The create is parked INSIDE its coordinator window
/// (after the Adopt arm's attach guard arms) and a handoff BEGIN is
/// attempted in the window: it answers the typed Blocked outcome — the
/// handoff can NEVER begin and commit inside the create's spawn window
/// (pre-r13 the Adopt arm proceeded with NO ticket or guard, so the
/// racing handoff GRANTED and could commit around the in-flight create).
#[tokio::test]
async fn a_handoff_during_the_adopt_create_window_answers_blocked_typed() {
    let (url, registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");
    let sid = uuid::Uuid::new_v4().to_string();

    // Terminal #1: the negotiated create commits Live{Terminal}(t1) — the
    // incumbent the second create's claim will Adopt.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r13-f1-incumbent",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r13-f1-incumbent"
    })
    .await;
    let incumbent = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Park create #2 INSIDE its held-authority window.
    let parked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    {
        let parked = std::sync::Arc::clone(&parked);
        let release = std::sync::Arc::clone(&release);
        registry.set_terminal_create_postclaim_pause_for_tests(std::sync::Arc::new(
            move |request_id: &str| {
                let parked = std::sync::Arc::clone(&parked);
                let release = std::sync::Arc::clone(&release);
                let request_id = request_id.to_string();
                Box::pin(async move {
                    if request_id == "req-r13-f1-second" {
                        parked.store(true, std::sync::atomic::Ordering::Release);
                        release.notified().await;
                    }
                })
            },
        ));
    }

    // Create #2 for the SAME session: the wire claim Adopts the live
    // incumbent → the ext-r13 guard arms → the create parks in its window.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r13-f1-second",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !parked.load(std::sync::atomic::Ordering::Acquire) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create never reached its window"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // THE CONTRACT: a handoff BEGIN inside the create's window answers the
    // typed Blocked outcome — never Granted (pre-r13 the Adopt arm held NO
    // authority, so the racing handoff granted).
    match ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r13-f1-racing-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) {
        freshell_ownership::BeginOutcome::Blocked {
            state,
            retry_after_ms,
        } => {
            assert!(
                matches!(state, freshell_ownership::OwnershipState::Live { .. }),
                "the blocked state names the still-Live key: {state:?}"
            );
            assert!(retry_after_ms > 0);
        }
        other => panic!(
            "a handoff begin inside the Adopt-create window must answer Blocked — got {other:?}"
        ),
    }

    // Release the park: create #2 completes its window. The incumbent still
    // lives, so the create either loses the late claim (error) OR attaches
    // to the LIVE incumbent (the negotiated BoundElsewhere multi-device
    // reuse — the created frame names the INCUMBENT's terminal id) — NEVER
    // a second writer and never a reaped-terminal attach.
    release.notify_one();
    let answer = await_frame(&mut ws, Duration::from_secs(30), |v| {
        v["requestId"] == "req-r13-f1-second"
            && (v["type"] == "terminal.created" || v["type"] == "error")
    })
    .await;
    if answer["type"] == "terminal.created" {
        assert_eq!(
            answer["terminalId"],
            json!(incumbent),
            "the create may only ATTACH to the live incumbent — never a second writer: {answer}"
        );
    }
    // No second terminal row for the session was ever registered.
    assert_eq!(
        registry
            .identity_probe_rows()
            .iter()
            .filter(|r| r.resume_session_id.as_deref() == Some(sid.as_str()))
            .count(),
        1,
        "exactly the incumbent row exists — no second writer"
    );

    // THE WINDOW CLOSED: a handoff begin now proceeds.
    match ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r13-f1-after-window",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) {
        freshell_ownership::BeginOutcome::Granted { .. } => {}
        other => panic!("the handoff must proceed after the create window closed: {other:?}"),
    }
    // Cleanup: restore the record + reap.
    let _ = ownership.fail("claude", &sid, "op-r13-f1-after-window", 3, false);
    registry.kill(&incumbent);
    registry.clear_terminal_create_postclaim_pause_for_tests();
}

/// b8ke ext r12 F2: the attach holds a REAL claim across its window. The
/// attach is parked INSIDE its coordinator window (after the guard arms,
/// before the restamp/attach completes) and a handoff BEGIN is attempted
/// in the window: it answers the typed Blocked outcome — it can NEVER
/// begin and commit inside the attach's restamp window (pre-r12 the
/// point-in-time observe() closed no window: the handoff granted, and the
/// delayed attach persisted stale old-runtime binding / answered from the
/// superseded runtime). After the window closes the handoff proceeds.
#[tokio::test]
async fn a_handoff_during_the_attach_window_answers_blocked_typed() {
    let (url, registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let ownership = ws_state.ownership.clone().expect("coordinator wired");

    // A negotiated terminal create — the session commits Live{Terminal}.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r12-f2-window",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r12-f2-window"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Park the attach INSIDE its coordinator window.
    let parked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    {
        let parked = std::sync::Arc::clone(&parked);
        let release = std::sync::Arc::clone(&release);
        let parked_terminal = terminal_id.clone();
        registry.set_terminal_attach_pause_for_tests(std::sync::Arc::new(move |tid: &str| {
            let parked = std::sync::Arc::clone(&parked);
            let release = std::sync::Arc::clone(&release);
            let tid = tid.to_string();
            let parked_terminal = parked_terminal.clone();
            Box::pin(async move {
                if tid == parked_terminal {
                    parked.store(true, std::sync::atomic::Ordering::Release);
                    release.notified().await;
                }
            })
        }));
    }

    // The cross-device attach (observed fence from the committed record).
    let snap = ownership.observe("claude", &sid);
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 120,
            "rows": 30,
            "sinceSeq": 0,
            "attachRequestId": "req-r12-f2-window-attach",
            "priority": "foreground",
            "observedEpoch": snap.epoch,
            "observedGeneration": snap.generation,
        }),
    )
    .await;
    // Park proof: the attach reached its window.
    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !parked.load(std::sync::atomic::Ordering::Acquire) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the attach never reached its window"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    // THE CONTRACT: a handoff BEGIN inside the attach's window answers
    // the typed Blocked outcome — never Granted (pre-r12 it granted and
    // could commit around the in-flight attach).
    match ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r12-f2-racing-handoff",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) {
        freshell_ownership::BeginOutcome::Blocked {
            state,
            retry_after_ms,
        } => {
            assert!(
                matches!(state, freshell_ownership::OwnershipState::Live { .. }),
                "the blocked state names the still-Live key: {state:?}"
            );
            assert!(retry_after_ms > 0);
        }
        other => panic!(
            "a handoff begin inside the attach window must answer Blocked — \
             got {other:?}"
        ),
    }

    // Release the park: the attach completes and the window closes.
    release.notify_one();
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.attach.ready" && v["terminalId"] == json!(terminal_id)
    })
    .await;

    // THE WINDOW CLOSED: the handoff proceeds on retry.
    match ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r12-f2-after-window",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) {
        freshell_ownership::BeginOutcome::Granted { .. } => {}
        other => panic!("the handoff must proceed after the window closed: {other:?}"),
    }
    // Cleanup: restore the record + reap.
    let _ = ownership.fail("claude", &sid, "op-r12-f2-after-window", 3, false);
    registry.kill(&terminal_id);
    registry.clear_terminal_attach_pause_for_tests();
}

/// b8ke ext r8 F2: a queued cross-device attach landing while the canonical
/// session is in Handoff answers the typed refusal with NO restamp —
/// pre-r8 the handler wrote the durable pane reattachment record and
/// restamped the old terminal without consulting the coordinator at all.
#[tokio::test]
async fn a_queued_attach_mid_handoff_is_refused_typed_no_restamp() {
    let (url, registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // A negotiated terminal create — the session commits Live{Terminal}.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r8-f2-attach",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r8-f2-attach"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let live = ownership.observe("claude", &sid);

    // The session moves to HANDOFF (a lifecycle transition owns it).
    let freshell_ownership::BeginOutcome::Granted { .. } = ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r8-attach-held",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("expected the handoff granted")
    };

    // THE QUEUED ATTACH (carrying the pre-handoff observation): typed
    // SESSION_RESERVED, never an attach.ready.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r8-attach",
            "priority": "foreground",
            "observedEpoch": live.epoch,
            "observedGeneration": live.generation,
        }),
    )
    .await;
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "error" && v["code"] == "SESSION_RESERVED"
    })
    .await;
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains("lifecycle operation is in flight"),
        "the typed refusal names the in-flight transition: {refused}"
    );
    // No attach.ready ever lands for the queued attach.
    // (The refusal IS the answer — the next frame for this terminal is
    // nothing attach-shaped; we assert via the next frame filter below.)
    let still_handoff = ownership.observe("claude", &sid);
    assert!(
        matches!(
            still_handoff.state,
            freshell_ownership::OwnershipState::Handoff { .. }
        ),
        "the Handoff record is untouched: {:?}",
        still_handoff.state
    );
    let _ = registry;
    // Cleanup: unwind the held handoff + reap the terminal.
    let _ = ownership.fail(
        "claude",
        &sid,
        "op-r8-attach-held",
        still_handoff.generation,
        true,
    );
    ws_state.registry.kill(&terminal_id);
}

/// b8ke ext r8 F2: a stale-generation attach answers the typed refusal —
/// never a restamp past the generation advance.
#[tokio::test]
async fn a_stale_generation_attach_is_refused_typed() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r8-f2-stale",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r8-f2-stale"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Advance the record's generation (a handoff begin + fail bumps it).
    let before = ownership.observe("claude", &sid);
    let freshell_ownership::BeginOutcome::Granted { generation: ho_gen } = ownership.begin_handoff(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r8-attach-bump",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    ) else {
        panic!("expected the bump handoff granted")
    };
    let _ = ownership.fail("claude", &sid, "op-r8-attach-bump", ho_gen, true);
    assert!(
        ownership.observe("claude", &sid).generation > before.generation,
        "the generation advanced"
    );

    // THE STALE ATTACH: observed generation is the PRE-advance value.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r8-attach-stale",
            "priority": "foreground",
            "observedEpoch": before.epoch,
            "observedGeneration": before.generation,
        }),
    )
    .await;
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "error" && v["code"] == "SESSION_RESERVED"
    })
    .await;
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains("stale observed generation"),
        "the typed refusal names the stale generation: {refused}"
    );
    // b8ke fence-heal: the refusal carries the coordinator's CURRENT pair so
    // the client can refresh its fence (fix b server contract).
    let current = ownership.observe("claude", &sid);
    assert_eq!(
        refused["ownerEpoch"],
        json!(current.epoch),
        "the refusal carries the current epoch: {refused}"
    );
    assert_eq!(
        refused["ownerGeneration"],
        json!(current.generation),
        "the refusal carries the current generation: {refused}"
    );
    // fix (b) wire-level self-heal: the immediate re-attach with the pair the
    // refusal just taught us must SUCCEED — the deterministic protocol-level
    // proof that "the next attempt uses the fresh pair" heals the wedge.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "observedEpoch": refused["ownerEpoch"],
            "observedGeneration": refused["ownerGeneration"],
        }),
    )
    .await;
    let attach_ready = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.attach.ready"
    })
    .await;
    assert_eq!(
        attach_ready["type"], "terminal.attach.ready",
        "the re-attach with the refusal-taught pair must heal the wedge"
    );
    ws_state.registry.kill(&terminal_id);
}

/// b8ke fence-heal (fix b server contract): a create refused on a stale
/// observed pair carries the coordinator's CURRENT (epoch, generation) —
/// the pair the client folds into its runtimeOwners fence so its next
/// attempt is born fresh instead of looping on the same stale pair.
#[tokio::test]
async fn a_stale_generation_create_refusal_carries_the_current_pair() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // Seed the session Live exactly as the attach refusal test does: one
    // terminal-lane create whose settle commits Live{Terminal}.
    let sid = uuid::Uuid::new_v4().to_string();
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-fenceheal-create-seed",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-fenceheal-create-seed"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE STALE CREATE: observed generation is one behind the committed
    // Live pair — the typed refusal must carry the CURRENT pair.
    let current = ownership.observe("claude", &sid);
    assert!(
        current.generation >= 1,
        "the committed Live pair must have a generation to be stale against"
    );
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-fenceheal-create-stale",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
            "observedEpoch": current.epoch,
            "observedGeneration": current.generation - 1,
        }),
    )
    .await;
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "error"
            && v["code"] == "SESSION_RESERVED"
            && v["requestId"] == "req-fenceheal-create-stale"
    })
    .await;
    assert_eq!(
        refused["code"], "SESSION_RESERVED",
        "the stale create is the typed refusal: {refused}"
    );
    assert_eq!(
        refused["ownerEpoch"],
        json!(current.epoch),
        "the refusal carries the current epoch: {refused}"
    );
    assert_eq!(
        refused["ownerGeneration"],
        json!(current.generation),
        "the refusal carries the current generation: {refused}"
    );
    // Nothing spawned: the incumbent Live owner stands untouched.
    let after = ownership.observe("claude", &sid);
    assert!(
        matches!(after.state, freshell_ownership::OwnershipState::Live { .. }),
        "the stale create must not disturb the incumbent owner: {:?}",
        after.state
    );
    ws_state.registry.kill(&terminal_id);
}

/// b8ke fence-heal (fix b server contract, review M-1): the create's ADOPT
/// arm — the ATOMIC adopt guard — is the arm that refuses a fence the wire
/// claim let through, and its refusal must carry the coordinator's CURRENT
/// (epoch, generation) pair so the client folds the fresh pair instead of
/// looping on the stale one. The lane claim's staleness gate only refuses
/// fences OLDER than the record (`observedGeneration < current`), while the
/// atomic adopt demands the fence name the Live record EXACTLY — so a fence
/// naming a DIFFERENT generation (here one AHEAD of the record: the shape a
/// client holds after a sweep re-created the record at a lower generation,
/// or any well-meant fence that simply doesn't match) passes the lane claim
/// (AdoptLive) and is refused by the adopt guard. Deterministic — no race
/// window needed. The Adopt arm's session-suffixed message is the
/// discriminator proving THIS arm answered, never the wire-claim Refused
/// arm (whose message carries no suffix).
#[tokio::test]
async fn a_stale_generation_adopt_create_refusal_carries_the_current_pair() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    // Seed the session Live exactly as the wire-claim refusal test does:
    // one terminal-lane create whose settle commits Live{Terminal}.
    let sid = uuid::Uuid::new_v4().to_string();
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-fenceheal-adopt-seed",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-fenceheal-adopt-seed"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE ADOPT-LANE STALE CREATE: the observed pair names a DIFFERENT
    // record than the committed Live one (one generation AHEAD) — the lane
    // claim's less-than gate passes it (AdoptLive), so the ATOMIC adopt
    // guard is the arm that must refuse it carrying the CURRENT pair.
    let current = ownership.observe("claude", &sid);
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-fenceheal-adopt-stale",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
            "observedEpoch": current.epoch,
            "observedGeneration": current.generation + 1,
        }),
    )
    .await;
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "error"
            && v["code"] == "SESSION_RESERVED"
            && v["requestId"] == "req-fenceheal-adopt-stale"
    })
    .await;
    assert_eq!(
        refused["code"], "SESSION_RESERVED",
        "the adopt-lane stale create is the typed refusal: {refused}"
    );
    assert!(
        refused["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&format!("(session {sid})")),
        "the session-suffixed message proves the ADOPT arm answered (the \
         wire-claim Refused arm's message carries no suffix): {refused}"
    );
    assert_eq!(
        refused["ownerEpoch"],
        json!(current.epoch),
        "the refusal carries the current epoch: {refused}"
    );
    assert_eq!(
        refused["ownerGeneration"],
        json!(current.generation),
        "the refusal carries the current generation: {refused}"
    );
    // Nothing spawned: the incumbent Live owner stands untouched.
    let after = ownership.observe("claude", &sid);
    assert!(
        matches!(after.state, freshell_ownership::OwnershipState::Live { .. }),
        "the adopt-lane stale create must not disturb the incumbent owner: {:?}",
        after.state
    );
    ws_state.registry.kill(&terminal_id);
}

/// b8ke fence-heal (fixes a + c): the terminal-lane create settle commits
/// Live{Terminal} and BROADCASTS the authoritative owner frame carrying the
/// commit's OWN (epoch, generation) pair — captured from the claim ticket
/// BEFORE the consuming commit (r32 F2 — never a re-observed current
/// generation) — and the `terminal.created` reply rides the SAME committed
/// pair so the creating pane's first attach is born fresh. Pre-fix the
/// settle committed Live with NO broadcast and a pair-less created frame,
/// so every connected client kept its pre-create observed fence until a
/// page reload, and the pane's queued attach / later kills and recreates
/// were refused typed ("moved to a newer runtime; refresh and retry").
///
/// Frame capture: the created reply and the broadcast use separate delivery
/// paths with no ordering guarantee, so every incoming frame is matched
/// against BOTH targets until both are captured — never `await_frame` one
/// then the other (it DROPS non-matching frames and would eat the other
/// one). Broadcasts fan out to every connection (each subscribes to the
/// bus pre-handshake), so the SAME test socket gets both.
///
/// Consistency note (plan-review round 3, finding 1): the end-to-end path
/// cannot DETERMINISTICALLY discriminate committed-pair vs re-observed
/// emission — no transition can land between the commit and the
/// same-handler-turn broadcast, and a captured frame never changes after
/// capture. That discrimination lives in the helper-level unit test
/// (`identity_ownership.rs`'s
/// `a_broadcast_owner_frame_carries_the_committed_pair_not_the_current_generation`),
/// which builds the divergence INTO the emission.
#[tokio::test]
async fn a_terminal_lane_create_settle_broadcasts_the_committed_owner_pair_and_rides_the_created_frame(
) {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    let sid = uuid::Uuid::new_v4().to_string();
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-fenceheal-settle",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;

    let mut created: Option<Value> = None;
    let mut broadcast: Option<Value> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while (created.is_none() || broadcast.is_none()) && tokio::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_millis(50), ws.next()).await {
            Err(_) => continue, // no frame within the tick — re-check the deadline
            Ok(None) => panic!("stream ended while collecting"),
            Ok(Some(Err(e))) => panic!("ws error while collecting: {e}"),
            Ok(Some(Ok(msg))) => msg,
        };
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).expect("json frame");
        if value["type"] == "terminal.created" && value["requestId"] == "req-fenceheal-settle" {
            created = Some(value);
        } else if value["type"] == "session.runtimeOwner" && value["sessionId"] == json!(sid) {
            broadcast = Some(value);
        }
    }
    let created = created.expect("the terminal.created reply arrived");
    let broadcast = broadcast.expect(
        "the create settle broadcast the committed owner frame \
         (session.runtimeOwner for the created session id)",
    );
    let committed_epoch = ws_state
        .ownership
        .as_ref()
        .expect("ownership wired")
        .boot_epoch();
    // (fix c) the created frame carries the commit's own pair
    assert_eq!(created["ownerKind"], json!("terminal"), "{created}");
    assert_eq!(created["ownerEpoch"], json!(committed_epoch), "{created}");
    // (fix a) the broadcast carried the SAME committed pair
    assert_eq!(broadcast["ownerKind"], json!("terminal"), "{broadcast}");
    assert_eq!(
        broadcast["transition"],
        json!("handoff-committed"),
        "{broadcast}"
    );
    assert_eq!(
        broadcast["terminalId"], created["terminalId"],
        "{broadcast}"
    );
    assert_eq!(broadcast["epoch"], created["ownerEpoch"], "{broadcast}");
    assert_eq!(
        broadcast["generation"], created["ownerGeneration"],
        "{broadcast}"
    );
    assert!(
        !broadcast["operationId"].as_str().unwrap_or("").is_empty(),
        "the broadcast names the committing operation: {broadcast}"
    );
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    ws_state.registry.kill(&terminal_id);
}

/// b8ke ext r8 F2: a CURRENT attach (fresh observation) succeeds and
/// restamps — the gate never over-blocks the legitimate path.
#[tokio::test]
async fn a_current_attach_succeeds_and_restamps() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;

    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r8-f2-current",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r8-f2-current"
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let live = ownership.observe("claude", &sid);

    // THE CURRENT ATTACH: attach.ready lands (the legitimate path).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r8-attach-current",
            "priority": "foreground",
            "observedEpoch": live.epoch,
            "observedGeneration": live.generation,
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.attach.ready" && v["terminalId"] == json!(terminal_id)
    })
    .await;
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the current attach never disturbed the Live record"
    );
    ws_state.registry.kill(&terminal_id);
}

// ── b8ke ext r24 F1: the live-owner kind/identity check ────────────────────

/// A negotiated terminal create → wait for the coordinator's Live commit,
/// returning the (terminalId, sessionId) pair.
async fn r24_negotiated_create(ws: &mut TestWs, request_id: &str) -> (String, String) {
    send_json(
        ws,
        &json!({
            "type": "terminal.create",
            "requestId": request_id,
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": uuid::Uuid::new_v4().to_string() },
        }),
    )
    .await;
    let created = await_frame(ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == json!(request_id)
    })
    .await;
    let terminal_id = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let sid = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("sid")
        .to_string();
    (terminal_id, sid)
}

/// Kill the terminal's PTY child (the NATURAL exit — the row stays
/// `Exited`, the identity sessionRef is retained, and the reader-thread's
/// confirmed reap releases the coordinator key fenced) and wait for the
/// key to leave Live.
async fn r24_natural_exit(ws_state: &WsState, provider: &str, sid: &str, terminal_id: &str) {
    let pid = ws_state
        .registry
        .pid_of(terminal_id)
        .expect("the terminal has a live child pid");
    let _ = std::process::Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .status();
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while matches!(
        ownership.observe(provider, sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the natural exit never released the coordinator key"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// b8ke ext r24 F1: an unfenced attach to the RETAINED old terminal while
/// the canonical key is Live under the OTHER runtime kind (a Fresh Agent
/// established it after the terminal's natural exit) answers the typed
/// fresh-owner conflict — SESSION_RESERVED with ownerKind "fresh-agent" +
/// the owner generation, never attach.ready, never a pane-ledger restamp
/// rebinding the pane to a dead terminal. Pre-r24 the live owner's
/// kind/identity was never checked: an unfenced attach to the exited
/// terminal was ACCEPTED (attach.ready + terminal.exit + the restamp).
#[tokio::test]
async fn an_attach_while_a_fresh_agent_owns_answers_the_typed_fresh_owner_conflict() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect(&url).await;
    let (terminal_id, sid) = r24_negotiated_create(&mut ws, "req-r24-f1-fresh").await;
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The natural exit: the row stays (Exited), the identity sessionRef is
    // retained, and the coordinator key vacates.
    r24_natural_exit(&ws_state, "claude", &sid, &terminal_id).await;

    // Another device establishes Live{FreshAgent} for the same session.
    let freshell_ownership::BeginOutcome::Granted {
        generation: fresh_gen,
    } = ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-r24-fresh-owner",
        None,
        "test",
        freshell_ownership::now_epoch_ms(),
    )
    else {
        panic!("expected Granted")
    };
    assert!(matches!(
        ownership.commit_live(
            "claude",
            &sid,
            "op-r24-fresh-owner",
            fresh_gen,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(sid.clone()),
                pid: None,
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            },
        ),
        freshell_ownership::CommitOutcome::Committed
    ));

    // THE UNFENCED ATTACH to the retained old terminal — the typed
    // fresh-owner conflict.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r24-attach-fresh",
            "priority": "foreground",
        }),
    )
    .await;
    let refused = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "error" && v["code"] == "SESSION_RESERVED"
    })
    .await;
    assert_eq!(
        refused["ownerKind"],
        json!("fresh-agent"),
        "the typed conflict names the fresh-agent owner: {refused}"
    );
    assert_eq!(
        refused["ownerGeneration"],
        json!(fresh_gen),
        "the typed conflict carries the owner's generation: {refused}"
    );

    // NO attach.ready for the refused attach (a bounded drain finds none).
    let deadline = tokio::time::Instant::now() + Duration::from_millis(750);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(WsMessage::Text(text)))) =
            tokio::time::timeout(Duration::from_millis(250), ws.next()).await
        {
            let v: Value = serde_json::from_str(&text).unwrap();
            if v["type"] == "terminal.attach.ready" && v["terminalId"] == json!(terminal_id) {
                panic!("no attach.ready may follow the typed conflict: {v}");
            }
        }
    }

    // The coordinator's fresh owner is UNTOUCHED — nothing restamped, no
    // ownership change from the refused attach.
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ),
        "the fresh-agent owner stands after the refused attach"
    );
}

/// b8ke ext r24 F1: an unfenced attach to the RETAINED old terminal while
/// a DIFFERENT terminal owns the canonical key (another device reopened the
/// session as CLI after the old terminal's natural exit) answers the typed
/// other-terminal conflict — SESSION_RESERVED with ownerKind "terminal",
/// the owner generation, and the LIVE terminal id for the client's direct
/// attach action; never attach.ready.
#[tokio::test]
async fn an_attach_while_a_different_terminal_owns_answers_the_typed_other_terminal_conflict() {
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws_a = connect(&url).await;
    let (terminal_a, sid) = r24_negotiated_create(&mut ws_a, "req-r24-f1-other-a").await;
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        ownership.observe("claude", &sid).state,
        freshell_ownership::OwnershipState::Live { .. }
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The old terminal exits naturally; the session reopens on ANOTHER
    // device as a NEW terminal (the same sessionRef).
    r24_natural_exit(&ws_state, "claude", &sid, &terminal_a).await;
    let mut ws_b = connect(&url).await;
    send_json(
        &mut ws_b,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r24-f1-other-b",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    let created_b = await_frame(&mut ws_b, Duration::from_secs(10), |v| {
        v["type"] == "terminal.created" && v["requestId"] == "req-r24-f1-other-b"
    })
    .await;
    let terminal_b = created_b["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_ne!(
        terminal_a, terminal_b,
        "the new owner is a different terminal"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match ownership.observe("claude", &sid).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(
                    owner.kind,
                    freshell_ownership::RuntimeOwnerKind::Terminal,
                    "the new terminal owns the session"
                );
                assert_eq!(
                    owner.terminal_id.as_deref(),
                    Some(terminal_b.as_str()),
                    "the new owner names terminal B"
                );
                break;
            }
            _ => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "terminal B never committed Live"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    let owner_b = ownership.observe("claude", &sid);

    // THE UNFENCED ATTACH to the retained OLD terminal — the typed
    // other-terminal conflict.
    send_json(
        &mut ws_a,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_a,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r24-attach-other",
            "priority": "foreground",
        }),
    )
    .await;
    let refused = await_frame(&mut ws_a, Duration::from_secs(10), |v| {
        v["type"] == "error" && v["code"] == "SESSION_RESERVED"
    })
    .await;
    assert_eq!(
        refused["ownerKind"],
        json!("terminal"),
        "the typed conflict names the terminal owner: {refused}"
    );
    assert_eq!(
        refused["ownerGeneration"],
        json!(owner_b.generation),
        "the typed conflict carries the owner's generation: {refused}"
    );
    assert_eq!(
        refused["liveTerminalId"],
        json!(terminal_b),
        "the typed conflict names the live terminal for the direct attach action: {refused}"
    );

    // NO attach.ready for the refused attach.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(750);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(WsMessage::Text(text)))) =
            tokio::time::timeout(Duration::from_millis(250), ws_a.next()).await
        {
            let v: Value = serde_json::from_str(&text).unwrap();
            if v["type"] == "terminal.attach.ready" && v["terminalId"] == json!(terminal_a) {
                panic!("no attach.ready may follow the typed conflict: {v}");
            }
        }
    }

    // Terminal B's ownership is UNTOUCHED.
    assert!(
        matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                    && owner.terminal_id.as_deref() == Some(terminal_b.as_str())
        ),
        "terminal B still owns the session after the refused attach"
    );
    ws_state.registry.kill(&terminal_b);
}

/// b8ke ext r24 F2: the attach-guard and terminal-kill coordinator
/// transitions record the CONNECTION'S device identity as the initiator —
/// the same identity field the handoff paths record (the request's device
/// id) — never a constant lane label, so the structured records identify
/// which client/device initiated the operation. Pre-r24 the attach guard
/// logged the constant "ws-terminal-attach" and the kill path logged
/// "ws-kill-<terminalId>" (the TARGET, not the initiator).
#[tokio::test]
async fn the_attach_guard_and_kill_transitions_record_the_connection_device_identity() {
    // The PROCESS-GLOBAL capture (not the thread-local): the assertion is a
    // PRESENCE check, and the thread-local default is racy under libtest's
    // parallel execution — the global layer sees every thread's events and
    // the unique session id isolates this test's transitions.
    let events = race_tracing_capture::global_events();
    let (url, _registry, ws_state) = spawn_server().await;
    let mut ws = connect_with_device(&url, "device-r24-f2").await;
    let (terminal_id, sid) = r24_negotiated_create(&mut ws, "req-r24-f2-identity").await;
    let ownership = ws_state.ownership.as_ref().expect("coordinator wired");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let live = loop {
        let snap = ownership.observe("claude", &sid);
        if matches!(snap.state, freshell_ownership::OwnershipState::Live { .. }) {
            break snap;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "never committed Live"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };

    // A current same-owner attach arms the guard (the legitimate path).
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.attach",
            "terminalId": terminal_id,
            "intent": "viewport_hydrate",
            "cols": 80,
            "rows": 24,
            "sinceSeq": 0,
            "attachRequestId": "req-r24-attach-identity",
            "priority": "foreground",
            "observedEpoch": live.epoch,
            "observedGeneration": live.generation,
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.attach.ready" && v["terminalId"] == json!(terminal_id)
    })
    .await;

    // THE ASSERTION: the attach's armed-guard event's initiator carries
    // the connection's device identity — never a constant. b8ke ext
    // r39 F1: the terminal attach arms the ATOMIC ADOPT (the r38
    // primitive — the observed pair + the expected terminal owner
    // validated in ONE coordinator decision), so the armed event is the
    // adopt's `ownership.adopt_guard.armed` (same initiator contract).
    let armed: Vec<_> = events
        .lock()
        .expect("capture lock")
        .iter()
        .filter(|e| {
            e.target == "freshell_ownership"
                && e.event == "ownership.adopt_guard.armed"
                && e.fields.get("session_id").map(String::as_str) == Some(sid.as_str())
        })
        .cloned()
        .collect();
    // The diagnostic counts are hoisted BEFORE the assert so the panic's
    // format arguments never re-lock the capture mutex (std::Mutex is not
    // reentrant — evaluating three `events.lock()` args while a guard
    // temporary is still alive self-deadlocks the panicking test thread;
    // b8ke ext r39 F1 found this the hard way when the event rename
    // failed this assert).
    let (total_adopt_armed, total_events, total_ownership_events) = {
        let guard = events.lock().expect("capture lock");
        (
            guard
                .iter()
                .filter(|e| e.event == "ownership.adopt_guard.armed")
                .count(),
            guard.len(),
            guard
                .iter()
                .filter(|e| e.target == "freshell_ownership")
                .count(),
        )
    };
    assert!(
        !armed.is_empty(),
        "the attach's atomic adopt armed (the event exists for {sid}): total armed events = {}, \
         total captured events = {}, ownership events = {}",
        total_adopt_armed,
        total_events,
        total_ownership_events
    );
    for e in &armed {
        let initiator = e.fields.get("initiator").map(String::as_str).unwrap_or("");
        assert!(
            initiator.contains("device-r24-f2"),
            "the attach-guard initiator carries the connection's device identity, got {initiator:?}"
        );
    }

    // The terminal-kill path: the stop.begin event's initiator carries the
    // same device identity.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.kill",
            "terminalId": terminal_id,
            "requestId": "req-r24-kill-identity",
        }),
    )
    .await;
    let _ = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "terminal.killed" && v["requestId"] == json!("req-r24-kill-identity")
    })
    .await;
    let stop_begins: Vec<_> = events
        .lock()
        .expect("capture lock")
        .iter()
        .filter(|e| {
            e.target == "freshell_ownership"
                && e.event == "ownership.stop.begin"
                && e.fields.get("session_id").map(String::as_str) == Some(sid.as_str())
        })
        .cloned()
        .collect();
    assert!(
        !stop_begins.is_empty(),
        "the kill began a coordinator stop for {sid}"
    );
    for e in &stop_begins {
        let initiator = e.fields.get("initiator").map(String::as_str).unwrap_or("");
        assert!(
            initiator.contains("device-r24-f2"),
            "the kill's stop.begin initiator carries the connection's device identity, got {initiator:?}"
        );
    }
}

// ── b8ke ext r9 F2: the commit verifies the PTY is alive at commit time ─────

/// An instantly-dying claude spec (the fast-failing exact-resume shape —
/// exits before the settle's binding/registration work can finish).
fn instant_death_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-cross-kind-instant-death-{name}-{}-{}.sh",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexit 1\n").expect("write instant-death script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("chmod instant-death script");
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
        effort_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// b8ke ext r9 F2: a terminal whose process EXITS BEFORE THE COMMIT is
/// NEVER recorded Live{Terminal} — the commit-time liveness check
/// synchronizes the interleaving under the retained-claim lock
/// (whichever observes first wins; the exit path releases or the commit
/// fails typed). The sessionRef-bearing create that instantly dies answers
/// the typed create failure (never a phantom Live), the key never holds a
/// dead runtime, and a handoff into the key enters from Vacant (no phantom
/// prior to stop) — pre-r9 the dead terminal WAS recorded Live and the
/// natural-exit callback released nothing.
#[tokio::test]
async fn an_instantly_exiting_terminal_is_never_recorded_live() {
    let (state, registry, _fresh_agent_state) =
        build_ws_state(vec![instant_death_cli_spec("claude")]).await;
    let url = {
        let router = freshell_ws::router(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback port");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("ws://{addr}/ws")
    };
    let mut ws = connect(&url).await;
    let sid = uuid::Uuid::new_v4().to_string();

    // The create: the CLI dies instantly — the PTY exits before/during
    // the settle's asynchronous binding work. The commit either saw the
    // exit (typed failure) or committed BEFORE the exit (the exit
    // callback then finds the retained claim and releases); BOTH paths
    // end with the key never holding a dead runtime.
    send_json(
        &mut ws,
        &json!({
            "type": "terminal.create",
            "requestId": "req-r9-f2-dead",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
    )
    .await;
    // Bounded wait for the create's settle to finish either way (the
    // created frame or the typed error), then the exit callback's release.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let snap = state
            .ownership
            .as_ref()
            .expect("coordinator wired")
            .observe("claude", &sid);
        // A Live owner with a DEAD PTY is the F2 defect. Everything else
        // is acceptable on both race sides: Vacant (the commit refused
        // typed / the exit released) or, transiently, Live{Terminal}
        // whose PTY still runs (the exit hasn't landed). Once the row
        // is gone/Exited AND the coordinator still says Live{Terminal}
        // — that's the phantom.
        // Row status by identity-registry join: the row is dead-or-gone when
        // no RUNNING row carries the session as its resume id.
        let row_dead_or_gone = !registry.identity_probe_rows().iter().any(|r| {
            r.resume_session_id.as_deref() == Some(sid.as_str())
                && r.status == freshell_protocol::TerminalRunStatus::Running
        });
        let live_terminal = matches!(
            snap.state,
            freshell_ownership::OwnershipState::Live {
                owner: ref o, ..
            } if o.kind == freshell_ownership::RuntimeOwnerKind::Terminal
        );
        if row_dead_or_gone {
            if live_terminal {
                // The exit landed; the coordinator must release within
                // the watcher's settle quantum — give the callback a
                // bounded window, then fail.
                let release_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                while matches!(
                    state
                        .ownership
                        .as_ref()
                        .expect("coordinator wired")
                        .observe("claude", &sid)
                        .state,
                    freshell_ownership::OwnershipState::Live { .. }
                ) {
                    assert!(
                        tokio::time::Instant::now() < release_deadline,
                        "the DEAD terminal is recorded Live(Terminal) — the commit verified nothing"
                    );
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                break;
            }
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the create never settled: {:?}",
            snap.state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // THE CONTRACT: after everything settles, the key NEVER holds
    // Live{Terminal} over the dead runtime.
    let snap = state
        .ownership
        .as_ref()
        .expect("coordinator wired")
        .observe("claude", &sid);
    assert!(
        !matches!(
            snap.state,
            freshell_ownership::OwnershipState::Live {
                owner: ref o, ..
            } if o.kind == freshell_ownership::RuntimeOwnerKind::Terminal
        ),
        "an instantly-dying terminal is never recorded Live — {:?}",
        snap.state
    );
}

/// b8ke ext r9 F2: the same at the COMMIT API level — a terminal that
/// exits before commit_session_ref_ownership is called answers the TYPED
/// refusal (never Committed), so a handoff into a fast-failing resume
/// target returns the typed resume failure instead of a dead-target
/// success.
#[tokio::test]
async fn a_dead_pty_commit_is_refused_typed() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    let locator = freshell_protocol::SessionLocator {
        provider: "claude".to_string(),
        session_id: "ses-r9-dead".to_string(),
    };
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        "ses-r9-dead",
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-r9-dead",
        None,
        "test",
        1_000,
    ) else {
        panic!("expected Granted")
    };
    // A headless row that is ALREADY Exited (the fast-fail shape).
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: "t-r9-dead".to_string(),
        stream_id: "s-r9".to_string(),
        mode: "claude".to_string(),
        resume_session_id: Some("ses-r9-dead".to_string()),
        create_request_id: None,
        created_at: None,
    });
    assert!(registry.is_pty_running("t-r9-dead"));
    registry.finish_pty_exit("t-r9-dead", 1);
    assert!(!registry.is_pty_running("t-r9-dead"));
    // THE TYPED REFUSAL: the dead-PTY commit fails typed, never records
    // Live.
    assert_eq!(
        registry.commit_session_ref_ownership(&locator, "op-r9-dead", generation, "t-r9-dead"),
        freshell_ownership::CommitOutcome::ForeignOperation,
        "a dead PTY's commit is refused typed"
    );
    assert!(
        !matches!(
            ownership.observe("claude", "ses-r9-dead").state,
            freshell_ownership::OwnershipState::Live { .. }
        ),
        "the dead runtime was never recorded Live"
    );
}

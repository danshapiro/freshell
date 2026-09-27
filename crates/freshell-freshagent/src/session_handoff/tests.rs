//! kata b8ke Task 6: the `SessionHandoffRunner` behavioral tests. The
//! required coverage set (plan tests 1-6 plus the round-2 additions
//! 3b/3c/6b): happy-path ordering, typed target-spawn failure, reap-timeout
//! re-probe semantics (live prior restored / unconfirmable prior Vacant /
//! late exit still releases), detached completion, abort leaves zero-or-one
//! owner, the OpenCode invariant, and the kilroy flavor.
//!
//! Harness: the inline fake claude sidecar env pattern (copied verbatim from
//! `cross_kind_liveness.rs::FakeSidecarEnv` — the request-log knob), the
//! fake `opencode serve` (the `freshagent_session_lease.rs` shape), and the
//! common sleeper CLI spec so terminal targets genuinely spawn Running PTYs.
//! `ENV_LOCK` serializes this file's tests (process-global env knobs).
use crate::session_handoff::FlavorWriter;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use freshell_ownership::{
    BeginOutcome, FenceReason, OwnershipState, RuntimeOwnerKind, RuntimeOwnershipRegistry,
};
use freshell_protocol::{
    AgentProvider, FreshAgentAttach, FreshAgentCompact, FreshAgentCreate, FreshAgentKill,
    SessionType,
};

use super::{
    kill_and_confirm_terminal_pid, AbortPayload, HandoffAction, HandoffHandle, HandoffRequest,
    HandoffTestHooks, SessionHandoffRunner, UncommittedTargetOutcome,
};

/// Serializes the tests in this file: they mutate process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE` /
/// `FAKE_SIDECAR_REQUEST_LOG` / `OPENCODE_CMD` / ...). It is the crate-wide
/// [`crate::OPENCODE_ENV_LOCK`] under its historical name — the snapshot
/// cold-GET tests mutate `OPENCODE_CMD` too and must exclude these.
use crate::OPENCODE_ENV_LOCK as ENV_LOCK;

// ── fake claude sidecar (request-log knob only; copied from
//    cross_kind_liveness.rs per the plan's instruction) ──────────────────────

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
        let dir =
            std::env::temp_dir().join(format!("freshell-session-handoff-{}", uuid_like_suffix()));
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

    /// The sidecar pid that served THIS session's create (the process the
    /// handoff must reap).
    fn sidecar_pid_for(&self, sid: &str) -> Option<u32> {
        self.create_rows()
            .into_iter()
            .find(|r| r["msg"]["resumeSessionId"] == sid)
            .and_then(|r| r["pid"].as_u64())
            .map(|p| p as u32)
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

// ── fake `opencode serve` (the freshagent_session_lease.rs shape) ──────────

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
let nextSession = 0
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
  // A create (the REST send-keys cold-start materialization): mint a
  // fresh durable ses_N id (b8ke focused round-3 R3-1).
  if (url.pathname === '/session' && req.method === 'POST') {
    nextSession += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: `ses_${nextSession}`, directory: '/tmp', title: 'fake opencode session' }))
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
    // An id containing "missing" models a session the serve does not know
    // (a 404) so wrong-lane dispatch attempts fail fast and hermetically.
    if (id.includes('missing')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id, directory: '/tmp', title: 'fake opencode session' }))
    return
  }
  // A prompt: accept it and NEVER emit a session.idle event — the turn
  // executes daemon-side with the client parked awaiting idle (the
  // active-turn shape the handoff stop must abort through the manager).
  const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
  if (prompt && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  // The config: a splittable model so a compact's model-pair resolution
  // succeeds against the fake serve (b8ke focused round-2 R2-5).
  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: 'fakeprov/fakemodel' }))
    return
  }
  // A summarize (compact): log the receipt, then HOLD the answer until the
  // release file appears — the mid-compaction window (the POST dispatched,
  // the daemon-side summarization running, the response parked) a handoff
  // must still quiesce through the abort (b8ke focused round-2 R2-5).
  const summarize = url.pathname.match(/^\/session\/([^/]+)\/summarize$/)
  if (summarize && req.method === 'POST') {
    const id = decodeURIComponent(summarize[1])
    log({ event: 'summarize-received', id })
    const release = process.env.FAKE_OPENCODE_SERVE_SUMMARIZE_RELEASE || ''
    const timer = setInterval(() => {
      if (!release || fs.existsSync(release)) {
        clearInterval(timer)
        log({ event: 'summarize-answered', id })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('true')
      }
    }, 25)
    return
  }
  // The abort: log the receipt, then HOLD the answer until the release
  // file appears (the test releases it) — proving the caller awaits the
  // daemon-side abort before reporting the reap.
  const abort = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
  if (abort && req.method === 'POST') {
    const id = decodeURIComponent(abort[1])
    log({ event: 'abort-received', id })
    const release = process.env.FAKE_OPENCODE_SERVE_ABORT_RELEASE || ''
    const timer = setInterval(() => {
      if (!release || fs.existsSync(release)) {
        clearInterval(timer)
        log({ event: 'abort-answered', id })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }
    }, 25)
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})
server.listen(port, hostname, () => { log({ event: 'listen', hostname, port }) })
"#;

struct FakeOpencodeServeEnv {
    dir: PathBuf,
}

impl FakeOpencodeServeEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-handoff-opencode-serve-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake serve temp dir");
        // Keep CommonJS explicit even if /tmp inherits a foreign package.json
        // with "type": "module".
        let script = dir.join("fake-opencode-serve.cjs");
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

    /// Bounded-wait for an audit row matching `pred`.
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

    /// Every distinct process id the fake serve ever ran under — a restart
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
        for var in [
            "OPENCODE_CMD",
            "FAKE_OPENCODE_SERVE_AUDIT_LOG",
            "FAKE_OPENCODE_SERVE_ABORT_RELEASE",
            "FAKE_OPENCODE_SERVE_SUMMARIZE_RELEASE",
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

/// Sleeper CLI spec (the cross_kind_liveness shape): a `sleep 30` script the
/// terminal-target spawn launches as a genuinely-Running PTY. Per-call path
/// (the ETXTBSY deflake rule).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-handoff-sleeper-{name}-{}-{}.sh",
        std::process::id(),
        uuid_like_suffix()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexec sleep 300\n").expect("write sleeper script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).expect("chmod sleeper script");
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

// ── the rig: runner + every shared state, exactly like main.rs ──────────────

/// b8ke e3r1 F4: the rig's recording flavor-writer log.
type FlavorWriteLog = Arc<std::sync::Mutex<Vec<(String, String, String)>>>;

/// The recording writer (the rig's default): records (provider, session,
/// flavor) and succeeds. b8ke ext r28 F4: TWO-PHASE — the log entry lands
/// at the staged handle's COMMIT (after Live(targetKind)), never at stage.
struct RecordingFlavorWriter {
    log: FlavorWriteLog,
}

struct StagedRecordingFlavor {
    log: FlavorWriteLog,
    entry: (String, String, String),
}

impl crate::session_handoff::StagedFlavor for StagedRecordingFlavor {
    fn commit(
        self: Box<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        self.log.lock().expect("flavor log lock").push(self.entry);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl crate::session_handoff::FlavorWrite for RecordingFlavorWriter {
    fn stage(
        &self,
        provider: &str,
        session_id: &str,
        flavor: &str,
    ) -> crate::session_handoff::StagedFlavorFuture {
        let staged: Box<dyn crate::session_handoff::StagedFlavor> =
            Box::new(StagedRecordingFlavor {
                log: Arc::clone(&self.log),
                entry: (
                    provider.to_string(),
                    session_id.to_string(),
                    flavor.to_string(),
                ),
            });
        Box::pin(std::future::ready(Ok(Some(staged))))
    }
}

fn build_recording_flavor_writer(log: FlavorWriteLog) -> FlavorWriter {
    Arc::new(RecordingFlavorWriter { log })
}

struct Rig {
    runner: Arc<SessionHandoffRunner>,
    ownership: Arc<RuntimeOwnershipRegistry>,
    registry: freshell_terminal::TerminalRegistry,
    fresh_claude: crate::FreshClaudeState,
    fresh_opencode: crate::FreshOpencodeState,
    fresh_agent: crate::FreshAgentState,
    rx: tokio::sync::broadcast::Receiver<String>,
    /// b8ke e3r1 F4: the recording flavor-writer log.
    flavor_log: FlavorWriteLog,
}

fn build_rig(hooks: Option<Arc<HandoffTestHooks>>) -> Rig {
    build_rig_with_claude_pauses(hooks, None, None)
}

/// [`build_rig`] plus the claude lane's handoff test pauses (round-3 review
/// I-1's abort-window holds): `kill_pause` parks `kill_for_handoff` after it
/// takes the retained stamp (the prior-reap window); `resume_pause` parks
/// `resume_for_attach` right after the target session registers (the
/// fresh-arm target-spawn window). Both must be armed BEFORE the runner is
/// minted — the states are cloned into it.
fn build_rig_with_claude_pauses(
    hooks: Option<Arc<HandoffTestHooks>>,
    kill_pause: Option<Arc<tokio::sync::Notify>>,
    resume_pause: Option<Arc<tokio::sync::Notify>>,
) -> Rig {
    build_rig_with_claude_pauses_and_reap_timeout_ms(hooks, kill_pause, resume_pause, 8_000)
}

/// [`build_rig_with_claude_pauses`] plus a caller-chosen reap budget — the
/// F3 real-timeout window needs a SHORT budget so a parked lane kill
/// deterministically exceeds the runner's reap timeout (the production
/// shape: kill issued, death delayed past the budget).
fn build_rig_with_claude_pauses_and_reap_timeout_ms(
    hooks: Option<Arc<HandoffTestHooks>>,
    kill_pause: Option<Arc<tokio::sync::Notify>>,
    resume_pause: Option<Arc<tokio::sync::Notify>>,
    reap_timeout_ms: u64,
) -> Rig {
    build_rig_full(hooks, kill_pause, resume_pause, reap_timeout_ms, None)
}

/// The full rig: the claude pauses + reap budget, PLUS the b8ke focused-FR3
/// seam — the claude lane's tree-death confirmation round override (a
/// one-round window makes a TERM-immune tagged descendant deterministically
/// outlive the lane's bounded confirmation, driving the runner's fenced
/// not-confirmed path).
fn build_rig_full(
    hooks: Option<Arc<HandoffTestHooks>>,
    kill_pause: Option<Arc<tokio::sync::Notify>>,
    resume_pause: Option<Arc<tokio::sync::Notify>>,
    reap_timeout_ms: u64,
    claude_confirm_rounds: Option<u8>,
) -> Rig {
    build_rig_with_options(
        hooks,
        kill_pause,
        resume_pause,
        reap_timeout_ms,
        claude_confirm_rounds,
        false,
    )
}

/// [`build_rig_full`] plus the b8ke focused round-2 R2-3 seam — the claude
/// lane's platform-limited stop override (the typed PlatformLimited answer
/// the real lane only produces under `cfg(not(linux))`, driven on Linux
/// for the fenced-platform-limited red/green).
#[allow(clippy::too_many_arguments)]
fn build_rig_with_pane_identity_binder(
    binder: std::sync::Arc<dyn freshell_terminal::registry::PaneIdentityBinder>,
) -> Rig {
    build_rig_inner(None, None, None, 10_000, None, false, None, Some(binder))
}

/// b8ke ext r27 F3: a handoff runner's binder whose terminal-target
/// identity registration FAILS — the typed recoverable handoff failure's
/// driver.
#[derive(Debug, Default)]
struct FailingCreateIdentityBinder;

impl freshell_terminal::registry::PaneIdentityBinder for FailingCreateIdentityBinder {
    fn record_prespawn_claude_binding(
        &self,
        _session_id: &str,
        _terminal_id: &str,
        _mode: &str,
        _cwd: Option<&str>,
        _create_request_id: Option<&str>,
    ) {
    }
    fn delete_prespawn_claude_binding(&self, _session_id: &str) {}
    fn register_create_identity(
        &self,
        _terminal_id: &str,
        _mode: &str,
        _resume_session_id: Option<&str>,
        _cwd: Option<&str>,
        _create_request_id: Option<&str>,
        _observed: Option<(u64, u64)>,
    ) -> Result<(), std::io::Error> {
        Err(std::io::Error::other(
            "TARGET_BINDING_FAILED: the fixture's ledger refuses the durable \
             registration write",
        ))
    }
    fn retire_pane_identity(&self, _terminal_id: &str) {}
}

fn build_rig_with_options(
    hooks: Option<Arc<HandoffTestHooks>>,
    kill_pause: Option<Arc<tokio::sync::Notify>>,
    resume_pause: Option<Arc<tokio::sync::Notify>>,
    reap_timeout_ms: u64,
    claude_confirm_rounds: Option<u8>,
    claude_platform_limited: bool,
) -> Rig {
    build_rig_inner(
        hooks,
        kill_pause,
        resume_pause,
        reap_timeout_ms,
        claude_confirm_rounds,
        claude_platform_limited,
        None,
        None,
    )
}

/// b8ke e3r2 F3: a rig with a CUSTOM flavor writer (the failing/blocking
/// shapes the awaited-in-window contract needs).
fn build_rig_with_flavor_writer(writer: FlavorWriter) -> Rig {
    build_rig_inner(None, None, None, 10_000, None, false, Some(writer), None)
}

#[allow(clippy::too_many_arguments)] // the test rig's full knob set
fn build_rig_inner(
    hooks: Option<Arc<HandoffTestHooks>>,
    kill_pause: Option<Arc<tokio::sync::Notify>>,
    resume_pause: Option<Arc<tokio::sync::Notify>>,
    reap_timeout_ms: u64,
    claude_confirm_rounds: Option<u8>,
    claude_platform_limited: bool,
    flavor_writer_override: Option<FlavorWriter>,
    pane_identity: Option<std::sync::Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
) -> Rig {
    let auth_token = Arc::new("handoff-test-token".to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let rx = broadcast_tx.subscribe();
    let ownership = Arc::new(RuntimeOwnershipRegistry::new());
    let registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));

    let mut fresh_claude = crate::FreshClaudeState::new(Arc::clone(&broadcast_tx));
    fresh_claude.set_ownership(Arc::clone(&ownership));
    fresh_claude.set_handoff_test_pauses(kill_pause, resume_pause);
    fresh_claude.set_handoff_confirm_rounds_for_test(claude_confirm_rounds);
    fresh_claude.set_handoff_platform_limited_for_test(if claude_platform_limited {
        Some(true)
    } else {
        None
    });
    let mut fresh_codex = crate::FreshCodexState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
        json!({ "freshAgent": { "enabled": true } }),
    );
    fresh_codex.set_ownership(Arc::clone(&ownership));

    let cli_commands = Arc::new(vec![
        sleeper_cli_spec("claude"),
        sleeper_cli_spec("opencode"),
        // b8ke ext r33 F2: the codex terminal-target handoff (the
        // old-rebound-reference resolution test) — a registered codex
        // sleeper CLI (additive: no test asserted codex was absent).
        sleeper_cli_spec("codex"),
    ]);
    let mut fresh_agent =
        crate::FreshAgentState::new(Arc::clone(&auth_token), Arc::clone(&broadcast_tx))
            .with_ownership(Arc::clone(&ownership))
            .with_terminal_registry(registry.clone())
            .with_cli_commands(Arc::clone(&cli_commands));
    if let Some(binder) = pane_identity {
        fresh_agent = fresh_agent.with_pane_identity_binder(binder);
    }
    let mut fresh_opencode = crate::FreshOpencodeState::new(fresh_agent.clone());
    fresh_opencode.set_ownership(Arc::clone(&ownership));

    // b8ke e3r1 F4 + e3r2 F3: the rig wires a RECORDING flavor writer so
    // the commit-side durable-flavor contract is testable (the awaited
    // write lands INSIDE the Handoff window, before the owner commit).
    let flavor_log: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    let flavor_writer: FlavorWriter = flavor_writer_override
        .unwrap_or_else(|| build_recording_flavor_writer(Arc::clone(&flavor_log)));
    let mut runner = SessionHandoffRunner::new(
        auth_token,
        broadcast_tx,
        Arc::clone(&ownership),
        registry.clone(),
        fresh_codex,
        fresh_claude.clone(),
        fresh_opencode.clone(),
        fresh_agent.clone(),
        cli_commands,
    )
    .with_reap_timeout_ms(reap_timeout_ms)
    .with_flavor_writer(Some(flavor_writer));
    if let Some(hooks) = hooks.clone() {
        runner = runner.with_test_hooks(hooks);
    }
    Rig {
        runner: Arc::new(runner),
        ownership,
        registry,
        fresh_claude,
        fresh_opencode,
        fresh_agent,
        rx,
        flavor_log,
    }
}

fn handoff_req_terminal(provider: &str, sid: &str, mode: &str) -> HandoffRequest {
    HandoffRequest {
        action: HandoffAction::Switch,
        provider: provider.to_string(),
        session_id: sid.to_string(),
        target_kind: RuntimeOwnerKind::Terminal,
        session_type: None,
        mode: Some(mode.to_string()),
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        tab_id: None,
        pane_id: None,
        observed_epoch: None,
        observed_generation: None,
        device_id: Some("test-device-a".to_string()),
    }
}

fn handoff_req_fresh(provider: &str, sid: &str, session_type: &str) -> HandoffRequest {
    HandoffRequest {
        action: HandoffAction::Switch,
        provider: provider.to_string(),
        session_id: sid.to_string(),
        target_kind: RuntimeOwnerKind::FreshAgent,
        session_type: Some(session_type.to_string()),
        mode: None,
        cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        tab_id: None,
        pane_id: None,
        observed_epoch: None,
        observed_generation: None,
        device_id: Some("test-device-a".to_string()),
    }
}

#[test]
fn handoff_action_contract_defaults_legacy_ack_only_to_clear() {
    assert_eq!(
        super::parse_handoff_action(&json!({})),
        Ok(HandoffAction::Switch)
    );
    assert_eq!(
        super::parse_handoff_action(&json!({
            "acknowledgePlatformLimitedRisk": true
        })),
        Ok(HandoffAction::ClearStaleBookkeeping)
    );
    assert_eq!(
        super::parse_handoff_action(&json!({ "action": "stop-and-reopen" })),
        Ok(HandoffAction::StopAndReopen)
    );
    assert!(super::parse_handoff_action(&json!({
        "action": "switch",
        "acknowledgePlatformLimitedRisk": true,
    }))
    .is_err());
    assert!(super::parse_handoff_action(&json!({
        "action": "clear-stale-bookkeeping",
        "acknowledgePlatformLimitedRisk": false,
    }))
    .is_err());
}

/// Task 3/F2: unsupported atomic handoff capability is refused before the
/// coordinator enters Handoff. The clear-only action still bypasses this
/// capability check because it never stops or starts a writer.
#[tokio::test]
async fn unsupported_atomic_handoff_refuses_before_mutation_and_clear_bypasses_preflight() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks
        .force_unsupported_preflight
        .store(true, Ordering::SeqCst);
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(Some(Arc::clone(&hooks)));

    let mut clear = handoff_req_terminal("claude", &sid, "claude");
    clear.action = HandoffAction::ClearStaleBookkeeping;
    let clear_result = rig.runner.spawn_handoff(clear).completion.await.unwrap();
    assert_eq!(clear_result["error"]["code"], json!("SESSION_NOT_FOUND"));

    establish_fresh_claude_owner(&mut rig, &sid).await;
    let before = rig.ownership.observe("claude", &sid);
    let before_flavor_writes = rig.flavor_log.lock().unwrap().len();
    let before_create_rows = env.create_rows().len();
    let before_events = hooks.events.lock().unwrap().clone();

    let result = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"))
        .completion
        .await
        .unwrap();

    assert_eq!(result["ok"], json!(false), "unsupported handoff: {result}");
    assert_eq!(result["error"]["code"], json!("PLATFORM_LIMITED_PRECHECK"));
    assert_eq!(result["error"]["retryable"], json!(true));
    assert_eq!(rig.ownership.observe("claude", &sid), before);
    assert_eq!(
        rig.flavor_log.lock().unwrap().len(),
        before_flavor_writes,
        "preflight must precede durable flavor writes"
    );
    assert_eq!(
        env.create_rows().len(),
        before_create_rows,
        "preflight must not tear down or recreate the prior runtime"
    );
    assert_eq!(
        *hooks.events.lock().unwrap(),
        before_events,
        "preflight must not enter target-start hooks"
    );
}

fn create_msg(sid: &str) -> FreshAgentCreate {
    FreshAgentCreate {
        naming_handle: None,
        request_id: format!("handoff-create-{}", uuid::Uuid::new_v4()),
        session_type: SessionType::Freshclaude,
        cwd: Some("/tmp".to_string()),
        effort: None,
        legacy_restore_context: None,
        model: None,
        model_selection: None,
        observed_epoch: None,
        observed_generation: None,
        permission_mode: None,
        plugins: None,
        provider: Some(AgentProvider::Claude),
        resume_session_id: None,
        sandbox: None,
        session_ref: Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: sid.to_string(),
        }),
        tab_id: None,
    }
}

fn kill_msg(sid: &str) -> FreshAgentKill {
    FreshAgentKill {
        provider: AgentProvider::Claude,
        session_id: sid.to_string(),
        session_type: SessionType::Freshclaude,
        cwd: None,
        observed_epoch: None,
        observed_generation: None,
    }
}

/// Drain every queued `session.runtimeOwner` frame off the rig's receiver.
fn drain_runtime_owner_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(raw) = rx.try_recv() {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            if value["type"] == "session.runtimeOwner" {
                frames.push(value);
            }
        }
    }
    frames
}

/// Bounded-poll until every named `session.runtimeOwner` transition has
/// arrived, then return ALL queued frames of this window in ARRIVAL ORDER
/// (the order the channel delivered them — the b8ke focused FR5 ordering
/// assertion's substrate: a `released` delivered before the `handoff-failed`
/// would let the stale failure frame overwrite the corrective release on
/// every same-generation client fold).
async fn await_owner_frames(
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    transitions: &[&str],
) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut frames = Vec::new();
    loop {
        while let Ok(raw) = rx.try_recv() {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                if value["type"] == "session.runtimeOwner" {
                    frames.push(value);
                }
            }
        }
        if transitions
            .iter()
            .all(|t| frames.iter().any(|f| f["transition"] == *t))
        {
            return frames;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the {transitions:?} broadcasts never arrived within budget"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// The single `session.runtimeOwner` frame with this transition (panics on
/// zero; errors on duplicates — every transition is broadcast exactly once).
fn runtime_owner_frame<'f>(frames: &'f [Value], transition: &str) -> &'f Value {
    let matches: Vec<&Value> = frames
        .iter()
        .filter(|f| f["transition"] == transition)
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "expected exactly one {transition} frame, got {frames:?}"
    );
    matches[0]
}

/// Bounded-poll until the pid is confirmed dead (`kill(pid, 0)` → ESRCH).
async fn await_pid_dead(pid: u32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while freshell_terminal::registry::pid_alive(pid) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "sidecar pid {pid} did not die within budget"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Await the single `session.runtimeOwner` frame with this transition
/// (bounded; skips unrelated frames — the tests 3b/4/5 inline loops,
/// factored for the round-3 abort-window tests).
async fn await_owner_frame(
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    transition: &str,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
            Ok(Ok(raw)) => {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if v["type"] == "session.runtimeOwner" && v["transition"] == transition {
                        return v;
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => panic!("broadcast channel closed"),
            Err(_) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the {transition} broadcast never arrived within budget"
                );
            }
        }
    }
}

/// Bounded-poll until the predicate holds (the async abort-cleanup settles).
async fn await_cond(desc: &str, pred: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !pred() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never held within budget: {desc}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Bounded-poll the claude lane's live-session probe until it flips to
/// `want` (the async abort-cleanup settles).
async fn await_live_session(state: &crate::FreshClaudeState, sid: &str, want: bool, desc: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while state.has_live_session(sid).await != want {
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never held within budget: {desc}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Establish a live freshclaude owner for `sid` (the fake sidecar path) and
/// return once the coordinator records it Live.
async fn establish_fresh_claude_owner(rig: &mut Rig, sid: &str) {
    rig.fresh_claude.handle_create(create_msg(sid), None).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match rig.ownership.observe("claude", sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "fresh owner never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    // b8ke ext r29 F1: the setup's own commit-to-Live now broadcasts the
    // authoritative owner record (EVERY commit does, per the invariant).
    // The handoff tests below assert the HANDOFF's frames with
    // exactly-one counts — drain the setup's frames here so each test's
    // frame window holds exactly what its own handoff emits (the
    // pre-r29 shape). The setup frame's existence itself is pinned by
    // the provider-level create tests (`a_normal_create_broadcasts_...`,
    // `a_materialization_broadcasts_...`).
    let _ = drain_runtime_owner_frames(&mut rig.rx);
}

// ── the capturing tracing layer (the diag01/ownership-crate pattern) ───────

mod tracing_capture {
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

    /// Thread-local capturing subscriber (current-thread test runtimes: the
    /// runner task, the settle task, and the lane awaits all poll on this
    /// thread and observe the default).
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
}

fn find_captured<'e>(
    events: &'e [tracing_capture::CapturedEvent],
    event: &str,
) -> Option<&'e tracing_capture::CapturedEvent> {
    events
        .iter()
        .find(|e| e.target == "freshell_ownership" && e.event == event)
}

// ── the tests ──────────────────────────────────────────────────────────────

/// 1. Happy path ordering: the old sidecar is reaped BEFORE the target
/// terminal spawns; commit is Live{Terminal}; the broadcast frames arrive
/// with the boot epoch and the true previousKind; exactly one sidecar ever
/// served the session; the runner's step order is Reaped < TargetStarted;
/// and the representative transitions carry the COMPLETE observability field
/// set.
#[tokio::test]
async fn handoff_to_terminal_reaps_sidecar_before_target_start_and_commits_owner() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let (events, _capture_guard) = tracing_capture::capture();
    // M-1 (round-3 review): hooks installed so the runner's step order is
    // ASSERTED (the plan's event-log ordering requirement), not just implied.
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let create_watermark = env.create_rows().len();
    let capture_start = events.lock().expect("capture lock").len();

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");

    assert_eq!(result["ok"], json!(true), "handoff must succeed: {result}");
    let terminal_id = result["owner"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    assert_eq!(result["owner"]["kind"], json!("terminal"));
    assert_eq!(result["owner"]["mode"], json!("claude"));

    // The coordinator is Live{Terminal} for (claude, sid), naming that terminal.
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected Live terminal owner, got {other:?}"),
    }

    // Broadcast frames: handoff-started then handoff-committed, each carrying
    // the boot epoch; the committed frame names the terminal and the TRUE
    // previousKind (the prior fresh-agent kind).
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let started = runtime_owner_frame(&frames, "handoff-started");
    let committed = runtime_owner_frame(&frames, "handoff-committed");
    assert!(started["epoch"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(
        started["previousKind"],
        json!("fresh-agent"),
        "the started frame carries the prior kind: {started}"
    );
    assert!(committed["epoch"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(committed["terminalId"].as_str(), Some(terminal_id.as_str()));
    assert_eq!(
        committed["previousKind"],
        json!("fresh-agent"),
        "the committed frame carries the true previousKind: {committed}"
    );

    // Exactly ONE sidecar create row for sid ever (no second fresh spawn),
    // and its pid is gone — the kill is awaited before the target start.
    assert_eq!(
        env.create_rows().len(),
        create_watermark,
        "no second sidecar may spawn for the session"
    );
    if let Some(pid) = env.sidecar_pid_for(&sid) {
        await_pid_dead(pid).await;
    }

    // Hook-event ordering: the prior was reaped BEFORE the target started.
    // (No hooks installed in the green path — the ordering is proven through
    // the sidecar pid death above plus the single-frame set; the explicit
    // event log is exercised by the timeout tests below.)

    // Round-1 review (observability): the COMPLETE field set on the
    // representative transitions.
    let captured = events.lock().expect("capture lock");
    let handoff_scope: Vec<_> = captured[capture_start..].to_vec();
    drop(captured);
    let begin = find_captured(&handoff_scope, "ownership.handoff.begin")
        .expect("ownership.handoff.begin event");
    for field in [
        "operation_id",
        "provider",
        "session_id",
        "initiator",
        "from_kind",
        "to_kind",
        "runtime_id",
        "pid",
        "epoch",
        "generation",
        "outcome",
    ] {
        assert!(
            begin.fields.contains_key(field),
            "ownership.handoff.begin must carry {field}: {begin:?}"
        );
    }
    let commit = find_captured(&handoff_scope, "ownership.live.commit")
        .expect("ownership.live.commit event");
    for field in [
        "operation_id",
        "provider",
        "session_id",
        "initiator",
        "from_kind",
        "to_kind",
        "runtime_id",
        "live_session_key",
        "pid",
        "epoch",
        "generation",
        "duration_ms",
        "outcome",
    ] {
        assert!(
            commit.fields.contains_key(field),
            "ownership.live.commit must carry {field}: {commit:?}"
        );
    }
    assert_eq!(
        commit.fields.get("outcome").map(String::as_str),
        Some("committed")
    );
    let done = find_captured(&handoff_scope, "ownership.handoff.done")
        .expect("ownership.handoff.done event");
    for field in [
        "operation_id",
        "provider",
        "session_id",
        "initiator",
        "epoch",
        "generation",
        "from_kind",
        "to_kind",
        "runtime_id",
        "live_session_key",
        "pid",
        "outcome",
        "duration_ms",
    ] {
        assert!(
            done.fields.contains_key(field),
            "ownership.handoff.done must carry {field}: {done:?}"
        );
    }
    assert_eq!(
        done.fields.get("outcome").map(String::as_str),
        Some("committed")
    );

    // Hook-event ordering (M-1, round-3 review — the plan's explicit
    // assertion): the prior was reaped BEFORE the target spawned.
    // b8ke ext r23 F2: TargetSpawnAttempted lands between them — start_target
    // was ENTERED (the spawn actually attempted), never answered early.
    assert_eq!(
        *hooks.events.lock().unwrap(),
        vec!["Reaped", "TargetSpawnAttempted", "TargetStarted"],
        "the runner's step order must be Reaped then TargetSpawnAttempted then TargetStarted"
    );

    // Cleanup: kill the committed terminal.
    rig.registry.kill(&terminal_id);
}

/// 2. Target spawn failure: no blank session, session id preserved, Vacant +
/// typed error, and the failure broadcast carries the ACTUAL resulting state
/// (ownerKind vacant, the prior fresh-agent previousKind, the typed reason,
/// the current epoch) — never the requested target kind — at the SAME
/// generation as the handoff-started frame.
#[tokio::test]
async fn handoff_target_spawn_failure_leaves_vacant_with_typed_error() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks.fail_target_spawn_once.store(true, Ordering::SeqCst);
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let create_watermark = env.create_rows().len();

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");

    assert_eq!(
        result["ok"],
        json!(false),
        "the handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("TARGET_SPAWN_FAILED"));
    assert_eq!(result["error"]["retryable"], json!(true));
    assert!(
        result["error"]["ownerGeneration"].as_u64().is_some(),
        "the typed error names the generation: {result}"
    );

    // The coordinator is Vacant — never a restored dead prior, never a
    // half-committed target.
    assert_eq!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant,
        "a failed target spawn leaves the key Vacant"
    );

    // No blank session was minted: no fresh sidecar row beyond the prior's,
    // and no PTY row for sid.
    assert_eq!(
        env.create_rows().len(),
        create_watermark,
        "no second sidecar may spawn for a failed handoff"
    );
    assert!(
        !rig.registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(sid.as_str())
        }),
        "no terminal may own {sid} after the failed handoff"
    );

    // b8ke ext r23 F2: THE ATTEMPT PIN — start_target was ENTERED (the
    // spawn was attempted on this call) before the failure. Pre-r23 the
    // knob fired at a pre-check BEFORE start_target was called; a
    // regression to that shape fails this assertion (the cleanup contract
    // is only proven by an actually-attempted-and-failed start).
    assert!(
        hooks
            .events
            .lock()
            .unwrap()
            .contains(&"TargetSpawnAttempted"),
        "the spawn-failure path must ENTER start_target (TargetSpawnAttempted): {:?}",
        hooks.events.lock().unwrap()
    );

    // Round-2 review (failure-broadcast truth): the handoff-failed frame
    // carries the ACTUAL resulting state — ownerKind "vacant", the prior
    // fresh-agent previousKind, the typed reason, the current epoch — never
    // the requested target kind.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let started = runtime_owner_frame(&frames, "handoff-started");
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(failed["ownerKind"], json!("vacant"), "the truth: {failed}");
    assert_eq!(failed["previousKind"], json!("fresh-agent"));
    assert_eq!(failed["reason"], json!("TARGET_SPAWN_FAILED"));
    assert!(failed["epoch"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(
        failed["generation"], started["generation"],
        "the corrective frame rides the SAME generation as the started frame \
         (it supersedes the transition record client-side)"
    );
}

/// 3. Reap timeout with a STILL-LIVE prior (round-2 review): no early
/// target start; typed REAP_TIMEOUT; the POSITIVE re-probe confirms the
/// prior live -> restored (a timeout alone never implies liveness). The
/// failure broadcast carries the RESTORED prior owner. A retry after
/// clearing the hook succeeds.
#[tokio::test]
async fn handoff_reap_timeout_reprobes_the_prior_and_restores_only_a_live_one() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let create_watermark = env.create_rows().len();
    // The sidecar stays ALIVE: the timeout is forced without any kill.
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");

    assert_eq!(
        result["ok"],
        json!(false),
        "the handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert_eq!(result["error"]["retryable"], json!(true));

    // The re-probe confirmed the prior LIVE — restored (a Live{fresh} record).
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                RuntimeOwnerKind::FreshAgent,
                "the restored prior is the fresh-agent owner"
            );
        }
        other => panic!("the live prior must be restored, got {other:?}"),
    }

    // NO terminal spawn happened: no PTY row for sid, no new sidecar rows.
    assert!(
        !rig.registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(sid.as_str())
        }),
        "no early target start on a reap timeout"
    );
    assert_eq!(env.create_rows().len(), create_watermark);
    assert!(
        !hooks.events.lock().unwrap().contains(&"TargetStarted"),
        "the runner's event log must not contain TargetStarted"
    );

    // The handoff-failed broadcast carries the RESTORED prior owner —
    // ownerKind fresh-agent, the prior's runtime identity, previousKind
    // fresh-agent, reason REAP_TIMEOUT — the truth, never the target kind.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        failed["ownerKind"],
        json!("fresh-agent"),
        "the truth: {failed}"
    );
    assert_eq!(failed["previousKind"], json!("fresh-agent"));
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"));

    // A retry after clearing the hook succeeds (the restored prior is stoppable).
    hooks.force_reap_timeout.store(false, Ordering::SeqCst);
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["ok"],
        json!(true),
        "the retry must succeed: {retried}"
    );
    let retry_terminal = retried["owner"]["terminalId"].as_str().unwrap().to_string();
    rig.registry.kill(&retry_terminal);
}

/// 3b. Reap timeout with an UNCONFIRMABLE prior (round-2 review): force the
/// timeout AND make the re-probe fail (kill the sidecar out-of-band while the
/// runner is parked at the pause hook) — the key ends VACANT with the typed
/// REAP_TIMEOUT (retryable, recoverable), never a dead runtime recorded as
/// Live; the handoff-failed broadcast carries ownerKind "vacant" + reason
/// REAP_TIMEOUT; a retry after clearing the hook succeeds.
#[tokio::test]
async fn handoff_reap_timeout_with_unconfirmable_prior_ends_vacant_typed() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the handoff-started broadcast fires before the pause.
    let _started = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rig.rx.recv().await {
                Ok(raw) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if v["type"] == "session.runtimeOwner"
                            && v["transition"] == "handoff-started"
                        {
                            return v;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => panic!("broadcast channel closed"),
            }
        }
    })
    .await
    .expect("handoff-started broadcast within budget");

    // Kill the sidecar out-of-band (the process itself — NOT the lane API):
    // the prior becomes unconfirmable once the consumer's exit eviction runs.
    let pid = env
        .sidecar_pid_for(&sid)
        .expect("the prior sidecar's pid from the create log");
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status()
        .expect("out-of-band sidecar kill");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while rig.fresh_claude.has_live_session(&sid).await {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the dead sidecar was never evicted from the lane's live map"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Force the timeout and unpark: the re-probe finds the prior dead.
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();
    let result = handle.completion.await.expect("runner completed");

    assert_eq!(
        result["ok"],
        json!(false),
        "the handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert_eq!(result["error"]["retryable"], json!(true));
    assert_eq!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant,
        "an unconfirmable prior ends the key Vacant — never a dead runtime as Live"
    );

    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(failed["ownerKind"], json!("vacant"), "the truth: {failed}");
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"));

    // A retry after clearing the hook succeeds (the session reopens cleanly).
    hooks.force_reap_timeout.store(false, Ordering::SeqCst);
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // The pause hook is still installed (a fresh notified() parks again) —
    // release the retry through it too.
    if let Some(pause) = hooks.pause_after_enter.as_ref() {
        pause.notify_one();
    }
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["ok"],
        json!(true),
        "the retry must succeed: {retried}"
    );
    let retry_terminal = retried["owner"]["terminalId"].as_str().unwrap().to_string();
    rig.registry.kill(&retry_terminal);
}

/// 3f. b8ke delta review F3 — the REAL reap-timeout window (the production
/// shape the `force_reap_timeout` hook cannot model: the kill ISSUED, the
/// death DELAYED past the runner's budget). The caller gets the typed
/// retryable REAP_TIMEOUT immediately, but the key does NOT go Vacant (and
/// the live prior is NOT restored — the detached teardown is still killing
/// it): it stays fenced in the Handoff/watcher state — a concurrent create
/// is Blocked, a retry is typed-refused — until the detached teardown's own
/// watcher confirms death, then the key releases to Vacant, the corrective
/// `released` broadcast supersedes the fenced `handoff-failed` frame, and a
/// retry succeeds. Pre-fix the timeout DROPPED the kill future and the
/// liveness probe's answer decided restore-vs-Vacant — a probe that reads
/// the lane's sessions map cannot see a map-evicted-but-alive sidecar, so
/// the key could reopen while the old process still ran (the second-writer
/// window).
#[tokio::test]
async fn handoff_reap_timeout_fences_the_key_until_the_detached_reap_confirms_death() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let kill_pause = Arc::new(tokio::sync::Notify::new());
    let mut rig = build_rig_with_claude_pauses_and_reap_timeout_ms(
        None,
        Some(Arc::clone(&kill_pause)),
        None,
        150,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the lane kill ISSUED (the retained stamp taken) — the
    // deterministic observable that the kill future is in flight and the
    // prior's death is DELAYED (the session itself is still registered).
    await_cond("the lane kill must issue (take the stamp)", || {
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .is_none()
    })
    .await;

    // The runner's reap budget elapses while the kill is parked: the
    // caller gets the typed retryable REAP_TIMEOUT...
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["ok"],
        json!(false),
        "the handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert_eq!(result["error"]["retryable"], json!(true));

    // ...and the key does NOT go Vacant nor restore the prior: it stays
    // fenced in Handoff (the detached watcher owns the release).
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Handoff { .. }
        ),
        "a real reap timeout must fence the key in Handoff until death is \
         confirmed, got {:?}",
        rig.ownership.observe("claude", &sid).state
    );
    // (a) A concurrent create is BLOCKED, not granted — no second writer
    // can start while the old process's death is unconfirmed.
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::FreshAgent,
                "fence-probe-create",
                None,
                "test",
                0,
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a create during the fenced reap window must be Blocked, not Granted"
    );
    // A handoff retry during the fence is typed-refused (in flight).
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["error"]["code"],
        json!("HANDOFF_IN_PROGRESS"),
        "the fenced retry is typed-refused: {retried}"
    );
    assert_eq!(retried["error"]["retryable"], json!(true));

    // (b) The delayed death lands: release the pause, the DETACHED
    // teardown runs to its confirmed reap, and the watcher releases the
    // fenced key to Vacant.
    kill_pause.notify_one();
    await_cond("the confirmed death must release the fenced key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    await_pid_dead(prior_pid).await;

    // The corrective frames: the fenced `handoff-failed` names the PRIOR
    // (still the fenced owner, reason REAP_TIMEOUT), then the settlement's
    // `released` names the now-vacant key. b8ke focused review FR5: the
    // failure frame must land STRICTLY BEFORE any released frame — the
    // frames are collected in arrival order (bounded-wait for both) and
    // their positions asserted (a released-first ordering would leave
    // same-generation client folds latched on the stale prior-owner
    // frame).
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed", "released"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        failed["ownerKind"],
        json!("fresh-agent"),
        "the truth: {failed}"
    );
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"));
    let released = runtime_owner_frame(&frames, "released");
    assert_eq!(
        released["ownerKind"],
        json!("vacant"),
        "the truth: {released}"
    );
    let failed_pos = frames
        .iter()
        .position(|f| f["transition"] == "handoff-failed")
        .expect("the failed frame position");
    let released_pos = frames
        .iter()
        .position(|f| f["transition"] == "released")
        .expect("the released frame position");
    assert!(
        failed_pos < released_pos,
        "b8ke focused FR5: the handoff-failed frame (index {failed_pos}) must strictly \
         precede the released frame (index {released_pos}) — a released-first ordering \
         would let the stale failure frame overwrite the corrective release on every \
         same-generation client fold"
    );

    // After confirmed death a retry succeeds (granted from Vacant — no
    // prior to stop; the target spawns and commits).
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["ok"],
        json!(true),
        "the post-settlement retry must succeed: {retried}"
    );
    let retry_terminal = retried["owner"]["terminalId"].as_str().unwrap().to_string();
    rig.registry.kill(&retry_terminal);
}

/// 3g. b8ke focused round-2 review R2-1: a JoinError in the detached reap
/// watcher (the spawned teardown task itself fails — here: cancelled by the
/// test hook, a REAL JoinError) must leave the TYPED FENCED state — NEVER
/// the round-1 fail-open to plain `Vacant` (which licensed a second writer
/// over a possibly-live prior). A create during the fence is BLOCKED; the
/// replacement watcher's bounded recorded-identity probe kill-and-confirms
/// the condemned sidecar tree, and ONLY that confirmed death releases the
/// fence — the corrective `released` frame (reason WATCHER_FAILED)
/// superseding the fenced `handoff-failed` frame — after which a retry
/// succeeds.
#[tokio::test]
async fn a_watcher_join_error_fences_the_key_until_the_replacement_probe_confirms_death() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let kill_pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig_full(
        Some(Arc::clone(&hooks)),
        Some(Arc::clone(&kill_pause)),
        None,
        150,
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");
    // The sidecar's ownership tag (our process is its ancestor, so
    // /proc/<pid>/environ is readable) — the replacement probe's
    // kill-and-confirm target.
    let ownership_id = {
        let environ = std::fs::read(format!("/proc/{prior_pid}/environ"))
            .expect("read the sidecar's environ");
        environ
            .split(|&b| b == 0)
            .find_map(|var| {
                let var = std::str::from_utf8(var).ok()?;
                var.strip_prefix("FRESHELL_CLAUDE_SIDECAR_ID=")
            })
            .expect("the sidecar's ownership id")
            .to_string()
    };
    // A TERM-immune tagged "CLI grandchild" under the sidecar's tag: the
    // replacement probe's kill-and-confirm needs its SIGKILL escalation
    // rounds (≥500ms), so the Fenced window is deterministically
    // observable — and the probe provably kill-and-confirms the WHOLE
    // condemned tree, not just the sidecar.
    let mut grandchild = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("trap '' TERM; while :; do sleep 1; done")
        .env("FRESHELL_CLAUDE_SIDECAR_ID", &ownership_id)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the lingering tagged grandchild");
    let grandchild_pid = grandchild.id().expect("grandchild pid");

    // Arm the injected JoinError: the NEXT watcher's confirmation wrapper
    // aborts the spawned teardown task (a real cancelled-JoinError).
    hooks
        .abort_reap_confirmation_once
        .store(true, Ordering::SeqCst);

    // Drive test 3f's real-timeout shape: the lane kill parks past the
    // runner's budget, the timeout branch fences the key and spawns the
    // watcher — whose confirmation task the hook then aborts.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    await_cond("the lane kill must issue (take the stamp)", || {
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .is_none()
    })
    .await;
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));

    // THE R2-1 regression: the watcher's JoinError leaves the key in the
    // TYPED Fenced{WatcherFailed} state — never the round-1 fail-open to
    // Vacant.
    await_cond("the watcher failure must fence the key typed", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: freshell_ownership::FenceReason::WatcherFailed,
                ..
            }
        )
    })
    .await;
    // While fenced, a create is BLOCKED — the round-1 fail-open granted it
    // (two writers on one session; the defect this test pins).
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::FreshAgent,
                "fence-probe-create-r21",
                None,
                "test",
                0,
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a create during the watcher-failed fence must be Blocked, never Granted"
    );

    // The replacement watcher's bounded recorded-identity probe finishes
    // the condemned kill: the sidecar dies immediately and the tagged
    // grandchild needs the SIGKILL escalation — the fence releases only
    // after the WHOLE tree is confirmed dead.
    await_pid_dead(prior_pid).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while crate::session_lease::proc_starttime(grandchild_pid as i32).is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the replacement probe never killed the lingering descendant"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    await_cond("the confirmed death must release the fenced key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed", "released"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"));
    let released = runtime_owner_frame(&frames, "released");
    assert_eq!(
        released["reason"],
        json!("WATCHER_FAILED"),
        "the replacement probe's release names the watcher failure: {released}"
    );
    let failed_pos = frames
        .iter()
        .position(|f| f["transition"] == "handoff-failed")
        .expect("the failed frame position");
    let released_pos = frames
        .iter()
        .position(|f| f["transition"] == "released")
        .expect("the release frame position");
    assert!(
        failed_pos < released_pos,
        "the failure frame (index {failed_pos}) must precede the release (index {released_pos})"
    );

    // The recoverable state: a retry SUCCEEDS (the fence released on
    // confirmed death).
    let _ = grandchild.wait().await;
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["ok"],
        json!(true),
        "the post-settlement retry must succeed: {retried}"
    );
    let retry_terminal = retried["owner"]["terminalId"].as_str().unwrap().to_string();
    rig.registry.kill(&retry_terminal);
}

/// 3i. b8ke focused round-2 review R2-3: a platform-limited prior stop (the
/// direct child's awaited exit is the portable confirmation floor; the
/// descendant-tree verification requires Linux `/proc`) must NOT satisfy
/// confirmed-reap. The handoff answers the typed PLATFORM_LIMITED failure,
/// the key is FENCED with the typed reason — a create is Blocked (never a
/// second writer over a possibly-live descendant), and the session remains
/// recoverable (the durable history untouched). The documented tradeoff:
/// nothing on that platform can confirm the descendant death, so the fence
/// persists for the boot epoch — driven on Linux through the lane's test
/// seam (the real arm is `cfg(not(linux))`-only).
#[tokio::test]
async fn handoff_with_a_platform_limited_prior_stop_fences_the_key_typed() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_options(None, None, None, 8_000, None, true);
    establish_fresh_claude_owner(&mut rig, &sid).await;
    // Consume the establish-time frames so the failure window is isolated.
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");

    // The typed failure — NEVER a bare success (pre-R2-3 the
    // PlatformLimited teardown answered Reaped and the handoff committed
    // a terminal writer over an unverifiable descendant tree).
    assert_eq!(
        result["ok"],
        json!(false),
        "the platform-limited handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("PLATFORM_LIMITED"));
    assert_eq!(result["error"]["retryable"], json!(true));
    // b8ke focused round-4 R4-5: the fenced failure frame carries the
    // `fenced` marker — an online same-kind pane keeps the typed recovery
    // state (no polling resumption as a healthy owner). Pre-fix, the
    // frame read as an ordinary handoff-failed owner and the client
    // resumed normal polling.
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        failed["fenced"],
        json!(true),
        "the fenced failure frame must carry the fenced marker: {failed}"
    );
    assert_eq!(failed["reason"], json!("PLATFORM_LIMITED"));
    // The key is FENCED with the typed PlatformLimited reason.
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::PlatformLimited,
                ..
            }
        ),
        "the platform-limited stop must fence the key typed, got {:?}",
        rig.ownership.observe("claude", &sid).state
    );
    // A create during the fence is Blocked — no new writer can start.
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::FreshAgent,
                "pl-fence-probe-create",
                None,
                "test",
                0,
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a create during the platform-limited fence must be Blocked"
    );
    // A handoff retry is the typed refusal while fenced. b8ke focused
    // round-4 R4-4: an ordinary retry (with OR without the observed
    // fence pair) answers the typed PLATFORM_LIMITED_FENCED refusal —
    // never a force-clear (the acknowledged force-clear is the only
    // recovery; see 3k).
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(retried["error"]["code"], json!("PLATFORM_LIMITED_FENCED"));
}

/// b8ke e3r3 F3: a STALE-STOP fence recovers through the SAME full path
/// as StaleStart — the runner's recoverable-fence match accepts it (the
/// ordinary retry answers the reason-typed STALE_STOP_FENCED refusal; the
/// acknowledged force-clear releases with the truthful stale-stop-fence
/// label). Pre-e3r3 the watchdog made StaleStop reachable but handoff
/// requests fell to generic HANDOFF_IN_PROGRESS — wedged until restart.
#[tokio::test]
async fn a_stale_stop_fence_recovers_through_the_handoff_runner() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(None);

    // Arm a StaleStop fence: a Live owner, a stranded stop claim, the
    // settlement flag FIRED (the handler ended), the watchdog fences.
    let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_start(
        "claude",
        &sid,
        RuntimeOwnerKind::FreshAgent,
        "op-live-ss",
        None,
        "test",
        0,
    ) else {
        panic!("expected Granted")
    };
    let owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::FreshAgent,
        terminal_id: None,
        live_session_key: Some(sid.clone()),
        pid: None,
        ownership_id: None,
    };
    assert!(matches!(
        rig.ownership
            .commit_live("claude", &sid, "op-live-ss", generation, owner),
        freshell_ownership::CommitOutcome::Committed
    ));
    let stop_claim = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: None,
        observed: freshell_ownership::ObservedFence {
            epoch: rig.ownership.boot_epoch(),
            generation,
        },
    };
    match rig
        .ownership
        .begin_stop("claude", &sid, "op-stranded-ss", &stop_claim, "test", 0)
    {
        freshell_ownership::StopOutcome::Granted {
            generation: stop_gen,
        } => {
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            assert!(rig.ownership.register_stop_settlement(
                "claude",
                &sid,
                "op-stranded-ss",
                stop_gen,
                Arc::clone(&flag),
            ));
            // The handler ENDED without commit/abort (the vanished stop).
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        other => panic!("expected the stop claim granted, got {other:?}"),
    }
    let fenced = rig.ownership.recover_stale_stoppings(10_000, 5_000);
    assert_eq!(fenced.len(), 1, "the fired-flag stop fences typed");
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Fenced {
            reason: freshell_ownership::FenceReason::StaleStop,
            ..
        }
    ));
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // (a) The ORDINARY retry: the reason-typed refusal (pre-e3r3: generic
    // HANDOFF_IN_PROGRESS).
    let ordinary = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let ordinary_result = ordinary.completion.await.expect("retry completed");
    assert_eq!(
        ordinary_result["error"]["code"],
        json!("STALE_STOP_FENCED"),
        "the ordinary retry answers the reason-typed refusal: {ordinary_result}"
    );
    assert_eq!(ordinary_result["error"]["retryable"], json!(true));
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Fenced { .. }
    ));

    // (b) b8ke ext r25 F1(b): the acknowledged force-clear now ACCEPTS
    // the stale reasons — the operator escape through the EXISTING
    // r16-F4 cleared-unverified pipeline (pre-r25 the flag answered the
    // same typed refusal and a stale fence whose provider evidence was
    // gone was PERMANENT). The clear STOPS AT THE CLEAR: the typed clear
    // answer, the key lands Fenced{ClearedUnverified} (never plain
    // Vacant), no owner committed, no handoff started.
    let _ = drain_runtime_owner_frames(&mut rig.rx);
    let snap = rig.ownership.observe("claude", &sid);
    let mut clear_req = handoff_req_terminal("claude", &sid, "claude");
    clear_req.action = HandoffAction::ClearStaleBookkeeping;
    clear_req.observed_epoch = Some(snap.epoch);
    clear_req.observed_generation = Some(snap.generation);
    let clear = rig.runner.spawn_handoff(clear_req);
    let cleared = clear
        .completion
        .await
        .expect("the acknowledged request completed");
    assert_eq!(
        cleared["ok"],
        json!(true),
        "the acknowledged force-clear answers the typed clear: {cleared}"
    );
    assert_eq!(
        cleared["cleared"],
        json!("stale-stop-fence"),
        "the typed clear names the stale-stop fence: {cleared}"
    );
    assert!(
        cleared.get("owner").is_none(),
        "the typed clear is NOT a handoff success — no owner is committed"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ),
        "the clear lands the TYPED cleared-unverified state — never plain Vacant"
    );
    // b8ke ext r28 F1: the clear's broadcast carries the AUTHORITATIVE
    // post-clear state — the FENCED truth (Fenced{ClearedUnverified}),
    // never a bare "released"/vacant frame (pre-r28 the two assertions
    // contradicted each other: a fenced coordinator plus a vacant
    // broadcast online panes folded as an available session).
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let cleared_frame = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        cleared_frame["ownerKind"],
        json!("fresh-agent"),
        "the fenced frame names the retained prior's kind: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["fenced"],
        json!(true),
        "the fenced marker rides the clear's broadcast: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["reason"],
        json!("cleared-unverified"),
        "the frame carries the authoritative fence's typed wire reason: {cleared_frame}"
    );

    // (c) An UNACKNOWLEDGED retry on the cleared-unverified key answers
    // the typed refusal — the start requires the acknowledged-risk arm.
    let snap = rig.ownership.observe("claude", &sid);
    let mut naive = handoff_req_terminal("claude", &sid, "claude");
    naive.observed_epoch = Some(snap.epoch);
    naive.observed_generation = Some(snap.generation);
    let naive_handle = rig.runner.spawn_handoff(naive);
    let naive_result = naive_handle
        .completion
        .await
        .expect("naive retry completed");
    assert_eq!(
        naive_result["error"]["code"],
        json!("CLEARED_UNVERIFIED_FENCED"),
        "an unacknowledged start on the cleared-unverified key refuses typed: {naive_result}"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ),
        "the naive retry left the cleared-unverified state held"
    );

    // (d) THE ACKNOWLEDGED START: the retry carrying the flag enters
    // Handoff atomically over the cleared-unverified state (the ONE
    // atomic acknowledged start) and the handoff proceeds fresh (the
    // no-prior sequence) — the terminal owner commits.
    let _ = drain_runtime_owner_frames(&mut rig.rx);
    let snap = rig.ownership.observe("claude", &sid);
    let mut start_req = handoff_req_terminal("claude", &sid, "claude");
    start_req.action = HandoffAction::StopAndReopen;
    start_req.observed_epoch = Some(snap.epoch);
    start_req.observed_generation = Some(snap.generation);
    let start = rig.runner.spawn_handoff(start_req);
    let started = start
        .completion
        .await
        .expect("acknowledged start completed");
    assert_eq!(
        started["ok"],
        json!(true),
        "the acknowledged start proceeds over the cleared-unverified state: {started}"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Live { owner, .. }
                if owner.kind == RuntimeOwnerKind::Terminal
        ),
        "the acknowledged start committed the terminal owner"
    );
}

/// b8ke e3r3 F4: the durable flavor derives from the session's kind
/// pairing, NEVER the wire mode — a Kilroy Fresh Agent reopened as its
/// Claude CLI (mode "claude") persists flavor "kilroy" (the pairing
/// contract; pre-e3r3 the wire mode remapped the session to freshclaude
/// for other devices/history).
struct FixedFlavorWriter {
    log: FlavorWriteLog,
    current: Option<String>,
}

impl crate::session_handoff::FlavorWrite for FixedFlavorWriter {
    fn stage(
        &self,
        provider: &str,
        session_id: &str,
        flavor: &str,
    ) -> crate::session_handoff::StagedFlavorFuture {
        let log = Arc::clone(&self.log);
        let entry = (
            provider.to_string(),
            session_id.to_string(),
            flavor.to_string(),
        );
        let staged: Box<dyn crate::session_handoff::StagedFlavor> =
            Box::new(StagedLoggingFlavor { log, entry });
        Box::pin(std::future::ready(Ok(Some(staged))))
    }

    fn current_flavor(
        &self,
        _provider: &str,
        _session_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>> {
        let current = self.current.clone();
        Box::pin(std::future::ready(current))
    }
}

#[tokio::test]
async fn a_kilroy_to_claude_cli_handoff_preserves_the_kilroy_flavor() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let log: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    // The session's current durable flavor is KILROY (the hidden type).
    let mut rig = build_rig_with_flavor_writer(Arc::new(FixedFlavorWriter {
        log: Arc::clone(&log),
        current: Some("kilroy".to_string()),
    }));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // The Kilroy→Claude-CLI handoff (the wire mode is "claude").
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["ok"], json!(true), "the handoff commits: {result}");

    // THE F4 CONTRACT: the durable flavor stays KILROY — the hidden
    // pairing, never the wire mode.
    let flavors = log.lock().expect("flavor log lock").clone();
    assert_eq!(
        flavors,
        vec![("claude".to_string(), sid.clone(), "kilroy".to_string())],
        "the hidden flavor is PRESERVED across the CLI handoff"
    );
}

/// b8ke d4 F1: the uncommitted-target teardown's outcome is CONSUMED —
/// a flavor-write failure whose target reap TIMES OUT (the kill issued,
/// the confirmation detached) fences the key in Handoff instead of
/// vacating it: the typed failure answers immediately, new claims stay
/// BLOCKED (never a second writer over an unconfirmed target — pre-d4
/// the discarded outcome vacated the key while the target lived), and
/// the detached watcher RESOLVES the fence to Vacant once its
/// confirmation lands.
#[tokio::test]
async fn an_unconfirmed_target_reap_on_the_flavor_failure_fences_then_the_watcher_resolves() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks
        .force_reap_timeout_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_reap_timeout_fenced_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig_inner(
        Some(Arc::clone(&hooks) as Arc<HandoffTestHooks>),
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(FailingFlavorWriter)),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // A handoff to a TERMINAL target (the rig's supported direction; the
    // forced fenced-timeout hook consults at the reap's top).
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure answers: {result}"
    );
    // THE F1 CONTRACT: the key is FENCED in Handoff — NOT Vacant (pre-d4
    // the discarded outcome vacated the key while the target was
    // unconfirmed).
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Handoff { .. }
        ),
        "the unconfirmed target's key stays FENCED in Handoff — got {:?}",
        rig.ownership.observe("claude", &sid).state
    );
    // New claims are BLOCKED (the active-writer refusal held).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-second-writer-d4",
            None,
            "test",
            0,
        ),
        freshell_ownership::BeginOutcome::Blocked { .. }
    ));
    // The detached watcher RESOLVES the fence (the hook's confirmation
    // lands after its short delay).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the detached watcher never resolved the fence — state: {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// b8ke d4 F1: a PLATFORM-LIMITED target teardown fences the typed
/// PlatformLimited fence (the documented no-watcher tradeoff) — never
/// Vacant over an unconfirmable descendant tree.
#[tokio::test]
async fn a_platform_limited_target_reap_on_the_flavor_failure_fences_typed() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks
        .force_platform_limited
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_platform_limited_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig_inner(
        Some(Arc::clone(&hooks) as Arc<HandoffTestHooks>),
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(FailingFlavorWriter)),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure answers: {result}"
    );
    // THE F1 CONTRACT: the typed PlatformLimited fence — never Vacant.
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::PlatformLimited,
                ..
            }
        ),
        "the platform-limited target's key ends the typed PlatformLimited \
         fence — got {:?}",
        rig.ownership.observe("claude", &sid).state
    );
}

/// b8ke e4r1 F1: the LAST `handoff-failed` frame of the window — the frame
/// every same-generation client fold ends on (the client applies ALL
/// same-generation updates, so the LAST one is the visible truth; a later
/// `released` frame never masks the failure sequence this asserts over).
fn last_handoff_failed_frame(frames: &[Value]) -> &Value {
    frames
        .iter()
        .rev()
        .find(|f| f["transition"] == "handoff-failed")
        .expect("at least one handoff-failed frame")
}

/// b8ke e4r1 F1 (the truthful-representation channel): the failure-truth
/// broadcast reflects the ACTUAL coordinator snapshot — after an
/// unconfirmed-reap flavor-write failure (the reap TIMED OUT, the key
/// stays fenced in Handoff), the LAST handoff-failed frame carries
/// fenced:true + REAP_TIMEOUT, never a vacant conversion (pre-e4r1 the
/// late generic failure frame converted the fenced record to
/// ownerKind:"vacant" and overwrote the typed fenced frame on every
/// same-generation client fold — remote panes read a vacant session while
/// the server kept blocking every lifecycle operation). e4r1 F2: the
/// done-line's outcome label records the NOT-CONFIRMED reap
/// (flavor_write_failed_target_unconfirmed), never the blanket "reaped".
#[tokio::test]
async fn the_unconfirmed_reap_flavor_failure_frame_stays_fenced_never_vacant() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let (sink, _capture_guard) = tracing_capture::capture();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks
        .force_reap_timeout_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_reap_timeout_fenced_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig_inner(
        Some(Arc::clone(&hooks) as Arc<HandoffTestHooks>),
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(FailingFlavorWriter)),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure answers: {result}"
    );

    // THE FRAME CONTRACT (the EMITTED frames, not the registry state):
    // the LAST handoff-failed frame keeps the typed fenced truth.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let last_failed = last_handoff_failed_frame(&frames);
    assert_ne!(
        last_failed["ownerKind"],
        json!("vacant"),
        "the unconfirmed-reap failure frame must never convert the fenced \
         record to a vacant session — frames: {frames:?}"
    );
    assert_eq!(
        last_failed["fenced"],
        json!(true),
        "the unconfirmed-reap failure frame carries the fenced marker: {frames:?}"
    );
    assert_eq!(
        last_failed["reason"],
        json!("REAP_TIMEOUT"),
        "the unconfirmed-reap failure frame carries the typed fence reason: {frames:?}"
    );

    // e4r1 F2: the done-line records the NOT-CONFIRMED reap — never the
    // blanket "reaped" label (the opposite of the safety-critical outcome).
    let events = sink.lock().expect("capture lock").clone();
    let done_outcomes: Vec<&str> = events
        .iter()
        .filter(|e| e.target == "freshell_ownership" && e.event == "ownership.handoff.done")
        .filter_map(|e| e.fields.get("outcome").map(String::as_str))
        .collect();
    assert!(
        done_outcomes.contains(&"flavor_write_failed_target_unconfirmed"),
        "the unconfirmed-reap flavor failure's done outcome must be the \
         truthful flavor_write_failed_target_unconfirmed — got {done_outcomes:?}"
    );
    assert!(
        !done_outcomes.contains(&"flavor_write_failed_target_reaped"),
        "a reap that was explicitly NOT confirmed must never log \
         flavor_write_failed_target_reaped — got {done_outcomes:?}"
    );
}

/// b8ke e4r1 F1: the PLATFORM-LIMITED unconfirmed-reap variant — the key
/// ends the typed Fenced{PlatformLimited} record, and the LAST
/// handoff-failed frame carries fenced:true + the fence's typed wire
/// reason, never a vacant conversion. e4r1 F2: the done outcome records
/// the NOT-CONFIRMED reap.
#[tokio::test]
async fn the_platform_limited_reap_failure_frame_stays_fenced_never_vacant() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let (sink, _capture_guard) = tracing_capture::capture();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    hooks
        .force_platform_limited
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_platform_limited_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig_inner(
        Some(Arc::clone(&hooks) as Arc<HandoffTestHooks>),
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(FailingFlavorWriter)),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure answers: {result}"
    );

    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let last_failed = last_handoff_failed_frame(&frames);
    assert_ne!(
        last_failed["ownerKind"],
        json!("vacant"),
        "the platform-limited failure frame must never convert the fenced \
         record to a vacant session — frames: {frames:?}"
    );
    assert_eq!(
        last_failed["fenced"],
        json!(true),
        "the platform-limited failure frame carries the fenced marker: {frames:?}"
    );
    assert_eq!(
        last_failed["reason"],
        json!("platform-limited"),
        "the platform-limited failure frame carries the fence's typed wire \
         reason: {frames:?}"
    );
    // b8ke e4 post-cap F2: the fence records the UNCONFIRMED TARGET's
    // identity, never the already-reaped source — the failure frame (and
    // the authoritative snapshot below) name the TERMINAL target the
    // handoff spawned (pre-post-cap the fence copied the Handoff prior —
    // the reaped fresh-agent source — and the frame carried ITS kind).
    assert_eq!(
        last_failed["ownerKind"],
        json!("terminal"),
        "the platform-limited failure frame names the unconfirmed TARGET's \
         kind — frames: {frames:?}"
    );
    let fenced_target_id = last_failed["terminalId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        !fenced_target_id.is_empty(),
        "the platform-limited failure frame carries the unconfirmed \
         TARGET's terminal id — frames: {frames:?}"
    );
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Fenced {
            prior: Some((owner, _)),
            ..
        } => {
            assert_eq!(
                owner.kind,
                RuntimeOwnerKind::Terminal,
                "the authoritative snapshot's fenced prior is the TARGET"
            );
            assert_eq!(
                owner.terminal_id.as_deref(),
                Some(fenced_target_id.as_str()),
                "the authoritative snapshot's fenced prior is the TARGET's id"
            );
        }
        other => panic!("the platform-limited fence must stand: {other:?}"),
    }

    let events = sink.lock().expect("capture lock").clone();
    let done_outcomes: Vec<&str> = events
        .iter()
        .filter(|e| e.target == "freshell_ownership" && e.event == "ownership.handoff.done")
        .filter_map(|e| e.fields.get("outcome").map(String::as_str))
        .collect();
    assert!(
        done_outcomes.contains(&"flavor_write_failed_target_unconfirmed"),
        "the platform-limited flavor failure's done outcome must be the \
         truthful flavor_write_failed_target_unconfirmed — got {done_outcomes:?}"
    );
    assert!(
        !done_outcomes.contains(&"flavor_write_failed_target_reaped"),
        "a platform-limited reap was explicitly NOT confirmed — never log \
         flavor_write_failed_target_reaped: {done_outcomes:?}"
    );

    // Cleanup: the forced platform-limited path never killed the spawned
    // target — reap it.
    rig.registry.kill(&fenced_target_id);
}

/// b8ke e4r1 F1: the STALE-COMMIT arm's duplicated flaw — a stale commit
/// (ownership moved mid-handoff: the record is Fenced when the runner's
/// commit arrives) whose uncommitted-target reap is UNCONFIRMED must keep
/// the typed fenced truth as the LAST handoff-failed frame, never a vacant
/// conversion. e4r1 F2: the done outcome records the NOT-CONFIRMED reap
/// (stale_commit_target_unconfirmed), never stale_commit_reaped_target.
#[tokio::test]
async fn the_stale_commit_unconfirmed_reap_frame_stays_fenced_never_vacant() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let (sink, _capture_guard) = tracing_capture::capture();
    let sid = uuid::Uuid::new_v4().to_string();
    let pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_in_target_spawn: Some(Arc::clone(&pause)),
        ..HandoffTestHooks::default()
    });
    // The target reap consults AFTER the prior stop consumed the skip.
    hooks
        .force_reap_timeout_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_reap_timeout_fenced_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the settle published the spawned terminal and parked.
    let target_terminal = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(watch) = hooks.spawn_watch_slot.lock().unwrap().clone() {
                if let Some(terminal_id) = watch.published_terminal() {
                    break terminal_id;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the settle never published the spawned terminal"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };

    // Ownership moves mid-handoff: the handoff's own record is fenced by
    // the watchdog-shaped typed fence (the runner's op/generation), so the
    // runner's commit answers foreign — the stale-commit arm.
    let (op, gen) = match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Handoff {
            operation_id,
            generation,
            ..
        } => (operation_id, generation),
        other => panic!("the runner must hold the Handoff record: {other:?}"),
    };
    assert!(matches!(
        rig.ownership.fence_unconfirmed_handoff(
            "claude",
            &sid,
            &op,
            gen,
            FenceReason::WatcherFailed,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    pause.notify_one();

    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("STALE_GENERATION"),
        "the typed stale-commit failure answers: {result}"
    );
    // b8ke ext r34 F1: the stale-commit's STALE_GENERATION is RETRYABLE
    // from the ACTUAL handler output — the message says the caller
    // refreshes and retries (pre-r34 the flag was false and the banner
    // rendered no action).
    assert_eq!(
        result["error"]["retryable"],
        json!(true),
        "STALE_GENERATION carries retryable: true from the handler: {result}"
    );

    // THE FRAME CONTRACT: the LAST handoff-failed frame keeps the typed
    // fenced truth (fenced:true + the fence record's wire reason), never a
    // vacant conversion over a fenced record.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let last_failed = last_handoff_failed_frame(&frames);
    assert_ne!(
        last_failed["ownerKind"],
        json!("vacant"),
        "the stale-commit's unconfirmed-reap failure frame must never \
         convert the fenced record to a vacant session — frames: {frames:?}"
    );
    assert_eq!(
        last_failed["fenced"],
        json!(true),
        "the stale-commit's unconfirmed-reap failure frame carries the \
         fenced marker: {frames:?}"
    );
    assert_eq!(
        last_failed["reason"],
        json!("watcher-failed"),
        "the stale-commit's unconfirmed-reap failure frame carries the \
         fence record's typed wire reason: {frames:?}"
    );

    // e4r1 F2: the done outcome records the NOT-CONFIRMED reap.
    let events = sink.lock().expect("capture lock").clone();
    let done_outcomes: Vec<&str> = events
        .iter()
        .filter(|e| e.target == "freshell_ownership" && e.event == "ownership.handoff.done")
        .filter_map(|e| e.fields.get("outcome").map(String::as_str))
        .collect();
    assert!(
        done_outcomes.contains(&"stale_commit_target_unconfirmed"),
        "the stale-commit's unconfirmed-reap done outcome must be the \
         truthful stale_commit_target_unconfirmed — got {done_outcomes:?}"
    );
    assert!(
        !done_outcomes.contains(&"stale_commit_reaped_target"),
        "a reap that was explicitly NOT confirmed must never log \
         stale_commit_reaped_target — got {done_outcomes:?}"
    );

    // b8ke e4r2 F3: the FINAL-frame contract — the detached noop watcher
    // resolves the fence (~300ms) and broadcasts `released`; the FINAL
    // runtimeOwner frame the client folds reflects the server's ACTUAL
    // (now Vacant) state, never the stale fenced failure frame.
    let frames = await_owner_frames(&mut rig.rx, &["released"]).await;
    let final_frame = frames.last().expect("at least one frame");
    assert_eq!(
        final_frame["ownerKind"],
        json!("vacant"),
        "the final frame reflects the watcher-released vacant state — \
         frames: {frames:?}"
    );
    assert_eq!(
        final_frame["transition"],
        json!("released"),
        "the watcher's corrective released frame is the final one — \
         frames: {frames:?}"
    );

    // Cleanup: reap the spawned target the forced-timeout path left
    // running.
    rig.registry.kill(&target_terminal);
}

/// b8ke e4r2 F3: the fenced-snapshot read and the failure send are
/// ordered atomically w.r.t. the detached watcher's release broadcast —
/// when the watcher resolves MID-WINDOW (releases the fence, broadcasts
/// `released`) between the failure-truth's snapshot read and its send,
/// the corrective frame for the RESOLVED state is sent AFTER the stale
/// failure frame, so the FINAL same-generation frame the client folds
/// reflects the server's actual (vacant) state. Pre-e4r2 the stale
/// fenced frame postceded the `released` frame and became the final
/// client state though the server was vacant.
#[tokio::test]
async fn a_watcher_release_mid_failure_window_leaves_the_final_frame_resolved() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let pause = Arc::new(tokio::sync::Notify::new());
    let failure_park = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_in_target_spawn: Some(Arc::clone(&pause)),
        pause_in_failure_truth_broadcast: Some(Arc::clone(&failure_park)),
        pause_in_failure_truth_once: std::sync::atomic::AtomicBool::new(true),
        ..HandoffTestHooks::default()
    });
    // The target reap consults AFTER the prior stop consumed the skip.
    hooks
        .force_reap_timeout_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_reap_timeout_fenced_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the settle published the spawned terminal and parked.
    let target_terminal = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(watch) = hooks.spawn_watch_slot.lock().unwrap().clone() {
                if let Some(terminal_id) = watch.published_terminal() {
                    break terminal_id;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the settle never published the spawned terminal"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };

    // Ownership moves mid-handoff: the record is fenced with the runner's
    // op/generation, so the runner's commit answers foreign — the
    // stale-commit arm whose failure-truth reads the FENCED snapshot.
    let (op, gen) = match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Handoff {
            operation_id,
            generation,
            ..
        } => (operation_id, generation),
        other => panic!("the runner must hold the Handoff record: {other:?}"),
    };
    assert!(matches!(
        rig.ownership.fence_unconfirmed_handoff(
            "claude",
            &sid,
            &op,
            gen,
            FenceReason::WatcherFailed,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    pause.notify_one();

    // The runner's stale-commit arm runs: the forced-timeout reap
    // broadcasts the fenced frame and spawns the noop watcher, then the
    // failure-truth READS the fenced snapshot and PARKS between the read
    // and its send (the deterministic mid-window hold — the PARKED flag
    // is the positive signal the snapshot read already happened).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !hooks
        .pause_in_failure_truth_parked
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the runner never reached its parked failure broadcast"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // MID-WINDOW: the detached noop watcher resolves (its confirmation
    // lands), releases the fence, and broadcasts `released` — BEFORE the
    // parked failure send.
    let frames = await_owner_frames(&mut rig.rx, &["released"]).await;
    let released = runtime_owner_frame(&frames, "released");
    assert_eq!(
        released["ownerKind"],
        json!("vacant"),
        "the watcher's released frame names the vacancy: {frames:?}"
    );
    assert_eq!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant,
        "the watcher released the fence mid-window — the server is vacant"
    );

    // Release the parked send: the (now-stale) failure frame goes out
    // AFTER the corrective `released` frame.
    failure_park.notify_one();
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("STALE_GENERATION"),
        "the typed stale-commit failure answers: {result}"
    );
    // b8ke ext r34 F1: the stale-commit's STALE_GENERATION is RETRYABLE
    // from the ACTUAL handler output — the message says the caller
    // refreshes and retries (pre-r34 the flag was false and the banner
    // rendered no action).
    assert_eq!(
        result["error"]["retryable"],
        json!(true),
        "STALE_GENERATION carries retryable: true from the handler: {result}"
    );

    // THE e4r2 F3 CONTRACT: the FINAL frame the client folds reflects the
    // server's ACTUAL (vacant) state — the corrective frame for the
    // resolved state postcedes the stale failure frame (pre-e4r2 the
    // stale fenced frame was the final client state).
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let final_frame = frames.last().expect("at least one frame");
    assert_ne!(
        final_frame["fenced"],
        json!(true),
        "the final frame must not be the stale fenced failure — frames: {frames:?}"
    );
    assert_eq!(
        final_frame["ownerKind"],
        json!("vacant"),
        "the final frame reflects the watcher-released vacant state — \
         frames: {frames:?}"
    );

    // Cleanup: reap the spawned target the forced-timeout path left
    // running.
    rig.registry.kill(&target_terminal);
}

/// b8ke e4r3 F1: the sync-abort path's queued authoritative broadcast is
/// ORDERED with the failed transition — a lifecycle request on another
/// device claims and commits the NEXT generation while the queued task
/// waits, and the task must REFUSE to publish over the moved-on record
/// (pre-e4r3 it observed the NEW Live state and stamped the OLD
/// operation's RUNNER_ABORTED/handoff-failed frame with the NEW
/// generation — the client folds every same-generation frame, so the
/// stale abort frame overwrote the committed owner's handoff-committed
/// transition and opposite-kind panes stayed at "being reopened
/// elsewhere" with the attach action suppressed until reconnect).
#[tokio::test]
async fn a_foreign_commit_during_the_abort_broadcast_window_is_never_overwritten() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let abort_broadcast_pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        pause_post_abort_broadcast: Some(Arc::clone(&abort_broadcast_pause)),
        pause_post_abort_broadcast_once: std::sync::atomic::AtomicBool::new(true),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // Handoff 1 parks right after the coordinator enter. The abort lands
    // in the sync-unwind window (nothing spawned, no kill in flight): the
    // Drop fails the record — restoring the prior at the handoff's
    // generation — and queues the authoritative broadcast, which PARKS at
    // its entry (before its snapshot observe).
    let first = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let _ = await_owner_frames(&mut rig.rx, &["handoff-started"]).await;
    first.abort();
    let _ = first.task.await;
    await_cond("the queued abort broadcast must park at its entry", || {
        hooks
            .pause_post_abort_broadcast_parked
            .load(std::sync::atomic::Ordering::SeqCst)
    })
    .await;
    let abort_generation = {
        let snap = rig.ownership.observe("claude", &sid);
        assert!(
            matches!(snap.state, OwnershipState::Live { .. }),
            "the sync abort must restore the untouched prior — got {:?}",
            snap.state
        );
        snap.generation
    };

    // ANOTHER DEVICE's lifecycle request claims and commits the NEXT
    // generation while the abort broadcast waits: the enter permit lets
    // handoff 2 pass the enter, reap the prior, spawn the terminal
    // target, and commit handoff-committed.
    hooks
        .pause_after_enter
        .as_ref()
        .expect("the enter pause is armed")
        .notify_one();
    let second = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let frames = await_owner_frames(&mut rig.rx, &["handoff-committed"]).await;
    let committed = runtime_owner_frame(&frames, "handoff-committed");
    assert_eq!(
        committed["generation"],
        json!(abort_generation + 1),
        "the foreign handoff committed the NEXT generation: {frames:?}"
    );
    let committed_terminal = committed["terminalId"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    // Release the queued abort broadcast. THE CONTRACT: the committed
    // owner's handoff-committed frame is the FINAL frame — no stale abort
    // frame stamped with the new generation (pre-e4r3 the stale
    // RUNNER_ABORTED/handoff-failed frame postceded and overwrote it).
    abort_broadcast_pause.notify_one();
    let result = second.completion.await.expect("handoff 2 completed");
    assert_eq!(result["ok"], json!(true), "handoff 2 commits: {result}");
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    // The frames AFTER the release: the queued abort broadcast must have
    // published NOTHING over the moved-on record.
    let new_frames = drain_runtime_owner_frames(&mut rig.rx);
    assert!(
        !new_frames.iter().any(|f| {
            f["transition"] == json!("handoff-failed")
                && f["reason"] == json!("RUNNER_ABORTED")
                && f["generation"] == json!(abort_generation + 1)
        }),
        "no stale abort frame is stamped with the committed owner's \
         generation: {new_frames:?}"
    );
    // THE FINAL-frame contract: the committed owner's handoff-committed
    // frame is the client's final state.
    let mut all_frames = frames;
    all_frames.extend(new_frames);
    let final_frame = all_frames.last().expect("at least one frame");
    assert_eq!(
        final_frame["transition"],
        json!("handoff-committed"),
        "the committed owner's handoff-committed frame is the final one — \
         the queued abort broadcast refused to publish over the moved-on \
         record: {all_frames:?}"
    );
    assert_eq!(
        final_frame["generation"],
        json!(abort_generation + 1),
        "the final frame rides the committed owner's generation: {all_frames:?}"
    );

    // Cleanup: reap the committed terminal.
    rig.registry.kill(&committed_terminal);
}

/// b8ke e4 post-cap F1: the uncommitted-target reap's terminal arm
/// confirms death on the recorded pid's OS-LEVEL death — NEVER the
/// registry kill's return. kill_internal removes the row BEFORE
/// signaling/reaping the PTY, so a CONCURRENT kill can own the removed
/// row while the process lives: a kill() answering false ("no row") was
/// classified as the confirmed reap and the callers vacated the key —
/// another writer before the first kill's reap confirmed. The
/// row-removed-but-pid-alive window fences typed unconfirmed (the
/// detached watcher resolves it on the pid's death); the confirmed
/// pid-death path still reaps.
#[tokio::test]
async fn the_uncommitted_target_reap_never_confirms_on_a_missing_row() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // A SHORT reap budget: the pid-alive window deterministically fences
    // within the test instead of waiting the production budget.
    let rig = build_rig_inner(None, None, None, 50, None, false, None, None);
    // The target's stand-in process: ALIVE, its registry row ABSENT —
    // the exact row-removed-but-not-yet-reaped shape a concurrent kill
    // produces.
    let mut target = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn the uncommitted target's stand-in");
    let target_pid = target.id();
    let absent_tid = "T-e4pc-f1-absent";
    assert!(
        rig.registry.terminal_is_dead(absent_tid),
        "precondition: the recorded pane's row is absent"
    );
    assert!(
        freshell_terminal::registry::pid_alive(target_pid),
        "precondition: the recorded runtime still lives"
    );
    let live_owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(absent_tid.to_string()),
        live_session_key: None,
        pid: Some(target_pid),
        ownership_id: None,
    };

    // THE WINDOW: kill() answers false (the row is gone) while the pid
    // lives — pre-post-cap the arm answered Reaped (the row's absence
    // misread as the confirmed reap) and the callers vacated over the
    // still-live target.
    let outcome = rig
        .runner
        .reap_uncommitted_target(
            &handoff_req_terminal("claude", &sid, "claude"),
            &live_owner,
            "op-e4pc-f1",
            1,
        )
        .await;
    assert!(
        matches!(
            outcome,
            super::StopOutcomePriv::ReapTimeout { fenced: true }
        ),
        "the row-removed-but-pid-alive window fences typed unconfirmed — \
         got {outcome:?}"
    );

    // The confirmed pid-death path still reaps: the stand-in dies (and
    // is reaped — a zombie still answers kill(pid, 0)), then the same
    // absent-row shape confirms through the pid.
    target.kill().expect("SIGKILL the stand-in");
    let _ = target.wait().expect("reap the stand-in");
    assert!(
        !freshell_terminal::registry::pid_alive(target_pid),
        "precondition: the recorded runtime is confirmed dead"
    );
    let dead_owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(absent_tid.to_string()),
        live_session_key: None,
        pid: Some(target_pid),
        ownership_id: None,
    };
    let outcome = rig
        .runner
        .reap_uncommitted_target(
            &handoff_req_terminal("claude", &sid, "claude"),
            &dead_owner,
            "op-e4pc-f1-dead",
            2,
        )
        .await;
    assert!(
        matches!(outcome, super::StopOutcomePriv::Reaped),
        "the confirmed pid-death path still reaps — got {outcome:?}"
    );
}

/// b8ke e4r1 F1 control: a CONFIRMED target reap (the key truly ends
/// Vacant) still broadcasts the truthful vacancy — the fix tightens the
/// fenced/in-progress conversion, never the honest one. The done outcome
/// keeps the truthful flavor_write_failed_target_reaped label.
#[tokio::test]
async fn the_confirmed_reap_flavor_failure_broadcasts_the_truthful_vacancy() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let (sink, _capture_guard) = tracing_capture::capture();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_flavor_writer(Arc::new(FailingFlavorWriter));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure answers: {result}"
    );
    await_cond("the confirmed reap must vacate the key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // The LAST handoff-failed frame is the truthful vacancy (the record IS
    // Vacant — the only shape the vacant conversion is honest for).
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let last_failed = last_handoff_failed_frame(&frames);
    assert_eq!(
        last_failed["ownerKind"],
        json!("vacant"),
        "the confirmed-reap failure broadcasts the truthful vacancy: {frames:?}"
    );
    assert_eq!(
        last_failed["reason"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the confirmed-reap failure carries the typed failure reason: {frames:?}"
    );

    // e4r1 F2: the confirmed reap keeps the truthful "reaped" label.
    let events = sink.lock().expect("capture lock").clone();
    let done_outcomes: Vec<&str> = events
        .iter()
        .filter(|e| e.target == "freshell_ownership" && e.event == "ownership.handoff.done")
        .filter_map(|e| e.fields.get("outcome").map(String::as_str))
        .collect();
    assert!(
        done_outcomes.contains(&"flavor_write_failed_target_reaped"),
        "the confirmed-reap flavor failure's done outcome keeps the \
         truthful flavor_write_failed_target_reaped — got {done_outcomes:?}"
    );
}

/// b8ke e4r2 F1: an abort landing in the FLAVOR WINDOW (the fresh target
/// RETURNED; the write is parked) whose FIRST target teardown is
/// UNCONFIRMED (a fenced reap timeout — the kill's confirmation runs
/// detached) must CONSUME that outcome: the abort fences typed (the
/// confirmation watcher owns the resolution), never vacates. Pre-e4r2
/// the discarded outcome fell through to the SECOND lane kill — its
/// AlreadyGone/Reaped answer was converted to a confirmed reap and
/// `abort_cleanup` VACATED while the first teardown was unconfirmed
/// (a competing lifecycle request could start a second writer).
/// b8ke ext r28 F4: the cancellation-atomicity driver — a fake whose
/// STAGE performs the durable-mutation precursor (the temp write,
/// modeled by the `staged_tmp` log) and THEN blocks, so the abort
/// lands with the precursor done but NOTHING promoted (the `durable`
/// log — the rename model — must stay empty). Pre-r28 the single-phase
/// write performed the durable mutation before its park, so an abort in
/// that interval left the persisted flavor naming the TARGET kind over
/// a reaped/fenced target: restart recovery could select a runtime kind
/// that never became owner.
struct TwoPhaseProbeFlavorWriter {
    staged_tmp: FlavorWriteLog,
    durable: FlavorWriteLog,
    release: Arc<tokio::sync::Notify>,
    reached: Arc<std::sync::atomic::AtomicBool>,
}

struct StagedTwoPhaseProbe {
    durable: FlavorWriteLog,
    entry: (String, String, String),
}

impl crate::session_handoff::StagedFlavor for StagedTwoPhaseProbe {
    fn commit(
        self: Box<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        self.durable
            .lock()
            .expect("durable flavor log lock")
            .push(self.entry);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl crate::session_handoff::FlavorWrite for TwoPhaseProbeFlavorWriter {
    fn stage(
        &self,
        provider: &str,
        session_id: &str,
        flavor: &str,
    ) -> crate::session_handoff::StagedFlavorFuture {
        // Perform the durable-mutation precursor and THEN block — the
        // reviewer's exact reshaped shape (pre-r28 the fake blocked BEFORE
        // performing any durable mutation, so the mismatch was
        // untestable).
        self.staged_tmp.lock().expect("staged tmp log lock").push((
            provider.to_string(),
            session_id.to_string(),
            flavor.to_string(),
        ));
        self.reached
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let release = Arc::clone(&self.release);
        let durable = Arc::clone(&self.durable);
        let entry = (
            provider.to_string(),
            session_id.to_string(),
            flavor.to_string(),
        );
        Box::pin(async move {
            let _ = release.notified().await;
            let staged: Box<dyn crate::session_handoff::StagedFlavor> =
                Box::new(StagedTwoPhaseProbe { durable, entry });
            Ok(Some(staged))
        })
    }
}

/// b8ke ext r28 F4: an abort AFTER the staged flavor precursor but
/// BEFORE the Live(targetKind) commit NEVER persists the target flavor —
/// the durable mutation is the staged handle's commit, which the abort
/// drops (restart recovery can never select a runtime kind that never
/// became owner); the guard's cleanup still fences/restores ownership
/// exactly as before.
#[tokio::test]
async fn an_abort_after_the_staged_flavor_precursor_never_persists_the_target_flavor() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let store_dir =
        std::env::temp_dir().join(format!("freshell-r28-f4-store-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let staged_tmp: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    let durable: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    let release = Arc::new(tokio::sync::Notify::new());
    let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut rig = build_rig_inner(
        None,
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(TwoPhaseProbeFlavorWriter {
            staged_tmp: Arc::clone(&staged_tmp),
            durable: Arc::clone(&durable),
            release: Arc::clone(&release),
            reached: Arc::clone(&reached),
        })),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // The handoff to a terminal target stages its flavor (the precursor
    // lands) and parks BEFORE the staged handle returns.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let HandoffHandle {
        mut completion,
        task,
    } = handle;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            result = &mut completion => {
                panic!("the handoff failed before its flavor stage: {result:?}");
            }
        }
        if reached.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the handoff never reached its flavor stage"
        );
    }
    assert_eq!(
        staged_tmp.lock().expect("staged tmp log lock").len(),
        1,
        "fixture: the durable-mutation precursor RAN (the window is real)"
    );

    // ABORT inside the stage park — after the precursor, before the
    // commit. The guard's cleanup runs (ownership settles), and the
    // staged handle is dropped with the task: NOTHING is promoted.
    task.abort();
    let _ = task.await;

    // THE r28 F4 CONTRACT: the durable log is EMPTY — the target flavor
    // was never renamed into place, so restart recovery never selects a
    // runtime kind that never became owner. (Pre-r28 the single-phase
    // write had already performed the durable mutation before its park —
    // the reshaped fake proves the rollback/atomicity, not a pre-mutation
    // park.)
    assert_eq!(
        durable.lock().expect("durable flavor log lock").len(),
        0,
        "the aborted handoff persisted NO target flavor"
    );
    // The precursor did run — the suppression is the atomicity, not a
    // stage that never reached its write.
    assert_eq!(
        staged_tmp.lock().expect("staged tmp log lock").len(),
        1,
        "the precursor ran and was abandoned (never promoted)"
    );

    // Ownership settles to the typed recoverable state exactly as the
    // pre-r28 abort contract demands (the prior was reaped; the target
    // was spawned — the guard's cleanup fences, never vacates over an
    // unconfirmed target).
    await_cond("the aborted handoff must settle (fenced)", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced { .. } | OwnershipState::Vacant
        )
    })
    .await;
    // Release the parked stage (its task is gone; the notify is inert —
    // drop the permit so the test's runtime winds down cleanly).
    release.notify_one();

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
    let _ = _env;
}

#[tokio::test]
async fn an_abort_in_the_flavor_window_with_an_unconfirmed_target_teardown_fences_not_vacates() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // The claude-lane resume gates on transcript presence (the 6b pattern)
    // — the fresh TARGET's resume needs the fake transcript.
    let store_dir =
        std::env::temp_dir().join(format!("freshell-e4r2-f1-store-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);
    let hooks = Arc::new(HandoffTestHooks::default());
    // The PRIOR stop consumes the skip; the post-spawn abort's FIRST
    // teardown is forced to the fenced timeout (kill issued, confirmation
    // detached — the noop watcher owns the resolution).
    hooks
        .force_reap_timeout_fenced
        .store(true, std::sync::atomic::Ordering::SeqCst);
    hooks
        .force_reap_timeout_fenced_skip
        .store(1, std::sync::atomic::Ordering::SeqCst);
    // A BLOCKING flavor writer parks the write — the abort window (the
    // fresh target has returned, so the guard's target_runtime is set).
    let release = Arc::new(tokio::sync::Notify::new());
    let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let log: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut rig = build_rig_inner(
        Some(Arc::clone(&hooks) as Arc<HandoffTestHooks>),
        None,
        None,
        10_000,
        None,
        false,
        Some(Arc::new(BlockingFlavorWriter {
            log: Arc::clone(&log),
            release: Arc::clone(&release),
            reached: Arc::clone(&reached),
        })),
        None,
    );
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // A handoff to a FRESH target (the reviewer's scenario) parks inside
    // its awaited flavor write.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    let HandoffHandle {
        mut completion,
        task,
    } = handle;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            result = &mut completion => {
                panic!(
                    "the fresh-target handoff failed before the flavor \
                     write: {result:?}"
                );
            }
        }
        if reached.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the handoff never reached its flavor write"
        );
    }

    // Abort inside the write await — the guard's detached cleanup runs
    // the post-spawn target reap.
    task.abort();
    let _ = task.await;

    // THE e4r2 F1 CONTRACT: the first teardown's unconfirmed outcome is
    // CONSUMED — the key fences typed, never vacates over the
    // unconfirmed target (pre-e4r2: the second lane kill's answer
    // vacated the key).
    await_cond("the aborted handoff must fence (never vacate)", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced { .. }
        )
    })
    .await;
    // New claims stay BLOCKED (no second writer over the unconfirmed
    // target).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "op-second-writer-e4r2",
            None,
            "test",
            0,
        ),
        freshell_ownership::BeginOutcome::Blocked { .. }
    ));
    // The detached confirmation watcher owns the resolution: once its
    // confirmation lands the fence releases to Vacant (recoverable, not
    // wedged).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant
    ) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the confirmation watcher never resolved the fence — state: {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// b8ke e3r2 F3: a FAILING flavor writer — the failure surfaces as the
/// TYPED handoff failure (SESSION_METADATA_WRITE_FAILED), never a
/// log-only success; the spawned target is reaped and the key ends Vacant
/// (the prior was reaped; a dead runtime is never restored Live).
struct FailingFlavorWriter;

impl crate::session_handoff::FlavorWrite for FailingFlavorWriter {
    fn stage(
        &self,
        _provider: &str,
        _session_id: &str,
        _flavor: &str,
    ) -> crate::session_handoff::StagedFlavorFuture {
        Box::pin(std::future::ready(Err(
            "metadata store write failed (test)".to_string(),
        )))
    }
}

/// b8ke e3r2 F3: a BLOCKING writer — parks inside the STAGE until released
/// (the generation-order/abort-window tests' hold). b8ke ext r28 F4:
/// TWO-PHASE — the log entry lands at the staged handle's COMMIT.
struct BlockingFlavorWriter {
    log: FlavorWriteLog,
    release: Arc<tokio::sync::Notify>,
    reached: Arc<std::sync::atomic::AtomicBool>,
}

struct StagedLoggingFlavor {
    log: FlavorWriteLog,
    entry: (String, String, String),
}

impl crate::session_handoff::StagedFlavor for StagedLoggingFlavor {
    fn commit(
        self: Box<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        self.log.lock().expect("flavor log lock").push(self.entry);
        Box::pin(std::future::ready(Ok(())))
    }
}

impl crate::session_handoff::FlavorWrite for BlockingFlavorWriter {
    fn stage(
        &self,
        provider: &str,
        session_id: &str,
        flavor: &str,
    ) -> crate::session_handoff::StagedFlavorFuture {
        self.reached
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let release = Arc::clone(&self.release);
        let log = Arc::clone(&self.log);
        let entry = (
            provider.to_string(),
            session_id.to_string(),
            flavor.to_string(),
        );
        Box::pin(async move {
            let _ = release.notified().await;
            let staged: Box<dyn crate::session_handoff::StagedFlavor> =
                Box::new(StagedLoggingFlavor { log, entry });
            Ok(Some(staged))
        })
    }
}

#[tokio::test]
async fn a_flavor_write_failure_surfaces_as_the_typed_handoff_failure() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_flavor_writer(Arc::new(FailingFlavorWriter));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    // THE TYPED FAILURE (never log-only success; the runtime switch is
    // unwound — the spawned target reaped, the key not left committed).
    assert_eq!(result["ok"], json!(false), "the failure surfaces: {result}");
    assert_eq!(
        result["error"]["code"],
        json!("SESSION_METADATA_WRITE_FAILED"),
        "the typed failure code: {result}"
    );
    assert_eq!(result["error"]["retryable"], json!(true));
    // The key ends Vacant (the prior was reaped; the uncommitted target
    // was reaped — never a dead runtime recorded Live).
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant
    ));
}

#[tokio::test]
async fn the_flavor_write_serializes_consecutive_handoffs_in_generation_order() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let release = Arc::new(tokio::sync::Notify::new());
    let reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let log: FlavorWriteLog = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut rig = build_rig_with_flavor_writer(Arc::new(BlockingFlavorWriter {
        log: Arc::clone(&log),
        release: Arc::clone(&release),
        reached: Arc::clone(&reached),
    }));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // Handoff A parks INSIDE its awaited flavor write (the record is
    // still Handoff — the write precedes the owner commit).
    let handle_a = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while !reached.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "handoff A never reached its flavor write"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // Handoff B CANNOT begin while A's write is in flight — the
    // coordinator's own generation discipline blocks it (pre-e3r2 the
    // detached post-commit write let B proceed and its flavor could land
    // before A's).
    // b8ke ext r28 F4 reshape: NOTHING durable has landed while A's stage
    // is parked — the rename waits for the owner commit (the pre-r28
    // single-phase writer recorded A's flavor here, pre-park).
    assert_eq!(
        log.lock().expect("flavor log lock").len(),
        0,
        "A's flavor is staged but NOT durably landed (the rename waits for \
         the Live commit) and B's has NOT landed"
    );
    let handle_b = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // B answers while A is still parked: the HANDOFF_IN_PROGRESS refusal.
    let result_b = tokio::time::timeout(std::time::Duration::from_secs(5), handle_b.completion)
        .await
        .expect("B answered while A's write is in flight")
        .expect("B's completion channel survived");
    assert_eq!(
        result_b["error"]["code"],
        json!("HANDOFF_IN_PROGRESS"),
        "B cannot begin until A's flavor write completes: {result_b}"
    );

    // Release A: its write completes, its owner commits — and ONLY THEN
    // could any later handoff begin (its flavor would land after A's; a
    // detached out-of-generation overwrite is impossible by construction).
    release.notify_one();
    let result_a = handle_a.completion.await.expect("A completed");
    assert_eq!(result_a["ok"], json!(true), "A commits: {result_a}");

    let flavors = log.lock().expect("flavor log lock").clone();
    assert_eq!(
        flavors,
        vec![("claude".to_string(), sid.clone(), "claude".to_string())],
        "exactly A's flavor write landed — B's was refused before any write \
         (the generation order holds: no later handoff's write can precede \
         an in-flight one)"
    );
}

/// b8ke e3r1 F4: the handoff COMMIT writes the durable flavor SERVER-SIDE
/// (inside the atomic transition). The recording writer observes exactly
/// (provider, session, flavor) — the TARGET's flavor, once, at the commit.
/// Pre-e3r1 the client performed a separate unversioned POST after the
/// reply (cross-device out-of-order overwrites; log-only failure).
#[tokio::test]
async fn the_handoff_commit_writes_the_durable_flavor_server_side() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(None);
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // The handoff to the CLI terminal commits; the flavor recorded is the
    // TERMINAL target's mode ("claude" — the CLI flavor).
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["ok"], json!(true), "the handoff commits: {result}");

    let flavors = rig.flavor_log.lock().expect("flavor log lock").clone();
    assert_eq!(
        flavors,
        vec![("claude".to_string(), sid.clone(), "claude".to_string())],
        "the commit recorded the TARGET's flavor exactly once — the \
         server-atomic durable write (no client POST exists)"
    );
}

/// b8ke delta round-3 F5: a STALE-START fence recovers through the SAME
/// acknowledged operator force-clear. The coordinator's force-release API
/// accepts PlatformLimited AND StaleStart (the registry's docs name
/// PID-less OpenCode starts as the production case that otherwise stays
/// fenced until restart), but pre-d3 the runner's force-release branch
/// matched PlatformLimited only — a StaleStart fence fell to generic
/// HANDOFF_IN_PROGRESS even with the acknowledgment flag set, permanently
/// wedging the documented recoverable state through the lifecycle API.
/// The four-phase contract:
///   (a) an ordinary retry is the typed STALE_START_FENCED refusal and
///       the key STAYS fenced;
///   (b) b8ke ext r25 F1(b): the acknowledged force-clear accepts the
///       stale reasons — the TYPED CLEAR answer, the key lands
///       Fenced{ClearedUnverified} (never plain Vacant), the clear
///       STOPS AT THE CLEAR (no owner committed, no handoff started),
///       and the cleared state is broadcast;
///   (c) an UNACKNOWLEDGED retry on the cleared-unverified key refuses
///       typed (the start requires the acknowledged-risk arm);
///   (d) the acknowledged retry enters Handoff atomically over the
///       cleared-unverified state (the ONE atomic acknowledged start)
///       and the handoff proceeds fresh (the no-prior sequence).
#[tokio::test]
async fn a_stale_start_fence_recovers_through_the_acknowledged_force_clear() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_options(None, None, None, 8_000, None, true);

    // Arm a StaleStart fence on the key (the watchdog's own shape): a
    // stale Starting record recovered + fenced with the typed reason.
    let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_start(
        "claude",
        &sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-stale-arm",
        None,
        "test",
        0,
    ) else {
        panic!("expected Granted")
    };
    let _ = generation;
    let recovered = rig.ownership.recover_stale_starts(0, 0);
    assert_eq!(recovered.len(), 1);
    let rec = recovered.into_iter().next().unwrap();
    assert!(matches!(
        rig.ownership.fence_unconfirmed_stop(
            "claude",
            &sid,
            &rec.operation_id,
            rec.generation,
            freshell_ownership::FenceReason::StaleStart,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // (a) An ordinary retry: the typed STALE_START_FENCED refusal, the
    // fence HELD (pre-d3 this fell to generic HANDOFF_IN_PROGRESS).
    let ordinary = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let ordinary_result = ordinary.completion.await.expect("retry completed");
    assert_eq!(
        ordinary_result["error"]["code"],
        json!("STALE_START_FENCED"),
        "an ordinary retry against a StaleStart fence answers the typed refusal: {ordinary_result}"
    );
    assert_eq!(ordinary_result["error"]["retryable"], json!(true));
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced { .. }
        ),
        "the ordinary retry left the fence held"
    );

    // (b) b8ke ext r25 F1(b): the acknowledged force-clear now ACCEPTS the
    // stale reasons — the operator escape through the EXISTING r16-F4
    // cleared-unverified pipeline (pre-r25 the flag answered the same
    // typed refusal and a stale fence whose provider evidence was gone
    // was PERMANENT). The clear STOPS AT THE CLEAR: the typed clear
    // answer, the key lands Fenced{ClearedUnverified} (never plain
    // Vacant), no owner committed, no handoff started.
    let _ = drain_runtime_owner_frames(&mut rig.rx);
    let snap = rig.ownership.observe("claude", &sid);
    let mut clear_req = handoff_req_terminal("claude", &sid, "claude");
    clear_req.action = HandoffAction::ClearStaleBookkeeping;
    clear_req.observed_epoch = Some(snap.epoch);
    clear_req.observed_generation = Some(snap.generation);
    let clear = rig.runner.spawn_handoff(clear_req);
    let cleared = clear
        .completion
        .await
        .expect("the acknowledged request completed");
    assert_eq!(
        cleared["ok"],
        json!(true),
        "the acknowledged force-clear answers the typed clear: {cleared}"
    );
    assert_eq!(
        cleared["cleared"],
        json!("stale-start-fence"),
        "the typed clear names the stale-start fence: {cleared}"
    );
    assert!(
        cleared.get("owner").is_none(),
        "the typed clear is NOT a handoff success — no owner is committed"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ),
        "the clear lands the TYPED cleared-unverified state — never plain Vacant"
    );
    // b8ke ext r28 F1: the clear's broadcast carries the AUTHORITATIVE
    // post-clear state — the FENCED truth (Fenced{ClearedUnverified}),
    // never a bare "released"/vacant frame. This stale-START fence retains
    // a VACANT prior (the R4-7 fenced-vacant shape), so the frame names
    // "vacant" WITH the fenced marker + reason — the client's fenced
    // branch (which precedes the vacant early-return) renders the typed
    // recovery card from the marker, never an available session.
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let cleared_frame = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        cleared_frame["ownerKind"],
        json!("vacant"),
        "the fenced frame names the retained VACANT prior's kind: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["fenced"],
        json!(true),
        "the fenced marker rides the clear's broadcast: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["reason"],
        json!("cleared-unverified"),
        "the frame carries the authoritative fence's typed wire reason: {cleared_frame}"
    );

    // (c) An UNACKNOWLEDGED retry on the cleared-unverified key answers
    // the typed refusal — the start requires the acknowledged-risk arm.
    let snap = rig.ownership.observe("claude", &sid);
    let mut naive = handoff_req_terminal("claude", &sid, "claude");
    naive.observed_epoch = Some(snap.epoch);
    naive.observed_generation = Some(snap.generation);
    let naive_handle = rig.runner.spawn_handoff(naive);
    let naive_result = naive_handle
        .completion
        .await
        .expect("naive retry completed");
    assert_eq!(
        naive_result["error"]["code"],
        json!("CLEARED_UNVERIFIED_FENCED"),
        "an unacknowledged start on the cleared-unverified key refuses typed: {naive_result}"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ),
        "the naive retry left the cleared-unverified state held"
    );

    // (d) THE ACKNOWLEDGED START: the retry carrying the flag enters
    // Handoff atomically over the cleared-unverified state (the ONE
    // atomic acknowledged start) and the handoff proceeds fresh (the
    // no-prior sequence) — the terminal owner commits.
    let _ = drain_runtime_owner_frames(&mut rig.rx);
    let snap = rig.ownership.observe("claude", &sid);
    let mut start_req = handoff_req_terminal("claude", &sid, "claude");
    start_req.action = HandoffAction::StopAndReopen;
    start_req.observed_epoch = Some(snap.epoch);
    start_req.observed_generation = Some(snap.generation);
    let start = rig.runner.spawn_handoff(start_req);
    let started = start
        .completion
        .await
        .expect("acknowledged start completed");
    assert_eq!(
        started["ok"],
        json!(true),
        "the acknowledged start proceeds over the cleared-unverified state: {started}"
    );
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Live { owner, .. }
                if owner.kind == RuntimeOwnerKind::Terminal
        ),
        "the acknowledged start committed the terminal owner"
    );
}

/// 3k. b8ke focused round-3 review R3-4, redesigned by the round-4 R4-4
/// review: a PlatformLimited fence recovers ONLY through the EXPLICIT
/// acknowledged operator force-clear — an ORDINARY retry (even with a
/// fresh observed fence) never clears it (pre-R4-4, the observed-fence
/// retry force-cleared AND re-entered handoff in one step, licensing a
/// new writer while the prior's descendant tree was unverified). The
/// three-phase contract:
///   (a) an ordinary retry is the typed PLATFORM_LIMITED_FENCED refusal
///       and the key STAYS fenced;
///   (b) the acknowledged force-clear (acknowledgePlatformLimitedRisk)
///       clears the key Vacant, answers the TYPED CLEAR (never a handoff
///       success — no owner is committed), and broadcasts the cleared
///       state;
///   (c) a subsequent EXPLICIT handoff proceeds as a fresh no-prior
///       sequence (the prior is Vacant — nothing to reap; the unverified
///       descendants are the operator's acknowledged risk).
#[tokio::test]
async fn a_platform_limited_fence_recovers_only_through_the_acknowledged_force_clear() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_options(None, None, None, 8_000, None, true);
    establish_fresh_claude_owner(&mut rig, &sid).await;
    // Consume the establish-time frames so the recovery window is isolated.
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // Fence the key PlatformLimited (the 3i shape).
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("PLATFORM_LIMITED"));
    let snap = rig.ownership.observe("claude", &sid);
    assert!(matches!(
        snap.state,
        OwnershipState::Fenced {
            reason: FenceReason::PlatformLimited,
            ..
        }
    ));

    // (a) THE R4-4 regression: an ORDINARY retry — even carrying the
    // FRESH observed fence pair — must NOT force-clear. Pre-fix, this
    // retry cleared the fence and started the terminal writer in one
    // step over an unverified descendant tree.
    let mut ordinary = handoff_req_terminal("claude", &sid, "claude");
    ordinary.observed_epoch = Some(snap.epoch);
    ordinary.observed_generation = Some(snap.generation);
    let ordinary_retry = rig.runner.spawn_handoff(ordinary);
    let ordinary_result = ordinary_retry.completion.await.expect("retry completed");
    assert_eq!(
        ordinary_result["error"]["code"],
        json!("PLATFORM_LIMITED_FENCED"),
        "an ordinary retry must not force-clear: {ordinary_result}"
    );
    assert_eq!(ordinary_result["error"]["retryable"], json!(true));
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced { .. }
        ),
        "the ordinary retry left the fence held"
    );
    // A fence-less ordinary retry answers the same typed refusal.
    let fenceless = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let fenceless_retry = fenceless.completion.await.expect("retry completed");
    assert_eq!(
        fenceless_retry["error"]["code"],
        json!("PLATFORM_LIMITED_FENCED"),
        "a fence-less ordinary retry must not force-clear: {fenceless_retry}"
    );

    // (b) THE acknowledged force-clear: clears the key Vacant, answers
    // the TYPED CLEAR — never a handoff success (no owner committed, no
    // handoff-started frame) — and broadcasts the cleared state so every
    // device converges.
    let _ = drain_runtime_owner_frames(&mut rig.rx);
    let mut clear_req = handoff_req_terminal("claude", &sid, "claude");
    clear_req.action = HandoffAction::ClearStaleBookkeeping;
    clear_req.observed_epoch = Some(snap.epoch);
    clear_req.observed_generation = Some(snap.generation);
    let clear = rig.runner.spawn_handoff(clear_req);
    let cleared = clear.completion.await.expect("force-clear completed");
    assert_eq!(
        cleared["ok"],
        json!(true),
        "the acknowledged force-clear answers the typed clear: {cleared}"
    );
    assert_eq!(cleared["cleared"], json!("platform-limited-fence"));
    assert!(
        cleared.get("owner").is_none(),
        "the typed clear is NOT a handoff success — no owner is committed"
    );
    match rig.ownership.observe("claude", &sid).state {
        // b8ke ext r16 F4: the force-clear lands in the TYPED
        // cleared-unverified state — never plain Vacant (the clear is
        // not permission to start a writer over the unverified tree).
        OwnershipState::Fenced {
            reason: FenceReason::ClearedUnverified,
            ..
        } => {}
        other => panic!("the force-clear must leave the key cleared-unverified, got {other:?}"),
    }
    // No handoff-started frame rode the clear (no handoff ran), and the
    // clear's broadcast carries the AUTHORITATIVE post-clear state — the
    // FENCED truth: the key is Fenced{ClearedUnverified} (the r16-F4
    // pipeline), so the frame names the retained prior's kind with the
    // fenced marker and the cleared-unverified wire reason. b8ke ext r28
    // F1: pre-r28 this emitted a bare "released"/vacant frame, which
    // online panes folded as an AVAILABLE session — discarding the
    // required recovery state while the coordinator still refused
    // ordinary starts (the reconnect replay then flipped the UI back to
    // the fence).
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let cleared_frame = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        cleared_frame["ownerKind"],
        json!("fresh-agent"),
        "the fenced frame names the retained prior's kind: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["fenced"],
        json!(true),
        "the fenced marker rides the clear's broadcast: {cleared_frame}"
    );
    assert_eq!(
        cleared_frame["reason"],
        json!("cleared-unverified"),
        "the frame carries the authoritative fence's typed wire reason: {cleared_frame}"
    );
    assert!(
        !frames.iter().any(|f| f["transition"] == "handoff-started"),
        "the force-clear path must not re-enter handoff: {frames:?}"
    );

    // b8ke ext r12 F1: THE CLEAR STOPS AT THE CLEAR — the typed clear
    // answer carries NO retry semantics (no owner, no handoff chain): the
    // server never re-enters handoff from the force-clear path, and the
    // recovery ends HERE (the client surfaces the cleared state; an
    // explicit user action re-initiates the handoff as any NEW request —
    // see a_post_clear_user_initiated_handoff_proceeds_fresh below).
    let cleared_response_keys: Vec<String> = cleared
        .as_object()
        .expect("the typed clear is a JSON object")
        .keys()
        .cloned()
        .collect();
    assert!(
        !cleared_response_keys.iter().any(|k| k.contains("retry")),
        "the typed clear carries no retry instruction: {cleared}"
    );
    assert!(
        cleared.get("owner").is_none() && cleared.get("ok").is_some(),
        "the typed clear is NOT a handoff success — no owner is committed: {cleared}"
    );

    // The limitation was recorded honestly: the force-clear's log names
    // the platform limitation and the operator's acknowledgment (the
    // registry's own force_released line + the runner's acknowledgment
    // line; the behavioral outcome above is the proof — no log capture is
    // needed here).
}

/// b8ke ext r16 F4: the acknowledged PlatformLimited clear lands in the
/// TYPED cleared-unverified state (never plain Vacant). b8ke ext r33 F1:
/// the banner-initiated "Start reopen again" handoff is the
/// FORCED-REAP-THEN-START — the acknowledged arm enters Handoff CARRYING
/// the unverified prior as the reap target (the kill must confirm before
/// any new writer); a NAIVE unacknowledged handoff on the
/// cleared-unverified key refuses typed (pre-r16 the clear landed
/// plain-Vacant, so a good-faith user following the offered recovery
/// could start a second writer beside a surviving descendant without any
/// acknowledgment; pre-r33 the acknowledged arm did the same with a
/// recorded risk-acceptance). On THIS platform-limited rig the forced
/// reap cannot confirm — the honest typed PLATFORM_LIMITED fence again.
#[tokio::test(flavor = "multi_thread")]
async fn the_cleared_unverified_state_requires_the_acknowledged_start() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig_with_options(None, None, None, 8_000, None, true);
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // Fence PlatformLimited (the 3i shape) and take the acknowledged clear.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("PLATFORM_LIMITED"));
    let snap = rig.ownership.observe("claude", &sid);
    let mut clear_req = handoff_req_terminal("claude", &sid, "claude");
    clear_req.action = HandoffAction::ClearStaleBookkeeping;
    clear_req.observed_epoch = Some(snap.epoch);
    clear_req.observed_generation = Some(snap.generation);
    let clear = rig.runner.spawn_handoff(clear_req);
    let cleared = clear.completion.await.expect("force-clear completed");
    assert_eq!(cleared["ok"], json!(true));
    assert_eq!(cleared["cleared"], json!("platform-limited-fence"));
    // THE TYPED LANDING: cleared-unverified, never plain Vacant.
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Fenced {
            reason: FenceReason::ClearedUnverified,
            ..
        }
    ));

    // THE NAIVE HANDOFF (no acknowledgment): typed refusal — the clear is
    // not permission to start a writer over the unverified tree.
    let naive = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let naive_result = naive.completion.await.expect("naive completed");
    assert_eq!(
        naive_result["error"]["code"],
        json!("CLEARED_UNVERIFIED_FENCED"),
        "the naive handoff on the cleared-unverified key refuses typed: {naive_result}"
    );
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Fenced {
            reason: FenceReason::ClearedUnverified,
            ..
        }
    ));

    // b8ke ext r33 F1: THE BANNER-INITIATED START (acknowledged) on THIS
    // platform-limited rig is the FORCED-REAP-THEN-START contract's
    // UNCONFIRMABLE half — the runner now CARRIES the unverified prior
    // as its reap target, attempts the kill, and this rig's teardown
    // STILL cannot confirm the descendant tree: the honest outcome is
    // the typed PLATFORM_LIMITED failure and the SAME fenced family
    // again (never ok:true over a possibly-live prior — pre-r33 the
    // enter discarded the prior and started a second writer here). The
    // operator can retry (the fence stays non-permanent); the confirmed-
    // kill green half is driven on the STANDARD rig in
    // `the_acknowledged_start_reaps_the_live_prior_before_the_new_writer`.
    let clear_snap = rig.ownership.observe("claude", &sid);
    let mut ack_req = handoff_req_terminal("claude", &sid, "claude");
    ack_req.action = HandoffAction::StopAndReopen;
    ack_req.observed_epoch = Some(clear_snap.epoch);
    ack_req.observed_generation = Some(clear_snap.generation);
    let retry = rig.runner.spawn_handoff(ack_req);
    let retried = retry
        .completion
        .await
        .expect("acknowledged retry completed");
    assert_eq!(
        retried["ok"],
        json!(false),
        "the acknowledged start over an unconfirmable prior answers the honest \
         typed failure — never a second writer: {retried}"
    );
    assert_eq!(
        retried["error"]["code"],
        json!("PLATFORM_LIMITED"),
        "the unconfirmable forced reap lands the typed PLATFORM_LIMITED fence: {retried}"
    );
    assert_eq!(retried["error"]["retryable"], json!(true));
    // The SAME typed fenced family again — never plain Vacant, never a
    // live second writer.
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced { reason, .. }
                if matches!(
                    reason,
                    FenceReason::PlatformLimited | FenceReason::ClearedUnverified
                )
        ),
        "the unconfirmable forced reap re-lands the typed fence: {:?}",
        rig.ownership.observe("claude", &sid).state
    );
}

/// b8ke ext r33 F1 (the GREEN half — the forced-reap-then-start on the
/// STANDARD rig): the acknowledged start over a cleared-unverified state
/// whose prior is PROVABLY ALIVE enters the handoff CARRYING the prior
/// as its reap target — the runner kills the prior sidecar (the
/// descendant tree included) and CONFIRMS death BEFORE the new writer
/// commits. Pre-r33 the enter discarded the prior: the sidecar was
/// never killed, the target spawned beside it — two live writers (the
/// exact finding).
#[tokio::test(flavor = "multi_thread")]
async fn the_acknowledged_start_reaps_the_live_prior_before_the_new_writer() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(None);
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // Seed the typed cleared-unverified state DIRECTLY on the registry —
    // the fence carries the LIVE prior (the standard rig's kill lanes can
    // confirm death, unlike the platform-limited rig's).
    let freshell_ownership::BeginOutcome::Granted {
        generation: g_fence,
    } = rig.ownership.begin_handoff(
        "claude",
        &sid,
        RuntimeOwnerKind::Terminal,
        "op-r33-seed-fence",
        None,
        "test",
        1_000,
    )
    else {
        panic!("fixture: the fence handoff must grant")
    };
    assert!(matches!(
        rig.ownership.fence_unconfirmed_handoff(
            "claude",
            &sid,
            "op-r33-seed-fence",
            g_fence,
            freshell_ownership::FenceReason::PlatformLimited,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    let snap = rig.ownership.observe("claude", &sid);
    assert!(matches!(
        rig.ownership.force_release_platform_limited(
            "claude",
            &sid,
            freshell_ownership::ObservedFence {
                epoch: snap.epoch,
                generation: snap.generation,
            },
            "operator",
        ),
        freshell_ownership::ForceReleaseOutcome::Released
    ));
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Fenced {
            reason: FenceReason::ClearedUnverified,
            ..
        }
    ));
    // Fixture: the prior sidecar is ALIVE at the acknowledged start.
    let prior_pid = env
        .sidecar_pid_for(&sid)
        .expect("fixture: the prior sidecar's pid");
    assert!(
        freshell_terminal::registry::pid_alive(prior_pid),
        "fixture: the unverified prior is provably alive"
    );

    // THE ACKNOWLEDGED START: enters Handoff carrying the prior as the
    // reap target — the forced kill + confirm, THEN the target.
    let ack_snap = rig.ownership.observe("claude", &sid);
    let mut ack_req = handoff_req_terminal("claude", &sid, "claude");
    ack_req.action = HandoffAction::StopAndReopen;
    ack_req.observed_epoch = Some(ack_snap.epoch);
    ack_req.observed_generation = Some(ack_snap.generation);
    let handle = rig.runner.spawn_handoff(ack_req);
    let result = handle
        .completion
        .await
        .expect("acknowledged start completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the forced-reap-then-start completes once the prior's death is \
         confirmed: {result}"
    );

    // THE PRIOR IS DEAD — the forced reap killed and confirmed it
    // (pre-r33 the sidecar stayed alive beside the new writer).
    await_pid_dead(prior_pid).await;
    assert!(
        !freshell_terminal::registry::pid_alive(prior_pid),
        "the unverified prior is killed and confirmed dead BEFORE the new \
         writer commits — never two live writers"
    );
    // The new writer is the session's SOLE owner.
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("the new terminal writer holds the key, got {other:?}"),
    }
    rig.registry.kill(&terminal_id);
}

/// b8ke ext r33 F1 (b): the acknowledged start over an ALREADY-DEAD
/// prior proceeds — the forced reap finds the prior gone (AlreadyGone /
/// the confirmed-death evidence) and the new writer commits without a
/// permanent wedge.
#[tokio::test(flavor = "multi_thread")]
async fn the_acknowledged_start_over_an_already_dead_prior_proceeds() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(None);
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // The same typed-state seeding...
    let freshell_ownership::BeginOutcome::Granted {
        generation: g_fence,
    } = rig.ownership.begin_handoff(
        "claude",
        &sid,
        RuntimeOwnerKind::Terminal,
        "op-r33-seed-fence-dead",
        None,
        "test",
        1_000,
    )
    else {
        panic!("fixture: the fence handoff must grant")
    };
    assert!(matches!(
        rig.ownership.fence_unconfirmed_handoff(
            "claude",
            &sid,
            "op-r33-seed-fence-dead",
            g_fence,
            freshell_ownership::FenceReason::PlatformLimited,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    let snap = rig.ownership.observe("claude", &sid);
    assert!(matches!(
        rig.ownership.force_release_platform_limited(
            "claude",
            &sid,
            freshell_ownership::ObservedFence {
                epoch: snap.epoch,
                generation: snap.generation,
            },
            "operator",
        ),
        freshell_ownership::ForceReleaseOutcome::Released
    ));

    // ...with the prior ALREADY DEAD (the OS-confirmed death evidence
    // the reap finds).
    let prior_pid = env
        .sidecar_pid_for(&sid)
        .expect("fixture: the prior sidecar's pid");
    let _ = std::process::Command::new("kill")
        .args(["-9", &prior_pid.to_string()])
        .status();
    await_pid_dead(prior_pid).await;

    // THE ACKNOWLEDGED START proceeds — no permanent wedge.
    let ack_snap = rig.ownership.observe("claude", &sid);
    let mut ack_req = handoff_req_terminal("claude", &sid, "claude");
    ack_req.action = HandoffAction::StopAndReopen;
    ack_req.observed_epoch = Some(ack_snap.epoch);
    ack_req.observed_generation = Some(ack_snap.generation);
    let handle = rig.runner.spawn_handoff(ack_req);
    let result = handle
        .completion
        .await
        .expect("acknowledged start completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the acknowledged start over an already-dead prior proceeds: {result}"
    );
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("the new terminal writer holds the key, got {other:?}"),
    }
    rig.registry.kill(&terminal_id);
}

/// b8ke ext r16 F1: the settle-then-reap confirmation PROPAGATES/// b8ke ext r19 F1: a cancellation after publication where the recorded
/// PID outlives the reap budget must NOT vacate to plain Vacant — the
/// unconfirmed kill answers `Unconfirmed` and the abort cleanup's
/// existing fence + replacement-watcher regime takes over (pre-r19 the
/// kill wrapper DISCARDED the false and the arm classified NothingToDo,
/// so a competing lifecycle request could acquire ownership while the
/// uncommitted terminal writer stayed alive).
#[tokio::test(flavor = "multi_thread")]
async fn an_abort_with_a_published_target_pid_outliving_the_reap_budget_fences() {
    let _guard = ENV_LOCK.lock().await;
    let rig = build_rig_with_options(None, None, None, 100, None, true);
    // A live external process the cleanup never owns a row for (the
    // published-target shape): the watch's RECORDED pid.
    let mut child = std::process::Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn the external live process");
    let live_pid = child.id();
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "fixture: the external pid is alive"
    );

    // The crafted published+settled watch (the r10 F3 seam): publication
    // recorded the live pid; the settle finished.
    let watch = crate::terminal_tabs::HandoffSpawnWatch::new_with_before_publish(None, None);
    watch.publish_and_settle_for_test("t-r19-live-recorded", Some(live_pid));

    // The AbortPayload the guard's Drop would build for a terminal-target
    // handoff aborted after publication (spawn begun, no returned target).
    let payload = AbortPayload {
        provider: "claude".to_string(),
        session_id: "ses-r19-f1-outlives".to_string(),
        operation_id: "op-r19-f1-outlives".to_string(),
        generation: 7,
        prior: None,
        target_kind: RuntimeOwnerKind::Terminal,
        target_spawn_begun: true,
        target: None,
        spawn_watch: Some(watch),
    };
    let outcome = rig.runner.abort_reap_uncommitted_target(&payload).await;

    // THE CONTRACT: the unconfirmed kill answers Unconfirmed — the fence
    // regime owns the key, never a plain-Vacant release (red: NothingToDo).
    assert!(
        matches!(outcome, UncommittedTargetOutcome::Unconfirmed),
        "a recorded PID outliving the reap budget must answer Unconfirmed — got {outcome:?}"
    );
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "the pid still lives (the fixture never died)"
    );

    let _ = child.kill();
    let _ = child.wait();
}

/// b8ke ext r33 F2: a codex terminal identity rebind moves the live
/// record to the new thread id and leaves the old key PERMANENTLY
/// `Aliased{to: new}`. A REST handoff addressing that old valid codex
/// reference must resolve through the coordinator's alias-chain fixpoint
/// to the canonical key and proceed against the real owner (typed owner
/// responses as usual) — pre-r33 the runner resolved aliases only for
/// claude and opencode, so the codex old reference fell to `begin_handoff`
/// on the ALIASED key and was mapped to retryable `HANDOFF_IN_PROGRESS`:
/// a retry that could NEVER succeed (the alias is permanent).
#[tokio::test(flavor = "multi_thread")]
async fn a_codex_handoff_on_an_old_rebound_reference_resolves_the_permanent_alias() {
    let _guard = ENV_LOCK.lock().await;
    // Hermeticity: the handoff's codex TARGET spawn (resume_for_handoff →
    // spawn_sidecar) launches whatever `CODEX_CMD` names — without an
    // override the test depends on a host-installed `codex` binary and
    // fails on the CI runner with TARGET_SPAWN_FAILED (ENOENT). Route the
    // spawn through the committed fake app-server (the same CODEX_CMD
    // wrapper codex.rs's own fixtures use; its `thread/resume` echoes
    // whatever id it is asked to resume, so the canonical-key target
    // resumes cleanly). The codex env guard is held for the same reason
    // as the mismatch-refusal sibling's: CODEX_CMD is codex.rs's
    // process-global surface, and the guard snapshots/restores every
    // mutated variable on drop.
    let _codex_env = crate::codex::tests::ENV_LOCK.lock().await;
    crate::codex::tests::configure_fake_codex_cmd("{}");
    let old_tid = format!("old-thread-{}", uuid::Uuid::new_v4());
    let new_tid = format!("new-thread-{}", uuid::Uuid::new_v4());
    let rig = build_rig(None);

    // The pre-rebind terminal owner under the OLD thread id.
    let owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-r33-codex-rebind".to_string()),
        live_session_key: None,
        pid: None,
        ownership_id: Some("op-r33-codex-live".to_string()),
    };
    let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_start(
        "codex",
        &old_tid,
        RuntimeOwnerKind::Terminal,
        "op-r33-codex-live",
        None,
        "test",
        1_000,
    ) else {
        panic!("fixture: the pre-rebind claim must grant")
    };
    assert!(matches!(
        rig.ownership.commit_live(
            "codex",
            &old_tid,
            "op-r33-codex-live",
            generation,
            owner.clone()
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    // The running headless terminal the rebind's owner names.
    rig.registry
        .register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: "t-r33-codex-rebind".to_string(),
            stream_id: "t-r33-codex-rebind".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some(new_tid.clone()),
            create_request_id: None,
            created_at: None,
        });

    // THE REBIND: the new key's Starting claim first (the rebind
    // commit's own contract), then the live record moves old→new; the
    // old key is PERMANENTLY Aliased{to: new}.
    let freshell_ownership::BeginOutcome::Granted { generation: g_new } =
        rig.ownership.begin_start(
            "codex",
            &new_tid,
            RuntimeOwnerKind::Terminal,
            "op-r33-codex-rebind",
            None,
            "test",
            1_100,
        )
    else {
        panic!("fixture: the rebind's new-key claim must grant")
    };
    assert!(matches!(
        rig.ownership.commit_live_rekey_from_terminal(
            "codex",
            &new_tid,
            "op-r33-codex-rebind",
            g_new,
            &old_tid,
            "t-r33-codex-rebind",
            owner,
            "test",
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    assert!(matches!(
        rig.ownership.observe("codex", &old_tid).state,
        OwnershipState::Aliased { to, .. } if to == new_tid
    ));
    assert!(matches!(
        rig.ownership.observe("codex", &new_tid).state,
        OwnershipState::Live { owner, .. }
            if owner.terminal_id.as_deref() == Some("t-r33-codex-rebind")
    ));

    // THE HANDOFF on the OLD reference: resolves to the canonical key and
    // proceeds against the real owner (pre-r33 this answered the
    // retryable HANDOFF_IN_PROGRESS forever).
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("codex", &old_tid, "codex"));
    let result = handle.completion.await.expect("handoff completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the old reference resolves to the canonical owner and the handoff \
         proceeds: {result}"
    );
    // The commit landed under the CANONICAL key; the old key stays the
    // resolution alias throughout.
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("codex", &new_tid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("the new writer holds the CANONICAL key, got {other:?}"),
    }
    assert!(matches!(
        rig.ownership.observe("codex", &old_tid).state,
        OwnershipState::Aliased { to, .. } if to == new_tid
    ));
    rig.registry.kill(&terminal_id);
}

/// b8ke ext r34 F1: the SERVER-side per-code pin — every real
/// STALE_GENERATION answer carries `retryable: true` from the ACTUAL
/// handler output. A stale generation is the canonical retryable
/// cross-device race outcome (the message says refresh and retry); the
/// client banner renders the Retry action from this flag. Pre-r34 the
/// server emitted `retryable: false` while the client coverage
/// fabricated `true` — the recovery existed only in the tests. This pin
/// drives the MAIN path's emission (the observed-pair stale enter); the
/// stale-commit arm's emission is pinned by the retryable asserts in the
/// stale-commit tests, and the acknowledged-start/force-clear race arms
/// share the same `typed_failure` call shape.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_generation_answer_is_retryable_from_the_handler_output() {
    let _guard = ENV_LOCK.lock().await;
    let sid = format!("stale-retryable-{}", uuid::Uuid::new_v4());
    let rig = build_rig(None);

    // A live terminal owner at generation 1 (the observed-pair baseline).
    let freshell_ownership::BeginOutcome::Granted { generation } = rig.ownership.begin_start(
        "codex",
        &sid,
        RuntimeOwnerKind::Terminal,
        "op-r34-stale-baseline",
        None,
        "test",
        1_000,
    ) else {
        panic!("fixture: the baseline claim must grant")
    };
    assert!(matches!(
        rig.ownership.commit_live(
            "codex",
            &sid,
            "op-r34-stale-baseline",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: RuntimeOwnerKind::Terminal,
                terminal_id: Some("t-r34-stale-baseline".to_string()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            },
        ),
        freshell_ownership::CommitOutcome::Committed
    ));

    // THE HANDOFF with a STALE observed pair (generation 0 against the
    // key's generation 1): the main path's stale-enter emission.
    let mut req = handoff_req_terminal("codex", &sid, "codex");
    req.observed_epoch = Some(rig.ownership.boot_epoch());
    req.observed_generation = Some(0);
    let handle = rig.runner.spawn_handoff(req);
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(
        result["error"]["code"],
        json!("STALE_GENERATION"),
        "the stale observed pair answers the typed stale generation: {result}"
    );
    assert_eq!(
        result["error"]["retryable"],
        json!(true),
        "STALE_GENERATION carries retryable: true from the ACTUAL handler \
         output — the banner's Retry action renders from this flag: {result}"
    );
    assert_eq!(
        result["error"]["ownerGeneration"],
        json!(generation),
        "the refusal names the current generation for the caller's refresh: {result}"
    );
    rig.registry.kill("t-r34-stale-baseline");
}

/// b8ke ext r16 F1: the settle-then-reap confirmation PROPAGATES
/// kill-and-confirm result — a concurrent kill that already removed the
/// registry row while the recorded PID stays alive (beyond the reap
/// timeout) must NOT answer Confirmed (pre-r16 the boolean was discarded
/// and the answer was unconditionally Confirmed, so the watcher released
/// the ownership fence and another writer could start beside the
/// abandoned target). The unconfirmed outcome keeps the typed fence +
/// watcher regime armed (ReapAnswer::Lost → the R2-1 fence + the
/// replacement watcher).
#[tokio::test(flavor = "multi_thread")]
async fn the_spawn_settle_reconfirmation_does_not_confirm_a_live_recorded_pid() {
    let _guard = ENV_LOCK.lock().await;
    let rig = build_rig(None);
    // A live process this cleanup never owned a row for (the concurrent
    // kill's shape): the watch's RECORDED pid.
    let mut child = std::process::Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn the external live process");
    let live_pid = child.id();
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "fixture: the external pid is alive"
    );

    let watch = crate::terminal_tabs::HandoffSpawnWatch::new_with_before_publish(None, None);
    watch.publish_and_settle_for_test("t-ghost-row-removed", Some(live_pid));

    let runner = std::sync::Arc::clone(&rig.runner);
    let answer = runner
        .spawn_settle_reconfirmation("claude", "ses-r16-f1-ghost", watch)
        .await;

    // THE CONTRACT: the live recorded pid is NOT a confirmed death — the
    // answer must keep the fence + watcher regime armed (Lost), never
    // Confirmed.
    assert!(
        matches!(answer, crate::session_handoff::ReapAnswer::Lost),
        "a live recorded pid must NOT answer Confirmed — got {answer:?}"
    );
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "the pid still lives (the fixture never died)"
    );

    let _ = child.kill();
    let _ = child.wait();
}

/// b8ke ext r13 F7: the row-removed-but-pid-alive window reports
/// UNCONFIRMED, not Confirmed. The registry removes a row BEFORE its
/// blocking PTY kill completes, so a concurrent kill can leave the target
/// PID alive while the row-based poll already reports dead — the
/// recorded-PID OS-level probe is the death evidence (the ext-r7 F5
/// discipline). The deterministic shape: a terminal id with NO registry
/// row (a concurrent kill removed it) whose RECORDED pid is a live
/// external process — the OLD row-based confirmation answered Confirmed
/// instantly; the recorded-PID confirmation answers unconfirmed.
#[tokio::test]
async fn the_row_removed_but_pid_alive_window_reports_unconfirmed() {
    let registry = freshell_terminal::TerminalRegistry::new();
    // A live process this cleanup never owned a row for (the concurrent
    // kill's window): the recorded pid.
    let mut child = std::process::Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn the external live process");
    let live_pid = child.id();
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "fixture: the external pid is alive"
    );

    // THE CONTRACT: the row-absent + pid-alive window is UNCONFIRMED
    // (pre-r13 the row-based poll answered Confirmed — the row's
    // absence was treated as exit proof).
    let confirmed =
        kill_and_confirm_terminal_pid(&registry, "ghost-row-removed-tid", Some(live_pid), 200)
            .await;
    assert!(
        !confirmed,
        "the row-removed-but-pid-alive window must NOT report Confirmed"
    );
    assert!(
        freshell_terminal::registry::pid_alive(live_pid),
        "the pid still lives"
    );

    // Cleanup: reap the external child.
    let _ = child.kill();
    let _ = child.wait();
}

/// 3j. b8ke focused round-3 review R3-3: the DELAYED platform-limited
/// shape — a teardown that crosses the handoff's reap budget (the runner
/// answers REAP_TIMEOUT and detaches the kill) and only LATER resolves
/// PlatformLimited — must leave the key `Fenced{PlatformLimited}`. The
/// delayed watcher's PlatformLimited arm fences and RETURNS: falling
/// through into the confirmed-death release would reopen the key (and
/// broadcast `released`) over a descendant tree nobody ever confirmed —
/// the literal-missing-return fail-open this test pins.
#[tokio::test]
async fn a_delayed_platform_limited_reap_fences_the_key_and_never_releases() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let kill_pause = Arc::new(tokio::sync::Notify::new());
    // The platform-limited seam + a SHORT reap budget: the parked lane kill
    // crosses the runner's budget (the timeout branch spawns it detached),
    // then the released park answers PlatformLimited.
    let mut rig =
        build_rig_with_options(None, Some(Arc::clone(&kill_pause)), None, 150, None, true);
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // The lane kill parks past the runner's budget (the stamp is taken —
    // the deterministic observable that the kill entered its pause).
    await_cond("the lane kill must issue (take the stamp)", || {
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .is_none()
    })
    .await;
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));

    // The parked kill now crosses: it answers PlatformLimited late.
    kill_pause.notify_one();

    // THE R3-3 regression: the delayed PlatformLimited answer FENCES the
    // key typed — never falls through into the confirmed-death release
    // (which would reopen it and broadcast `released`).
    await_cond(
        "the delayed platform-limited answer must fence the key",
        || {
            matches!(
                rig.ownership.observe("claude", &sid).state,
                OwnershipState::Fenced {
                    reason: FenceReason::PlatformLimited,
                    ..
                }
            )
        },
    )
    .await;
    // The fence is terminal on this platform: NO corrective `released`
    // frame may follow the fenced `handoff-failed` frame.
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    assert!(
        !frames.iter().any(|f| f["transition"] == "released"),
        "the delayed platform-limited fence must never broadcast released: {frames:?}"
    );
    let _ = runtime_owner_frame(&frames, "handoff-failed");
    // A new writer stays Blocked over the unconfirmed descendant tree.
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::FreshAgent,
                "delayed-pl-fence-probe-create",
                None,
                "test",
                0,
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a create during the delayed platform-limited fence must be Blocked"
    );
}

/// 3h. b8ke focused review FR3 (the runner's fenced not-confirmed path): a
/// claude prior whose teardown CANNOT confirm the runtime tree's death in
/// its bounded window (a TERM-immune tagged descendant outlives the
/// one-round test window) makes the handoff answer the typed retryable
/// REAP_TIMEOUT and fence the key in Handoff — never a bare success with
/// the lingering descendant still alive — until the lane's carried
/// escalation confirms death, the watcher releases the key to Vacant, and
/// the corrective `released` frame lands. Linux-only: the /proc ownership
/// tag scan is the Linux discipline.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn handoff_with_an_unconfirmable_claude_tree_fences_the_key_until_the_escalation_lands() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // The one-round confirmation window: a TERM-immune descendant
    // deterministically outlives it (the SIGKILL escalation is rounds away).
    let mut rig = build_rig_full(None, None, None, 8_000, Some(1));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    // Discover the sidecar's ownership tag from its environment (the
    // spawn injects FRESHELL_CLAUDE_SIDECAR_ID; our process is its
    // ancestor, so /proc/<pid>/environ is readable) and park a
    // TERM-immune tagged "CLI grandchild" under it.
    let ownership_id = {
        let environ = std::fs::read(format!("/proc/{prior_pid}/environ"))
            .expect("read the sidecar's environ");
        environ
            .split(|&b| b == 0)
            .find_map(|var| {
                let var = std::str::from_utf8(var).ok()?;
                var.strip_prefix("FRESHELL_CLAUDE_SIDECAR_ID=")
            })
            .expect("the sidecar's ownership id")
            .to_string()
    };
    let mut grandchild = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("trap '' TERM; while :; do sleep 1; done")
        .env("FRESHELL_CLAUDE_SIDECAR_ID", &ownership_id)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the lingering tagged grandchild");
    let grandchild_pid = grandchild.id().expect("grandchild pid");

    // Handoff claude -> terminal: the prior stop cannot confirm the tree's
    // death in its (one-round) window.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");

    // The typed fenced failure — NEVER a bare success while the descendant
    // lives.
    assert_eq!(
        result["ok"],
        json!(false),
        "the unconfirmable-tree handoff must fail: {result}"
    );
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert_eq!(result["error"]["retryable"], json!(true));
    // The key is FENCED in Handoff at the failure (the lane's carried
    // escalation needs its SIGKILL rounds — ≥500ms — before the watcher
    // can release): a competing create is Blocked, never granted, while the
    // lingering descendant still lives.
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Handoff { .. }
        ),
        "the unconfirmable tree must fence the key in Handoff, got {:?}",
        rig.ownership.observe("claude", &sid).state
    );
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::FreshAgent,
                "fence-probe-create-fr3",
                None,
                "test",
                0,
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a create during the fenced not-confirmed window must be Blocked"
    );

    // The escalation lands: the descendant dies (a zombie counts — nothing
    // holds its pipes; `proc_starttime` reads None for state Z), the
    // watcher releases the key to Vacant, and the corrective frames arrive
    // in order.
    await_cond("the escalation must kill the lingering descendant", || {
        crate::session_lease::proc_starttime(grandchild_pid as i32).is_none()
    })
    .await;
    await_cond("the confirmed death must release the fenced key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed", "released"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(failed["reason"], json!("REAP_TIMEOUT"));
    let released = runtime_owner_frame(&frames, "released");
    assert_eq!(
        released["ownerKind"],
        json!("vacant"),
        "the truth: {released}"
    );
    let failed_pos = frames
        .iter()
        .position(|f| f["transition"] == "handoff-failed")
        .expect("the failed frame position");
    let released_pos = frames
        .iter()
        .position(|f| f["transition"] == "released")
        .expect("the released frame position");
    assert!(
        failed_pos < released_pos,
        "the failure frame (index {failed_pos}) must precede the release (index {released_pos})"
    );
    await_pid_dead(prior_pid).await;
    let _ = grandchild.wait().await;

    // The recoverable state: a retry from Vacant succeeds.
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let retried = retry.completion.await.expect("retry completed");
    assert_eq!(
        retried["ok"],
        json!(true),
        "the post-settlement retry must succeed: {retried}"
    );
    let retry_terminal = retried["owner"]["terminalId"].as_str().unwrap().to_string();
    rig.registry.kill(&retry_terminal);
}

/// 3c. Exit-watcher after the boundary (round-2 review): a prior restored
/// after a reap timeout is a NORMAL Live record — when it dies LATER, its
/// fenced exit path still releases the key (no permanent wedge).
#[tokio::test]
async fn a_prior_restored_after_reap_timeout_still_releases_when_it_later_exits() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // Drive test 3's scenario: timeout, re-probe live, restored.
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Live { .. }
    ));

    // The prior dies LATER (a real lane kill — the retained stamp still
    // matches the restored Live record, so the fenced stop path works).
    rig.fresh_claude.handle_kill(kill_msg(&sid)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while rig.ownership.observe("claude", &sid).state != OwnershipState::Vacant {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the restored prior's later exit must release the key — no permanent \
             wedge after a reap-timeout restore, got {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// 3d. Whole-branch review M-1 (the exact wedge): a client that folded the
/// handoff frames holds the HANDOFF generation (the fold is same-epoch
/// monotonic — it never regresses). After a reap-timeout restore, its
/// wire-fenced kill (`freshAgent.kill` carrying the folded
/// observedEpoch/observedGeneration pair) must CONVERGE: begin_stop
/// Granted, the lane kill proceeds, commit_stop leaves the key Vacant.
/// Pre-fix the restored Live state held the prior's ORIGINAL generation
/// and the kill looped on typed StaleClaim until a reconnect.
#[tokio::test]
async fn a_wire_fenced_kill_at_the_handoff_generation_converges_after_a_restore() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    // Drive test 3's scenario: timeout, re-probe live, restored.
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Live { .. }
    ));

    // The client's folded fence: the handoff frames carry the boot epoch and
    // the HANDOFF generation (the failed frame rides the started frame's
    // generation — test 2's assertion).
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    let epoch = failed["epoch"]
        .as_u64()
        .expect("the frame carries the epoch");
    let generation = failed["generation"]
        .as_u64()
        .expect("the frame carries the generation");
    // The restored Live key must hold EXACTLY the generation the frames
    // carried (no straddle: the record's, the Live state's, and the
    // broadcast's are one value).
    assert_eq!(
        rig.ownership.observe("claude", &sid).generation,
        generation,
        "the restored Live key holds the handoff generation the frames carried"
    );
    // The lane's retained stamp is repaired to the same generation, so the
    // stamp-fenced kill path converges too.
    assert_eq!(
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .map(|stamp| stamp.generation),
        Some(generation),
        "the repaired lane stamp fences at the restored generation"
    );

    // The wire-fenced kill from that client: begin_stop must Grant (the
    // exact-generation match), the lane teardown runs, and the key ends
    // Vacant — not a StaleClaim refusal loop.
    rig.fresh_claude
        .handle_kill(FreshAgentKill {
            observed_epoch: Some(epoch),
            observed_generation: Some(generation),
            ..kill_msg(&sid)
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while rig.ownership.observe("claude", &sid).state != OwnershipState::Vacant {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the wire-fenced kill at the handoff generation must converge after a \
             restore — the key is {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    await_pid_dead(prior_pid).await;
}

/// 3e. Whole-branch M-1 ripple (terminal priors): a restored TERMINAL prior
/// holds the handoff generation, so the registry's retained claim (the
/// terminal exit/kill release paths' fence source) must be repaired to the
/// SAME generation — otherwise the fenced `release` (an exact generation
/// match against the Live state) would no-op forever and the restored key
/// would never vacate when the terminal later dies.
#[tokio::test]
async fn a_restored_terminal_prior_still_releases_when_it_later_exits() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks::default());
    let mut rig = build_rig(Some(Arc::clone(&hooks)));

    // Terminal prior (the 5c pattern): a real Running PTY that
    // self-commits Live{Terminal} for the canonical key.
    let spawn_body = json!({
        "mode": "claude",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let spawned = crate::terminal_tabs::spawn_terminal_pane(
        &rig.fresh_agent,
        &spawn_body,
        "handoff-restore-terminal-tab",
        "handoff-restore-terminal-pane",
    )
    .await
    .expect("terminal prior spawn");
    let prior_terminal = spawned.terminal_id.clone();
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Live { .. }
    ));

    // Reap-timeout restore of the still-live terminal prior.
    hooks.force_reap_timeout.store(true, Ordering::SeqCst);
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["error"]["code"], json!("REAP_TIMEOUT"));
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Live { ref owner, .. } if owner.kind == RuntimeOwnerKind::Terminal
    ));

    // The retained claim must now fence at the RESTORED (handoff)
    // generation — the same value the failure broadcast carried.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    let generation = failed["generation"]
        .as_u64()
        .expect("the frame carries the generation");
    assert_eq!(
        rig.ownership.observe("claude", &sid).generation,
        generation,
        "the restored terminal prior holds the handoff generation"
    );
    assert_eq!(
        rig.registry
            .retained_ownership_fence(&prior_terminal)
            .map(|(_, claim_generation)| claim_generation),
        Some(generation),
        "the retained claim is repaired to the restored generation"
    );

    // The terminal later dies (the registry kill IS the confirmed reap):
    // the fenced release must match and vacate the key — no permanent
    // wedge after a reap-timeout restore.
    rig.registry.kill(&prior_terminal);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while rig.ownership.observe("claude", &sid).state != OwnershipState::Vacant {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the restored terminal prior's later exit must release the key — no \
             permanent wedge after a reap-timeout restore, got {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// 4. Detached completion: dropping the reply receiver mid-handoff cannot
/// strand the operation; the detached task still reaches Live{target} and
/// the handoff-committed broadcast fires.
#[tokio::test]
async fn handoff_continues_to_consistency_when_client_disconnects() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle: HandoffHandle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // The client disconnects (the reply receiver is dropped) while the
    // runner is parked after enter — the operation MUST continue.
    drop(handle.completion);
    hooks
        .pause_after_enter
        .as_ref()
        .expect("pause hook installed")
        .notify_one();

    // The committed broadcast arrives (the detached task reached the commit).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let committed = loop {
        match tokio::time::timeout(Duration::from_millis(500), rig.rx.recv()).await {
            Ok(Ok(raw)) => {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if v["type"] == "session.runtimeOwner" && v["transition"] == "handoff-committed"
                    {
                        break v;
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => panic!("broadcast channel closed"),
            Err(_) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the detached handoff never committed"
                );
            }
        }
    };
    let terminal_id = committed["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("the detached handoff must reach Live{{Terminal}}, got {other:?}"),
    }
    rig.registry.kill(&terminal_id);
}

/// 5. Guard fail: aborting the handoff task restores prior owner or Vacant —
/// zero or one owner, never a stranded Handoff. A fresh begin_start is
/// Granted afterward (the key reopens).
#[tokio::test]
async fn handoff_task_abort_leaves_zero_or_one_owner() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: wait for the started broadcast so the abort lands mid-Handoff.
    let _started = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match rig.rx.recv().await {
                Ok(raw) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if v["type"] == "session.runtimeOwner"
                            && v["transition"] == "handoff-started"
                        {
                            return v;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => panic!("broadcast channel closed"),
            }
        }
    })
    .await
    .expect("handoff-started broadcast within budget");

    // Abort: the RAII guard fails the coordinator entry during the unwind.
    handle.abort();
    let _ = handle.task.await;

    let state = rig.ownership.observe("claude", &sid).state;
    assert!(
        matches!(state, OwnershipState::Live { .. } | OwnershipState::Vacant),
        "abort must leave zero or one owner (Live prior or Vacant), got {state:?}"
    );

    // The key reopens (not wedged): from Vacant a fresh begin_start is
    // Granted; from the restored Live prior a fresh begin_handoff is Granted
    // (the restored owner is a normal Live record, not a stranded Handoff).
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Vacant => {
            assert!(matches!(
                rig.ownership.begin_start(
                    "claude",
                    &sid,
                    RuntimeOwnerKind::Terminal,
                    "post-abort-probe",
                    None,
                    "test",
                    0,
                ),
                BeginOutcome::Granted { .. }
            ));
            let _ = rig
                .ownership
                .fail("claude", &sid, "post-abort-probe", 1, false);
        }
        OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                RuntimeOwnerKind::FreshAgent,
                "the restored owner is the prior fresh runtime"
            );
            match rig.ownership.begin_handoff(
                "claude",
                &sid,
                RuntimeOwnerKind::Terminal,
                "post-abort-probe",
                None,
                "test",
                0,
            ) {
                BeginOutcome::Granted { generation } => {
                    // Roll the probe back to the live prior (the abort's own
                    // outcome) under the generation it was granted.
                    let _ =
                        rig.ownership
                            .fail("claude", &sid, "post-abort-probe", generation, true);
                }
                other => panic!("expected Granted from the probe handoff, got {other:?}"),
            }
        }
        other => panic!("already asserted Live-or-Vacant, got {other:?}"),
    }

    // Cleanup: kill the sidecar so nothing leaks.
    rig.fresh_claude.handle_kill(kill_msg(&sid)).await;
}

/// 5b. Prior-reap window (round-3 review I-1): an abort landing inside the
/// prior-kill await — AFTER the lane kill took the retained stamp but
/// BEFORE it removed the session — must RE-PROBE the prior's liveness
/// before any restore: the probe confirms it live (the kill future was
/// dropped before the map removal), so the prior is restored — and the
/// taken stamp is REPAIRED, so the lane's later kill/exit paths can still
/// release the record (no permanent block).
#[tokio::test]
async fn handoff_abort_during_prior_kill_reprobes_and_repairs_the_stamp() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let kill_pause = Arc::new(tokio::sync::Notify::new());
    let mut rig = build_rig_with_claude_pauses(None, Some(Arc::clone(&kill_pause)), None);
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the lane kill ISSUED — the retained stamp is gone (the
    // deterministic observable that the kill entered its pause; the session
    // itself is still registered and alive).
    await_cond("the lane kill must issue (take the stamp)", || {
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .is_none()
    })
    .await;

    // ABORT inside the prior-kill await.
    handle.abort();
    let _ = handle.task.await;

    // The abort path re-probed and RESTORED the confirmed-live prior.
    await_cond("the abort cleanup must settle the record", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Live { .. }
        )
    })
    .await;
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                RuntimeOwnerKind::FreshAgent,
                "the re-probed-live prior is restored"
            );
        }
        other => panic!("the restored prior must be Live, got {other:?}"),
    }
    assert!(
        rig.fresh_claude.has_live_session(&sid).await,
        "the prior was never actually killed (the kill future dropped before teardown)"
    );
    // The stamp was TAKEN by the kill and REPAIRED by the abort path.
    await_cond("the retained stamp must be repaired", || {
        crate::ownership_lane::peek_retained_stamp(&rig.fresh_claude.ownership_stamps, &sid)
            .is_some()
    })
    .await;

    // No permanent block: the lane's OWN kill path still works through the
    // repaired stamp — the key releases to Vacant on the real exit.
    rig.fresh_claude.handle_kill(kill_msg(&sid)).await;
    await_cond("the later lane kill must release the key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    await_pid_dead(prior_pid).await;
}

/// 5c. Prior-reap window (round-3 review I-1): an abort landing after the
/// TERMINAL prior's registry kill was issued and the prior is CONFIRMED
/// DEAD must end the key VACANT — the abort path's re-probe finds the row
/// gone, so a dying/dead prior is never restored as `Live` (the exact
/// wedge the carried finding names).
#[tokio::test]
async fn handoff_abort_after_terminal_prior_kill_never_restores_a_dead_prior() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_terminal_prior_kill: Some(tokio::sync::Notify::new()),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    let sid = uuid::Uuid::new_v4().to_string();

    // Terminal prior (the 6b pattern): a real Running PTY that
    // self-commits Live{Terminal} for the canonical key.
    let spawn_body = json!({
        "mode": "claude",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let spawned = crate::terminal_tabs::spawn_terminal_pane(
        &rig.fresh_agent,
        &spawn_body,
        "handoff-abort-terminal-tab",
        "handoff-abort-terminal-pane",
    )
    .await
    .expect("terminal prior spawn");
    let prior_terminal = spawned.terminal_id.clone();
    assert!(matches!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Live { .. }
    ));

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    // Park proof: the runner passed the enter and issued the registry
    // kill (parked inside the window); the SIGKILL always lands.
    let _started = await_owner_frame(&mut rig.rx, "handoff-started").await;
    await_cond("the prior terminal must die after the issued kill", || {
        rig.registry.terminal_is_dead(&prior_terminal)
    })
    .await;

    // ABORT inside the prior-kill await: the kill was issued, the prior is
    // dead — never restore it as Live.
    handle.abort();
    let _ = handle.task.await;

    await_cond("the abort cleanup must settle the record Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // The key reopens (not wedged).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "post-abort-probe",
            None,
            "test",
            0,
        ),
        BeginOutcome::Granted { .. }
    ));
    let _ = rig
        .ownership
        .fail("claude", &sid, "post-abort-probe", 1, false);
}

/// 5d. Target-spawn window (round-3 review I-1): an abort landing inside the
/// terminal-target spawn await — the settle is parked AFTER publishing the
/// spawned terminal — must let the guard's cleanup wait for the settle's
/// completion and REAP the uncommitted terminal: no live unowned writer, the
/// key Vacant, the registry clean.
#[tokio::test]
async fn handoff_abort_during_target_spawn_reaps_the_uncommitted_terminal() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_in_target_spawn: Some(Arc::clone(&pause)),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the runner deposited its spawn watch, and the settle
    // PUBLISHED the spawned terminal (then parked at the seam — it cannot
    // pass without the test's notify).
    let watch = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(watch) = hooks.spawn_watch_slot.lock().unwrap().clone() {
                if let Some(terminal_id) = watch.published_terminal() {
                    break (watch, terminal_id);
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the settle never published the spawned terminal"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    let target_terminal = watch.1;

    // ABORT inside the target-spawn await (the runner is parked awaiting
    // the settle).
    handle.abort();
    let _ = handle.task.await;

    // b8ke focused round-3 R3-6: the key does NOT go plain-Vacant yet — the
    // deferred cleanup holds the record in Handoff (Blocked) until the
    // uncommitted terminal's settle + reap complete.
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Handoff { .. }
        ),
        "the abort must hold the fence while the uncommitted target settle runs"
    );

    // Release the settle: it completes UNDER-TICKET (no commit — the
    // runner is gone) and marks settlement, waking the cleanup.
    pause.notify_one();

    // The cleanup reaped the uncommitted terminal: its row is gone and no
    // registry row holds the canonical sessionRef.
    await_cond("the uncommitted target terminal must be reaped", || {
        rig.registry.terminal_is_dead(&target_terminal)
    })
    .await;
    assert!(
        !rig.registry
            .directory()
            .into_iter()
            .any(|entry| entry.resume_session_id.as_deref() == Some(sid.as_str())),
        "no terminal may own {sid} after the aborted handoff"
    );

    // The settled cleanup vacated the key (the prior was reaped).
    await_cond("the settled cleanup must leave the key Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // The key reopens (not wedged).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "post-abort-probe",
            None,
            "test",
            0,
        ),
        BeginOutcome::Granted { .. }
    ));
    let _ = rig
        .ownership
        .fail("claude", &sid, "post-abort-probe", 1, false);
    await_pid_dead(prior_pid).await;
}

/// b8ke ext r30 F1: a handoff target whose sidecar EXITS before the
/// commit-to-Live is NEVER published — the publication's liveness
/// check runs under the lane-stamps lock (the same lock the exit
/// watcher's release consult takes), so the dead target refuses the
/// commit (the stale-commit arm: reap + typed recoverable failure +
/// the failed-transition repair) and no retained stamp leaks for an
/// owner that never materialized. Pre-r30 the commit ran first and
/// the stamp was inserted only after it: the killed target was
/// committed Live{FreshAgent} globally, the already-completed exit
/// watcher had no-op'd (no stamp), and the answer was a FALSE ok:true
/// — every device converged on a nonexistent owner.
#[tokio::test]
async fn a_handoff_target_exiting_before_the_commit_never_publishes_live() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // The claude-lane resume gates on transcript presence (the 6b
    // pattern).
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-r30-f1-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    // A RELEASABLE pausing flavor writer: stage() parks inside the
    // Handoff window (post target-spawn, pre-commit) until the test
    // releases it — the deterministic kill window.
    let stage_reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stage_release = Arc::new(tokio::sync::Notify::new());
    struct ReleasablePausingFlavor {
        reached: Arc<std::sync::atomic::AtomicBool>,
        release: Arc<tokio::sync::Notify>,
    }
    impl crate::session_handoff::FlavorWrite for ReleasablePausingFlavor {
        fn stage(
            &self,
            _provider: &str,
            _session_id: &str,
            _flavor: &str,
        ) -> crate::session_handoff::StagedFlavorFuture {
            self.reached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let release = Arc::clone(&self.release);
            Box::pin(async move {
                let _ = release.notified().await;
                // No durable flavor to commit — the runner proceeds
                // straight to the commit-to-Live.
                Ok(None)
            })
        }
    }
    let mut rig = build_rig_with_flavor_writer(Arc::new(ReleasablePausingFlavor {
        reached: Arc::clone(&stage_reached),
        release: Arc::clone(&stage_release),
    }));
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    rig.fresh_claude.set_identity_sink(fake.clone());

    establish_fresh_claude_owner(&mut rig, &sid).await;
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));

    // Park proof: the runner reached the flavor stage INSIDE the
    // Handoff window — the target is spawned and registered.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !stage_reached.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the runner never reached the flavor stage"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // THE TARGET EXITS: kill the resumed sidecar (the LATEST create
    // row for this sid — the target's spawn), and wait for the OS to
    // confirm it gone (the publication's liveness evidence).
    let rows = env.create_rows();
    let target_pid = rows
        .iter()
        .rev()
        .find(|r| r["msg"]["resumeSessionId"] == sid)
        .and_then(|r| r["pid"].as_u64())
        .expect("the target sidecar's create row") as u32;
    let _ = std::process::Command::new("kill")
        .args(["-9", &target_pid.to_string()])
        .status();
    await_pid_dead(target_pid).await;

    // RELEASE: the runner proceeds to the commit-to-Live with a dead
    // target — the publication must refuse it.
    stage_release.notify_one();
    let result = handle.completion.await.expect("handoff completed");

    // The typed failure — never a false ok:true over a dead runtime.
    assert_eq!(
        result["ok"],
        json!(false),
        "the dead target is never published Live — the handoff answers \
             the typed recoverable failure: {result}"
    );
    // The coordinator NEVER holds Live{FreshAgent} for the dead
    // target: the stale-commit arm reaped it and failed the entry
    // (the prior was reaped by the runner's stop — the key settles
    // Vacant).
    await_cond("the failed handoff must settle the key Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    // No retained stamp LEAKED for the never-published owner.
    assert!(
        rig.fresh_claude
            .ownership_stamps
            .lock()
            .expect("stamps lock")
            .get(&sid)
            .is_none(),
        "no release evidence leaked for an owner that never materialized"
    );
    // And the failed-transition repair fired (the r4 machinery) with
    // the transition's own generation.
    let repairs = fake.repairs.lock().expect("repairs lock").clone();
    assert!(
        !repairs.is_empty(),
        "the stale-commit arm's cleanup repaired the failed transition"
    );
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(store_dir);
}

/// b8ke focused ep5 r4 F1: an aborted handoff whose target is a FRESH
/// AGENT fires the FAILED-TRANSITION REPAIR through the reaped target's
/// identity sink — the cleanup's ledger act (the durable tombstone fence
/// + the conditional revert of the transition's own orphaned row) — with
/// the transition's OWN (boot epoch, handoff generation). The abort
/// lands in the staged-flavor window: the target was spawned and
/// registered (its under-ticket binding write may be in flight or
/// landed), the runner parks at the flavor stage, and the abort's guard
/// cleanup reaps the uncommitted target and fails the entry.
#[tokio::test]
async fn handoff_abort_of_a_fresh_target_fires_the_failed_transition_repair() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // The claude-lane resume gates on transcript presence (the 6b pattern):
    // the target's resume of `sid` needs the transcript under
    // CLAUDE_CONFIG_DIR.
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-ep5-r4-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    // A pausing flavor writer: `stage` parks inside the Handoff window
    // (post target-spawn, pre-commit) — the abort's deterministic window.
    let stage_reached = Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct PausingFlavorWriter {
        reached: Arc<std::sync::atomic::AtomicBool>,
    }
    impl crate::session_handoff::FlavorWrite for PausingFlavorWriter {
        fn stage(
            &self,
            _provider: &str,
            _session_id: &str,
            _flavor: &str,
        ) -> crate::session_handoff::StagedFlavorFuture {
            self.reached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // Park until the test aborts the runner (the await is
            // CANCELED by the abort — the stage never commits).
            Box::pin(std::future::pending::<
                Result<Option<Box<dyn crate::session_handoff::StagedFlavor>>, String>,
            >())
        }
    }
    let mut rig = build_rig_with_flavor_writer(Arc::new(PausingFlavorWriter {
        reached: Arc::clone(&stage_reached),
    }));
    // The reaped target's lane sink: the fake RECORDS the repair call.
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    rig.fresh_claude.set_identity_sink(fake.clone());

    establish_fresh_claude_owner(&mut rig, &sid).await;
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));

    // Park proof: the runner reached the flavor stage INSIDE the Handoff
    // window (the target is spawned + registered) — capture the window's
    // generation.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !stage_reached.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the runner never reached the flavor stage"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let generation = match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Handoff { generation, .. } => generation,
        other => panic!("expected the Handoff window, got {other:?}"),
    };

    // ABORT inside the flavor-stage window: the guard's cleanup reaps the
    // uncommitted fresh-agent target (firing the repair), then fails the
    // entry (the prior was reaped by the runner's stop — the key goes
    // Vacant).
    handle.abort();
    let _ = handle.task.await;
    await_cond("the aborted handoff must settle the key Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // THE REPAIR FIRED with the transition's own pair: (provider, sid,
    // boot epoch, handoff generation).
    let repairs = fake.repairs.lock().expect("repairs lock").clone();
    assert!(
        repairs.contains(&(
            "claude".to_string(),
            sid.clone(),
            rig.ownership.boot_epoch(),
            generation
        )),
        "the failed transition's repair fired with its own (epoch, generation): \
         {repairs:?} (boot epoch {}, handoff generation {generation})",
        rig.ownership.boot_epoch()
    );
    // The prior's sidecar tree is dead (the runner's stop + the cleanup's
    // reap both settled).
    let _ = env;
}

/// 5e'. b8ke ext r10 F3: an abort landing while the detached terminal
/// spawn is parked in PRE-PUBLICATION work (the reviewer's exact window —
/// nothing published, the cleanup's bounded settle-wait times out) FAILS
/// CLOSED: the key fences typed (never release-and-hope over the
/// unsettled spawn), and the fence's replacement confirmation watcher
/// awaits the spawn's settle, reaps the terminal it publishes, and only
/// the confirmed death releases the key. Pre-r10 the timeout was
/// discarded — the cleanup classified NothingToDo and VACATED while the
/// spawn still ran, and the late-published spawn could survive as a live
/// unowned writer.
#[tokio::test]
async fn handoff_abort_during_pre_publication_spawn_fences_until_the_spawn_settles() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let pre_publish_park = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_in_target_spawn_before_publish: Some(Arc::clone(&pre_publish_park)),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));

    // Park proof: the runner deposited its spawn watch, the settle REACHED
    // the pre-publication park (the flag), and NOTHING is published yet.
    let watch = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(watch) = hooks.spawn_watch_slot.lock().unwrap().clone() {
                if watch.parked_before_publish() {
                    break watch;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the settle never reached the pre-publication park"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    assert!(
        watch.published_terminal().is_none(),
        "nothing is published while parked pre-publication"
    );
    // Shrink the cleanup's bounded settle-wait so the timeout path runs
    // deterministically (the test knob; production keeps 60s).
    watch.set_settle_wait_budget_ms(200);

    // ABORT inside the target-spawn await (the runner is parked awaiting
    // the settle).
    handle.abort();
    let _ = handle.task.await;

    // FAIL-CLOSED: after the settle-wait budget elapses the key FENCES
    // typed — it is NEVER vacated while the detached spawn is unsettled
    // (pre-r10 the discarded timeout classified NothingToDo and vacated).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let state = rig.ownership.observe("claude", &sid).state;
        match state {
            OwnershipState::Fenced { .. } => break,
            OwnershipState::Handoff { .. } => {
                // The deferred cleanup may still be inside its settle-wait
                // budget — keep waiting for the timeout arm.
            }
            other => panic!(
                "the unsettled spawn's cleanup must hold/fence the key — \
                 never {other:?} while the spawn still runs"
            ),
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the cleanup never fenced the key for the unsettled spawn — \
             state: {:?}",
            rig.ownership.observe("claude", &sid).state
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Release the settle: it publishes the terminal and finishes — the
    // fence's confirmation watcher reaps the late-published spawn.
    pre_publish_park.notify_one();
    let published = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(terminal_id) = watch.published_terminal() {
                break terminal_id;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the released settle never published its terminal"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };

    // The late-published spawn is KILLED (never a live unowned writer).
    await_cond("the late-published spawn must be reaped", || {
        rig.registry.terminal_is_dead(&published)
    })
    .await;
    assert!(
        !rig.registry
            .directory()
            .into_iter()
            .any(|entry| entry.resume_session_id.as_deref() == Some(sid.as_str())),
        "no terminal may own {sid} after the watcher reaps the late-published spawn"
    );

    // The confirmed death releases the fence — the key reopens.
    await_cond("the watcher-resolved key must reopen", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Vacant
        )
    })
    .await;
    await_pid_dead(prior_pid).await;
}

/// 5f. Cancellation kill filter (b8ke delta review F6): the abort
/// cleanup's sessionRef backstop sweep must match the handoff's PROVIDER
/// (the registry join: `mode == provider`) in addition to the session id —
/// an opaque-id collision across providers must never abort an unrelated
/// terminal. A same-id CODEX terminal survives the aborted CLAUDE
/// handoff's cleanup; the same-id claude terminal (the uncommitted target)
/// is still reaped.
#[tokio::test]
async fn handoff_abort_cleanup_spares_a_same_id_different_provider_terminal() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        pause_in_target_spawn: Some(Arc::clone(&pause)),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    // The collision victim: a RUNNING terminal of a DIFFERENT provider
    // (codex) whose registry row carries the SAME resume session id — the
    // opaque-id collision. It is not part of this handoff in any way.
    let codex_terminal = format!("f6-codex-collision-{}", uuid::Uuid::new_v4().simple());
    rig.registry
        .register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: codex_terminal.clone(),
            stream_id: codex_terminal.clone(),
            mode: "codex".to_string(),
            resume_session_id: Some(sid.clone()),
            create_request_id: None,
            created_at: None,
        });
    assert!(
        rig.registry
            .probe(&codex_terminal)
            .is_some_and(|row| row.status == freshell_protocol::TerminalRunStatus::Running),
        "the different-provider terminal must be Running before the handoff"
    );

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof (the 5d pattern): the settle PUBLISHED the spawned
    // terminal, then parked at the seam.
    let target_terminal = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(watch) = hooks.spawn_watch_slot.lock().unwrap().clone() {
                if let Some(terminal_id) = watch.published_terminal() {
                    break terminal_id;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the settle never published the spawned terminal"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };

    // ABORT inside the target-spawn await.
    handle.abort();
    let _ = handle.task.await;
    pause.notify_one();

    // The uncommitted CLAUDE target is reaped — no claude row may hold the
    // canonical sessionRef once the cleanup's sweep has settled.
    await_cond("the uncommitted claude target must be reaped", || {
        rig.registry.terminal_is_dead(&target_terminal)
    })
    .await;
    await_cond(
        "the sweep must clear every claude row for the session",
        || {
            !rig.registry.directory().into_iter().any(|entry| {
                entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(sid.as_str())
            })
        },
    )
    .await;
    // b8ke focused round-3 R3-6: the deferred cleanup settled — the key
    // vacated only after the uncommitted target's reap completed.
    await_cond("the settled cleanup must leave the key Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    // The sweep is the cleanup task's last step — a short settle before the
    // survival read keeps the assertion race-free.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // THE F6 ASSERTION: the different-provider terminal with the SAME
    // session id is untouched — still registered, still Running.
    assert!(
        rig.registry
            .probe(&codex_terminal)
            .is_some_and(|row| row.status == freshell_protocol::TerminalRunStatus::Running),
        "the same-id different-provider (codex) terminal must survive the claude handoff's abort cleanup"
    );

    // The key reopens (not wedged).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "post-abort-probe",
            None,
            "test",
            0,
        ),
        BeginOutcome::Granted { .. }
    ));
    let _ = rig
        .ownership
        .fail("claude", &sid, "post-abort-probe", 1, false);
    let _ = env;
}

/// 5e. Target-spawn window, fresh arm (round-3 review I-1): an abort landing
/// inside the fresh-target resume await — parked right AFTER the target
/// session registered — must reap the registered-but-uncommitted session
/// (the dropped resume skipped its in-function cleanup) and must not leak
/// the lane's `resuming` single-flight flag: a retry of the same handoff
/// succeeds.
#[tokio::test]
async fn handoff_abort_during_fresh_target_resume_reaps_the_registered_session_and_keeps_retryability(
) {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir = std::env::temp_dir().join(format!(
        "freshell-handoff-abort-fresh-store-{}",
        uuid_like_suffix()
    ));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let resume_pause = Arc::new(tokio::sync::Notify::new());
    let mut rig = build_rig_with_claude_pauses(None, None, Some(Arc::clone(&resume_pause)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    // Park proof: the prior was reaped (its sidecar is dead) and the TARGET
    // resume registered its session (the park is right after registration —
    // the resume cannot pass it).
    await_pid_dead(prior_pid).await;
    await_live_session(
        &rig.fresh_claude,
        &sid,
        true,
        "the target resume must register its session",
    )
    .await;

    // ABORT inside the fresh-target resume await.
    handle.abort();
    let _ = handle.task.await;

    // The registered-but-uncommitted target session was reaped by the
    // cleanup's lane sweep — no live unowned writer.
    await_live_session(
        &rig.fresh_claude,
        &sid,
        false,
        "the uncommitted target session must be reaped",
    )
    .await;
    // The target sidecar's process is dead too (the sweep's teardown).
    let target_pid = env
        .create_rows()
        .into_iter()
        .filter(|r| r["msg"]["resumeSessionId"] == sid)
        .filter_map(|r| r["pid"].as_u64())
        .find(|pid| *pid != prior_pid as u64)
        .expect("the target sidecar's create row") as u32;
    await_pid_dead(target_pid).await;
    // b8ke focused round-3 R3-6: the deferred cleanup settled (the target
    // reap completed), and only THEN did the key vacate — the prior was
    // reaped, so the ending is Vacant.
    await_cond("the settled cleanup must leave the key Vacant", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // Retryability (the `resuming` flag did not leak): a retry of the same
    // handoff succeeds — it registers (parking at the same seam), the test
    // releases it, and the runner commits.
    let retry = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    await_live_session(
        &rig.fresh_claude,
        &sid,
        true,
        "the retry must register its session",
    )
    .await;
    resume_pause.notify_one();
    let result = retry.completion.await.expect("retry completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the retry must succeed: {result}"
    );
    assert_eq!(result["owner"]["sessionId"], json!(sid));

    // Cleanup: the runner retained the stamp — the lane kill works.
    let _ = rig
        .fresh_claude
        .kill_for_handoff(&sid, "test-cleanup")
        .await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
}

/// b8ke ext r27 F2 (the Claude target arm): the under-ticket target
/// resume's session-init adoption stamps its durable binding row with the
/// SUPPLIED handoff (epoch, generation) pair — pre-r27 the under-ticket
/// adoption held no own ticket (the runner performs the ONE commit), so
/// the write carried a None generation, the target row preserved the
/// PRIOR generation, and a delayed prior-generation write could pass the
/// ledger's comparison and replace the new owner's recovery metadata.
#[tokio::test]
async fn the_claude_handoff_target_binding_carries_the_handoff_generation() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface is process-global (see the pattern above).
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-r27-f2-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let mut rig = build_rig(None);
    // The sink wired BEFORE the seed below; the establish's own
    // all-blank adoption writes NOTHING (the V7 no-laundering gate), so
    // the ONLY binding row is the handoff target's.
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    rig.fresh_claude.set_identity_sink(fake.clone());
    establish_fresh_claude_owner(&mut rig, &sid).await;
    assert!(
        fake.bindings.lock().unwrap().is_empty(),
        "fixture: the all-blank establish wrote no binding row"
    );
    // Seed the settings record so the TARGET resume's create carries
    // non-default settings — its session-init adoption's binding write is
    // recordable (the settings-bearing row).
    fake.seed(
        "claude",
        &sid,
        crate::identity_sink::FreshAgentSettings {
            model: Some("opus-x".into()),
            sandbox: None,
            permission_mode: Some("plan".into()),
            effort: Some("high".into()),
            cwd: None,
        },
    );

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    let result = handle
        .completion
        .await
        .expect("the handoff runner completed");
    assert_eq!(result["ok"], json!(true), "the handoff commits: {result}");
    let committed_generation = {
        let snap = rig.ownership.observe("claude", &sid);
        assert!(matches!(snap.state, OwnershipState::Live { .. }));
        snap.generation
    };

    // The target resume's sidecar init adoption writes the binding row
    // (async to the runner's commit) — bounded-poll until it lands.
    // DEFLAKE (wait-depth): the loop previously broke on ANY matching row,
    // but an interim unfenced row (observed pair None) can land FIRST —
    // the runner's under-ticket adoption (the row this test asserts on)
    // follows it. Poll for the SETTLED row — one stamped with the supplied
    // handoff pair — so the assertions below never read an interim row.
    // The r27 regression shape (the adoption writing None and never the
    // pair) still fails here at the deadline, with the full dump.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if fake.bindings.lock().unwrap().iter().any(|b| {
            b.provider == "claude"
                && b.session_id == sid
                && b.mode == "freshclaude"
                && b.observed_epoch == Some(rig.ownership.boot_epoch())
                && b.observed_generation == Some(committed_generation)
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the under-ticket adoption never stamped its binding row with the supplied \
             handoff pair — bindings: {:?}",
            fake.bindings.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    {
        let bindings = fake.bindings.lock().unwrap();
        let target_binding = bindings
            .iter()
            .rev()
            .find(|b| b.provider == "claude" && b.session_id == sid && b.mode == "freshclaude")
            .expect("the target binding row");
        assert_eq!(
            target_binding.observed_epoch,
            Some(rig.ownership.boot_epoch()),
            "the under-ticket adoption stamps the boot epoch"
        );
        assert_eq!(
            target_binding.observed_generation,
            Some(committed_generation),
            "the under-ticket adoption stamps the SUPPLIED handoff generation — \
             pre-r27 it carried None (the adoption holds no own ticket)"
        );
        // b8ke focused ep5 r2 F1: the under-ticket target binding carries
        // the AUTHORITATIVE marker (the handoff runner's own target
        // binding — the ledger's terminal-row guard accepts it over the
        // prior terminal's normal UNSTAMPED row).
        assert!(
            target_binding.authoritative,
            "the under-ticket target binding is the runner's authoritative write: \
             {target_binding:?}"
        );
    }

    // Cleanup: the runner retained the stamp — the lane kill works.
    let _ = rig
        .fresh_claude
        .kill_for_handoff(&sid, "test-cleanup")
        .await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
    let _ = env;
}

/// b8ke ext r27 F3: a handoff whose TERMINAL target's durable identity
/// registration FAILS answers the TYPED recoverable handoff failure —
/// never a successful owner + Live{Terminal} commit with no recoverable
/// target registration. The spawned target is reaped, the prior was
/// already reaped so the key ends Vacant (never restoring a dead
/// runtime), and the failure names the binding's typed code.
#[tokio::test]
async fn a_terminal_target_binding_failure_fails_the_handoff_typed() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface is process-global (see the pattern above).
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-r27-f3-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    // The rig whose runner's terminal-target registration ALWAYS fails.
    let mut rig =
        build_rig_with_pane_identity_binder(std::sync::Arc::new(FailingCreateIdentityBinder));
    establish_fresh_claude_owner(&mut rig, &sid).await;

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    let result = handle
        .completion
        .await
        .expect("the handoff runner completed");

    // THE TYPED RECOVERABLE FAILURE — never `ok: true` over a target
    // with no recoverable registration.
    assert_eq!(
        result["ok"],
        json!(false),
        "the handoff fails typed: {result}"
    );
    assert_eq!(
        result["error"]["code"],
        json!("TARGET_SPAWN_FAILED"),
        "the start-target failure answers the runner's typed code: {result}"
    );
    assert!(
        result["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("TARGET_BINDING_FAILED"),
        "the failure's message names the binding's typed code (the spawn's \
         typed envelope, not a Debug dump): {result}"
    );
    assert_eq!(result["error"]["retryable"], json!(true), "{result}");

    // NO Live commit: the prior was reaped, the target was never committed
    // — the key ends Vacant (the typed recoverable state; never a dead
    // runtime restored as Live).
    await_cond("the key must end Vacant (no Live commit)", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;

    // The spawned target terminal was reaped — no live claude-mode
    // terminal row for the session survives the failed handoff.
    await_cond("the failed target terminal must be reaped", || {
        !rig.registry.directory().into_iter().any(|entry| {
            entry.mode == "claude" && entry.resume_session_id.as_deref() == Some(sid.as_str())
        })
    })
    .await;

    // The key reopens (not wedged).
    assert!(matches!(
        rig.ownership.begin_start(
            "claude",
            &sid,
            RuntimeOwnerKind::Terminal,
            "post-failure-probe",
            None,
            "test",
            0,
        ),
        BeginOutcome::Granted { .. }
    ));

    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
    let _ = env;
}

/// 5g. b8ke focused round-3 review R3-6: an abort inside the fresh-target
/// window must HOLD the coordinator fence until the uncommitted target's
/// `NotConfirmed` continuation settles — the global record does not go
/// plain-Vacant while an uncommitted target may live. A competing start
/// DURING the continuation is Blocked; after the settle/confirm the key
/// goes Vacant and the start proceeds. (Pre-fix, the sync Drop fail
/// vacated the record BEFORE the detached cleanup even issued its lane
/// kill — the competing start was Granted over the uncommitted target.)
#[tokio::test]
async fn handoff_abort_holds_the_fence_until_the_uncommitted_target_continuation_settles() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir =
        std::env::temp_dir().join(format!("freshell-handoff-r36-store-{}", uuid_like_suffix()));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let resume_pause = Arc::new(tokio::sync::Notify::new());
    // The one-round confirmation window: the cleanup's lane kill cannot
    // confirm the target tree while a TERM-immune tagged descendant lives
    // — the NotConfirmed continuation shape.
    let mut rig = build_rig_full(None, None, Some(Arc::clone(&resume_pause)), 8_000, Some(1));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let prior_pid = env.sidecar_pid_for(&sid).expect("the prior sidecar's pid");

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    // Park proof: the prior was reaped and the TARGET resume registered its
    // session (the park is right after registration).
    await_pid_dead(prior_pid).await;
    await_live_session(
        &rig.fresh_claude,
        &sid,
        true,
        "the target resume must register its session",
    )
    .await;
    // The TARGET sidecar's ownership tag, and a TERM-immune tagged
    // grandchild parked under it: the cleanup's kill cannot confirm the
    // tree in its one-round window, so it answers NotConfirmed and the
    // escalation continuation runs (SIGKILL rounds ≥500ms later).
    let target_pid = env
        .create_rows()
        .into_iter()
        .filter(|r| r["msg"]["resumeSessionId"] == sid)
        .filter_map(|r| r["pid"].as_u64())
        .find(|pid| *pid != prior_pid as u64)
        .expect("the target sidecar's create row") as u32;
    let ownership_id = {
        let environ = std::fs::read(format!("/proc/{target_pid}/environ"))
            .expect("read the target sidecar's environ");
        environ
            .split(|&b| b == 0)
            .find_map(|var| {
                let var = std::str::from_utf8(var).ok()?;
                var.strip_prefix("FRESHELL_CLAUDE_SIDECAR_ID=")
            })
            .expect("the target sidecar's ownership id")
            .to_string()
    };
    let mut grandchild = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("trap '' TERM; while :; do sleep 1; done")
        .env("FRESHELL_CLAUDE_SIDECAR_ID", &ownership_id)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the lingering tagged grandchild");
    let grandchild_pid = grandchild.id().expect("grandchild pid");

    // ABORT inside the fresh-target resume await.
    handle.abort();
    let _ = handle.task.await;

    // THE R3-6 regression: the record did NOT go plain-Vacant — the
    // cleanup's target reap (its NotConfirmed continuation) is still in
    // flight, and a competing start is BLOCKED throughout it.
    let assert_blocked = |label: &str| {
        assert!(
            matches!(
                rig.ownership.begin_start(
                    "claude",
                    &sid,
                    RuntimeOwnerKind::Terminal,
                    "r36-competing-start",
                    None,
                    "test",
                    0,
                ),
                BeginOutcome::Blocked { .. }
            ),
            "a competing start {label} must be Blocked (the fence holds while the \
             uncommitted target's continuation runs)"
        );
    };
    assert_blocked("immediately after the abort");
    // The cleanup's lane kill ran and entered its continuation: the
    // target's direct child dies while the TERM-immune grandchild needs
    // the escalation — the continuation is observably in flight.
    await_pid_dead(target_pid).await;
    assert_blocked("during the uncommitted target's continuation");

    // The escalation settles: the grandchild dies, the continuation
    // resolves, and the key goes Vacant — the competing start proceeds.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while crate::session_lease::proc_starttime(grandchild_pid as i32).is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the cleanup's escalation never killed the lingering descendant"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    await_cond("the settled continuation must vacate the key", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    assert!(
        matches!(
            rig.ownership.begin_start(
                "claude",
                &sid,
                RuntimeOwnerKind::Terminal,
                "r36-competing-start-after",
                None,
                "test",
                0,
            ),
            BeginOutcome::Granted { .. }
        ),
        "after the settle/confirm the competing start proceeds"
    );
    let _ = rig
        .ownership
        .fail("claude", &sid, "r36-competing-start-after", 1, false);
    let _ = grandchild.wait().await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
}

/// 7a. b8ke focused round-5 review R5-1: a handoff that legitimately
/// started from VACANT and is aborted while its fresh target is
/// registering must fence with the TYPED separation, never the folded
/// watcher-less WatcherFailed the pre-fix no-prior arm produced for BOTH
/// outcomes — a PlatformLimited target teardown (the non-Linux shape,
/// driven here through the R2-3 lane seam) fences TYPED PlatformLimited,
/// which the r4 acknowledged force-clear recovers (pre-fix it was
/// WatcherFailed: `force_release_platform_limited` matched nothing and
/// the session blocked until a server restart).
///
/// R5-2: the abort-cleanup fence transition BROADCASTS the authoritative
/// state — the fenced marker, the typed reason, and the no-prior fence's
/// vacant ownerKind — so connected devices converge without a reconnect
/// (pre-fix: no frame at all; the stale handoff-started record lingered).
#[tokio::test]
async fn an_aborted_from_vacant_platform_limited_target_fences_typed_and_recovers() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir = std::env::temp_dir().join(format!(
        "freshell-handoff-r54a-store-{}",
        uuid_like_suffix()
    ));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let resume_pause = Arc::new(tokio::sync::Notify::new());
    // The R2-3 platform-limited lane seam: the target teardown answers
    // PlatformLimited (the non-Linux shape) on Linux for this red/green.
    let mut rig = build_rig_with_options(
        None,
        None,
        Some(Arc::clone(&resume_pause)),
        8_000,
        None,
        true,
    );
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // FROM VACANT: no establish — the key has no owner; the handoff
    // begins from a vacant key (prior = None).
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    // The target resume registered its session (the park point).
    await_live_session(
        &rig.fresh_claude,
        &sid,
        true,
        "the from-vacant target resume must register its session",
    )
    .await;

    // ABORT inside the target-resume await: the cleanup's lane kill
    // answers PlatformLimited and the NO-PRIOR arm fences.
    handle.abort();
    let _ = handle.task.await;

    // R5-1: the fence is TYPED PlatformLimited (pre-fix: the folded
    // WatcherFailed the force-clear can never release).
    // b8ke ext r8 F6: the fence names the unconfirmed TARGET (the
    // resumed session's identity — pre-r8 it defaulted to the Handoff
    // record's prior: vacant on a from-vacant handoff, naming nothing
    // while the potentially live target went unnamed).
    let snap = rig.ownership.observe("claude", &sid);
    assert!(
        matches!(
            &snap.state,
            OwnershipState::Fenced {
                reason: FenceReason::PlatformLimited,
                prior: Some((owner, _)),
                ..
            } if owner.kind == RuntimeOwnerKind::FreshAgent
                && owner.live_session_key.as_deref() == Some(sid.as_str())
        ),
        "the aborted from-vacant handoff's PlatformLimited target must fence \
         TYPED PlatformLimited naming the TARGET, got {:?}",
        snap.state
    );

    // R5-2: the fence transition BROADCASTS — fenced marker + typed
    // reason + the TARGET's ownerKind (pre-fix: no frame; pre-r8 the
    // frame said vacant).
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        failed["fenced"],
        json!(true),
        "the abort-cleanup fence frame carries the fenced marker: {failed}"
    );
    assert_eq!(failed["reason"], json!("platform-limited"));
    assert_eq!(
        failed["ownerKind"],
        json!("fresh-agent"),
        "the abort-cleanup fence names the unconfirmed TARGET's kind: {failed}"
    );

    // THE R5-1 recovery: the r4 acknowledged force-clear releases the
    // typed PlatformLimited fence (pre-fix: force_release_platform_
    // limited matched nothing — SESSION_FENCED, blocked until restart).
    let mut clear = handoff_req_fresh("claude", &sid, "freshclaude");
    clear.action = HandoffAction::ClearStaleBookkeeping;
    clear.observed_epoch = Some(snap.epoch);
    clear.observed_generation = Some(snap.generation);
    let clear_handle = rig.runner.spawn_handoff(clear);
    let cleared = clear_handle
        .completion
        .await
        .expect("force-clear completed");
    assert_eq!(
        cleared["ok"],
        json!(true),
        "the typed PlatformLimited fence is force-clear recoverable: {cleared}"
    );
    assert_eq!(cleared["cleared"], json!("platform-limited-fence"));
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                reason: FenceReason::ClearedUnverified,
                ..
            }
        ),
        "the force-cleared key sits in the TYPED cleared-unverified state \
         (b8ke ext r16 F4 — never plain Vacant)"
    );
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
}

/// 7b. b8ke focused round-5 review R5-1: the aborted from-vacant handoff's
/// UNCONFIRMED target (the lane kill's NotConfirmed continuation LOST —
/// the drop-confirmation test seam) fences WITH the replacement
/// confirmation watcher (the r2/e3887a378 pattern): the watcher's bounded
/// probe re-issues the target's recorded-identity kill-and-confirm, and
/// ONLY the confirmed death (the lingering TERM-immune grandchild killed)
/// releases the fence to Vacant + broadcasts `released`. Pre-fix the
/// no-prior arm produced a WATCHER-LESS WatcherFailed fence — the key
/// blocked until a server restart.
#[tokio::test]
async fn an_aborted_from_vacant_unconfirmed_target_fences_with_a_replacement_watcher() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume gates on transcript presence (the 6b pattern).
    let store_dir = std::env::temp_dir().join(format!(
        "freshell-handoff-r54b-store-{}",
        uuid_like_suffix()
    ));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let resume_pause = Arc::new(tokio::sync::Notify::new());
    let hooks = Arc::new(HandoffTestHooks {
        drop_abort_target_confirmation_once: std::sync::atomic::AtomicBool::new(true),
        ..HandoffTestHooks::default()
    });
    // The one-round confirmation window: the lane kill cannot confirm the
    // target tree while the TERM-immune tagged descendant lives — the
    // NotConfirmed shape; the armed seam then DROPS the continuation.
    let mut rig = build_rig_with_options(
        Some(Arc::clone(&hooks)),
        None,
        Some(Arc::clone(&resume_pause)),
        8_000,
        Some(1),
        false,
    );
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // FROM VACANT (no establish): the freshclaude target resume registers.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "freshclaude"));
    await_live_session(
        &rig.fresh_claude,
        &sid,
        true,
        "the from-vacant target resume must register its session",
    )
    .await;
    // The TARGET sidecar's ownership tag + a TERM-immune tagged grandchild
    // parked under it (the R3-6 pattern): the lane kill's one-round window
    // cannot confirm, and the dropped continuation leaves it lingering.
    let target_pid = env
        .create_rows()
        .into_iter()
        .filter(|r| r["msg"]["resumeSessionId"] == sid)
        .filter_map(|r| r["pid"].as_u64())
        .find(|pid| *pid != 0)
        .expect("the target sidecar's create row") as u32;
    let ownership_id = {
        let environ = std::fs::read(format!("/proc/{target_pid}/environ"))
            .expect("read the target sidecar's environ");
        environ
            .split(|&b| b == 0)
            .find_map(|var| {
                let var = std::str::from_utf8(var).ok()?;
                var.strip_prefix("FRESHELL_CLAUDE_SIDECAR_ID=")
            })
            .expect("the target sidecar's ownership id")
            .to_string()
    };
    let mut grandchild = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("trap '' TERM; while :; do sleep 1; done")
        .env("FRESHELL_CLAUDE_SIDECAR_ID", &ownership_id)
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the lingering tagged grandchild");
    let grandchild_pid = grandchild.id().expect("grandchild pid");

    // ABORT inside the fresh-target resume await; the cleanup's lane kill
    // answers NotConfirmed and the armed seam DROPS the continuation.
    handle.abort();
    let _ = handle.task.await;

    // The fence is typed (never plain Vacant, never Reaped) — and R5-2:
    // the fence transition is BROADCAST with the marker + reason.
    // b8ke ext r8 F6: the fence names the unconfirmed TARGET (the
    // resumed session's identity — pre-r8 the from-vacant fence said
    // vacant while the target went unnamed).
    await_cond("the unconfirmed target must fence the key", || {
        matches!(
            &rig.ownership.observe("claude", &sid).state,
            OwnershipState::Fenced {
                prior: Some((owner, _)),
                ..
            } if owner.kind == RuntimeOwnerKind::FreshAgent
                && owner.live_session_key.as_deref() == Some(sid.as_str())
        )
    })
    .await;
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(failed["fenced"], json!(true), "the fence frame: {failed}");
    assert_eq!(failed["reason"], json!("watcher-failed"));
    assert_eq!(failed["ownerKind"], json!("fresh-agent"));

    // THE R5-1 replacement watcher: its bounded probe re-issues the
    // recorded-identity kill-and-confirm — the lingering grandchild is
    // killed, the death is CONFIRMED, and only then the fence releases to
    // Vacant + the corrective `released` broadcast (RUNNER_ABORTED).
    // Pre-fix (watcher-less): the grandchild lingers and the key stays
    // fenced forever.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while crate::session_lease::proc_starttime(grandchild_pid as i32).is_some() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the replacement confirmation watcher never killed the lingering \
             unconfirmed-target descendant — a watcher-less fence"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    await_cond("the watcher-confirmed death must release the fence", || {
        rig.ownership.observe("claude", &sid).state == OwnershipState::Vacant
    })
    .await;
    let frames = await_owner_frames(&mut rig.rx, &["released"]).await;
    let released = runtime_owner_frame(&frames, "released");
    assert_eq!(
        released["reason"],
        json!("RUNNER_ABORTED"),
        "the watcher's release names the abort: {released}"
    );
    let _ = grandchild.wait().await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = std::fs::remove_dir_all(&store_dir);
}

/// 7c. b8ke focused round-5 review R5-2: the abort-cleanup RESTORE arm
/// broadcasts the authoritative owner too — an abort with a live prior
/// restores it, and the devices holding the stale handoff-started record
/// receive the corrective handoff-failed frame naming the RESTORED owner
/// (pre-fix: nothing on the bus until a reconnect).
#[tokio::test]
async fn an_abort_cleanup_broadcasts_the_restored_prior_owner() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    let hooks = Arc::new(HandoffTestHooks {
        pause_after_enter: Some(tokio::sync::Notify::new()),
        ..HandoffTestHooks::default()
    });
    let mut rig = build_rig(Some(Arc::clone(&hooks)));
    establish_fresh_claude_owner(&mut rig, &sid).await;
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &sid, "claude"));
    // Park proof: the started broadcast, so the abort lands mid-Handoff.
    let _started = await_owner_frame(&mut rig.rx, "handoff-started").await;
    handle.abort();
    let _ = handle.task.await;

    // The restored prior is the authoritative owner.
    await_cond("the aborted handoff must restore the live prior", || {
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Live { .. }
        )
    })
    .await;
    // R5-2: the corrective frame names the RESTORED owner (the fresh-agent
    // prior) with the typed abort reason — no reconnect needed.
    let frames = await_owner_frames(&mut rig.rx, &["handoff-failed"]).await;
    let failed = runtime_owner_frame(&frames, "handoff-failed");
    assert_eq!(
        failed["ownerKind"],
        json!("fresh-agent"),
        "the abort-cleanup frame names the restored prior: {failed}"
    );
    assert_eq!(failed["reason"], json!("RUNNER_ABORTED"));
    assert!(
        failed.get("fenced").is_none() || failed["fenced"] == Value::Null,
        "the restore arm is NOT fenced: {failed}"
    );
}

/// The fake sidecar's durable id for a create with NO resumeSessionId
/// (the fresh-create fallback in FAKE_CLAUDE_SIDECAR_SOURCE).
const FRESH_CREATE_DURABLE_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn fresh_create_msg(session_type: SessionType) -> FreshAgentCreate {
    FreshAgentCreate {
        naming_handle: None,
        request_id: format!("handoff-create-fresh-{}", uuid::Uuid::new_v4()),
        session_type,
        cwd: Some("/tmp".to_string()),
        effort: None,
        legacy_restore_context: None,
        model: None,
        model_selection: None,
        observed_epoch: None,
        observed_generation: None,
        permission_mode: None,
        plugins: None,
        provider: Some(AgentProvider::Claude),
        resume_session_id: None,
        sandbox: None,
        // b8ke delta round-2 F1: the ORDINARY create — NO explicit
        // sessionRef. The durable id materializes at sdk.session.init
        // (the pre-fix tests all created with an explicit sessionRef,
        // masking the no-adoption defect).
        session_ref: None,
        tab_id: None,
    }
}

/// 8c. b8ke focused episode-2 round-2 F1: a handoff addressing a
/// SUPERSEDED durable id (a stale pane's sessionRef after a rollback fork
/// re-keyed the session) resolves through the lane's re-key alias map to
/// the CANONICAL coordinator key — the runner enters Handoff on the key
/// that holds the prior owner, stops it, and transfers atomically.
/// Pre-fix the runner passed the wire id straight to begin_handoff: the
/// canonical key read Vacant, no prior was captured, the sidecar was never
/// stopped, and the terminal target started beside the live Fresh Agent
/// (the split-identity two-writer shape).
#[tokio::test]
async fn a_handoff_on_a_superseded_rekeyed_id_resolves_the_canonical_owner() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let canonical = uuid::Uuid::new_v4().to_string();
    let superseded = uuid::Uuid::new_v4().to_string();
    let mut rig = build_rig(None);
    // The pre-rekey truth: the live owner sits under the OLD durable id
    // (the superseded name). The kill handle / sidecar pid resolve through
    // the OLD name.
    establish_fresh_claude_owner(&mut rig, &superseded).await;
    let sidecar_pid = env.sidecar_pid_for(&superseded);
    assert!(sidecar_pid.is_some(), "the live owner's sidecar pid");

    // The rollback's re-key in the FULL production sequence: (1) the fork
    // adoption publishes the re-key bookkeeping at the LANE level (the
    // preseed publication: cli_index[new] = map key + the session's
    // cli_session_id = new — the same write adopt_session_init performs
    // for the supersedes-carrying preseed), then (2) the registry's own
    // rekey_live performs the atomic old→new coordinator move (the same
    // step the rollback's Adopt-path commit performs), leaving
    // Aliased{to: canonical} at the superseded key — the COORDINATOR as
    // the single source of truth (e2r3 F3). Pre-fix this id pair was a
    // lane-local HashMap nobody hydrated.
    // (1) The fork adoption's publication — the REAL lane-level re-key
    // bookkeeping (cli_index[new] = map key + the session's
    // cli_session_id = new), driven through the adoption itself exactly
    // like the rollback's preseed arm.
    {
        let map_key = rig
            .fresh_claude
            .test_resolve_session_key(&superseded)
            .await
            .expect("the live session's map key");
        rig.fresh_claude
            .test_adopt_session_init(&canonical, &map_key, "freshclaude", Some(&superseded))
            .await;
    }
    // (2) The registry's own rekey_live performs the atomic old→new
    // coordinator move (the same step the rollback's Adopt-path commit
    // performs), leaving Aliased{to: canonical} at the superseded key —
    // the COORDINATOR as the single source of truth (e2r3 F3).
    let rekey_map_key = rig
        .fresh_claude
        .test_resolve_session_key(&superseded)
        .await
        .expect("the live session's map key");
    assert!(matches!(
        rig.ownership.rekey_live(
            "claude",
            &superseded,
            &canonical,
            &rekey_map_key,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(rekey_map_key.clone()),
                pid: sidecar_pid,
                ownership_id: Some("test-rekey-op".into()),
            },
            "test-rekey",
            "test-rekey-op",
        ),
        freshell_ownership::CommitOutcome::Committed
    ));

    // THE e2r2 F1 red/green: the handoff on the SUPERSEDED id resolves the
    // canonical key and stops the prior owner.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_terminal("claude", &superseded, "claude"));
    let result = handle.completion.await.expect("handoff completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the superseded-id handoff must resolve and succeed: {result}"
    );
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    // The CANONICAL key carries the terminal owner (never the wire id).
    match rig.ownership.observe("claude", &canonical).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected the committed terminal owner, got {other:?}"),
    }
    // The SUPERSEDED key holds only the Aliased residue (never an
    // operation key).
    assert!(matches!(
        rig.ownership.observe("claude", &superseded).state,
        OwnershipState::Aliased { .. }
    ));
    // The prior's sidecar is dead (the resolved handoff stopped it).
    if let Some(pid) = sidecar_pid {
        await_pid_dead(pid).await;
    }
    rig.registry.kill(&terminal_id);
}

/// 8a. b8ke delta round-2 F1: a NORMALLY created freshclaude session (no
/// explicit sessionRef) adopts the canonical key at `sdk.session.init` —
/// the coordinator holds authoritative Live{FreshAgent} under the durable
/// id, every device receives the owner broadcast, and a handoff to the CLI
/// sees the prior owner, STOPS it (the sidecar is reaped), and transfers
/// atomically. Pre-fix: the coordinator saw Vacant (no prior — the sidecar
/// was never stopped), the handoff "succeeded" over a live second writer,
/// and no owner frame ever reached the bus.
#[tokio::test]
async fn a_fresh_created_claude_session_adopts_the_canonical_key_and_hands_off_atomically() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let mut rig = build_rig(None);
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    // The ORDINARY create: no sessionRef, no resume id.
    rig.fresh_claude
        .handle_create(fresh_create_msg(SessionType::Freshclaude), None)
        .await;

    // THE F1 ADOPTION: the durable id minted at sdk.session.init becomes
    // the authoritative Live{FreshAgent} owner. Pre-fix: the key stayed
    // Vacant forever (this await is the red).
    await_cond(
        "the fresh-created session must adopt the canonical key",
        || {
            matches!(
                rig.ownership
                    .observe("claude", FRESH_CREATE_DURABLE_ID)
                    .state,
                OwnershipState::Live { owner, .. }
                    if owner.kind == RuntimeOwnerKind::FreshAgent
            )
        },
    )
    .await;

    // The authoritative owner record reached the bus (cross-device
    // convergence; pre-fix no frame ever named this owner).
    let frames = await_owner_frames(&mut rig.rx, &["handoff-committed"]).await;
    let committed = frames
        .iter()
        .find(|f| {
            f["transition"] == "handoff-committed"
                && f["ownerKind"] == "fresh-agent"
                && f["sessionId"] == json!(FRESH_CREATE_DURABLE_ID)
        })
        .expect("the adoption's authoritative owner frame");
    assert_eq!(committed["provider"], json!("claude"));

    // The sidecar process serving the fresh create (the handoff must reap
    // it — pre-fix it was never stopped).
    let sidecar_pid = env
        .create_rows()
        .last()
        .and_then(|r| r["pid"].as_u64())
        .expect("the fresh create's sidecar pid") as u32;

    // THE F1 HANDOFF: freshclaude → terminal over the durable id. Post-fix
    // the runner sees the prior owner, stops the sidecar, and transfers
    // atomically. Pre-fix: prior=None (Vacant) — the handoff committed a
    // terminal over the LIVE sidecar (two writers).
    let handle = rig.runner.spawn_handoff(handoff_req_terminal(
        "claude",
        FRESH_CREATE_DURABLE_ID,
        "claude",
    ));
    let result = handle.completion.await.expect("handoff completed");
    assert_eq!(
        result["ok"],
        json!(true),
        "the from-fresh-create handoff must succeed: {result}"
    );
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig
        .ownership
        .observe("claude", FRESH_CREATE_DURABLE_ID)
        .state
    {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected the committed terminal owner, got {other:?}"),
    }
    // The sidecar was STOPPED (the prior owner's confirmed reap).
    await_pid_dead(sidecar_pid).await;
    rig.registry.kill(&terminal_id);
}

/// 8b. b8ke delta round-2 F1 (kilroy): the ORDINARY create shares the
/// claude lane — a fresh-created KILROY session adopts the canonical key
/// at `sdk.session.init` the same way (the ownership machinery is
/// flavor-independent).
#[tokio::test]
async fn a_fresh_created_kilroy_session_adopts_the_canonical_key() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let mut rig = build_rig(None);
    let _ = drain_runtime_owner_frames(&mut rig.rx);

    rig.fresh_claude
        .handle_create(fresh_create_msg(SessionType::Kilroy), None)
        .await;

    await_cond(
        "the fresh-created kilroy session must adopt the canonical key",
        || {
            matches!(
                rig.ownership
                    .observe("claude", FRESH_CREATE_DURABLE_ID)
                    .state,
                OwnershipState::Live { owner, .. }
                    if owner.kind == RuntimeOwnerKind::FreshAgent
            )
        },
    )
    .await;
}

/// 6. opencode: handoff never kills the shared serve and never changes the
/// id. The serve manager instance is the SAME before/after (exactly one
/// serve pid across both handoffs — a restart would add one); the `ses_*`
/// id is unchanged in every coordinator record and response.
#[tokio::test]
async fn opencode_handoff_keeps_shared_serve_alive_and_session_id_stable() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    let sid = format!("ses_handoff_{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // Fresh owner: a durable opencode session, registered through the shared
    // serve (the attach-resume lane — get_session on the fake serve answers).
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    // The shared serve is up (exactly one pid so far).
    env.await_audit_row(Duration::from_secs(20), |r| r["event"] == "listen")
        .await;
    assert_eq!(env.serve_pids().len(), 1, "one shared serve instance");

    // Handoff opencode -> terminal (mode opencode: the CLI mode that resumes
    // `ses_*` ids — a mismatched mode would fail the session-ID preservation
    // check by design).
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", &sid, "opencode"));
    let result = to_terminal.completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    // (The terminal-owner response carries terminalId+mode; the canonical
    // ses_* id is proven by the coordinator record below — and by the
    // runner's own session-ID preservation check, which already had to pass
    // for the spawn to be accepted.)
    match rig.ownership.observe("opencode", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected Live terminal owner, got {other:?}"),
    }

    // Handoff BACK to freshopencode — through the SAME shared serve.
    let back = rig
        .runner
        .spawn_handoff(handoff_req_fresh("opencode", &sid, "freshopencode"));
    let result = back.completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff back to fresh: {result}");
    assert_eq!(
        result["owner"]["sessionId"],
        json!(sid),
        "the ses_* id is unchanged in the response"
    );
    match rig.ownership.observe("opencode", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
            assert_eq!(
                owner.live_session_key.as_deref(),
                Some(sid.as_str()),
                "the coordinator record keeps the canonical ses_* id"
            );
        }
        other => panic!("expected Live fresh owner, got {other:?}"),
    }

    // The serve manager instance is the SAME before/after: no restart, no
    // kill — exactly ONE serve pid across both handoffs, and its health
    // endpoint kept answering (the audit rows below prove liveness).
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );
    let health_pid = env
        .await_audit_row(Duration::from_secs(10), |r| r["path"] == "/global/health")
        .await["pid"]
        .as_u64()
        .expect("health probe pid");
    assert_eq!(
        env.serve_pids(),
        vec![health_pid],
        "the health-check probes kept hitting the SAME live serve instance"
    );

    // Cleanup: kill the resumed session's lane bookkeeping (never the serve)
    // — the runner retained the stamp, so the lane kill path works.
    let _ = rig
        .fresh_opencode
        .opencode_kill_for_handoff(&sid, "test-cleanup")
        .await;
}

/// b8ke ext r23 F1: a handoff addressed by the pane's PERSISTED
/// `freshopencode-*` placeholder resolves through the coordinator's
/// alias chain to the DURABLE `ses_*` key and operates there — the
/// prior names the actual durable owner (never a vacant-key skip),
/// the durable owner is stopped, and the handoff completes on the
/// durable key. Pre-F1 the placeholder was NOT resolved: the handoff
/// entered on the vacant placeholder key (prior None), the durable
/// owner was never stopped, and the target resume of the placeholder
/// failed.
#[tokio::test]
async fn an_opencode_placeholder_handoff_resolves_the_durable_owner_and_completes() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    let durable_id = format!("ses_r23f1_{}", uuid::Uuid::new_v4().simple());
    let placeholder_id = format!("freshopencode-req-r23f1-{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // The DURABLE owner: a live opencode session under the ses_* key
    // (the materialization's committed owner — the real durable
    // identity the pane resolves to after the first send).
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: durable_id.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &durable_id).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live: {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    // THE PLACEHOLDER ALIAS: the materialization's resolution record —
    // the pane's persisted placeholder identity becomes
    // `Aliased{to: ses_*}` (the alias the WS and REST materialization
    // sites now create at the durable commit).
    assert!(matches!(
        rig.ownership.alias_vacant_key(
            "opencode",
            &placeholder_id,
            &durable_id,
            "op-r33-alias",
            "freshopencode/send-materialize",
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    assert_eq!(
        rig.ownership.resolve_canonical("opencode", &placeholder_id),
        durable_id,
    );

    // THE HANDOFF on the PLACEHOLDER — the runner resolves through the
    // alias chain and operates on the DURABLE key.
    let to_terminal = rig.runner.spawn_handoff(handoff_req_terminal(
        "opencode",
        &placeholder_id,
        "opencode",
    ));
    let result = to_terminal.completion.await.expect("handoff completed");

    // The handoff COMPLETED on the durable key (pre-F1: the handoff
    // entered on the vacant placeholder — prior None, the target resume
    // of the placeholder id failed).
    assert_eq!(
        result["ok"],
        json!(true),
        "the placeholder-addressed handoff completes: {result}"
    );

    // The coordinator's LIVE record is on the DURABLE key — the
    // placeholder was the resolution alias, never the operational key.
    match rig.ownership.observe("opencode", &durable_id).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
        }
        other => panic!("expected Live terminal owner on the durable key, got {other:?}"),
    }

    // The placeholder is STILL the resolution alias (never an owner
    // record — a lifecycle on the placeholder always resolves).
    assert_eq!(
        rig.ownership.resolve_canonical("opencode", &placeholder_id),
        durable_id,
    );

    // The shared serve was never killed or restarted.
    assert!(
        env.serve_pids().len() <= 1,
        "the shared serve is never the handoff target: {:?}",
        env.serve_pids()
    );
}

/// 6c. b8ke delta review F1: a handoff that stops an opencode session with
/// an ACTIVE turn must abort the turn THROUGH THE MANAGER (the interrupt
/// path's mechanism) before reporting Reaped — the local JoinHandle abort
/// only stops awaiting the turn; once `prompt_async` returned, the turn
/// executes INSIDE the shared daemon. The fake serve accepts the prompt and
/// never goes idle (the active-turn shape), and HOLDS its abort answer
/// until the test releases it: the handoff must not complete while the
/// daemon-side abort is unanswered, and the shared serve itself is never
/// killed (OpenCode invariant).
#[tokio::test]
async fn opencode_handoff_stop_aborts_the_active_turn_through_the_manager_before_reaping() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // The abort-hold release file: absent until the test writes it, so the
    // fake serve holds its abort answer open.
    let release = env.dir.join("abort-release");
    std::env::set_var("FAKE_OPENCODE_SERVE_ABORT_RELEASE", &release);
    let sid = format!("ses_handoff_active_{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // Fresh owner: a durable opencode session, registered through the
    // shared serve (the attach-resume lane — the test-6 pattern).
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    // An ACTIVE turn: a send whose prompt the fake serve accepts but whose
    // idle never arrives — the turn executes daemon-side, with the local
    // turn task parked awaiting it.
    rig.fresh_opencode
        .handle_send(freshell_protocol::FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            text: "hold this turn open".to_string(),
            cwd: Some("/tmp".to_string()),
            images: None,
            request_id: Some(format!("handoff-active-send-{}", uuid::Uuid::new_v4())),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
        })
        .await;
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["method"] == "POST"
            && r["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("/prompt_async"))
    })
    .await;

    // Handoff opencode -> terminal: the stop must abort the daemon-side
    // turn before the reap is reported.
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", &sid, "opencode"));
    let mut completion = to_terminal.completion;

    // The manager abort was ISSUED through the daemon (the interrupt
    // mechanism) for the REAL session id.
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "abort-received" && r["id"] == json!(sid)
    })
    .await;

    // Ordering: the handoff must NOT complete (Reaped unreported) while
    // the daemon-side abort is unanswered.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut completion)
            .await
            .is_err(),
        "the handoff completed before the daemon-side turn abort settled — \
         Reaped must follow the manager abort"
    );

    // Release: the daemon answers the abort; the stop reports Reaped and
    // the handoff runs to its committed terminal owner.
    std::fs::write(&release, "").expect("release the abort hold");
    let result = completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("opencode", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected Live terminal owner, got {other:?}"),
    }

    // The shared serve was never killed — exactly one serve pid across
    // the whole handoff, and the abort was answered by that same process.
    env.await_audit_row(Duration::from_secs(10), |r| {
        r["event"] == "abort-answered" && r["id"] == json!(sid)
    })
    .await;
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );

    // Cleanup: kill the terminal owner's row (the lane bookkeeping for an
    // opencode session no longer exists post-handoff).
    rig.registry.kill(&terminal_id);
}

/// 6d. b8ke focused review FR1: the IdleTimeout shape — the local turn
/// task FINISHED (the local `run_turn` await gave up) while the
/// daemon-side turn still runs (the prompt was accepted; no idle ever
/// arrived). The stop path must STILL abort the daemon-side turn through
/// the manager and AWAIT its answer before reporting Reaped — pre-fix, the
/// stop skipped the abort entirely whenever the local task was finished
/// and let the handoff start a terminal writer over a still-running
/// daemon-side turn.
#[tokio::test]
async fn opencode_handoff_stop_aborts_a_daemon_turn_left_running_by_a_finished_local_task() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // The abort-hold release file: absent until the test writes it, so the
    // fake serve holds its abort answer open.
    let release = env.dir.join("abort-release-fr1");
    std::env::set_var("FAKE_OPENCODE_SERVE_ABORT_RELEASE", &release);
    let sid = format!("ses_handoff_idletimeout_{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // Fresh owner: a durable opencode session, registered through the
    // shared serve (the test-6 pattern).
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    // An ACTIVE daemon-side turn: a send whose prompt the fake serve
    // accepts but whose idle never arrives.
    rig.fresh_opencode
        .handle_send(freshell_protocol::FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            text: "hold this daemon-side turn open".to_string(),
            cwd: Some("/tmp".to_string()),
            images: None,
            request_id: Some(format!("handoff-idletimeout-send-{}", uuid::Uuid::new_v4())),
            settings: None,
            observed_epoch: None,
            observed_generation: None,
        })
        .await;
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["method"] == "POST"
            && r["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("/prompt_async"))
    })
    .await;

    // THE IdleTimeout shape: the LOCAL turn task finishes (the local
    // await is settled) while the daemon-side turn keeps running — the
    // test seam performs exactly the local settle a real IdleTimeout
    // leaves behind (task finished, acceptance still armed).
    rig.fresh_opencode
        .settle_local_turn_task_for_test(&sid)
        .await;

    // Handoff opencode -> terminal: the stop must STILL abort the
    // daemon-side turn before the reap is reported.
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", &sid, "opencode"));
    let mut completion = to_terminal.completion;

    // The manager abort was ISSUED through the daemon for the REAL session
    // id — despite the local task being finished (pre-fix: never issued).
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "abort-received" && r["id"] == json!(sid)
    })
    .await;

    // Ordering: the handoff must NOT complete (Reaped unreported) while
    // the daemon-side abort is unanswered.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut completion)
            .await
            .is_err(),
        "the handoff completed before the daemon-side turn abort settled — \
         Reaped must follow the manager abort even when the local task finished"
    );

    // Release: the daemon answers the abort; the stop reports Reaped and
    // the handoff runs to its committed terminal owner.
    std::fs::write(&release, "").expect("release the abort hold");
    let result = completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();

    // The shared serve was never killed — exactly one serve pid across
    // the whole handoff.
    env.await_audit_row(Duration::from_secs(10), |r| {
        r["event"] == "abort-answered" && r["id"] == json!(sid)
    })
    .await;
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );

    // Cleanup: kill the terminal owner's row.
    rig.registry.kill(&terminal_id);
}

/// 6e. b8ke focused round-2 review R2-5: a handoff landing MID-COMPACTION
/// must quiesce the daemon-side summarize through the abort before
/// Reaped — the compact drive arms the SAME accepted-daemon-operation
/// witness the send drive arms, at the summarize POST's dispatch boundary.
/// Pre-fix: the compact never armed the flag, so the stop path skipped the
/// daemon abort, reported Reaped, and started the terminal while the
/// daemon-side summarization still mutated the session. The fake serve
/// holds the summarize answer open (the POST dispatched, the response
/// parked) while the abort answers normally.
#[tokio::test]
async fn opencode_handoff_during_compaction_aborts_the_daemon_side_summarize() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // The summarize-hold release file: absent until the test writes it, so
    // the fake serve holds its summarize answer open — the mid-compaction
    // window (dispatched, daemon-side work running, response parked).
    let summarize_release = env.dir.join("summarize-release-r25");
    std::env::set_var("FAKE_OPENCODE_SERVE_SUMMARIZE_RELEASE", &summarize_release);
    let sid = format!("ses_handoff_compact_{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // Fresh owner: a durable opencode session, registered through the
    // shared serve (the test-6 pattern).
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    // A compact whose summarize POST the fake serve accepts but whose
    // answer is HELD open — the daemon-side summarization is running.
    // ep5 r4 F2: the honest client shape — the compact carries the pair
    // observed from the owner record (an unfenced history mutation against
    // a Live{FreshAgent} key is the typed FENCE_REQUIRED refusal now).
    let before = rig.ownership.observe("opencode", &sid);
    rig.fresh_opencode
        .handle_compact(FreshAgentCompact {
            request_id: None,
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            instructions: None,
            observed_epoch: Some(before.epoch),
            observed_generation: Some(before.generation),
        })
        .await;
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "summarize-received" && r["id"] == json!(sid)
    })
    .await;

    // Handoff opencode -> terminal MID-COMPACTION: the stop must abort the
    // daemon-side summarize before the reap is reported.
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", &sid, "opencode"));
    let completion = to_terminal.completion;

    // THE R2-5 assertion: the manager abort IS issued for the compacted
    // session (pre-fix: the compact never armed the acceptance, so the
    // stop path skipped the abort entirely).
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "abort-received" && r["id"] == json!(sid)
    })
    .await;

    // The abort answers (no abort hold set): the stop reports Reaped and
    // the handoff runs to its committed terminal owner.
    let result = completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();

    // The shared serve was never killed — exactly one serve pid across the
    // whole handoff (OpenCode invariant).
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );

    // Release the summarize hold for a clean shutdown of the parked
    // response, then clean up the terminal owner's row.
    std::fs::write(&summarize_release, "").expect("release the summarize hold");
    rig.registry.kill(&terminal_id);
}

/// 6f. b8ke focused round-3 review R3-1: the REST/MCP opencode send-keys
/// path participates in the coordinator. An in-flight REST-driven daemon
/// turn — the pane is NOT represented in the WebSocket session map — is
/// still visible to a concurrent handoff: the stop finds the REST turn
/// witness and ABORTS the daemon-side turn (the per-session /abort)
/// BEFORE reporting the reap, exactly like a WS-lane turn. Pre-fix, the
/// stop found no session (AlreadyGone), answered Reaped, and the handoff
/// started the terminal CLI while the REST-driven turn kept mutating the
/// session. The fake serve holds its abort answer until released: the
/// handoff must not complete while the daemon-side abort is unanswered.
#[tokio::test]
async fn opencode_handoff_stop_aborts_an_in_flight_rest_driven_turn_before_reaping() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // The abort-hold release file: absent until the test writes it, so the
    // fake serve holds its abort answer open.
    let release = env.dir.join("abort-release-r31");
    std::env::set_var("FAKE_OPENCODE_SERVE_ABORT_RELEASE", &release);
    let rig = build_rig(None);

    // A REST-created freshopencode pane (the POST /api/tabs shape),
    // driven through the REST send-keys surface — never the WS lane.
    rig.fresh_agent.panes.lock().expect("panes mutex").insert(
        "pane-r31".to_string(),
        crate::PaneEntry {
            placeholder_id: "freshopencode-r31".to_string(),
            provider: "opencode".to_string(),
            session_type: "freshopencode".to_string(),
            cwd: Some("/tmp".to_string()),
            model: None,
            effort: None,
            durable_id: None,
        },
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-auth-token", "handoff-test-token".parse().unwrap());
    // Drive the REST turn with a short budget: the prompt dispatches (the
    // acceptance witness arms at the dispatch boundary), the local await
    // gives up (IdleTimeout — the fake serve never goes idle), and the
    // daemon-side turn keeps running with the request already answered.
    let send = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r31".to_string()),
        headers,
        axum::Json(json!({ "text": "hold this REST turn open", "timeout": 1 })),
    ));
    // The REST materialization committed Live{FreshAgent} for the minted
    // durable id (the fake serve's first create is ses_1).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", "ses_1").state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the REST materialization never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }
    // The REST request answered (approx — its own budget expired while the
    // daemon-side turn runs on).
    let rest_response = send.await.expect("REST send-keys completed");
    assert_eq!(
        rest_response.status(),
        axum::http::StatusCode::OK,
        "the REST send-keys drive answers approx: {rest_response:?}"
    );

    // Handoff opencode -> terminal: the stop must abort the REST-driven
    // daemon-side turn before the reap is reported.
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", "ses_1", "opencode"));
    let mut completion = to_terminal.completion;

    // THE R3-1 regression: the manager abort was ISSUED for the REAL
    // session id through the REST turn witness (pre-fix: no session in
    // the WS map → AlreadyGone → no abort at all).
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "abort-received" && r["id"] == json!("ses_1")
    })
    .await;

    // Ordering: the handoff must NOT complete (the reap unreported) while
    // the daemon-side abort is unanswered.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut completion)
            .await
            .is_err(),
        "the handoff completed before the daemon-side turn abort settled — \
         the reap must follow the manager abort"
    );

    // Release: the daemon answers the abort; the stop reports the reap
    // and the handoff runs to its committed terminal owner.
    std::fs::write(&release, "").expect("release the abort hold");
    let result = completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("opencode", "ses_1").state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected Live terminal owner, got {other:?}"),
    }

    // The shared serve was never killed — exactly one serve pid across the
    // whole handoff (OpenCode invariant).
    env.await_audit_row(Duration::from_secs(10), |r| {
        r["event"] == "abort-answered" && r["id"] == json!("ses_1")
    })
    .await;
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );
    rig.registry.kill(&terminal_id);
}

/// 6g. b8ke focused round-4 review R4-2: the REST drive's dispatch is
/// ATOMIC against lifecycle handoff. The drive holds the session's
/// dispatch/condemn GATE across [ownership re-check + accepted-witness
/// arming + prompt POST]; the stop's quiesce takes the SAME gate around
/// [witness take + condemn]. The interleaving under review — a handoff
/// that starts AFTER the drive's ownership check but BEFORE its prompt
/// dispatch — must be total: pre-fix (check once, then a separate
/// unconstrained dispatch) the stop condemned the UNARMED witness,
/// reported the reap, and committed the terminal owner while the parked
/// drive then armed the removed witness and POSTed a daemon-side writer
/// AFTER the coordinator had moved on. Post-fix the stop BLOCKS on the
/// gate until the POST issued, sees the ARMED witness, and its abort
/// confirms the daemon-side turn's death BEFORE the reap.
#[tokio::test]
async fn opencode_handoff_stop_waits_for_a_mid_dispatch_rest_drive_under_the_gate() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // No abort hold: the fake serve answers aborts immediately.
    let rig = build_rig(None);

    // A REST-created freshopencode pane (the POST /api/tabs shape).
    rig.fresh_agent.panes.lock().expect("panes mutex").insert(
        "pane-r42".to_string(),
        crate::PaneEntry {
            placeholder_id: "freshopencode-r42".to_string(),
            provider: "opencode".to_string(),
            session_type: "freshopencode".to_string(),
            cwd: Some("/tmp".to_string()),
            model: None,
            effort: None,
            durable_id: None,
        },
    );
    let headers = |()| {
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-auth-token", "handoff-test-token".parse().unwrap());
        h
    };
    // Drive #1 materializes ses_1 with a short budget: the prompt
    // dispatches, the local await gives up (IdleTimeout), and the witness
    // stays ARMED and REGISTERED (the R4-3 retained shape).
    let first = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r42".to_string()),
        headers(()),
        axum::Json(json!({ "text": "first REST turn", "timeout": 1 })),
    ));
    let rest_response = first.await.expect("drive #1 completed");
    assert_eq!(
        rest_response.status(),
        axum::http::StatusCode::OK,
        "drive #1 answers approx: {rest_response:?}"
    );

    // Park drive #2 mid-dispatch — AFTER the gate-held re-check, BEFORE
    // the prompt POST (the R4-2 test seam; never armed in production).
    let pause = Arc::new(tokio::sync::Notify::new());
    rig.fresh_agent
        .set_rest_turn_test_pause_for_test(Some(Arc::clone(&pause)));
    let second = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r42".to_string()),
        headers(()),
        axum::Json(json!({ "text": "second REST turn", "timeout": 5 })),
    ));
    // The drive reached the park: its retained-witness settle (R4-3)
    // aborted drive #1's daemon-side turn first — that abort row is the
    // drive's progress marker up to the park point.
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["event"] == "abort-received" && r["id"] == json!("ses_1")
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Handoff opencode -> terminal while the drive is parked BEFORE its
    // prompt POST: the stop's quiesce blocks on the dispatch gate.
    let to_terminal = rig
        .runner
        .spawn_handoff(handoff_req_terminal("opencode", "ses_1", "opencode"));
    let mut completion = to_terminal.completion;

    // THE R4-2 regression: the handoff must NOT complete while the drive
    // is parked mid-section — pre-fix the quiesce condemned the UNARMED
    // witness and the handoff committed the terminal owner BEFORE the
    // drive's POST (a daemon-side writer started after the reap).
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut completion)
            .await
            .is_err(),
        "the handoff completed while the REST drive was parked before its \
         prompt dispatch — the stop must block on the dispatch gate"
    );

    // Release the drive: the prompt POST issues UNDER the gate, the gate
    // opens, and the stop takes+condemns the now-ARMED witness and its
    // abort confirms the daemon-side turn BEFORE the reap.
    pause.notify_waiters();
    env.await_audit_row(Duration::from_secs(20), |r| {
        r["method"] == "POST"
            && r["path"]
                .as_str()
                .is_some_and(|p| p == "/session/ses_1/prompt_async")
    })
    .await;
    let result = completion.await.expect("handoff completed");
    assert_eq!(result["ok"], json!(true), "handoff to terminal: {result}");
    let terminal_id = result["owner"]["terminalId"].as_str().unwrap().to_string();
    match rig.ownership.observe("opencode", "ses_1").state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::Terminal);
            assert_eq!(owner.terminal_id.as_deref(), Some(terminal_id.as_str()));
        }
        other => panic!("expected Live terminal owner, got {other:?}"),
    }
    // Ordering proof: the drive's prompt POST row precedes a SECOND
    // abort row for ses_1 — the quiesce's confirmed abort of the armed
    // witness. (Pre-fix the quiesce aborted nothing: no armed witness
    // existed and the drive's POST armed an orphan AFTER the handoff.)
    let rows = env.audit_rows();
    let prompt_idx = rows
        .iter()
        .position(|r| {
            r["method"] == "POST"
                && r["path"]
                    .as_str()
                    .is_some_and(|p| p == "/session/ses_1/prompt_async")
        })
        .expect("the drive's prompt row");
    let abort_after_prompt = rows[prompt_idx..]
        .iter()
        .any(|r| r["event"] == "abort-received" && r["id"] == json!("ses_1"));
    assert!(
        abort_after_prompt,
        "the stop's abort of the ARMED witness must follow the prompt POST"
    );

    // The drive answered (approx — the fake serve never idles).
    let second_response = second.await.expect("drive #2 completed");
    assert_eq!(
        second_response.status(),
        axum::http::StatusCode::OK,
        "drive #2 answers: {second_response:?}"
    );
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed or restarted: pids {:?}",
        env.serve_pids()
    );
    rig.fresh_agent.set_rest_turn_test_pause_for_test(None);
    rig.registry.kill(&terminal_id);
}

/// 6h. b8ke focused round-4 review R4-3: a second REST drive SETTLES the
/// retained witness before replacing it. An earlier drive's IdleTimeout
/// deliberately leaves its witness ARMED and REGISTERED (the daemon-side
/// turn may still be mutating the session); pre-fix the replacement
/// overwrote the registry entry unconditionally, silently forgetting that
/// unresolved writer. Post-fix the retained witness is condemned and its
/// accepted daemon-side turn is aborted to confirmed settlement BEFORE
/// the new witness registers — the audit shows the abort landing between
/// the two prompt POSTs.
#[tokio::test]
async fn a_second_rest_drive_settles_the_retained_witness_before_replacing_it() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    let rig = build_rig(None);

    rig.fresh_agent.panes.lock().expect("panes mutex").insert(
        "pane-r43".to_string(),
        crate::PaneEntry {
            placeholder_id: "freshopencode-r43".to_string(),
            provider: "opencode".to_string(),
            session_type: "freshopencode".to_string(),
            cwd: Some("/tmp".to_string()),
            model: None,
            effort: None,
            durable_id: None,
        },
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-auth-token", "handoff-test-token".parse().unwrap());
    // Drive #1: IdleTimeout leaves the retained witness armed.
    let first = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r43".to_string()),
        headers.clone(),
        axum::Json(json!({ "text": "first REST turn", "timeout": 1 })),
    ));
    assert_eq!(
        first.await.expect("drive #1 completed").status(),
        axum::http::StatusCode::OK
    );
    // The retained witness is registered and armed.
    {
        let turns = rig
            .fresh_agent
            .rest_opencode_turns
            .lock()
            .expect("rest opencode turns lock");
        let retained = turns.get("ses_1").expect("the retained witness");
        assert!(
            retained
                .daemon_turn_accepted
                .load(std::sync::atomic::Ordering::SeqCst),
            "drive #1's IdleTimeout left its witness ARMED"
        );
    }

    // Drive #2: the settle-then-replace. Pre-fix this drive overwrote the
    // registry entry silently — no abort was ever issued for the retained
    // turn.
    let second = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r43".to_string()),
        headers.clone(),
        axum::Json(json!({ "text": "second REST turn", "timeout": 5 })),
    ));
    assert_eq!(
        second.await.expect("drive #2 completed").status(),
        axum::http::StatusCode::OK,
        "the settled replacement drive proceeds"
    );

    // THE R4-3 regression: the retained witness's daemon-side turn was
    // ABORTED — and the abort landed BETWEEN the two prompt POSTs (the
    // settle runs before the new witness registers and dispatches).
    let rows = env.audit_rows();
    let prompt_positions: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, r)| {
            (r["method"] == "POST"
                && r["path"]
                    .as_str()
                    .is_some_and(|p| p == "/session/ses_1/prompt_async"))
            .then_some(i)
        })
        .collect();
    assert_eq!(
        prompt_positions.len(),
        2,
        "both drives dispatched their prompts: rows {:?}",
        rows
    );
    let abort_between = rows[prompt_positions[0]..prompt_positions[1]]
        .iter()
        .any(|r| r["event"] == "abort-received" && r["id"] == json!("ses_1"));
    assert!(
        abort_between,
        "the retained witness's daemon-side turn must be aborted to \
         confirmed settlement BEFORE the replacement drive dispatches"
    );
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed: pids {:?}",
        env.serve_pids()
    );
}

/// 6i. b8ke focused round-4 review R4-3: an UNCONFIRMABLE retained
/// witness refuses the replacement TYPED — never a silent overwrite that
/// orphans the earlier daemon-side writer. The fake serve holds its abort
/// answer open (the release file stays absent), so the new drive's
/// bounded settle cannot confirm; the drive answers the typed 409 and the
/// retained witness STAYS registered (still visible to every lifecycle
/// stop). Releasing the hold lets the NEXT drive settle and proceed.
#[tokio::test]
async fn an_unconfirmable_retained_witness_refuses_the_replacement_typed() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeOpencodeServeEnv::install();
    // The abort-hold release file: absent until the test writes it, so
    // the fake serve holds every abort answer open.
    let release = env.dir.join("abort-release-r43b");
    std::env::set_var("FAKE_OPENCODE_SERVE_ABORT_RELEASE", &release);
    let rig = build_rig(None);

    rig.fresh_agent.panes.lock().expect("panes mutex").insert(
        "pane-r43b".to_string(),
        crate::PaneEntry {
            placeholder_id: "freshopencode-r43b".to_string(),
            provider: "opencode".to_string(),
            session_type: "freshopencode".to_string(),
            cwd: Some("/tmp".to_string()),
            model: None,
            effort: None,
            durable_id: None,
        },
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("x-auth-token", "handoff-test-token".parse().unwrap());
    // Drive #1: IdleTimeout leaves the retained witness armed.
    let first = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r43b".to_string()),
        headers.clone(),
        axum::Json(json!({ "text": "first REST turn", "timeout": 1 })),
    ));
    assert_eq!(
        first.await.expect("drive #1 completed").status(),
        axum::http::StatusCode::OK
    );

    // Drive #2 while the abort is unanswerable: the bounded settle fails →
    // the typed refusal. Pre-fix this drive silently replaced the
    // retained witness and answered 200.
    let second = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r43b".to_string()),
        headers.clone(),
        axum::Json(json!({ "text": "second REST turn", "timeout": 1 })),
    ));
    let second_response = second.await.expect("drive #2 completed");
    assert_eq!(
        second_response.status(),
        axum::http::StatusCode::CONFLICT,
        "the unconfirmable retained witness must refuse the replacement \
         typed: {second_response:?}"
    );

    // The retained witness STAYS registered — no orphan writer (every
    // lifecycle stop still sees it).
    assert!(
        rig.fresh_agent
            .rest_opencode_turns
            .lock()
            .expect("rest opencode turns lock")
            .contains_key("ses_1"),
        "the unconfirmed retained witness must stay registered"
    );

    // Release the hold: the NEXT drive settles (the abort answers) and
    // proceeds.
    std::fs::write(&release, "").expect("release the abort hold");
    let third = tokio::spawn(crate::send_keys(
        axum::extract::State(rig.fresh_agent.clone()),
        axum::extract::Path("pane-r43b".to_string()),
        headers.clone(),
        axum::Json(json!({ "text": "third REST turn", "timeout": 5 })),
    ));
    assert_eq!(
        third.await.expect("drive #3 completed").status(),
        axum::http::StatusCode::OK,
        "the post-release drive settles the retained witness and proceeds"
    );
    assert_eq!(
        env.serve_pids().len(),
        1,
        "the shared serve was never killed: pids {:?}",
        env.serve_pids()
    );
}

/// 6b. kilroy (round-2 review): handoff TO a kilroy fresh-agent target — the
/// claude-lane resume keeps the kilroy flavor (the resumed session's frames
/// carry sessionType kilroy; the coordinator owner record serves the same
/// canonical (claude, sessionId)); the broadcast ownerKind is fresh-agent.
/// Never map by provider alone (freshclaude would lose the kilroy identity).
#[tokio::test]
async fn handoff_to_a_kilroy_target_resumes_as_kilroy_on_the_claude_lane() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    // The claude-lane resume path gates on transcript presence — install a
    // fake transcript store root for the session.
    let store_dir = std::env::temp_dir().join(format!(
        "freshell-handoff-kilroy-store-{}",
        uuid_like_suffix()
    ));
    let project_dir = store_dir.join("projects").join("slug");
    std::fs::create_dir_all(&project_dir).expect("create transcript project dir");
    let sid = uuid::Uuid::new_v4().to_string();
    std::fs::write(
        project_dir.join(format!("{sid}.jsonl")),
        "{\"cwd\": \"/tmp\"}\n",
    )
    .expect("write fake transcript");
    std::env::set_var("CLAUDE_CONFIG_DIR", &store_dir);

    let mut rig = build_rig(None);

    // Terminal owner first (mode claude — the sleeper spec spawns a real
    // Running PTY that self-commits Live{Terminal} for the canonical key).
    let spawn_body = json!({
        "mode": "claude",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "claude", "sessionId": sid },
    });
    let spawned = crate::terminal_tabs::spawn_terminal_pane(
        &rig.fresh_agent,
        &spawn_body,
        "handoff-kilroy-tab",
        "handoff-kilroy-pane",
    )
    .await
    .expect("terminal prior spawn");
    let prior_terminal = spawned.terminal_id.clone();
    assert!(
        matches!(
            rig.ownership.observe("claude", &sid).state,
            OwnershipState::Live { .. }
        ),
        "the terminal prior must commit Live"
    );

    // Handoff { targetKind: fresh-agent, sessionType: kilroy }.
    let handle = rig
        .runner
        .spawn_handoff(handoff_req_fresh("claude", &sid, "kilroy"));
    let result = handle.completion.await.expect("runner completed");
    assert_eq!(result["ok"], json!(true), "the kilroy handoff: {result}");
    assert_eq!(result["owner"]["kind"], json!("fresh-agent"));
    assert_eq!(result["owner"]["sessionType"], json!("kilroy"));
    assert_eq!(result["owner"]["sessionId"], json!(sid));

    // The prior terminal is dead.
    assert!(rig.registry.terminal_is_dead(&prior_terminal));

    // The created/resumed session's frames carry sessionType "kilroy".
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut saw_kilroy_frame = false;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(250), rig.rx.recv()).await {
            Ok(Ok(raw)) => {
                if raw.contains("\"sessionType\":\"kilroy\"") && raw.contains(&sid) {
                    saw_kilroy_frame = true;
                    break;
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => break,
            Err(_) => {}
        }
    }
    assert!(
        saw_kilroy_frame,
        "the resumed session's frames must keep the kilroy flavor"
    );

    // observe() == Live{FreshAgent} for (claude, sessionId).
    match rig.ownership.observe("claude", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
        }
        other => panic!("expected Live fresh owner, got {other:?}"),
    }

    // The broadcast frames carry epoch + ownerKind fresh-agent.
    let frames = drain_runtime_owner_frames(&mut rig.rx);
    let committed = runtime_owner_frame(&frames, "handoff-committed");
    assert!(committed["epoch"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(committed["ownerKind"], json!("fresh-agent"));
    assert_eq!(committed["previousKind"], json!("terminal"));

    // Cleanup: the runner retained the lane stamp — the lane kill works.
    let _ = rig
        .fresh_claude
        .kill_for_handoff(&sid, "test-cleanup")
        .await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");
    let _ = env;
    let _ = std::fs::remove_dir_all(&store_dir);
}

// ── the router's typed 401/400 surface (round-3 review N-2) ────────────────

/// POST the handoff route with or without the auth header (the
/// `tower::ServiceExt::oneshot` shape the pane_ops tests use).
async fn post_handoff_route(
    router: axum::Router,
    body: Value,
    auth: bool,
) -> (axum::http::StatusCode, Value) {
    use tower::util::ServiceExt;
    let mut req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/sessions/handoff")
        .header("content-type", "application/json");
    if auth {
        req = req.header("x-auth-token", "handoff-test-token");
    }
    let resp = router
        .oneshot(req.body(axum::body::Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// Round-3 review N-2: the 401 answers with a typed code that matches the
/// status (`UNAUTHORIZED` — the plan sketch's `BAD_REQUEST` read oddly).
#[tokio::test]
async fn handoff_route_requires_auth_with_typed_unauthorized_code() {
    let rig = build_rig(None);
    let router = super::handoff_router(Arc::clone(&rig.runner));
    let (status, body) = post_handoff_route(
        router,
        json!({ "provider": "claude", "sessionId": "sid", "targetKind": "terminal" }),
        false,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], json!("UNAUTHORIZED"));
    assert_eq!(body["error"]["retryable"], json!(false));
}

/// The typed 400 validation surface (pinned beside the 401: no handoff is
/// ever spawned for an invalid body — the coordinator is untouched).
#[tokio::test]
async fn handoff_route_validates_target_kind_typed() {
    let rig = build_rig(None);
    let sid = uuid::Uuid::new_v4().to_string();
    let router = super::handoff_router(Arc::clone(&rig.runner));
    let (status, body) = post_handoff_route(
        router,
        json!({ "provider": "claude", "sessionId": sid, "targetKind": "bogus" }),
        true,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], json!("BAD_REQUEST"));
    assert_eq!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant,
        "an invalid body must never touch the coordinator"
    );
}

/// b8ke delta review F7: a handoff body carrying exactly ONE of the
/// observed epoch/generation pair is a TYPED invalid-fence refusal — never
/// a silent downgrade to the unfenced legacy path (which could let an
/// old-generation half-fenced request reacquire a Vacant key). Both
/// half-fence combinations refuse; the coordinator is untouched.
#[tokio::test]
async fn handoff_route_refuses_each_half_fenced_observation_typed() {
    let rig = build_rig(None);
    let sid = uuid::Uuid::new_v4().to_string();
    for (name, body) in [
        (
            "epoch-only",
            json!({
                "provider": "claude", "sessionId": sid, "targetKind": "terminal",
                "mode": "claude", "observedEpoch": 1,
            }),
        ),
        (
            "generation-only",
            json!({
                "provider": "claude", "sessionId": sid, "targetKind": "terminal",
                "mode": "claude", "observedGeneration": 4,
            }),
        ),
    ] {
        let router = super::handoff_router(Arc::clone(&rig.runner));
        let (status, response) = post_handoff_route(router, body, true).await;
        assert_eq!(
            status,
            axum::http::StatusCode::BAD_REQUEST,
            "the {name} half-fence must be a typed 400: {response}"
        );
        assert_eq!(
            response["error"]["code"],
            json!("INVALID_FENCE"),
            "the {name} half-fence carries the typed code: {response}"
        );
        assert_eq!(
            response["error"]["retryable"],
            json!(false),
            "an invalid fence is not retryable as-is: {response}"
        );
    }
    assert_eq!(
        rig.ownership.observe("claude", &sid).state,
        OwnershipState::Vacant,
        "a half-fenced body must never touch the coordinator"
    );
}

/// b8ke delta review F5: the provider↔target validation — a handoff whose
/// sessionType is not one of the provider's canonical fresh-agent session
/// types, whose absent sessionType is ambiguous (claude is two flavors), or
/// whose terminal mode does not match the provider is a TYPED 400 refused
/// PRE-STOP: the prior runtime is never stopped, the coordinator record
/// never changes. The wrong-mode case is proven against a LIVE prior (the
/// record must stay byte-identical: same owner kind, same generation).
#[tokio::test]
async fn handoff_route_refuses_provider_mismatched_targets_typed() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    // The codex sidecar stub: wrong-lane dispatches that reach the codex
    // lane in the pre-fix shape fail fast instead of spawning the real
    // `codex` binary (held with codex.rs's own env lock — CODEX_CMD is its
    // process-global surface).
    let _codex_env = crate::codex::tests::ENV_LOCK.lock().await;
    let prev_codex_cmd = std::env::var("CODEX_CMD").ok();
    std::env::set_var("CODEX_CMD", "/bin/false");
    // The fake serve: wrong-lane dispatches that reach the opencode lane
    // resume a session the fake 404s (the "missing" id rule).
    let _serve_env = FakeOpencodeServeEnv::install();
    let env = FakeSidecarEnv::install();

    let mut rig = build_rig(None);
    // A LIVE prior for the wrong-mode case: the refusal must leave this
    // record byte-identical (same owner kind, same generation).
    let live_sid = uuid::Uuid::new_v4().to_string();
    establish_fresh_claude_owner(&mut rig, &live_sid).await;
    let before = rig.ownership.observe("claude", &live_sid);
    let before_generation = before.generation;

    let missing = format!("missing-{}", uuid::Uuid::new_v4());
    for (name, body) in [
        (
            "wrong-provider sessionType (opencode key, codex flavor)",
            json!({
                "provider": "opencode", "sessionId": missing, "targetKind": "fresh-agent",
                "sessionType": "freshcodex", "cwd": "/tmp",
            }),
        ),
        (
            "wrong-provider sessionType (codex key, opencode flavor)",
            json!({
                "provider": "codex", "sessionId": missing, "targetKind": "fresh-agent",
                "sessionType": "freshopencode", "cwd": "/tmp",
            }),
        ),
        (
            "wrong-provider sessionType (claude key, opencode flavor)",
            json!({
                "provider": "claude", "sessionId": missing, "targetKind": "fresh-agent",
                "sessionType": "freshopencode", "cwd": "/tmp",
            }),
        ),
        (
            "absent sessionType under an ambiguous provider (claude)",
            json!({
                "provider": "claude", "sessionId": missing, "targetKind": "fresh-agent",
                "cwd": "/tmp",
            }),
        ),
        (
            "provider with no fresh-agent lane",
            json!({
                "provider": "gemini", "sessionId": missing, "targetKind": "fresh-agent",
                "sessionType": "freshclaude", "cwd": "/tmp",
            }),
        ),
        (
            "terminal mode of a different provider",
            json!({
                "provider": "claude", "sessionId": live_sid, "targetKind": "terminal",
                "mode": "opencode",
            }),
        ),
        (
            "blank terminal mode",
            json!({
                "provider": "claude", "sessionId": live_sid, "targetKind": "terminal",
                "mode": "",
            }),
        ),
        (
            "unregistered terminal mode",
            json!({
                "provider": "claude", "sessionId": live_sid, "targetKind": "terminal",
                "mode": "shell",
            }),
        ),
    ] {
        let router = super::handoff_router(Arc::clone(&rig.runner));
        let (status, response) = post_handoff_route(router, body, true).await;
        assert_eq!(
            status,
            axum::http::StatusCode::BAD_REQUEST,
            "the {name} mismatch must be a typed 400: {response}"
        );
        assert_eq!(
            response["error"]["code"],
            json!("BAD_REQUEST"),
            "the {name} mismatch carries the typed code: {response}"
        );
        assert_eq!(
            response["error"]["retryable"],
            json!(false),
            "a validation refusal is not retryable as-is: {response}"
        );
    }

    // The LIVE prior is untouched: same owner kind, same generation — the
    // refusals never stopped it, never bumped the record.
    let after = rig.ownership.observe("claude", &live_sid);
    assert_eq!(
        after.generation, before_generation,
        "a refused handoff must never bump the coordinator record"
    );
    match after.state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(
                owner.kind,
                RuntimeOwnerKind::FreshAgent,
                "the live prior must still own its key after the refusals"
            );
        }
        other => panic!("the live prior must remain Live, got {other:?}"),
    }

    // Restore the codex command surface.
    match prev_codex_cmd {
        Some(value) => std::env::set_var("CODEX_CMD", value),
        None => std::env::remove_var("CODEX_CMD"),
    }
    let _ = env;
}

/// b8ke delta review F5: an ABSENT sessionType resolves to the provider's
/// canonical fresh-agent type when unambiguous — an opencode handoff
/// without a sessionType resumes as freshopencode through the shared
/// serve (never the silent freshcodex default under an opencode key).
#[tokio::test]
async fn handoff_route_resolves_absent_session_type_when_unambiguous() {
    let _guard = ENV_LOCK.lock().await;
    // The claude-lane env surface this file's tests mutate
    // (FRESHELL_CLAUDE_SIDECAR/NODE, FAKE_SIDECAR_REQUEST_LOG,
    // CLAUDE_CONFIG_DIR) is process-global and shared with claude.rs's and
    // snapshot.rs's tests through THEIR lock — hold it too: our own
    // ENV_LOCK only serializes this file against itself.
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    // The pre-fix shape dispatches an absent sessionType to the CODEX lane
    // — stub the sidecar so that dispatch fails fast and hermetically.
    let _codex_env = crate::codex::tests::ENV_LOCK.lock().await;
    let prev_codex_cmd = std::env::var("CODEX_CMD").ok();
    std::env::set_var("CODEX_CMD", "/bin/false");
    let env = FakeOpencodeServeEnv::install();

    let sid = format!("ses_handoff_absent_{}", uuid::Uuid::new_v4().simple());
    let rig = build_rig(None);

    // Fresh owner: a durable opencode session through the shared serve.
    rig.fresh_opencode
        .handle_attach(FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: sid.clone(),
            session_type: SessionType::Freshopencode,
            cwd: Some("/tmp".to_string()),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match rig.ownership.observe("opencode", &sid).state {
            OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
                break;
            }
            state => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the opencode attach never committed Live, got {state:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    // The handoff carries NO sessionType: the unambiguous opencode
    // resolution must resume as freshopencode.
    let router = super::handoff_router(Arc::clone(&rig.runner));
    let (status, body) = post_handoff_route(
        router,
        json!({
            "provider": "opencode", "sessionId": sid, "targetKind": "fresh-agent",
            "cwd": "/tmp",
        }),
        true,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    assert_eq!(body["ok"], json!(true), "the absent-type handoff: {body}");
    assert_eq!(
        body["owner"]["sessionType"],
        json!("freshopencode"),
        "the resolved sessionType names the lane the request targets: {body}"
    );
    assert_eq!(body["owner"]["sessionId"], json!(sid), "{body}");
    match rig.ownership.observe("opencode", &sid).state {
        OwnershipState::Live { owner, .. } => {
            assert_eq!(owner.kind, RuntimeOwnerKind::FreshAgent);
        }
        other => panic!("expected Live fresh owner, got {other:?}"),
    }

    // Cleanup: the lane bookkeeping (never the serve).
    let _ = rig
        .fresh_opencode
        .opencode_kill_for_handoff(&sid, "test-cleanup")
        .await;
    match prev_codex_cmd {
        Some(value) => std::env::set_var("CODEX_CMD", value),
        None => std::env::remove_var("CODEX_CMD"),
    }
    let _ = env;
}

/// b8ke ext r6 F2: the PRIOR-stop terminal arm confirms death on the
/// recorded pid's OS-LEVEL death — never registry.kill()'s return.
/// kill_internal removes the row BEFORE signaling/reaping the PTY, so a
/// concurrent kill can own the removed row while the process lives: the
/// old kill()=false arm answered Reaped and the handoff started the
/// replacement before confirmed reap. The row-removed-but-pid-alive
/// window fences (the watcher regime resolves it), never reaps.
#[tokio::test]
async fn the_prior_stop_never_confirms_on_a_missing_row() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let sid = uuid::Uuid::new_v4().to_string();
    // A SHORT reap budget: the pid-alive window deterministically fences
    // within the test.
    let rig = build_rig_inner(None, None, None, 50, None, false, None, None);
    // The prior's stand-in process: ALIVE, its registry row ABSENT — the
    // exact row-removed-but-not-yet-reaped shape a concurrent kill
    // produces.
    let mut prior = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn the prior's stand-in");
    let prior_pid = prior.id();
    let absent_tid = "T-r6-f2-absent";
    assert!(
        rig.registry.terminal_is_dead(absent_tid),
        "precondition: the recorded pane's row is absent"
    );
    assert!(
        freshell_terminal::registry::pid_alive(prior_pid),
        "precondition: the recorded runtime still lives"
    );
    let live_owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(absent_tid.to_string()),
        live_session_key: None,
        pid: Some(prior_pid),
        ownership_id: None,
    };

    // THE WINDOW: kill() answers false (the row is gone) while the pid
    // lives — pre-r6 the prior-stop arm answered Reaped and the handoff
    // started the replacement before the reap confirmed.
    let outcome = rig
        .runner
        .stop_runtime(
            &handoff_req_terminal("claude", &sid, "claude"),
            &live_owner,
            "test",
            "op-r6-f2",
            1,
        )
        .await;
    assert!(
        matches!(
            outcome,
            super::StopOutcomePriv::ReapTimeout { fenced: true }
        ),
        "the row-removed-but-pid-alive window fences typed — got {outcome:?}"
    );

    // The confirmed pid-death path still reaps.
    prior.kill().expect("SIGKILL the stand-in");
    let _ = prior.wait().expect("reap the stand-in");
    assert!(
        !freshell_terminal::registry::pid_alive(prior_pid),
        "precondition: the recorded runtime is confirmed dead"
    );
    let dead_owner = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(absent_tid.to_string()),
        live_session_key: None,
        pid: Some(prior_pid),
        ownership_id: None,
    };
    let outcome = rig
        .runner
        .stop_runtime(
            &handoff_req_terminal("claude", &sid, "claude"),
            &dead_owner,
            "test",
            "op-r6-f2-dead",
            2,
        )
        .await;
    assert!(
        matches!(outcome, super::StopOutcomePriv::Reaped),
        "the confirmed pid-death path still reaps — got {outcome:?}"
    );
}

/// b8ke ext r7 F5: the replacement fence watcher's TERMINAL prior
/// confirmation uses the recorded PID's OS-level death — never the
/// registry row's disappearance. kill_internal removes the row BEFORE the
/// blocking kill/reap, so a concurrent kill can create a short interval
/// where the row is gone while the prior process still lives: pre-r7 the
/// watcher released the fence in that window (a dual-writer consequence);
/// post-r7 the row-absent/live-pid window HOLDS the fence and the
/// confirmed pid-death path releases.
#[tokio::test]
async fn the_replacement_probe_never_confirms_a_terminal_prior_on_a_missing_row() {
    let _guard = ENV_LOCK.lock().await;
    let _claude_env = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeSidecarEnv::install();
    let rig = build_rig_inner(None, None, None, 10_000, None, false, None, None);
    // The prior's stand-in process: ALIVE, its registry row ABSENT — the
    // exact row-removed-but-not-yet-reaped shape a concurrent kill
    // produces.
    let mut prior = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn the prior's stand-in");
    let prior_pid = prior.id();
    let absent_tid = "T-r7-f5-absent";
    assert!(
        rig.registry.terminal_is_dead(absent_tid),
        "precondition: the recorded pane's row is absent"
    );
    assert!(
        freshell_terminal::registry::pid_alive(prior_pid),
        "precondition: the recorded runtime still lives"
    );
    let live_prior = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(absent_tid.to_string()),
        live_session_key: None,
        pid: Some(prior_pid),
        ownership_id: None,
    };

    // THE WINDOW: the row is gone while the pid lives — the replacement
    // probe must NOT confirm in that window (pre-r7 the row-based
    // predicate confirmed immediately).
    let probe = tokio::time::timeout(
        Duration::from_millis(600),
        rig.runner
            .prior_death_reconfirmation("claude", "sid-r7-f5", &live_prior),
    )
    .await;
    assert!(
        probe.is_err(),
        "the row-absent/live-pid window must NOT confirm the prior's death \
         (the probe kept polling — pre-r7 the row predicate confirmed \
         immediately over the still-live prior)"
    );

    // The confirmed pid-death path releases: the stand-in dies and is
    // reaped (a zombie still answers kill(pid, 0)), then the probe
    // confirms.
    prior.kill().expect("SIGKILL the stand-in");
    let _ = prior.wait().expect("reap the stand-in");
    assert!(
        !freshell_terminal::registry::pid_alive(prior_pid),
        "precondition: the recorded runtime is confirmed dead"
    );
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        rig.runner
            .prior_death_reconfirmation("claude", "sid-r7-f5", &live_prior),
    )
    .await
    .expect("the probe confirms once the pid is dead");
    assert!(matches!(answer, super::ReapAnswer::Confirmed));
}

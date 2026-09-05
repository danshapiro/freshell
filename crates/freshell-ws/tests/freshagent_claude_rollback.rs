//! Kata 1wxv Task 4: end-to-end claude rollback dispatch through the REAL WS
//! pipeline against a scripted fake sidecar. The inline fake implements the
//! production sidecar protocol plus the fork-at-point additions: on create with
//! `forkSession:true` it mints a NEW cliSessionId and writes the transcript PREFIX
//! (up to and including `resumeSessionAt`) for the child under the fake
//! CLAUDE_CONFIG_DIR; every create line is logged to `$FAKE_ROLLBACK_SIDECAR_LOG`
//! for assertion. The pane-ledger rollback row is real (`PaneLedger` rooted under
//! the temp HOME's `.freshell/pane-ledger`), and the fresh-agent snapshot REST
//! route is mounted on the same axum app (mirroring freshell-server's main.rs).
//!
//! Harness conventions mirror `freshagent_claude_kill_interrupt.rs`: real axum
//! server on an ephemeral loopback port, real tokio-tungstenite client, the
//! `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` production env-var overrides,
//! and one `CLAUDE_ENV_LOCK` serializing the env-var mutation.

mod common;
use common::{connect_and_capture_inventory, TestWs, AUTH_TOKEN};

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_freshagent::{
    FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord, SinkWrite,
};
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
use freshell_ws::WsState;

/// Serializes every test in this file (process-global env vars + one fake store).
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── rollback-aware fake claude sidecar ──────────────────────────────────────

/// The production protocol (`create`/`send`/`shutdown`) plus fork-at-point: a
/// create carrying `forkSession:true` mints a NEW durable cli id and writes the
/// resume transcript's PREFIX (up to and including `resumeSessionAt`, walked along
/// the raw parentUuid chain) as the child's file — the source file is NEVER
/// touched (Stage-2-proven SDK invariant: the original's JSONL is hash-identical
/// after a fork). A `<n>`-th `send` appends a uuid-chained u<n>/a<n> pair (the
/// user line carries the verbatim prompt text) and answers `sdk.status idle`
/// (the in_turn clear edge) — NEVER a result frame, so no completion chime can
/// leak into the rollback capture.
const FAKE_ROLLBACK_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const logPath = process.env.FRESHELL_TEST_CLAUDE_ROLLBACK_LOG
const storeRoot = process.env.CLAUDE_CONFIG_DIR
const projDir = path.join(storeRoot, 'projects', 'fakeproj')

let mintCounter = 0
let cliId = null
let turnCount = 0

function transcriptPath(id) { return path.join(projDir, `${id}.jsonl`) }
function readLines(id) {
  try { return fs.readFileSync(transcriptPath(id), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
function mintCliId() {
  mintCounter += 1
  return `ffffffff-0000-4000-8000-${String(process.pid).padStart(4, '0')}${String(mintCounter).padStart(4, '0')}`.slice(0, 36)
}
function prefixThrough(lines, atUuid) {
  // The RAW parentUuid chain walk: keep up to AND including the named uuid
  // (resumeSessionAt semantics), every line — display filtering is NEVER the
  // chain's business.
  const byUuid = new Map()
  for (const line of lines) {
    try {
      const v = JSON.parse(line)
      if (v.uuid) byUuid.set(v.uuid, { line, parent: v.parentUuid ?? null })
    } catch { /* skip */ }
  }
  const keep = new Set()
  let cur = atUuid
  while (cur && byUuid.has(cur)) {
    keep.add(cur)
    cur = byUuid.get(cur).parent
  }
  return lines.filter((line) => {
    try { const v = JSON.parse(line); return v.uuid ? keep.has(v.uuid) : false } catch { return false }
  })
}

let placeholderCounter = 0
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.type === 'create') {
    // Log the WHOLE create request verbatim — the harness asserts resume/fork keys.
    if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(msg)}\n`)
    placeholderCounter += 1
    const sessionId = `fake-sidecar-${process.pid}-${placeholderCounter}`
    fs.mkdirSync(projDir, { recursive: true })
    if (msg.forkSession === true) {
      // Fork-at-point: NEW durable id, child file = the parent transcript's prefix.
      const src = msg.resumeSessionId
      let lines = readLines(src)
      if (msg.resumeSessionAt) lines = prefixThrough(lines, msg.resumeSessionAt)
      cliId = mintCliId()
      turnCount = 0
      fs.writeFileSync(transcriptPath(cliId), lines.length ? `${lines.join('\n')}\n` : '')
    } else {
      cliId = mintCliId()
      turnCount = 0
      fs.writeFileSync(transcriptPath(cliId), '')
    }
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId: cliId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'send') {
    turnCount += 1
    let parent = null
    for (const line of readLines(cliId)) {
      try { const v = JSON.parse(line); if (v.uuid) parent = v.uuid } catch { /* skip */ }
    }
    const u = `u${turnCount}`
    const a = `a${turnCount}`
    const user = { type: 'user', uuid: u, parentUuid: parent, timestamp: `t${turnCount}a`, cwd: '/tmp', message: { role: 'user', content: [{ type: 'text', text: msg.text }] } }
    const assistant = { type: 'assistant', uuid: a, parentUuid: u, timestamp: `t${turnCount}b`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${turnCount}` }] } }
    fs.appendFileSync(transcriptPath(cliId), `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`)
    // The rollback capture surface must NEVER see a completion chime; idle is the
    // busy-clear edge.
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'rollback.quiesce') {
    // ep4-r3 wire parity: rollback's pre-teardown probe — this fake never has
    // an inflight turn at that point (its sends settle their statuses
    // immediately) and nothing sits in an SDK-input queue.
    process.stdout.write(JSON.stringify({ type: 'sdk.rollback.quiesced', sessionId: msg.sessionId, probeId: msg.probeId ?? null, cancelledQueue: 0, inFlightTurn: false, handedCompactLikely: false }) + '\n')
  } else if (msg.type === 'interrupt') {
    // ep4-r2 wire parity: the real sidecar always answers with the signed
    // settle; on this fake nothing is ever in flight mid-rollback, matching
    // the real sidecar's 'no in-flight SDK query' answer (NO trailing result
    // — no turn exists to terminate).
    process.stdout.write(JSON.stringify({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: false, message: 'no in-flight SDK query' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// One test's installed rig: fake sidecar on disk + env vars + temp HOME.
struct RollbackRig {
    home: tempfile::TempDir,
    sidecar_log: PathBuf,
}
impl RollbackRig {
    fn install() -> Self {
        let home = tempfile::tempdir().expect("temp home");
        let dir = home.path().join("rig");
        std::fs::create_dir_all(&dir).expect("rig dir");
        let script = dir.join("fake-claude-rollback-sidecar.mjs");
        std::fs::write(&script, FAKE_ROLLBACK_SIDECAR_SOURCE).expect("write fake sidecar");
        let sidecar_log = dir.join("creates.log");
        std::fs::write(&sidecar_log, "").expect("init creates log");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("FRESHELL_TEST_CLAUDE_ROLLBACK_LOG", &sidecar_log);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path().join("claude-store"));
        Self { home, sidecar_log }
    }

    fn ledger_dir(&self) -> PathBuf {
        self.home.path().join(".freshell/pane-ledger")
    }
    /// Every create request the fake sidecar received, in order.
    fn create_lines(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.sidecar_log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("create log line is JSON"))
            .collect()
    }
}
impl Drop for RollbackRig {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_ROLLBACK_LOG");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
    }
}

/// The rollback-record-provisioning identity sink, backed by the REAL pane
/// ledger — mirrors `freshell-server/src/identity_sink.rs`'s LedgerIdentitySink
/// (the ws-test crate cannot depend on freshell-server: the dep edge runs the
/// other way), INCLUDING the claude-adoption rollback-row re-key that rides the
/// awaited binding batch.
struct TestLedgerSink {
    ledger: Arc<PaneLedger>,
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
            tokio::task::spawn_blocking(move || ledger.record_pending(&p, &m, c.as_deref(), now))
                .await
                .map_err(std::io::Error::other)?
        })
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = Self::now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
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
    fn load_settings(&self, _provider: &str, _session_id: &str) -> Option<FreshAgentSettings> {
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
}

fn test_settings_value() -> Value {
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

/// Real axum server (ephemeral loopback) with the ws route AND the fresh-agent
/// snapshot route merged (mirroring freshell-server's main.rs), the pane ledger
/// rooted under the rig's `.freshell/pane-ledger`, and fresh_claude's identity
/// sink wired to it. Returns (ws_url, http_addr, ledger).
async fn spawn_server_with_rollback_rig(
    rig: &RollbackRig,
) -> (String, std::net::SocketAddr, Arc<PaneLedger>) {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let pane_ledger = Arc::new(PaneLedger::new(Some(rig.ledger_dir())));

    let fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
    fresh_claude.set_identity_sink(Arc::new(TestLedgerSink {
        ledger: Arc::clone(&pane_ledger),
    }));

    let state = WsState {
        pane_ledger: Arc::clone(&pane_ledger),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
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
            json!({ "freshAgent": { "enabled": true } }),
        ),
        fresh_claude: fresh_claude.clone(),
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

    let fresh_agent = freshell_freshagent::FreshAgentState::new(
        Arc::clone(&auth_token),
        Arc::clone(&broadcast_tx),
    );
    let snapshot_state = freshell_freshagent::SnapshotState::new(
        Arc::clone(&auth_token),
        state.fresh_codex.clone(),
        fresh_agent,
        state.fresh_claude.clone(),
    );
    let router =
        freshell_ws::router(state).merge(freshell_freshagent::snapshot::router(snapshot_state));
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (format!("ws://{addr}/ws"), addr, pane_ledger)
}

async fn send_json(ws: &mut TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// A capture bag with a CONSUME cursor: every awaited scan STARTS with the
/// bag's unconsumed tail (a prior await's drain may already have captured the
/// wanted frame — the undo ack's drain also captures the materialized broadcast
/// riding immediately behind it), and consumes exactly the matched frame.
#[derive(Default)]
struct FrameBag {
    entries: Vec<(bool, Value)>,
}
impl FrameBag {
    fn collect(&mut self, value: Value) {
        self.entries.push((false, value));
    }
    fn take_matching(&mut self, pred: &dyn Fn(&Value) -> bool) -> Option<Value> {
        let pos = self
            .entries
            .iter()
            .position(|(consumed, v)| !*consumed && pred(v))?;
        self.entries[pos].0 = true;
        Some(self.entries[pos].1.clone())
    }
    fn recent_types(&self) -> Vec<String> {
        self.entries
            .iter()
            .rev()
            .take(12)
            .map(|(_, f)| {
                format!(
                    "{}/{}",
                    f["type"].as_str().unwrap_or("?"),
                    f["event"]["type"].as_str().unwrap_or("-")
                )
            })
            .collect()
    }
}

/// Drain frames into `bag` until `pred` matches one (bounded); returns the match.
async fn await_frame_into(
    ws: &mut TestWs,
    bag: &mut FrameBag,
    budget_secs: u64,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(budget_secs);
    loop {
        if let Some(value) = bag.take_matching(&pred) {
            return value;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "frame within budget (recent frames seen: {:?})",
                    bag.recent_types()
                )
            })
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = msg {
            bag.collect(serde_json::from_str(&text).unwrap());
        }
    }
}

async fn http_get_json(addr: &std::net::SocketAddr, path: &str) -> Value {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("http connect");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-auth-token: {AUTH_TOKEN}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("http write");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("http read");
    let text = String::from_utf8(buf).expect("utf8 response");
    let body = text.split("\r\n\r\n").nth(1).expect("http body present");
    serde_json::from_str(body.trim()).expect("json snapshot body")
}

/// Boot the rig and drive a freshclaude pane through `prompts` sends; returns
/// (ws, original durable cli id, every frame seen so far).
async fn drive_conversation(
    rig: &RollbackRig,
    prompts: &[&str],
) -> (
    TestWs,
    std::net::SocketAddr,
    Arc<PaneLedger>,
    FrameBag,
    String,
) {
    let (url, addr, ledger) = spawn_server_with_rollback_rig(rig).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let mut frames = FrameBag::default();

    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-create-1",
            "sessionType": "freshclaude",
            "provider": "claude",
        }),
    )
    .await;
    await_frame_into(&mut ws, &mut frames, 15, |v| {
        v["type"] == json!("freshAgent.created") && v["requestId"] == json!("req-create-1")
    })
    .await;
    // The durable id arrives on the session.init broadcast; its consumer-side fold
    // (cli_index insert) precedes the broadcast, so this settles the alias too.
    let init = await_frame_into(&mut ws, &mut frames, 15, |v| {
        v["type"] == json!("freshAgent.event")
            && v["event"]["type"] == json!("freshAgent.session.init")
    })
    .await;
    let original = init["event"]["cliSessionId"]
        .as_str()
        .expect("cliSessionId on the init frame")
        .to_string();
    // Drain the POST-CREATE idle (the fake emits one idle right after init): each
    // per-send idle await below must pair with THAT send's emission, or the undo
    // could observe a not-yet-appended transcript.
    await_frame_into(&mut ws, &mut frames, 15, |v| {
        v["type"] == json!("freshAgent.event")
            && v["event"]["type"] == json!("freshAgent.status")
            && v["event"]["status"] == json!("idle")
    })
    .await;
    for (i, prompt) in prompts.iter().enumerate() {
        send_json(
            &mut ws,
            &json!({
                "type": "freshAgent.send",
                "provider": "claude",
                "sessionId": original,
                "sessionType": "freshclaude",
                "text": prompt,
                "requestId": format!("send-{i}"),
            }),
        )
        .await;
        await_frame_into(&mut ws, &mut frames, 15, |v| {
            v["type"] == json!("freshAgent.send.accepted")
                && v["requestId"] == json!(format!("send-{i}"))
        })
        .await;
        // The fake appends the u<n>/a<n> pair BEFORE answering idle, so this waits
        // out both the transcript append AND the busy-clear edge.
        await_frame_into(&mut ws, &mut frames, 15, |v| {
            v["type"] == json!("freshAgent.event")
                && v["event"]["type"] == json!("freshAgent.status")
                && v["event"]["status"] == json!("idle")
        })
        .await;
    }
    (ws, addr, ledger, frames, original)
}

fn rollback_frame(request_id: &str, kind: &str, session_id: &str, mode: &str) -> Value {
    json!({
        "type": format!("freshAgent.{kind}"),
        "provider": "claude",
        "sessionId": session_id,
        "sessionType": "freshclaude",
        "requestId": request_id,
        "mode": mode,
    })
}

/// The durable rollback row files under `rollback/claude/` — exactly the rows the
/// ledger holds for this provider.
fn rollback_rows(ledger_dir: &Path) -> Vec<Value> {
    let dir = ledger_dir.join("rollback").join("claude");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).unwrap()).unwrap())
        .collect()
}

fn assert_never_completes(frames: &FrameBag) {
    assert!(
        frames.entries.iter().all(|(_, f)| {
            f.get("event")
                .and_then(|e| e.get("type"))
                .and_then(Value::as_str)
                != Some("freshAgent.turn.complete")
        }),
        "a rollback NEVER chimes — no freshAgent.turn.complete anywhere in the capture"
    );
}

/// The canonical Task 4 flow: two sends → undo step → the ack/materalized pair →
/// every assertion the kata pins on the undo leg. Returns the state needed to
/// continue (redo test drives on from here).
async fn setup_and_undo_two_turn_conversation() -> (
    RollbackRig,
    TestWs,
    std::net::SocketAddr,
    Arc<PaneLedger>,
    FrameBag,
    String,
    String,
) {
    let rig = RollbackRig::install();
    let (mut ws, addr, ledger, mut frames, original) =
        drive_conversation(&rig, &["first prompt", "second prompt"]).await;

    send_json(
        &mut ws,
        &rollback_frame("rb-undo-1", "undo", &original, "step"),
    )
    .await;
    let ack = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.event")
            && v["event"]["type"] == json!("freshAgent.rolledBack")
    })
    .await;
    assert_eq!(ack["event"]["requestId"], json!("rb-undo-1"));
    assert_eq!(ack["event"]["mode"], json!("step"));
    assert_eq!(
        ack["event"]["removedPromptText"],
        json!("second prompt"),
        "the ack carries the removed prompt for the composer refill"
    );
    assert_eq!(ack["event"]["canRedo"], json!(true));
    let new_id = ack["event"]["newSessionId"]
        .as_str()
        .expect("claude ack carries the adopted id")
        .to_string();
    assert_ne!(new_id, original, "forkSession mints a fresh durable id");
    let removed: Vec<&str> = ack["event"]["removedTurnIds"]
        .as_array()
        .expect("removedTurnIds")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(removed, vec!["u2", "a2"], "{ack}");

    // The materialized broadcast re-keyed the pane (existing repoint idiom).
    let materialized = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.session.materialized")
    })
    .await;
    assert_eq!(materialized["previousSessionId"], json!(original));
    assert_eq!(materialized["sessionId"], json!(new_id));

    // The fake sidecar saw the fork-at-point create with EXACTLY the computed options.
    let creates = rig.create_lines();
    let fork_create = creates
        .iter()
        .find(|l| l["forkSession"] == json!(true))
        .expect("fork create observed");
    assert_eq!(fork_create["resumeSessionId"], json!(original));
    assert_eq!(
        fork_create["resumeSessionAt"],
        json!("a1"),
        "keep prefix through a1"
    );
    assert_eq!(
        fork_create["resumeDropsTurn"],
        json!("u2"),
        "the guard is the first-to-discard turn's prompt uuid"
    );

    // REST snapshot by the NEW id is the prefix ("turns[] equals what the model sees next").
    let snapshot = http_get_json(
        &addr,
        &format!("/api/fresh-agent/threads/freshclaude/claude/{new_id}"),
    )
    .await;
    let turns = snapshot["turns"].as_array().expect("turns");
    assert_eq!(turns.len(), 2, "prefix only: u1+a1");
    assert_eq!(turns[0]["items"][0]["text"], json!("first prompt"));
    assert_eq!(turns[1]["items"][0]["text"], json!("answer 1"));

    // The durable record: original_session_id + original_tip_uuid recorded for the
    // redo contract, re-keyed to the adopted id (exactly ONE row survives the move).
    let rows = rollback_rows(&rig.ledger_dir());
    assert_eq!(rows.len(), 1, "the rollback row MOVED old→new: {rows:?}");
    let record = &rows[0];
    assert_eq!(record["originalSessionId"], json!(original));
    assert_eq!(
        record["originalTipUuid"],
        json!("a2"),
        "undo stamps the original's raw-chain tip"
    );
    assert_eq!(record["canRedo"], json!(true));
    assert!(record["redoDestroyed"].is_boolean() && record["redoDestroyed"] == json!(false));
    let entry_ids: Vec<&str> = record["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .flat_map(|e| e["removedTurns"].as_array().expect("removedTurns").iter())
        .filter_map(|t| t["turnId"].as_str())
        .collect();
    assert_eq!(
        entry_ids,
        vec!["u2", "a2"],
        "the marker bucket carries the removed slice (r3 union)"
    );

    assert_never_completes(&frames);
    (rig, ws, addr, ledger, frames, original, new_id)
}

#[tokio::test]
async fn claude_undo_recreates_the_sidecar_with_resume_session_at_and_rekeys_the_pane() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let (rig, _ws, _addr, _ledger, _frames, _original, _new_id) =
        setup_and_undo_two_turn_conversation().await;
    drop(rig);
}

#[tokio::test]
async fn claude_redo_reforks_from_the_original_at_a_later_point() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let (rig, mut ws, addr, _ledger, mut frames, original, new_id) =
        setup_and_undo_two_turn_conversation().await;

    send_json(
        &mut ws,
        &rollback_frame("rb-redo-1", "redo", &new_id, "step"),
    )
    .await;
    let ack = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.event") && v["event"]["type"] == json!("freshAgent.redone")
    })
    .await;
    assert_eq!(ack["event"]["requestId"], json!("rb-redo-1"));
    assert_eq!(
        ack["event"]["restoredThroughTurnId"],
        json!("a2"),
        "redo restores through the restored step's OWN last uuid (r3 boundary rule)"
    );
    assert_eq!(
        ack["event"]["canRedo"],
        json!(false),
        "nothing lies beyond the chain-root tip after restoring to it"
    );
    let redone_id = ack["event"]["newSessionId"]
        .as_str()
        .expect("claude ack carries the adopted id")
        .to_string();
    assert_ne!(redone_id, new_id);

    // The observed create re-forks the ORIGINAL (the chain root), keeping through
    // the restored step's group end — never the prefix's current tip + never the
    // discarded fork.
    let creates = rig.create_lines();
    let fork_creates: Vec<&Value> = creates
        .iter()
        .filter(|l| l["forkSession"] == json!(true))
        .collect();
    assert_eq!(fork_creates.len(), 2, "{creates:?}");
    let redo_create = fork_creates[1];
    assert_eq!(redo_create["resumeSessionId"], json!(original));
    assert_eq!(redo_create["resumeSessionAt"], json!("a2"));
    assert_eq!(redo_create["forkSession"], json!(true));
    assert!(
        redo_create.get("resumeDropsTurn").is_none(),
        "the guard is omitted when the discard range is empty (redo to the tip)"
    );

    // The new snapshot carries all four turns again.
    let snapshot = http_get_json(
        &addr,
        &format!("/api/fresh-agent/threads/freshclaude/claude/{redone_id}"),
    )
    .await;
    let turns = snapshot["turns"].as_array().expect("turns");
    assert_eq!(
        turns.len(),
        4,
        "the restored conversation is whole: {snapshot}"
    );

    // The record followed the pane again; the restored turns left the marker bucket.
    let rows = rollback_rows(&rig.ledger_dir());
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["canRedo"], json!(false));
    assert!(
        rows[0]["entries"].as_array().expect("entries").is_empty(),
        "the restored turns left the current-epoch marker portion: {}",
        rows[0]
    );
    assert_never_completes(&frames);
    drop(rig);
}

#[tokio::test]
async fn claude_undo_of_the_only_turn_empties_the_conversation_via_a_fresh_create() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let rig = RollbackRig::install();
    let (mut ws, addr, _ledger, mut frames, original) =
        drive_conversation(&rig, &["first prompt"]).await;

    // r2: first-turn rollback is LEGAL. Undo of the only step → exactly ONE ack
    // (removedPromptText == the only prompt, canRedo == true) and a FRESH create
    // (NO resume/fork keys — the empty fresh transcript IS the rollback target).
    send_json(
        &mut ws,
        &rollback_frame("rb-first-u", "undo", &original, "step"),
    )
    .await;
    let ack = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.event")
            && v["event"]["type"] == json!("freshAgent.rolledBack")
    })
    .await;
    assert_eq!(ack["event"]["removedPromptText"], json!("first prompt"));
    assert_eq!(ack["event"]["canRedo"], json!(true));
    let fresh_id = ack["event"]["newSessionId"]
        .as_str()
        .expect("adopted id")
        .to_string();
    let materialized = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.session.materialized")
    })
    .await;
    assert_eq!(materialized["sessionId"], json!(fresh_id));
    assert_ne!(fresh_id, original);

    let creates = rig.create_lines();
    assert_eq!(
        creates.len(),
        2,
        "the initial create + the rollback's FRESH create: {creates:?}"
    );
    let fresh_create = &creates[1];
    for key in [
        "resumeSessionId",
        "resumeSessionAt",
        "forkSession",
        "resumeDropsTurn",
    ] {
        assert!(
            fresh_create.get(key).is_none(),
            "the fresh-conversation leg carries NO resume/fork keys ({key} absent): {fresh_create}"
        );
    }

    // The record retained the discarded session as the redo source.
    let rows = rollback_rows(&rig.ledger_dir());
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["originalSessionId"], json!(original));
    assert_eq!(
        rows[0]["originalTipUuid"],
        json!("a1"),
        "the discarded chain's tip"
    );
    assert_eq!(rows[0]["canRedo"], json!(true));

    // The live conversation is genuinely EMPTY (a fresh durable id, empty transcript).
    let snapshot = http_get_json(
        &addr,
        &format!("/api/fresh-agent/threads/freshclaude/claude/{fresh_id}"),
    )
    .await;
    assert_eq!(snapshot["turns"].as_array().expect("turns").len(), 0);

    // A following redo re-forks the ORIGINAL at the LAST raw-chain uuid of the
    // restored u1/a1 step's group — its assistant tail (the r3 boundary fix:
    // resumeSessionAt keeps through-AND-including the named uuid, so the target
    // is a1, NOT u1 — resuming at u1 would restore only the bare prompt).
    send_json(
        &mut ws,
        &rollback_frame("rb-first-r", "redo", &fresh_id, "step"),
    )
    .await;
    let redone = await_frame_into(&mut ws, &mut frames, 20, |v| {
        v["type"] == json!("freshAgent.event") && v["event"]["type"] == json!("freshAgent.redone")
    })
    .await;
    assert_eq!(redone["event"]["restoredThroughTurnId"], json!("a1"));
    let restored_id = redone["event"]["newSessionId"]
        .as_str()
        .expect("adopted id")
        .to_string();
    let creates = rig.create_lines();
    assert_eq!(creates.len(), 3, "{creates:?}");
    let redo_create = &creates[2];
    assert_eq!(redo_create["forkSession"], json!(true));
    assert_eq!(redo_create["resumeSessionId"], json!(original));
    assert_eq!(
        redo_create["resumeSessionAt"],
        json!("a1"),
        "the r3 boundary rule — resume at a1, NOT u1"
    );
    let snapshot = http_get_json(
        &addr,
        &format!("/api/fresh-agent/threads/freshclaude/claude/{restored_id}"),
    )
    .await;
    assert_eq!(
        snapshot["turns"].as_array().expect("turns").len(),
        2,
        "the whole u1/a1 step is restored"
    );
    assert_never_completes(&frames);
    drop(rig);
}

/// Sanity guard for the raw-HTTP helper's framing (keeps the ws::Write import
/// meaningful; exercises the same surface the snapshot GETs use).
#[test]
fn http_request_write_is_plain_bytes() {
    let dir = std::env::temp_dir().join("freshell-rollback-http-sanity.bin");
    let mut f = std::fs::File::create(&dir).unwrap();
    let request = format!("GET /x HTTP/1.1\r\nx-auth-token: {AUTH_TOKEN}\r\n\r\n");
    f.write_all(request.as_bytes()).unwrap();
    assert!(std::fs::read_to_string(&dir).unwrap().contains("GET /x"));
    let _ = std::fs::remove_file(&dir);
}

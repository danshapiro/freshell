//! A new freshclaude/kilroy pane's messages run, sent the way the browser sends
//! them, on a server whose ownership coordinator is wired the way
//! `crates/freshell-server/src/main.rs` wires it (one
//! `RuntimeOwnershipRegistry` shared by the WS state and the claude lane).
//!
//! The browser sends every message with a checkpoint intent
//! (`FreshAgentView.tsx`'s `sendFreshAgentSendFrame`), and once a
//! `session.runtimeOwner` frame named the pane's durable session id it also
//! carries that record's observed `(epoch, generation)` pair. `handle_send`
//! fences such a send through the coordinator. The claude lane's pane id is the
//! sidecar's placeholder; the coordinator owns the session under the durable id
//! the CLI reports in `system/init` (`sdk.session.init`). The real CLI reports
//! it only once a prompt runs; the e2e fake reports it at create. Both orders
//! are covered here.
//!
//! The claude sidecar is a scripted fake (the production
//! `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` overrides): no SDK, no
//! network. It logs every prompt it receives, so "the message ran" is observed
//! at the process boundary, not inferred from a frame.

mod common;
use common::{TestWs, AUTH_TOKEN, FRAME_BUDGET};

use std::path::PathBuf;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

/// Serializes every test in this file: they set the process-global sidecar
/// env vars the claude lane reads at spawn time.
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── fake claude sidecar ─────────────────────────────────────────────────────

/// The production newline-JSON sidecar protocol, reduced to create / send /
/// interrupt / shutdown. The session is reported (`sdk.session.init`, the CLI's
/// `system/init`) at the start of every turn, as the real CLI does, and
/// `FRESHELL_TEST_CLAUDE_INIT_AT` picks whether it is also reported earlier:
///   - `first-prompt`: never before the first prompt runs, like the real CLI;
///   - `create`: also right after `created`, like the e2e fake sidecar.
///
/// Every prompt is one turn: assistant text, a `success` result, one
/// `sdk.turn.complete` with a strictly increasing `at`, then idle. Each prompt's
/// text is appended to `FRESHELL_TEST_CLAUDE_SEND_LOG`.
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

const initAt = process.env.FRESHELL_TEST_CLAUDE_INIT_AT
const sendLog = process.env.FRESHELL_TEST_CLAUDE_SEND_LOG
const sessions = new Map()
let counter = 0
let lastAt = 0
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')

function reportSession(sessionId, st) {
  emit({ type: 'sdk.session.init', sessionId, cliSessionId: st.cliSessionId, model: 'fake-model', cwd: process.cwd(), tools: [] })
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('close', () => process.exit(0))
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-${process.pid}-${counter}`
    const st = { cliSessionId: randomUUID() }
    sessions.set(sessionId, st)
    emit({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
    if (initAt === 'create') reportSession(sessionId, st)
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'send') {
    const st = sessions.get(msg.sessionId)
    if (!st) return
    if (sendLog) fs.appendFileSync(sendLog, `${msg.text}\n`)
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    reportSession(msg.sessionId, st)
    emit({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: `echo: ${msg.text}` }], model: 'fake-model' })
    emit({ type: 'sdk.result', sessionId: msg.sessionId, result: 'success' })
    lastAt = Math.max(Date.now(), lastAt + 1)
    emit({ type: 'sdk.turn.complete', sessionId: msg.sessionId, at: lastAt })
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' })
  } else if (msg.type === 'interrupt') {
    emit({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, ok: false, message: 'no in-flight SDK query' })
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// When the fake sidecar reports the session.
#[derive(Clone, Copy)]
enum InitAt {
    /// As the first prompt runs (the real CLI).
    FirstPrompt,
    /// Right after create (the e2e fake sidecar).
    Create,
}

/// The installed fake sidecar: script + prompt log in a temp dir, env vars set.
/// The caller holds [`CLAUDE_ENV_LOCK`] for its lifetime.
struct FakeSidecar {
    _dir: tempfile::TempDir,
    send_log: PathBuf,
}

impl FakeSidecar {
    fn install(init_at: InitAt) -> Self {
        let dir = tempfile::tempdir().expect("fake sidecar temp dir");
        let script = dir.path().join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        let send_log = dir.path().join("sends.log");
        std::fs::write(&send_log, "").expect("init send log");
        let init_at = match init_at {
            InitAt::FirstPrompt => "first-prompt",
            InitAt::Create => "create",
        };
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("FRESHELL_TEST_CLAUDE_INIT_AT", init_at);
        std::env::set_var("FRESHELL_TEST_CLAUDE_SEND_LOG", &send_log);
        Self {
            _dir: dir,
            send_log,
        }
    }

    /// Every prompt the sidecar received, in order.
    fn prompts(&self) -> Vec<String> {
        std::fs::read_to_string(&self.send_log)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

impl Drop for FakeSidecar {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_INIT_AT");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_SEND_LOG");
    }
}

// ── server: the ownership coordinator wired like main.rs ────────────────────

fn settings_value() -> Value {
    let mut settings = common::test_settings_value();
    settings["freshAgent"]["enabled"] = json!(true);
    settings
}

/// A real axum server on an ephemeral loopback port (never 3001/3002) whose
/// claude lane and WS state share ONE ownership coordinator, as in main.rs.
async fn spawn_server(ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>) -> String {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(256).0);
    let mut fresh_claude = freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx));
    fresh_claude.set_ownership(Arc::clone(&ownership));

    let state = WsState {
        pane_ledger: Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        layout: Default::default(),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        terminal_meta: Default::default(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings: Arc::new(serde_json::from_value(settings_value()).expect("valid settings")),
        handshake_settings: Arc::new(tokio::sync::RwLock::new(
            serde_json::from_value(settings_value()).expect("valid settings"),
        )),
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

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    let router = freshell_ws::router(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    format!("ws://{addr}/ws")
}

// ── a browser-shaped connection that keeps every frame it read ──────────────

struct Conn {
    ws: TestWs,
    frames: Vec<Value>,
}

impl Conn {
    async fn connect(url: &str) -> Self {
        let (mut ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .expect("ws connect");
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
        let mut conn = Self {
            ws,
            frames: Vec::new(),
        };
        conn.wait_for("the ready handshake frame", |v| v["type"] == "ready")
            .await;
        conn
    }

    async fn send(&mut self, frame: Value) {
        self.ws
            .send(WsMessage::Text(frame.to_string()))
            .await
            .expect("send frame");
    }

    /// Read frames until `done` holds over every frame read so far.
    async fn wait_until(&mut self, what: &str, done: impl Fn(&[Value]) -> bool) {
        let deadline = tokio::time::Instant::now() + FRAME_BUDGET;
        while !done(&self.frames) {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let msg = tokio::time::timeout(remaining, self.ws.next())
                .await
                .unwrap_or_else(|_| {
                    panic!("timed out waiting for {what}; frames: {:#?}", self.frames)
                })
                .expect("stream not ended")
                .expect("no ws error");
            let WsMessage::Text(text) = msg else { continue };
            self.frames
                .push(serde_json::from_str(&text).expect("json frame"));
        }
    }

    /// The first frame (already read or read now) matching `pred`.
    async fn wait_for(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        self.wait_until(what, |frames| frames.iter().any(&pred))
            .await;
        self.frames
            .iter()
            .find(|v| pred(v))
            .cloned()
            .expect("the frame wait_until saw")
    }

    async fn create(&mut self, request_id: &str) -> String {
        self.send(json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "provider": "claude",
            "sessionType": "freshclaude",
        }))
        .await;
        let created = self
            .wait_for("freshAgent.created", |v| {
                v["type"] == "freshAgent.created" && v["requestId"] == request_id
            })
            .await;
        created["sessionId"]
            .as_str()
            .expect("created carries a session id")
            .to_string()
    }

    fn durable_id(&self, session_id: &str) -> Option<String> {
        durable_id(&self.frames, session_id)
    }

    fn observed_owner(&self, session_id: &str) -> Option<(u64, u64)> {
        observed_owner(&self.frames, session_id)
    }

    /// A `freshAgent.send` shaped like the browser's: a checkpoint intent, and
    /// the given observed owner pair when there is one.
    async fn send_checkpointed(
        &mut self,
        session_id: &str,
        request_id: &str,
        text: &str,
        observed: Option<(u64, u64)>,
    ) {
        let mut frame = json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
            "requestId": request_id,
            "checkpointIntent": { "logicalAttemptId": format!("attempt-{request_id}") },
            "text": text,
        });
        if let Some((epoch, generation)) = observed {
            frame["observedEpoch"] = json!(epoch);
            frame["observedGeneration"] = json!(generation);
        }
        self.send(frame).await;
    }

    /// The browser's send: the observed pair rides along once it holds one.
    async fn send_like_the_browser(&mut self, session_id: &str, request_id: &str, text: &str) {
        let observed = self.observed_owner(session_id);
        self.send_checkpointed(session_id, request_id, text, observed)
            .await;
    }

    /// The request's outcome: its `freshAgent.send.accepted` or its `error`.
    async fn send_outcome(&mut self, request_id: &str) -> Value {
        self.wait_for(&format!("{request_id} to be accepted or refused"), |v| {
            v["requestId"] == request_id
                && (v["type"] == "error" || v["type"] == "freshAgent.send.accepted")
        })
        .await
    }

    /// The request ran: it was accepted (never refused) and the session's
    /// `turn`-th turn-complete edge arrived.
    async fn expect_send_runs(&mut self, session_id: &str, request_id: &str, turn: usize) {
        let outcome = self.send_outcome(request_id).await;
        assert_eq!(
            outcome["type"], "freshAgent.send.accepted",
            "{request_id} must run, not be refused: {outcome}"
        );
        self.wait_until(&format!("turn-complete edge #{turn}"), |frames| {
            turn_completes(frames, session_id).len() >= turn
        })
        .await;
    }

    /// Kill the session and read through its `freshAgent.killed`, so every frame
    /// its turns produced has been read before the counts are taken.
    async fn kill(&mut self, session_id: &str) {
        self.send(json!({
            "type": "freshAgent.kill",
            "provider": "claude",
            "sessionType": "freshclaude",
            "sessionId": session_id,
        }))
        .await;
        self.wait_for("freshAgent.killed", |v| {
            v["type"] == "freshAgent.killed" && v["sessionId"] == session_id
        })
        .await;
    }

    fn events_of(&self, session_id: &str, event_type: &str) -> usize {
        self.frames
            .iter()
            .filter(|v| {
                v["type"] == "freshAgent.event"
                    && v["sessionId"] == session_id
                    && v["event"]["type"] == event_type
            })
            .count()
    }
}

/// The durable id the session's `freshAgent.session.init` reported.
fn durable_id(frames: &[Value], session_id: &str) -> Option<String> {
    frames.iter().find_map(|v| {
        (v["type"] == "freshAgent.event"
            && v["sessionId"] == session_id
            && v["event"]["type"] == "freshAgent.session.init")
            .then(|| v["event"]["cliSessionId"].as_str().map(str::to_string))
            .flatten()
    })
}

/// The owner pair the browser holds for the pane: the latest
/// `session.runtimeOwner` frame for the pane's durable id.
fn observed_owner(frames: &[Value], session_id: &str) -> Option<(u64, u64)> {
    let durable = durable_id(frames, session_id)?;
    frames.iter().rev().find_map(|v| {
        (v["type"] == "session.runtimeOwner"
            && v["provider"] == "claude"
            && v["sessionId"] == durable.as_str())
        .then(|| Some((v["epoch"].as_u64()?, v["generation"].as_u64()?)))
        .flatten()
    })
}

/// The `at` of every `freshAgent.turn.complete` edge for the session, in order.
fn turn_completes(frames: &[Value], session_id: &str) -> Vec<u64> {
    frames
        .iter()
        .filter(|v| {
            v["type"] == "freshAgent.event"
                && v["sessionId"] == session_id
                && v["event"]["type"] == "freshAgent.turn.complete"
        })
        .map(|v| v["event"]["at"].as_u64().expect("numeric at"))
        .collect()
}

// ── tests ───────────────────────────────────────────────────────────────────

/// Three messages sent the way the browser sends them each run once: each
/// reaches the sidecar, is accepted, and rings exactly one turn-complete edge.
/// The CLI reports the session again at the start of every turn, so the later
/// messages are sent after a repeated report of the session they belong to.
async fn a_new_panes_messages_each_run_once(init_at: InitAt) {
    let _env = CLAUDE_ENV_LOCK.lock().await;
    let sidecar = FakeSidecar::install(init_at);
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let url = spawn_server(Arc::clone(&ownership)).await;
    let mut conn = Conn::connect(&url).await;

    let session_id = conn.create("create-1").await;
    if matches!(init_at, InitAt::Create) {
        // The session was reported at create: the pane learns its durable id and
        // owner pair before the user types, so even the first message carries
        // the pair.
        conn.wait_until("the reported session's owner frame", |frames| {
            observed_owner(frames, &session_id).is_some()
        })
        .await;
    }
    let messages = ["first message", "second message", "third message"];
    for (index, text) in messages.iter().enumerate() {
        let turn = index + 1;
        let request_id = format!("send-{turn}");
        conn.send_like_the_browser(&session_id, &request_id, text)
            .await;
        conn.expect_send_runs(&session_id, &request_id, turn).await;
        // The first prompt made the CLI report the session (in either order), so
        // the browser now holds the durable id's owner pair and sends it.
        assert!(
            conn.observed_owner(&session_id).is_some(),
            "the coordinator announced the reported session's owner: {:#?}",
            conn.frames
        );
    }

    conn.kill(&session_id).await;
    assert_eq!(
        sidecar.prompts(),
        messages.map(str::to_string).to_vec(),
        "each message reached the sidecar exactly once"
    );
    let edges = turn_completes(&conn.frames, &session_id);
    assert_eq!(
        edges.len(),
        messages.len(),
        "one turn-complete edge per send: {edges:?}"
    );
    assert!(
        edges.windows(2).all(|pair| pair[0] < pair[1]),
        "edges are strictly increasing: {edges:?}"
    );
    assert_eq!(
        conn.events_of(&session_id, "freshAgent.result"),
        messages.len()
    );
}

mod checkpointed_sends {
    use super::*;

    /// The real CLI reports the session only once a prompt runs: nothing owns the
    /// new pane's session in the coordinator when its first message is sent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_when_the_session_is_reported_by_the_first_prompt() {
        a_new_panes_messages_each_run_once(InitAt::FirstPrompt).await;
    }

    /// The e2e fake reports the session at create: every message is sent after
    /// the coordinator owns the session under its durable id, with that record's
    /// observed pair.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_when_the_session_is_reported_at_create() {
        a_new_panes_messages_each_run_once(InitAt::Create).await;
    }

    /// The fence still guards a reported session, on the record that owns it: a
    /// message carrying an owner pair from before a lifecycle transition is
    /// refused as stale and never reaches the sidecar; the same message with the
    /// re-observed pair runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_a_stale_owner_pair_are_refused_once_the_session_is_reported() {
        let _env = CLAUDE_ENV_LOCK.lock().await;
        let sidecar = FakeSidecar::install(InitAt::Create);
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let url = spawn_server(Arc::clone(&ownership)).await;
        let mut conn = Conn::connect(&url).await;

        let session_id = conn.create("create-1").await;
        conn.wait_until("the reported session's owner frame", |frames| {
            observed_owner(frames, &session_id).is_some()
        })
        .await;
        let observed = conn
            .observed_owner(&session_id)
            .expect("observed owner pair");
        let durable = conn.durable_id(&session_id).expect("reported durable id");

        // A lifecycle transition advances the owner record's generation while the
        // session stays live here (a handoff that failed back to this runtime).
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
            "claude",
            &durable,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "test-generation-bump",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the generation-bump handoff must be granted")
        };
        let _ = ownership.fail("claude", &durable, "test-generation-bump", generation, true);
        let current = ownership.observe("claude", &durable);
        assert!(
            matches!(
                current.state,
                freshell_ownership::OwnershipState::Live { .. }
            ) && current.generation > observed.1,
            "fixture: the record is still live at a newer generation: {current:?}"
        );

        conn.send_checkpointed(&session_id, "send-stale", "stale message", Some(observed))
            .await;
        let refusal = conn.send_outcome("send-stale").await;
        assert_eq!(refusal["type"], "error", "{refusal}");
        let message = refusal["message"].as_str().unwrap_or_default();
        assert!(
            message.starts_with("SESSION_RESERVED")
                && message.contains(freshell_freshagent::ownership_lane::STALE_OP_GUARD_MESSAGE),
            "refused as stale against the record that owns the session: {refusal}"
        );

        conn.send_checkpointed(
            &session_id,
            "send-current",
            "current message",
            Some((current.epoch, current.generation)),
        )
        .await;
        conn.expect_send_runs(&session_id, "send-current", 1).await;

        conn.kill(&session_id).await;
        assert_eq!(
            sidecar.prompts(),
            vec!["current message".to_string()],
            "the stale message never reached the sidecar"
        );
        assert_eq!(turn_completes(&conn.frames, &session_id).len(), 1);
    }

    /// Before the CLI reports the session, the coordinator can still hold a
    /// record under the pane's placeholder id: a lifecycle operation started from
    /// a pane with no durable id addresses the session by that id. A message sent
    /// while the operation is in flight is refused and never reaches the sidecar;
    /// once the operation settles and nothing owns the placeholder, the same
    /// message runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_for_a_lifecycle_operation_on_the_placeholder_before_the_session_is_reported() {
        let _env = CLAUDE_ENV_LOCK.lock().await;
        let sidecar = FakeSidecar::install(InitAt::FirstPrompt);
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let url = spawn_server(Arc::clone(&ownership)).await;
        let mut conn = Conn::connect(&url).await;

        let session_id = conn.create("create-1").await;
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
            "claude",
            &session_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "test-placeholder-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the handoff on the unreported session's placeholder must be granted")
        };

        conn.send_like_the_browser(&session_id, "send-during", "message during the handoff")
            .await;
        let refusal = conn.send_outcome("send-during").await;
        assert_eq!(refusal["type"], "error", "{refusal}");
        let message = refusal["message"].as_str().unwrap_or_default();
        assert!(
            message.starts_with("SESSION_RESERVED")
                && message
                    .contains(freshell_freshagent::ownership_lane::LIFECYCLE_OP_GUARD_MESSAGE),
            "refused while the handoff owns the placeholder: {refusal}"
        );

        assert!(
            matches!(
                ownership.fail(
                    "claude",
                    &session_id,
                    "test-placeholder-handoff",
                    generation,
                    false
                ),
                freshell_ownership::FailOutcome::Vacant { .. }
            ),
            "fixture: the failed handoff leaves the placeholder vacant"
        );
        conn.send_like_the_browser(&session_id, "send-after", "message after the handoff")
            .await;
        conn.expect_send_runs(&session_id, "send-after", 1).await;

        conn.kill(&session_id).await;
        assert_eq!(
            sidecar.prompts(),
            vec!["message after the handoff".to_string()],
            "the message sent during the handoff never reached the sidecar"
        );
        assert_eq!(turn_completes(&conn.frames, &session_id).len(), 1);
    }
}

//! WS-level proof for restart-resilience P0.2 slice 1: the real dispatch
//! (`terminal.rs`'s `ClientMessage::FreshAgentAttach` arm) must route a claude/kilroy
//! `freshAgent.attach` to `FreshClaudeState::handle_attach` instead of swallowing it
//! via `_ => {}`. Unit-level coverage exists in `claude.rs::tests`, but -- exactly like
//! the kill/interrupt dispatch gap before it (`freshagent_claude_kill_interrupt.rs`) --
//! it is unreachable from the wire until the dispatch arm exists. Harness duplicated
//! from that file per the repo's per-test-file convention.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes every test in this file that mutates process-global env vars
/// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE` / `CLAUDE_CONFIG_DIR`),
/// mirroring `freshagent_claude_kill_interrupt.rs`'s convention for the same hazard.
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── fake claude sidecar (resume flavor: created + sdk.session.init + sdk.status) ──

/// A minimal scripted fake claude sidecar (no real SDK, no network, no cost) speaking
/// the SAME newline-JSON protocol `spawn_sidecar()` drives the vendored package with.
/// On `create` it replies `created`, then `sdk.session.init` echoing `resumeSessionId`
/// as the durable `cliSessionId` (resume continuity -- exactly what the real sidecar's
/// SDK init does), then `sdk.status idle`; on `send` it emits `sdk.status busy` (the
/// Task 10b event-after-rebind knob); on `shutdown` it exits. Every inbound request is
/// appended (with the sidecar's pid) to the JSONL file named by
/// `FAKE_SIDECAR_REQUEST_LOG` -- distinct pids == spawn count, `msg.type` rows prove
/// what each sidecar actually received.
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
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  logReq(msg)
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'send') {
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: 'busy' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// A fresh temp dir holding the fake sidecar script, with `FRESHELL_CLAUDE_SIDECAR`/
/// `FRESHELL_CLAUDE_NODE` pointed at it, PLUS a seeded claude transcript store with
/// `CLAUDE_CONFIG_DIR` pointed at it. Caller must hold [`CLAUDE_ENV_LOCK`] for the
/// lifetime of the returned guard.
struct FakeClaudeResumeEnv {
    dir: std::path::PathBuf,
}
impl FakeClaudeResumeEnv {
    fn install(durable: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-resume-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        std::env::set_var("FAKE_SIDECAR_REQUEST_LOG", dir.join("requests.jsonl"));
        // Seed the transcript store: one user line carrying an EXISTING cwd ("/tmp"),
        // so the resume request goes by durable UUID + original cwd (ledger A15).
        let store = dir.join("claude-store");
        let project = store.join("projects").join("-t");
        std::fs::create_dir_all(&project).expect("create transcript project dir");
        std::fs::write(
            project.join(format!("{durable}.jsonl")),
            r#"{"type":"user","cwd":"/tmp","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .expect("seed transcript");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("CLAUDE_CONFIG_DIR", &store);
        Self { dir }
    }
}
impl FakeClaudeResumeEnv {
    /// The JSONL request log the fake sidecar appends every inbound request to
    /// (`{ pid, msg }` per line) -- distinct pids == spawn count.
    fn request_log_path(&self) -> std::path::PathBuf {
        self.dir.join("requests.jsonl")
    }

    fn request_log_rows(&self) -> Vec<Value> {
        let Ok(raw) = std::fs::read_to_string(self.request_log_path()) else {
            return Vec::new();
        };
        raw.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("request log row parses"))
            .collect()
    }
}

impl Drop for FakeClaudeResumeEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::env::remove_var("FAKE_SIDECAR_REQUEST_LOG");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Dependency-free unique suffix (avoids pulling in `uuid` for this test crate).
fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id())
}

// ── server harness (duplicated from diag01_lifecycle_events.rs's convention, with
//    `freshAgent.enabled: true` so `freshAgent.create` actually dispatches) ──

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

async fn connect_and_complete_handshake(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "hello",
            "token": AUTH_TOKEN,
            "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        })
        .to_string(),
    ))
    .await
    .expect("send hello");

    // Drain the handshake frames (ready + whatever else precedes it) until `ready`.
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

/// Drain frames until one matching `predicate` arrives (or the budget expires).
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

/// A claude `freshAgent.attach` for a session id this server process does not track
/// (the always-true case right after a server restart) must produce the
/// `freshAgent.error{code:'INVALID_SESSION_ID'}` lost-session frame on the wire --
/// the frame the frozen client folds into `markSessionLost` -> `triggerRecovery`.
/// Before the fix the dispatch swallowed the message and NO frame ever arrived
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "restarted-away",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "restarted-away"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["type"], "freshAgent.error");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

/// Restart parity (Task 6): an attach for an untracked session that DOES carry a
/// durable claude UUID with a resumable transcript must be resumed in place -- the
/// server spawns a sidecar with `resumeSessionId` and emits the idle
/// `freshAgent.session.snapshot` whose `timelineSessionId` is the durable UUID (the
/// frozen client persists it unvalidated -- NEVER a nanoid), all under the CLIENT's
/// original session id. Before the fix this attach produced the lost frame instead
/// (this test then fails with `await_frame` panicking on its timeout budget).
#[tokio::test]
async fn claude_attach_with_resumable_transcript_resumes_and_emits_snapshot_over_ws() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let durable = "abababab-abab-4bab-8bab-abababababab";
    let _env = FakeClaudeResumeEnv::install(durable);

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "gone-after-restart",
            "sessionType": "freshclaude",
            "resumeSessionId": durable,
            "sessionRef": { "provider": "claude", "sessionId": durable },
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.snapshot"
    })
    .await;

    assert_eq!(frame["sessionId"], "gone-after-restart");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["status"], "idle");
    assert_eq!(frame["event"]["timelineSessionId"], durable);
}

/// Kilroy panes ride the same claude provider arm with `sessionType: "kilroy"`; the
/// envelope must echo it (through the real serde parse of `ClientMessage`, which the
/// unit tests bypass) or the client builds the wrong session locator.
#[tokio::test]
async fn kilroy_attach_for_untracked_session_emits_lost_session_frame_over_ws() {
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": "kilroy-was-here",
            "sessionType": "kilroy",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event" && v["sessionId"] == "kilroy-was-here"
    })
    .await;

    assert_eq!(frame["provider"], "claude");
    assert_eq!(frame["sessionType"], "kilroy");
    assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
}

// ── Task 10b: claude durable→live resolution (attach rebind + ack, send routing) ──
//
// claude keys live sessions by a sidecar-minted placeholder nanoid, while the reconcile
// attach verdict names the DURABLE ref. On base, `attach{durable}` on a live session is
// a silent no-op and `send{durable}` misses the sessions map (SESSION_NOT_FOUND) while
// events keep broadcasting under the placeholder — stranding the pane the fold rebound.

/// The fake sidecar's baked-in durable `cliSessionId` for a create WITHOUT resume.
const DURABLE_FALLBACK: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/// Drive a claude `freshAgent.create` (no resume) through the fake sidecar; wait for
/// `freshAgent.session.init` so `cli_index[DURABLE_FALLBACK] = placeholder` is recorded.
/// Returns the placeholder session id.
async fn create_live_claude_session(ws: &mut TestWs, request_id: &str) -> String {
    send_json(
        ws,
        &serde_json::json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
        }),
    )
    .await;
    let created = await_frame(ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == request_id
    })
    .await;
    let placeholder = created["sessionId"]
        .as_str()
        .expect("created carries sessionId")
        .to_string();
    await_frame(ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.init"
    })
    .await;
    placeholder
}

/// Attach by the DURABLE id on a LIVE session must REBIND (alias) + ACK — at least one
/// frame stamped with the durable id must reach the attaching connection. On base the
/// cli_index-hit arm is a silent no-op (this test then fails on `await_frame`'s budget).
#[tokio::test]
async fn attach_by_durable_id_on_a_live_session_rebinds_and_acks() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeResumeEnv::install(DURABLE_FALLBACK);

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let _placeholder = create_live_claude_session(&mut ws, "req-10b-attach").await;

    let mut ws2 = connect_and_complete_handshake(&url).await;
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": DURABLE_FALLBACK,
            "sessionType": "freshclaude",
            "resumeSessionId": DURABLE_FALLBACK,
            "sessionRef": { "provider": "claude", "sessionId": DURABLE_FALLBACK },
        }),
    )
    .await;

    let frame = await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["sessionId"] == DURABLE_FALLBACK
    })
    .await;
    assert_eq!(frame["type"], "freshAgent.event");

    // No second sidecar: exactly ONE create row in the fake's request log.
    let creates = env
        .request_log_rows()
        .into_iter()
        .filter(|r| r["msg"]["type"] == "create")
        .count();
    assert_eq!(creates, 1, "attach-to-live must not spawn a second sidecar");
}

/// `freshAgent.send` addressed by the DURABLE id must resolve through `cli_index` to the
/// live session — the sidecar receives the send line and `freshAgent.send.accepted`
/// lands. On base the sessions-map miss broadcasts SESSION_NOT_FOUND and no accepted
/// frame ever arrives (this test then fails on `await_frame`'s budget).
#[tokio::test]
async fn send_by_durable_id_routes_to_the_live_session() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeResumeEnv::install(DURABLE_FALLBACK);

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let _placeholder = create_live_claude_session(&mut ws, "req-10b-send").await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionId": DURABLE_FALLBACK,
            "sessionType": "freshclaude",
            "text": "ping",
            "requestId": "send-10b",
        }),
    )
    .await;

    let accepted = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.send.accepted" && v["requestId"] == "send-10b"
    })
    .await;
    assert_eq!(accepted["sessionId"], DURABLE_FALLBACK);

    // The sidecar answers every `send` with `sdk.status busy` -- awaiting it proves the
    // sidecar PROCESSED the routed send (the accepted broadcast races the log append).
    await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.status"
            && v["event"]["status"] == "busy"
    })
    .await;

    // The fake sidecar actually received the send line (routing, not just the ack).
    let sends = env
        .request_log_rows()
        .into_iter()
        .filter(|r| r["msg"]["type"] == "send")
        .count();
    assert_eq!(sends, 1, "the live sidecar must receive the routed send");
}

/// After the durable rebind, event envelopes must be stamped with the DURABLE id (the
/// broadcast stamp flips), or the pane keyed on the durable never receives events.
#[tokio::test]
async fn events_after_durable_rebind_are_stamped_with_the_durable_id() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeResumeEnv::install(DURABLE_FALLBACK);

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;
    let _placeholder = create_live_claude_session(&mut ws, "req-10b-events").await;

    let mut ws2 = connect_and_complete_handshake(&url).await;
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.attach",
            "provider": "claude",
            "sessionId": DURABLE_FALLBACK,
            "sessionType": "freshclaude",
            "resumeSessionId": DURABLE_FALLBACK,
            "sessionRef": { "provider": "claude", "sessionId": DURABLE_FALLBACK },
        }),
    )
    .await;
    // The rebind ack gates the ordering (attach handled before the send below).
    await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["sessionId"] == DURABLE_FALLBACK
    })
    .await;

    // Drive the fake to emit an sdk.status (it answers every `send` with status busy).
    send_json(
        &mut ws2,
        &serde_json::json!({
            "type": "freshAgent.send",
            "provider": "claude",
            "sessionId": DURABLE_FALLBACK,
            "sessionType": "freshclaude",
            "text": "poke",
            "requestId": "send-10b-events",
        }),
    )
    .await;

    let status = await_frame(&mut ws2, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.status"
            && v["event"]["status"] == "busy"
    })
    .await;
    assert_eq!(
        status["sessionId"], DURABLE_FALLBACK,
        "post-rebind envelopes must be stamped with the durable id"
    );
}

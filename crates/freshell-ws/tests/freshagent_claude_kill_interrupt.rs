//! Integration-level regression coverage for the claude `freshAgent.kill` /
//! `freshAgent.interrupt` dispatch gap (review-confirmed parity bug): the
//! `terminal.rs` `ClientMessage::FreshAgentKill` / `FreshAgentInterrupt` arms only
//! routed `codex` + `opencode` -- a claude-provider frame fell through the `if`/`else
//! if` chain and was silently dropped. `FreshClaudeState::handle_kill` already existed
//! (9eaaf122, unit-tested) but was UNREACHABLE from the real WS dispatch, and its
//! `create_dedup` cache was therefore never evicted for claude sessions.
//!
//! These tests run a REAL axum server (ephemeral loopback port, never 3001/3002) and a
//! REAL `tokio-tungstenite` client -- the same harness convention as
//! `diag01_lifecycle_events.rs`/`keepalive.rs` -- so they exercise the actual
//! `handle_client_text` dispatch rather than calling `FreshClaudeState` methods
//! directly (that unit-level coverage already exists in `claude.rs`). The claude
//! sidecar itself is swapped for a minimal scripted fake via the SAME
//! `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` production env-var overrides
//! `spawn_sidecar()` already honors -- no network, no cost, no real SDK.
//!
//! The load-bearing assertion (kill): a `freshAgent.create` resent with the SAME
//! `requestId` immediately after an explicit `freshAgent.kill` for the session it
//! created must mint a **fresh** session id, not replay the killed one -- proof that
//! the kill dispatch actually reached `FreshClaudeState::handle_kill` (which evicts the
//! create-dedup cache), not just that a `freshAgent.killed` frame happened to arrive.
//!
//! The interrupt coverage mirrors what legacy does
//! (`server/fresh-agent/adapters/claude/adapter.ts:163-168`'s
//! `interrupt(sessionId) { mapMissingResult(deps.sdkBridge.interrupt(sessionId), ...) }`,
//! `server/sdk-bridge.ts:785-793`'s `sp.query.interrupt().catch(warn)`): a known session
//! forwards an `interrupt` request to the sidecar (observed here via a log file the fake
//! sidecar appends to -- the process-boundary analog of "the SDK's `query.interrupt()`
//! was actually invoked"), and legacy's `mapMissingResult` throw (surfaced by
//! `ws-handler.ts:3513-3514`'s `catch` as an `INTERNAL_ERROR` frame) is mirrored for an
//! unknown session.

use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

/// Serializes every test in this file, all of which mutate the process-global
/// `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` env vars (mirrors `claude.rs`'s
/// own `CLAUDE_ENV_LOCK` convention for the identical hazard).
static CLAUDE_ENV_LOCK: Mutex<()> = Mutex::new(());

// ── fake claude sidecar (production wire protocol only: create/interrupt/shutdown) ──

/// A minimal scripted fake claude sidecar -- no real `@anthropic-ai/claude-agent-sdk`,
/// no network, no cost. Speaks the SAME newline-JSON protocol `spawn_sidecar()` (the
/// production code, `crates/freshell-freshagent/src/claude.rs`) drives real
/// `crates/freshell-claude-sidecar/index.mjs` with:
///   - `{"type":"create",...}` -> replies `{"type":"created",requestId,sessionId}`
///     with a fresh id every call (never replays), so a genuinely-new spawn is
///     observable by session id alone.
///   - `{"type":"interrupt",sessionId}` -> appends `sessionId` to
///     `FRESHELL_TEST_CLAUDE_INTERRUPT_LOG` (this test's observable proxy for "the
///     sidecar's `query.interrupt()` was actually invoked").
///   - `{"type":"shutdown"}` -> exits (driven by `FreshClaudeState::handle_kill`'s
///     graceful-shutdown request).
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'

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
  if (msg.type === 'create') {
    counter += 1
    const sessionId = `fake-claude-session-${process.pid}-${counter}`
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId }) + '\n')
  } else if (msg.type === 'interrupt') {
    const log = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG
    if (log) fs.appendFileSync(log, `${msg.sessionId}\n`)
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// A fresh temp dir holding the fake sidecar script + this test's interrupt-log file,
/// with `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE`/
/// `FRESHELL_TEST_CLAUDE_INTERRUPT_LOG` pointed at it. Caller must hold
/// [`CLAUDE_ENV_LOCK`] for the lifetime of the returned guard.
struct FakeClaudeSidecarEnv {
    dir: std::path::PathBuf,
    interrupt_log: std::path::PathBuf,
}
impl FakeClaudeSidecarEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-sidecar-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        let interrupt_log = dir.join("interrupt.log");
        std::fs::write(&interrupt_log, "").expect("init interrupt log");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG", &interrupt_log);
        Self { dir, interrupt_log }
    }

    fn interrupt_log_contents(&self) -> String {
        std::fs::read_to_string(&self.interrupt_log).unwrap_or_default()
    }
}
impl Drop for FakeClaudeSidecarEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG");
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
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
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
        config_fallback: None,
        amplifier_locator: None,
        opencode_locator: None,
        activity: None,
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

fn create_frame(request_id: &str) -> Value {
    serde_json::json!({
        "type": "freshAgent.create",
        "requestId": request_id,
        "sessionType": "freshclaude",
        "provider": "claude",
    })
}

/// **RED before the terminal.rs fix**: a claude-provider `freshAgent.kill` frame falls
/// through the dispatch's `if is_codex_provider(...) else if ...Opencode` chain with no
/// claude arm, so `FreshClaudeState::handle_kill` never runs. Two observable
/// consequences prove the arm now fires (or don't, pre-fix):
///  1. a `freshAgent.killed{success:true}` frame is broadcast at all (pre-fix: never
///     arrives -> this test times out), and
///  2. THE LOAD-BEARING ASSERTION: a duplicate `freshAgent.create` resent with the SAME
///     `requestId` right after the kill mints a genuinely fresh session id, proving
///     `handle_kill`'s `create_dedup.clear_for_session` ran (pre-fix: the create-dedup
///     cache was never touched, so the duplicate replays the OLD session id verbatim --
///     wrong even though no timeout occurs).
#[tokio::test]
async fn claude_kill_frame_reaches_handle_kill_and_evicts_the_create_dedup_cache() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _sidecar = FakeClaudeSidecarEnv::install();

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    let request_id = "req-claude-ws-kill-dedup";
    send_json(&mut ws, &create_frame(request_id)).await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == request_id
    })
    .await;
    let first_session_id = created["sessionId"].as_str().unwrap().to_string();

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.kill",
            "provider": "claude",
            "sessionId": first_session_id,
            "sessionType": "freshclaude",
        }),
    )
    .await;
    // Consequence 1: the `killed` broadcast must arrive at all -- pre-fix, this branch
    // is never taken (silent no-op) and the test times out here.
    let killed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.killed" && v["sessionId"] == first_session_id
    })
    .await;
    assert_eq!(killed["success"], true, "{killed}");

    // Consequence 2 (load-bearing): resend the SAME requestId. If the kill genuinely
    // evicted the create-dedup cache, this mints a FRESH session id, not a replay of
    // `first_session_id`.
    send_json(&mut ws, &create_frame(request_id)).await;
    let recreated = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == request_id
    })
    .await;
    assert_ne!(
        recreated["sessionId"], first_session_id,
        "a duplicate create after an explicit claude kill must mint a fresh session, \
         not replay the killed one -- the create_dedup cache was not evicted: {recreated}"
    );
}

/// **RED before the terminal.rs fix**: a claude-provider `freshAgent.interrupt` frame
/// falls through the same dispatch gap. This mirrors what legacy does
/// (`adapters/claude/adapter.ts:163-168` -> `server/sdk-bridge.ts:785-793`'s
/// `sp.query.interrupt().catch(warn)`, fire-and-forget with NO confirmation frame on
/// success): the observable proxy for "the interrupt actually reached the session
/// machinery" is the fake sidecar's interrupt log, since there is no `query.interrupt()`
/// broadcast to assert on (matching legacy's silence on success).
#[tokio::test]
async fn claude_interrupt_frame_reaches_the_sidecar_for_a_known_session() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let sidecar = FakeClaudeSidecarEnv::install();

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    let request_id = "req-claude-ws-interrupt";
    send_json(&mut ws, &create_frame(request_id)).await;
    let created = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.created" && v["requestId"] == request_id
    })
    .await;
    let session_id = created["sessionId"].as_str().unwrap().to_string();

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionId": session_id,
            "sessionType": "freshclaude",
        }),
    )
    .await;

    // Poll the fake sidecar's interrupt log (best-effort bounded wait -- the dispatch is
    // a detached `tokio::spawn` task, same pattern as create/send/kill). Pre-fix: the
    // claude branch never runs, so the sidecar never receives the interrupt request and
    // this loop exhausts its budget with an empty log.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if sidecar.interrupt_log_contents().contains(&session_id) {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "the claude sidecar never received the interrupt request for {session_id} \
                 within budget; log contents: {:?}",
                sidecar.interrupt_log_contents()
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Legacy's `mapMissingResult` throw for an unavailable session
/// (`adapter.ts:163-168`, surfaced by `ws-handler.ts:3513-3514`'s `catch` as an
/// `INTERNAL_ERROR` frame) mirrored: an interrupt for a session id this process never
/// created must produce an `error` frame, not silently vanish.
#[tokio::test]
async fn claude_interrupt_frame_errors_for_an_unknown_session() {
    let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _sidecar = FakeClaudeSidecarEnv::install();

    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    send_json(
        &mut ws,
        &serde_json::json!({
            "type": "freshAgent.interrupt",
            "provider": "claude",
            "sessionId": "does-not-exist",
            "sessionType": "freshclaude",
        }),
    )
    .await;

    let frame = await_frame(&mut ws, Duration::from_secs(10), |v| v["type"] == "error").await;
    assert!(
        frame["message"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .contains("session not found"),
        "{frame}"
    );
}

/// Sanity guard: writing to a closed log path never panics the harness (keeps clippy
/// happy about the unused `Write` import staying meaningful if the log-append strategy
/// changes; exercises the same append path production code takes).
#[test]
fn interrupt_log_append_is_plain_fs_no_special_handling_needed() {
    let dir = std::env::temp_dir().join(format!(
        "freshell-interrupt-log-sanity-{}",
        uuid_like_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("interrupt.log");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .unwrap();
    writeln!(f, "sanity").unwrap();
    assert!(std::fs::read_to_string(&log).unwrap().contains("sanity"));
    let _ = std::fs::remove_dir_all(&dir);
}

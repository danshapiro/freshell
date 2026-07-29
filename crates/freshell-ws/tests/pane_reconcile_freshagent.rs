//! `paneReconcileFreshAgentV1` capability + verdict-derivation wire tests —
//! raw-WS (tokio-tungstenite) integration against an in-process axum server,
//! on the `pane_reconcile.rs` harness convention (ephemeral loopback ports,
//! never a fixed one).
//!
//! Covered here:
//! * negotiation — `hello.capabilities.paneReconcileFreshAgentV1` → echoed in
//!   `ready.capabilities` (typed `ReadyCapabilities`, omitted when absent).
//! * frozen-client protection — a connection WITHOUT the capability keeps the
//!   pre-existing verdict for `kind: "fresh-agent"`: `invalid` /
//!   `unsupported_kind` (the permanent regression guard).
//! * Task 13 — fresh-agent verdict derivation: the four states, live→attach,
//!   in-request dedupe, the respawn cap + reset-on-live, and the G3
//!   supersession-chain reader rule end-to-end through the real ledger.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_protocol::SessionLocator;
use freshell_recovery::{
    prepare_exact_recovery_query, BlockingExactRecoveryProbe, DurableRecoveryProvider,
    ExactRecoveryIssue, ExactRecoveryProvider, ExactRecoveryQuery, ExactRecoverySnapshot,
    ExactRecoveryState, MaterializationState, RecoveryOwnerKey, RecoveryProviderRegistry,
};
use freshell_ws::existence::SessionExistence;
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

#[derive(Default)]
struct InstrumentedExactProvider {
    root_calls: std::sync::atomic::AtomicUsize,
    filesystem_calls: std::sync::atomic::AtomicUsize,
    sqlite_calls: std::sync::atomic::AtomicUsize,
    queries: std::sync::Mutex<Vec<ExactRecoveryQuery>>,
}

impl ExactRecoveryProvider for InstrumentedExactProvider {
    fn lookup_many_blocking(&self, queries: &[ExactRecoveryQuery]) -> ExactRecoverySnapshot {
        use std::sync::atomic::Ordering;

        self.root_calls.fetch_add(1, Ordering::SeqCst);
        self.filesystem_calls.fetch_add(1, Ordering::SeqCst);
        self.sqlite_calls.fetch_add(1, Ordering::SeqCst);
        self.queries.lock().unwrap().extend_from_slice(queries);
        queries
            .iter()
            .map(|query| (query.key.clone(), ExactRecoveryState::ProviderUnavailable))
            .collect()
    }
}

fn instrumented_exact_registry() -> (RecoveryProviderRegistry, Arc<InstrumentedExactProvider>) {
    let provider = Arc::new(InstrumentedExactProvider::default());
    let mut registry = RecoveryProviderRegistry::new();
    for kind in [
        DurableRecoveryProvider::Claude,
        DurableRecoveryProvider::Codex,
        DurableRecoveryProvider::Opencode,
        DurableRecoveryProvider::Amplifier,
    ] {
        registry
            .register(kind, provider.clone())
            .expect("one test provider per durable kind");
    }
    (registry, provider)
}

fn exact_state(
    registry: &RecoveryProviderRegistry,
    mode: &str,
    provider: &str,
    session_id: &str,
) -> ExactRecoveryState {
    let raw = SessionLocator {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    };
    match prepare_exact_recovery_query(
        mode,
        &raw,
        Some(PathBuf::from("/tmp/project")),
        MaterializationState::Unknown,
    ) {
        Err(issue) => ExactRecoveryState::Invalid(issue),
        Ok(query) => registry
            .lookup_many_blocking(std::slice::from_ref(&query))
            .remove(&query.key)
            .expect("registry returns one state per query"),
    }
}

fn prepared_query(
    mode: &str,
    provider: &str,
    session_id: &str,
    cwd: Option<&str>,
) -> ExactRecoveryQuery {
    prepare_exact_recovery_query(
        mode,
        &SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        },
        cwd.map(PathBuf::from),
        MaterializationState::Unknown,
    )
    .expect("valid exact query")
}

#[test]
fn invalid_session_refs_do_zero_store_io() {
    let (registry, provider) = instrumented_exact_registry();
    let oversized_opencode = format!("ses_{}", "a".repeat(125));
    let oversized_amplifier = "é".repeat(128);
    let invalid = vec![
        (
            "custom",
            "custom",
            "anything",
            ExactRecoveryIssue::UnsupportedSessionProvider,
        ),
        (
            "gemini",
            "gemini",
            "anything",
            ExactRecoveryIssue::UnsupportedSessionProvider,
        ),
        (
            "kimi",
            "kimi",
            "anything",
            ExactRecoveryIssue::UnsupportedSessionProvider,
        ),
        (
            "custom",
            "claude",
            "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
            ExactRecoveryIssue::ProviderModeMismatch,
        ),
        (
            "opencode",
            "claude",
            "f81d4fae-7dec-11d0-a765-00a0c91e6bf6",
            ExactRecoveryIssue::ProviderModeMismatch,
        ),
        (
            "claude",
            "claude",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "codex",
            "codex",
            "{01890f18-6a3f-7cc2-98c8-72a7381f4d3a}",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "codex",
            "codex",
            "01890f18-6a3f-7cc2-18c8-72a7381f4d3a",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "opencode",
            "opencode",
            "session",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "opencode",
            "opencode",
            "ses_non_ascii_é",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "opencode",
            "opencode",
            &oversized_opencode,
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            ".",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "..",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "dir/name",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            r"dir\name",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            r"D:relative",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            r"\\.\pipe\device",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "name:stream",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "AUX",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "NUL.data",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "CLOCK$",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "COM³",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "LPT³.txt",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "trailing.",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "trailing ",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "bad\nname",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            "bad*name",
            ExactRecoveryIssue::InvalidSessionId,
        ),
        (
            "amplifier",
            "amplifier",
            &oversized_amplifier,
            ExactRecoveryIssue::InvalidSessionId,
        ),
    ];

    for (mode, provider_name, session_id, issue) in invalid {
        assert_eq!(
            exact_state(&registry, mode, provider_name, session_id),
            ExactRecoveryState::Invalid(issue),
            "wrong invalid classification for {mode}/{provider_name}/{session_id:?}"
        );
    }

    use std::sync::atomic::Ordering;
    assert_eq!(provider.root_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provider.filesystem_calls.load(Ordering::SeqCst), 0);
    assert_eq!(provider.sqlite_calls.load(Ordering::SeqCst), 0);
    assert!(provider.queries.lock().unwrap().is_empty());
}

#[test]
fn valid_fresh_agent_session_refs_preserve_portable_ids_and_scope_ownership() {
    let (registry, provider) = instrumented_exact_registry();
    let max_amplifier_id = format!("{}a", "é".repeat(127));
    let cases = [
        ("opencode", "ses_CasePreserved019".to_string()),
        ("amplifier", "real_world_id_with_underscores".to_string()),
        ("amplifier", "日本語-session_42".to_string()),
        ("amplifier", "COM⁴".to_string()),
        ("amplifier", "LPT10".to_string()),
        ("amplifier", max_amplifier_id),
    ];

    let mut queries: Vec<_> = cases
        .iter()
        .map(|(mode, session_id)| prepared_query(mode, mode, session_id, Some("/tmp/project")))
        .collect();
    // Missing cwd is still a valid Amplifier query; its provider may uniquely
    // enumerate or return Conflict, but validation must not fabricate invalid.
    queries.push(prepared_query(
        "amplifier",
        "amplifier",
        "no_cwd_is_valid",
        None,
    ));
    let snapshot = registry.lookup_many_blocking(&queries);
    assert_eq!(snapshot.len(), queries.len());
    let captured = provider.queries.lock().unwrap();
    for ((mode, session_id), query) in cases.iter().zip(captured.iter()) {
        assert_eq!(query.key.session_ref.session_id, *session_id);
        let owner = if *mode == "amplifier" {
            RecoveryOwnerKey::project(&query.key.session_ref, "/normalized/project").unwrap()
        } else {
            RecoveryOwnerKey::global(&query.key.session_ref).unwrap()
        };
        assert_eq!(owner.session_id, *session_id);
        assert_eq!(
            owner.provider_scope.as_deref(),
            (*mode == "amplifier").then_some("/normalized/project")
        );
    }
}

/// Serializes every test in this file that mutates the process-global
/// `FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE` / `CLAUDE_CONFIG_DIR`
/// env vars, mirroring `freshagent_claude_attach.rs`'s convention for the
/// same hazard.
static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── scripted disk-truth probe ─────────────────────────────────────────────────

#[derive(Default)]
struct StubProbe {
    answers: std::sync::Mutex<std::collections::HashMap<(String, String), SessionExistence>>,
    observed: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
}
impl freshell_ws::existence::SessionExistenceProbe for StubProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        self.answers
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .copied()
            .unwrap_or(SessionExistence::Unknown)
    }
    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        self.observed
            .lock()
            .unwrap()
            .contains(&(provider.into(), session_id.into()))
    }
}

// ── fake claude sidecar (donor: freshagent_claude_attach.rs) ──────────────────

/// A minimal scripted fake claude sidecar (no real SDK, no network, no cost)
/// speaking the SAME newline-JSON protocol `spawn_sidecar()` drives the
/// vendored package with. On `create` it replies `created`, then
/// `sdk.session.init` echoing `resumeSessionId` (or a fixed durable UUID the
/// tests control) as the durable `cliSessionId`, then `sdk.status idle`; on
/// `shutdown` it exits.
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
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
    const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    process.stdout.write(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }) + '\n')
    process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

/// The fixed durable `cliSessionId` the fake sidecar mints on a plain (non
/// resume) `create` — the id the live-session tests key their probe on.
const FAKE_DURABLE_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/// A fresh temp dir holding the fake sidecar script, with
/// `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` pointed at it, PLUS an
/// empty claude store with `CLAUDE_CONFIG_DIR` pointed at it (so no test ever
/// touches the real home). Caller must hold [`CLAUDE_ENV_LOCK`] for the
/// lifetime of the returned guard.
struct FakeClaudeEnv {
    dir: std::path::PathBuf,
}
impl FakeClaudeEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-reconcile-ws-{}",
            uuid_like_suffix()
        ));
        std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
        let script = dir.join("fake-claude-sidecar.mjs");
        std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
        let store = dir.join("claude-store");
        std::fs::create_dir_all(&store).expect("create claude store dir");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var("CLAUDE_CONFIG_DIR", &store);
        Self { dir }
    }
}
impl Drop for FakeClaudeEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
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

struct Server {
    url: String,
    // Shared-registry handles, donor-shaped: derivation tests seed state
    // through these; the negotiation tests don't need to.
    #[allow(dead_code)]
    registry: freshell_terminal::TerminalRegistry,
    #[allow(dead_code)]
    identity: freshell_ws::identity::TerminalIdentityRegistry,
    /// The REAL temp-root ledger shared with the server (G3 tests seed it).
    pane_ledger: Arc<PaneLedger>,
    /// Clone of `WsState.fresh_agent_respawn_counts` for direct assertions.
    respawn_counts: Arc<Mutex<HashMap<(String, String), u32>>>,
    /// Keeps the ledger's temp root alive for the server's lifetime.
    #[allow(dead_code)]
    ledger_root: tempfile::TempDir,
}

/// Real axum server on an ephemeral loopback port, with the scripted
/// disk-truth probe + a REAL temp-root pane ledger injected via the pub
/// `WsState` fields. Returns handles to the SHARED registries/ledger/counter
/// so tests can seed and assert deterministically (the §9.1 headless
/// convention).
async fn spawn_server_with_probe(probe: Arc<StubProbe>) -> Server {
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let ledger_root = tempfile::tempdir().expect("ledger temp root");
    let pane_ledger = Arc::new(PaneLedger::new_locked(Some(
        ledger_root.path().to_path_buf(),
    )));
    let respawn_counts: Arc<Mutex<HashMap<(String, String), u32>>> = Arc::default();

    let state = WsState {
        pane_ledger: Arc::clone(&pane_ledger),
        identity: identity.clone(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
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
        registry: registry.clone(),
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
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Arc::clone(&respawn_counts),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    Server {
        url: format!("ws://{addr}/ws"),
        registry,
        identity,
        pane_ledger,
        respawn_counts,
        ledger_root,
    }
}

async fn spawn_server() -> Server {
    spawn_server_with_probe(Arc::new(StubProbe::default())).await
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello (negotiating `paneReconcileV1` / `paneReconcileFreshAgentV1`
/// per the flags), consuming the 4-frame handshake. Returns the socket and the
/// parsed `ready` frame.
async fn connect(
    url: &str,
    pane_reconcile_v1: bool,
    fresh_agent_v1: bool,
) -> (TestWs, serde_json::Value) {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    let mut hello = serde_json::json!({
        "type": "hello",
        "token": AUTH_TOKEN,
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
    });
    hello["capabilities"] = serde_json::json!({
        "paneReconcileV1": pane_reconcile_v1,
        "paneReconcileFreshAgentV1": fresh_agent_v1,
    });
    ws.send(WsMessage::Text(hello.to_string()))
        .await
        .expect("send hello");

    let mut ready = serde_json::Value::Null;
    for _ in 0..4u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!("ready") {
                ready = value;
            }
        }
    }
    assert!(!ready.is_null(), "handshake must contain ready");
    (ws, ready)
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..30u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            if value["type"] == serde_json::json!(wanted) {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 30 messages");
}

/// Send a `pane.reconcile.request` for `panes` and return the result's
/// `verdicts` array.
async fn reconcile_request(ws: &mut TestWs, panes: serde_json::Value) -> serde_json::Value {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "pane.reconcile.request",
            "reconcileId": "rec-fa",
            "panes": panes,
        })
        .to_string(),
    ))
    .await
    .expect("send reconcile request");
    let result = next_frame_of_type(ws, "pane.reconcile.result").await;
    result["verdicts"].clone()
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

/// Drive a claude `freshAgent.create` through the fake sidecar and return the
/// durable `cliSessionId` from the `freshAgent.session.init` event.
async fn create_live_claude_session(ws: &mut TestWs, request_id: &str) -> String {
    ws.send(WsMessage::Text(
        serde_json::json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "sessionType": "freshclaude",
            "provider": "claude",
        })
        .to_string(),
    ))
    .await
    .expect("send freshAgent.create");
    let init = await_frame(ws, Duration::from_secs(15), |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.init"
    })
    .await;
    init["event"]["cliSessionId"]
        .as_str()
        .expect("session.init carries the durable cliSessionId")
        .to_string()
}

// --- negotiation ---------------------------------------------------------------

#[tokio::test]
async fn ready_echoes_fresh_agent_capability_when_negotiated() {
    let server = spawn_server().await;
    let (_ws, ready) = connect(&server.url, true, true).await;
    assert_eq!(
        ready["capabilities"]["paneReconcileFreshAgentV1"],
        serde_json::json!(true)
    );
}

// --- frozen-client protection (permanent regression guard) ----------------------

#[tokio::test]
async fn without_the_capability_fresh_agent_kind_stays_invalid_unsupported() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true, false).await; // frozen-client shape
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([{
            "paneKey": "p1", "kind": "fresh-agent",
            "sessionRef": {"provider": "claude", "sessionId": "s-1"}
        }]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "invalid");
    assert_eq!(verdicts[0]["reason"], "unsupported_kind");
}

// --- Task 13: fresh-agent verdict derivation -------------------------------------

#[tokio::test]
async fn fresh_agent_verdicts_cover_the_four_states() {
    let probe = std::sync::Arc::new(StubProbe::default());
    probe.answers.lock().unwrap().insert(
        ("codex".into(), "resumable".into()),
        SessionExistence::Present,
    );
    probe.answers.lock().unwrap().insert(
        ("claude".into(), "deleted".into()),
        SessionExistence::Absent,
    );
    probe
        .observed
        .lock()
        .unwrap()
        .insert(("claude".into(), "deleted".into()));
    probe.answers.lock().unwrap().insert(
        ("opencode".into(), "never".into()),
        SessionExistence::Absent,
    );
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "a", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "resumable"} },
            { "paneKey": "b", "kind": "fresh-agent", "sessionRef": {"provider": "claude", "sessionId": "deleted"} },
            { "paneKey": "c", "kind": "fresh-agent", "sessionRef": {"provider": "opencode", "sessionId": "never"} },
            { "paneKey": "d", "kind": "fresh-agent" },
            { "paneKey": "t", "kind": "terminal", "mode": "shell", "createRequestId": "cr-t" }
        ]),
    )
    .await;
    assert_eq!(
        verdicts[0]["verdict"], "respawn",
        "killed-server-but-resumable"
    );
    assert_eq!(verdicts[0]["sessionRef"]["sessionId"], "resumable");
    assert_eq!(verdicts[1]["verdict"], "dead_session", "transcript deleted");
    assert_eq!(verdicts[1]["reason"], "session_not_on_disk");
    assert_eq!(verdicts[2]["verdict"], "fresh", "never existed");
    assert_eq!(verdicts[2]["reason"], "identity_never_observed");
    assert_eq!(verdicts[3]["verdict"], "fresh");
    assert_eq!(verdicts[3]["reason"], "no_recoverable_identity");
    // Terminal panes in the same request still work (mixed-kind request):
    assert_eq!(verdicts[4]["paneKey"], "t");
    assert_eq!(
        verdicts[4]["verdict"], "fresh",
        "shell terminal answered normally"
    );
}

#[tokio::test]
async fn live_fresh_agent_session_gets_attach() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeEnv::install();

    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;

    let cli_session_id = create_live_claude_session(&mut ws, "req-live-attach").await;
    assert_eq!(cli_session_id, FAKE_DURABLE_ID);

    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "live", "kind": "fresh-agent",
              "sessionRef": {"provider": "claude", "sessionId": cli_session_id} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "attach");
    assert_eq!(verdicts[0]["sessionRef"]["sessionId"], cli_session_id);
    assert!(verdicts[0].get("terminalId").is_none());
}

/// WAVE-B B1xB4 seam pin (V9 3.6): a mixed request whose TERMINAL pane
/// triggers B1's bounded index-warming deferral re-derives the verdicts ONCE
/// -- and that re-derivation must REUSE the fresh-agent snapshot built at
/// request start, so the fresh-agent respawn counter burns exactly once per
/// request (never once per derivation).
#[tokio::test]
async fn warming_deferral_rederivation_burns_the_respawn_counter_once() {
    let probe = std::sync::Arc::new(StubProbe::default());
    probe.answers.lock().unwrap().insert(
        ("codex".into(), "fa-once".into()),
        SessionExistence::Present,
    );
    // The terminal claim "warm-x" stays unset => Unknown => error{index_warming}
    // on BOTH derivations, so the deferral + re-derive path definitely runs.
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "t", "kind": "terminal", "mode": "codex", "createRequestId": "cr-warm",
              "sessionRef": {"provider": "codex", "sessionId": "warm-x"} },
            { "paneKey": "fa", "kind": "fresh-agent",
              "sessionRef": {"provider": "codex", "sessionId": "fa-once"} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "error");
    assert_eq!(verdicts[0]["reason"], "index_warming");
    assert_eq!(verdicts[1]["verdict"], "respawn");
    let counts = server.respawn_counts.lock().expect("counts lock");
    assert_eq!(
        counts.get(&("codex".into(), "fa-once".into())).copied(),
        Some(1),
        "the deferral's re-derivation must not double-burn the respawn counter"
    );
}

/// WAVE-B B1xB4 seam pin: B1's `ProviderUnavailable` existence answer maps to
/// the B4 pre-decision (V9/A12): presence Unknown => conservative
/// respawn-with-cap -- never dead_session, and never the terminal arm's
/// error{provider_unavailable} shape (fresh-agent liveness does not depend on
/// the disk index being able to warm).
#[tokio::test]
async fn provider_unavailable_existence_maps_to_respawn_with_cap() {
    let probe = std::sync::Arc::new(StubProbe::default());
    probe.answers.lock().unwrap().insert(
        ("codex".into(), "pu-1".into()),
        SessionExistence::ProviderUnavailable,
    );
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "pu", "kind": "fresh-agent",
              "sessionRef": {"provider": "codex", "sessionId": "pu-1"} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "respawn");
    assert_eq!(verdicts[0]["sessionRef"]["sessionId"], "pu-1");
    let counts = server.respawn_counts.lock().expect("counts lock");
    assert_eq!(
        counts.get(&("codex".into(), "pu-1".into())).copied(),
        Some(1),
        "the answer counted against the respawn cap"
    );
}

#[tokio::test]
async fn duplicate_session_claims_dedupe_within_one_request() {
    let probe = std::sync::Arc::new(StubProbe::default());
    probe
        .answers
        .lock()
        .unwrap()
        .insert(("codex".into(), "t1".into()), SessionExistence::Present);
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "first",  "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "t1"} },
            { "paneKey": "second", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "t1"} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "respawn");
    assert_eq!(verdicts[1]["verdict"], "fresh");
    assert_eq!(verdicts[1]["reason"], "duplicate_session_claim");
    assert_eq!(verdicts[1]["duplicate"], "first");
}

#[tokio::test]
async fn respawn_cap_turns_the_fourth_answer_into_dead_session() {
    // The session stays Present-but-never-live, so every answer maps to
    // respawn; only RESPAWN ANSWERS burn the cap (V2/A7).
    let probe = std::sync::Arc::new(StubProbe::default());
    probe
        .answers
        .lock()
        .unwrap()
        .insert(("codex".into(), "cap".into()), SessionExistence::Present);
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    for i in 0..4 {
        let verdicts = reconcile_request(
            &mut ws,
            serde_json::json!([
                { "paneKey": "p", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "cap"} }
            ]),
        )
        .await;
        if i < 3 {
            assert_eq!(verdicts[0]["verdict"], "respawn", "answer {i}");
        } else {
            assert_eq!(verdicts[0]["verdict"], "dead_session");
            assert_eq!(verdicts[0]["reason"], "respawn_exhausted");
        }
    }
}

#[tokio::test]
async fn a_session_resolving_live_clears_the_respawn_counter() {
    // Reset-on-live (V2/A7): a successful respawn is OBSERVED as the session
    // going live; the counter must clear so healthy sessions are never
    // exhausted by reconnect/reload storms.
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let _env = FakeClaudeEnv::install();

    let probe = std::sync::Arc::new(StubProbe::default());
    probe.answers.lock().unwrap().insert(
        ("claude".into(), FAKE_DURABLE_ID.into()),
        SessionExistence::Present,
    );
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;

    // TWO reconcile requests while the session is NOT yet live → both respawn.
    for i in 0..2 {
        let verdicts = reconcile_request(
            &mut ws,
            serde_json::json!([
                { "paneKey": "p", "kind": "fresh-agent",
                  "sessionRef": {"provider": "claude", "sessionId": FAKE_DURABLE_ID} }
            ]),
        )
        .await;
        assert_eq!(verdicts[0]["verdict"], "respawn", "pre-live answer {i}");
    }
    assert_eq!(
        server
            .respawn_counts
            .lock()
            .unwrap()
            .get(&("claude".to_string(), FAKE_DURABLE_ID.to_string()))
            .copied(),
        Some(2),
        "two respawn answers burned two"
    );

    // Drive freshAgent.create through the fake sidecar so has_live_session
    // becomes true for the durable id.
    let cli_session_id = create_live_claude_session(&mut ws, "req-reset-on-live").await;
    assert_eq!(cli_session_id, FAKE_DURABLE_ID);

    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "p", "kind": "fresh-agent",
              "sessionRef": {"provider": "claude", "sessionId": FAKE_DURABLE_ID} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "attach");
    assert!(
        !server
            .respawn_counts
            .lock()
            .unwrap()
            .contains_key(&("claude".to_string(), FAKE_DURABLE_ID.to_string())),
        "counter cleared (not merely un-incremented) when presence resolved Live"
    );
}

#[tokio::test]
async fn old_thread_claim_after_crash_respawn_answers_the_new_terminus() {
    // G3 reader rule end-to-end (V8/A14). Seed the REAL temp-root ledger.
    let probe = std::sync::Arc::new(StubProbe::default());
    // The old rollout may ALSO still exist on disk — the point is we never
    // answer the retired ref.
    probe
        .answers
        .lock()
        .unwrap()
        .insert(("codex".into(), "new-t".into()), SessionExistence::Present);
    let server = spawn_server_with_probe(probe).await;
    let now = 1_000;
    server
        .pane_ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "old-t",
            provider_scope: None,
            materialization: MaterializationState::Observed,
            mode: "freshcodex",
            cwd: Some("/w"),
            create_request_id: None,
            model: Some("m"),
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: None,
            now_ms: now,
        })
        .unwrap();
    server
        .pane_ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "new-t",
            provider_scope: None,
            materialization: MaterializationState::Observed,
            mode: "freshcodex",
            cwd: Some("/w"),
            create_request_id: None,
            model: Some("m"),
            sandbox: None,
            permission_mode: None,
            effort: None,
            supersedes: Some("old-t"),
            now_ms: now + 1,
        })
        .unwrap();
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(
        &mut ws,
        serde_json::json!([
            { "paneKey": "p", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "old-t"} }
        ]),
    )
    .await;
    assert_eq!(verdicts[0]["verdict"], "respawn");
    assert_eq!(
        verdicts[0]["sessionRef"]["sessionId"], "new-t",
        "answer from the chain terminus"
    );
    assert_eq!(verdicts[0]["corrected"], true);
}

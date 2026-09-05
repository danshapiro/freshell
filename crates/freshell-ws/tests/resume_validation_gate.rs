//! Door 1 (resume-validation feature): the WS `terminal.create` restore path
//! consults the disk-existence probe before turning a WIRE-derived resume id
//! into resume argv. POSITIVE absence => fresh-spawn fallback + `notice` on
//! `terminal.created` + `retire_missing` on the pane ledger. Everything else
//! (Present/Unknown/live sessions) proceeds byte-identically to today.
//!
//! Harness: the `restore_spawn_gate.rs` convention — REAL axum server + REAL
//! tokio-tungstenite client on an ephemeral loopback port — with an injected
//! fake `SharedExistenceProbe` and a REAL pane ledger in a temp dir.

mod common;

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};
use freshell_ws::pane_ledger::{BindingWrite, PaneLedger, RetiredReason, RowState};
use freshell_ws::WsState;

// ── scripted disk-truth probe (pane_reconcile_freshagent.rs convention) ──────

#[derive(Default)]
struct StubProbe {
    answers: std::sync::Mutex<std::collections::HashMap<(String, String), SessionExistence>>,
}

impl StubProbe {
    fn answering(provider: &str, session_id: &str, answer: SessionExistence) -> Arc<Self> {
        let probe = Self::default();
        probe
            .answers
            .lock()
            .unwrap()
            .insert((provider.to_string(), session_id.to_string()), answer);
        Arc::new(probe)
    }
}

impl SessionExistenceProbe for StubProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        self.answers
            .lock()
            .unwrap()
            .get(&(provider.into(), session_id.into()))
            .copied()
            .unwrap_or(SessionExistence::Unknown)
    }
    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        // Amplifier/codex gating never consults the on-disk-history flag
        // (only the claude zero-turn carve-out does), so the fakes keep it
        // trivially false via the trait default.
        false
    }
}

/// Answers Absent-but-previously-observed for EVERY (provider, id) query —
/// including ids minted server-side that the test cannot know in advance.
/// `ever_observed → true` is load-bearing: it defeats the claude zero-turn
/// carve-out (Absent + never-observed → Proceed, resume_gate.rs:100-104),
/// so ANY gate consult on a server-allocated id — claude included —
/// evaluates to SpawnFresh (resume_gate.rs:119), fires the notice, and
/// fails the assertions below.
struct AbsentButObservedProbe;

impl SessionExistenceProbe for AbsentButObservedProbe {
    fn exists(&self, _provider: &str, _session_id: &str) -> SessionExistence {
        SessionExistence::Absent
    }
    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        true
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

/// Seed a Bound ledger row for `(provider, session_id)` through the SERVER'S
/// ledger Arc (write-through index — V1.md read policy).
fn seed_bound_row(ledger: &PaneLedger, provider: &str, session_id: &str) {
    ledger
        .record_binding(&BindingWrite {
            provider,
            session_id,
            terminal_id: "t-prior-epoch",
            mode: provider,
            cwd: None,
            create_request_id: None,
            now_ms: now_ms(),
        })
        .expect("seed bound ledger row");
    assert_eq!(
        ledger
            .load_binding(provider, session_id)
            .expect("seeded row present")
            .state,
        RowState::Bound
    );
}

/// Real server with an injected existence probe + a REAL pane ledger rooted
/// in a fresh temp dir. Returns `(ws_url, registry, ledger, state)` — the
/// state clone lets tests seed liveness (identity upsert) the way
/// `spawn_server_with_specs_and_state` consumers do.
async fn spawn_server_with_probe(
    probe: Arc<dyn SessionExistenceProbe>,
    fresh_agent_enabled: bool,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<PaneLedger>,
    WsState,
) {
    // F7/V9 choke point: amplifier creates write stub dirs — never the real home.
    let _ = common::isolate_amplifier_home();
    let ledger_dir = std::env::temp_dir().join(format!(
        "freshell-resume-gate-ledger-{}-{}",
        std::process::id(),
        uuid_like_suffix()
    ));
    std::fs::create_dir_all(&ledger_dir).expect("create ledger temp dir");
    let pane_ledger = Arc::new(PaneLedger::new(Some(ledger_dir)));

    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let mut settings_value = common::test_settings_value();
    settings_value["freshAgent"]["enabled"] = json!(fresh_agent_enabled);
    let settings =
        Arc::new(serde_json::from_value(settings_value).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::clone(&pane_ledger),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: common::handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({ "freshAgent": { "enabled": fresh_agent_enabled } }),
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
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![
            common::sleeper_cli_spec("amplifier"),
            common::sleeper_cli_spec("claude"),
            common::sleeper_cli_spec("codex"),
        ]),
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
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, pane_ledger, state)
}

// ── seam 5a pieces (DEV-0006 S5) — copied from codex_managed_launch_e2e.rs ──

/// Real codex CliCommandSpec (env_var seam) — copied from
/// codex_managed_launch_e2e.rs so the resolver takes the REAL codex branch
/// and managed-launch planning engages.
fn codex_cli_spec() -> freshell_platform::CliCommandSpec {
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }
    freshell_platform::CliCommandSpec {
        name: "codex".into(),
        label: "Codex CLI".into(),
        env_var: Some("CODEX_CMD".into()),
        default_cmd: "codex".into(),
        resume_args: Some(s(&["resume", "{{sessionId}}"])),
        model_args: Some(s(&["--model", "{{model}}"])),
        sandbox_args: Some(s(&["--sandbox", "{{sandbox}}"])),
        ..Default::default()
    }
}

/// Node dispatcher playing both codex roles — verbatim from
/// codex_managed_launch_e2e.rs (app-server argv -> run the committed
/// fake-app-server.mjs fixture; else dump argv JSON to
/// $CODEX_ARGV_CAPTURE_PATH and stay alive).
fn write_codex_dispatcher() -> std::path::PathBuf {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
        .canonicalize()
        .expect("fake-app-server fixture exists");
    let dispatcher = std::env::temp_dir().join(format!(
        "freshell-resume-gate-dispatcher-{}.mjs",
        std::process::id()
    ));
    let script = format!(
        "#!/usr/bin/env node\n\
         import fs from 'node:fs'\n\
         const args = process.argv.slice(2)\n\
         if (args.includes('app-server')) {{\n\
           await import('file://{fixture}')\n\
         }} else {{\n\
           fs.writeFileSync(process.env.CODEX_ARGV_CAPTURE_PATH, JSON.stringify(args))\n\
           setInterval(() => undefined, 1000)\n\
         }}\n",
        fixture = fixture.display()
    );
    std::fs::write(&dispatcher, script).expect("write dispatcher");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dispatcher, std::fs::Permissions::from_mode(0o755))
            .expect("chmod dispatcher");
    }
    dispatcher
}

/// Bounded NEGATIVE argv-capture check: the dispatcher writes the capture
/// file SYNCHRONOUSLY at child spawn, so its absence after a short window
/// proves no codex child ever launched — the door rejection has zero side
/// effects (no spawn, no planning slot burned).
fn assert_never_captured(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        assert!(
            !path.exists(),
            "a create rejected at the door must never spawn a codex child: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Scope guard owning a test's teardown (registry kill, env-var removal,
/// evidence-file deletion) so the zero-side-effect pins can run BEFORE the
/// files are deleted while cleanup is still guaranteed: on a RED pin the
/// assertion panic unwinds through this guard's Drop and the teardown runs
/// anyway. Delta-review Fix B (ejh6) — previously the files were deleted
/// before `assert_never_captured`, so the assertions passed even when a
/// sidecar or CLI child had written them.
struct AssertBeforeCleanupGuard<'a> {
    registry: &'a freshell_terminal::TerminalRegistry,
    evidence_files: Vec<std::path::PathBuf>,
}

impl Drop for AssertBeforeCleanupGuard<'_> {
    fn drop(&mut self) {
        self.registry.kill_all();
        std::env::remove_var("CODEX_CMD");
        std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_ARG_LOG");
        std::env::remove_var("CODEX_HOME");
        for path in &self.evidence_files {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Managed-codex harness: modeled line-for-line on `spawn_server_with_probe`
/// with exactly one difference — the CLI specs are the REAL codex spec only
/// (no sleeper specs), so the resolver takes the env_var codex branch and
/// managed-launch planning engages.
async fn spawn_managed_codex_server_with_probe(
    probe: Arc<dyn SessionExistenceProbe>,
    fresh_agent_enabled: bool,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    Arc<PaneLedger>,
    WsState,
) {
    // F7/V9 choke point: amplifier creates write stub dirs — never the real home.
    let _ = common::isolate_amplifier_home();
    let ledger_dir = std::env::temp_dir().join(format!(
        "freshell-resume-gate-ledger-{}-{}",
        std::process::id(),
        uuid_like_suffix()
    ));
    std::fs::create_dir_all(&ledger_dir).expect("create ledger temp dir");
    let pane_ledger = Arc::new(PaneLedger::new(Some(ledger_dir)));

    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let mut settings_value = common::test_settings_value();
    settings_value["freshAgent"]["enabled"] = json!(fresh_agent_enabled);
    let settings =
        Arc::new(serde_json::from_value(settings_value).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::clone(&pane_ledger),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-test".to_string()),
        boot_id: Arc::new("boot-test".to_string()),
        settings,
        handshake_settings: common::handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({ "freshAgent": { "enabled": fresh_agent_enabled } }),
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
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![codex_cli_spec()]),
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
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws"), registry, pane_ledger, state)
}

fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id())
}

async fn send_json(ws: &mut common::TestWs, value: &Value) {
    ws.send(WsMessage::Text(value.to_string()))
        .await
        .expect("send frame");
}

/// Read frames until either a `terminal.created` or an `error` correlated to
/// `request_id` arrives (bounded).
async fn next_created_or_error(ws: &mut common::TestWs, request_id: &str) -> Value {
    for _ in 0..40u8 {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a reply to {request_id}"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: Value = serde_json::from_str(text).expect("json frame");
            let frame_type = value["type"].as_str().unwrap_or("");
            if (frame_type == "terminal.created" || frame_type == "error")
                && value["requestId"] == json!(request_id)
            {
                return value;
            }
        }
    }
    panic!("no terminal.created/error for {request_id} within 40 messages");
}

fn notice_of(frame: &Value) -> Option<String> {
    match frame.get("notice") {
        Some(v) if !v.is_null() => v.as_str().map(str::to_string),
        _ => None,
    }
}

/// Does `<amp_home>/projects/*/sessions/<session_id>` exist?
fn amplifier_session_dir_exists(amp_home: &std::path::Path, session_id: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(amp_home.join("projects")) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().join("sessions").join(session_id).is_dir())
}

fn restore_create_with_session_ref(request_id: &str, mode: &str, session_id: &str) -> Value {
    json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": mode,
        "shell": "system",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": mode, "sessionId": session_id },
    })
}

fn restore_create_with_legacy_resume_id(request_id: &str, mode: &str, session_id: &str) -> Value {
    json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": mode,
        "shell": "system",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
        "resumeSessionId": session_id,
    })
}

// ── the six pinned behaviors ─────────────────────────────────────────────────

/// Case 1 — THE incident shape: a restore of an amplifier id that is
/// definitively absent from the store must SUCCEED as a fresh spawn (never an
/// error), carry the operator notice, retire the stale Bound row as
/// SessionMissing, and never resurrect the stale dir. NOTE (AD-5): an empty
/// home + stale id is byte-identical on disk to a never-used stub GC'd at
/// terminal exit — gating it is the DECIDED behavior, not an accident.
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_amplifier_absent_spawns_fresh_with_notice() {
    let probe = StubProbe::answering("amplifier", "stale-amp", SessionExistence::Absent);
    let (url, registry, ledger, _state) = spawn_server_with_probe(probe, false).await;
    seed_bound_row(&ledger, "amplifier", "stale-amp");
    let amp_home = common::isolate_amplifier_home();

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        &restore_create_with_session_ref("req-gate-1", "amplifier", "stale-amp"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-1").await;

    assert_eq!(
        frame["type"], "terminal.created",
        "the gate-fired create must SUCCEED as a fresh spawn, got {frame}"
    );
    let notice = notice_of(&frame).expect("gate fire must carry the operator notice");
    assert!(
        notice.contains("stale-amp"),
        "notice must name the stale id: {notice}"
    );

    // The stale row is retired as SessionMissing — never retried forever.
    let stale_row = ledger
        .load_binding("amplifier", "stale-amp")
        .expect("stale row still exists (retired, not deleted)");
    assert_eq!(stale_row.state, RowState::Retired);
    assert_eq!(
        stale_row.retired_reason,
        Some(RetiredReason::SessionMissing)
    );

    // The spawned resume id is a FRESH mint, not the stale ref.
    let fresh_id = frame["sessionRef"]["sessionId"]
        .as_str()
        .expect("created frame carries the fresh sessionRef")
        .to_string();
    assert_ne!(fresh_id, "stale-amp");

    // Disk truth: the stale dir was NOT resurrected; the fresh stub exists.
    assert!(
        !amplifier_session_dir_exists(&amp_home, "stale-amp"),
        "the amplifier pre-create must never re-stub the stale id"
    );
    assert!(
        amplifier_session_dir_exists(&amp_home, &fresh_id),
        "the fresh UUID stub must exist under the temp amplifier home"
    );

    registry.kill_all();
}

/// Case 2 — Present passes through unchanged: no notice, row stays Bound.
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_amplifier_present_resumes_unchanged() {
    let probe = StubProbe::answering("amplifier", "present-amp", SessionExistence::Present);
    let (url, registry, ledger, _state) = spawn_server_with_probe(probe, false).await;
    seed_bound_row(&ledger, "amplifier", "present-amp");

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        &restore_create_with_session_ref("req-gate-2", "amplifier", "present-amp"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-2").await;

    assert_eq!(frame["type"], "terminal.created", "got {frame}");
    assert!(
        notice_of(&frame).is_none(),
        "a Present resume must carry NO notice: {frame}"
    );
    assert_eq!(
        frame["sessionRef"]["sessionId"], "present-amp",
        "the resume id must pass through unchanged"
    );
    assert_eq!(
        ledger
            .load_binding("amplifier", "present-amp")
            .expect("row present")
            .state,
        RowState::Bound
    );

    registry.kill_all();
}

/// Case 3 — Unknown fails OPEN (today's behavior preserved): no notice, row
/// stays Bound.
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_unknown_fails_open() {
    let probe = StubProbe::answering("amplifier", "unknown-amp", SessionExistence::Unknown);
    let (url, registry, ledger, _state) = spawn_server_with_probe(probe, false).await;
    seed_bound_row(&ledger, "amplifier", "unknown-amp");

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        &restore_create_with_session_ref("req-gate-3", "amplifier", "unknown-amp"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-3").await;

    assert_eq!(frame["type"], "terminal.created", "got {frame}");
    assert!(
        notice_of(&frame).is_none(),
        "Unknown must fail open with NO notice: {frame}"
    );
    assert_eq!(frame["sessionRef"]["sessionId"], "unknown-amp");
    assert_eq!(
        ledger
            .load_binding("amplifier", "unknown-amp")
            .expect("row present")
            .state,
        RowState::Bound
    );

    registry.kill_all();
}

/// Case 4 — ordering pin (V8 §A11): a LIVE session whose ref rides the wire
/// `sessionRef` hits D7's loud "still running" reject, NOT the gate — the
/// Bound ledger row of the running session SURVIVES. Gate-before-D7 would
/// replace the resume id, falsify D7's applicability filter, and retire a
/// RUNNING session's row.
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_live_absent_sessionref_hits_d7_not_the_gate() {
    let probe = StubProbe::answering("amplifier", "live-amp", SessionExistence::Absent);
    let (url, registry, ledger, state) = spawn_server_with_probe(probe, false).await;
    seed_bound_row(&ledger, "amplifier", "live-amp");

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    // A RUNNING owner for ("amplifier", "live-amp"): a live PTY whose
    // identity-registry entry names the session (the same identity-owner arm
    // D7's live_session_owner join consults).
    let owner_tid = common::create_shell_terminal(&mut ws, "req-live-owner-4").await;
    state.identity.upsert(
        &owner_tid,
        Some("amplifier"),
        Some("live-amp"),
        None,
        now_ms(),
    );

    send_json(
        &mut ws,
        &restore_create_with_session_ref("req-gate-4", "amplifier", "live-amp"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-4").await;

    assert_eq!(
        frame["type"], "error",
        "a live session must hit D7's reject, never a gate-fired fresh spawn: {frame}"
    );
    assert_eq!(frame["code"], "RESTORE_UNAVAILABLE");
    assert!(
        frame["message"]
            .as_str()
            .is_some_and(|m| m.contains("still running")),
        "D7's own rejection message must answer: {frame}"
    );
    // The running session's Bound row SURVIVES — the gate never saw the create.
    assert_eq!(
        ledger
            .load_binding("amplifier", "live-amp")
            .expect("row present")
            .state,
        RowState::Bound
    );

    registry.kill_all();
}

/// Case 5 — the legacy `resumeSessionId`-only restore carrier is now REFUSED
/// up front (Node parity, `server/ws-handler.ts:2170-2186`): restore identity
/// must be a `sessionRef`. The refusal fires before D7 and before the gate,
/// so the live session is never touched — its Bound row survives and no
/// second writer spawns. (Pre-fix this carrier bypassed D7 entirely and the
/// in-gate liveness precondition was its only protection; that precondition
/// remains in `gate_wire_resume` as the D7→gate race-window backstop.)
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_live_legacy_resume_id_is_refused_invalid_message() {
    let probe = StubProbe::answering("amplifier", "live-amp-legacy", SessionExistence::Absent);
    let (url, registry, ledger, state) = spawn_server_with_probe(probe, false).await;
    seed_bound_row(&ledger, "amplifier", "live-amp-legacy");

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    let owner_tid = common::create_shell_terminal(&mut ws, "req-live-owner-5").await;
    state.identity.upsert(
        &owner_tid,
        Some("amplifier"),
        Some("live-amp-legacy"),
        None,
        now_ms(),
    );

    send_json(
        &mut ws,
        &restore_create_with_legacy_resume_id("req-gate-5", "amplifier", "live-amp-legacy"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-5").await;

    assert_eq!(
        frame["type"], "error",
        "a legacy-only restore must be refused loudly, never spawn: {frame}"
    );
    assert_eq!(frame["code"], "INVALID_MESSAGE", "{frame}");
    assert_eq!(
        frame["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen Node refusal text: {frame}"
    );
    assert_eq!(
        ledger
            .load_binding("amplifier", "live-amp-legacy")
            .expect("row present")
            .state,
        RowState::Bound,
        "the live session's Bound row must survive"
    );

    registry.kill_all();
}

/// Case 6 — the ASYNC sidecar arm of the cross-kind liveness join: liveness
/// held ONLY by the fresh-agent sidecar (no registry/identity owner).
/// Pre-ejh6 codex was exempt from the case-5 legacy-restore refusal, so
/// this carrier reached D7's loud liveness reject; post-ejh6 the uniform
/// any-carry door guard (raw pre-parse, `handle_client_text`) rejects the
/// legacy carrier FIRST — `INVALID_MESSAGE` + frozen text — before any
/// sidecar liveness consult. The live session is never touched: its Bound
/// row survives.
#[tokio::test(flavor = "multi_thread")]
async fn restore_true_sidecar_live_legacy_resume_id_is_refused_at_the_door() {
    // DEV-0006 S5.e: the managed-launch default is ON; this suite exercises the
    // plain-CLI codex path (sleeper CLI spec, no app-server), so pin OFF.
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    // The codex fake app-server fixture (the codex.rs crash-recovery tests'
    // scripted peer), pinned to mint the exact thread id this test keys on.
    // Env mutation is process-global; this is the ONLY test in this binary
    // that spawns a codex sidecar, so nothing else reads these vars.
    std::env::set_var(
        "CODEX_CMD",
        format!(
            "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
    );
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        r#"{"threadStartThreadId":"stale-cx"}"#,
    );

    let probe = StubProbe::answering("codex", "stale-cx", SessionExistence::Absent);
    let (url, registry, ledger, state) = spawn_server_with_probe(probe, true).await;
    seed_bound_row(&ledger, "codex", "stale-cx");

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    // A live freshcodex sidecar owning ("codex", "stale-cx").
    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-owner-6",
            "sessionType": "freshcodex",
            "provider": "codex",
            "cwd": "/tmp",
        }),
    )
    .await;
    let created = common::next_frame_of_type(&mut ws, "freshAgent.created").await;
    assert_eq!(
        created["sessionId"], "stale-cx",
        "the fake app-server mints the pinned thread id"
    );
    assert!(
        state.fresh_codex.has_live_session("stale-cx").await,
        "precondition: the sidecar owns the session"
    );

    send_json(
        &mut ws,
        &restore_create_with_legacy_resume_id("req-gate-6", "codex", "stale-cx"),
    )
    .await;
    let frame = next_created_or_error(&mut ws, "req-gate-6").await;

    assert_eq!(
        frame["type"], "error",
        "a sidecar-live legacy carrier must be refused (one writer per thread): {frame}"
    );
    assert_eq!(
        frame["code"], "INVALID_MESSAGE",
        "codex is no longer exempt from the legacy-field reject: {frame}"
    );
    assert_eq!(
        frame["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {frame}"
    );
    assert_eq!(
        ledger
            .load_binding("codex", "stale-cx")
            .expect("row present")
            .state,
        RowState::Bound,
        "the live session's Bound row must survive"
    );

    registry.kill_all();
    std::env::remove_var("CODEX_CMD");
    std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
}

/// Case 7 (post-ejh6) — the definitively-absent codex LEGACY carrier is
/// rejected at the raw pre-parse guard (managed-launch default ON) with
/// `INVALID_MESSAGE` + frozen text. Stronger than the old gate-before-plan
/// pin: the carrier never reaches the gate OR managed-launch planning — no
/// codex child ever spawns (the dispatcher's argv capture never appears).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "host-gated e2e (needs node + repo node_modules); mutates process env — run alone with --ignored --test-threads=1"]
async fn managed_default_legacy_codex_carrier_is_rejected_before_any_planning() {
    // Managed leg: the flag stays UNSET (default ON). remove_var, not "1",
    // mirroring codex_managed_launch_e2e.rs's managed phases.
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    let stale_id = "0b5aa1d2-9d5c-4f6e-8f2a-1c3d5e7f9a0b"; // definitively absent
    let capture_path = std::env::temp_dir().join(format!(
        "freshell-resume-gate-managed-argv-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture_path);
    let dispatcher = write_codex_dispatcher();
    std::env::set_var("CODEX_CMD", &dispatcher);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture_path);

    // Probe: codex stale_id is POSITIVELY absent (store readable). The codex
    // arm gates on positive Absent alone — no on-disk-history flag needed.
    let probe = StubProbe::answering("codex", stale_id, SessionExistence::Absent);
    // Hygiene: point CODEX_HOME at a temp dir so no codex-side path can ever
    // touch the real ~/.codex (the fake app-server writes ~/.codex/sessions
    // on turn/start when CODEX_HOME is unset; this test never sends
    // turn/start, but pin it anyway):
    let codex_home = std::env::temp_dir().join(format!(
        "freshell-resume-gate-codex-home-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&codex_home).expect("codex home");
    std::env::set_var("CODEX_HOME", &codex_home);
    let (url, registry, _ledger, _state) = spawn_managed_codex_server_with_probe(probe, true).await;

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    // terminal.create with restore:true carrying the stale codex resume id —
    // the legacy resume-id carrier shape (case 6), minus its live-sidecar
    // arrangement: post-ejh6 the raw guard rejects it at the door.
    send_json(
        &mut ws,
        &restore_create_with_legacy_resume_id("req-gate-7", "codex", stale_id),
    )
    .await;

    // 1. Rejected at the door: INVALID_MESSAGE + frozen text.
    let frame = next_created_or_error(&mut ws, "req-gate-7").await;
    assert_eq!(
        frame["type"], "error",
        "the legacy carrier must be refused, never spawn: {frame}"
    );
    assert_eq!(
        frame["code"], "INVALID_MESSAGE",
        "codex is no longer exempt from the legacy-field reject: {frame}"
    );
    assert_eq!(
        frame["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {frame}"
    );

    registry.kill_all();
    std::env::remove_var("CODEX_CMD");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
    std::env::remove_var("CODEX_HOME");

    // 2. Zero side effects: no codex child ever launched (the dispatcher
    //    writes the capture synchronously at spawn).
    assert_never_captured(&capture_path);
    let _ = std::fs::remove_file(&capture_path);
}

fn fresh_create(request_id: &str, mode: &str) -> serde_json::Value {
    // Same envelope as a restore create, minus every resume carrier — this
    // is the shape that triggers the server prealloc arms.
    let mut v = restore_create_with_session_ref(request_id, mode, "unused");
    let obj = v.as_object_mut().expect("create frame is an object");
    obj.remove("restore");
    obj.remove("sessionRef");
    obj.remove("resumeSessionId");
    v
}

/// A fresh claude create mints a SERVER-allocated session id (prealloc).
/// That id is by definition absent on disk — and must NEVER be gated:
/// no notice, plain successful create. Probe answers Absent-but-observed
/// for everything, so any gate consult on the minted id evaluates to
/// SpawnFresh (the claude zero-turn carve-out does NOT apply), fires the
/// notice, and fails this test.
#[tokio::test(flavor = "multi_thread")]
async fn server_allocated_fresh_claude_id_is_never_gated() {
    let (url, registry, _ledger, _state) =
        spawn_server_with_probe(Arc::new(AbsentButObservedProbe), false).await;

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(&mut ws, &fresh_create("req-prealloc-claude", "claude")).await;
    let frame = next_created_or_error(&mut ws, "req-prealloc-claude").await;

    assert_eq!(
        frame["type"], "terminal.created",
        "fresh claude create must succeed, got {frame}"
    );
    assert!(
        notice_of(&frame).is_none(),
        "server-allocated claude prealloc id must never trip the gate notice"
    );

    registry.kill_all();
}

/// The amplifier sibling (THE TRAP: claude_fresh_prealloc == false here, yet
/// the id is still server-minted): a fresh amplifier create must never gate.
#[tokio::test(flavor = "multi_thread")]
async fn server_allocated_fresh_amplifier_id_is_never_gated() {
    let (url, registry, _ledger, _state) =
        spawn_server_with_probe(Arc::new(AbsentButObservedProbe), false).await;
    let _amp_home = common::isolate_amplifier_home();

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(&mut ws, &fresh_create("req-prealloc-amp", "amplifier")).await;
    let frame = next_created_or_error(&mut ws, "req-prealloc-amp").await;

    assert_eq!(
        frame["type"], "terminal.created",
        "fresh amplifier create must succeed, got {frame}"
    );
    assert!(
        notice_of(&frame).is_none(),
        "server-minted amplifier id must never trip the gate notice"
    );

    registry.kill_all();
}

// ── gate-vs-plan ORDER probe (case 7b) ──────────────────────────────────────

/// [`StubProbe`] + a gate-consult latch (post-ejh6 polarity): on the FIRST
/// `exists` consult for the watched `(provider, session_id)`, records whether
/// managed-launch planning had ALREADY spawned the codex app-server sidecar
/// (the fixture's `FAKE_CODEX_APP_SERVER_ARG_LOG` file exists on disk).
///
/// Post-ejh6 the legacy carrier is rejected at the raw pre-parse guard, so
/// the assertion is the latch's ABSENCE: `None` after the exchange proves
/// the disk-existence gate was never consulted for the legacy carrier at
/// all — stronger than the old gate-before-plan ordering pin.
struct GateOrderProbe {
    provider: String,
    session_id: String,
    answer: SessionExistence,
    planning_marker: std::path::PathBuf,
    planning_started_before_gate: std::sync::Mutex<Option<bool>>,
}

impl SessionExistenceProbe for GateOrderProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        if provider == self.provider && session_id == self.session_id {
            let mut latch = self.planning_started_before_gate.lock().unwrap();
            if latch.is_none() {
                *latch = Some(self.planning_marker.exists());
            }
            return self.answer;
        }
        SessionExistence::Unknown
    }
    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        false
    }
}

/// Case 7b — the ZERO-consult invariant behind case 7, made directly
/// observable: a stale codex legacy carrier must be rejected at the door
/// with the probe NEVER consulted (`latch == None`) and NO app-server
/// sidecar ever planned (the fixture's arg-log file never appears).
/// Post-ejh6 the raw pre-parse guard supersedes the gate-before-plan
/// ordering this test used to pin: the legacy carrier cannot reach either
/// stage.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "host-gated e2e (needs node + repo node_modules); mutates process env — run alone with --ignored --test-threads=1"]
async fn managed_default_legacy_codex_carrier_never_consults_gate_or_plans() {
    // Managed leg: the flag stays UNSET (default ON), mirroring case 7.
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");

    let stale_id = "3f9d2c81-6a4e-4b7f-9c0d-5e8a1b2c3d4f"; // definitively absent
    let capture_path = std::env::temp_dir().join(format!(
        "freshell-resume-gate-order-argv-{}.json",
        std::process::id()
    ));
    // The committed fake-app-server fixture writes this file synchronously at
    // startup (before `new WebSocketServer`) when the env var is set — it
    // exists on disk ⟺ sidecar planning has begun.
    let planning_marker = std::env::temp_dir().join(format!(
        "freshell-resume-gate-order-planned-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture_path);
    let _ = std::fs::remove_file(&planning_marker);
    let dispatcher = write_codex_dispatcher();
    std::env::set_var("CODEX_CMD", &dispatcher);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture_path);
    std::env::set_var("FAKE_CODEX_APP_SERVER_ARG_LOG", &planning_marker);
    let codex_home = std::env::temp_dir().join(format!(
        "freshell-resume-gate-order-codex-home-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&codex_home).expect("codex home");
    std::env::set_var("CODEX_HOME", &codex_home);

    let probe = Arc::new(GateOrderProbe {
        provider: "codex".into(),
        session_id: stale_id.into(),
        answer: SessionExistence::Absent,
        planning_marker: planning_marker.clone(),
        planning_started_before_gate: std::sync::Mutex::new(None),
    });
    let (url, registry, _ledger, _state) =
        spawn_managed_codex_server_with_probe(probe.clone(), true).await;

    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;
    send_json(
        &mut ws,
        &restore_create_with_legacy_resume_id("req-gate-7b", "codex", stale_id),
    )
    .await;

    // Rejected at the door: INVALID_MESSAGE + frozen text.
    let frame = next_created_or_error(&mut ws, "req-gate-7b").await;
    assert_eq!(
        frame["type"], "error",
        "the legacy carrier must be refused, never spawn: {frame}"
    );
    assert_eq!(
        frame["code"], "INVALID_MESSAGE",
        "codex is no longer exempt from the legacy-field reject: {frame}"
    );
    assert_eq!(
        frame["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {frame}"
    );

    let gate_consulted = probe.planning_started_before_gate.lock().unwrap().is_some();

    // THE pins run BEFORE the evidence files are deleted, with the teardown
    // owned by a scope guard so a RED run still cleans up on unwind (see
    // AssertBeforeCleanupGuard). Asserting before deletion is the load-bearing
    // ordering: the never-captured pins must observe the filesystem while a
    // violation is still visible.
    let _teardown = AssertBeforeCleanupGuard {
        registry: &registry,
        evidence_files: vec![capture_path.clone(), planning_marker.clone()],
    };

    // THE pins: the gate NEVER consulted the probe for the legacy carrier,
    // and neither the managed-planning sidecar (arg-log marker) nor a TUI
    // child (argv capture) ever spawned.
    assert!(
        !gate_consulted,
        "the disk-existence gate must NEVER consult the probe for a legacy carrier \
         (the raw guard rejects it first) — probe latch was set for stale id {stale_id}"
    );
    assert_never_captured(&planning_marker);
    assert_never_captured(&capture_path);
}

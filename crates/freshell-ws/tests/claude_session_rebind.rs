//! Claude mid-session rebind via SessionStart signal files.
//! Phase 1: create a claude terminal (spawn identity A via the preallocated
//!   --session-id path), drive the sweep body directly against a temp signal
//!   root, drop a signal file {session_id: "B", source: "resume"} named
//!   "<terminal_id>__1.json"; expect terminal.session.associated with
//!   sessionRef {provider:"claude", sessionId:"B"} and previousSessionId ==
//!   "A"; registry meta resume_session_id == "B".
//! Phase 2 (the restart story): kill; create with sessionRef {claude, "B"} +
//!   restore:true and CLAUDE_ARGV capture -> argv contains ["--resume","B"].
//! Phase 3 (hijack): second live claude pane bound to "C"; drop a signal
//!   for pane1 claiming "C" -> refused; both panes' meta unchanged (A13).
//! Phase 4 (cross-kind, D7): a LIVE freshclaude sidecar owns "D" (fake
//!   sidecar, in-memory session map only -- no ledger row); a signal claiming
//!   "D" for a terminal pane -> refused (live-sidecar session-map probe).
//! Phase 5 (multi-instance, P4): a signal naming a terminal id unknown to
//!   this instance is RETAINED across drain cycles, never emits a frame,
//!   and is reaped only after the staleness TTL.
//! Phase 6 (first-bind, P2): a fresh claude pane's resume identity is the
//!   spawn-time preallocated --session-id, NOT signal consumption; it stays
//!   intact even after an external actor destroys every signal file.
//! Phase 7 (foreign provider, Discard): a signal naming a SHELL-mode pane is
//!   explicitly ignored and CONSUMED (Discard, not Retain) -- no associated
//!   frame, file deleted, so it cannot warn-log every sweep for 10 minutes.
//!
//! Determinism: the test calls `drain_and_rebind_claude` directly on a state
//! handle (the brief's preferred shape) instead of racing a spawned sweep
//! timer. ONE test fn: the phases share server/env state (CLAUDE_CMD /
//! CLAUDE_ARGV_CAPTURE_PATH are process-wide), and phase 2/3 build on
//! phase 1's rebind.

#[cfg(unix)]
mod common;

#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use std::time::Duration;
#[cfg(unix)]
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// Canonical claude session UUIDs (the resume-create path rejects
/// non-canonical claude ids with RESTORE_UNAVAILABLE).
#[cfg(unix)]
const B: &str = "22222222-3333-4444-8555-666677778888";
#[cfg(unix)]
const C: &str = "33333333-4444-4555-8666-777788889999";

/// Fake claude that records its argv (one token per line, atomically via
/// tmp+mv) to `$CLAUDE_ARGV_CAPTURE_PATH` before parking -- the argv-capture
/// idiom copied from `codex_fork_rebind.rs`.
#[cfg(unix)]
fn write_fake_claude_capture() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-claude-rebind-capture-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CLAUDE_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CLAUDE_ARGV_CAPTURE_PATH.tmp\" \"$CLAUDE_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake claude capture script");
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

/// `sleeper_cli_spec`-style claude spec with `env_var: Some("CLAUDE_CMD")` --
/// the test points CLAUDE_CMD at the argv-capturing fake.
#[cfg(unix)]
fn claude_capture_spec() -> freshell_platform::CliCommandSpec {
    let mut spec = common::sleeper_cli_spec("claude");
    spec.env_var = Some("CLAUDE_CMD".to_string());
    spec
}

/// Poll the capture file the fake writes until it appears, then return the
/// argv tokens (one per line). Copied from `codex_fork_rebind.rs`.
#[cfg(unix)]
fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if !raw.is_empty() {
                return raw.lines().map(str::to_string).collect();
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "spawned claude child never wrote its argv capture at {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Position of the adjacent `["--resume", session_id]` pair in argv, if any.
#[cfg(unix)]
fn resume_pair_position(argv: &[String], session_id: &str) -> Option<usize> {
    argv.windows(2)
        .position(|w| w[0] == "--resume" && w[1] == session_id)
}

/// The registry's `resume_session_id` for a terminal (meta probe).
#[cfg(unix)]
fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// [`common::spawn_server_with_specs`], but ALSO returning the `WsState`
/// handle so the test can drive `drain_and_rebind_claude` directly
/// (deterministic -- no sweep-timer race). `WsState` is Clone (every field
/// is an Arc/primitive), so the clone shares the server's live stores.
#[cfg(unix)]
async fn spawn_server_returning_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    freshell_ws::WsState,
) {
    use std::sync::Arc;
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = freshell_ws::WsState {
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
        registry: registry.clone(),
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
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
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    };

    let router = freshell_ws::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (format!("ws://{addr}/ws", addr = addr), registry, state)
}

/// Scan WS text frames until the next `terminal.session.associated` for
/// `terminal_id` arrives (10 s budget), returning the parsed frame. Copied
/// from `codex_fork_rebind.rs`.
#[cfg(unix)]
async fn next_associated_frame(
    ws: &mut common::TestWs,
    terminal_id: &str,
    label: &str,
) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if value["type"] == "terminal.session.associated"
                        && value["terminalId"] == terminal_id
                    {
                        return value;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("[{label}] ws ended/errored/timed out awaiting associated: {other:?}"),
        }
    }
    panic!("[{label}] no terminal.session.associated frame for {terminal_id} within 10s");
}

/// Scan WS text frames until `pred` matches or `window` elapses, returning
/// whether a matching frame arrived. Copied from `codex_fork_rebind.rs`;
/// serves the phase-3 absence proof.
#[cfg(unix)]
async fn frame_seen_within(
    ws: &mut common::TestWs,
    window: Duration,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    let deadline = tokio::time::Instant::now() + window;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining.max(Duration::from_millis(1)), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if pred(&value) {
                        return true;
                    }
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false, // stream ended, ws error, or timed out
        }
    }
    false
}

/// Send a `terminal.create` and await its `terminal.created`, returning the
/// full frame (multi-pane phases need distinct requestIds -- the
/// create-dedupe folds a repeated id into the FIRST create's terminal).
#[cfg(unix)]
async fn send_create(ws: &mut common::TestWs, body: serde_json::Value) -> serde_json::Value {
    ws.send(WsMessage::Text(body.to_string()))
        .await
        .expect("send terminal.create");
    common::next_frame_of_type(ws, "terminal.created").await
}

/// Minimal fake claude sidecar speaking the newline-JSON protocol: answers
/// `create` with `created` + `sdk.session.init` (echoing resumeSessionId as
/// the durable cliSessionId), exits on `shutdown`.
#[cfg(unix)]
const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"import readline from 'node:readline'

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

/// A fresh temp dir holding the fake sidecar script, with
/// `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE` pointed at it, PLUS an
/// empty claude store with `CLAUDE_CONFIG_DIR` pointed at it (so the test
/// never touches the real home). This file is `#[cfg(unix)]` and its single
/// test fn owns process env, so no env lock is needed.
#[cfg(unix)]
struct FakeClaudeEnv {
    dir: std::path::PathBuf,
}
#[cfg(unix)]
impl FakeClaudeEnv {
    fn install() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "freshell-fake-claude-rebind-{}",
            std::process::id()
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
#[cfg(unix)]
impl Drop for FakeClaudeEnv {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn session_start_signal_rebinds_and_restores_the_new_id() {
    // ---- env setup (single test fn: this binary owns process env) ----
    let capture_for = |phase: &str| {
        std::env::temp_dir().join(format!(
            "freshell-claude-rebind-argv-{phase}-{}.txt",
            std::process::id()
        ))
    };
    // The capture fake dereferences $CLAUDE_ARGV_CAPTURE_PATH on EVERY
    // spawn, so the var is set before the first create too (bind-phase argv
    // is not asserted -- a fresh create has no resume args by construction).
    let capture_bind = capture_for("bind");
    let _ = std::fs::remove_file(&capture_bind);
    std::env::set_var("CLAUDE_ARGV_CAPTURE_PATH", &capture_bind);
    std::env::set_var(
        "CLAUDE_CMD",
        write_fake_claude_capture().to_string_lossy().to_string(),
    );

    let signal_root = std::env::temp_dir().join(format!(
        "freshell-claude-rebind-signals-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&signal_root);
    std::fs::create_dir_all(&signal_root).expect("signal root");
    let watcher = freshell_ws::claude_signal::ClaudeSignalWatcher::new(signal_root.clone());

    let (url, registry, state) = spawn_server_returning_state(vec![claude_capture_spec()]).await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    // ── Phase 1 -- mid-session rebind: fresh claude pane (identity A via the
    // preallocated --session-id path), then the CLI reports B via a
    // SessionStart signal file.
    let created = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-1",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid1 = created["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let a = common::session_ref_of(&created).expect("fresh claude carries a preallocated ref")
        ["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    assert_ne!(a, B, "preallocated id must differ from the signal id");

    std::fs::write(
        signal_root.join(format!("{tid1}__1.json")),
        format!(r#"{{"session_id":"{B}","source":"resume","hook_event_name":"SessionStart"}}"#),
    )
    .expect("write signal file");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;

    let rebound = next_associated_frame(&mut ws, &tid1, "phase1/rebind").await;
    assert_eq!(
        rebound["sessionRef"],
        json!({ "provider": "claude", "sessionId": B }),
        "rebind must move the pane to the CLI-reported id: {rebound}"
    );
    assert_eq!(
        rebound["previousSessionId"],
        json!(a),
        "rebind must carry previousSessionId == the superseded id: {rebound}"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid1).as_deref(),
        Some(B),
        "registry meta resume_session_id must follow the rebind"
    );

    // ── Phase 2 -- the restart story: kill, then replay EXACTLY what a
    // client that accepted the rebind persists (sessionRef {claude, B} +
    // restore:true). The respawned claude must launch `--resume B`.
    registry.kill(&tid1);
    let capture_respawn = capture_for("respawn");
    let _ = std::fs::remove_file(&capture_respawn);
    std::env::set_var("CLAUDE_ARGV_CAPTURE_PATH", &capture_respawn);

    let restored = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-2",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": B },
        }),
    )
    .await;
    let tid2 = restored["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let argv = wait_for_captured_argv(&capture_respawn);
    assert!(
        resume_pair_position(&argv, B).is_some(),
        "respawned claude argv must contain `--resume {B}`: {argv:?}"
    );
    assert!(
        !argv.iter().any(|t| t == &a),
        "respawned claude argv must NOT reference the superseded id {a}: {argv:?}"
    );

    // ── Phase 3 -- hijack (A13): a second live claude pane owns C; a signal
    // for pane tid2 claiming C must be refused, both panes' meta unchanged.
    let capture_p3 = capture_for("pane3");
    let _ = std::fs::remove_file(&capture_p3);
    std::env::set_var("CLAUDE_ARGV_CAPTURE_PATH", &capture_p3);
    let created3 = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-3",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true,
            "sessionRef": { "provider": "claude", "sessionId": C },
        }),
    )
    .await;
    let tid3 = created3["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    std::fs::write(
        signal_root.join(format!("{tid2}__2.json")),
        format!(r#"{{"session_id":"{C}","source":"resume","hook_event_name":"SessionStart"}}"#),
    )
    .expect("write forged signal file");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;

    // Absence proof: NO associated frame may move tid2 (the drain already
    // completed synchronously above; the short window drains any in-flight
    // broadcast forwarding).
    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == tid2.as_str()
    })
    .await;
    assert!(
        !moved,
        "a signal claiming a live-owned session must never rebind the pane (A13)"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid2).as_deref(),
        Some(B),
        "pane tid2 must still be bound to B"
    );
    assert_eq!(
        registry_resume_id(&registry, &tid3).as_deref(),
        Some(C),
        "pane tid3 must still own C"
    );
    assert_eq!(
        std::fs::read_dir(&signal_root).unwrap().count(),
        0,
        "a deliberate refusal counts as acted on: the file is consumed (act-then-delete)"
    );

    // ---- Phase 4: cross-kind (D7) -- a signal claiming a session owned by a
    // LIVE freshclaude sidecar must NOT move the pane (the ledger-row guard
    // is blind to a sidecar whose durable row hasn't landed; this phase
    // proves the in-memory session-map probe covers that window).
    let capture_p4 = capture_for("pane4");
    let _ = std::fs::remove_file(&capture_p4);
    std::env::set_var("CLAUDE_ARGV_CAPTURE_PATH", &capture_p4);
    let created4 = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-4",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid4 = created4["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    let _fake_env = FakeClaudeEnv::install();
    let sidecar_sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    ws.send(WsMessage::Text(
        json!({
            "type": "freshAgent.create",
            "requestId": "req-live-owner",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": sidecar_sid,
            "sessionRef": { "provider": "claude", "sessionId": sidecar_sid },
        })
        .to_string(),
    ))
    .await
    .expect("send freshAgent.create");
    assert!(
        frame_seen_within(&mut ws, Duration::from_secs(15), |v| {
            v["type"] == "freshAgent.created" && v["requestId"] == "req-live-owner"
        })
        .await,
        "fake sidecar must come live"
    );
    // The resume path inserts cli_index[S] synchronously before `created`
    // (claude.rs:436), so the probe is authoritative now:
    assert!(state.fresh_claude.has_live_session(sidecar_sid).await);

    // Forge a SessionStart signal from the phase-4 pane claiming the
    // sidecar-owned session.
    std::fs::write(
        signal_root.join(format!("{tid4}__1769000000000000009-1.json")),
        format!(r#"{{"session_id":"{sidecar_sid}","source":"resume"}}"#),
    )
    .expect("write forged signal file");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;

    // Refusal proof: the pane's identity did not move...
    assert_ne!(
        registry_resume_id(&registry, &tid4).as_deref(),
        Some(sidecar_sid),
        "a live-sidecar-owned session must never be claimed by a terminal pane"
    );
    // ...no association frame was emitted for it...
    assert!(
        !frame_seen_within(&mut ws, Duration::from_secs(2), |v| {
            v["type"] == "terminal.session.associated"
                && v["terminalId"] == tid4.as_str()
                && v["sessionRef"]["sessionId"] == sidecar_sid
        })
        .await,
        "no rebind frame may be emitted for a refused claim"
    );
    // ...and the deliberate refusal counts as acted on: the file is
    // consumed (act-then-delete).
    assert!(!signal_root
        .join(format!("{tid4}__1769000000000000009-1.json"))
        .exists());

    // ── Phase 5 — multi-instance retention (P4): a signal naming a terminal
    // id UNKNOWN to this instance (another freshell server sharing $HOME
    // owns that pane) must be RETAINED across drain cycles, never emit a
    // frame, and be reaped only after the staleness TTL.
    let foreign_tid = "some-other-instances-pane";
    let foreign_path = signal_root.join(format!("{foreign_tid}__9000000000000000000-1.json"));
    std::fs::write(
        &foreign_path,
        r#"{"session_id":"11111111-2222-3333-4444-555555555555","source":"resume","hook_event_name":"SessionStart"}"#,
    )
    .expect("write foreign-instance signal");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        foreign_path.exists(),
        "an unknown-terminal signal must be RETAINED on disk (act-then-delete), \
         not destroyed -- a second freshell instance sharing $HOME owns it"
    );
    // Absence proof: no associated frame for the foreign terminal id within
    // 1s (reuse this file's Phase 3 absence-proof helper/pattern verbatim,
    // substituting foreign_tid).
    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == foreign_tid
    })
    .await;
    assert!(
        !moved,
        "an unknown-terminal signal must never produce an associated frame on this instance"
    );
    // Retention is stable across sweeps, not a one-drain artifact.
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        foreign_path.exists(),
        "the retained signal must survive a SECOND drain (stable retention)"
    );
    // Reaped ONLY after the staleness TTL: backdate the mtime past the cap
    // (STALE_SIGNAL_MAX_AGE = 600s, opencode_signal.rs:40 -- pub(crate),
    // not visible to this integration binary, hence the literal; the
    // in-module unit test drain_reaps_stale_files_without_emitting pins the
    // reap against the constant itself).
    let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(11 * 60);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&foreign_path)
        .expect("open retained signal for backdating")
        .set_modified(stale)
        .expect("backdate retained signal");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        !foreign_path.exists(),
        "an orphaned unknown-terminal signal must be reaped after the staleness TTL"
    );

    // ── Phase 6 — first-bind is signal-independent (P2): a fresh claude
    // pane's resume identity comes from the spawn-time preallocated
    // --session-id (terminal.rs fresh-create path), NOT from signal
    // consumption. Even if an external actor (e.g. another instance's
    // pre-parity destructive sweeper) destroys every signal file, the pane
    // must still carry a usable sessionRef/resume identity.
    //
    // Create a fresh claude pane exactly the way Phase 1 does (no
    // resumeSessionId, no sessionRef, no restore) and capture its
    // terminal.created frame.
    let capture_p6 = capture_for("pane6");
    let _ = std::fs::remove_file(&capture_p6);
    std::env::set_var("CLAUDE_ARGV_CAPTURE_PATH", &capture_p6);
    let created6 = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-6",
            "mode": "claude",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid6 = created6["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let created_ref =
        common::session_ref_of(&created6).expect("fresh claude carries a preallocated ref");
    assert_eq!(created_ref["provider"], "claude");
    let preallocated_id = created_ref["sessionId"]
        .as_str()
        .expect("fresh claude create must carry a preallocated session id")
        .to_string();
    assert_eq!(preallocated_id.len(), 36, "preallocated id is a UUID");
    // External actor destroys EVERY signal file (the pre-fix production
    // sweeper's behavior): wipe the whole signal dir.
    if let Ok(entries) = std::fs::read_dir(&signal_root) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    // Sweep after the destruction: binding must be unaffected.
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    // The pane's resume identity is intact and usable (same read pattern
    // Phase 1 uses to assert registry_resume_id(tid1) == B).
    assert_eq!(
        registry_resume_id(&registry, &tid6).as_deref(),
        Some(preallocated_id.as_str()),
        "a fresh claude pane must keep its preallocated resume identity even \
         when every signal file is destroyed by an external actor"
    );

    // ── Phase 7 — foreign provider (Discard): a signal addressed to a
    // SHELL-mode pane is explicitly ignored (logged) and CONSUMED — it can
    // never become actionable (a pane's mode never changes), so retaining it
    // would just warn-log every 1s sweep for 10 minutes (unbounded noise).
    // Ports opencode_switch_rebind.rs's foreign-provider phase.
    let created7 = send_create(
        &mut ws,
        json!({
            "type": "terminal.create",
            "requestId": "req-claude-rebind-7",
            "mode": "shell",
            "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
    )
    .await;
    let tid7 = created7["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    // A valid claude UUID bound nowhere — the mode guard must fire before
    // any session-ownership probe even matters.
    let foreign_claim = "77777777-8888-4999-8aaa-bbbbccccdddd";
    let discard_path = signal_root.join(format!("{tid7}__9100000000000000000-1.json"));
    std::fs::write(
        &discard_path,
        format!(
            r#"{{"session_id":"{foreign_claim}","source":"resume","hook_event_name":"SessionStart"}}"#
        ),
    )
    .expect("write foreign-provider signal");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    // Discard => consumed, NOT retained (this is what distinguishes Discard
    // from Retain: a Retain regression would warn-log every sweep for 10min).
    assert!(
        !discard_path.exists(),
        "a foreign-provider signal file must be CONSUMED (Discard), not retained"
    );
    // Absence proof: the shell pane was never rebound (Phase 5 pattern).
    let moved = frame_seen_within(&mut ws, Duration::from_secs(1), |v| {
        v["type"] == "terminal.session.associated" && v["terminalId"] == tid7.as_str()
    })
    .await;
    assert!(
        !moved,
        "a foreign-provider pane must never be rebound by a claude signal"
    );

    state.fresh_claude.shutdown().await; // reap the fake node child

    registry.kill(&tid2);
    registry.kill(&tid3);
    registry.kill(&tid4);
    registry.kill(&tid6);
    let _ = std::fs::remove_dir_all(&signal_root);
    std::env::remove_var("CLAUDE_ARGV_CAPTURE_PATH");
    std::env::remove_var("CLAUDE_CMD");
}

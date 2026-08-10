//! respawn_agent_terminal spawns a resume-generation with the same
//! createRequestId and provider-native resume argv.
//!
//! Raw-WS integration against an in-process axum server on an ephemeral
//! loopback port (shared `common` harness convention). The claude CLI command
//! is overridden with a recording shim so argv is assertable — the same
//! plain-`sh` recording-script convention as `codex_session_ref_resume.rs`,
//! with the capture path baked into the script (no env-var mutation, so this
//! stays parallel-safe).

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{connect_and_capture_inventory, next_frame_of_type};
use futures_util::SinkExt;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};
use freshell_ws::pane_ledger::{BindingWrite, PaneLedger, RetiredReason, RowState};
use freshell_ws::WsState;

/// A claude-shaped CLI spec whose command records its argv (one token per
/// line, atomically via tmp+mv) to `capture`, then exits 1 — so the first
/// generation "crashes" immediately and a respawn's argv overwrites the
/// capture. The crash-and-record sibling of `auto_resume_events.rs`'s
/// `exiting_cli_spec`.
fn recording_crashing_claude_spec(capture: &std::path::Path) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-respawn-shim-{}.sh",
        std::process::id()
    ));
    let capture = capture.display();
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{capture}.tmp.$$\"\nmv \"{capture}.tmp.$$\" \"{capture}\"\nexit 1\n"
    );
    std::fs::write(&script_path, script).expect("write recording shim");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    freshell_platform::CliCommandSpec {
        name: "claude".to_string(),
        label: "claude-label".to_string(),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        // The fresh-claude preallocation path THROWS without
        // `create_session_args` (`cli_launch.rs:436-441`); same shape as
        // `common::sleeper_cli_spec`.
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Poll the capture file until its argv contains `--resume <session_id>` (the
/// respawn overwrites the crashed generation's `--session-id ...` capture) or
/// the deadline passes; returns the captured argv tokens for the assertion.
fn wait_for_resume_argv(path: &std::path::Path, session_id: &str) -> Vec<String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(raw) = std::fs::read_to_string(path) {
            let argv: Vec<String> = raw.lines().map(str::to_string).collect();
            if argv
                .windows(2)
                .any(|w| w[0] == "--resume" && w[1] == session_id)
            {
                return argv;
            }
            if std::time::Instant::now() >= deadline {
                return argv; // let the caller's assertion print what WAS captured
            }
        } else {
            assert!(
                std::time::Instant::now() < deadline,
                "spawned child never wrote its argv capture at {}",
                path.display()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn respawn_spawns_resume_generation_with_same_create_request_id() {
    let capture = std::env::temp_dir().join(format!(
        "freshell-auto-resume-respawn-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture);
    let (url, registry, state) =
        common::spawn_server_with_specs_and_state(vec![recording_crashing_claude_spec(&capture)])
            .await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Arrange: a fresh claude terminal (server-preallocated session id, so
    // `terminal.created` carries the sessionRef) that has crashed — the
    // recording shim exits 1 immediately.
    let create_request_id = "req-respawn-1";
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": create_request_id,
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let old_tid = created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string();
    let session_id = created["sessionRef"]["sessionId"]
        .as_str()
        .expect("fresh claude create carries a preallocated sessionRef")
        .to_string();

    // Wait for the crash: the registry row leaves Running (natural exit keeps
    // the row, status Exited) and the exit hook has retired the identity.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let status = registry
            .probe(&old_tid)
            .expect("crashed row remains")
            .status;
        if status != freshell_protocol::TerminalRunStatus::Running {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "crashed generation never exited"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let new_tid = freshell_ws::terminal::respawn_agent_terminal(
        &state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "claude".into(),
            provider: "claude".into(),
            session_id: session_id.clone(),
            create_request_id: create_request_id.into(),
            cwd: None,
        },
    )
    .await
    .expect("respawn");

    assert_ne!(new_tid, old_tid, "a respawn mints a new terminalId");
    // Registry row: same createRequestId, mode claude, resume id recorded.
    let probe = registry.probe(&new_tid).expect("row");
    assert_eq!(probe.mode, "claude");
    assert_eq!(
        probe.resume_session_id.as_deref(),
        Some(session_id.as_str())
    );
    assert_eq!(
        registry.probe_create_request_id(&new_tid),
        Some(create_request_id.to_string())
    );
    // Argv: the fake CLI recorded `--resume <session_id>`.
    let argv = wait_for_resume_argv(&capture, &session_id);
    assert!(
        argv.windows(2)
            .any(|w| w[0] == "--resume" && w[1] == session_id),
        "resume argv missing: {argv:?}"
    );
}

/// Kata enn3 interaction pin: an auto-resume respawn is a SERVER-initiated
/// create, and a crash-loop storm is exactly the shape the server-wide spawn
/// gate exists to bound — so `respawn_agent_terminal` must queue behind the
/// SAME gate as the WS-restore and REST doors and fail loud (no spawn) when
/// the gate's queue is full.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn respawn_is_rejected_loud_when_spawn_gate_queue_is_full() {
    let (_url, _registry, state) =
        common::spawn_server_with_specs_and_state(vec![common::sleeper_cli_spec("claude")]).await;

    // Saturate the gate: hold every concurrency permit (the shared test
    // harness builds `SpawnGate::new(4, 64)`)...
    let (_hold_tx, mut hold_rx) = tokio::sync::watch::channel(false);
    let mut held_permits = Vec::new();
    for _ in 0..4 {
        held_permits.push(
            state
                .spawn_gate
                .acquire(Duration::from_secs(30), &mut hold_rx)
                .await
                .expect("free permit while unsaturated"),
        );
    }
    // ...then fill the 64-deep queue with waiters (each owns a never-fired
    // cancel sender for its lifetime, the REST-door convention).
    let mut waiters = Vec::new();
    for _ in 0..64 {
        let gate = std::sync::Arc::clone(&state.spawn_gate);
        waiters.push(tokio::spawn(async move {
            let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
            let _ = gate.acquire(Duration::from_secs(30), &mut cancel_rx).await;
        }));
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while state.spawn_gate.queued_total() < 64 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "gate queue never filled: queued_total={}",
            state.spawn_gate.queued_total()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let err = freshell_ws::terminal::respawn_agent_terminal(
        &state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "claude".into(),
            provider: "claude".into(),
            session_id: "sess-gate-pin".into(),
            create_request_id: "req-gate-pin".into(),
            cwd: None,
        },
    )
    .await
    .expect_err("a queue-full spawn gate must reject the respawn, not spawn a PTY");

    match err {
        freshell_ws::terminal::RespawnError::LaunchUnresolvable(msg) => {
            // The queue-full mapping from `spawn_gate_error_parts` — proof the
            // rejection came from the gate, not some other pre-spawn failure.
            assert_eq!(msg, "Too many terminal.create requests");
        }
        other => panic!("expected the gate's queue-full rejection, got {other:?}"),
    }
    assert_eq!(
        state.spawn_gate.queue_rejections(),
        1,
        "exactly the respawn's acquire was rejected by the gate"
    );

    // Unblock the queued waiters so the test exits promptly.
    drop(held_permits);
    for w in waiters {
        let _ = w.await;
    }
}

// ── Door 2 (resume-validation): gate the headless respawn ──────────────────

/// Scripted disk-truth probe (the `resume_validation_gate.rs` convention).
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
        // Amplifier gating never consults the on-disk-history flag (only the
        // claude zero-turn carve-out does).
        false
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

/// Seed a Bound ledger row for `(provider, session_id)` through the STATE'S
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

/// Does `<amp_home>/projects/*/sessions/<session_id>` exist?
fn amplifier_session_dir_exists(amp_home: &std::path::Path, session_id: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(amp_home.join("projects")) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| e.path().join("sessions").join(session_id).is_dir())
}

/// A directly-constructed `WsState` for driving `respawn_agent_terminal`
/// (no WS connection needed on the headless door): injected existence probe +
/// REAL pane ledger in a fresh temp dir, amplifier sleeper CLI spec so the
/// respawn genuinely spawns. Field-for-field the
/// `resume_validation_gate.rs::spawn_server_with_probe` state.
fn respawn_state_with_probe(
    probe: Arc<dyn SessionExistenceProbe>,
) -> (
    freshell_terminal::TerminalRegistry,
    Arc<PaneLedger>,
    WsState,
) {
    // F7/V9 choke point: amplifier respawns write stub dirs — never the real home.
    let _ = common::isolate_amplifier_home();
    let ledger_dir = std::env::temp_dir().join(format!(
        "freshell-respawn-gate-ledger-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&ledger_dir).expect("create ledger temp dir");
    let pane_ledger = Arc::new(PaneLedger::new(Some(ledger_dir)));

    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings = Arc::new(
        serde_json::from_value(common::test_settings_value()).expect("valid settings fixture"),
    );
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
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            serde_json::json!({ "freshAgent": { "enabled": false } }),
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
        cli_commands: Arc::new(vec![common::sleeper_cli_spec("amplifier")]),
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

    (registry, pane_ledger, state)
}

/// Drain every frame buffered on the broadcast receiver into parsed JSON.
fn drain_broadcast_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(json) = rx.try_recv() {
        if let Ok(v) = serde_json::from_str::<Value>(&json) {
            frames.push(v);
        }
    }
    frames
}

/// Door 2 gate fire: a respawn of an amplifier id that is definitively absent
/// from the store must PROCEED as a fresh spawn (the pane survives), retire
/// the stale Bound row `SessionMissing`, never re-stub the stale dir,
/// broadcast a `terminal.status{recovering, reason}` frame naming the stale
/// id, and carry the FRESH id through ALL post-spawn bookkeeping (V8 §A9:
/// registry row, identity upsert, ledger record_binding — a Bound row for the
/// stale id must NOT be re-minted right after retire_missing).
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn respawn_with_absent_session_spawns_fresh_and_retires_binding() {
    let amp_home = common::isolate_amplifier_home();
    let probe = StubProbe::answering("amplifier", "stale-amp", SessionExistence::Absent);
    let (registry, ledger, state) = respawn_state_with_probe(probe);
    seed_bound_row(&ledger, "amplifier", "stale-amp");
    let mut rx = state.broadcast_tx.subscribe();

    let new_tid = freshell_ws::terminal::respawn_agent_terminal(
        &state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "amplifier".into(),
            provider: "amplifier".into(),
            session_id: "stale-amp".into(),
            create_request_id: "req-respawn-gate-1".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        },
    )
    .await
    .expect("a gate-fired respawn must proceed as a fresh spawn, never an error");

    // 2. The stale row is retired SessionMissing — never retried forever.
    let stale_row = ledger
        .load_binding("amplifier", "stale-amp")
        .expect("stale row still exists (retired, not deleted)");
    assert_eq!(stale_row.state, RowState::Retired);
    assert_eq!(
        stale_row.retired_reason,
        Some(RetiredReason::SessionMissing)
    );

    // 5. V8 §A9 pin: the NEW generation's bookkeeping carries the FRESH id.
    let sref = state
        .identity
        .session_ref_for(&new_tid)
        .expect("identity registry entry for the new terminal");
    assert_eq!(sref.provider, "amplifier");
    let fresh_id = sref.session_id.clone();
    assert_ne!(fresh_id, "stale-amp", "identity must name the fresh uuid");
    assert_eq!(
        registry
            .probe(&new_tid)
            .expect("registry row")
            .resume_session_id
            .as_deref(),
        Some(fresh_id.as_str()),
        "the registry row must record the fresh id, not the stale one"
    );
    assert_eq!(
        ledger
            .load_binding("amplifier", &fresh_id)
            .expect("fresh Bound row")
            .state,
        RowState::Bound
    );
    // record_binding must NOT have resurrected the stale id as Bound.
    assert_eq!(
        ledger
            .load_binding("amplifier", "stale-amp")
            .expect("stale row present")
            .state,
        RowState::Retired,
        "record_binding re-minted a Bound row for the stale id (respawn loop)"
    );

    // 3. ensure_session must not run for the stale id.
    assert!(
        !amplifier_session_dir_exists(&amp_home, "stale-amp"),
        "the amplifier pre-spawn stub must never resurrect the stale dir"
    );

    // 4. A broadcast terminal.status{recovering} frame names the stale id.
    let frames = drain_broadcast_frames(&mut rx);
    assert!(
        frames.iter().any(|v| v["type"] == "terminal.status"
            && v["status"] == "recovering"
            && v["reason"]
                .as_str()
                .is_some_and(|r| r.contains("stale-amp"))),
        "no recovering broadcast naming the stale id; frames: {frames:?}"
    );

    // #582 interplay: a gate-fired respawn is ONE ordinary recovery cycle.
    // (a) Exactly one Recovering status frame was broadcast for this respawn —
    //     the gate must not add a second cycle's worth of status traffic.
    let recovering_frames = frames
        .iter()
        .filter(|v| {
            v["type"] == "terminal.status"
                && v["status"] == "recovering"
                && v["reason"]
                    .as_str()
                    .is_some_and(|r| r.contains("stale-amp"))
        })
        .count();
    assert_eq!(
        recovering_frames, 1,
        "gate-fired respawn is a single recovery cycle"
    );

    // (b) The gate itself must not emit a breaker settle: no
    //     terminal.status{status: exited, resumeCycles: Some(_)} frame
    //     appears as part of this respawn.
    assert!(
        !frames.iter().any(|v| v["type"] == "terminal.status"
            && v["status"] == "exited"
            && !v["resumeCycles"].is_null()),
        "gate must not synthesize a breaker settle frame"
    );

    // (c) auto_resume_cancels bookkeeping is untouched by the gate — the
    //     harness state's cancel set/map remains empty (no phantom cancel).
    assert!(
        state
            .auto_resume_cancels
            .lock()
            .expect("auto_resume_cancels lock")
            .is_empty(),
        "gate must not record a phantom autoResumeCancel"
    );

    registry.kill_all();
}

/// Fail-open pin: Unknown existence resumes EXACTLY as today — the spawned
/// generation carries the resume id, the row stays Bound, and no
/// recovering-with-stale-id broadcast is emitted.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn respawn_with_unknown_existence_resumes_exactly_as_today() {
    let probe = StubProbe::answering("amplifier", "maybe-amp", SessionExistence::Unknown);
    let (registry, ledger, state) = respawn_state_with_probe(probe);
    seed_bound_row(&ledger, "amplifier", "maybe-amp");
    let mut rx = state.broadcast_tx.subscribe();

    let new_tid = freshell_ws::terminal::respawn_agent_terminal(
        &state,
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "amplifier".into(),
            provider: "amplifier".into(),
            session_id: "maybe-amp".into(),
            create_request_id: "req-respawn-gate-2".into(),
            cwd: Some(std::env::temp_dir().to_string_lossy().to_string()),
        },
    )
    .await
    .expect("Unknown fails open: the respawn proceeds as a resume");

    // The spawned generation still carries the resume id (the sibling test's
    // registry-row observation point) and the row stays Bound.
    assert_eq!(
        registry
            .probe(&new_tid)
            .expect("registry row")
            .resume_session_id
            .as_deref(),
        Some("maybe-amp")
    );
    assert_eq!(
        ledger
            .load_binding("amplifier", "maybe-amp")
            .expect("row present")
            .state,
        RowState::Bound
    );

    // No recovering-with-stale-id broadcast on the fail-open path.
    let frames = drain_broadcast_frames(&mut rx);
    assert!(
        !frames.iter().any(|v| v["type"] == "terminal.status"
            && v["status"] == "recovering"
            && v["reason"]
                .as_str()
                .is_some_and(|r| r.contains("maybe-amp"))),
        "Unknown must never emit the stale-id recovering frame; frames: {frames:?}"
    );

    registry.kill_all();
}

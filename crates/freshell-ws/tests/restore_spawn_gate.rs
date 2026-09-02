//! WSL-outage RCA §6.3 acceptance tests: the per-connection create rate
//! limit (legacy parity) and the cancellable, server-wide RESTORE-ONLY spawn
//! gate (scope pinned by user decision, PR #552): interactive (non-restore)
//! creates bypass the gate entirely for an instant create; only
//! `restore == Some(true)` creates -- the restart-storm fleet the gate
//! exists for -- are gated. REAL axum server + REAL tokio-tungstenite
//! client, the session_identity_frames.rs harness convention.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use freshell_ws::create_limit::CreateProtectConfig;
use freshell_ws::spawn_gate::SpawnGate;
use freshell_ws::WsState;

const AUTH_TOKEN: &str = "s3cr3t-token-abcdef";

fn test_settings_value() -> serde_json::Value {
    serde_json::json!({
        "ai": {},
        "codingCli": { "enabledProviders": [], "mcpServer": true, "providers": {} },
        "editor": { "externalEditor": "auto" },
        "extensions": { "disabled": [] },
        "freshAgent": { "defaultPlugins": [], "enabled": false, "providers": {} },
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

/// A minimal always-present CLI spec (`/bin/sh` sleeper script) so non-shell
/// creates genuinely spawn — the same recording-script convention as
/// `session_identity_frames.rs` (these tests assert on wire frames, not argv).
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-restore-gate-sleeper-{name}-{}.sh",
        std::process::id()
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
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Real server on an ephemeral loopback port with injectable protection
/// knobs. Returns (ws_url, registry, shutdown_notify, gate, shutdown_started).
async fn spawn_server(
    create_protect: CreateProtectConfig,
    gate: SpawnGate,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<SpawnGate>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let gate = std::sync::Arc::new(gate);
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let shutdown_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let auth_token = Arc::new(AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let settings =
        Arc::new(serde_json::from_value(test_settings_value()).expect("valid settings fixture"));
    let registry = freshell_terminal::TerminalRegistry::new();

    let state = WsState {
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
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![
            sleeper_cli_spec("amplifier"),
            sleeper_cli_spec("claude"),
        ]),
        shutdown: std::sync::Arc::clone(&shutdown),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect,
        spawn_gate: std::sync::Arc::clone(&gate),
        shutdown_started: std::sync::Arc::clone(&shutdown_started),
        create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
        pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
    };

    let router = freshell_ws::router(state);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    (
        format!("ws://{addr}/ws", addr = addr),
        registry,
        shutdown,
        gate,
        shutdown_started,
    )
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connect + hello, draining the handshake (`config_fallback` is None in
/// this harness, so the handshake is exactly 4 frames — the
/// `session_identity_frames.rs` convention).
async fn connect_and_hello(url: &str) -> TestWs {
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url)
        .await
        .expect("ws connect");
    // Nagle OFF on the test client: the two-creates-in-flight tests send
    // back-to-back small frames that must reach the server within the first
    // create's spawn-to-settled window; Nagle + delayed ACK on loopback
    // holds the second frame for ~3ms, longer than a whole settled create.
    if let tokio_tungstenite::MaybeTlsStream::Plain(stream) = ws.get_ref() {
        stream.set_nodelay(true).expect("set_nodelay");
    }
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

    for _ in 0..4u8 {
        let _ = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("handshake message within timeout")
            .expect("stream not ended")
            .expect("no ws error");
    }
    ws
}

/// Send one text frame.
async fn send_text(ws: &mut TestWs, text: &str) {
    ws.send(WsMessage::Text(text.to_string()))
        .await
        .expect("send text frame");
}

/// Read text frames until one with `type == wanted` arrives (bounded).
async fn next_json_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..20u8 {
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
    panic!("no {wanted} frame within 20 messages");
}

/// Read frames until `Message::Close(Some(frame))` arrives (bounded) — the
/// same way the `keepalive.rs`-family tests read server close codes.
async fn next_close_frame(
    ws: &mut TestWs,
) -> tokio_tungstenite::tungstenite::protocol::CloseFrame<'static> {
    for _ in 0..20u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("close frame within timeout")
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Close(Some(frame)) = msg {
            return frame;
        }
    }
    panic!("no close frame within 20 messages");
}

/// [`next_json_of_type`] variant that PANICS on any output-family frame
/// (`terminal.output` / `terminal.outputBatch`) while waiting. Used while
/// draining the storm's `terminal.created` replies: nothing is attached yet,
/// so output before attach would break the A21 causal invariant (create
/// never auto-attaches, registry.rs:548).
async fn next_json_of_type_failing_on_output(ws: &mut TestWs, wanted: &str) -> serde_json::Value {
    for _ in 0..40u8 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for a {wanted} frame"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let value: serde_json::Value = serde_json::from_str(text).expect("json frame");
            let frame_type = value["type"].as_str().unwrap_or("");
            assert!(
                frame_type != "terminal.output" && frame_type != "terminal.outputBatch",
                "output frame before any attach breaks the A21 causal invariant: {value}"
            );
            if frame_type == wanted {
                return value;
            }
        }
    }
    panic!("no {wanted} frame within 40 messages");
}

/// Plain-JSON `terminal.create` frame; a shell create needs no CLI spec.
fn create_frame(request_id: &str, restore: bool) -> String {
    if restore {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system","restore":true}}"#
        )
    } else {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system"}}"#
        )
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn third_non_restore_create_in_window_is_rate_limited() {
    let cfg = CreateProtectConfig {
        rate_limit: 2,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Creates 1 and 2: accepted -> terminal.created replies.
    for i in 0..2 {
        send_text(&mut client, &create_frame(&format!("req-{i}"), false)).await;
        let reply = next_json_of_type(&mut client, "terminal.created").await;
        assert_eq!(reply["requestId"], format!("req-{i}"));
    }
    // Create 3: rejected with RATE_LIMITED, and no third terminal exists.
    send_text(&mut client, &create_frame("req-2", false)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
    assert_eq!(err["requestId"], "req-2");

    assert_eq!(
        registry.kill_all(),
        2,
        "only the two accepted creates spawned"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_creates_are_gated_and_non_restore_bypass() {
    // RESTORE-ONLY gate scope (user decision, PR #552): interactive
    // (non-restore) creates are latency-visible one-at-a-time human actions
    // and BYPASS the gate entirely for an instant create; the restart-storm
    // the gate exists for is restore fleets, and exactly those creates are
    // gated. Zero-permit gate: any create that actually consults the gate
    // can never proceed — the wiring proof in both directions (an inert
    // gate would let the restore create through; an over-broad gate would
    // block the plain create). Since graceful restore/resume S1 the restore
    // direction is proven by queue+cancel — the restore gate wait is
    // acquire_unbounded (cancel-aware, no wall-clock death), so gate
    // Timeout is unreachable on this path and the parked create is
    // observably queued, then cancelled on disconnect without spawning.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Non-restore create BYPASSES the zero-permit gate and succeeds.
    send_text(&mut client, &create_frame("plain", false)).await;
    let reply = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(reply["requestId"], "plain");

    // Restore create consults the gate: it parks on the 0-permit queue —
    // the wiring proof in the restore direction.
    send_text(&mut client, &create_frame("restore-1", true)).await;
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        1,
        "the restore create must consult (and park on) the gate"
    );

    // Disconnect: the parked restore create is cancelled without spawning.
    drop(client);
    for _ in 0..200 {
        if gate.cancellations() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        gate.cancellations(),
        1,
        "disconnect must cancel the parked restore create"
    );

    assert_eq!(
        registry.kill_all(),
        1,
        "only the bypassing non-restore create spawned"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_creates_queue_behind_held_permit_and_both_settle() {
    // Deterministic rework of the former settled-hold race: the TEST holds
    // the gate's single permit while both restore creates arrive, so "the
    // second create had to queue" is structural instead of a race against
    // the first create's few-ms spawn-to-settled window (see the Nagle
    // comment in connect_and_hello). All original assertions preserved:
    // both settle with their own requestId, the gate queued (now == 2,
    // strictly stronger than the old >= 1), and exactly two PTYs exist.
    // The "permit held until settled, not just spawn" ordering is pinned
    // deterministically by create_gate's unit test
    // permit_released_only_after_work_completes.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(1, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Hold the only permit so both creates MUST queue.
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let permit = gate
        .acquire(std::time::Duration::from_secs(5), &mut cancel_rx)
        .await
        .expect("test acquires the gate's only permit");

    send_text(&mut client, &create_frame("r1", true)).await;
    send_text(&mut client, &create_frame("r2", true)).await;

    // Bounded poll (suite idiom, cf. the disconnect test): both creates
    // observably queued behind the held permit.
    for _ in 0..400 {
        if gate.queued_total() >= 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        2,
        "with the only permit held by the test, both restore creates must queue"
    );

    // Release: with 1 permit the creates now run strictly one at a time.
    drop(permit);

    let first = next_json_of_type(&mut client, "terminal.created").await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    let mut ids: Vec<String> = vec![
        first["requestId"].as_str().expect("id").to_string(),
        second["requestId"].as_str().expect("id").to_string(),
    ];
    ids.sort();
    assert_eq!(ids, vec!["r1".to_string(), "r2".to_string()]);

    // Permit-leak check: once both creates settled, the permit must be
    // re-acquirable (released at settle, not retained).
    let reacquired = gate
        .acquire(std::time::Duration::from_secs(5), &mut cancel_rx)
        .await;
    assert!(
        reacquired.is_ok(),
        "gate permit must be free again once both creates settled"
    );
    drop(reacquired);

    assert_eq!(registry.kill_all(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn gated_create_racing_shutdown_leaves_no_live_pty() {
    // A10 (V3, FALSIFIED): main's registry.kill_all() snapshots the id set
    // ONCE (registry.rs:889-892) with no re-sweep; a detached gated create
    // survives the axum drain and its registry insert can land AFTER the
    // snapshot. The registry-Drop fallback does NOT hold (the PTY reader
    // thread's exit hook owns a registry Arc — terminal.rs:1047,
    // pty.rs:464/512 — circular), and the 5s watchdog exits via
    // std::process::exit(1), skipping Drops. So the gated path itself must
    // re-check the shutdown latch around handle_create.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, shutdown_started) =
        spawn_server(cfg, SpawnGate::new(1, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Shutdown has begun (exactly what main.rs latches before the WS
    // notify — Task 7 Step 2b) while the restore create is about to run:
    shutdown_started.store(true, std::sync::atomic::Ordering::SeqCst);
    send_text(&mut client, &create_frame("late", true)).await;

    // Give the gated task time to (wrongly) spawn and settle.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        registry.kill_all(),
        0,
        "a create racing shutdown must not leave a live PTY"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_create_is_abandoned_on_disconnect_without_spawning() {
    // Zero-permit gate + long timeout: the restore create parks in the queue.
    let cfg = CreateProtectConfig {
        spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("doomed", true)).await;

    // Wait until the create is actually queued on the gate.
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "restore create must be queued");

    // Client disconnects while queued.
    drop(client);

    // The queued create must unblock as Cancelled — not sit out its 30s
    // timeout, and not spawn.
    for _ in 0..200 {
        if gate.cancellations() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        gate.cancellations(),
        1,
        "disconnect must cancel the queued create"
    );
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_creates_drain_without_spawning_on_shutdown() {
    let cfg = CreateProtectConfig {
        spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("draining-1", true)).await;
    send_text(&mut client, &create_frame("draining-2", true)).await;

    for _ in 0..200 {
        if gate.queued_total() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        gate.queued_total(),
        2,
        "both restore creates must be queued"
    );

    // Server-side graceful shutdown: every connection loop closes 4009,
    // which must drain the queued creates without spawning.
    shutdown.notify_waiters();

    // The client observes the 4009 close frame.
    let close = next_close_frame(&mut client).await;
    assert_eq!(close.code, 4009_u16.into());

    for _ in 0..200 {
        if gate.cancellations() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(gate.cancellations(), 2, "shutdown must drain the queue");
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_storm_drains_bounded_with_per_terminal_ordering() {
    // N restore creates > gate limit: every create must settle with its own
    // requestId, exactly once, with no duplicate PTYs; and no terminal may
    // emit output before the client attaches (the A21 causal invariant —
    // create never auto-attaches, registry.rs:548).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(2, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    const N: usize = 12; // > gate limit 2: forces real FIFO queueing
    for i in 0..N {
        send_text(&mut client, &create_frame(&format!("storm-{i}"), true)).await;
    }

    // Drain N terminal.created frames. While draining, FAIL on any
    // terminal.output / terminal.outputBatch frame — nothing is attached
    // yet, so output before attach would break the A21 invariant. (Use a
    // next_json_of_type variant that panics on output-family frames.)
    let mut seen = std::collections::HashMap::<String, String>::new();
    for _ in 0..N {
        let created = next_json_of_type_failing_on_output(&mut client, "terminal.created").await;
        let req = created["requestId"]
            .as_str()
            .expect("requestId")
            .to_string();
        let tid = created["terminalId"]
            .as_str()
            .expect("terminalId")
            .to_string();
        assert!(
            seen.insert(req, tid).is_none(),
            "duplicate terminal.created for one requestId"
        );
    }
    assert_eq!(seen.len(), N, "every requestId settled exactly once");
    assert!(
        seen.keys().all(|k| k.starts_with("storm-")),
        "only the storm requestIds replied"
    );
    assert!(
        gate.queued_total() >= (N as u64) - 2,
        "with 2 permits the storm must actually queue FIFO behind the gate"
    );

    // Per-terminal created -> attach -> output: attach ONE storm terminal
    // (the session_identity_frames.rs attach frame shape) and assert
    // terminal.attach.ready arrives for that terminalId — output for it may
    // only follow now.
    let attach_tid = seen
        .get("storm-0")
        .expect("storm-0 settled with a terminalId")
        .clone();
    send_text(
        &mut client,
        &serde_json::json!({
            "type": "terminal.attach",
            "terminalId": attach_tid,
            "intent": "viewport_hydrate",
            "cols": 120,
            "rows": 30,
            "attachRequestId": "att-storm-0",
        })
        .to_string(),
    )
    .await;
    let ready = next_json_of_type(&mut client, "terminal.attach.ready").await;
    assert_eq!(
        ready["terminalId"].as_str().expect("terminalId"),
        attach_tid,
        "terminal.attach.ready must arrive for the attached storm terminal"
    );

    assert_eq!(registry.kill_all(), N, "exactly N PTYs, no duplicates");
}

#[tokio::test(flavor = "multi_thread")]
async fn same_requestid_resend_returns_existing_terminal() {
    // A20: the frozen client re-sends terminal.create with the SAME
    // requestId on reconnect (TerminalView.tsx:4227-4262; ws-client.ts
    // inFlightCreates). The server must answer with the EXISTING terminal,
    // not spawn a duplicate.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("dup", true)).await;
    let first = next_json_of_type(&mut client, "terminal.created").await;
    let tid = first["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();

    send_text(&mut client, &create_frame("dup", true)).await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(second["requestId"], "dup");
    assert_eq!(
        second["terminalId"],
        tid.as_str(),
        "same-requestId resend must return the EXISTING terminal"
    );
    assert_eq!(registry.kill_all(), 1, "exactly one PTY for one requestId");
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_while_queued_does_not_double_spawn() {
    // Zero-permit gate + long timeout: the first create parks in the gate
    // queue; a duplicate arriving meanwhile must be swallowed by the
    // InFlight sentinel (the queued original will answer), never enqueued
    // as a second spawn.
    let cfg = CreateProtectConfig {
        spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(0, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    send_text(&mut client, &create_frame("dup-q", true)).await;
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "first create must be queued");

    send_text(&mut client, &create_frame("dup-q", true)).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        gate.queued_total(),
        1,
        "duplicate must not enqueue a second gated create"
    );
    assert_eq!(registry.kill_all(), 0, "no PTY spawned for either copy");
}

#[tokio::test(flavor = "multi_thread")]
async fn rate_limited_retry_same_requestid_proceeds() {
    // A2 hard requirement: a rate-limited create must NOT leave an InFlight
    // sentinel behind. The dedupe `begin` runs at the TOP of the dispatch
    // arm — BEFORE the rate limiter — so the RATE_LIMITED early return must
    // clear the sentinel; otherwise the frozen client's 2s retry with the
    // SAME requestId (TerminalView.tsx:155-157, :3995-3999) is swallowed as
    // DuplicateInFlight forever and the pane wedges.
    let cfg = CreateProtectConfig {
        rate_limit: 1,
        rate_window_ms: 300,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    // First non-restore create consumes the whole 1-token budget.
    send_text(&mut client, &create_frame("rl-1", false)).await;
    let _ = next_json_of_type(&mut client, "terminal.created").await;

    // Second non-restore create is rate-limited.
    send_text(&mut client, &create_frame("rl-2", false)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
    assert_eq!(err["requestId"], "rl-2");

    // Client-style retry: SAME requestId after the window slides.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    send_text(&mut client, &create_frame("rl-2", false)).await;
    let retried = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(
        retried["requestId"], "rl-2",
        "same-requestId retry after RATE_LIMITED must proceed as a fresh create"
    );
    assert_eq!(registry.kill_all(), 2, "rl-1 plus the retried rl-2");
}

#[tokio::test(flavor = "multi_thread")]
async fn resend_on_new_connection_returns_same_terminal() {
    // The A20 reconnect shape end-to-end: the frozen client re-sends an
    // unanswered create with the SAME requestId on a NEW connection
    // (ws-client.ts inFlightCreates resend). The resend must be answered
    // WHICHEVER window it lands in: Settled -> stored-frame replay;
    // InFlight -> waiter registration, forwarded on settle. Either way the
    // new connection receives terminal.created for the SAME terminal and
    // exactly one PTY exists.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(1, 64)).await;
    let mut client1 = connect_and_hello(&ws_url).await;
    let mut client2 = connect_and_hello(&ws_url).await;
    send_text(&mut client1, &create_frame("xconn", true)).await;
    // Deliberately do NOT await client1's reply first: let the resend race
    // into the in-flight window when the scheduler allows.
    send_text(&mut client2, &create_frame("xconn", true)).await;

    let first = next_json_of_type(&mut client1, "terminal.created").await;
    let second = next_json_of_type(&mut client2, "terminal.created").await;
    assert_eq!(second["requestId"], "xconn");
    assert_eq!(
        second["terminalId"], first["terminalId"],
        "a cross-connection resend must be answered with the SAME terminal"
    );
    assert_eq!(registry.kill_all(), 1, "exactly one PTY for one requestId");
}

#[tokio::test(flavor = "multi_thread")]
async fn resend_on_new_connection_never_swallowed_while_inflight() {
    // The A2 wedge guard: a duplicate landing while the original is in
    // flight must NEVER be silently dropped -- the original's reply goes to
    // the ORIGINAL connection's sink (dead after a real reconnect), so the
    // waiter path is the resend's ONLY reply path. A zero-permit gate parks
    // the original InFlight deterministically; its non-settled exit trigger
    // is now DISCONNECT-CANCEL (since graceful restore/resume S1 the
    // restore gate wait is acquire_unbounded, so gate timeout can no longer
    // trigger it), and clear_if_in_flight must fail the cross-connection
    // waiter LOUD (which re-drives the frozen client's retry ladder).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, SpawnGate::new(0, 64)).await;
    let mut client1 = connect_and_hello(&ws_url).await;
    let mut client2 = connect_and_hello(&ws_url).await;
    send_text(&mut client1, &create_frame("xq", true)).await;
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "original must be queued");

    send_text(&mut client2, &create_frame("xq", true)).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(
        gate.queued_total(),
        1,
        "a cross-connection duplicate registers as a waiter, never enqueues"
    );

    // Disconnect the ORIGINAL connection: its create exits non-settled via
    // disconnect-cancel, and clear_if_in_flight must fail the waiter loud
    // on the second socket.
    drop(client1);

    let err2 = next_json_of_type(&mut client2, "error").await;
    assert_eq!(err2["code"], "PTY_SPAWN_FAILED");
    assert_eq!(
        err2["requestId"], "xq",
        "the waiter must receive a fail-loud reply -- silence wedges the pane"
    );
    assert_eq!(registry.kill_all(), 0);
}

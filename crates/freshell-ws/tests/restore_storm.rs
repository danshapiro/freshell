//! Graceful restore/resume S1 — the mandate's integration pins (spec §8):
//! a restore storm of 8 codex + 4 shell creates in one burst produces ZERO
//! user-facing error frames, all 12 panes, shells settling before the codex
//! backlog drains (proof that planning is off-permit), and plan concurrency
//! never exceeding the budget of 2. Plus: deterministic plan failure stays
//! loud for THAT create only; disconnect/shutdown/queue-full paths discard
//! prepared sidecars (fake runtime records spawn/teardown pairs).
//!
//! REAL axum server + REAL tokio-tungstenite client (the
//! restore_spawn_gate.rs harness convention), with the codex launch manager
//! globally installed over a fake runtime (set-once per process).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
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
/// `restore_spawn_gate.rs`, EXCEPT the script path is unique PER CALL (a
/// process-wide counter beside the pid): rewriting a shared `{name}-{pid}`
/// script while an earlier PTY may still be executing it races text-file-busy
/// (ETXTBSY) — the `1839b11e` fix.
fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec {
    static CALL: AtomicU64 = AtomicU64::new(0);
    let call = CALL.fetch_add(1, Ordering::SeqCst);
    let script_path = std::env::temp_dir().join(format!(
        "freshell-restore-storm-sleeper-{name}-{pid}-{call}.sh",
        pid = std::process::id()
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
        terminal_meta: Default::default(),
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
        cli_commands: Arc::new(vec![
            sleeper_cli_spec("amplifier"),
            sleeper_cli_spec("claude"),
            sleeper_cli_spec("codex"),
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

// ── the fake runtime layer ─────────────────────────────────────────────────

/// Loopback WS echo listener standing in for the spawned app-server — enough
/// upstream for the REAL proxy to dial and relay against. Trimmed copy of
/// `crates/freshell-codex/tests/launch_lifecycle.rs`'s FakeRuntime (the
/// recording fields are dropped: [`StormControls`] does the recording in
/// this binary, so keeping them would only trip `-D dead_code`).
struct FakeRuntime {
    ws_url: String,
}

impl FakeRuntime {
    async fn start() -> Arc<FakeRuntime> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let Ok(ws) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    let (mut sink, mut source) = ws.split();
                    while let Some(Ok(msg)) = source.next().await {
                        if let WsMessage::Text(text) = msg {
                            if sink.send(WsMessage::Text(text)).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        Arc::new(FakeRuntime { ws_url })
    }
}

impl freshell_codex::launch_lifecycle::CodexLaunchRuntime for FakeRuntime {
    fn ensure_ready(
        &self,
        _cwd: Option<String>,
    ) -> freshell_codex::BoxFuture<
        '_,
        Result<freshell_codex::launch_lifecycle::CodexRuntimeReady, String>,
    > {
        Box::pin(async move {
            Ok(freshell_codex::launch_lifecycle::CodexRuntimeReady {
                ws_url: self.ws_url.clone(),
            })
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

/// Switchable fake codex runtime shared by every test in this binary.
struct StormControls {
    plan_delay_ms: AtomicU64,
    park: AtomicBool, // park plans on `release` instead of sleeping
    release: tokio::sync::Notify,
    fail_cwd: Mutex<Option<String>>, // plans for this cwd ALWAYS fail
    in_flight: AtomicUsize,
    peak: AtomicUsize,
    plans_started: AtomicU64,
    shutdown_calls: AtomicU64,
}

impl StormControls {
    fn reset(&self) {
        self.plan_delay_ms.store(0, Ordering::SeqCst);
        self.park.store(false, Ordering::SeqCst);
        *self.fail_cwd.lock().unwrap() = None;
        self.in_flight.store(0, Ordering::SeqCst);
        self.peak.store(0, Ordering::SeqCst);
        self.plans_started.store(0, Ordering::SeqCst);
        self.shutdown_calls.store(0, Ordering::SeqCst);
    }
}

struct StormRuntime {
    c: Arc<StormControls>,
}

impl freshell_codex::launch_lifecycle::CodexLaunchRuntime for StormRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> freshell_codex::BoxFuture<
        '_,
        Result<freshell_codex::launch_lifecycle::CodexRuntimeReady, String>,
    > {
        Box::pin(async move {
            self.c.plans_started.fetch_add(1, Ordering::SeqCst);
            let fail_cwd = self.c.fail_cwd.lock().unwrap().clone();
            if let Some(fail) = fail_cwd {
                if cwd.as_deref() == Some(fail.as_str()) {
                    return Err("codex app-server unavailable (storm negative pin)".to_string());
                }
            }
            if self.c.park.load(Ordering::SeqCst) {
                // Register interest on the Notify BEFORE publishing the
                // in_flight increment: the tests poll `in_flight == N` and
                // then `notify_waiters()`, and Notify stores no permit for a
                // waiter that has not registered yet — enabling first makes
                // the park/release handshake structural, not a race against
                // the gap between fetch_add and the first poll of
                // `notified()`.
                let notified = self.c.release.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let now = self.c.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                self.c.peak.fetch_max(now, Ordering::SeqCst);
                notified.await;
            } else {
                let now = self.c.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                self.c.peak.fetch_max(now, Ordering::SeqCst);
                let delay = self.c.plan_delay_ms.load(Ordering::SeqCst);
                if delay > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
            self.c.in_flight.fetch_sub(1, Ordering::SeqCst);
            // Real loopback upstream so the planned proxy relays against a
            // live socket: delegate to the FakeRuntime echo listener above.
            let inner = FakeRuntime::start().await;
            freshell_codex::launch_lifecycle::CodexLaunchRuntime::ensure_ready(&*inner, cwd).await
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        // Recording no-op (the FakeRuntime convention); nothing in this
        // binary asserts on ownership updates.
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> freshell_codex::BoxFuture<'_, Result<(), String>> {
        self.c.shutdown_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

/// Install the manager once per process; return the shared controls.
fn storm_controls() -> &'static Arc<StormControls> {
    static CONTROLS: OnceLock<Arc<StormControls>> = OnceLock::new();
    CONTROLS.get_or_init(|| {
        let controls = Arc::new(StormControls {
            plan_delay_ms: AtomicU64::new(0),
            park: AtomicBool::new(false),
            release: tokio::sync::Notify::new(),
            fail_cwd: Mutex::new(None),
            in_flight: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            plans_started: AtomicU64::new(0),
            shutdown_calls: AtomicU64::new(0),
        });
        let factory_controls = controls.clone();
        let manager =
            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
                Box::new(move || {
                    Arc::new(StormRuntime {
                        c: factory_controls.clone(),
                    })
                        as Arc<dyn freshell_codex::launch_lifecycle::CodexLaunchRuntime>
                }),
                2,
                std::time::Duration::from_secs(30),
                64,
            );
        assert!(
            freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(manager),
            "storm binary must be the first global() toucher in this process"
        );
        controls
    })
}

fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// One tokio runtime for the WHOLE binary, never dropped: the manager's
/// lazily-armed teardown worker (see ground rules) must outlive every test
/// fn, so every test is `#[test] fn .. { storm_rt().block_on(async { .. }); }`
/// instead of `#[tokio::test]`.
fn storm_rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("storm runtime")
    })
}

/// Ground-rule drain: block until the manager's async teardowns of ADOPTED
/// codex terminals have all executed, so no late `shutdown_calls` increment
/// can bleed past TEST_LOCK into the next test's exact-count asserts.
/// Deterministic (see ground rules): `kill_all()` joins each PTY reader
/// thread, whose exit hook queues the teardown — every send is already on
/// the worker channel when this poll starts; it only waits for execution.
/// Call after the final `kill_all()` in every test that adopted codex
/// terminals (`expected_total` = adopted count; counters reset at start).
async fn drain_adopted_teardowns(c: &StormControls, expected_total: u64) {
    for _ in 0..400 {
        if c.shutdown_calls.load(Ordering::SeqCst) >= expected_total {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        c.shutdown_calls.load(Ordering::SeqCst),
        expected_total,
        "all adopted-terminal teardowns must drain before releasing TEST_LOCK"
    );
}

/// `terminal.create` frames. Codex restores carry identity in sessionRef
/// (the frozen client's shape — codex_session_ref_resume.rs precedent).
/// `shell` is a REQUIRED TerminalCreate field (no serde default), so every
/// create frame carries `"shell":"system"` exactly as that precedent does.
fn codex_restore_frame(request_id: &str, session_id: &str, cwd: Option<&str>) -> String {
    let mut v = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": session_id },
    });
    if let Some(cwd) = cwd {
        v["cwd"] = serde_json::json!(cwd);
    }
    v.to_string()
}

fn shell_restore_frame(request_id: &str) -> String {
    format!(
        r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system","restore":true}}"#
    )
}

/// Drain frames until `expected` terminal.created arrive or `deadline`
/// passes. PANICS on any `error` frame (the mandate) and on any
/// output-family frame before attach (A21). Returns (requestId, terminalId)
/// in ARRIVAL ORDER — the fairness assertion's substrate.
async fn drain_created(
    ws: &mut TestWs,
    expected: usize,
    deadline: std::time::Duration,
) -> Vec<(String, String)> {
    let start = tokio::time::Instant::now();
    let mut created: Vec<(String, String)> = Vec::new();
    while created.len() < expected {
        let remaining = deadline
            .checked_sub(start.elapsed())
            .unwrap_or_else(|| panic!("deadline: only {}/{expected} settled", created.len()));
        let msg = tokio::time::timeout(remaining, futures_util::StreamExt::next(ws))
            .await
            .unwrap_or_else(|_| panic!("deadline: only {}/{expected} settled", created.len()))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let v: serde_json::Value = serde_json::from_str(text).expect("json frame");
            let t = v["type"].as_str().unwrap_or("");
            assert!(
                t != "error",
                "user-facing error frame during the storm (mandate violation): {v}"
            );
            assert!(
                t != "terminal.output" && t != "terminal.outputBatch",
                "output before attach breaks the A21 causal invariant: {v}"
            );
            if t == "terminal.created" {
                created.push((
                    v["requestId"].as_str().expect("requestId").to_string(),
                    v["terminalId"].as_str().expect("terminalId").to_string(),
                ));
            }
        }
    }
    created
}

// ── the five pins ──────────────────────────────────────────────────────────

/// THE mandate pin (spec §8), DETERMINISTIC park/release form (V5 §A10):
/// one burst of 8 codex + 4 shell restore creates -> zero error frames,
/// all 12 settle, and while every codex plan is PARKED the 4 shells all
/// settle — fairness is STRUCTURAL (codex parked => shells cannot starve),
/// not a wall-clock bet. The previous 500ms plan_delay shape eroded
/// one-sidedly under CI load: the fake plan sleep is load-INVARIANT while
/// PTY spawn is load-SENSITIVE, so only the shell side of the race
/// stretches. Plan concurrency <= 2 throughout.
#[test]
fn restore_storm_settles_all_twelve_with_zero_error_frames_and_no_shell_starvation() {
    storm_rt().block_on(async {
        let _serial = test_lock().lock().await;
        let c = storm_controls();
        c.reset();
        c.park.store(true, Ordering::SeqCst); // NO plan_delay: plans park on `release`
        let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
            spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
        let mut client = connect_and_hello(&ws_url).await;

        // Codex burst FIRST (worst case for shells), then shells — one burst.
        for i in 0..8 {
            let sid = uuid::Uuid::new_v4().to_string();
            send_text(
                &mut client,
                &codex_restore_frame(&format!("codex-{i}"), &sid, None),
            )
            .await;
        }
        for i in 0..4 {
            send_text(&mut client, &shell_restore_frame(&format!("shell-{i}"))).await;
        }

        // Drain EXACTLY 4 terminal.created while all codex plans are parked:
        // they must all be shells (zero error frames enforced by drain_created).
        let created = drain_created(&mut client, 4, std::time::Duration::from_secs(30)).await;
        assert!(
            created.iter().all(|(rid, _)| rid.starts_with("shell-")),
            "only shells can settle while codex plans are parked: {created:?}"
        );

        // Structural queue state while parked: 2 plans hold the budget, 6 queued.
        let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
        for _ in 0..400 {
            if c.plans_started.load(Ordering::SeqCst) == 2 && manager.plan_queue_depth() == 6 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // NOTE: plans_started is CUMULATIVE (fetch_add, reset only in reset());
        // at this instant it equals the 2 currently parked plans, but never
        // use it as an "in flight" gauge — that is what in_flight is for.
        assert_eq!(
            c.plans_started.load(Ordering::SeqCst),
            2,
            "exactly 2 plans started (both parked on the budget)"
        );
        assert_eq!(
            manager.plan_queue_depth(),
            6,
            "6 plans queued behind the budget"
        );

        // Wave-structured release (deterministic): notify_waiters releases only
        // the CURRENTLY parked ensure_ready bodies (Notify stores no permit for
        // future waiters), so 8 codex plans on a 2-permit budget drain in 4
        // waves of exactly 2. Per wave: poll until BOTH permits are held by
        // parked plans, release them, drain exactly their 2 created frames
        // (drain_created panics on any error frame — the zero-error mandate —
        // and on deadline, so a wedged wave fails loud, never hangs).
        let mut settled = created;
        for wave in 1..=4u32 {
            for _ in 0..400 {
                if c.in_flight.load(Ordering::SeqCst) == 2 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            assert_eq!(
                c.in_flight.load(Ordering::SeqCst),
                2,
                "wave {wave}: both budget permits must be held by parked plans"
            );
            c.release.notify_waiters();
            settled.extend(drain_created(&mut client, 2, std::time::Duration::from_secs(30)).await);
        }
        assert_eq!(settled.len(), 12, "all 12 panes must be created");
        let peak = c.peak.load(Ordering::SeqCst);
        assert!(peak <= 2, "plan concurrency exceeded the budget: {peak}");
        assert_eq!(registry.kill_all(), 12, "exactly 12 PTYs, no duplicates");
        drain_adopted_teardowns(c, 8).await; // 8 adopted codex sidecars — ground-rule drain
    });
}

/// Negative pin (spec §8, adapted to S1's zero-protocol scope — the
/// errorClass discriminator is Slice 2): a deterministic per-create plan
/// failure is loud for THAT create only; the other 11 are unaffected.
#[test]
fn deterministic_plan_failure_is_loud_for_that_create_only() {
    storm_rt().block_on(async {
        let _serial = test_lock().lock().await;
        let c = storm_controls();
        c.reset();
        c.plan_delay_ms.store(100, Ordering::SeqCst);
        let doomed_cwd = std::env::temp_dir().join("freshell-storm-doomed");
        std::fs::create_dir_all(&doomed_cwd).expect("mk doomed cwd");
        let doomed_cwd = doomed_cwd.to_string_lossy().to_string();
        *c.fail_cwd.lock().unwrap() = Some(doomed_cwd.clone());

        let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
            spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
        let mut client = connect_and_hello(&ws_url).await;
        for i in 0..8 {
            let sid = uuid::Uuid::new_v4().to_string();
            let cwd = (i == 2).then_some(doomed_cwd.as_str());
            send_text(
                &mut client,
                &codex_restore_frame(&format!("codex-{i}"), &sid, cwd),
            )
            .await;
        }
        for i in 0..4 {
            send_text(&mut client, &shell_restore_frame(&format!("shell-{i}"))).await;
        }
        // Custom drain: 11 created + EXACTLY the one expected error frame.
        let mut created = 0usize;
        let mut errors: Vec<serde_json::Value> = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
        while created < 11 || errors.is_empty() {
            let remaining = deadline
                .checked_duration_since(tokio::time::Instant::now())
                .unwrap_or_else(|| panic!("deadline: created={created} errors={errors:?}"));
            let msg = tokio::time::timeout(remaining, futures_util::StreamExt::next(&mut client))
                .await
                .unwrap_or_else(|_| panic!("deadline: created={created} errors={errors:?}"))
                .expect("stream not ended")
                .expect("no ws error");
            if let WsMessage::Text(text) = &msg {
                let v: serde_json::Value = serde_json::from_str(text).expect("json frame");
                match v["type"].as_str().unwrap_or("") {
                    "terminal.created" => created += 1,
                    "error" => errors.push(v),
                    _ => {}
                }
            }
        }
        assert_eq!(errors.len(), 1, "exactly one loud error: {errors:?}");
        assert_eq!(errors[0]["requestId"], serde_json::json!("codex-2"));
        assert_eq!(
            errors[0]["code"],
            serde_json::json!("PTY_SPAWN_FAILED"),
            "unanticipatable plan failure keeps today's loud code: {}",
            errors[0]
        );
        assert_eq!(registry.kill_all(), 11, "the doomed create must not spawn");
        // 7 adopted codex sidecars tear down asynchronously after kill_all.
        // PLUS: the planner's cleanup-on-plan-failure (`plan_create`'s Err
        // arm, launch_lifecycle.rs) runs `sidecar.shutdown()` — and thus
        // `runtime.shutdown()` — once per failed attempt, and the doomed
        // create burns the full initial retry budget; those cleanups were
        // awaited inline BEFORE the error frame we already received, so the
        // total is exact and deterministic.
        let doomed_cleanups = u64::from(freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS);
        drain_adopted_teardowns(c, 7 + doomed_cleanups).await;
        *c.fail_cwd.lock().unwrap() = None;
    });
}

/// T11 extension + discard arms (1)/(3): disconnect mid-storm drains the
/// plan queue with no PTY spawns and no further plans; the two in-flight
/// plans complete and are DISCARDED (fake runtime records the teardowns).
#[test]
fn disconnect_mid_storm_drains_queue_without_spawns_and_discards_prepared_launches() {
    storm_rt().block_on(async {
        let _serial = test_lock().lock().await;
        let c = storm_controls();
        c.reset();
        c.park.store(true, Ordering::SeqCst);
        let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
            spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
        let mut client = connect_and_hello(&ws_url).await;
        for i in 0..8 {
            let sid = uuid::Uuid::new_v4().to_string();
            send_text(
                &mut client,
                &codex_restore_frame(&format!("codex-{i}"), &sid, None),
            )
            .await;
        }
        // Wait until 2 plans hold the budget and 6 queue behind it.
        let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
        for _ in 0..400 {
            if c.plans_started.load(Ordering::SeqCst) == 2 && manager.plan_queue_depth() == 6 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.plans_started.load(Ordering::SeqCst),
            2,
            "2 plans in flight"
        );
        assert_eq!(manager.plan_queue_depth(), 6, "6 plans queued");

        drop(client); // disconnect: cancel watch fires for all 8 tasks

        // Queued waiters drain as Cancelled (no plan ever starts for them)...
        for _ in 0..400 {
            if manager.plan_queue_depth() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            manager.plan_queue_depth(),
            0,
            "plan queue must drain on disconnect"
        );
        // ...then release the 2 parked plans: their creates are cancelled, so
        // the prepared launches must be DISCARDED (arm 1/3), never spawned.
        // in_flight == 2 also proves both parked bodies REGISTERED on the
        // Notify (registration is ordered before the in_flight increment in
        // StormRuntime), so notify_waiters below wakes exactly both.
        for _ in 0..400 {
            if c.in_flight.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.in_flight.load(Ordering::SeqCst),
            2,
            "both budget permits held by parked plans"
        );
        c.release.notify_waiters();
        for _ in 0..400 {
            if c.shutdown_calls.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.shutdown_calls.load(Ordering::SeqCst),
            2,
            "both completed-but-cancelled plans must be torn down"
        );
        assert_eq!(
            c.plans_started.load(Ordering::SeqCst),
            2,
            "no further plans after disconnect"
        );
        assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
    });
}

/// Discard arm (2): a prepared launch whose gate acquire rejects QueueFull
/// gets RATE_LIMITED (ladder absorbs) and the sidecar is torn down.
#[test]
fn gate_queue_full_after_prepare_sends_rate_limited_and_discards_the_sidecar() {
    storm_rt().block_on(async {
        let _serial = test_lock().lock().await;
        let c = storm_controls();
        c.reset();
        // 0 permits + 0 queue cap: the FIRST gated waiter rejects QueueFull.
        let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
            spawn_server(CreateProtectConfig::default(), SpawnGate::new(0, 0)).await;
        let mut client = connect_and_hello(&ws_url).await;
        let sid = uuid::Uuid::new_v4().to_string();
        send_text(&mut client, &codex_restore_frame("qf-0", &sid, None)).await;
        // Expect exactly one RATE_LIMITED error frame for qf-0.
        let err = next_json_of_type(&mut client, "error").await;
        assert_eq!(err["requestId"], serde_json::json!("qf-0"));
        assert_eq!(err["code"], serde_json::json!("RATE_LIMITED"));
        for _ in 0..400 {
            if c.shutdown_calls.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.shutdown_calls.load(Ordering::SeqCst),
            1,
            "prepared sidecar discarded"
        );
        assert_eq!(registry.kill_all(), 0, "no PTY spawned");
    });
}

/// Discard arm (4): shutdown beginning between prepare and spawn abandons
/// the create silently and discards the prepared sidecar.
#[test]
fn shutdown_after_prepare_abandons_silently_and_discards_the_sidecar() {
    storm_rt().block_on(async {
        let _serial = test_lock().lock().await;
        let c = storm_controls();
        c.reset();
        c.park.store(true, Ordering::SeqCst);
        let (ws_url, registry, _shutdown, _gate, shutdown_started) =
            spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
        let mut client = connect_and_hello(&ws_url).await;
        let sid = uuid::Uuid::new_v4().to_string();
        send_text(&mut client, &codex_restore_frame("sd-0", &sid, None)).await;
        // in_flight == 1 (not just plans_started) proves the parked body
        // REGISTERED on the Notify before we release it (see StormRuntime).
        for _ in 0..400 {
            if c.in_flight.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(c.plans_started.load(Ordering::SeqCst), 1, "plan in flight");
        assert_eq!(c.in_flight.load(Ordering::SeqCst), 1, "plan parked");
        shutdown_started.store(true, Ordering::SeqCst); // A10 pre-check trips next
        c.release.notify_waiters();
        for _ in 0..400 {
            if c.shutdown_calls.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.shutdown_calls.load(Ordering::SeqCst),
            1,
            "prepared sidecar discarded"
        );
        assert_eq!(registry.kill_all(), 0, "no PTY spawned during shutdown");
        // Silent: drain the socket briefly and assert no error frame arrived.
        let quiet = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            futures_util::StreamExt::next(&mut client),
        )
        .await;
        if let Ok(Some(Ok(WsMessage::Text(text)))) = quiet {
            let v: serde_json::Value = serde_json::from_str(&text).expect("json");
            assert_ne!(
                v["type"],
                serde_json::json!("error"),
                "shutdown abandon must be silent: {v}"
            );
        }
    });
}

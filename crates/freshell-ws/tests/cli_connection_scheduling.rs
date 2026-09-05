//! Real WebSocket regression: a parked ordinary create cannot hold up input,
//! attach, or app-level ping on the same connection. Uses the real router and
//! dispatch functions, headless existing terminals, and an injected disk probe.
//! No provider binary is executed. Runs as an ordinary `cargo test` target —
//! a one-test binary, so its process-wide HOME/FRESHELL_HOME isolation below
//! cannot leak into other tests; the repo sandbox is an optional wrapper.
#![cfg(unix)]
mod common;

use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};
use freshell_ws::WsState;
use futures_util::SinkExt;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

const SID: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Default)]
struct ParkedProbe {
    entered: Notify,
    calls: AtomicUsize,
    released: Mutex<bool>,
    changed: Condvar,
}
impl ParkedProbe {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}
impl SessionExistenceProbe for ParkedProbe {
    fn exists(&self, _: &str, _: &str) -> SessionExistence {
        SessionExistence::Present
    }
    fn ever_observed(&self, _: &str, _: &str) -> bool {
        true
    }
    fn exists_for_gate(&self, _: &str, id: &str) -> SessionExistence {
        if id == SID {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            let mut released = self.released.lock().unwrap();
            while !*released {
                released = self.changed.wait(released).unwrap();
            }
        }
        SessionExistence::Present
    }
}
struct ReleaseProbe(Arc<ParkedProbe>);
impl Drop for ReleaseProbe {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct ServerGuard {
    task: tokio::task::JoinHandle<()>,
    shutdown: Arc<Notify>,
    shutdown_started: Arc<AtomicBool>,
}
impl Drop for ServerGuard {
    fn drop(&mut self) {
        self.shutdown_started.store(true, Ordering::SeqCst);
        self.shutdown.notify_waiters();
        self.task.abort();
    }
}

// Same fixture fields as tests/common/mod.rs at the pinned base, with an
// explicit injected existence probe. Keep this test independent of real homes.
fn state(probe: Arc<ParkedProbe>, missing_program: &std::path::Path) -> WsState {
    let auth_token = Arc::new(common::AUTH_TOKEN.to_string());
    let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(64).0);
    let registry = freshell_terminal::TerminalRegistry::new();
    let cli = freshell_platform::CliCommandSpec {
        name: "claude".into(),
        label: "test claude".into(),
        env_var: None,
        default_cmd: missing_program.to_string_lossy().into_owned(),
        base_args: vec![],
        base_env: Default::default(),
        resume_args: Some(vec!["--resume".into(), "{{sessionId}}".into()]),
        create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()]),
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    };
    WsState {
        layout: Default::default(),
        terminal_meta: Default::default(),
        pane_ledger: Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        auth_token: Arc::clone(&auth_token),
        server_instance_id: Arc::new("srv-scheduling-test".into()),
        boot_id: Arc::new("boot-scheduling-test".into()),
        settings: Arc::new(serde_json::from_value(common::test_settings_value()).unwrap()),
        handshake_settings: common::handshake_settings_lock(),
        broadcast_tx: Arc::clone(&broadcast_tx),
        auto_resume_tx: mpsc::unbounded_channel().0,
        auto_resume_cancels: Default::default(),
        fresh_codex: freshell_freshagent::FreshCodexState::new(
            Arc::clone(&auth_token),
            Arc::clone(&broadcast_tx),
            json!({"freshAgent":{"enabled":false}}),
        ),
        fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
        fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
            freshell_freshagent::FreshAgentState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
            ),
        ),
        registry,
        tabs: freshell_ws::tabs::TabsRegistry::new(),
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(Arc::clone(&broadcast_tx)),
        subagent_interest: Default::default(),
        host_stats: Default::default(),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        cli_commands: Arc::new(vec![cli]),
        shutdown: Arc::new(Notify::new()),
        ping_interval_ms: 30_000,
        hello_timeout_ms: 5_000,
        allowed_origins: Arc::new(freshell_ws::origin::default_allowed_origins()),
        ws_max_payload_bytes: 16 * 1024 * 1024,
        term09: freshell_ws::backpressure::Term09Config::default(),
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
        shutdown_started: Arc::new(AtomicBool::new(false)),
        create_dedupe: Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),
        config_fallback: None,
        opencode_locator: None,
        codex_locator: None,
        activity: None,
        session_existence: probe,
        reconcile_deferral_budget_ms: freshell_ws::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
        fresh_agent_respawn_counts: Default::default(),
    }
}

#[tokio::test]
async fn ordinary_create_does_not_block_same_connection_input_attach_or_ping() {
    let home = tempfile::tempdir().unwrap();
    // This integration binary has ONE test. Isolate launch-side file/config
    // generation before starting any server tasks; never inspect live homes.
    std::env::set_var("HOME", home.path());
    std::env::set_var("FRESHELL_HOME", home.path());
    std::env::set_var("CLAUDE_HOME", home.path().join("claude"));
    std::env::set_var("AUTH_TOKEN", common::AUTH_TOKEN);
    let probe = Arc::new(ParkedProbe::default());
    let _release = ReleaseProbe(Arc::clone(&probe)); // releases even on RED/panic
    let state = state(Arc::clone(&probe), &home.path().join("nonexistent-cli"));
    let registry = state.registry.clone();
    for mode in ["claude", "opencode", "codex"] {
        registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
            terminal_id: format!("existing-{mode}"),
            stream_id: format!("stream-{mode}"),
            mode: mode.into(),
            ..Default::default()
        });
    }
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<(String, String)>();
    registry.set_activity_observer(Arc::new(move |event| {
        if let freshell_terminal::registry::ActivityEvent::Input {
            terminal_id, data, ..
        } = event
        {
            let _ = input_tx.send((terminal_id, data));
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let shutdown = Arc::clone(&state.shutdown);
    let shutdown_started = Arc::clone(&state.shutdown_started);
    let router = freshell_ws::router(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let _server = ServerGuard {
        task,
        shutdown,
        shutdown_started,
    };
    let (mut ws, _) = common::connect_and_capture_inventory(&format!("ws://{addr}/ws")).await;
    let create = json!({
        "type":"terminal.create", "requestId":"parked-create", "mode":"claude", "shell":"system",
        "cwd":home.path().to_string_lossy(), "sessionRef":{"provider":"claude","sessionId":SID}
    });
    ws.send(Message::Text(create.to_string())).await.unwrap();
    tokio::time::timeout(common::FRAME_BUDGET, probe.entered.notified())
        .await
        .unwrap();
    // A retry of the same intent must not enqueue another create.
    ws.send(Message::Text(create.to_string())).await.unwrap();
    for mode in ["claude", "opencode", "codex"] {
        let terminal_id = format!("existing-{mode}");
        ws.send(Message::Text(
            json!({
                "type":"terminal.input", "terminalId":terminal_id, "data":"still responsive"
            })
            .to_string(),
        ))
        .await
        .unwrap();
        let (observed_id, observed) = tokio::time::timeout(common::FRAME_BUDGET, input_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed_id, terminal_id);
        assert_eq!(observed, "still responsive");
        ws.send(Message::Text(json!({
            "type":"terminal.attach", "terminalId":terminal_id, "attachRequestId":format!("attach-{mode}"),
            "cols":80, "rows":24, "sinceSeq":0, "intent":"viewport_hydrate", "surfaceReset":true
        }).to_string())).await.unwrap();
        let attached = common::next_frame_of_type(&mut ws, "terminal.attach.ready").await;
        assert_eq!(attached["terminalId"], terminal_id);
    }
    assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    ws.send(Message::Text(json!({"type":"ping"}).to_string()))
        .await
        .unwrap();
    assert_eq!(
        common::next_frame_of_type(&mut ws, "pong").await["type"],
        "pong"
    );
    // The gate is deliberately held until all independent progress
    // assertions complete. On the old inline dispatcher they cannot complete.
    probe.release();
    let failed = common::next_frame_of_type(&mut ws, "error").await;
    assert_eq!(failed["requestId"], "parked-create");
    assert_eq!(failed["code"], "PTY_SPAWN_FAILED");
    assert_eq!(
        registry.identity_probe_rows().len(),
        3,
        "no real CLI or duplicate was spawned"
    );
    ws.close(None).await.unwrap();
}

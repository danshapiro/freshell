//! DEV-0006 S4 — lifecycle glue tests for [`freshell_codex::launch_lifecycle`]:
//! the launch planner + sidecar lifecycle (`launch-planner.ts:108-316`) that turns the
//! S3 pure decisions ([`freshell_codex::launch_plan`]) into a running app-server
//! sidecar + S2 remote proxy, and the terminal-keyed manager both terminal-create
//! paths (WS + REST) wire through.
//!
//! Real sockets throughout (loopback, ephemeral only — never 3001/3002). The planner
//! tests inject a fake runtime (a loopback WS listener standing in for the spawned
//! app-server) but always drive the REAL `CodexRemoteProxy`; the spawn integration
//! test at the bottom spawns the committed fake app-server fixture
//! (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`) via node and
//! proves the fake-TUI → proxy → app-server relay end to end.
#![cfg(feature = "real-transport")]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

use freshell_codex::launch_lifecycle::{
    CodexLaunchError, CodexLaunchPlanner, CodexLaunchRuntime, CodexRuntimeReady,
    CodexTerminalLaunchManager, SpawnedCodexAppServerRuntime,
    CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE, CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE,
};
use freshell_codex::launch_plan::{codex_remote_args, CodexLaunchPlanInput};
use freshell_codex::BoxFuture;

const RECV_TIMEOUT: Duration = Duration::from_secs(10);

// ── fake runtime: a loopback WS echo listener standing in for the app-server ──────

struct FakeRuntime {
    ws_url: String,
    ensure_ready_calls: Mutex<Vec<Option<String>>>,
    fail_ensure_ready: AtomicBool,
    shutdown_calls: AtomicU32,
    ownership_updates: Mutex<Vec<(String, u64)>>,
}

impl FakeRuntime {
    /// Bind a real loopback WS listener that accepts connections and echoes text
    /// frames back — enough upstream for the REAL proxy to dial and relay against.
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
                    let Ok(ws) = accept_async(stream).await else {
                        return;
                    };
                    let (mut sink, mut source) = ws.split();
                    while let Some(Ok(msg)) = source.next().await {
                        if let Message::Text(text) = msg {
                            if sink.send(Message::Text(text)).await.is_err() {
                                break;
                            }
                        }
                    }
                });
            }
        });
        Arc::new(FakeRuntime {
            ws_url,
            ensure_ready_calls: Mutex::new(Vec::new()),
            fail_ensure_ready: AtomicBool::new(false),
            shutdown_calls: AtomicU32::new(0),
            ownership_updates: Mutex::new(Vec::new()),
        })
    }
}

impl CodexLaunchRuntime for FakeRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            self.ensure_ready_calls.lock().unwrap().push(cwd);
            if self.fail_ensure_ready.load(Ordering::SeqCst) {
                return Err("fake runtime: ensureReady failed".to_string());
            }
            Ok(CodexRuntimeReady {
                ws_url: self.ws_url.clone(),
            })
        })
    }

    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.ownership_updates
                .lock()
                .unwrap()
                .push((terminal_id, generation));
            Ok(())
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}

fn planner_for(runtime: Arc<FakeRuntime>) -> CodexLaunchPlanner {
    CodexLaunchPlanner::new(Box::new(move || {
        runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }))
}

// ── planCreate fresh/resume knobs (launch-planner.ts:125-163) ─────────────────────

#[tokio::test]
async fn fresh_plan_starts_a_real_proxy_with_candidate_persistence_on() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some("/repo/one"),
            ..Default::default()
        })
        .await
        .unwrap();

    // Fresh: no sessionId (launch-planner.ts:158-163); the proxy URL — not the
    // runtime's — is what the TUI is pointed at (spec §1.3 step 3).
    assert_eq!(launch.session_id, None);
    assert_ne!(launch.remote_ws_url, runtime.ws_url);
    assert!(launch.remote_ws_url.starts_with("ws://127.0.0.1:"));
    // The 4-tuple gate accepts the minted URL (terminal-registry.ts:295-307).
    assert!(codex_remote_args(&launch.remote_ws_url).is_ok());
    // ensureReady got the create cwd (launch-planner.ts:153).
    assert_eq!(
        runtime.ensure_ready_calls.lock().unwrap().as_slice(),
        &[Some("/repo/one".to_string())]
    );
    // requireCandidatePersistence: legacy fresh leaves the PROXY default (true,
    // remote-proxy.ts:140) — the Rust planner passes the plan's value EXPLICITLY
    // (review note 2: no shadow default at the proxy layer).
    assert_eq!(
        launch.sidecar.require_candidate_persistence().await,
        Some(true)
    );

    launch.sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn resume_plan_sets_session_id_and_disables_candidate_persistence() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some("/repo/resume"),
            resume_session_id: Some("thread-ready"),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(launch.session_id.as_deref(), Some("thread-ready"));
    // requireCandidatePersistence=false on resume (launch-planner.ts:140).
    assert_eq!(
        launch.sidecar.require_candidate_persistence().await,
        Some(false)
    );
    launch.sidecar.shutdown().await.unwrap();
}

#[tokio::test]
async fn relay_works_through_the_planned_proxy() {
    // The plan's remote_ws_url accepts a TUI connection and relays to the upstream:
    // fake TUI → REAL proxy → fake runtime (echo) → back.
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();

    let (mut tui, _) = connect_async(&launch.remote_ws_url).await.unwrap();
    let frame = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
    tui.send(Message::Text(frame.to_string())).await.unwrap();
    let echoed = timeout(RECV_TIMEOUT, tui.next())
        .await
        .expect("timed out waiting for the relayed frame")
        .expect("proxy closed before relaying")
        .unwrap();
    assert_eq!(echoed, Message::Text(frame.to_string()));

    launch.sidecar.shutdown().await.unwrap();
}

// ── plan-failure teardown (launch-planner.ts:164-175) ─────────────────────────────

#[tokio::test]
async fn planning_error_tears_the_sidecar_down_and_surfaces_the_error() {
    let runtime = FakeRuntime::start().await;
    runtime.fail_ensure_ready.store(true, Ordering::SeqCst);
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap_err();
    match err {
        CodexLaunchError::Failed(message) => {
            assert!(message.contains("ensureReady failed"), "{message}");
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    // Cleanup-on-plan-failure: the sidecar (runtime) was shut down.
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── shutdown rejects new plans (launch-planner.ts:197-201) ────────────────────────

#[tokio::test]
async fn planner_shutdown_rejects_new_plans_with_the_legacy_message() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    planner.shutdown().await;
    let err = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap_err();
    match err {
        CodexLaunchError::Failed(message) => {
            assert_eq!(message, CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE);
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

#[tokio::test]
async fn planner_shutdown_tears_down_unadopted_sidecars() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let _launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    planner.shutdown().await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── adopt (launch-planner.ts:238-244) ─────────────────────────────────────────────

#[tokio::test]
async fn adopt_transfers_ownership_out_of_the_planner() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();

    launch.sidecar.adopt("term-1", 0).await.unwrap();
    assert_eq!(
        runtime.ownership_updates.lock().unwrap().as_slice(),
        &[("term-1".to_string(), 0)]
    );

    // An adopted sidecar is the TERMINAL's; planner.shutdown() must not tear it down
    // (adopt removes it from activeSidecars, launch-planner.ts:242-243).
    planner.shutdown().await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 0);

    launch.sidecar.shutdown().await.unwrap();
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn adopt_after_sidecar_shutdown_is_rejected_with_the_legacy_message() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    launch.sidecar.shutdown().await.unwrap();
    let err = launch.sidecar.adopt("term-1", 0).await.unwrap_err();
    assert_eq!(err, CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE);
}

#[tokio::test]
async fn sidecar_shutdown_is_idempotent() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    launch.sidecar.shutdown().await.unwrap();
    launch.sidecar.shutdown().await.unwrap();
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

// ── retry (launch-retry.ts:16-50; asymmetric budget, review note 5) ───────────────

#[tokio::test]
async fn retry_gives_up_after_the_attempt_budget_on_transient_failures() {
    let runtime = FakeRuntime::start().await;
    runtime.fail_ensure_ready.store(true, Ordering::SeqCst);
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            3,
            /* retry_delay_ms */ 1,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CodexLaunchError::Failed(_)));
    // One ensureReady per attempt: the budget is honored.
    assert_eq!(runtime.ensure_ready_calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn retry_never_retries_configuration_errors() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());
    let err = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput {
                sandbox: Some("full-yolo"),
                ..Default::default()
            },
            5,
            1,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, CodexLaunchError::Config(_)));
    // The config error fails BEFORE any runtime IO (launch-retry.ts:35).
    assert_eq!(runtime.ensure_ready_calls.lock().unwrap().len(), 0);
}

// ── the terminal-keyed manager (the shared seam both create paths wire through) ───

#[tokio::test]
async fn manager_adopts_by_terminal_id_and_tears_down_on_exit() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));

    let launch = manager
        .plan_create_with_retry(&CodexLaunchPlanInput::default(), 5)
        .await
        .unwrap();
    let remote_ws_url = launch.remote_ws_url.clone();
    manager.adopt("term-42", launch, 0).await.unwrap();
    assert_eq!(
        runtime.ownership_updates.lock().unwrap().as_slice(),
        &[("term-42".to_string(), 0)]
    );

    // The proxy stays up while the terminal lives.
    assert!(connect_async(&remote_ws_url).await.is_ok());

    // PTY exit (the sync exit hook) → async teardown of proxy + sidecar.
    manager.notify_terminal_exit("term-42");
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if runtime.shutdown_calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "sidecar was never torn down after terminal exit"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn manager_discard_tears_down_an_unadopted_plan() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    let launch = manager
        .plan_create_with_retry(&CodexLaunchPlanInput::default(), 5)
        .await
        .unwrap();
    manager.discard(launch).await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn manager_exit_for_unknown_terminal_is_a_noop() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move || {
        factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));
    manager.notify_terminal_exit("never-created");
}

// ── the spawn integration leg: real child + real proxy + fake TUI ─────────────────

fn fake_app_server_command() -> String {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    format!("node {}", fixture.display())
}

#[tokio::test]
async fn spawned_runtime_launches_the_app_server_and_relays_through_the_proxy() {
    let tmp = std::env::temp_dir().join(format!("freshell-codex-s4-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command(
        fake_app_server_command(),
    ));
    let spawn_runtime = runtime.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move || {
        spawn_runtime.clone() as Arc<dyn CodexLaunchRuntime>
    }));

    let launch = planner
        .plan_create(&CodexLaunchPlanInput {
            cwd: Some(tmp.to_str().unwrap()),
            ..Default::default()
        })
        .await
        .expect("plan_create against the spawned fake app-server");

    // The TUI argv 4-tuple accepts the minted proxy URL.
    let args = codex_remote_args(&launch.remote_ws_url).unwrap();
    assert_eq!(args[0], "--remote");
    assert_eq!(args[2], "-c");
    assert_eq!(args[3], "features.apps=false");

    // Fake TUI dials the proxy and completes an initialize round trip against the
    // real (spawned) app-server through the relay.
    let (mut tui, _) = connect_async(&launch.remote_ws_url).await.unwrap();
    tui.send(Message::Text(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}).to_string(),
    ))
    .await
    .unwrap();
    let reply = loop {
        let msg = timeout(RECV_TIMEOUT, tui.next())
            .await
            .expect("timed out waiting for the initialize reply through the proxy")
            .expect("proxy closed before replying")
            .unwrap();
        if let Message::Text(text) = msg {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            if value.get("id") == Some(&json!(1)) {
                break value;
            }
        }
    };
    assert!(reply.get("result").is_some(), "initialize failed: {reply}");

    // Teardown kills the spawned child.
    let pid = runtime.child_pid().await.expect("child pid");
    launch.sidecar.shutdown().await.unwrap();
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "spawned app-server (pid {pid}) survived sidecar shutdown"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

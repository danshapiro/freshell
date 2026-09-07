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
    CodexTerminalLaunchManager, LaunchClass, SpawnedCodexAppServerRuntime,
    CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE, CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE,
};
use freshell_codex::launch_plan::{codex_remote_args, CodexLaunchPlanInput};
use freshell_codex::{
    proc_cmdline, proc_starttime, verify_sidecar_identity, BoxFuture, CodexSidecarRecord,
    CodexSidecarStore, IdentityVerdict, ReattachedCodexAppServerRuntime, SidecarReconciler,
    SidecarRecordState, CODEX_SIDECAR_OWNERSHIP_ENV, SIDECAR_RECORD_VERSION,
};

const RECV_TIMEOUT: Duration = Duration::from_secs(10);

// ── fake runtime: a loopback WS echo listener standing in for the app-server ──────

struct FakeRuntime {
    ws_url: String,
    ensure_ready_calls: Mutex<Vec<Option<String>>>,
    fail_ensure_ready: AtomicBool,
    fail_prepare_retention: AtomicBool,
    shutdown_calls: AtomicU32,
    ownership_updates: Mutex<Vec<(String, u64)>>,
    noted_session_ids: Mutex<Vec<String>>,
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
            fail_prepare_retention: AtomicBool::new(false),
            shutdown_calls: AtomicU32::new(0),
            ownership_updates: Mutex::new(Vec::new()),
            noted_session_ids: Mutex::new(Vec::new()),
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

    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.noted_session_ids.lock().unwrap().push(session_id);
            Ok(())
        })
    }

    fn prepare_retention(&self, _reason: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            if self.fail_prepare_retention.load(Ordering::SeqCst) {
                return Err("fake runtime: prepare_retention failed".to_string());
            }
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
    CodexLaunchPlanner::new(Box::new(move |_plan| {
        let rt = runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
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

/// Task 4: resume launches know their session id at plan time, so
/// `plan_create` notes it on the runtime; fresh launches have no id yet
/// (theirs arrives via the proxy's thread candidate), so no call is made.
#[tokio::test]
async fn plan_create_notes_the_resume_session_id_on_the_runtime() {
    let runtime = FakeRuntime::start().await;
    let planner = planner_for(runtime.clone());

    let resume = planner
        .plan_create(&CodexLaunchPlanInput {
            resume_session_id: Some("s-1"),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        runtime.noted_session_ids.lock().unwrap().as_slice(),
        &["s-1".to_string()],
        "the resume plan must note its session id on the runtime"
    );
    resume.sidecar.shutdown().await.unwrap();

    let fresh = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .unwrap();
    assert_eq!(
        runtime.noted_session_ids.lock().unwrap().len(),
        1,
        "a fresh plan has no session id at plan time; no note call"
    );
    fresh.sidecar.shutdown().await.unwrap();
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
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));

    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
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
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    manager.discard(launch).await;
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 1);
}

/// discard_sync must tear the sidecar down (asynchronously) without the
/// caller awaiting — the seam Task 4's RAII guard uses from Drop.
#[tokio::test(flavor = "multi_thread")]
async fn discard_sync_tears_down_an_unadopted_plan() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move |_plan| {
            let rt = factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>;
            Box::pin(async move { rt })
        }),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    manager.discard_sync(launch);
    // Teardown is fire-and-forget: poll for the shutdown.
    for _ in 0..200 {
        if runtime
            .shutdown_calls
            .load(std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        runtime
            .shutdown_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1,
        "discard_sync must shut the sidecar down"
    );
}

/// A8 (V4): `tokio::spawn` panics with no ambient runtime, and discard_sync
/// is called from Drop — where a panic is a double-panic abort during
/// unwind. Plan on a locally-built runtime, tear the runtime down, then
/// call discard_sync from plain (non-tokio) test context: pre-hardening
/// this PANICS ("there is no reactor running"); post-hardening it must
/// degrade to best-effort kill / log-and-leak.
#[test] // deliberately NOT #[tokio::test]
fn discard_sync_outside_runtime_context_does_not_panic() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("local runtime");
    let (manager, launch) = rt.block_on(async {
        let runtime = FakeRuntime::start().await;
        let factory_runtime = runtime.clone();
        let manager = CodexTerminalLaunchManager::with_plan_budget(
            Box::new(move |_plan| {
                let rt = factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>;
                Box::pin(async move { rt })
            }),
            2,
            std::time::Duration::from_secs(30),
            64,
        );
        let launch = manager
            .plan_create_with_retry_uncancellable(
                &CodexLaunchPlanInput::default(),
                1,
                LaunchClass::Interactive,
            )
            .await
            .expect("plan");
        (manager, launch)
    });
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    // No ambient runtime here: must not panic (teardown is best-effort).
    manager.discard_sync(launch);
}

#[tokio::test]
async fn manager_shutdown_tears_down_adopted_and_unadopted_and_rejects_new_plans() {
    // main.rs graceful-shutdown wiring (inc.2): `manager.shutdown()` mirrors legacy's
    // close-time `codexLaunchPlanner.shutdown()` — the planner stops accepting plans
    // and tears down its unadopted sidecars — PLUS the adopted (terminal-owned)
    // launches the Rust manager keys, since server exit ends those terminals too.
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));

    // One adopted launch + one unadopted plan.
    let adopted = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    manager.adopt("term-live", adopted, 0).await.unwrap();
    let _unadopted = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();

    manager.shutdown().await;
    // Both sidecars (two FakeRuntime instances? no — one shared runtime, one
    // shutdown call per sidecar) torn down: 2 runtime shutdowns.
    assert_eq!(runtime.shutdown_calls.load(Ordering::SeqCst), 2);

    // New plans are rejected with the legacy planner-shutdown message.
    let err = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
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
async fn manager_exit_for_unknown_terminal_is_a_noop() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));
    manager.notify_terminal_exit("never-created");
}

// ── D-C-R sidecar planning budget (S5.e precondition) ─────────────────────────────

/// A [`FakeRuntime`]-shaped runtime whose `ensure_ready` blocks on a shared
/// [`tokio::sync::Notify`] so plans stay in flight until the test releases
/// them — the knob that keeps budget permits occupied.
struct BlockingRuntime {
    release: Arc<tokio::sync::Notify>,
}

impl CodexLaunchRuntime for BlockingRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            self.release.notified().await;
            // Released: stand up the file's real loopback echo upstream so
            // the plan completes against a real socket.
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

fn blocking_test_runtime_factory() -> (
    freshell_codex::launch_lifecycle::CodexRuntimeFactory,
    Arc<tokio::sync::Notify>,
) {
    let release = Arc::new(tokio::sync::Notify::new());
    let factory_release = release.clone();
    let factory: freshell_codex::launch_lifecycle::CodexRuntimeFactory = Box::new(move |_plan| {
        let rt = Arc::new(BlockingRuntime {
            release: factory_release.clone(),
        }) as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    });
    (factory, release)
}

#[tokio::test]
async fn third_concurrent_plan_fails_fast_on_the_sidecar_budget() {
    let (blocking_runtime_factory, release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            blocking_runtime_factory,
            2,
            std::time::Duration::from_millis(200),
            64,
        ),
    );
    let input = freshell_codex::launch_plan::CodexLaunchPlanInput::default();
    let m1 = manager.clone();
    let a = tokio::spawn(async move {
        m1.plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
    });
    let m2 = manager.clone();
    let b = tokio::spawn(async move {
        m2.plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await; // both hold the budget
    let third = manager
        .plan_create_with_retry_uncancellable(&input, 1, LaunchClass::Interactive)
        .await;
    let err = third.expect_err("third concurrent plan must fail fast on the budget");
    assert!(
        err.to_string().contains("planning budget exhausted"),
        "{err}"
    );
    release.notify_waiters();
    let _ = a.await;
    let _ = b.await;
}

// ── graceful restore/resume S1 (P2): restore-class plans queue, never die ─────────

/// Graceful restore/resume S1 (P2): a runtime that counts CONCURRENT
/// `ensure_ready` bodies and sleeps, so "max plan concurrency <= budget"
/// is observable without wall-clock racing. All trait methods other than
/// `ensure_ready` are copied from [`FakeRuntime`]'s impl (delegate to an
/// inner FakeRuntime started on demand, exactly like BlockingRuntime does).
struct CountingRuntime {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    peak: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    plan_delay: std::time::Duration,
}

impl CodexLaunchRuntime for CountingRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.plan_delay).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }

    fn update_ownership_metadata(
        &self,
        _terminal_id: String,
        _generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { Ok(()) })
    }
}

/// The mandate's unit pin: 8 restore-class plans on a 2-permit budget with a
/// wait FAR smaller than the drain time — all 8 succeed (no wall-clock
/// death), and observed plan concurrency never exceeds 2.
#[tokio::test(flavor = "multi_thread")]
async fn eight_restore_class_plans_queue_and_drain_without_error() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let in_flight = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));
    let (rt_in, rt_peak) = (in_flight.clone(), peak.clone());
    let factory: freshell_codex::launch_lifecycle::CodexRuntimeFactory = Box::new(move |_plan| {
        let rt = std::sync::Arc::new(CountingRuntime {
            in_flight: rt_in.clone(),
            peak: rt_peak.clone(),
            plan_delay: std::time::Duration::from_millis(200),
        }) as std::sync::Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    });
    // wait = 200ms: 8 plans / 2 permits * 200ms = ~800ms of queueing.
    // Interactive would die; Restore must drain.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            2,
            std::time::Duration::from_millis(200),
            64,
        ),
    );
    let mut handles = Vec::new();
    for _ in 0..8 {
        let m = manager.clone();
        handles.push(tokio::spawn(async move {
            let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
            m.plan_create_with_retry(
                &CodexLaunchPlanInput::default(),
                1,
                freshell_codex::launch_lifecycle::LaunchClass::Restore,
                &mut cancel_rx,
            )
            .await
        }));
    }
    for h in handles {
        let launch = h
            .await
            .expect("join")
            .expect("restore-class plan must never die on the budget");
        manager.discard(launch).await;
    }
    let seen_peak = peak.load(Ordering::SeqCst);
    assert!(
        seen_peak <= 2,
        "plan concurrency bound violated: {seen_peak}"
    );
}

/// Cancel-aware queueing: a restore-class waiter parked on a zero-permit
/// budget unblocks as Cancelled the moment the watch fires.
#[tokio::test]
async fn restore_class_plan_wait_cancels_when_the_watch_fires() {
    let (factory, _release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            0,
            std::time::Duration::from_millis(50),
            64,
        ),
    );
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let m = manager.clone();
    let waiter = tokio::spawn(async move {
        m.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut cancel_rx,
        )
        .await
    });
    // Let the waiter park (0 permits => it can only be waiting or done-wrong).
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(manager.plan_queue_depth(), 1, "waiter must be queued");
    cancel_tx.send(true).expect("fire cancel");
    let err = waiter
        .await
        .expect("join")
        .expect_err("cancel must unblock the queued restore-class plan");
    assert!(
        matches!(
            err,
            freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled
        ),
        "{err}"
    );
    assert_eq!(
        manager.plan_queue_depth(),
        0,
        "queue slot reclaimed on cancel"
    );
}

/// The backpressure backstop: restore-class waiters beyond the queue cap
/// fail loud as QueueFull (the WS door maps this to RATE_LIMITED).
#[tokio::test(flavor = "multi_thread")]
async fn restore_class_queue_overflow_fails_loud_as_queue_full() {
    let (factory, release) = blocking_test_runtime_factory();
    // 1 permit, cap 1: holder + one queued waiter fill the system.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            1,
            std::time::Duration::from_millis(50),
            1,
        ),
    );
    let m1 = manager.clone();
    let holder = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m1.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    // Let the holder take the permit (it parks inside ensure_ready).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let m2 = manager.clone();
    let queued = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m2.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        manager.plan_queue_depth(),
        1,
        "one waiter queued at the cap"
    );
    // Third arrival overflows the cap.
    let (_tx3, mut c3) = tokio::sync::watch::channel(false);
    let err = manager
        .plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c3,
        )
        .await
        .expect_err("overflow past the plan queue cap must fail loud");
    assert!(
        matches!(
            err,
            freshell_codex::launch_lifecycle::CodexLaunchError::QueueFull
        ),
        "{err}"
    );
    // Drain: release the parked plans (BlockingRuntime parks on a Notify;
    // the queued waiter parks again after the holder finishes, so notify twice).
    release.notify_waiters();
    let launch = holder.await.expect("join").expect("holder plan completes");
    manager.discard(launch).await;
    release.notify_waiters();
    let launch2 = queued.await.expect("join").expect("queued plan completes");
    manager.discard(launch2).await;
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
    let planner = CodexLaunchPlanner::new(Box::new(move |_plan| {
        let rt = spawn_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
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

// ── Task 7: reattach failure falls back to a fresh spawn through the plan retry ────

/// Task 7 (kata da92): the plan-aware factory claims a survivor for a resume
/// plan. A survivor that DIED between boot reconcile and the restore is
/// pruned by the claim-time re-verification (record removed, NOTHING
/// signalled — the pid is dead), the claim returns `None`, and the SAME
/// factory invocation falls through to the fresh spawn: the launch succeeds
/// within the retry budget, served by a fresh fixture.
#[tokio::test]
async fn plan_retry_falls_back_to_fresh_spawn_after_reattach_failure() {
    let (_dir, store) = temp_sidecar_store();

    // A survivor record for s-1 whose process is ALIVE at boot reconcile:
    // this test's own `sleep 300` child, with its REAL /proc evidence.
    let mut sleep_child = std::process::Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn this test's own sleep child");
    let dead_pid = sleep_child.id();
    // Wait for exec to complete so the captured cmdline is really `sleep 300`
    // (the sidecar_reconcile_tests post-fork/pre-exec flake guard).
    let want = vec!["sleep".to_string(), "300".to_string()];
    let exec_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while proc_cmdline(dead_pid as i32).as_ref() != Some(&want) {
        assert!(
            std::time::Instant::now() < exec_deadline,
            "sleep child failed to exec within 5s"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    // The record's ws_url points at a loopback ephemeral port NOTHING
    // listens on (bound, read, dropped) — never dialed here (the claim
    // refuses the dead pid first), and fail-fast if it ever were.
    let unused_ws_url = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);
        format!("ws://127.0.0.1:{port}")
    };
    let dead_record = CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: "codex-sidecar-a7000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb".to_string(),
        pid: dead_pid,
        starttime: proc_starttime(dead_pid as i32).expect("live child has a starttime"),
        cmdline: want,
        ws_url: unused_ws_url,
        session_id: Some("s-1".to_string()),
        terminal_id: None,
        server_instance_id: "srv-prev".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
        lane: None,
    };
    store.write(&dead_record).expect("write survivor record");
    let (reconciler, report) = SidecarReconciler::boot_reconcile(store.clone());
    assert_eq!(report.held, 1, "the survivor is held at boot");
    let reconciler = Arc::new(reconciler);

    // …then the sidecar DIES before the restore claims it (kill + reap OUR
    // OWN child): the claim-time re-verification prunes the record and the
    // reattach arm never mints — no signal is ever sent.
    sleep_child.kill().expect("kill own sleep child");
    sleep_child.wait().expect("reap own sleep child");

    // The plan-aware factory: the production selection shape, with the spawn
    // fallback pinned to the committed fixture (never the real `codex`).
    let factory_reconciler = reconciler.clone();
    let factory_store = store.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move |plan| {
        let reconciler = factory_reconciler.clone();
        let store = factory_store.clone();
        Box::pin(async move {
            if let Some(session_id) = plan.session_id.as_deref() {
                if let Some(record) = reconciler.claim_for_session(session_id).await {
                    return Arc::new(ReattachedCodexAppServerRuntime::new(record, store))
                        as Arc<dyn CodexLaunchRuntime>;
                }
            }
            Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
                fake_app_server_command(),
                store,
            )) as Arc<dyn CodexLaunchRuntime>
        })
    }));

    let tmp = std::env::temp_dir().join(format!("freshell-codex-t7-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let launch = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput {
                cwd: Some(tmp.to_str().unwrap()),
                resume_session_id: Some("s-1"),
                ..Default::default()
            },
            2,
            /* retry_delay_ms */ 1,
        )
        .await
        .expect("the resume plan must fall back to a fresh spawn");

    // The dead survivor's record is GONE (pruned at claim) and the store's
    // one record is the FRESH spawn's — a different sidecar entirely.
    assert_eq!(reconciler.unclaimed_len(), 0, "the dead record left held");
    let records = store.load_all();
    assert_eq!(
        records.len(),
        1,
        "exactly the fresh spawn's record remains: {records:?}"
    );
    assert_ne!(
        records[0].ownership_id, dead_record.ownership_id,
        "the dead survivor's record was removed"
    );
    assert_ne!(
        records[0].pid, dead_pid,
        "the launch is served by a FRESH sidecar"
    );

    // The fresh fixture actually serves the launch: an initialize round trip
    // relays through the planned proxy.
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

    launch
        .sidecar
        .shutdown()
        .await
        .expect("teardown the fresh spawn");
    assert!(
        store.load_all().is_empty(),
        "teardown scrubs the fresh spawn's record"
    );
}

/// Task 7 review follow-up: the TRUE retry path. The claim SUCCEEDS (the
/// survivor's /proc evidence verifies) but the minted
/// [`ReattachedCodexAppServerRuntime`]'s `ensure_ready` FAILS (the record's
/// ws_url points at a port where nothing listens), which reaps the
/// verified-but-unusable survivor's tree (the test's OWN fixture child) and
/// removes its record; `plan_create`'s cleanup-on-plan-failure tears the
/// sidecar down and the retry loop's SECOND factory invocation finds
/// nothing left to claim (claims are one-shot) and spawns fresh.
#[tokio::test]
async fn plan_retry_spawns_fresh_after_claimed_reattach_ensure_ready_fails() {
    let (_dir, store) = temp_sidecar_store();

    // The survivor: this test's OWN fake app-server fixture on loopback
    // ephemeral port A (spawn shape copied from
    // `sidecar_reconcile_tests::spawn_own_fake_app_server`; test binaries
    // cannot share code — the repo's copy-with-attribution convention).
    let survivor_ownership = "codex-sidecar-a7000003-cccc-4ccc-8ccc-cccccccccccc";
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    let bind_unused_ws_url = || {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);
        format!("ws://127.0.0.1:{port}")
    };
    let listen_ws_url = bind_unused_ws_url();
    let mut survivor = tokio::process::Command::new("node")
        .arg(&fixture)
        .arg("--listen")
        .arg(&listen_ws_url)
        .env(CODEX_SIDECAR_OWNERSHIP_ENV, survivor_ownership)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn this test's own fake app-server");
    let survivor_pid = survivor.id().expect("live fixture pid");
    // Wait for the WS listener: by then exec has long completed, so the
    // /proc evidence captured below is really the fixture's (no
    // post-fork/pre-exec cmdline flake).
    let listen_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Ok((probe, _response))) =
            timeout(Duration::from_secs(1), connect_async(&listen_ws_url)).await
        {
            drop(probe);
            break;
        }
        if let Ok(Some(status)) = survivor.try_wait() {
            panic!("fake app-server exited before listening: {status}");
        }
        assert!(
            tokio::time::Instant::now() < listen_deadline,
            "fake app-server WS never came up"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // The record: the fixture's REAL /proc evidence (claim-time
    // re-verification: Verified) BUT a ws_url on ephemeral port B where
    // NOTHING listens (bind-then-drop) — the reattach probe fails fast.
    let survivor_record = CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: survivor_ownership.to_string(),
        pid: survivor_pid,
        starttime: proc_starttime(survivor_pid as i32).expect("live fixture has a starttime"),
        cmdline: proc_cmdline(survivor_pid as i32).expect("live fixture has a cmdline"),
        ws_url: bind_unused_ws_url(),
        session_id: Some("s-1".to_string()),
        terminal_id: None,
        server_instance_id: "srv-prev".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
        lane: None,
    };
    store
        .write(&survivor_record)
        .expect("write survivor record");
    let (reconciler, report) = SidecarReconciler::boot_reconcile(store.clone());
    assert_eq!(report.held, 1, "the survivor is held at boot");
    let reconciler = Arc::new(reconciler);

    // The plan-aware factory (production selection shape + an invocation
    // counter): attempt 1 claims and mints the reattach runtime; attempt 2
    // finds the one-shot claim consumed and spawns the fixture fresh.
    let factory_invocations = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let invocations = factory_invocations.clone();
    let factory_reconciler = reconciler.clone();
    let factory_store = store.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move |plan| {
        factory_invocations.fetch_add(1, Ordering::SeqCst);
        let reconciler = factory_reconciler.clone();
        let store = factory_store.clone();
        Box::pin(async move {
            if let Some(session_id) = plan.session_id.as_deref() {
                if let Some(record) = reconciler.claim_for_session(session_id).await {
                    return Arc::new(ReattachedCodexAppServerRuntime::new(record, store))
                        as Arc<dyn CodexLaunchRuntime>;
                }
            }
            Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
                fake_app_server_command(),
                store,
            )) as Arc<dyn CodexLaunchRuntime>
        })
    }));

    let tmp = std::env::temp_dir().join(format!("freshell-codex-t7r-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let launch = planner
        .plan_create_with_retry(
            &CodexLaunchPlanInput {
                cwd: Some(tmp.to_str().unwrap()),
                resume_session_id: Some("s-1"),
                ..Default::default()
            },
            2,
            /* retry_delay_ms */ 1,
        )
        .await
        .expect("attempt 2 must spawn fresh after the claimed reattach fails");

    assert_eq!(
        invocations.load(Ordering::SeqCst),
        2,
        "the failed reattach consumes attempt 1; the fresh spawn is attempt 2"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        0,
        "the one-shot claim was consumed by attempt 1"
    );

    // The verified-but-unusable survivor was REAPED by the reattach failure
    // arm (an unusable tracked sidecar must not leak) — the fixture is this
    // test's own child, and nothing else was ever signalled.
    wait_pid_gone(survivor_pid).await;
    let _ = survivor.wait().await; // reap our own child

    // The store holds exactly the FRESH spawn's record — the survivor's is
    // gone, and the launch is served by a different sidecar entirely.
    let records = store.load_all();
    assert_eq!(
        records.len(),
        1,
        "exactly the fresh spawn's record remains: {records:?}"
    );
    assert_ne!(
        records[0].ownership_id, survivor_record.ownership_id,
        "the unusable survivor's record was removed"
    );
    assert_ne!(
        records[0].pid, survivor_pid,
        "the launch is served by a FRESH sidecar"
    );

    launch
        .sidecar
        .shutdown()
        .await
        .expect("teardown the fresh spawn");
    assert!(
        store.load_all().is_empty(),
        "teardown scrubs the fresh spawn's record"
    );
}

// ────── S5.c persistence plumbing (mark_candidate_persisted, fail_candidate_capture) ──────

#[tokio::test]
async fn mark_candidate_persisted_is_a_noop_for_unknown_terminals() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));
    // Must not panic, hang, or error for a terminal that was never adopted.
    manager.mark_candidate_persisted("no-such-terminal").await;
    manager
        .fail_candidate_capture("no-such-terminal", "test refusal")
        .await;
    // Observe the no-op: create and adopt a real launch, verify calling the
    // no-op methods on unknown terminals does not affect it (observable: the
    // adopted launch can still be shut down cleanly).
    let planner_runtime = runtime.clone();
    let planner = CodexLaunchPlanner::new(Box::new(move |_plan| {
        let rt = planner_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .expect("plan_create");
    manager
        .adopt("known-terminal", launch, 0)
        .await
        .expect("adopt");
    // Calling operations on other unknown terminals is still a no-op.
    manager.mark_candidate_persisted("still-unknown").await;
    manager
        .fail_candidate_capture("still-unknown", "test")
        .await;
    // The adopted terminal is unaffected (observable: manager can shut down cleanly).
    manager.shutdown().await;
}

/// Task 4: the manager seam forwards a captured session/thread id to the
/// ADOPTED terminal's runtime; unknown terminal ids are a silent no-op
/// (mirrors `mark_candidate_persisted`).
#[tokio::test]
async fn manager_note_session_id_reaches_adopted_runtime() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = factory_runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            5,
            LaunchClass::Interactive,
        )
        .await
        .unwrap();
    manager.adopt("term-sid", launch, 0).await.unwrap();

    // Unknown terminal id: silent no-op — nothing reaches the runtime.
    manager
        .note_session_id("no-such-terminal", "s-ignored")
        .await;
    assert!(
        runtime.noted_session_ids.lock().unwrap().is_empty(),
        "an unknown terminal id must not forward to any runtime"
    );

    manager.note_session_id("term-sid", "s-1").await;
    assert_eq!(
        runtime.noted_session_ids.lock().unwrap().as_slice(),
        &["s-1".to_string()],
        "the adopted terminal's runtime must see the noted session id"
    );

    manager.shutdown().await;
}

// ────── Task 3: durable sidecar records — persist on spawn, scrub on teardown,
// survive server death (kata ynfn "surviving restarts is a feature") ──────────────

/// A lock-free store over its own tempdir (the tests-and-verification
/// construction, `sidecar_store.rs` docs). The `TempDir` guard is returned so
/// the record files outlive every runtime the test builds over the store.
fn temp_sidecar_store() -> (tempfile::TempDir, Arc<CodexSidecarStore>) {
    let dir = tempfile::tempdir().expect("tempdir for the sidecar store");
    let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
    (dir, store)
}

/// Poll until `pid` reads gone from `/proc`. `proc_starttime` returns `None`
/// for reaped AND zombie (Z) states, so this stays robust to tokio's
/// background orphan-reaping timing.
async fn wait_pid_gone(pid: u32) {
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    loop {
        if proc_starttime(pid as i32).is_none() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pid {pid} still alive past the {RECV_TIMEOUT:?} deadline"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn ensure_ready_persists_a_verified_sidecar_record() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    );

    let ready = runtime.ensure_ready(None).await.expect("ensure_ready");
    let pid = runtime.child_pid().await.expect("child pid");

    let records = store.load_all();
    assert_eq!(records.len(), 1, "exactly one record: {records:?}");
    let record = &records[0];
    assert_eq!(record.state, SidecarRecordState::Active);
    assert_eq!(record.pid, pid, "record pid is the live child's pid");
    assert_eq!(
        record.ws_url, ready.ws_url,
        "record ws_url is the returned one"
    );
    assert_eq!(
        verify_sidecar_identity(record),
        IdentityVerdict::Verified,
        "(starttime, cmdline) must verify against the live child"
    );

    runtime
        .shutdown()
        .await
        .expect("shutdown cleans up the child");
}

#[tokio::test]
async fn runtime_shutdown_removes_the_sidecar_record() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    );
    runtime.ensure_ready(None).await.expect("ensure_ready");
    let pid = runtime.child_pid().await.expect("child pid");
    assert_eq!(store.load_all().len(), 1, "record present before shutdown");

    runtime.shutdown().await.expect("shutdown");

    assert!(
        store.load_all().is_empty(),
        "explicit shutdown must scrub the record"
    );
    wait_pid_gone(pid).await;
}

#[tokio::test]
async fn update_ownership_metadata_enriches_the_record() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    );
    runtime.ensure_ready(None).await.expect("ensure_ready");

    runtime
        .update_ownership_metadata("term-42".to_string(), 7)
        .await
        .expect("update_ownership_metadata");

    let records = store.load_all();
    assert_eq!(records.len(), 1, "still exactly one record: {records:?}");
    assert_eq!(
        records[0].terminal_id.as_deref(),
        Some("term-42"),
        "adopt must enrich the record with the terminal id"
    );

    runtime
        .shutdown()
        .await
        .expect("shutdown cleans up the child");
}

/// Task 4: `note_session_id` rewrites the durable record with the codex
/// session/thread id — the restore-time reattach key (katas ynfn/da92).
#[tokio::test]
async fn spawned_runtime_note_session_id_enriches_the_record() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    );
    runtime.ensure_ready(None).await.expect("ensure_ready");

    runtime
        .note_session_id("s-1".to_string())
        .await
        .expect("note_session_id");

    let records = store.load_all();
    assert_eq!(records.len(), 1, "still exactly one record: {records:?}");
    assert_eq!(
        records[0].session_id.as_deref(),
        Some("s-1"),
        "note_session_id must enrich the record with the session id"
    );

    runtime
        .shutdown()
        .await
        .expect("shutdown cleans up the child");
}

#[tokio::test]
async fn spawned_sidecar_survives_runtime_drop_without_shutdown() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    );
    runtime.ensure_ready(None).await.expect("ensure_ready");
    let pid = runtime.child_pid().await.expect("child pid");

    // Server death without shutdown(): kill_on_drop is OFF for tracked spawns.
    drop(runtime);

    // Give any (wrong) kill-on-drop a chance to land before asserting liveness.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        proc_starttime(pid as i32).is_some(),
        "detached sidecar (pid {pid}) must survive the runtime drop"
    );

    // The record still exists: an uncleanly-dying server leaves a TRACKED,
    // reconcilable sidecar — not an invisible orphan (the whole point).
    let records = store.load_all();
    assert_eq!(
        records.len(),
        1,
        "record must survive the drop: {records:?}"
    );
    let record = &records[0];
    assert_eq!(record.pid, pid);

    // PROCESS SAFETY: kill ONLY the child this test spawned, and only after
    // re-verifying (pid, starttime, cmdline) identity via the record.
    assert_eq!(verify_sidecar_identity(record), IdentityVerdict::Verified);
    // SAFETY: plain FFI signal send to our own verified child pid.
    unsafe {
        assert_eq!(
            libc::kill(pid as i32, libc::SIGTERM),
            0,
            "SIGTERM this test's own child"
        );
    }
    wait_pid_gone(pid).await;
}

#[tokio::test]
async fn drop_without_shutdown_with_disabled_store_keeps_the_kill_on_drop_backstop() {
    let runtime = SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        Arc::new(CodexSidecarStore::disabled()),
    );
    runtime.ensure_ready(None).await.expect("ensure_ready");
    let pid = runtime.child_pid().await.expect("child pid");

    // A record-less sidecar must NEVER outlive the server: detaching it would
    // be the silently-orphaned ynfn hole with no reconcile path, so untracked
    // spawns keep today's kill_on_drop backstop.
    drop(runtime);

    wait_pid_gone(pid).await;
}

// ────── Task 10: server-shutdown retention (katas ynfn/da92) ──────
//
// `begin_shutdown_retention()` flips the manager into server-shutdown mode:
// adopted (terminal-owned) TRACKED sidecars are retained across the restart
// (record → `Retained{reason:"server-shutdown"}`, process never signalled);
// unadopted planner sidecars and record-less (disabled-store) sidecars are
// torn down exactly as today — retaining a record-less sidecar would orphan
// it silently with no reconcile path (the ynfn hole).

/// Manager over a single pre-built spawned runtime (the Task 3 test shape:
/// per-instance store injection, never the process-global handle).
fn manager_over(runtime: Arc<SpawnedCodexAppServerRuntime>) -> CodexTerminalLaunchManager {
    CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let rt = runtime.clone() as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }))
}

#[tokio::test]
async fn shutdown_retention_retains_adopted_sidecars_and_records_reason() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    ));
    let manager = manager_over(runtime.clone());

    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    manager
        .adopt("term-retained", launch, 0)
        .await
        .expect("adopt");
    let pid = runtime.child_pid().await.expect("child pid");

    manager.begin_shutdown_retention();
    manager.shutdown().await;

    // The fixture pid is STILL ALIVE: retention never signals. (Give any
    // wrong kill a moment to land before asserting liveness — the
    // spawned_sidecar_survives_runtime_drop_without_shutdown pattern.)
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        proc_starttime(pid as i32).is_some(),
        "retained sidecar (pid {pid}) must survive the server shutdown"
    );

    // The record carries the reason a restarted server reconciles against.
    let records = store.load_all();
    assert_eq!(records.len(), 1, "exactly one record: {records:?}");
    assert_eq!(records[0].pid, pid);
    assert_eq!(
        records[0].state,
        SidecarRecordState::Retained {
            reason: "server-shutdown".to_string()
        },
        "retention must record its reason"
    );

    // PROCESS SAFETY cleanup: reap this test's OWN fixture pid, identity
    // re-verified via the record immediately before the signal.
    assert_eq!(
        verify_sidecar_identity(&records[0]),
        IdentityVerdict::Verified
    );
    // SAFETY: plain FFI signal send to our own verified child pid.
    unsafe {
        assert_eq!(
            libc::kill(pid as i32, libc::SIGTERM),
            0,
            "SIGTERM this test's own child"
        );
    }
    wait_pid_gone(pid).await;
}

/// Final-review H3c: even when `prepare_retention` fails (record rewrite
/// error — retention already logs loudly), the DECISION to retain stands: a
/// later `shutdown()` (a double-fired PTY exit hook, `manager.shutdown()`'s
/// drain) must NOT kill the sidecar we chose to retain.
#[tokio::test]
async fn retain_failure_still_blocks_a_later_shutdown_kill() {
    let runtime = FakeRuntime::start().await;
    runtime.fail_prepare_retention.store(true, Ordering::SeqCst);
    let planner = planner_for(runtime.clone());
    let launch = planner
        .plan_create(&CodexLaunchPlanInput::default())
        .await
        .expect("plan");

    launch
        .sidecar
        .retain("server-shutdown")
        .await
        .expect_err("the prepare_retention failure propagates to the caller");

    // The retention decision stands: shutdown() must no-op via the
    // idempotence flag, never reaching the runtime's kill path.
    launch
        .sidecar
        .shutdown()
        .await
        .expect("post-retain shutdown is an idempotent no-op");
    assert_eq!(
        runtime.shutdown_calls.load(Ordering::SeqCst),
        0,
        "a sidecar we decided to retain must never be killed by a later shutdown()"
    );
}

#[tokio::test]
async fn shutdown_still_tears_down_unadopted_planner_sidecars() {
    let (_dir, store) = temp_sidecar_store();
    let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        store.clone(),
    ));
    let manager = manager_over(runtime.clone());

    // Plan WITHOUT adopt: a mid-plan sidecar has no pane to reattach to (and
    // a fresh-plan proxy may hold the candidate timer) — still torn down.
    let _unadopted = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    let pid = runtime.child_pid().await.expect("child pid");

    manager.begin_shutdown_retention();
    manager.shutdown().await;

    wait_pid_gone(pid).await;
    assert!(
        store.load_all().is_empty(),
        "unadopted teardown must scrub the record"
    );
}

#[tokio::test]
async fn retention_with_disabled_store_tears_down_as_today() {
    // Task 3's conditional detach: disabled store ⇒ kill_on_drop(true), NO
    // record. The retention gate says record-less sidecars are NEVER
    // retained — "retaining" one would orphan it silently (the ynfn hole).
    let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
        fake_app_server_command(),
        Arc::new(CodexSidecarStore::disabled()),
    ));
    let manager = manager_over(runtime.clone());

    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    manager
        .adopt("term-untracked", launch, 0)
        .await
        .expect("adopt");
    let pid = runtime.child_pid().await.expect("child pid");

    manager.begin_shutdown_retention();
    manager.shutdown().await;

    wait_pid_gone(pid).await;
}

#[tokio::test]
async fn notify_terminal_exit_retains_under_retention_flag() {
    let (_dir, store) = temp_sidecar_store();
    // One runtime per plan (the exit hook consumes its adopted entry, so the
    // two arms need independent sidecars), each recorded for pid access.
    let spawned: Arc<Mutex<Vec<Arc<SpawnedCodexAppServerRuntime>>>> =
        Arc::new(Mutex::new(Vec::new()));
    let factory_store = store.clone();
    let factory_spawned = spawned.clone();
    let manager = CodexTerminalLaunchManager::new(Box::new(move |_plan| {
        let runtime = Arc::new(SpawnedCodexAppServerRuntime::with_command_and_store(
            fake_app_server_command(),
            factory_store.clone(),
        ));
        factory_spawned.lock().unwrap().push(runtime.clone());
        let rt = runtime as Arc<dyn CodexLaunchRuntime>;
        Box::pin(async move { rt })
    }));

    // Arm 1 — flag OFF (existing behavior, asserted so the contrast is
    // pinned): the exit hook hands the entry to the teardown worker, which
    // reaps the sidecar and scrubs its record.
    let launch_a = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan a");
    manager
        .adopt("term-exit-a", launch_a, 0)
        .await
        .expect("adopt a");
    let runtime_a = spawned.lock().unwrap()[0].clone();
    let pid_a = runtime_a.child_pid().await.expect("pid a");

    manager.notify_terminal_exit("term-exit-a");
    wait_pid_gone(pid_a).await;
    // The record scrub is a separate write after the reap — poll for it.
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    while !store.load_all().is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "flag-off teardown must scrub the record"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Arm 2 — flag ON: the SAME exit hook retains instead of reaping.
    let launch_b = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan b");
    manager
        .adopt("term-exit-b", launch_b, 0)
        .await
        .expect("adopt b");
    let runtime_b = spawned.lock().unwrap()[1].clone();
    let pid_b = runtime_b.child_pid().await.expect("pid b");

    manager.begin_shutdown_retention();
    manager.notify_terminal_exit("term-exit-b");

    // Retention flows through the async worker: poll for the Retained write.
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    let record = loop {
        let mut records = store.load_all();
        if records.len() == 1 && matches!(records[0].state, SidecarRecordState::Retained { .. }) {
            break records.remove(0);
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "retained record never appeared: {records:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(record.pid, pid_b);
    assert_eq!(
        record.state,
        SidecarRecordState::Retained {
            reason: "server-shutdown".to_string()
        }
    );
    assert!(
        proc_starttime(pid_b as i32).is_some(),
        "retained sidecar (pid {pid_b}) must be alive after the exit hook"
    );

    // PROCESS SAFETY cleanup: verified reap of this test's own fixture pid.
    assert_eq!(verify_sidecar_identity(&record), IdentityVerdict::Verified);
    // SAFETY: plain FFI signal send to our own verified child pid.
    unsafe {
        assert_eq!(
            libc::kill(pid_b as i32, libc::SIGTERM),
            0,
            "SIGTERM this test's own child"
        );
    }
    wait_pid_gone(pid_b).await;
}

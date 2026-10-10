//! Pin for the test-only global-manager installer (graceful restore/resume
//! S1): integration suites (freshell-ws restore-storm) must be able to make
//! `global()` resolve to a manager over a FAKE runtime. Lives in its own
//! test binary because the global is process-wide and set-once.
#![cfg(feature = "real-transport")]

use freshell_codex::launch_lifecycle::{
    CodexLaunchRuntime, CodexTerminalLaunchManager, LaunchClass,
};

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use freshell_codex::launch_lifecycle::CodexRuntimeReady;
use freshell_codex::BoxFuture;

// ── fake runtime: a loopback WS echo listener standing in for the app-server ──────
// Copied verbatim from crates/freshell-codex/tests/launch_lifecycle.rs (test
// binaries cannot share code without a common module; this repo's harness
// convention is copy-with-attribution).

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
                codex_home: None,
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

    fn stop(
        &self,
        _mode: freshell_containment::StopMode,
        _reason: freshell_containment::StopReason,
        _initiator: String,
    ) -> BoxFuture<'_, Option<freshell_containment::StopHandle>> {
        Box::pin(async move {
            self.shutdown_calls.fetch_add(1, Ordering::SeqCst);
            None
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn installed_manager_is_returned_by_global_and_set_twice_fails() {
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
    assert!(
        freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(manager),
        "first install must win"
    );
    // Prove global() is the installed instance: plan through it and observe
    // the fake runtime being exercised.
    let launch = CodexTerminalLaunchManager::global()
        .plan_create_with_retry_uncancellable(
            &freshell_codex::launch_plan::CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan through the installed manager");
    assert_eq!(
        runtime.ensure_ready_calls.lock().unwrap().len(),
        1,
        "the installed fake runtime must have served the plan"
    );
    CodexTerminalLaunchManager::global().discard(launch).await;

    let runtime2 = FakeRuntime::start().await;
    let second = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move |_plan| {
            let rt = runtime2.clone() as std::sync::Arc<dyn CodexLaunchRuntime>;
            Box::pin(async move { rt })
        }),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    assert!(
        !freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(second),
        "second install must report failure (set-once)"
    );
}

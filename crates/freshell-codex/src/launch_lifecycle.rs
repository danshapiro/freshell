//! Codex launch-planning LIFECYCLE glue (DEV-0006 S4) — the IO half that turns the S3
//! pure decisions ([`crate::launch_plan`]) into a running app-server sidecar + S2 remote
//! proxy ([`crate::remote_proxy`]), plus the terminal-keyed manager both terminal-create
//! paths (WS `terminal.create` and REST `/api/tabs`) wire through.
//!
//! Faithful (scoped) port of `server/coding-cli/codex-app-server/launch-planner.ts`
//! (`CodexLaunchPlanner` + the sidecar closure, `:108-316`) and the app-server spawn from
//! `runtime.ts:1246-1261` (already mirrored by
//! `freshell-freshagent/src/codex.rs::spawn_sidecar` — the argv/env DECISION lives in
//! [`crate::launch_plan::codex_sidecar_spawn_spec`]; this module is the canonical shared
//! home for the terminal-mode spawn, a follow-up refactor points `codex.rs` here too).
//!
//! ## Scope decisions (S4 increment 1; see the spec §5 slice fences)
//!
//! - **Ported:** `planCreate` fresh/resume (runtime `ensureReady` → REAL proxy start →
//!   plan out), cleanup-on-plan-failure (`launch-planner.ts:164-175`), planner `shutdown`
//!   with `assertAcceptingPlans` (`:197-201`), the sidecar `adopt`/`shutdown` state
//!   machine from `:238-316` (adoptable assertion, ownership transfer out of the planner
//!   on adopt, idempotent single-flight shutdown), and the retry driver over
//!   [`crate::launch_plan::plan_codex_launch_retry`].
//! - **Deferred to S5 (durability/DEV-0008, whole-or-not):** the identity-gate pass-throughs
//!   (`markCandidatePersisted`/`pause`/`resume`), the runtime RPC surface
//!   (`readThreadTurn`/`listThreadTurns`/`watchPath`/`unwatchPath`), `onFsChanged` +
//!   lifecycle-loss handler merging, and `failedSidecarShutdowns` retry-before-plan
//!   bookkeeping (`:206-236`) — nothing consumes them until S5's consumers land.
//! - **`update_ownership_metadata` records in memory only.** Legacy writes the durability
//!   store's ownership record; that store IS S5. The trait seam is shaped so S5 swaps the
//!   recording for the real write without touching the planner.
//! - **Recovery (`recovery.planCreate`, re-plan on sidecar loss) is deferred** per the
//!   spec's risk fence ("keep recovery minimal in Slices 1-4"). The retry budget
//!   asymmetry is still replicated structurally: `planCodexLaunch`'s default attempts is
//!   1 (`ws-handler.ts:934`) while the initial WS create passes
//!   [`crate::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS`] (= 5, `ws-handler.ts:2447`) —
//!   callers of [`CodexLaunchPlanner::plan_create_with_retry`] choose their budget
//!   explicitly.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::app_server::BoxFuture;
use crate::durability::mint_ownership_id;
use crate::launch_plan::{
    codex_sidecar_spawn_spec, plan_codex_launch, plan_codex_launch_retry, CodexLaunchConfigError,
    CodexLaunchPlan, CodexLaunchPlanInput, CodexLaunchRetryDecision,
    CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
};
use crate::remote_proxy::{CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent};
use crate::transport::reap_owned_codex_sidecars;

/// `assertAcceptingPlans` (`launch-planner.ts:199`), byte-identical.
pub const CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE: &str =
    "Codex launch planner is shutting down; new Codex launch plans are not accepted.";

/// `assertAdoptable` (`launch-planner.ts:227`), byte-identical.
pub const CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE: &str =
    "Codex launch sidecar is shutting down; it cannot be adopted.";

/// How long a spawned app-server gets to bring its WS listener up — matches
/// `freshell-freshagent/src/codex.rs::SIDECAR_START_BUDGET`.
const SIDECAR_START_BUDGET: Duration = Duration::from_secs(45);

// ─── the runtime seam (CodexRuntimeLike, launch-planner.ts:34-52, scoped) ───────────────

/// `runtime.ensureReady()`'s result: the app-server's own listen URL (NOT what the TUI
/// sees — the proxy's URL is what rides into argv, spec §1.3 step 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRuntimeReady {
    pub ws_url: String,
}

/// The injected runtime seam (`CodexRuntimeLike`), scoped to what S4 consumes: readiness,
/// the adopt-time ownership update, and teardown. The S5 RPC surface
/// (`readThreadTurn`/`watchPath`/…) joins this trait when its consumers land.
pub trait CodexLaunchRuntime: Send + Sync {
    /// Bring the app-server up (spawn on first call) and return its WS URL
    /// (`runtime.ensureReady(cwd)`, called with the create cwd in BOTH plan branches,
    /// `launch-planner.ts:137,153`).
    fn ensure_ready(&self, cwd: Option<String>)
        -> BoxFuture<'_, Result<CodexRuntimeReady, String>>;

    /// `runtime.updateOwnershipMetadata({terminalId, generation})` (`launch-planner.ts:240`).
    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>>;

    /// Tear the app-server down (`runtime.shutdown()`, `launch-planner.ts:302`).
    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>>;
}

/// The planner's runtime factory (`CodexLaunchPlanner` ctor `runtimeOrFactory`,
/// `launch-planner.ts:115-121`): one fresh runtime per plan.
pub type CodexRuntimeFactory = Box<dyn Fn() -> Arc<dyn CodexLaunchRuntime> + Send + Sync>;

// ─── errors ──────────────────────────────────────────────────────────────────────────────

/// A launch-planning failure, split exactly the way the retry policy needs
/// (`launch-retry.ts:35`: config errors are never retried).
#[derive(Debug)]
pub enum CodexLaunchError {
    /// Non-retryable configuration error (invalid sandbox, `codex-launch-config.ts`).
    Config(CodexLaunchConfigError),
    /// Retryable launch failure (runtime/proxy IO, planner shutdown).
    Failed(String),
}

impl std::fmt::Display for CodexLaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexLaunchError::Config(error) => f.write_str(&error.message),
            CodexLaunchError::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for CodexLaunchError {}

// ─── the sidecar handle (launch-planner.ts:221-316, scoped) ─────────────────────────────

struct SidecarInner {
    proxy: Option<CodexRemoteProxy>,
    shutdown_started: bool,
    shutdown_succeeded: bool,
}

/// The launch sidecar: owns the runtime (spawned app-server) + the started proxy for one
/// codex terminal pane. Created by [`CodexLaunchPlanner::plan_create`]; the planner owns
/// it until [`CodexLaunchSidecar::adopt`] transfers ownership to the terminal.
pub struct CodexLaunchSidecar {
    id: u64,
    runtime: Arc<dyn CodexLaunchRuntime>,
    inner: tokio::sync::Mutex<SidecarInner>,
    planner_active: Arc<Mutex<HashMap<u64, Arc<CodexLaunchSidecar>>>>,
    planner_shutdown: Arc<AtomicBool>,
}

impl CodexLaunchSidecar {
    /// The live proxy's recorded `requireCandidatePersistence` (fresh → true, resume →
    /// false; review note 2). `None` once the proxy has been torn down.
    pub async fn require_candidate_persistence(&self) -> Option<bool> {
        self.inner
            .lock()
            .await
            .proxy
            .as_ref()
            .map(|proxy| proxy.require_candidate_persistence())
    }

    async fn assert_adoptable(&self) -> Result<(), String> {
        let shutting_down = self.planner_shutdown.load(Ordering::SeqCst)
            || self.inner.lock().await.shutdown_started;
        if shutting_down {
            return Err(CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE.to_string());
        }
        Ok(())
    }

    /// `sidecar.adopt({terminalId, generation})` (`launch-planner.ts:238-244`): assert
    /// adoptable, record the ownership metadata, re-assert, then transfer ownership OUT
    /// of the planner (an adopted sidecar survives `planner.shutdown()` — the terminal's
    /// exit path owns its teardown from here).
    pub async fn adopt(&self, terminal_id: &str, generation: u64) -> Result<(), String> {
        self.assert_adoptable().await?;
        self.runtime
            .update_ownership_metadata(terminal_id.to_string(), generation)
            .await?;
        self.assert_adoptable().await?;
        self.planner_active.lock().unwrap().remove(&self.id);
        Ok(())
    }

    /// `sidecar.shutdown()` (`launch-planner.ts:281-316`): idempotent, single-flight
    /// (concurrent callers serialize on the inner lock and observe the succeeded flag).
    /// Tears down the proxy (listener + socket pairs) and the runtime (spawned child).
    pub async fn shutdown(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.shutdown_succeeded {
            return Ok(());
        }
        inner.shutdown_started = true;
        if let Some(proxy) = inner.proxy.take() {
            proxy.close().await;
        }
        self.runtime.shutdown().await?;
        inner.shutdown_succeeded = true;
        self.planner_active.lock().unwrap().remove(&self.id);
        Ok(())
    }
}

// ─── the launch (planCreate's CodexLaunchPlan, launch-planner.ts:24-32) ─────────────────

/// A planned + started codex terminal launch: what `planCreate` returns
/// (`{sessionId?, remote: {wsUrl}, sidecar}`) plus the S3 pure plan (binding reason etc.
/// for the S5 consumers) and the proxy's event stream (durability candidates / turn
/// events — unconsumed until S5; hold it so the proxy's senders stay connected).
pub struct CodexTerminalLaunch {
    /// Set ONLY on resume (`launch-planner.ts:145`).
    pub session_id: Option<String>,
    /// The PROXY's ws URL — what `--remote` points the TUI at (spec §1.3 step 3).
    pub remote_ws_url: String,
    /// The S3 pure decisions this launch was planned from.
    pub plan: CodexLaunchPlan,
    pub sidecar: Arc<CodexLaunchSidecar>,
    /// The proxy's typed event stream (S5's seam).
    pub events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
}

impl std::fmt::Debug for CodexTerminalLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexTerminalLaunch")
            .field("session_id", &self.session_id)
            .field("remote_ws_url", &self.remote_ws_url)
            .field("plan", &self.plan)
            .finish_non_exhaustive()
    }
}

// ─── the planner (launch-planner.ts:108-201, scoped) ────────────────────────────────────

/// `CodexLaunchPlanner`: one per server process (`server/index.ts:359`). Owns un-adopted
/// sidecars; refuses new plans once shutdown starts.
pub struct CodexLaunchPlanner {
    runtime_factory: CodexRuntimeFactory,
    shutdown_started: Arc<AtomicBool>,
    active: Arc<Mutex<HashMap<u64, Arc<CodexLaunchSidecar>>>>,
    next_id: AtomicU64,
}

impl CodexLaunchPlanner {
    pub fn new(runtime_factory: CodexRuntimeFactory) -> Self {
        Self {
            runtime_factory,
            shutdown_started: Arc::new(AtomicBool::new(false)),
            active: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
        }
    }

    fn assert_accepting_plans(&self) -> Result<(), CodexLaunchError> {
        if self.shutdown_started.load(Ordering::SeqCst) {
            return Err(CodexLaunchError::Failed(
                CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE.to_string(),
            ));
        }
        Ok(())
    }

    /// `planCreate` (`launch-planner.ts:125-175`): decide (S3 pure plan) → runtime
    /// `ensureReady(cwd)` → start the REAL proxy against the app-server, passing the
    /// plan's `require_candidate_persistence` EXPLICITLY (review note 2) → return the
    /// proxy's ws URL. Any failure after the sidecar exists tears it down
    /// (cleanup-on-plan-failure, `:164-175`).
    pub async fn plan_create(
        &self,
        input: &CodexLaunchPlanInput<'_>,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        self.assert_accepting_plans()?;
        let plan = plan_codex_launch(input).map_err(CodexLaunchError::Config)?;

        let runtime = (self.runtime_factory)();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let sidecar = Arc::new(CodexLaunchSidecar {
            id,
            runtime: runtime.clone(),
            inner: tokio::sync::Mutex::new(SidecarInner {
                proxy: None,
                shutdown_started: false,
                shutdown_succeeded: false,
            }),
            planner_active: self.active.clone(),
            planner_shutdown: self.shutdown_started.clone(),
        });
        self.active.lock().unwrap().insert(id, sidecar.clone());

        let started: Result<(CodexRemoteProxy, mpsc::UnboundedReceiver<RemoteProxyEvent>), String> =
            async {
                let ready = runtime.ensure_ready(plan.runtime_cwd.clone()).await?;
                CodexRemoteProxy::start(CodexRemoteProxyOptions::new(
                    ready.ws_url,
                    plan.require_candidate_persistence,
                ))
                .await
                .map_err(|error| error.to_string())
            }
            .await;

        match started {
            Ok((proxy, events)) => {
                let remote_ws_url = proxy.ws_url().to_string();
                sidecar.inner.lock().await.proxy = Some(proxy);
                if let Err(rejected) = self.assert_accepting_plans() {
                    // Shutdown raced the plan (`assertAcceptingPlans` after proxy start,
                    // launch-planner.ts:144,156): tear the fresh sidecar down.
                    let _ = sidecar.shutdown().await;
                    return Err(rejected);
                }
                Ok(CodexTerminalLaunch {
                    session_id: plan.session_id.clone(),
                    remote_ws_url,
                    plan,
                    sidecar,
                    events,
                })
            }
            Err(message) => {
                if let Err(teardown) = sidecar.shutdown().await {
                    return Err(CodexLaunchError::Failed(format!(
                        "Codex launch sidecar teardown failed after planning error: {teardown}"
                    )));
                }
                Err(CodexLaunchError::Failed(message))
            }
        }
    }

    /// `planCodexLaunchWithRetry` (`launch-retry.ts:16-50`) over the pure schedule
    /// decision: linear backoff, config errors never retried. The attempt budget is the
    /// caller's — the WS initial create passes 5 (`ws-handler.ts:2447`) while legacy's
    /// recovery closure defaults to 1 (`planCodexLaunch` default param, the asymmetry
    /// review note 5 pins).
    pub async fn plan_create_with_retry(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
        retry_delay_ms: u64,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            match self.plan_create(input).await {
                Ok(launch) => return Ok(launch),
                Err(error) => {
                    let is_config_error = matches!(error, CodexLaunchError::Config(_));
                    match plan_codex_launch_retry(
                        attempt,
                        attempts,
                        retry_delay_ms,
                        is_config_error,
                    ) {
                        CodexLaunchRetryDecision::Retry { delay_ms } => {
                            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        }
                        CodexLaunchRetryDecision::GiveUp => return Err(error),
                    }
                }
            }
        }
    }

    /// `planner.shutdown()` (`launch-planner.ts:177-195`): stop accepting plans, tear
    /// down every sidecar the planner still owns (adopted sidecars are the terminals').
    pub async fn shutdown(&self) {
        self.shutdown_started.store(true, Ordering::SeqCst);
        let sidecars: Vec<Arc<CodexLaunchSidecar>> = {
            let mut active = self.active.lock().unwrap();
            active.drain().map(|(_, sidecar)| sidecar).collect()
        };
        for sidecar in sidecars {
            let _ = sidecar.shutdown().await;
        }
    }
}

// ─── the terminal-keyed manager (the ONE shared seam for both create paths) ─────────────

struct AdoptedTerminalLaunch {
    sidecar: Arc<CodexLaunchSidecar>,
    /// Held (unconsumed) so the proxy's event senders stay connected for S5.
    _events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
}

/// The shared `resolve_codex_launch` seam (spec §5 Slice 4): plan → adopt-by-terminal-id →
/// teardown-on-terminal-exit, used by BOTH the WS `terminal.create` codex branch and the
/// REST `/api/tabs` codex branch. Teardown is decoupled from the (sync) PTY exit hook via
/// an unbounded channel + a worker task.
pub struct CodexTerminalLaunchManager {
    planner: CodexLaunchPlanner,
    adopted: Mutex<HashMap<String, AdoptedTerminalLaunch>>,
    teardown_tx: OnceLock<mpsc::UnboundedSender<AdoptedTerminalLaunch>>,
}

impl CodexTerminalLaunchManager {
    pub fn new(runtime_factory: CodexRuntimeFactory) -> Self {
        Self {
            planner: CodexLaunchPlanner::new(runtime_factory),
            adopted: Mutex::new(HashMap::new()),
            teardown_tx: OnceLock::new(),
        }
    }

    /// The process-wide manager over the REAL spawn runtime — legacy has exactly one
    /// `CodexLaunchPlanner` per server (`server/index.ts:359`).
    pub fn global() -> &'static CodexTerminalLaunchManager {
        static GLOBAL: OnceLock<CodexTerminalLaunchManager> = OnceLock::new();
        GLOBAL.get_or_init(|| {
            CodexTerminalLaunchManager::new(Box::new(|| {
                Arc::new(SpawnedCodexAppServerRuntime::new()) as Arc<dyn CodexLaunchRuntime>
            }))
        })
    }

    /// Must be called from async (tokio) context; the teardown worker is spawned lazily
    /// here so [`CodexTerminalLaunchManager::notify_terminal_exit`] can stay sync-safe.
    pub async fn plan_create_with_retry(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        self.ensure_teardown_worker();
        self.planner
            .plan_create_with_retry(input, attempts, CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS)
            .await
    }

    /// Adopt the launch for a created terminal (`codexPlan.sidecar.adopt({terminalId,
    /// generation: 0})`, `ws-handler.ts:2511`) and key its teardown by terminal id.
    pub async fn adopt(
        &self,
        terminal_id: &str,
        launch: CodexTerminalLaunch,
        generation: u64,
    ) -> Result<(), String> {
        launch.sidecar.adopt(terminal_id, generation).await?;
        self.adopted.lock().unwrap().insert(
            terminal_id.to_string(),
            AdoptedTerminalLaunch {
                sidecar: launch.sidecar,
                _events: launch.events,
            },
        );
        Ok(())
    }

    /// Tear down a plan whose terminal create failed before adoption (the
    /// `pendingCodexPlan` cleanup path). Best-effort: teardown errors are swallowed —
    /// the create error the caller is already surfacing is the primary failure.
    pub async fn discard(&self, launch: CodexTerminalLaunch) {
        let _ = launch.sidecar.shutdown().await;
    }

    /// Sync-safe (callable from the PTY exit hook's non-async thread): detach the
    /// terminal's launch and hand it to the teardown worker. No-op for terminals without
    /// a managed launch.
    pub fn notify_terminal_exit(&self, terminal_id: &str) {
        let Some(entry) = self.adopted.lock().unwrap().remove(terminal_id) else {
            return;
        };
        if let Some(tx) = self.teardown_tx.get() {
            let _ = tx.send(entry);
        }
    }

    /// Server-exit teardown (main.rs graceful shutdown): mirrors legacy's close-time
    /// `codexLaunchPlanner.shutdown()` (`server/index.ts:981-1049` shutdown owners) —
    /// the planner stops accepting plans and tears down its unadopted sidecars — PLUS
    /// the adopted (terminal-owned) launches this manager keys, since server exit ends
    /// those terminals too (their exit hooks may also queue teardown; sidecar shutdown
    /// is idempotent, so both paths are safe).
    pub async fn shutdown(&self) {
        self.planner.shutdown().await;
        let adopted: Vec<AdoptedTerminalLaunch> = {
            let mut map = self.adopted.lock().unwrap();
            map.drain().map(|(_, entry)| entry).collect()
        };
        for entry in adopted {
            let _ = entry.sidecar.shutdown().await;
        }
    }

    fn ensure_teardown_worker(&self) {
        self.teardown_tx.get_or_init(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<AdoptedTerminalLaunch>();
            tokio::spawn(async move {
                while let Some(entry) = rx.recv().await {
                    let _ = entry.sidecar.shutdown().await;
                }
            });
            tx
        });
    }
}

// ─── the real runtime: spawn `codex … app-server --listen` (runtime.ts:1246-1261) ───────

struct SpawnedSidecar {
    ws_url: String,
    ownership_id: String,
    child: tokio::process::Child,
}

/// The real [`CodexLaunchRuntime`]: spawns `codex -c features.apps=false app-server
/// --listen ws://127.0.0.1:<port>` (argv/env from
/// [`crate::launch_plan::codex_sidecar_spawn_spec`], ownership-tagged for the `/proc`
/// reaper), waits for the WS listener, and kills + reaps on teardown. Mirrors
/// `freshell-freshagent/src/codex.rs::spawn_sidecar` mechanics minus the client
/// handshake — the terminal topology's client is the TUI, which runs its own
/// `initialize` through the proxy.
pub struct SpawnedCodexAppServerRuntime {
    codex_command: Option<String>,
    start_budget: Duration,
    state: tokio::sync::Mutex<Option<SpawnedSidecar>>,
    adopted_metadata: Mutex<Option<(String, u64)>>,
}

impl Default for SpawnedCodexAppServerRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl SpawnedCodexAppServerRuntime {
    /// Command from `CODEX_CMD` (whitespace-split, matching `codex.rs::spawn_sidecar`'s
    /// interpreter-plus-script support) falling back to `codex`.
    pub fn new() -> Self {
        Self {
            codex_command: None,
            start_budget: SIDECAR_START_BUDGET,
            state: tokio::sync::Mutex::new(None),
            adopted_metadata: Mutex::new(None),
        }
    }

    /// Explicit command override (tests: `node …/fake-app-server.mjs`) — avoids
    /// process-global env mutation in parallel test runs.
    pub fn with_command(command: impl Into<String>) -> Self {
        Self {
            codex_command: Some(command.into()),
            ..Self::new()
        }
    }

    /// The spawned app-server's pid, if running (test observability).
    pub async fn child_pid(&self) -> Option<u32> {
        self.state.lock().await.as_ref().and_then(|s| s.child.id())
    }

    /// The ownership metadata recorded at adopt time (in-memory until S5's durability
    /// store lands; see the module docs).
    pub fn adopted_metadata(&self) -> Option<(String, u64)> {
        self.adopted_metadata.lock().unwrap().clone()
    }

    fn resolved_command(&self) -> String {
        self.codex_command
            .clone()
            .or_else(|| std::env::var("CODEX_CMD").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "codex".to_string())
    }
}

/// Allocate a loopback ephemeral port (`allocateLocalhostPort`-shaped: bind
/// `127.0.0.1:0`, read the assigned port, release). Never a fixed port.
fn allocate_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("loopback port allocation failed: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("loopback port allocation failed: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn drain_child_io(child: &mut tokio::process::Child) {
    if let Some(mut stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        });
    }
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
    }
}

impl CodexLaunchRuntime for SpawnedCodexAppServerRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.as_ref() {
                return Ok(CodexRuntimeReady {
                    ws_url: existing.ws_url.clone(),
                });
            }

            let port = allocate_loopback_port()?;
            let ws_url = format!("ws://127.0.0.1:{port}");
            let ownership_id = mint_ownership_id();
            let spec = codex_sidecar_spawn_spec(&ws_url, &ownership_id);

            let command = self.resolved_command();
            let mut parts = command.split_whitespace();
            let program = parts.next().unwrap_or("codex").to_string();
            let leading_args: Vec<String> = parts.map(str::to_string).collect();

            let mut cmd = tokio::process::Command::new(&program);
            cmd.args(&leading_args);
            cmd.args(&spec.args);
            if let Some(cwd) = cwd.as_deref() {
                cmd.current_dir(cwd);
            }
            for (key, value) in &spec.env {
                cmd.env(key, value);
            }
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            cmd.kill_on_drop(true);

            let mut child = cmd
                .spawn()
                .map_err(|error| format!("codex app-server spawn failed ({command}): {error}"))?;
            drain_child_io(&mut child);

            // Wait for the listener: probe-dial until accepted or the budget expires.
            let deadline = tokio::time::Instant::now() + self.start_budget;
            loop {
                match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((probe, _)) => {
                        drop(probe);
                        break;
                    }
                    Err(error) => {
                        if let Ok(Some(status)) = child.try_wait() {
                            reap_owned_codex_sidecars(&ownership_id);
                            return Err(format!(
                                "codex app-server exited before listening: {status}"
                            ));
                        }
                        if tokio::time::Instant::now() >= deadline {
                            let _ = child.start_kill();
                            reap_owned_codex_sidecars(&ownership_id);
                            return Err(format!("codex app-server WS never came up: {error}"));
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }

            *state = Some(SpawnedSidecar {
                ws_url: ws_url.clone(),
                ownership_id,
                child,
            });
            Ok(CodexRuntimeReady { ws_url })
        })
    }

    fn update_ownership_metadata(
        &self,
        terminal_id: String,
        generation: u64,
    ) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            *self.adopted_metadata.lock().unwrap() = Some((terminal_id, generation));
            Ok(())
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if let Some(mut spawned) = state.take() {
                let _ = spawned.child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), spawned.child.wait()).await;
                reap_owned_codex_sidecars(&spawned.ownership_id);
            }
            Ok(())
        })
    }
}

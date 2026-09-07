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
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::mpsc;

use crate::app_server::BoxFuture;
use crate::durability::{default_server_instance_id, mint_ownership_id};
use crate::launch_plan::{
    codex_sidecar_spawn_spec, plan_codex_launch, plan_codex_launch_retry, CodexLaunchConfigError,
    CodexLaunchPlan, CodexLaunchPlanInput, CodexLaunchRetryDecision,
    CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
};
use crate::remote_proxy::{CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent};
use crate::runtime_select::select_codex_runtime;
use crate::sidecar_reconcile::{codex_sidecar_reconciler, write_record_loudly};
use crate::sidecar_store::{
    codex_sidecar_store, proc_cmdline, proc_starttime, CodexSidecarRecord, CodexSidecarStore,
    SidecarRecordState, SIDECAR_RECORD_VERSION,
};
use crate::transport::reap_owned_codex_sidecars;

/// `assertAcceptingPlans` (`launch-planner.ts:199`), byte-identical.
pub const CODEX_LAUNCH_PLANNER_SHUTDOWN_MESSAGE: &str =
    "Codex launch planner is shutting down; new Codex launch plans are not accepted.";

/// `assertAdoptable` (`launch-planner.ts:227`), byte-identical.
pub const CODEX_SIDECAR_NOT_ADOPTABLE_MESSAGE: &str =
    "Codex launch sidecar is shutting down; it cannot be adopted.";

/// How long a spawned app-server gets to bring its WS listener up — the shared
/// sidecar-spawn budget (S5.d.1 unification; also `freshell-freshagent`'s spawn).
pub const SIDECAR_START_BUDGET: Duration = Duration::from_secs(45);

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

    /// Task 4: note the codex session/thread id once it is known — resume
    /// launches at plan time, fresh launches when the proxy captures the
    /// thread candidate. Default no-op: only runtimes with a durable sidecar
    /// record have anything to enrich.
    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        let _ = session_id;
        Box::pin(async { Ok(()) })
    }

    /// Task 10: server-shutdown retention — the runtime is asked to KEEP its
    /// sidecar alive across the restart (record flipped to
    /// `Retained{reason}`, process never signalled) instead of tearing it
    /// down. Default no-op `Ok(())` (the `note_session_id` pattern): only
    /// runtimes with a durable sidecar record have anything to retain. The
    /// retention gate lives in the real impls — a runtime whose sidecar has
    /// NO persisted record (disabled store / non-Linux) MUST tear down
    /// exactly as `shutdown` would; "retaining" a record-less sidecar would
    /// orphan it silently (the ynfn hole).
    fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>> {
        let _ = reason;
        Box::pin(async { Ok(()) })
    }

    /// Tear the app-server down (`runtime.shutdown()`, `launch-planner.ts:302`).
    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>>;
}

/// The planner's runtime factory (`CodexLaunchPlanner` ctor `runtimeOrFactory`,
/// `launch-planner.ts:115-121`): one fresh runtime per plan. Plan-aware and
/// async (Task 7): the factory receives the S3 pure plan and returns a boxed
/// future that async [`CodexLaunchPlanner::plan_create`] AWAITS — the
/// production selection ([`crate::runtime_select::select_codex_runtime`])
/// must await the reconciler's claim
/// ([`crate::sidecar_reconcile::SidecarReconciler::claim_for_session`],
/// whose duplicate arm runs a bounded ws writer probe) before deciding
/// reattach-vs-spawn.
pub type CodexRuntimeFactory = Box<
    dyn for<'a> Fn(
            &'a CodexLaunchPlan,
        )
            -> Pin<Box<dyn Future<Output = Arc<dyn CodexLaunchRuntime>> + Send + 'a>>
        + Send
        + Sync,
>;

// ─── errors ──────────────────────────────────────────────────────────────────────────────

/// Which class of caller is asking for a codex launch plan (graceful
/// restore/resume S1, spec P2 — docs/plans/2026-07-30-graceful-restore-resume.md).
/// `Interactive` keeps the D-C-REVISIT fail-fast: a human is actively
/// waiting, so loud-at-30s is defensible. `Restore` is the bounce-restore
/// fleet: anticipatable contention must never kill it (the D-GATE-SOFT
/// generalization), so it queues cancel-aware with no wall-clock death —
/// the wait is bounded structurally (queue depth x per-plan attempt budget;
/// honest worst case ~251s/plan, ~2.2h for a full 64-deep queue — see the
/// D-C-REVISIT block below) and by cancellation (disconnect/shutdown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchClass {
    Interactive,
    Restore,
}

/// A launch-planning failure, split exactly the way the retry policy needs
/// (`launch-retry.ts:35`: config errors are never retried).
#[derive(Debug)]
pub enum CodexLaunchError {
    /// Non-retryable configuration error (invalid sandbox, `codex-launch-config.ts`).
    Config(CodexLaunchConfigError),
    /// Retryable launch failure (runtime/proxy IO, planner shutdown).
    Failed(String),
    /// Restore-class plan queue overflow (more than the configured cap of
    /// waiters). The true backpressure backstop: the WS door maps it to
    /// RATE_LIMITED (frozen-client ladder absorbs it), the REST door to 429.
    QueueFull,
    /// The restore-class caller's cancel watch fired (or its sender dropped)
    /// while queued — the client is gone (disconnect/shutdown). Never
    /// user-visible: callers abandon silently.
    Cancelled,
}

impl std::fmt::Display for CodexLaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexLaunchError::Config(error) => f.write_str(&error.message),
            CodexLaunchError::Failed(message) => f.write_str(message),
            CodexLaunchError::QueueFull => {
                f.write_str("codex plan queue full; too many queued codex launches")
            }
            CodexLaunchError::Cancelled => f.write_str("codex launch planning cancelled"),
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

    /// S5.c: forward the persistence release to the live proxy's identity gate.
    /// No-op once the proxy is torn down.
    pub async fn mark_candidate_persisted(&self) {
        if let Some(proxy) = self.inner.lock().await.proxy.as_ref() {
            proxy.mark_candidate_persisted();
        }
    }

    /// S5.c: forward a capture failure (candidate refused by identity guards).
    pub async fn fail_candidate_capture(&self, message: &str) {
        if let Some(proxy) = self.inner.lock().await.proxy.as_ref() {
            proxy.fail_candidate_capture(message);
        }
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

    /// Task 10 server-shutdown retention: close the proxy (its listener dies
    /// with this process anyway) and ask the runtime to
    /// `prepare_retention(reason)` INSTEAD of tearing it down. Marks the
    /// sidecar shutdown-complete so any late teardown path (a double-fired
    /// PTY exit hook, `manager.shutdown()`'s drain) no-ops via the
    /// idempotence flag instead of re-killing the retained survivor. The
    /// retention GATE lives in the runtime: a record-less runtime tears its
    /// sidecar down exactly as today.
    pub async fn retain(&self, reason: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.shutdown_succeeded {
            return Ok(());
        }
        inner.shutdown_started = true;
        if let Some(proxy) = inner.proxy.take() {
            proxy.close().await;
        }
        let result = self.runtime.prepare_retention(reason.to_string()).await;
        // Final-review H3c: the retention DECISION stands even when the
        // record rewrite fails (prepare_retention already logs loudly): mark
        // shutdown-complete either way, so a later shutdown() (a double-fired
        // PTY exit hook, `manager.shutdown()`'s drain) can never kill a
        // sidecar we chose to retain.
        inner.shutdown_succeeded = true;
        self.planner_active.lock().unwrap().remove(&self.id);
        result
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

        let runtime = (self.runtime_factory)(&plan).await;
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
                // Task 4: resume launches know their session id at plan time —
                // note it so the runtime's durable record carries the
                // restore-time reattach key. Best-effort (the record write
                // path logs its own failures); never fails the plan.
                if let Some(sid) = plan.session_id.clone() {
                    let _ = runtime.note_session_id(sid).await;
                }
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

/// S5.a: one proxy event, tagged with its adopting terminal.
#[derive(Debug)]
pub struct TerminalProxyEvent {
    pub terminal_id: String,
    /// The plan's create cwd (`CodexLaunchPlan.runtime_cwd`) — the identity
    /// adoption tail's cwd hint.
    pub cwd: Option<String>,
    pub event: RemoteProxyEvent,
}

/// S5.d.2 DECISION (recorded): the manager stays a process-global singleton.
/// Instead of DI'ing the 12 `::global()` call sites, freshell-ws installs this
/// set-once sink at boot (the spawn-gate set-once-handle precedent) and runs
/// the WsState-aware router on its far side. The drain task itself never
/// needs WsState, so no singleton→DI conversion is required.
static PROXY_EVENT_SINK: Mutex<Option<mpsc::UnboundedSender<TerminalProxyEvent>>> =
    Mutex::new(None);

/// Install the process-wide proxy-event sink. Called exactly once at server
/// boot (before any codex terminal can be adopted); later calls replace the
/// sink (test affordance).
pub fn set_codex_proxy_event_sink(tx: mpsc::UnboundedSender<TerminalProxyEvent>) {
    *PROXY_EVENT_SINK.lock().unwrap() = Some(tx);
}

fn codex_proxy_event_sink() -> Option<mpsc::UnboundedSender<TerminalProxyEvent>> {
    PROXY_EVENT_SINK.lock().unwrap().clone()
}

/// S5.a: the ONE per-terminal drain task, spawned at adopt (covers all three
/// adopt sites: WS create, WS auto-resume respawn, REST /api/tabs). Ends when
/// the proxy's event senders drop (sidecar shutdown) or the sink closes.
fn spawn_proxy_event_drain(
    terminal_id: String,
    cwd: Option<String>,
    mut events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    sink: Option<mpsc::UnboundedSender<TerminalProxyEvent>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            let Some(sink) = sink.as_ref() else {
                // No consumer installed (tests / bare servers): drop, matching
                // the pre-S5 parked-receiver behavior.
                continue;
            };
            if sink
                .send(TerminalProxyEvent {
                    terminal_id: terminal_id.clone(),
                    cwd: cwd.clone(),
                    event,
                })
                .is_err()
            {
                break;
            }
        }
    })
}

struct AdoptedTerminalLaunch {
    sidecar: Arc<CodexLaunchSidecar>,
    /// S5.a: the per-terminal proxy-event drain. Ends on its own when the
    /// proxy's senders drop; aborted by the teardown worker as a belt.
    drain: tokio::task::JoinHandle<()>,
}

/// D-C-REVISIT — SUPERSEDED IN PART (2026-07-30, graceful restore/resume S1;
/// spec docs/plans/2026-07-30-graceful-restore-resume.md §9.2): the
/// concurrency bound of 2 STANDS (a burst may never stack ~226s plan holds —
/// the half of the 2026-07-30 resolution that mattered). The fail-fast half
/// is superseded for `LaunchClass::Restore`: the S5.e flag-flip bounce
/// analysis is the revisit evidence (tabs 3+ died at >=5 codex tabs), so
/// restore-class waiters now QUEUE cancel-aware with no wall-clock death,
/// bounded by the plan queue cap below. `LaunchClass::Interactive` (WS
/// interactive, REST /api/tabs, auto-resume respawn) keeps the 30s fail-fast.
/// Honest arithmetic (V3 bounded-hold audit): worst-case per-plan hold
/// ~251s (5 attempts x (45s probe budget + 5s teardown) + 1s retry sleeps),
/// so a full 64-deep restore queue drains worst-case in ~2.2h, and an
/// Interactive waiter behind K queued restores waits ~ceil(K/2) x T
/// (T = healthy plan time, seconds).
pub const CODEX_SIDECAR_PLAN_CONCURRENCY: usize = 2;
pub const CODEX_SIDECAR_PLAN_WAIT: Duration = Duration::from_secs(30);

/// Env knob for the restore-class plan queue cap. Mirrors
/// `FRESHELL_SPAWN_GATE_QUEUE_CAP` semantics (create_limit.rs): unset,
/// `0`, or non-numeric fall back to the default.
pub const FRESHELL_CODEX_PLAN_QUEUE_CAP_ENV: &str = "FRESHELL_CODEX_PLAN_QUEUE_CAP";
const CODEX_PLAN_QUEUE_CAP_DEFAULT: usize = 64;

fn plan_queue_cap_from_env() -> usize {
    std::env::var(FRESHELL_CODEX_PLAN_QUEUE_CAP_ENV)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(CODEX_PLAN_QUEUE_CAP_DEFAULT)
}

/// Cancel-safe accounting for the restore-class plan queue depth: the
/// decrement lives in Drop so success, cancellation, and futures dropped
/// mid-wait all reclaim the slot (the SpawnGate::WaitingGuard discipline,
/// crates/freshell-freshagent/src/spawn_gate.rs:80-87).
struct PlanWaitingGuard<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for PlanWaitingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

static GLOBAL_MANAGER: OnceLock<CodexTerminalLaunchManager> = OnceLock::new();

/// Test-only global installer (mirrors the `set_codex_proxy_event_sink`
/// seam): lets integration suites make [`CodexTerminalLaunchManager::global`]
/// resolve to a manager over a fake runtime. Set-once: returns `false` (and
/// installs nothing) if the global was already initialized. Production code
/// must never call this.
pub fn set_global_codex_launch_manager_for_tests(manager: CodexTerminalLaunchManager) -> bool {
    GLOBAL_MANAGER.set(manager).is_ok()
}

/// The shared `resolve_codex_launch` seam (spec §5 Slice 4): plan → adopt-by-terminal-id →
/// teardown-on-terminal-exit, used by BOTH the WS `terminal.create` codex branch and the
/// REST `/api/tabs` codex branch. Teardown is decoupled from the (sync) PTY exit hook via
/// an unbounded channel + a worker task.
pub struct CodexTerminalLaunchManager {
    planner: CodexLaunchPlanner,
    adopted: Mutex<HashMap<String, AdoptedTerminalLaunch>>,
    /// Teardown/retention worker feed: the bool is the RETAIN decision,
    /// made by the sender at hand-off time (Task 10).
    teardown_tx: OnceLock<mpsc::UnboundedSender<(AdoptedTerminalLaunch, bool)>>,
    /// Task 10: server-shutdown retention mode — set once by
    /// [`Self::begin_shutdown_retention`], never cleared (the process is
    /// exiting).
    shutdown_retention: AtomicBool,
    plan_budget: Arc<tokio::sync::Semaphore>,
    plan_budget_wait: Duration,
    plan_queue_cap: usize,
    plan_waiting: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

/// The durable `Retained{reason}` every server-shutdown retention records
/// (both [`CodexTerminalLaunchManager::shutdown`]'s drain and the retention
/// arm of the PTY exit hook).
const SERVER_SHUTDOWN_RETENTION_REASON: &str = "server-shutdown";

impl CodexTerminalLaunchManager {
    pub fn new(runtime_factory: CodexRuntimeFactory) -> Self {
        Self {
            planner: CodexLaunchPlanner::new(runtime_factory),
            adopted: Mutex::new(HashMap::new()),
            teardown_tx: OnceLock::new(),
            shutdown_retention: AtomicBool::new(false),
            plan_budget: Arc::new(tokio::sync::Semaphore::new(CODEX_SIDECAR_PLAN_CONCURRENCY)),
            plan_budget_wait: CODEX_SIDECAR_PLAN_WAIT,
            // The env read MUST live here — `global()` calls `new()`, so
            // `with_plan_budget` alone would never reach production.
            plan_queue_cap: plan_queue_cap_from_env(),
            plan_waiting: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// Test/DI constructor with an explicit sidecar planning budget.
    pub fn with_plan_budget(
        runtime_factory: CodexRuntimeFactory,
        concurrency: usize,
        wait: Duration,
        queue_cap: usize,
    ) -> Self {
        let mut manager = Self::new(runtime_factory);
        manager.plan_budget = Arc::new(tokio::sync::Semaphore::new(concurrency));
        manager.plan_budget_wait = wait;
        manager.plan_queue_cap = queue_cap;
        manager
    }

    /// Current depth of the restore-class plan queue (waiters parked on the
    /// budget). Observability for tests and diagnostics.
    pub fn plan_queue_depth(&self) -> usize {
        self.plan_waiting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The process-wide manager over the REAL selection — legacy has exactly one
    /// `CodexLaunchPlanner` per server (`server/index.ts:359`). Task 7: the
    /// factory dispatches through [`select_codex_runtime`] — a claimable
    /// verified survivor for a resume plan reattaches
    /// ([`crate::sidecar_reconcile::ReattachedCodexAppServerRuntime`]); every
    /// other plan (and a `None` reconciler/store — nothing installed at boot)
    /// gets the spawn runtime, exactly the pre-Task-7 behavior.
    pub fn global() -> &'static CodexTerminalLaunchManager {
        GLOBAL_MANAGER.get_or_init(|| {
            CodexTerminalLaunchManager::new(Box::new(|plan| {
                Box::pin(async move {
                    select_codex_runtime(
                        codex_sidecar_reconciler().as_ref(),
                        codex_sidecar_store().as_ref(),
                        plan,
                    )
                    .await
                })
            }))
        })
    }

    /// Must be called from async (tokio) context; the teardown worker is spawned lazily
    /// here so [`CodexTerminalLaunchManager::notify_terminal_exit`] can stay sync-safe.
    ///
    /// Budget semantics by class (graceful restore/resume S1, P2):
    /// - `Interactive`: today's fail-fast, unchanged — the 30s wait races the
    ///   semaphore; on loss the caller gets the loud budget-exhausted error.
    /// - `Restore`: queue cancel-aware with NO wall-clock death. Bounded
    ///   structurally (restore storms are known-finite: N panes existed, N
    ///   restores arrive, the queue drains N; per-plan hold worst ~251s,
    ///   full 64-deep queue worst ~2.2h — see the D-C-REVISIT block) and by
    ///   the queue cap (overflow => QueueFull, the backpressure backstop).
    pub async fn plan_create_with_retry(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
        class: LaunchClass,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        use std::sync::atomic::Ordering;
        self.ensure_teardown_worker();
        let _budget = match class {
            LaunchClass::Interactive => {
                match tokio::time::timeout(
                    self.plan_budget_wait,
                    self.plan_budget.clone().acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        return Err(CodexLaunchError::Failed(
                            "codex sidecar planning budget exhausted; too many concurrent codex launches"
                                .to_string(),
                        ))
                    }
                }
            }
            LaunchClass::Restore => {
                if *cancel.borrow() {
                    return Err(CodexLaunchError::Cancelled);
                }
                // Fast path mirrors SpawnGate::acquire: tokio's fair semaphore
                // fails try_acquire while waiters queue, so no barging.
                match self.plan_budget.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let waiting_before = self.plan_waiting.fetch_add(1, Ordering::SeqCst);
                        if waiting_before >= self.plan_queue_cap {
                            self.plan_waiting.fetch_sub(1, Ordering::SeqCst);
                            tracing::warn!(
                                target: "freshell_codex::launch",
                                waiting = waiting_before,
                                queue_cap = self.plan_queue_cap,
                                "codex_plan_queue_full"
                            );
                            return Err(CodexLaunchError::QueueFull);
                        }
                        let _waiting_guard = PlanWaitingGuard(&self.plan_waiting);
                        tokio::select! {
                            acquired = self.plan_budget.clone().acquire_owned() => match acquired {
                                Ok(permit) => permit,
                                // Semaphore closed = planner shutdown.
                                Err(_) => return Err(CodexLaunchError::Failed(
                                    "codex launch planner is shut down".to_string(),
                                )),
                            },
                            // Ok(()) = the watch changed (we only ever send true);
                            // Err(_) = the sender dropped (connection loop exited).
                            // Both mean this waiter's client is gone: cancel.
                            _ = cancel.changed() => {
                                tracing::info!(
                                    target: "freshell_codex::launch",
                                    "codex_plan_wait_cancelled"
                                );
                                return Err(CodexLaunchError::Cancelled);
                            }
                        }
                    }
                }
            }
        };
        self.planner
            .plan_create_with_retry(input, attempts, CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS)
            .await
    }

    /// No-cancel doors — WS interactive create, REST /api/tabs, auto-resume
    /// respawn. The never-fired watch lives HERE, not at call sites (the
    /// kata bccd discipline the spawn gate's `acquire_uncancellable` set).
    pub async fn plan_create_with_retry_uncancellable(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
        class: LaunchClass,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        self.plan_create_with_retry(input, attempts, class, &mut cancel_rx)
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
        // S5.d.3 DECISION (recorded): `launch.plan.binding_reason` is
        // deliberately DROPPED here — the identity tail derives adopt-vs-rebind
        // from context, and no Rust wire frame carries sessionBindingReason.
        // See CodexLaunchPlan::binding_reason's doc.
        let drain = spawn_proxy_event_drain(
            terminal_id.to_string(),
            launch.plan.runtime_cwd.clone(),
            launch.events,
            codex_proxy_event_sink(),
        );
        self.adopted.lock().unwrap().insert(
            terminal_id.to_string(),
            AdoptedTerminalLaunch {
                sidecar: launch.sidecar,
                drain,
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

    /// [`Self::discard`] for sync contexts (RAII Drop guards): fire-and-forget
    /// the sidecar teardown on the runtime. Same best-effort semantics —
    /// teardown errors are swallowed; the create failure the caller is
    /// surfacing (or the silent cancel) is the primary event.
    ///
    /// A8 hardening (V4): `tokio::spawn` PANICS when no ambient runtime
    /// exists, and this fn is called from Drop (`PreparedCodexLaunch`),
    /// where panicking is never acceptable (double-panic abort during
    /// unwind). Spawn only when a handle exists; otherwise degrade to a
    /// best-effort SYNCHRONOUS kill of the sidecar child (or, if no sync
    /// kill seam is reachable from here, `tracing::warn!` and leak) —
    /// NEVER panic.
    pub fn discard_sync(&self, launch: CodexTerminalLaunch) {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    let _ = launch.sidecar.shutdown().await;
                });
            }
            Err(_) => {
                // No runtime (e.g. Drop during unwind after runtime
                // teardown): no sync kill seam is reachable from here — the
                // sidecar's shutdown path is async-only (`CodexLaunchRuntime::
                // shutdown` returns a future, and the runtime handle lives
                // behind an async mutex) — so log-and-leak. Leaking is
                // acceptable; panicking is not.
                tracing::warn!(
                    target: "freshell_codex::launch",
                    "discard_sync outside runtime context; best-effort kill/leak"
                );
            }
        }
    }

    /// S5.c: release the candidate-persistence gate for an adopted terminal's
    /// proxy. Called by the freshell-ws proxy-event router after
    /// `adopt_codex_identity` returned true (the ledger write is awaited inside
    /// that tail — fsync-before-announce IS the "persisted" signal). Idempotent;
    /// unknown terminals are a silent no-op (legacy has five release sites, most
    /// of them dedupe paths — this single seam is called on every candidate
    /// re-observation too).
    pub async fn mark_candidate_persisted(&self, terminal_id: &str) {
        let sidecar = {
            self.adopted
                .lock()
                .unwrap()
                .get(terminal_id)
                .map(|entry| entry.sidecar.clone())
        };
        if let Some(sidecar) = sidecar {
            sidecar.mark_candidate_persisted().await;
        }
    }

    /// Task 4: forward a captured codex session/thread id to an adopted
    /// terminal's runtime so its durable sidecar record carries the
    /// restore-time reattach key (katas ynfn/da92). Called by the freshell-ws
    /// proxy-event router beside [`Self::mark_candidate_persisted`]; resume
    /// launches get theirs at plan time instead. Unknown terminal ids are a
    /// silent no-op (the mark_candidate_persisted discipline).
    pub async fn note_session_id(&self, terminal_id: &str, session_id: &str) {
        let runtime = {
            self.adopted
                .lock()
                .unwrap()
                .get(terminal_id)
                .map(|entry| entry.sidecar.runtime.clone())
        };
        if let Some(runtime) = runtime {
            let _ = runtime.note_session_id(session_id.to_string()).await;
        }
    }

    /// S5.c: fail the gate for an adopted terminal (candidate refused).
    pub async fn fail_candidate_capture(&self, terminal_id: &str, message: &str) {
        let sidecar = {
            self.adopted
                .lock()
                .unwrap()
                .get(terminal_id)
                .map(|entry| entry.sidecar.clone())
        };
        if let Some(sidecar) = sidecar {
            sidecar.fail_candidate_capture(message).await;
        }
    }

    /// Server-shutdown mode: adopted (terminal-owned) sidecars are RETAINED
    /// across the restart — proxies close, runtimes are asked to
    /// prepare_retention(reason) instead of shutdown. Unadopted planner
    /// sidecars (mid-plan) are still torn down. Call BEFORE registry.kill_all()
    /// so PTY-exit hooks (notify_terminal_exit) also retain instead of reap.
    pub fn begin_shutdown_retention(&self) {
        self.shutdown_retention.store(true, Ordering::SeqCst);
    }

    /// Sync-safe (callable from the PTY exit hook's non-async thread): detach the
    /// terminal's launch and hand it to the teardown worker. No-op for terminals without
    /// a managed launch. Task 10: under server-shutdown retention
    /// ([`Self::begin_shutdown_retention`] runs BEFORE `registry.kill_all()`,
    /// so every shutdown-driven exit sees the flag set) the entry is routed
    /// through retention instead of teardown.
    pub fn notify_terminal_exit(&self, terminal_id: &str) {
        let Some(entry) = self.adopted.lock().unwrap().remove(terminal_id) else {
            return;
        };
        let retain = self.shutdown_retention.load(Ordering::SeqCst);
        if let Some(tx) = self.teardown_tx.get() {
            let _ = tx.send((entry, retain));
        }
    }

    /// Server-exit teardown (main.rs graceful shutdown): mirrors legacy's close-time
    /// `codexLaunchPlanner.shutdown()` (`server/index.ts:981-1049` shutdown owners) —
    /// the planner stops accepting plans and tears down its unadopted sidecars
    /// unconditionally (they have no pane to reattach to, and a fresh-plan proxy may
    /// hold the candidate timer) — PLUS the adopted (terminal-owned) launches this
    /// manager keys. Task 10: with [`Self::begin_shutdown_retention`] set, adopted
    /// entries get proxy-close + `prepare_retention("server-shutdown")` instead of
    /// teardown (kata ynfn: surviving restarts is a feature); the runtime-level
    /// retention gate still tears down record-less sidecars exactly as today. Exit
    /// hooks may also route the same entries; retain/shutdown share the sidecar's
    /// idempotence flag, so both paths stay safe.
    pub async fn shutdown(&self) {
        self.planner.shutdown().await;
        let retain = self.shutdown_retention.load(Ordering::SeqCst);
        let adopted: Vec<AdoptedTerminalLaunch> = {
            let mut map = self.adopted.lock().unwrap();
            map.drain().map(|(_, entry)| entry).collect()
        };
        for entry in adopted {
            if retain {
                let _ = entry.sidecar.retain(SERVER_SHUTDOWN_RETENTION_REASON).await;
            } else {
                let _ = entry.sidecar.shutdown().await;
            }
            entry.drain.abort();
        }
    }

    fn ensure_teardown_worker(&self) {
        self.teardown_tx.get_or_init(|| {
            let (tx, mut rx) = mpsc::unbounded_channel::<(AdoptedTerminalLaunch, bool)>();
            tokio::spawn(async move {
                while let Some((entry, retain)) = rx.recv().await {
                    if retain {
                        let _ = entry.sidecar.retain(SERVER_SHUTDOWN_RETENTION_REASON).await;
                    } else {
                        let _ = entry.sidecar.shutdown().await;
                    }
                    entry.drain.abort();
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
    /// The durable record written at spawn (tracked spawns only) — kept so
    /// `update_ownership_metadata` can enrich + rewrite it without a re-read.
    record: Option<CodexSidecarRecord>,
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
    /// Durable sidecar record store (Task 3). Production resolves the
    /// process-global handle ([`crate::sidecar_store::set_codex_sidecar_store`],
    /// wired at boot in Task 10); absent global ⇒ disabled store ⇒ behavior
    /// identical to the pre-store world (attached `kill_on_drop(true)` spawn,
    /// no record).
    store: Arc<CodexSidecarStore>,
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
    /// interpreter-plus-script support) falling back to `codex`. The record
    /// store resolves from the process-global handle; absent ⇒ disabled.
    pub fn new() -> Self {
        Self {
            codex_command: None,
            start_budget: SIDECAR_START_BUDGET,
            store: codex_sidecar_store().unwrap_or_else(|| Arc::new(CodexSidecarStore::disabled())),
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

    /// Explicit command AND store injection (tests: a lock-free store over a
    /// tempdir) — per-instance, never the process-global handle.
    pub fn with_command_and_store(
        command: impl Into<String>,
        store: Arc<CodexSidecarStore>,
    ) -> Self {
        Self {
            codex_command: Some(command.into()),
            store,
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

    /// Remove the durable record after teardown/failure reaping. Idempotent
    /// (missing rows are `Ok`); failures are logged loudly, never propagated —
    /// the reap already happened, so the worst case is a stale row the boot
    /// reconciler re-verifies (and finds Dead) later.
    fn scrub_record(&self, ownership_id: &str) {
        if let Err(error) = self.store.remove(ownership_id) {
            tracing::error!(
                target: "freshell_codex::launch",
                ownership_id = %ownership_id,
                error = %error,
                "sidecar_record_remove_failed: stale row left for boot reconcile"
            );
        }
    }
}

/// Wall-clock unix millis for record `created_at`/`updated_at` stamps.
fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Allocate a loopback ephemeral port (`allocateLocalhostPort`-shaped: bind
/// `127.0.0.1:0`, read the assigned port, release). Never a fixed port. Shared
/// sidecar-spawn mechanics (S5.d.1 unification; also `freshell-freshagent`'s spawn).
pub fn allocate_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("loopback port allocation failed: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("loopback port allocation failed: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Drain the child's piped stdout/stderr to a sink so verbose app-server logs never
/// back-pressure it. Shared sidecar-spawn mechanics (S5.d.1 unification; also
/// `freshell-freshagent`'s spawn).
pub fn drain_child_io(child: &mut tokio::process::Child) {
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

            // Detach CONDITIONALLY — only when the sidecar will actually be
            // TRACKED (kata ynfn: "surviving restarts is a feature"; Node
            // parity: `detached: true`, runtime.ts:1828-1843). The store
            // record now plays the safety-net role kill_on_drop played: an
            // unclean server death leaves a tracked record for boot
            // reconciliation (Tasks 5/9). A sidecar with NO record must keep
            // the kill_on_drop backstop — detaching it would be the
            // silently-orphaned ynfn hole with no reconcile path — and
            // non-Linux identity can never be /proc-verified, so a detached
            // sidecar there would be untracked AND unreapable.
            let detach = cfg!(target_os = "linux") && self.store.is_enabled();
            if detach {
                cmd.kill_on_drop(false);
                // `tokio::process::Command::process_group` is Unix-only, so
                // the call must stay cfg-gated even though detach is
                // Linux-only today — keeps any non-Unix build compiling.
                #[cfg(unix)]
                cmd.process_group(0);
            } else {
                cmd.kill_on_drop(true);
            }

            let mut child = cmd
                .spawn()
                .map_err(|error| format!("codex app-server spawn failed ({command}): {error}"))?;
            drain_child_io(&mut child);

            // Wait for the listener: probe-dial until accepted or the budget expires.
            let deadline = tokio::time::Instant::now() + self.start_budget;
            loop {
                // A6 fix (V3 bounded-hold audit, reports/V3-bounded-holds.md §A6): the 45s
                // SIDECAR_START_BUDGET was only checked in the Err arm — an
                // individual `connect_async` has NO deadline of its own (TCP connect +
                // HTTP upgrade + response read), so a child that binds/listens but stalls
                // the WS handshake parks this await FOREVER, permanently losing 1 of the
                // 2 plan permits (uncancellable: cancellation covers only the queue wait,
                // never the held plan). Timeout-per-probe restores the structural bound.
                let remaining = deadline
                    .checked_duration_since(tokio::time::Instant::now())
                    .unwrap_or(Duration::ZERO);
                let probe_error = match tokio::time::timeout(
                    remaining,
                    tokio_tungstenite::connect_async(&ws_url),
                )
                .await
                {
                    Ok(Ok((probe, _))) => {
                        drop(probe);
                        break;
                    }
                    // Failed probe and stalled-handshake probe take the SAME path:
                    // the existing child-exit check, deadline check (now guaranteed
                    // reached), and 100ms retry sleep run unchanged below.
                    Ok(Err(error)) => error.to_string(),
                    Err(_elapsed) => "probe timed out awaiting the WS handshake".to_string(),
                };
                if let Ok(Some(status)) = child.try_wait() {
                    reap_owned_codex_sidecars(&ownership_id);
                    self.scrub_record(&ownership_id);
                    return Err(format!(
                        "codex app-server exited before listening: {status}"
                    ));
                }
                if tokio::time::Instant::now() >= deadline {
                    let _ = child.start_kill();
                    reap_owned_codex_sidecars(&ownership_id);
                    self.scrub_record(&ownership_id);
                    return Err(format!("codex app-server WS never came up: {probe_error}"));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            // Persist the durable record for TRACKED spawns (Task 3): the
            // listener is up, so capture the child's /proc identity evidence
            // and write the row a restarted server reconciles against.
            // Untracked spawns (detach == false) skip the write — they keep
            // the kill_on_drop backstop and need no reconcile row.
            let mut record = None;
            if detach {
                match child.id() {
                    Some(pid) => {
                        // Fall back to the constructed argv if /proc is
                        // momentarily unreadable; a starttime of 0 can never
                        // match a live process, so the worst outcome is the
                        // conservative Mismatch (never signalled), not a
                        // wrong kill.
                        let constructed_cmdline: Vec<String> = std::iter::once(program.clone())
                            .chain(leading_args.iter().cloned())
                            .chain(spec.args.iter().cloned())
                            .collect();
                        let now = unix_millis();
                        let row = CodexSidecarRecord {
                            record_version: SIDECAR_RECORD_VERSION,
                            ownership_id: ownership_id.clone(),
                            pid,
                            starttime: proc_starttime(pid as i32).unwrap_or(0),
                            cmdline: proc_cmdline(pid as i32).unwrap_or(constructed_cmdline),
                            ws_url: ws_url.clone(),
                            session_id: None,
                            terminal_id: None,
                            server_instance_id: default_server_instance_id(),
                            created_at: now,
                            updated_at: now,
                            state: SidecarRecordState::Active,
                            lane: None,
                        };
                        // Write failures are logged LOUDLY, never abort the
                        // launch (the pane-ledger write-failure policy).
                        if let Err(error) = self.store.write(&row) {
                            tracing::error!(
                                target: "freshell_codex::launch",
                                ownership_id = %row.ownership_id,
                                pid = row.pid,
                                error = %error,
                                "sidecar_record_write_failed: spawn proceeds UNTRACKED \
                                 (detached; boot reconcile cannot see this sidecar)"
                            );
                        }
                        record = Some(row);
                    }
                    None => tracing::error!(
                        target: "freshell_codex::launch",
                        ownership_id = %ownership_id,
                        "sidecar_record_skipped: child pid unavailable after probe success"
                    ),
                }
            }

            *state = Some(SpawnedSidecar {
                ws_url: ws_url.clone(),
                ownership_id,
                child,
                record,
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
            *self.adopted_metadata.lock().unwrap() = Some((terminal_id.clone(), generation));
            // Enrich the durable record at adopt (Task 3): the terminal id is
            // what boot reconcile reports a surviving sidecar under.
            let mut state = self.state.lock().await;
            if let Some(record) = state.as_mut().and_then(|s| s.record.as_mut()) {
                record.terminal_id = Some(terminal_id);
                record.updated_at = unix_millis();
                if let Err(error) = self.store.write(record) {
                    tracing::error!(
                        target: "freshell_codex::launch",
                        ownership_id = %record.ownership_id,
                        error = %error,
                        "sidecar_record_enrich_failed: adopt proceeds; record keeps \
                         its spawn-time shape (pane-ledger write-failure policy)"
                    );
                }
            }
            Ok(())
        })
    }

    fn note_session_id(&self, session_id: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            // Enrich the durable record with the codex session/thread id
            // (Task 4): the restore-time reattach key boot reconcile matches
            // records against. Untracked spawns (no record) are a no-op.
            let mut state = self.state.lock().await;
            if let Some(record) = state.as_mut().and_then(|s| s.record.as_mut()) {
                record.session_id = Some(session_id);
                record.updated_at = unix_millis();
                if let Err(error) = self.store.write(record) {
                    tracing::error!(
                        target: "freshell_codex::launch",
                        ownership_id = %record.ownership_id,
                        error = %error,
                        "sidecar_record_enrich_failed: session id kept in memory only \
                         (pane-ledger write-failure policy)"
                    );
                }
            }
            Ok(())
        })
    }

    /// Task 10: server-shutdown retention. Tracked spawns (persisted record;
    /// `kill_on_drop(false)`, Task 3) flip their record to `Retained{reason}`
    /// and DROP the `Child` handle without a signal — the sidecar outlives
    /// this process and the record is what the next generation reconciles
    /// against. The retention GATE: a record-less spawn (disabled store /
    /// non-Linux ⇒ `kill_on_drop(true)`, NO record) is torn down exactly as
    /// [`Self::shutdown`] would — "retaining" it would orphan it silently
    /// with no reconcile path (the ynfn hole).
    fn prepare_retention(&self, reason: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            let Some(mut spawned) = state.take() else {
                return Ok(()); // never spawned / already torn down
            };
            match spawned.record.as_mut() {
                Some(record) => {
                    record.state = SidecarRecordState::Retained { reason };
                    record.updated_at = unix_millis();
                    // Write failures log loudly, never propagate (pane-ledger
                    // policy): the row stays Active on disk and boot
                    // reconcile still finds + re-verifies the survivor.
                    write_record_loudly(&self.store, record);
                    tracing::info!(
                        target: "freshell_codex::launch",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        "sidecar_retained: tracked sidecar left running across \
                         server shutdown (kata ynfn); record state = Retained"
                    );
                    // `spawned` drops at scope end: kill_on_drop is false for
                    // tracked spawns, so the child is released untouched.
                    Ok(())
                }
                None => {
                    // Record-less: the ynfn gate — teardown exactly as today.
                    let _ = spawned.child.start_kill();
                    let _ =
                        tokio::time::timeout(Duration::from_secs(5), spawned.child.wait()).await;
                    reap_owned_codex_sidecars(&spawned.ownership_id);
                    self.scrub_record(&spawned.ownership_id);
                    Ok(())
                }
            }
        })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if let Some(mut spawned) = state.take() {
                let _ = spawned.child.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(5), spawned.child.wait()).await;
                reap_owned_codex_sidecars(&spawned.ownership_id);
                // Explicit teardown scrubs the record (Task 3): a cleanly
                // shut-down sidecar must leave nothing for boot reconcile.
                self.scrub_record(&spawned.ownership_id);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drain_forwards_tagged_events_to_the_sink() {
        let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
        let (sink_tx, mut sink_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = spawn_proxy_event_drain(
            "term-1".to_string(),
            Some("/tmp/work".to_string()),
            proxy_rx,
            Some(sink_tx),
        );
        proxy_tx
            .send(crate::remote_proxy::RemoteProxyEvent::RepairTrigger(
                crate::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
            ))
            .unwrap();
        let tagged = tokio::time::timeout(std::time::Duration::from_secs(2), sink_rx.recv())
            .await
            .expect("drain must forward within 2s")
            .expect("sink open");
        assert_eq!(tagged.terminal_id, "term-1");
        assert_eq!(tagged.cwd.as_deref(), Some("/tmp/work"));
        assert!(matches!(
            tagged.event,
            crate::remote_proxy::RemoteProxyEvent::RepairTrigger(_)
        ));
        drop(proxy_tx); // senders gone -> drain exits
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("drain task must end when the proxy senders drop")
            .unwrap();
    }

    #[tokio::test]
    async fn drain_without_a_sink_discards_and_survives() {
        let (proxy_tx, proxy_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = spawn_proxy_event_drain("term-2".to_string(), None, proxy_rx, None);
        proxy_tx
            .send(crate::remote_proxy::RemoteProxyEvent::RepairTrigger(
                crate::remote_proxy::RemoteProxyRepairTrigger::ProxyClose,
            ))
            .unwrap();
        drop(proxy_tx);
        tokio::time::timeout(std::time::Duration::from_secs(2), handle)
            .await
            .expect("no-sink drain must still terminate")
            .unwrap();
    }
}

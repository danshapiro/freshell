//! Atomic session handoff (kata b8ke Task 6): one server-authoritative
//! operation that moves a canonical `(provider, sessionId)` between the
//! terminal lane and a fresh-agent runtime — enter Handoff (generation+1) →
//! broadcast → stop prior runtime → await confirmed reap → start/attach
//! target under the retained lease (under-ticket mode — no double commit) →
//! commit Live(targetKind) → broadcast owner identity. Failures are typed,
//! retryable, and restore the prior owner or leave Vacant; never a blank
//! session, never a second writer.
//!
//! Runs on a DETACHED task (the settle-task precedent, `terminal_tabs.rs`)
//! so a client disconnect cannot half-orphan it; an RAII guard fails the
//! coordinator entry if the task is cancelled or panics mid-flight — and
//! reaps a spawned-but-uncommitted target runtime (round-1 review:
//! cancellation-safety across the target-spawn window).
//!
//! Layering: `freshell-freshagent` never imports `freshell-ws`; the runner
//! holds clones of the three fresh states plus the shared terminal registry
//! and coordinator, minted in `freshell-server::main`.
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use freshell_ownership::{
    BeginOutcome, CommitOutcome, FailOutcome, ObservedFence, OwnerIdentity, RuntimeOwnerKind,
    RuntimeOwnershipRegistry,
};
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// The REST route this module serves.
pub(crate) const HANDOFF_ROUTE: &str = "/api/sessions/handoff";

/// Test-only injection (rides the constructor, never env — the
/// `spawn_auto_resume_hub_with_schedules` precedent). `events` records the
/// runner's step order (Reaped/TargetStarted) for ordering assertions.
pub struct HandoffTestHooks {
    /// Park the runner right after the coordinator enter (before the stop).
    pub pause_after_enter: Option<tokio::sync::Notify>,
    /// Park the runner after the TERMINAL prior's registry kill is ISSUED but
    /// before the dead-poll confirms it (round-3 review I-1: the prior-reap
    /// window's abort-test hold; terminal arm only — the fresh arm's hold is
    /// the lane-side `handoff_kill_pause` seam on `FreshClaudeState`).
    pub pause_after_terminal_prior_kill: Option<tokio::sync::Notify>,
    /// Park the under-ticket terminal-target SETTLE after it publishes the
    /// spawned terminal (round-3 review I-1: the target-spawn window's
    /// abort-test hold). The runner embeds this into the `HandoffSpawnWatch`
    /// it hands the settle.
    pub pause_in_target_spawn: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// b8ke ext r10 F3: park the under-ticket terminal-target settle
    /// BEFORE its publication point — the reviewer's exact pre-publication
    /// abort window (the cleanup's bounded settle-wait times out with
    /// nothing published). The runner embeds this into the
    /// `HandoffSpawnWatch` it hands the settle.
    pub pause_in_target_spawn_before_publish: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// The runner deposits the terminal-target spawn watch here at
    /// `start_target` entry, so a test can observe the settle's publication
    /// deterministically.
    pub spawn_watch_slot: std::sync::Mutex<Option<crate::terminal_tabs::HandoffSpawnWatch>>,
    /// Short-circuit `stop_runtime` to `ReapTimeout` WITHOUT issuing any
    /// kill — the deterministic reap-timeout test path (the prior stays
    /// exactly as alive as the test made it). Atomic so a test can clear it
    /// for the retry assertion.
    pub force_reap_timeout: std::sync::atomic::AtomicBool,
    /// b8ke d4 F1: short-circuit `stop_runtime` to the FENCED reap-timeout
    /// shape (`ReapTimeout { fenced: true }` — the kill was issued, its
    /// confirmation detached) and to the PlatformLimited teardown — the
    /// uncommitted-target consumption tests' deterministic outcomes. The
    /// SKIP counter is decremented per `stop_runtime` call and the forced
    /// outcome applies only once it reaches zero, so a test can pass the
    /// PRIOR stop normally (skip = 1) and force the TARGET reap (call 2).
    pub force_reap_timeout_fenced: std::sync::atomic::AtomicBool,
    pub force_reap_timeout_fenced_skip: std::sync::atomic::AtomicUsize,
    pub force_platform_limited: std::sync::atomic::AtomicBool,
    pub force_platform_limited_skip: std::sync::atomic::AtomicUsize,
    /// Force the atomic handoff capability preflight to refuse. This is a
    /// deterministic test seam for unsupported-platform behavior and is
    /// intentionally separate from the post-stop platform-limited seam.
    pub force_unsupported_preflight: std::sync::atomic::AtomicBool,
    /// b8ke focused review FR6: abort the detached reap-confirmation task
    /// at the NEXT watcher spawn — the injected REAL JoinError (cancelled)
    /// the watcher's fail-open typed release is tested against. Atomic so
    /// a test can arm it once.
    pub abort_reap_confirmation_once: std::sync::atomic::AtomicBool,
    /// b8ke focused round-5 review R5-1: make the NEXT abort-cleanup target
    /// reap DROP its `NotConfirmed` continuation (the lost-escalation
    /// shape) and answer `Unconfirmed` — the deterministic red/green for
    /// the no-prior abort path's replacement confirmation watcher. Atomic
    /// so a test can arm it once; never armed in production.
    pub drop_abort_target_confirmation_once: std::sync::atomic::AtomicBool,
    /// Make the NEXT `start_target` fail before spawning anything.
    pub fail_target_spawn_once: std::sync::atomic::AtomicBool,
    /// b8ke e4r2 F3: park `broadcast_failure_truth` BETWEEN its snapshot
    /// read and its frame send — the deterministic hold for the
    /// watcher-release race window (the test releases the detached
    /// watcher mid-window, so the stale failure frame would postcede the
    /// watcher's `released` frame). The ONCE flag parks only the FIRST
    /// send (the send-then-recheck regime's later rounds never park);
    /// PARKED flags the moment the hold engaged (the test's positive
    /// signal that the snapshot read already happened); never armed in
    /// production.
    pub pause_in_failure_truth_broadcast: Option<std::sync::Arc<tokio::sync::Notify>>,
    pub pause_in_failure_truth_once: std::sync::atomic::AtomicBool,
    pub pause_in_failure_truth_parked: std::sync::atomic::AtomicBool,
    /// b8ke e4r3 F1: park `broadcast_post_abort_authority` AT ENTRY —
    /// BEFORE its snapshot observe — the deterministic hold for the
    /// foreign-commit-during-the-abort-broadcast-window race (the test
    /// lets another device's claim commit while the queued abort
    /// broadcast waits). The ONCE flag parks only the first call; the
    /// PARKED flag signals the hold engaged; never armed in production.
    pub pause_post_abort_broadcast: Option<std::sync::Arc<tokio::sync::Notify>>,
    pub pause_post_abort_broadcast_once: std::sync::atomic::AtomicBool,
    pub pause_post_abort_broadcast_parked: std::sync::atomic::AtomicBool,
    /// Ordered step labels ("Reaped", "TargetStarted") — test assertions.
    pub events: std::sync::Mutex<Vec<&'static str>>,
}

impl Default for HandoffTestHooks {
    fn default() -> Self {
        Self {
            pause_after_enter: None,
            pause_after_terminal_prior_kill: None,
            pause_in_target_spawn: None,
            pause_in_target_spawn_before_publish: None,
            spawn_watch_slot: std::sync::Mutex::new(None),
            force_reap_timeout: std::sync::atomic::AtomicBool::new(false),
            force_reap_timeout_fenced: std::sync::atomic::AtomicBool::new(false),
            force_reap_timeout_fenced_skip: std::sync::atomic::AtomicUsize::new(0),
            force_platform_limited: std::sync::atomic::AtomicBool::new(false),
            force_platform_limited_skip: std::sync::atomic::AtomicUsize::new(0),
            force_unsupported_preflight: std::sync::atomic::AtomicBool::new(false),
            abort_reap_confirmation_once: std::sync::atomic::AtomicBool::new(false),
            drop_abort_target_confirmation_once: std::sync::atomic::AtomicBool::new(false),
            fail_target_spawn_once: std::sync::atomic::AtomicBool::new(false),
            pause_in_failure_truth_broadcast: None,
            pause_in_failure_truth_once: std::sync::atomic::AtomicBool::new(false),
            pause_in_failure_truth_parked: std::sync::atomic::AtomicBool::new(false),
            pause_post_abort_broadcast: None,
            pause_post_abort_broadcast_once: std::sync::atomic::AtomicBool::new(false),
            pause_post_abort_broadcast_parked: std::sync::atomic::AtomicBool::new(false),
            events: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl HandoffTestHooks {
    fn record(&self, step: &'static str) {
        self.events.lock().expect("handoff hooks lock").push(step);
    }
}

/// The lifecycle operation requested by `POST /api/sessions/handoff`.
///
/// `ClearStaleBookkeeping` is deliberately a separate operation. It may
/// release only an already fenced record and never enters the handoff
/// lifecycle, so a delayed clear cannot turn into a stop or a new writer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffAction {
    Switch,
    ClearStaleBookkeeping,
    StopAndReopen,
}

impl HandoffAction {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Switch => "switch",
            Self::ClearStaleBookkeeping => "clear-stale-bookkeeping",
            Self::StopAndReopen => "stop-and-reopen",
        }
    }
}

/// The handoff request (the `POST /api/sessions/handoff` body, parsed).
pub struct HandoffRequest {
    pub action: HandoffAction,
    pub provider: String,
    pub session_id: String,
    pub target_kind: RuntimeOwnerKind,
    /// fresh-agent target: freshcodex | freshopencode | freshclaude | kilroy
    /// (round-2 review: ALL fresh-agent session types — kilroy rides the
    /// claude lane, so the flavor is a param there).
    pub session_type: Option<String>,
    /// terminal target CLI mode (validated against the registered specs).
    pub mode: Option<String>,
    pub cwd: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
    pub observed_epoch: Option<u64>,
    pub observed_generation: Option<u64>,
    pub device_id: Option<String>,
}

/// The lanes' `kill_for_handoff` answer. The reap TIMEOUT itself is the
/// runner's concern (it bounds the whole kill future with
/// [`SessionHandoffRunner::reap_timeout_ms`]) — the lanes answer only what
/// they directly observed.
pub(crate) enum StopResult {
    /// The runtime is confirmed gone (awaited watcher/teardown).
    Reaped,
    /// There was no live runtime under this id (idempotent stop).
    AlreadyGone,
    /// b8ke focused review FR3: the lane's bounded confirmation window
    /// expired with the runtime tree still alive — NEVER a reap, never a
    /// silent success. Carries the detached continuation that keeps
    /// escalating and resolves `true` only once death is finally
    /// confirmed; the runner fences the key (the F3 machinery), broadcasts
    /// the failure frame, and its watcher releases on this future. A lost
    /// continuation is covered by the watcher's typed fenced state +
    /// replacement probe (round-2 review R2-1).
    NotConfirmed {
        confirmation: std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'static>>,
    },
    /// b8ke focused round-2 review R2-3: a non-Linux teardown confirmed the
    /// direct child's awaited exit (the portable floor) but CANNOT verify
    /// the descendant tree (`/proc` is Linux-only) — the typed
    /// platform-limited stop answer. It must NEVER satisfy the handoff's
    /// confirmed-reap requirement: the runner fences the key with the typed
    /// [`freshell_ownership::FenceReason::PlatformLimited`] reason (a new
    /// writer cannot start; the session remains recoverable — the operator
    /// can still kill leftover processes by other means), the documented
    /// tradeoff being that nothing on that platform can confirm the
    /// descendant death, so the fence persists for the boot epoch.
    PlatformLimited,
}

impl std::fmt::Debug for StopResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StopResult::Reaped => f.write_str("Reaped"),
            StopResult::AlreadyGone => f.write_str("AlreadyGone"),
            StopResult::NotConfirmed { .. } => f.write_str("NotConfirmed { .. }"),
            StopResult::PlatformLimited => f.write_str("PlatformLimited"),
        }
    }
}

/// The detached reap watcher's answer (b8ke focused round-2 review):
/// `Confirmed` — the prior runtime's death was positively confirmed (the
/// lane teardown's own watcher, the registry dead-poll, or the replacement
/// probe); `PlatformLimited` — the teardown completed but its platform
/// cannot confirm the descendant tree (R2-3: fences, never releases);
/// `Lost` — the confirmation future itself failed (R2-1: fences with the
/// typed WatcherFailed reason and spawns the replacement probe).
#[derive(Debug)]
pub(crate) enum ReapAnswer {
    Confirmed,
    PlatformLimited,
    Lost,
}

/// Why a prior runtime's stop could not be confirmed reaped.
#[derive(Debug)]
enum StopOutcomePriv {
    /// The runtime is confirmed gone (awaited reap, or it never existed).
    Reaped,
    /// The exit was not observed within the handoff's reap timeout. This
    /// proves ONLY that — liveness is re-probed separately (round-2 review).
    ///
    /// b8ke delta review F3: `fenced` distinguishes the two shapes.
    /// `false` — the FORCE test hook short-circuited BEFORE any kill was
    /// issued (the prior is untouched): the round-2 re-probe semantics
    /// decide restore-vs-Vacant. `true` — a REAL timeout (or a lane's typed
    /// [`StopResult::NotConfirmed`], b8ke focused FR3): the kill WAS
    /// issued and its confirmation continues DETACHED (the teardown future
    /// was spawned, never dropped; a NotConfirmed lane carries its own
    /// escalation continuation); the key stays fenced in Handoff until
    /// the watcher confirms death — a probe that reads the lane's
    /// sessions map cannot see a map-evicted-but-alive runtime, so the
    /// probe must NOT decide anything here. b8ke focused FR5: this arm
    /// implies the `handoff-failed` frame was ALREADY broadcast by
    /// `stop_runtime`, strictly before the watcher existed — the caller
    /// never re-broadcasts it.
    ReapTimeout { fenced: bool },
    /// b8ke focused round-2 review R2-3: the lane answered
    /// [`StopResult::PlatformLimited`] — the child's awaited exit is the
    /// portable floor but the descendant tree is unverifiable on that
    /// platform. The caller fences the key with the typed PlatformLimited
    /// reason and answers the typed retryable failure; a new writer can
    /// never start against the unconfirmable prior.
    PlatformLimitedFenced,
}

/// The server-wide atomic handoff runner. Minted in `freshell-server::main`
/// with the SAME fresh states, registry, coordinator, broadcast bus, and CLI
/// specs every other lane holds.
/// b8ke e3r1 F4 + e3r2 F3: the host-wired durable flavor writer. The
/// handoff AWAITS `stage` INSIDE the Handoff window (before the owner
/// commit) — stage performs every pre-commit check (the hidden-flavor
/// resolution + the writability probe) WITHOUT the durable mutation.
/// b8ke ext r28 F4: the write is TWO-PHASE — the durable mutation (the
/// store's atomic rename) happens ONLY in the staged handle's `commit`,
/// which the runner awaits AFTER the coordinator commits
/// Live(targetKind). A cancellation anywhere before the commit drops the
/// staged handle and NOTHING durable changed: the pre-r28 single-phase
/// write renamed the metadata into place before a later awaited cleanup
/// and before the commit, so an abort in that interval reaped the target
/// and restored/fenced ownership while the persisted flavor already named
/// the TARGET kind — restart recovery could then select a runtime kind
/// that never became owner. Stage failures (disk unwritable, a failing
/// writer) still surface as the typed SESSION_METADATA_WRITE_FAILED
/// handoff failure (the uncommitted target reaped); a `commit` failure
/// after the owner is committed is logged loud and the owner stands (the
/// session runs; the next metadata write re-converges the flavor).
pub trait StagedFlavor: Send {
    /// The durable mutation — the ONE atomic write. Awaited only after
    /// Live(targetKind) committed.
    fn commit(
        self: Box<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
}

/// The staged-write future's shape ([`FlavorWrite::stage`]'s return).
pub type StagedFlavorFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = StagedFlavorOutcome> + Send>>;
/// [`FlavorWrite::stage`]'s outcome: the staged handle, or `Ok(None)` when
/// the store already holds this flavor (a no-op — nothing to commit).
pub type StagedFlavorOutcome = Result<Option<Box<dyn StagedFlavor>>, String>;

pub trait FlavorWrite: Send + Sync {
    /// The pre-commit phase: validate + prepare, NEVER durably mutate.
    /// `Ok(None)` = the store already holds this flavor (a no-op —
    /// nothing to commit).
    fn stage(&self, provider: &str, session_id: &str, flavor: &str) -> StagedFlavorFuture;

    /// b8ke e3r3 F4: the session's CURRENT durable flavor — the
    /// hidden-flavor preservation read. A terminal-target handoff whose
    /// current flavor is a HIDDEN type paired with the target's CLI mode
    /// (kilroy ↔ claude) KEEPS the hidden flavor (the pairing contract:
    /// reopening a Kilroy Fresh Agent as its Claude CLI never remaps the
    /// session for other devices/history). Default `None` (no durable
    /// record → the wire mode stands).
    fn current_flavor(
        &self,
        _provider: &str,
        _session_id: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>> {
        Box::pin(std::future::ready(None))
    }
}

/// b8ke e3r3 F4: the hidden-flavor table server-side — the same pairing
/// the client encodes (`shared/session-flavor.ts`
/// HIDDEN_SESSION_METADATA_TYPES: kilroy's CLI is claude).
fn hidden_flavor_for_cli(mode: &str) -> Option<&'static str> {
    match mode {
        "claude" => Some("kilroy"),
        _ => None,
    }
}

pub type FlavorWriter = Arc<dyn FlavorWrite>;

pub struct SessionHandoffRunner {
    auth_token: Arc<String>,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ownership: Arc<RuntimeOwnershipRegistry>,
    registry: freshell_terminal::TerminalRegistry,
    fresh_codex: crate::FreshCodexState,
    fresh_claude: crate::FreshClaudeState,
    /// The opencode lane (its sessions map + the shared serve handle).
    fresh_opencode: crate::FreshOpencodeState,
    /// The REST surface's fully-wired state — the terminal target spawn
    /// pipeline (`terminal_tabs::spawn_terminal_pane_with_handoff`) needs its
    /// registry/CLI-spec wiring.
    fresh_agent: crate::FreshAgentState,
    cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    reap_timeout_ms: u64,
    test_hooks: Option<Arc<HandoffTestHooks>>,
    /// b8ke e3r1 F4: the SERVER-side durable flavor writer, wired by the
    /// host (the session-metadata store lives in freshell-server). The
    /// handoff COMMIT performs the flavor write itself — inside the atomic
    /// transition, single-server-ordered — so the client's separate
    /// unversioned POST (cross-device out-of-order overwrites; log-only
    /// failure) is GONE. The callback is fire-and-forget (the host spawns
    /// its async store write; failures log server-side structured).
    flavor_writer: Option<FlavorWriter>,
}

impl SessionHandoffRunner {
    #[allow(clippy::too_many_arguments)] // the main.rs mint; mirrors the other state wirings
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        ownership: Arc<RuntimeOwnershipRegistry>,
        registry: freshell_terminal::TerminalRegistry,
        fresh_codex: crate::FreshCodexState,
        fresh_claude: crate::FreshClaudeState,
        fresh_opencode: crate::FreshOpencodeState,
        fresh_agent: crate::FreshAgentState,
        cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    ) -> Self {
        Self {
            auth_token,
            broadcast_tx,
            ownership,
            registry,
            fresh_codex,
            fresh_claude,
            fresh_opencode,
            fresh_agent,
            cli_commands,
            reap_timeout_ms: 10_000,
            test_hooks: None,
            flavor_writer: None,
        }
    }

    /// b8ke e3r1 F4: wire the host's durable flavor writer.
    pub fn with_flavor_writer(mut self, writer: Option<FlavorWriter>) -> Self {
        self.flavor_writer = writer;
        self
    }

    pub fn with_reap_timeout_ms(mut self, ms: u64) -> Self {
        self.reap_timeout_ms = ms;
        self
    }

    pub fn with_test_hooks(mut self, hooks: Arc<HandoffTestHooks>) -> Self {
        self.test_hooks = Some(hooks);
        self
    }

    /// Spawn the DETACHED handoff. Returns a CANCELLATION-CAPABLE handle:
    /// `completion` is the HTTP reply channel (dropping it never cancels the
    /// operation — a disconnected client cannot half-orphan it);
    /// `task` is the detached JoinHandle — `abort()` cancels deterministically
    /// (the RAII guard then fails the coordinator entry and reaps an
    /// uncommitted target runtime).
    pub fn spawn_handoff(self: &Arc<Self>, req: HandoffRequest) -> HandoffHandle {
        let (tx, rx) = oneshot::channel();
        let runner = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = runner.run(req).await;
            // Err (dropped receiver) is fine: the operation is detached.
            let _ = tx.send(result);
        });
        HandoffHandle {
            completion: rx,
            task,
        }
    }

    /// Clear only stale ownership bookkeeping. This path intentionally does
    /// not call `begin_handoff`, stop a runtime, start a target, or change a
    /// durable flavor. A clear request can therefore never become a reopen
    /// because a delayed response or a concurrent lifecycle operation changed
    /// the record while it was in flight.
    async fn clear_stale_bookkeeping(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        initiator: &str,
    ) -> Value {
        let snapshot = self.ownership.observe(&req.provider, &req.session_id);
        let generation = snapshot.generation;
        let observed = match (req.observed_epoch, req.observed_generation) {
            (Some(epoch), Some(generation)) => Some(ObservedFence { epoch, generation }),
            _ => None,
        };

        match snapshot.state {
            freshell_ownership::OwnershipState::Fenced {
                reason:
                    reason @ (freshell_ownership::FenceReason::PlatformLimited
                    | freshell_ownership::FenceReason::StaleStart
                    | freshell_ownership::FenceReason::StaleStop),
                prior,
                ..
            } => {
                let Some(observed) = observed else {
                    return typed_failure(
                        "INVALID_FENCE",
                        "clear-stale-bookkeeping requires the current observed (epoch, generation) fence pair",
                        false,
                        generation,
                    );
                };
                match self.ownership.force_release_platform_limited(
                    &req.provider,
                    &req.session_id,
                    observed,
                    initiator,
                ) {
                    freshell_ownership::ForceReleaseOutcome::Released => {
                        let cleared = match reason {
                            freshell_ownership::FenceReason::PlatformLimited => {
                                "platform-limited-fence"
                            }
                            freshell_ownership::FenceReason::StaleStart => "stale-start-fence",
                            freshell_ownership::FenceReason::StaleStop => "stale-stop-fence",
                            _ => unreachable!("matched only force-clearable fences"),
                        };
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.clear_stale_bookkeeping",
                            operation_id = %operation_id,
                            provider = %req.provider,
                            session_id = %req.session_id,
                            epoch = observed.epoch,
                            generation = observed.generation,
                            fence_reason = ?reason,
                            action = HandoffAction::ClearStaleBookkeeping.wire_name(),
                            outcome = "cleared_unverified",
                            shutdown_confirmed = false,
                            "clear-only released stale bookkeeping while retaining the unverified prior in ClearedUnverified; no runtime was stopped or started");
                        self.broadcast_owner(
                            req,
                            "handoff-failed",
                            prior.as_ref().map(|(owner, _)| owner.kind),
                            prior
                                .as_ref()
                                .and_then(|(owner, _)| owner.terminal_id.clone()),
                            operation_id,
                            observed.generation,
                            prior.as_ref().map(|(owner, _)| owner.kind),
                            Some(freshell_ownership::FenceReason::ClearedUnverified.wire_str()),
                            Some(true),
                        );
                        json!({
                            "ok": true,
                            "cleared": cleared,
                            "operationId": operation_id,
                            "generation": observed.generation,
                            "shutdownConfirmed": false,
                        })
                    }
                    freshell_ownership::ForceReleaseOutcome::NotPlatformLimited { .. } => {
                        typed_failure(
                            "SESSION_FENCED",
                            "clear-stale-bookkeeping was refused because the recovery state moved on; retry with a fresh observation",
                            true,
                            self.ownership.observe(&req.provider, &req.session_id).generation,
                        )
                    }
                    freshell_ownership::ForceReleaseOutcome::StaleObservation {
                        current_generation,
                        ..
                    } => typed_failure(
                        "STALE_GENERATION",
                        "observed ownership fence is stale; refresh and retry",
                        true,
                        current_generation,
                    ),
                }
            }
            freshell_ownership::OwnershipState::Vacant => typed_failure(
                "SESSION_NOT_FOUND",
                "There is no stale bookkeeping to clear. No reopen was started.",
                false,
                generation,
            ),
            // A clear-only request never treats a live or in-progress state
            // as proof that its writer is dead. It is a typed refusal and
            // leaves the ownership record untouched.
            _ => typed_failure(
                "SESSION_FENCED",
                "clear-stale-bookkeeping requires a fenced stale record; no writer was stopped or started",
                true,
                generation,
            ),
        }
    }

    /// The atomic sequence. See the module doc; every failure branch is a
    /// typed, retryable JSON body and leaves the coordinator in a coherent
    /// state (restored prior, or Vacant — never a stranded Handoff).
    async fn run(self: &Arc<Self>, req: HandoffRequest) -> Value {
        // b8ke focused episode-2 round-2 F1: resolve the wire session id to
        // its CANONICAL coordinator key FIRST. The claude rollback's fork
        // re-keys ownership to the client-visible new durable id; a stale
        // pane's handoff addressing the SUPERSEDED id resolves through the
        // lane's re-key alias map so the runner enters Handoff on the key
        // that actually holds the prior owner (never a false-Vacant split
        // identity that skips the prior stop and starts a second writer).
        // Every downstream surface — the coordinator enter, the lane stop,
        // the broadcast frames — then uses the one canonical id, so the
        // panes holding EITHER id converge. b8ke ext r23 F1: OpenCode has
        // the SAME two-identity shape (the pane's persisted
        // `freshopencode-*` placeholder is an `Aliased{to: ses_*}`
        // coordinator alias). b8ke ext r33 F2: the resolution is the
        // coordinator's OWN alias-chain fixpoint for EVERY provider —
        // codex included: a codex terminal identity rebind leaves the old
        // thread id permanently `Aliased{to: new}`, and a REST handoff
        // addressing that old reference previously fell to the aliased
        // key's typed retryable `HANDOFF_IN_PROGRESS` — a retry that
        // could never succeed (the alias is permanent). The one fixpoint
        // resolves all three providers' aliases (and any future one) to
        // the canonical key before the coordinator enter.
        let mut req = req;
        let resolved = self
            .ownership
            .resolve_canonical(&req.provider, &req.session_id);
        if resolved != req.session_id {
            tracing::info!(target: "freshell_ownership",
                event = "ownership.handoff.rekey_alias_resolved",
                provider = %req.provider,
                wire_session_id = %req.session_id, canonical_session_id = %resolved,
                "the handoff's wire id is a superseded re-key alias — the runner \
                 operates on the canonical coordinator key");
            req.session_id = resolved;
        }
        // b8ke delta review F5: the provider↔target validation — BEFORE the
        // coordinator enter, so a mismatched target never stops the prior
        // runtime or bumps the generation. The HTTP handler already refuses
        // mismatches with the typed 400 pre-spawn; this re-check covers
        // direct `spawn_handoff` callers with the same rule.
        if let Err(reason) = validate_handoff_target(
            &req.provider,
            req.target_kind,
            req.session_type.as_deref(),
            req.mode.as_deref(),
            &self.cli_commands,
        ) {
            let generation = self
                .ownership
                .observe(&req.provider, &req.session_id)
                .generation;
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.handoff.refused_pre_stop",
                provider = %req.provider, session_id = %req.session_id,
                epoch = self.ownership.boot_epoch(), generation,
                outcome = "validation_failed", failure_reason = "BAD_REQUEST",
                "a mismatched handoff target was refused before any coordinator state change: {reason}");
            return typed_failure("BAD_REQUEST", &reason, false, generation);
        }
        // b8ke delta review F5: resolve an ABSENT sessionType to the
        // provider's canonical type when unambiguous (codex → freshcodex,
        // opencode → freshopencode), so the dispatch, the response, and
        // the owner frames all name the lane the request actually targets
        // — never a silent freshcodex default under a foreign provider's
        // key. (An ambiguous absent type — claude — was refused above.)
        if req.target_kind == RuntimeOwnerKind::FreshAgent && req.session_type.is_none() {
            if let Some(canonical) =
                canonical_session_types(&req.provider).filter(|list| list.len() == 1)
            {
                req.session_type = Some(canonical[0].to_string());
            }
        }
        let operation_id = format!("handoff-{}", uuid::Uuid::new_v4());
        let initiator = req.device_id.clone().unwrap_or_else(|| "rest".into());
        if req.action == HandoffAction::ClearStaleBookkeeping {
            // Clear-only is dispatched before `begin_handoff`: it cannot
            // claim a lifecycle lease, signal a process, start a target, or
            // reinterpret a race as permission to reopen.
            return self
                .clear_stale_bookkeeping(&req, &operation_id, &initiator)
                .await;
        }
        // An atomic handoff needs a platform capability that can positively
        // confirm the complete prior writer tree is gone. Refuse before
        // `begin_handoff` on platforms without that capability, so this
        // typed limitation cannot strand a new Handoff state or mutate the
        // prior owner. Clear-only intentionally bypasses this preflight above:
        // it only repairs already fenced bookkeeping and never starts a writer.
        let forced_unsupported = self.test_hooks.as_ref().is_some_and(|hooks| {
            hooks
                .force_unsupported_preflight
                .load(std::sync::atomic::Ordering::SeqCst)
        });
        if !cfg!(target_os = "linux") || forced_unsupported {
            let generation = self
                .ownership
                .observe(&req.provider, &req.session_id)
                .generation;
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.handoff.refused_pre_stop",
                provider = %req.provider,
                session_id = %req.session_id,
                epoch = self.ownership.boot_epoch(),
                generation,
                outcome = "unsupported_platform",
                failure_reason = "PLATFORM_LIMITED",
                "atomic session handoff refused before mutation: the platform cannot confirm the complete prior writer tree");
            return typed_failure(
                "PLATFORM_LIMITED_PRECHECK",
                "atomic session handoff is unavailable because the server cannot confirm the complete prior writer tree; the existing session was left running",
                true,
                generation,
            );
        }
        let began = std::time::Instant::now();
        // 1. Atomically enter Handoff (+generation). The fence pair is
        // (epoch, generation) — a pre-restart pair is always stale; a half
        // pair is not a fence; neither-sent is legacy-unfenced.
        let observed = match (req.observed_epoch, req.observed_generation) {
            (Some(epoch), Some(generation)) => Some(ObservedFence { epoch, generation }),
            _ => None,
        };
        let entered = self.ownership.begin_handoff(
            &req.provider,
            &req.session_id,
            req.target_kind,
            &operation_id,
            observed,
            &initiator,
            now_ms(),
        );
        let generation = match entered {
            BeginOutcome::Granted { generation } => generation,
            BeginOutcome::StaleGeneration {
                current_generation, ..
            } => {
                return typed_failure(
                    "STALE_GENERATION",
                    "observed ownership fence is stale; refresh and retry",
                    // b8ke ext r34 F1: a stale generation is the CANONICAL
                    // retryable race outcome — the message says refresh and
                    // retry, so the banner renders the Retry action (pre-r34
                    // every real STALE_GENERATION answered retryable: false
                    // and the recovery was unreachable).
                    true,
                    current_generation,
                );
            }
            // b8ke focused round-4 review R4-4: a PlatformLimited fence is
            // cleared ONLY by the EXPLICIT acknowledged operator
            // force-clear — NEVER by an ordinary retry. Pre-fix, any
            // observed-fence retry force-cleared AND re-entered handoff
            // in one step, licensing a new writer while the prior's
            // descendant tree was unverified (only the direct child's
            // exit was confirmed). The force-clear is its own typed
            // action: it clears the key Vacant with the platform
            // limitation logged prominently, broadcasts the cleared state
            // (every device converges), and answers the typed clear —
            // NO handoff starts here. The caller retries the handoff
            // explicitly afterwards; that retry is a NEW operation whose
            // prior-owner is Vacant (no prior runtime to reap — the
            // normal sequence starts the target fresh from the durable
            // session, the unverified descendants being the operator's
            // acknowledged risk).
            BeginOutcome::Blocked {
                state:
                    freshell_ownership::OwnershipState::Fenced {
                        reason: freshell_ownership::FenceReason::ClearedUnverified,
                        prior,
                        ..
                    },
                ..
            } => {
                // b8ke ext r16 F4: the acknowledged PlatformLimited
                // force-clear landed in the TYPED cleared-unverified
                // state (never plain Vacant) — a lifecycle start here
                // requires the acknowledged-risk arm, and the
                // acknowledgment is recorded at THE START (the dangerous
                // new-writer step), not the clear. Without the flag: the
                // typed refusal; with it: the acknowledged start vacates
                // the state and THIS handoff proceeds fresh (the
                // no-prior sequence).
                let generation = self
                    .ownership
                    .observe(&req.provider, &req.session_id)
                    .generation;
                if req.action != HandoffAction::StopAndReopen {
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.cleared_unverified_refused",
                        operation_id = %operation_id, provider = %req.provider,
                        session_id = %req.session_id,
                        from_kind = ?prior.as_ref().map(|(o, _)| o.kind),
                        to_kind = ?Option::<RuntimeOwnerKind>::None,
                        epoch = self.ownership.boot_epoch(), generation,
                        outcome = "refused", failure_reason = "CLEARED_UNVERIFIED_FENCED",
                        "an unacknowledged start on the cleared-unverified key is \
                         refused typed — the prior writer's descendant tree was never \
                         confirmed dead; retry with acknowledgePlatformLimitedRisk: true \
                         (the pane's start-again action carries it)");
                    return typed_failure(
                        "CLEARED_UNVERIFIED_FENCED",
                        "the session sits in the cleared-unverified state: the prior \
                         runtime's descendant processes were never confirmed dead. The \
                         prior clear is not permission to start a writer — retry with the \
                         acknowledged risk (acknowledgePlatformLimitedRisk: true; the pane's \
                         start-again action carries it).",
                        true,
                        generation,
                    );
                }
                // THE ACKNOWLEDGED START: the current observed pair is
                // required (the operator acknowledges the state they are
                // looking at).
                let Some(observed) = observed else {
                    return typed_failure(
                        "CLEARED_UNVERIFIED_FENCED",
                        "the acknowledged start requires the current observed \
                         (epoch, generation) fence pair; refresh and retry",
                        true,
                        generation,
                    );
                };
                // b8ke ext r17 F1: the acknowledged start is ONE atomic
                // coordinator transition — `Fenced{ClearedUnverified} →
                // Handoff` in a single lock hold with the risk carried
                // INTO the claim (pre-r17 this was two steps — clear to
                // plain Vacant, then re-enter — whose lock window a
                // concurrent request could consume, including an
                // UNACKNOWLEDGED one, and whose re-entry PANICKED on
                // refusal). A lost race answers the typed conflict
                // refusal; the entered handoff runs the no-prior sequence.
                match self
                    .ownership
                    .begin_handoff_acknowledged_cleared_unverified(
                        &req.provider,
                        &req.session_id,
                        req.target_kind,
                        &operation_id,
                        observed,
                        &initiator,
                        now_ms(),
                    ) {
                    freshell_ownership::AcknowledgedStartOutcome::Granted {
                        generation: entered,
                    } => {
                        tracing::info!(target: "freshell_ownership",
                            event = "ownership.handoff.cleared_unverified_acknowledged_start",
                            operation_id = %operation_id, provider = %req.provider,
                            session_id = %req.session_id,
                            epoch = self.ownership.boot_epoch(), generation = entered,
                            outcome = "acknowledged_start_proceeds", failure_reason = "",
                            "the operator's acknowledged-risk start entered Handoff \
                             atomically over the cleared-unverified state");
                        entered
                    }
                    freshell_ownership::AcknowledgedStartOutcome::StaleObservation {
                        current_generation,
                        ..
                    } => {
                        return typed_failure(
                            "STALE_GENERATION",
                            "observed ownership fence is stale; refresh and retry",
                            // b8ke ext r34 F1: retryable (the acknowledged
                            // start's stale observation is the same
                            // refresh-and-retry race).
                            true,
                            current_generation,
                        );
                    }
                    freshell_ownership::AcknowledgedStartOutcome::LostRace { state } => {
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.cleared_unverified_acknowledge_moved_on",
                            operation_id = %operation_id, provider = %req.provider,
                            session_id = %req.session_id, state = ?state,
                            outcome = "refused", failure_reason = "RECOVERY_STATE_MOVED_ON",
                            "the acknowledged start lost the record — the typed \
                             conflict refusal, never a panic");
                        return typed_failure(
                            "SESSION_FENCED",
                            "the session's recovery state moved on (a concurrent \
                             lifecycle request claimed it); retry with a fresh \
                             observation",
                            true,
                            generation,
                        );
                    }
                }
            }
            BeginOutcome::Blocked {
                // b8ke delta round-3 F5: the acknowledged operator
                // force-clear accepts BOTH unconfirmable fence reasons —
                // the coordinator's own force_release API takes
                // PlatformLimited AND StaleStart (the registry's docs name
                // PID-less OpenCode starts as the production case that
                // otherwise stays fenced until restart), but pre-d3 this
                // branch matched PlatformLimited only and a StaleStart
                // fence fell to generic HANDOFF_IN_PROGRESS even with the
                // acknowledgment flag set — the documented recoverable
                // state was permanently wedged through the lifecycle API.
                // The probe keeps its OWN confirmed-death discipline; this
                // is the operator path, with the risk typed identically.
                state:
                    freshell_ownership::OwnershipState::Fenced {
                        // b8ke ext r25 F1(b): the acknowledged force-clear
                        // accepts ALL the unconfirmable fence reasons —
                        // PlatformLimited AND the stale reasons
                        // (StaleStart/StaleStop). Pre-r25 the stale
                        // reasons were probe-only, and once the
                        // provider's retained records were gone the
                        // fence was PERMANENT — no typed fence may lack
                        // a working automatic recovery or an operator
                        // escape. The clear never lands plain Vacant
                        // (the r16-F4 typed cleared-unverified state);
                        // the subsequent start requires the
                        // acknowledged-risk arm, so the active-writer
                        // refusal holds. The probe keeps its OWN
                        // confirmed-death discipline (with the r25
                        // PID-level death confirmation); this is the
                        // operator path, with the risk typed identically.
                        reason:
                            reason @ (freshell_ownership::FenceReason::PlatformLimited
                            | freshell_ownership::FenceReason::StaleStart
                            | freshell_ownership::FenceReason::StaleStop),
                        prior,
                        ..
                    },
                ..
            } => {
                // The reason-aware typed refusal: an ordinary retry never
                // clears an UNCONFIRMABLE fence. b8ke ext r25 F1(b): for
                // the STALE reasons the acknowledgment flag NOW clears —
                // through the SAME typed pipeline as PlatformLimited (the
                // clear lands Fenced{ClearedUnverified}, never plain
                // Vacant, and the subsequent start requires the
                // acknowledged-risk arm, so the active-writer refusal
                // holds). Pre-r25 the stale reasons were probe-only, and
                // once the provider's retained records were gone the
                // fence was PERMANENT — no typed fence may lack either a
                // working automatic recovery or an operator escape. The
                // refusal code is REASON-TYPED so the client's recovery UI
                // presents the truthful guidance.
                let fence_code = match reason {
                    freshell_ownership::FenceReason::PlatformLimited => "PLATFORM_LIMITED_FENCED",
                    freshell_ownership::FenceReason::StaleStop => "STALE_STOP_FENCED",
                    _ => "STALE_START_FENCED",
                };
                if req.action != HandoffAction::StopAndReopen {
                    let generation = self
                        .ownership
                        .observe(&req.provider, &req.session_id)
                        .generation;
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.unconfirmable_fence_refused",
                        operation_id = %operation_id, provider = %req.provider, session_id = %req.session_id,
                        epoch = self.ownership.boot_epoch(), generation,
                        fence_reason = ?reason,
                        outcome = "refused", failure_reason = fence_code,
                        "an ordinary retry does not clear an unconfirmable fence: the \
                         prior runtime's death could not be confirmed — the acknowledged \
                         force-clear is the only recovery");
                    return typed_failure(
                        fence_code,
                        match reason {
                            freshell_ownership::FenceReason::PlatformLimited =>
                                "the session is fenced pending recovery: this platform cannot \
                                 verify the prior runtime's descendant processes. Retry with the \
                                 acknowledged force-clear (acknowledgePlatformLimitedRisk: true) to \
                                 release the fence, accepting that unverified descendants may remain.",
                            freshell_ownership::FenceReason::StaleStop =>
                                "the session is fenced pending recovery: a stop operation ended \
                                 without confirming the prior runtime's death. The server's \
                                 confirmed-death probe recovers the fence once the prior is \
                                 confirmed gone — or retry with the acknowledged force-clear \
                                 (acknowledgePlatformLimitedRisk: true), accepting that surviving \
                                 processes are the operator's acknowledged risk.",
                            _ =>
                                "the session is fenced pending recovery: the prior runtime's \
                                 death could not be confirmed (a stale start left it \
                                 unconfirmable). The server's confirmed-death probe recovers the \
                                 fence once the prior is confirmed gone — or retry with the \
                                 acknowledged force-clear (acknowledgePlatformLimitedRisk: true), \
                                 accepting that surviving processes are the operator's \
                                 acknowledged risk.",
                        },
                        true,
                        generation,
                    );
                }
                // The acknowledged force-clear requires the CURRENT
                // observed fence pair — the operator clears the fence they
                // are looking at, never a stale one. b8ke e3r1 F5: the
                // missing-fence refusal is REASON-TYPED (previously
                // hard-coded PLATFORM_LIMITED_FENCED even for a StaleStart
                // fence).
                let Some(observed) = observed else {
                    let generation = self
                        .ownership
                        .observe(&req.provider, &req.session_id)
                        .generation;
                    return typed_failure(
                        fence_code,
                        "the acknowledged force-clear requires the current observed \
                         (epoch, generation) fence pair; refresh and retry",
                        true,
                        generation,
                    );
                };
                match self.ownership.force_release_platform_limited(
                    &req.provider,
                    &req.session_id,
                    observed,
                    &initiator,
                ) {
                    freshell_ownership::ForceReleaseOutcome::Released => {
                        // b8ke e3r1 F5: the event/reason/cleared strings are
                        // REASON-TYPED — a StaleStart force-clear records
                        // STALE_START_FORCE_CLEARED and the truthful
                        // unconfirmed-runtime risk (never a claim about a
                        // platform-specific direct-child condition); the
                        // PlatformLimited strings stay on the
                        // PlatformLimited case.
                        let (clear_event, clear_ack, cleared_label, clear_log) = match reason {
                            freshell_ownership::FenceReason::PlatformLimited => (
                                "PLATFORM_LIMITED_FORCE_CLEARED",
                                "platform-limited-descendant-tree-risk",
                                "platform-limited-fence",
                                "PLATFORM-LIMITED RISK ACKNOWLEDGED: the operator \
                                     force-cleared the fence — the prior runtime's DESCENDANT \
                                     tree is UNVERIFIED on this platform (only the direct \
                                     child's exit was confirmed). Surviving descendants are \
                                     the operator's acknowledged risk; the key is Vacant and a \
                                     subsequent explicit handoff starts the target fresh from \
                                     the durable session",
                            ),
                            freshell_ownership::FenceReason::StaleStop => (
                                "STALE_STOP_FORCE_CLEARED",
                                "stale-stop-unconfirmed-runtime-risk",
                                "stale-stop-fence",
                                "STALE-STOP RISK ACKNOWLEDGED: the operator force-cleared \
                                 the fence — a stop operation vanished mid-flight and the \
                                 prior runtime's death was NEVER CONFIRMED. Surviving \
                                 processes are the operator's acknowledged risk; the key is \
                                 Vacant and a subsequent explicit handoff starts the target \
                                 fresh from the durable session",
                            ),
                            _ => (
                                "STALE_START_FORCE_CLEARED",
                                "stale-start-unconfirmed-runtime-risk",
                                "stale-start-fence",
                                "STALE-START RISK ACKNOWLEDGED: the operator \
                                     force-cleared the fence — the prior runtime's death was \
                                     NEVER CONFIRMED (a stale start left it unconfirmable). \
                                     Surviving processes are the operator's acknowledged \
                                     risk; the key is Vacant and a subsequent explicit \
                                     handoff starts the target fresh from the durable session",
                            ),
                        };
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.unconfirmable_force_cleared",
                            fence_reason = ?reason,
                            clear_event = clear_event,
                            operation_id = %operation_id, provider = %req.provider, session_id = %req.session_id,
                            epoch = self.ownership.boot_epoch(), generation = observed.generation,
                            from_kind = ?prior.as_ref().map(|(owner, _)| owner.kind),
                            acknowledged = clear_ack,
                            "{clear_log}");
                        // Broadcast the AUTHORITATIVE post-clear state so
                        // every device holding the sessionRef converges on
                        // the coordinator's truth. b8ke ext r28 F1: the
                        // clear lands the key in
                        // Fenced{ClearedUnverified} (the r16-F4 pipeline —
                        // never plain Vacant), so the frame is the FENCED
                        // truth — the same shape the failure-broadcast and
                        // ready-replay paths emit for fenced records: the
                        // retained prior's kind, the fenced marker, and
                        // the cleared-unverified wire reason. Pre-r28 this
                        // emitted a bare "released"/vacant frame, which
                        // online panes folded as an AVAILABLE session —
                        // discarding the required recovery state while
                        // the coordinator still refused ordinary starts;
                        // the reconnect replay then flipped the UI back to
                        // the fence.
                        self.broadcast_owner(
                            &req,
                            "handoff-failed",
                            prior.as_ref().map(|(owner, _)| owner.kind),
                            prior
                                .as_ref()
                                .and_then(|(owner, _)| owner.terminal_id.clone()),
                            &operation_id,
                            observed.generation,
                            prior.as_ref().map(|(owner, _)| owner.kind),
                            Some(freshell_ownership::FenceReason::ClearedUnverified.wire_str()),
                            Some(true),
                        );
                        // The typed clear — the force-clear's own answer.
                        // NOT a handoff success: no owner is committed.
                        // b8ke ext r12 F1: the clear STOPS AT THE CLEAR —
                        // the answer carries NO retry instruction
                        // (acknowledgment covers clearing the fence, not
                        // starting a writer over the acknowledged-risk
                        // tree); the client surfaces the cleared state
                        // with an explicit user action to re-initiate the
                        // handoff, which then goes through the coordinator
                        // fresh (the no-prior sequence).
                        return json!({
                            "ok": true,
                            "cleared": cleared_label,
                            "operationId": operation_id,
                            "generation": observed.generation,
                        });
                    }
                    freshell_ownership::ForceReleaseOutcome::NotPlatformLimited { state } => {
                        let generation = self
                            .ownership
                            .observe(&req.provider, &req.session_id)
                            .generation;
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.force_clear_refused",
                            operation_id = %operation_id, provider = %req.provider, session_id = %req.session_id,
                            state = ?state,
                            "the acknowledged force-clear was refused — the key's state moved on");
                        return typed_failure(
                            "SESSION_FENCED",
                            "the session is fenced pending recovery; retry with a fresh \
                             observation or confirm the prior runtime is dead",
                            true,
                            generation,
                        );
                    }
                    freshell_ownership::ForceReleaseOutcome::StaleObservation {
                        current_epoch,
                        current_generation,
                    } => {
                        let _ = current_epoch;
                        return typed_failure(
                            "STALE_GENERATION",
                            "observed ownership fence is stale; refresh and retry",
                            // b8ke ext r34 F1: retryable (the force-clear's
                            // stale observation is the same refresh-and-
                            // retry race).
                            true,
                            current_generation,
                        );
                    }
                }
            }
            // `begin_handoff` grants from Vacant AND from Live of any kind, so
            // AdoptLive/OwnedByOtherKind are unreachable arms — mapped to the
            // same typed, retryable in-flight answer rather than unwrapped.
            BeginOutcome::Blocked { .. }
            | BeginOutcome::AdoptLive { .. }
            | BeginOutcome::OwnedByOtherKind { .. } => {
                let generation = self
                    .ownership
                    .observe(&req.provider, &req.session_id)
                    .generation;
                return typed_failure(
                    "HANDOFF_IN_PROGRESS",
                    "a lifecycle operation is in flight; retry after it settles",
                    true,
                    generation,
                );
            }
        };
        // The prior owner captured at enter (the stop source) — WITH its
        // Live generation (historical; a restore fences at the RECORD's
        // current generation instead — whole-branch M-1). Read before the
        // guard so the guard carries it.
        let prior = self
            .ownership
            .observe(&req.provider, &req.session_id)
            .state
            .prior_owner();
        let prior_kind = prior.as_ref().map(|(owner, _)| owner.kind);
        let mut guard = HandoffGuard {
            runner: Arc::clone(self),
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
            operation_id: operation_id.clone(),
            generation,
            prior: prior.clone(),
            // Flipped false once the awaited reap confirms the prior died;
            // set from the POSITIVE re-probe on a reap timeout (round-2
            // review).
            prior_still_live: prior.is_some(),
            prior_stop: PriorStopPhase::NotIssued,
            target_kind: req.target_kind,
            target_runtime: None,
            target_spawn_watch: None,
            target_spawn_begun: false,
            disarmed: false,
        };
        // 2. Broadcast the transition (all devices stop old-kind scheduling).
        // Every frame carries the boot epoch; the started frame's
        // previousKind is the prior owner's kind (round-2 review).
        self.broadcast_owner(
            &req,
            "handoff-started",
            Some(req.target_kind),
            None,
            &operation_id,
            generation,
            prior_kind,
            None,
            None,
        );
        if let Some(hooks) = self.test_hooks.as_ref() {
            if let Some(pause) = hooks.pause_after_enter.as_ref() {
                let _ = pause.notified().await;
            }
        }
        // 3+4. Stop the prior runtime and await confirmed reap (bounded).
        // Exit-watcher events arriving DURING Handoff are folded HERE:
        // `release` is fenced to a no-op in Handoff state (Task 1), so this
        // awaited kill/reap is the single fold point. The phase marks the
        // kill as IN FLIGHT across the await — an abort landing inside it
        // must re-probe before any restore (round-3 review I-1).
        if let Some((owner, _)) = prior.as_ref() {
            guard.prior_stop = PriorStopPhase::KillInFlight;
            match self
                .stop_runtime(&req, owner, &initiator, &operation_id, generation)
                .await
            {
                StopOutcomePriv::Reaped => {
                    guard.prior_stop = PriorStopPhase::Reaped;
                    guard.prior_still_live = false; // the runner folded the exit event
                    if let Some(hooks) = self.test_hooks.as_ref() {
                        hooks.record("Reaped");
                    }
                }
                StopOutcomePriv::ReapTimeout { fenced: true } => {
                    // b8ke delta review F3: a REAL reap timeout — the kill
                    // was issued and its confirmation runs DETACHED (the
                    // watcher owns the coordinator release). The caller gets
                    // the typed retryable failure NOW; the key does NOT go
                    // Vacant and the prior is NOT restored (the detached
                    // teardown is still killing it — a probe that reads the
                    // lane's map cannot see a map-evicted-but-alive
                    // runtime). It stays fenced in Handoff until the
                    // watcher confirms death, then releases to Vacant.
                    // b8ke focused review FR5: the `handoff-failed` frame was
                    // ALREADY broadcast inside `stop_runtime`, strictly
                    // before the watcher was spawned — never again here (a
                    // second send could only ever trail the watcher's
                    // corrective `released`).
                    guard.disarm(); // the watcher performs the release
                    self.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &req.provider,
                            session_id: &req.session_id,
                            initiator: &initiator,
                            epoch: self.ownership.boot_epoch(),
                            generation,
                            live_session_key: owner.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: Some(req.target_kind),
                            runtime_id: owner.terminal_id.as_deref(),
                            pid: owner.pid,
                            outcome: "reap_timeout_fenced_pending_reap",
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("REAP_TIMEOUT"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Warn,
                    );
                    return typed_failure(
                        "REAP_TIMEOUT",
                        "the prior runtime's reap is still being confirmed; the session stays \
                         fenced until the prior is confirmed dead — retry after it settles",
                        true,
                        generation,
                    );
                }
                StopOutcomePriv::PlatformLimitedFenced => {
                    // b8ke focused round-2 review R2-3: the lane's teardown
                    // confirmed the direct child's awaited exit but cannot
                    // verify the descendant tree on this platform — NEVER a
                    // confirmed reap. The failure frame (reason
                    // PLATFORM_LIMITED) was already broadcast inside
                    // `stop_runtime`; here the key moves to the TYPED
                    // `Fenced{PlatformLimited}` state: every new writer is
                    // Blocked (never a second writer over a possibly-live
                    // descendant), the session stays recoverable (the
                    // durable history is untouched; the operator can kill
                    // leftover processes by other means), and — the
                    // documented tradeoff — nothing on this platform can
                    // ever confirm the descendant death, so the fence
                    // persists for the boot epoch.
                    guard.disarm(); // the fenced state replaces the Handoff
                    let fenced = self.ownership.fence_unconfirmed_handoff(
                        &req.provider,
                        &req.session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                    debug_assert!(matches!(fenced, freshell_ownership::FenceOutcome::Fenced));
                    self.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &req.provider,
                            session_id: &req.session_id,
                            initiator: &initiator,
                            epoch: self.ownership.boot_epoch(),
                            generation,
                            live_session_key: owner.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: Some(req.target_kind),
                            runtime_id: owner.terminal_id.as_deref(),
                            pid: owner.pid,
                            outcome: "reap_platform_limited_fenced",
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("PLATFORM_LIMITED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    return typed_failure(
                        "PLATFORM_LIMITED",
                        "the prior runtime's teardown cannot confirm the descendant tree on \
                         this platform; the session stays fenced (no new writer can start) \
                         and remains recoverable",
                        true,
                        generation,
                    );
                }
                StopOutcomePriv::ReapTimeout { fenced: false } => {
                    // Round-2 review: a reap timeout proves ONLY that the exit
                    // was not observed in time — it does NOT imply the prior
                    // runtime is still live. POSITIVE re-probe before any
                    // restore: confirmed live -> restore (its fenced exit
                    // watcher releases the key once it actually dies — no
                    // permanent wedge); unconfirmable -> end Vacant with the
                    // typed REAP_TIMEOUT (retryable, recoverable — never
                    // record a dead runtime as Live).
                    let prior_live = self
                        .probe_prior_live(&req.provider, &req.session_id, owner)
                        .await;
                    guard.prior_still_live = prior_live;
                    let fail_outcome = guard.disarm_and_fail();
                    // Round-3 review I-1 (claim repairs) + whole-branch M-1:
                    // a restored prior — fresh (whose retained stamp the lane
                    // kill may have taken) or terminal (whose retained claim
                    // still fences at its commit generation) — must have its
                    // lane claims brought to the RESTORED generation (the
                    // handoff's — `fail` restores the record's current), or
                    // its later exit/kill paths can never release the record.
                    if prior_live && matches!(fail_outcome, FailOutcome::RestoredPriorOwner) {
                        self.repair_restored_prior_claims(
                            &req.provider,
                            &req.session_id,
                            owner,
                            generation,
                        );
                    }
                    // Failure-broadcast truth (round-2 review): the frame
                    // carries the ACTUAL resulting state — the restored prior
                    // owner with its kind/runtime identity, or Vacant — plus
                    // previousKind and the typed reason.
                    self.broadcast_failure_truth(
                        &req,
                        &operation_id,
                        generation,
                        prior_kind,
                        "REAP_TIMEOUT",
                    )
                    .await;
                    let outcome = if prior_live {
                        "reap_timeout_restored_prior"
                    } else {
                        "reap_timeout_vacant"
                    };
                    self.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &req.provider,
                            session_id: &req.session_id,
                            initiator: &initiator,
                            epoch: self.ownership.boot_epoch(),
                            generation,
                            live_session_key: owner.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: Some(req.target_kind),
                            runtime_id: owner.terminal_id.as_deref(),
                            pid: owner.pid,
                            outcome,
                            duration_ms: began.elapsed().as_millis() as u64,
                            failure_reason: Some("REAP_TIMEOUT"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Warn,
                    );
                    let detail = if prior_live {
                        "prior runtime re-probed live and restored; retry after it exits"
                    } else {
                        "prior runtime unconfirmable after reap timeout; session left Vacant — retry to reopen"
                    };
                    return typed_failure("REAP_TIMEOUT", detail, true, generation);
                }
            }
        }
        // 5. Start/attach the target UNDER the handoff's ticket (single
        // commit authority — the target paths skip their own commit and
        // surface the identity; THIS runner performs the one commit_live).
        // Round-3 review I-1 (target-spawn window): for a terminal target,
        // arm the guard-visible spawn watch BEFORE the await — an abort
        // landing anywhere inside `start_target` leaves the settle running
        // detached, and the guard's cleanup needs the watch to find (and
        // reap) the terminal it publishes.
        let mut target_spawn_watch = None;
        if req.target_kind == RuntimeOwnerKind::Terminal {
            let watch = crate::terminal_tabs::HandoffSpawnWatch::new_with_before_publish(
                self.test_hooks
                    .as_ref()
                    .and_then(|hooks| hooks.pause_in_target_spawn.clone()),
                self.test_hooks
                    .as_ref()
                    .and_then(|hooks| hooks.pause_in_target_spawn_before_publish.clone()),
            );
            if let Some(hooks) = self.test_hooks.as_ref() {
                *hooks.spawn_watch_slot.lock().expect("spawn watch slot") = Some(watch.clone());
            }
            guard.target_spawn_watch = Some(watch.clone());
            target_spawn_watch = Some(watch);
        }
        guard.target_spawn_begun = true;
        match self
            .start_target(&req, &operation_id, generation, target_spawn_watch)
            .await
        {
            Ok((owner, opencode_committed)) => {
                // The cancellation-safety window: a spawned-but-uncommitted
                // target is reaped by the guard if the runner is aborted
                // before the commit (round-1 review). The precise identity
                // supersedes the spawn watch (no further await precedes the
                // commit, so no abort can land between them).
                guard.target_runtime = Some(owner.clone());
                guard.target_spawn_watch = None;
                // b8ke e3r2 F3: the durable flavor write is AWAITED here —
                // INSIDE the Handoff window, before the owner commit. The
                // record is still `Handoff`, so the NEXT handoff on this
                // session cannot begin until this write completes (the
                // coordinator's generation discipline enforces the flavor
                // order); persistence lands before success returns; and a
                // failure surfaces as the TYPED handoff failure (the
                // spawned target is reaped + the entry fails, mirroring
                // the stale-commit unwind — never log-only success).
                // b8ke ext r28 F4: the STAGED flavor handle — stage pre-commit
                // (inside the Handoff window), commit AFTER Live(targetKind).
                let mut staged_flavor: Option<Box<dyn StagedFlavor>> = None;
                if let Some(writer) = &self.flavor_writer {
                    // b8ke e3r3 F4: the durable flavor derives from the
                    // session's provider/kind pairing — NEVER the wire mode
                    // alone. A terminal target whose CURRENT durable flavor
                    // is a hidden type paired with the target's CLI keeps
                    // the hidden flavor (kilroy stays kilroy across a
                    // Kilroy→Claude-CLI handoff; pre-e3r3 the wire mode
                    // "claude" remapped the session for other
                    // devices/history).
                    let prior_flavor = writer.current_flavor(&req.provider, &req.session_id).await;
                    let flavor: Option<String> = match owner.kind {
                        RuntimeOwnerKind::Terminal => {
                            let mode = req.mode.clone().filter(|m| !m.is_empty());
                            match (&prior_flavor, &mode) {
                                (Some(current), Some(mode))
                                    if hidden_flavor_for_cli(mode)
                                        .is_some_and(|hidden| hidden == current) =>
                                {
                                    Some(current.clone())
                                }
                                _ => mode,
                            }
                        }
                        RuntimeOwnerKind::FreshAgent => {
                            req.session_type.clone().filter(|t| !t.is_empty())
                        }
                    };
                    if let Some(flavor) = flavor {
                        // b8ke ext r28 F4: the STAGED (two-phase) flavor
                        // write — `stage` performs the pre-commit checks
                        // (writability probe; no durable mutation) inside
                        // the Handoff window; the durable rename lands in
                        // the staged handle's `commit`, awaited AFTER the
                        // Live(targetKind) commit below. A cancellation
                        // between the two drops the staged handle and
                        // NOTHING durable changed — the pre-r28
                        // single-phase write renamed the metadata into
                        // place here, so an abort in the later awaited
                        // cleanup (or before the commit) left the
                        // persisted flavor naming the TARGET kind over a
                        // reaped/fenced target.
                        match writer.stage(&req.provider, &req.session_id, &flavor).await {
                            Ok(staged) => staged_flavor = staged,
                            Err(err) => {
                                tracing::error!(target: "invariant",
                                    operation_id = %operation_id, provider = %req.provider,
                                    session_id = %req.session_id, flavor = %flavor,
                                    error = %err,
                                    event = "ownership.handoff.flavor_write_failed",
                                    "the durable flavor write failed inside the commit \
                                     window — the uncommitted target is reaped and the \
                                     handoff answers the typed failure"
                                );
                                let reap_outcome = self
                                    .reap_uncommitted_target(
                                        &req,
                                        &owner,
                                        &operation_id,
                                        generation,
                                    )
                                    .await;
                                if let StopOutcomePriv::PlatformLimitedFenced = reap_outcome {
                                    // b8ke d4 F1: the platform-limited teardown
                                    // fences the typed fence (no watcher can
                                    // ever confirm the descendant tree here).
                                    // b8ke e4 post-cap F2: the fence records
                                    // the UNCONFIRMED TARGET's identity — the
                                    // runtime with the unverifiable descendant
                                    // tree is the newly spawned target, not the
                                    // already-reaped source, so the snapshot/
                                    // broadcast/typed answers name the right
                                    // runtime.
                                    guard.disarm();
                                    let _ = self.ownership.fence_unconfirmed_handoff_with_prior(
                                        &req.provider,
                                        &req.session_id,
                                        &operation_id,
                                        generation,
                                        freshell_ownership::FenceReason::PlatformLimited,
                                        Some((owner.clone(), generation)),
                                    );
                                } else if !self
                                    .uncommitted_target_reap_vacates(&reap_outcome, &mut guard)
                                {
                                    tracing::warn!(target: "freshell_ownership",
                                        operation_id = %operation_id,
                                        provider = %req.provider,
                                        session_id = %req.session_id,
                                        "ownership.handoff.uncommitted_target_reap_unconfirmed: \
                                         the flavor-write failure's target reap is unconfirmed — \
                                         the key stays FENCED (the detached watcher resolves it), \
                                         never Vacant over an unconfirmed target");
                                }
                                self.broadcast_failure_truth(
                                    &req,
                                    &operation_id,
                                    generation,
                                    prior_kind,
                                    "SESSION_METADATA_WRITE_FAILED",
                                )
                                .await;
                                let current = self
                                    .ownership
                                    .observe(&req.provider, &req.session_id)
                                    .generation;
                                // b8ke e4r1 F2: the truthful outcome label —
                                // the reap's CONFIRMATION class, never a
                                // blanket "reaped" (a timeout/platform-limited
                                // reap was explicitly NOT confirmed; the old
                                // label recorded the opposite of the
                                // safety-critical outcome).
                                let outcome =
                                    if Self::uncommitted_target_reap_confirmed(&reap_outcome) {
                                        "flavor_write_failed_target_reaped"
                                    } else {
                                        "flavor_write_failed_target_unconfirmed"
                                    };
                                self.log_transition(
                                    TransitionLog {
                                        operation_id: &operation_id,
                                        provider: &req.provider,
                                        session_id: &req.session_id,
                                        initiator: &initiator,
                                        epoch: self.ownership.boot_epoch(),
                                        generation,
                                        live_session_key: owner.live_session_key.as_deref(),
                                        from_kind: prior_kind,
                                        to_kind: Some(owner.kind),
                                        runtime_id: owner.terminal_id.as_deref(),
                                        pid: owner.pid,
                                        outcome,
                                        duration_ms: began.elapsed().as_millis() as u64,
                                        failure_reason: Some("SESSION_METADATA_WRITE_FAILED"),
                                        stale: None,
                                    },
                                    "ownership.handoff.done",
                                    TransitionLevel::Error,
                                );
                                return typed_failure(
                                    "SESSION_METADATA_WRITE_FAILED",
                                    "the handoff switched the runtime but could not persist the \
                                     session's durable flavor; retry the handoff",
                                    true,
                                    current,
                                );
                            }
                        }
                    }
                }
                // 6. THE single commit Live(targetKind) + broadcast owner
                // identity. b8ke ext r30 F1: for a FRESH target this is
                // the ATOMIC publication — the commit and the retained
                // stamp land in ONE lane-stamps lock scope the exit
                // watcher's release consult also takes, gated by a
                // liveness check under that lock (a dead sidecar never
                // publishes; its watchers never strand a Live record).
                match self.commit_live_target_with_release_evidence(
                    &req,
                    &operation_id,
                    generation,
                    &owner,
                ) {
                    CommitOutcome::Committed => {
                        guard.disarm();
                        self.broadcast_owner(
                            &req,
                            "handoff-committed",
                            Some(owner.kind),
                            owner.terminal_id.clone(),
                            &operation_id,
                            generation,
                            prior_kind,
                            None,
                            None,
                        );
                        // b8ke ext r28 F4: the durable flavor mutation lands
                        // HERE — AFTER the coordinator committed
                        // Live(targetKind). The staged handle's Drop (an
                        // abort anywhere before this point) removed its
                        // probe residue and NOTHING durable changed; a
                        // commit failure here is logged loud and the
                        // committed owner stands (the session runs; the
                        // next metadata write re-converges the flavor) —
                        // never a reaped committed owner over metadata.
                        if let Some(staged) = staged_flavor.take() {
                            if let Err(err) = staged.commit().await {
                                tracing::error!(target: "invariant",
                                    operation_id = %operation_id, provider = %req.provider,
                                    session_id = %req.session_id, error = %err,
                                    event = "ownership.handoff.flavor_commit_failed_post_commit",
                                    "the durable flavor rename failed AFTER the owner                                      committed — the committed owner stands; the flavor                                      re-converges on the next metadata write (kata b8ke                                      ext r28 F4)"
                                );
                            }
                        }
                        self.log_transition(
                            TransitionLog {
                                operation_id: &operation_id,
                                provider: &req.provider,
                                session_id: &req.session_id,
                                initiator: &initiator,
                                epoch: self.ownership.boot_epoch(),
                                generation,
                                live_session_key: owner.live_session_key.as_deref(),
                                from_kind: prior_kind,
                                to_kind: Some(owner.kind),
                                runtime_id: owner.terminal_id.as_deref(),
                                pid: owner.pid,
                                outcome: "committed",
                                duration_ms: began.elapsed().as_millis() as u64,
                                failure_reason: None,
                                stale: None,
                            },
                            "ownership.handoff.done",
                            TransitionLevel::Info,
                        );
                        // fresheyes ep2-r4 Major (daemon loss in the
                        // handoff pre-commit window): the under-ticket
                        // continuation (`start_target` →
                        // `opencode_resume_for_handoff`) installs its
                        // generation-fenced bridge and runs its own
                        // transitional rescue BEFORE this runner's single
                        // `Live` commit — and between the two, this
                        // runner can still await
                        // `current_flavor()`/`stage()` while the
                        // coordinator key remains `Handoff`. A daemon
                        // loss in that interval kills the fresh bridge
                        // with every recovery trigger spent: the
                        // successor's `Started` revival pass deliberately
                        // skips the transitional owner (the
                        // foreign-transition rule), this commit emits no
                        // new daemon signal, and the finished rescue is
                        // never rerun — the handoff would answer plain
                        // success over an A-generation dead bridge. The
                        // ESTABLISHED post-commit rescue pattern (the
                        // fork/resume tails) closes the window from the
                        // commit's own side: re-run the SAME
                        // ownership-coordinator-gated guarded-restart
                        // seam for the freshopencode target.
                        // `own_lifecycle_window = false`: this commit IS
                        // the window's end, so the seam observes the
                        // runner's own `Live{FreshAgent}` and arms the
                        // adopt guard across the restart (the revival
                        // pass's exact discipline). A bridge alive
                        // against the CURRENT daemon is the quiet no-op;
                        // a dead/lost-generation bridge is restarted
                        // against the successor and the client gets its
                        // one recovery snapshot; a REFUSAL — the session
                        // was killed or re-transitioned between the
                        // commit and this tail, the mover's teardown
                        // owning the cleanup — surfaces the typed
                        // ownership-changed failure, never success over
                        // the retired session. A bounded respawn failure
                        // stays WARN-only (the seam's ep2-r2 contract).
                        //
                        // fresheyes ep2-r5: the re-check is bound to the
                        // identity THIS runner committed — the under-
                        // ticket continuation's session instance (carried
                        // out of `start_target`) and this commit's own
                        // `(epoch, generation)` fence. A same-key
                        // REPLACEMENT (the target killed and another
                        // resume's brand-new session installed under the
                        // same durable id during the awaited post-commit
                        // work) can never satisfy the instance binding or
                        // the fence equality, so the runner surfaces the
                        // typed failure instead of answering success
                        // carrying its obsolete generation.
                        if req.target_kind == RuntimeOwnerKind::FreshAgent
                            && req.session_type.as_deref() == Some("freshopencode")
                            && match opencode_committed.as_ref() {
                                Some(committed) => matches!(
                                    self.fresh_opencode
                                        .rescue_transitional_bridge_after_commit(
                                            &req.session_id,
                                            false,
                                            committed,
                                            Some(ObservedFence {
                                                epoch: self.ownership.boot_epoch(),
                                                generation,
                                            }),
                                        )
                                        .await,
                                    crate::opencode_ws::TransitionalBridgeRescue::Refused
                                ),
                                // Unreachable for a freshopencode target
                                // (the under-ticket resume hands its
                                // committed instance out on every Ok) —
                                // fail CLOSED: an instance the runner
                                // cannot verify must never answer
                                // success.
                                None => true,
                            }
                        {
                            tracing::warn!(target: "freshell_freshagent::opencode",
                                operation_id = %operation_id,
                                provider = %req.provider, session_id = %req.session_id,
                                generation,
                                "freshagent.opencode.handoff_bridge_recheck_refused: the \
                                 freshopencode target committed but the session was retired \
                                 or re-transitioned before the handoff answered — the \
                                 mover's teardown owns the cleanup; the handoff surfaces \
                                 the typed ownership-changed failure (ep2-r4)"
                            );
                            let current = self
                                .ownership
                                .observe(&req.provider, &req.session_id)
                                .generation;
                            return typed_failure(
                                "STALE_GENERATION",
                                "ownership changed during handoff; the freshopencode target \
                                 committed but the session was retired or re-transitioned \
                                 before the handoff could answer — refresh and retry",
                                true,
                                current,
                            );
                        }
                        json!({
                            "ok": true,
                            "operationId": operation_id,
                            "generation": generation,
                            "owner": owner_json(&owner, &req),
                        })
                    }
                    // A stale/foreign commit (the ownership moved mid-handoff)
                    // must REAP the uncommitted target runtime — it has no
                    // owner record — then fail typed (round-1 review).
                    stale @ (CommitOutcome::StaleGeneration { .. }
                    | CommitOutcome::ForeignOperation) => {
                        let reap_outcome = self
                            .reap_uncommitted_target(&req, &owner, &operation_id, generation)
                            .await;
                        if let StopOutcomePriv::PlatformLimitedFenced = reap_outcome {
                            // b8ke d4 F1: the typed PlatformLimited fence.
                            // b8ke e4 post-cap F2: the fence records the
                            // UNCONFIRMED TARGET's identity (the same
                            // reversed-identity fix as the flavor arm).
                            guard.disarm();
                            let _ = self.ownership.fence_unconfirmed_handoff_with_prior(
                                &req.provider,
                                &req.session_id,
                                &operation_id,
                                generation,
                                freshell_ownership::FenceReason::PlatformLimited,
                                Some((owner.clone(), generation)),
                            );
                        } else if !self.uncommitted_target_reap_vacates(&reap_outcome, &mut guard) {
                            tracing::warn!(target: "freshell_ownership",
                                operation_id = %operation_id,
                                provider = %req.provider,
                                session_id = %req.session_id,
                                "ownership.handoff.uncommitted_target_reap_unconfirmed: \
                                 the stale-commit's target reap is unconfirmed — the key \
                                 stays FENCED (the detached watcher resolves it), never \
                                 Vacant over an unconfirmed target");
                        }
                        self.broadcast_failure_truth(
                            &req,
                            &operation_id,
                            generation,
                            prior_kind,
                            "STALE_GENERATION",
                        )
                        .await;
                        let current = self
                            .ownership
                            .observe(&req.provider, &req.session_id)
                            .generation;
                        // b8ke e4r1 F2: the truthful outcome label — the
                        // reap's CONFIRMATION class (the old blanket
                        // "reaped" recorded the opposite of the
                        // safety-critical outcome for a timeout/
                        // platform-limited reap).
                        let outcome = if Self::uncommitted_target_reap_confirmed(&reap_outcome) {
                            "stale_commit_reaped_target"
                        } else {
                            "stale_commit_target_unconfirmed"
                        };
                        self.log_transition(
                            TransitionLog {
                                operation_id: &operation_id,
                                provider: &req.provider,
                                session_id: &req.session_id,
                                initiator: &initiator,
                                epoch: self.ownership.boot_epoch(),
                                generation,
                                live_session_key: owner.live_session_key.as_deref(),
                                from_kind: prior_kind,
                                to_kind: Some(owner.kind),
                                runtime_id: owner.terminal_id.as_deref(),
                                pid: owner.pid,
                                outcome,
                                duration_ms: began.elapsed().as_millis() as u64,
                                failure_reason: Some("STALE_GENERATION"),
                                stale: Some(&stale),
                            },
                            "ownership.handoff.done",
                            TransitionLevel::Error,
                        );
                        typed_failure(
                            "STALE_GENERATION",
                            "ownership moved during handoff; the uncommitted target was reaped",
                            // b8ke ext r34 F1: retryable — the target was
                            // reaped (nothing to clean up); the caller
                            // refreshes its observed pair and retries.
                            true,
                            current,
                        )
                    }
                }
            }
            Err((code, detail)) => {
                // 7. Typed recoverable state — the prior was reaped, so the
                // key ends Vacant (never restore a dead runtime as Live).
                let _ = guard.disarm_and_fail();
                self.broadcast_failure_truth(
                    &req,
                    &operation_id,
                    generation,
                    prior_kind,
                    "TARGET_SPAWN_FAILED",
                )
                .await;
                self.log_transition(
                    TransitionLog {
                        operation_id: &operation_id,
                        provider: &req.provider,
                        session_id: &req.session_id,
                        initiator: &initiator,
                        epoch: self.ownership.boot_epoch(),
                        generation,
                        live_session_key: None,
                        from_kind: prior_kind,
                        to_kind: Some(req.target_kind),
                        runtime_id: None,
                        pid: None,
                        outcome: "target_spawn_failed",
                        duration_ms: began.elapsed().as_millis() as u64,
                        failure_reason: Some(&code),
                        stale: None,
                    },
                    "ownership.handoff.done",
                    TransitionLevel::Warn,
                );
                typed_failure("TARGET_SPAWN_FAILED", &detail, true, generation)
            }
        }
    }

    /// Round-2 review: a POSITIVE liveness re-probe of the prior runtime (a
    /// reap timeout does NOT imply liveness — and neither does an abort
    /// inside the prior-kill await, round-3 review I-1). Terminal priors:
    /// the registry row's Running status (the same join
    /// `live_session_owner` uses); fresh priors: the lane's
    /// `has_live_session` probe (the same probe the D7 guard uses).
    async fn probe_prior_live(
        &self,
        provider: &str,
        session_id: &str,
        owner: &OwnerIdentity,
    ) -> bool {
        match owner.kind {
            RuntimeOwnerKind::Terminal => owner
                .terminal_id
                .as_deref()
                .map(|tid| {
                    self.registry.probe(tid).is_some_and(|row| {
                        row.status == freshell_protocol::TerminalRunStatus::Running
                    })
                })
                .unwrap_or(false),
            RuntimeOwnerKind::FreshAgent => match provider {
                "codex" => self.fresh_codex.has_live_session(session_id).await,
                "claude" => self.fresh_claude.has_live_session(session_id).await,
                "opencode" => self.fresh_opencode.has_live_session(session_id).await,
                _ => false,
            },
        }
    }

    /// Round-3 review I-1 + whole-branch review M-1 (the claim repairs): a
    /// prior the abort/reap-timeout path is RESTORING as Live resumes at
    /// the RECORD's current (handoff) generation, so every lane-side
    /// fenced claim must be brought to that same generation or the prior's
    /// later kill/exit paths could never match the restored record. Fresh
    /// priors: re-retain the lane stamp (the lane kill may have taken it —
    /// the insert overwrites either way; a real teardown timeout can leave
    /// the runtime alive with its stamp gone). Terminal priors: bump the
    /// registry's retained claim. The repaired claims match the restored
    /// record exactly (same owner identity, the restored generation, the
    /// prior's committing operation id), so the lanes' later
    /// kill/exit-watcher release paths keep working — a taken stamp can
    /// never permanently block repair.
    fn repair_restored_prior_claims(
        &self,
        provider: &str,
        session_id: &str,
        owner: &OwnerIdentity,
        restored_generation: u64,
    ) {
        match owner.kind {
            RuntimeOwnerKind::FreshAgent => {
                let Some(operation_id) = owner.ownership_id.clone() else {
                    // No committing operation id on the identity: no fenced claim
                    // can ever match it (commit_live stamps one) — nothing to
                    // repair against.
                    return;
                };
                let stamp = crate::ownership_lane::OwnershipStamp {
                    epoch: self.ownership.boot_epoch(),
                    generation: restored_generation,
                    operation_id,
                    owner: owner.clone(),
                };
                let stamps = match provider {
                    "codex" => &self.fresh_codex.ownership_stamps,
                    "claude" => &self.fresh_claude.ownership_stamps,
                    _ => &self.fresh_opencode.fresh_agent().ownership_stamps,
                };
                stamps
                    .lock()
                    .expect("ownership stamps lock")
                    .insert(session_id.to_string(), stamp);
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.stamp_repaired",
                    provider, session_id,
                    generation = restored_generation,
                    outcome = "stamp_retained",
                    "handoff restored a live prior; its lane stamp must fence at the restored generation");
            }
            RuntimeOwnerKind::Terminal => {
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    // A Live terminal owner always carries its terminal id
                    // (commit_session_ref_ownership stamps it) — nothing to
                    // repair against without one.
                    return;
                };
                let repaired = self
                    .registry
                    .repair_restored_prior_ownership(terminal_id, restored_generation);
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.terminal_claim_repaired",
                    provider, session_id, terminal_id,
                    generation = restored_generation,
                    outcome = if repaired { "claim_bumped" } else { "no_claim_to_repair" },
                    "handoff restored a live terminal prior; its retained claim must fence \
                     at the restored generation");
            }
        }
    }

    /// Round-2 review (failure-broadcast truth): AFTER `disarm_and_fail`,
    /// observe the ACTUAL resulting state and broadcast it — the restored
    /// prior owner with its kind/runtime identity, or Vacant — plus
    /// previousKind and the typed reason. Remote panes converge on the owner
    /// that really exists, never the requested target, and the
    /// same-generation corrective frame supersedes the handoff-started
    /// transition record on every device (the client fold never drops it —
    /// Task 8).
    /// The failure-truth broadcast (round-2 review): the frame carries the
    /// ACTUAL resulting coordinator snapshot — the owner identity for a
    /// `Live` record, the TYPED fenced truth for a `Fenced` record, or the
    /// true vacancy for a `Vacant` one — plus previousKind and the typed
    /// reason. b8ke e4r1 F1: NEVER a vacant conversion for a fenced or
    /// in-progress record — the client folds EVERY same-generation frame,
    /// so a late generic "vacant" frame overwrites the specific typed
    /// fence frame the unconfirmed-reap regime broadcast moments earlier
    /// (connected remote panes would read a vacant session while the
    /// server keeps blocking every lifecycle operation). The fenced branch
    /// mirrors `broadcast_post_abort_authority` (R5-2): the record's
    /// captured prior identity ("vacant" for a no-prior fence), the
    /// `fenced: true` marker, and the fence's typed wire reason. An
    /// IN-PROGRESS record (this runner's own fence-in-`Handoff` window or
    /// a foreign Starting/Stopping/Handoff) is never asserted over: its
    /// owning operation broadcasts its own phase frames — for the
    /// unconfirmed-reap timeout the fenced `handoff-failed` frame stands as
    /// the last same-generation frame, and a foreign transition owns the
    /// record in the snapshot's place.
    async fn broadcast_failure_truth(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        previous_kind: Option<RuntimeOwnerKind>,
        reason: &str,
    ) {
        // b8ke e4r2 F3: the snapshot read and the failure send are ordered
        // atomically w.r.t. same-generation resolver broadcasts (the
        // detached confirmation watcher's `released` frame) by the
        // SEND-THEN-RECHECK regime: after each send the record is
        // re-observed, and if it moved WITHIN this operation's
        // generation the resolved state is broadcast — the corrective
        // frame always trails the stale one, so the client's FINAL
        // same-generation frame is the server's. The loop is bounded: the
        // only same-generation resolution in play is the fenced record's
        // release to Vacant (terminal); a record that moved to a foreign
        // in-progress/newer operation is never asserted over (its own
        // frames own the record, and its newer generation wins the
        // client's fold regardless).
        for round in 0..4u8 {
            let snap = self.ownership.observe(&req.provider, &req.session_id);
            let (owner_kind, terminal_id, reason, fenced) = match snap.state {
                freshell_ownership::OwnershipState::Live { ref owner, .. } => (
                    Some(owner.kind),
                    owner.terminal_id.clone(),
                    reason.to_string(),
                    None,
                ),
                freshell_ownership::OwnershipState::Fenced {
                    ref prior,
                    reason: fence_reason,
                    ..
                } => {
                    // b8ke e4r1 F1: the typed fenced truth — the record's
                    // own captured identity, the fenced marker, and the
                    // fence's typed wire reason (never the generic failure
                    // reason over a fenced record).
                    let (owner_kind, terminal_id) = match prior {
                        Some((owner, _)) => (Some(owner.kind), owner.terminal_id.clone()),
                        None => (None, None),
                    };
                    (
                        owner_kind,
                        terminal_id,
                        fence_reason.wire_str().to_string(),
                        Some(true),
                    )
                }
                // In-progress records: never a vacant conversion, never an
                // assertion over a foreign transition — the owning
                // operation's own phase frames stand.
                freshell_ownership::OwnershipState::Handoff { .. }
                | freshell_ownership::OwnershipState::Starting { .. }
                | freshell_ownership::OwnershipState::Stopping { .. } => return,
                // Vacant (or a resolved foreign/Aliased record): the only
                // truthful vacant conversion.
                _ => (None, None, reason.to_string(), None),
            };
            // b8ke e4r2 F3: the deterministic mid-window hold for the
            // watcher-release race test — park BETWEEN the snapshot read
            // and the frame send (never armed in production; the ONCE flag
            // parks only the first send).
            if let Some(hooks) = self.test_hooks.as_ref() {
                if hooks
                    .pause_in_failure_truth_once
                    .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
                    if let Some(pause) = hooks.pause_in_failure_truth_broadcast.as_ref() {
                        hooks
                            .pause_in_failure_truth_parked
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                        let _ = pause.notified().await;
                    }
                }
            }
            self.broadcast_owner(
                req,
                "handoff-failed",
                owner_kind,
                terminal_id,
                operation_id,
                generation,
                previous_kind,
                Some(&reason),
                fenced,
            );
            // THE RECHECK: if the record moved while the frame was being
            // sent, the frame is stale — broadcast the resolved state (the
            // next round re-observes). An unchanged record ends the
            // regime: the sent frame is the server's truth.
            let after = self.ownership.observe(&req.provider, &req.session_id);
            if after.state == snap.state {
                return;
            }
            if round == 3 {
                // Still moving after the bounded rounds — impossible in
                // practice (the only same-generation resolution is the
                // terminal Vacant release); fail loud, never silent.
                tracing::error!(target: "freshell_ownership",
                    operation_id = %operation_id,
                    provider = %req.provider, session_id = %req.session_id,
                    epoch = self.ownership.boot_epoch(), generation,
                    event = "ownership.handoff.failure_truth_unresolved",
                    "the failure-truth broadcast could not settle on a stable \
                     snapshot within its bounded recheck rounds — the last \
                     sent frame may trail the record");
            }
        }
    }

    /// Round-1 review: reap a target runtime whose commit was refused
    /// (stale/foreign) — no owner record points at it, so leaving it running
    /// would be an untracked second writer. Terminal targets: registry kill
    /// (the immediate SIGKILL-and-reap) + confirmed death. Fresh targets:
    /// the same lane teardown the prior stop uses (a REAL timeout there
    /// detaches the confirmation the same way — the watcher's coordinator
    /// release is the op/generation-fenced no-op it should be for a target
    /// that never committed).
    /// b8ke d4 F1: the uncommitted-target teardown's OUTCOME is consumed —
    /// only a CONFIRMED reap lets the caller vacate the coordinator entry.
    /// A reap timeout keeps the kill's confirmation running DETACHED (the
    /// watcher regime — `stop_runtime`/the terminal arm spawn the
    /// confirmation watcher, the failure frame precedes it) and the caller
    /// answers the typed failure with the key FENCED in Handoff (the
    /// watcher releases it once death is confirmed — pre-d4 both callers
    /// discarded the result and vacated the key while the target was
    /// alive/unconfirmed, and the stale-start watcher could no longer
    /// resolve it: the record was already Vacant).
    /// b8ke focused ep5 r4 F1: the failed-transition repair's LANE
    /// DISPATCH — the reaped uncommitted target's provider lane owns the
    /// identity sink, so the runner routes the repair through it (the
    /// same provider→lane dispatch the kill path uses). The epoch is the
    /// coordinator's boot epoch (the same one the under-ticket binding
    /// write's pair carried, so the orphan filter matches the orphaned
    /// row's own stamp exactly). Best-effort on failure: the cleanup
    /// never blocks its coordinator fail on a ledger hiccup, but it logs
    /// LOUD — the consult still refuses the failed transition's late
    /// writes, and a landed orphan row converges at the next claim or
    /// sweep.
    async fn repair_failed_transition_binding_row(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        generation: u64,
    ) {
        let epoch = self.ownership.boot_epoch();
        let sink = match provider {
            "codex" => self.fresh_codex.identity_sink(),
            "claude" => self.fresh_claude.identity_sink(),
            "opencode" => self.fresh_opencode.identity_sink(),
            // An unknown provider never wrote a fresh-agent binding row.
            _ => return,
        };
        let Some(sink) = sink else {
            // The lane has no ledger wired (unwired tests): nothing to
            // repair.
            return;
        };
        if let Err(err) = sink
            .repair_failed_transition(provider, session_id, epoch, generation)
            .await
        {
            tracing::error!(target: "invariant",
                provider = %provider, session_id = %session_id,
                epoch, generation, error = %err,
                event = "ownership.handoff.failed_transition_repair_write_failed",
                "the failed transition's durable ledger repair could not land — \
                 the bridge consult still refuses this transition's late \
                 writes; an already-landed orphan row converges at the next \
                 claim or sweep (kata b8ke focused ep5 r4 F1)"
            );
        }
    }

    async fn reap_uncommitted_target(
        self: &Arc<Self>,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
    ) -> StopOutcomePriv {
        // b8ke d4 F1: the deterministic forced outcome (shared counter
        // budget with stop_runtime — the prior stop consumes the skip).
        if let Some(outcome) = self.forced_stop_outcome(req, owner, operation_id, generation) {
            return outcome;
        }
        match owner.kind {
            RuntimeOwnerKind::Terminal => {
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    return StopOutcomePriv::Reaped;
                };
                // b8ke e4 post-cap F1: confirmed death is the recorded
                // pid's OS-LEVEL death — NEVER the registry kill's return
                // and never the row-based predicate. kill_internal removes
                // the row BEFORE signaling/reaping the PTY, so a CONCURRENT
                // kill can own the removed row while the process lives:
                // a kill() answering false ("no row") was classified as
                // the confirmed reap and the callers vacated the key —
                // another writer before the first kill's reap confirmed.
                // Issue the kill (idempotent — false only means the row is
                // gone) and confirm on the pid; the
                // row-removed-but-pid-alive interval fences typed
                // unconfirmed and the DETACHED watcher (pid-based
                // confirmation) resolves it — never vacates.
                match owner.pid {
                    Some(pid) => {
                        self.registry.kill(terminal_id);
                        let budget = std::time::Duration::from_millis(self.reap_timeout_ms);
                        let mut confirm = std::pin::pin!(async {
                            while freshell_terminal::registry::pid_alive(pid) {
                                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            }
                        });
                        tokio::select! {
                            () = &mut confirm => StopOutcomePriv::Reaped,
                            _ = tokio::time::sleep(budget) => {
                                // The kill was issued (ours or the
                                // concurrent one); the process's death is
                                // merely unobserved — the DETACHED watcher
                                // owns the release (the failure frame
                                // first, FR5), exactly like the prior-stop
                                // arm.
                                self.broadcast_fenced_reap_timeout(
                                    req, owner, operation_id, generation,
                                );
                                self.spawn_reap_confirmation_watcher(
                                    req,
                                    operation_id,
                                    generation,
                                    "handoff-runner-stale-commit",
                                    owner,
                                    "REAP_TIMEOUT",
                                    async move {
                                        while freshell_terminal::registry::pid_alive(pid) {
                                            tokio::time::sleep(
                                                std::time::Duration::from_millis(25),
                                            )
                                            .await;
                                        }
                                        ReapAnswer::Confirmed
                                    },
                                );
                                StopOutcomePriv::ReapTimeout { fenced: true }
                            }
                        }
                    }
                    None => {
                        // No recorded pid (a degenerate identity): the best
                        // available evidence is the row-based poll after
                        // OUR OWN kill removed the row — a kill() answering
                        // false means nothing existed under this identity
                        // (no row, no pid — no concurrent-kill window CAN
                        // apply to a pid-less identity, whose row a real
                        // concurrent killer would have spawned with a pid).
                        if self.registry.kill(terminal_id) {
                            let budget = std::time::Duration::from_millis(self.reap_timeout_ms);
                            let mut confirm =
                                std::pin::pin!(await_terminal_dead(&self.registry, terminal_id,));
                            tokio::select! {
                                () = &mut confirm => StopOutcomePriv::Reaped,
                                _ = tokio::time::sleep(budget) => {
                                    self.broadcast_fenced_reap_timeout(
                                        req, owner, operation_id, generation,
                                    );
                                    let registry = self.registry.clone();
                                    let tid = terminal_id.to_string();
                                    self.spawn_reap_confirmation_watcher(
                                        req,
                                        operation_id,
                                        generation,
                                        "handoff-runner-stale-commit",
                                        owner,
                                        "REAP_TIMEOUT",
                                        async move {
                                            await_terminal_dead(&registry, &tid).await;
                                            ReapAnswer::Confirmed
                                        },
                                    );
                                    StopOutcomePriv::ReapTimeout { fenced: true }
                                }
                            }
                        } else {
                            // No row to kill (already gone — and no pid was
                            // ever recorded for this identity): confirmed
                            // absent.
                            StopOutcomePriv::Reaped
                        }
                    }
                }
            }
            RuntimeOwnerKind::FreshAgent => {
                let outcome = self
                    .stop_runtime(
                        req,
                        owner,
                        "handoff-runner-stale-commit",
                        operation_id,
                        generation,
                    )
                    .await;
                // b8ke focused ep5 r4 F1: the FAILED-TRANSITION REPAIR —
                // this runtime is an UNCOMMITTED handoff target being
                // reaped by its own failing transition (the abort cleanup,
                // the flavor-write failure, or the stale-commit unwind —
                // this function is their one shared choke point, and the
                // PRIOR stop never routes through it). Its authoritative
                // binding write may have landed, be in flight, or arrive
                // late (a `spawn_blocking` closure whose bridge consult
                // passed before the cancel), so the transition's cleanup
                // lands the ledger repair: the durable tombstone fence
                // (suppressing any late write from this transition) plus
                // the conditional retire of the transition's own orphaned
                // row. Fires for EVERY verdict — Reaped, fenced
                // ReapTimeout, PlatformLimited — the target is abandoned
                // in all three, and its identity claim must not outlive
                // the transition that failed.
                self.repair_failed_transition_binding_row(
                    &req.provider,
                    &req.session_id,
                    generation,
                )
                .await;
                outcome
            }
        }
    }

    /// b8ke d4 F1: the hook's deterministic fenced-timeout watcher —
    /// a confirmation that resolves CONFIRMED after a short delay, so the
    /// tests can observe BOTH halves of the regime: the key stays FENCED
    /// in Handoff immediately after the typed failure (never Vacant over
    /// an unconfirmed target), then the detached watcher RESOLVES it to
    /// Vacant once its confirmation lands.
    fn spawn_noop_reap_watcher(
        self: &Arc<Self>,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        owner: &OwnerIdentity,
    ) {
        let confirmation = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            ReapAnswer::Confirmed
        };
        self.spawn_reap_confirmation_watcher(
            req,
            operation_id,
            generation,
            "handoff-runner-stale-commit",
            owner,
            "REAP_TIMEOUT",
            confirmation,
        );
    }

    /// b8ke d4 F1: consume the uncommitted-target reap's outcome. Only a
    /// CONFIRMED reap lets the caller vacate the coordinator entry; a reap
    /// timeout keeps the key FENCED in Handoff (the detached watcher owns
    /// the release — same regime as the prior-stop path), and a
    /// platform-limited teardown fences `Fenced{PlatformLimited}` (the
    /// documented no-watcher tradeoff). Returns `true` when the caller may
    /// vacate (the confirmed-reap shape).
    /// b8ke e4r1 F2: whether the uncommitted-target teardown CONFIRMED the
    /// target's death — `Reaped` (the reap answered) or the pre-kill
    /// short-circuit (`ReapTimeout { fenced: false }`: nothing was ever
    /// spawned/killed). A fenced timeout or a platform-limited teardown
    /// was explicitly NOT confirmed. The truthful outcome-label class for
    /// the failure arms' done-lines (a blanket "reaped" would record the
    /// opposite of the safety-critical outcome).
    fn uncommitted_target_reap_confirmed(outcome: &StopOutcomePriv) -> bool {
        matches!(
            outcome,
            StopOutcomePriv::Reaped | StopOutcomePriv::ReapTimeout { fenced: false }
        )
    }

    fn uncommitted_target_reap_vacates(
        &self,
        outcome: &StopOutcomePriv,
        guard: &mut HandoffGuard,
    ) -> bool {
        match outcome {
            StopOutcomePriv::Reaped => {
                let _ = guard.disarm_and_fail();
                true
            }
            StopOutcomePriv::ReapTimeout { fenced: true } => {
                // The watcher performs the release — the key stays FENCED in
                // Handoff; a timeout-watcher/probe can still resolve it.
                guard.disarm();
                false
            }
            StopOutcomePriv::PlatformLimitedFenced => {
                guard.disarm();
                false
            }
            StopOutcomePriv::ReapTimeout { fenced: false } => {
                // The pre-kill short-circuit (no teardown was issued):
                // nothing was killed, the entry may vacate.
                let _ = guard.disarm_and_fail();
                true
            }
        }
    }

    /// A minimal synthetic request for the cleanup paths (the Drop cannot
    /// reach the original — only the pieces `reap_uncommitted_target`'s
    /// stop dispatch reads are needed).
    fn cleanup_request(
        &self,
        provider: &str,
        session_id: &str,
        kind: RuntimeOwnerKind,
    ) -> HandoffRequest {
        HandoffRequest {
            action: HandoffAction::Switch,
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            target_kind: kind,
            session_type: None,
            mode: None,
            cwd: None,
            tab_id: None,
            pane_id: None,
            observed_epoch: None,
            observed_generation: None,
            device_id: Some("handoff-guard-cleanup".into()),
        }
    }

    /// Round-3 review I-1: the abort/panic cleanup's coordinator half, run
    /// on the Drop's detached task. b8ke focused round-3 review R3-6: the
    /// UNCOMMITTED-TARGET reap runs FIRST — the record stays in this
    /// operation's `Handoff` (every competing begin Blocked with the typed
    /// in-flight answer) until the fresh target's `NotConfirmed`
    /// continuation settles (or a bounded kill confirms) — the record never
    /// goes plain-Vacant while an uncommitted target may live. THEN the
    /// prior half: re-probe the prior's liveness (KillInFlight — the
    /// reap-timeout discipline: a dying prior is never restored as Live;
    /// a confirmed-live one is restored WITH its lane claims repaired to
    /// the restored generation) or use the guard's known value
    /// (NotIssued/Reaped), and fail accordingly. An UNCONFIRMED or
    /// PLATFORM-LIMITED target reap never fails to plain Vacant — the key
    /// fences typed (recoverable) instead.
    async fn abort_cleanup(self: &Arc<Self>, payload: AbortPayload, decision: AbortFailDecision) {
        let AbortPayload {
            provider,
            session_id,
            operation_id,
            generation,
            prior,
            target_kind,
            target,
            ..
        } = &payload;
        // b8ke ext r8 F6: the unconfirmed TARGET's identity — the runtime
        // whose death the fence awaits (the spawn's returned identity when
        // start_target returned, else the resumed session's kind+key — the
        // SAME probe identity the R5-1 replacement watcher uses). The
        // abort fences name it (the normal failure paths already do);
        // pre-r8 they defaulted to the Handoff record's already-reaped
        // SOURCE (or vacant on a from-vacant handoff), so snapshots, logs,
        // broadcasts, and typed responses named a dead runtime while the
        // potentially live TARGET went unnamed.
        let fence_target = target.clone().unwrap_or_else(|| OwnerIdentity {
            kind: *target_kind,
            terminal_id: None,
            live_session_key: Some(session_id.clone()),
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        });
        let target_outcome = self.abort_reap_uncommitted_target(&payload).await;
        let confirmed_live = match prior.as_ref() {
            Some((owner, _)) => {
                let live = match decision {
                    AbortFailDecision::Probe => {
                        self.probe_prior_live(provider, session_id, owner).await
                    }
                    AbortFailDecision::Known(live) => live,
                };
                match target_outcome {
                    UncommittedTargetOutcome::Reaped | UncommittedTargetOutcome::NothingToDo => {
                        let outcome = self.ownership.fail(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            live,
                        );
                        if live && matches!(outcome, FailOutcome::RestoredPriorOwner) {
                            self.repair_restored_prior_claims(
                                provider,
                                session_id,
                                owner,
                                *generation,
                            );
                        }
                    }
                    UncommittedTargetOutcome::PlatformLimited => {
                        // R3-6 + the round-2 R2-3 discipline: the target's
                        // descendant tree is unverifiable on this platform —
                        // fence typed (a new writer can never start against
                        // the unconfirmable target), never plain Vacant.
                        let fenced = self.ownership.fence_unconfirmed_handoff_with_prior(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::PlatformLimited,
                            Some((fence_target.clone(), *generation)),
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_platform_limited",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target could not be \
                             confirmed dead on this platform — the key fences typed");
                    }
                    UncommittedTargetOutcome::Unconfirmed => {
                        // R3-6 fail-closed: the escalation continuation was
                        // lost or resolved unconfirmed — a live unowned
                        // writer may remain, so the key fences typed rather
                        // than reopening.
                        // b8ke focused round-5 review R5-1: the fence is
                        // NEVER watcher-less — the replacement confirmation
                        // watcher (the r2/e3887a378 pattern) probes the
                        // uncommitted target's recorded identity and only
                        // a confirmed death releases the fence; without it
                        // the key blocked until a server restart.
                        let fenced = self.ownership.fence_unconfirmed_handoff_with_prior(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::WatcherFailed,
                            Some((fence_target.clone(), *generation)),
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_unconfirmed_target",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target reap never confirmed \
                             death — the key fences typed (never plain Vacant); the \
                             replacement confirmation watcher owns the release");
                        self.spawn_abort_target_reconfirmation(&payload);
                    }
                }
                live
            }
            None => {
                match target_outcome {
                    UncommittedTargetOutcome::Reaped | UncommittedTargetOutcome::NothingToDo => {
                        let _ = self.ownership.fail(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            false,
                        );
                    }
                    // b8ke focused round-5 review R5-1: a handoff may
                    // legitimately start from VACANT — the abort's target
                    // reap outcomes must fence with the SAME typed
                    // separation as the prior arm, never the folded
                    // watcher-less WatcherFailed fence the pre-fix path
                    // produced for BOTH outcomes (a PlatformLimited
                    // teardown was unrecoverable: force_release_platform_
                    // limited only clears PlatformLimited fences, and no
                    // watcher existed to confirm the target's death —
                    // the session blocked until a server restart).
                    UncommittedTargetOutcome::PlatformLimited => {
                        // Typed PlatformLimited (recoverable through the
                        // acknowledged force-clear): the target's teardown
                        // confirmed the direct child's exit but cannot
                        // verify the descendant tree on this platform.
                        let fenced = self.ownership.fence_unconfirmed_handoff_with_prior(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::PlatformLimited,
                            Some((fence_target.clone(), *generation)),
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_platform_limited",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target could not be \
                             confirmed dead on this platform — the key fences TYPED \
                             PlatformLimited (the acknowledged force-clear recovers it)");
                    }
                    UncommittedTargetOutcome::Unconfirmed => {
                        // Typed WatcherFailed WITH the replacement
                        // confirmation watcher — the r2/e3887a378 pattern:
                        // the bounded probe re-issues the target's lane
                        // kill-and-confirm and only a confirmed death
                        // releases the fence. Never a watcher-less fence.
                        let fenced = self.ownership.fence_unconfirmed_handoff_with_prior(
                            provider,
                            session_id,
                            operation_id,
                            *generation,
                            freshell_ownership::FenceReason::WatcherFailed,
                            Some((fence_target.clone(), *generation)),
                        );
                        tracing::error!(target: "freshell_ownership",
                            event = "ownership.handoff.abort_fenced_unconfirmed_target",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = self.ownership.boot_epoch(), generation,
                            outcome = ?fenced,
                            "the aborted handoff's uncommitted target reap never confirmed \
                             death — the key fences typed (never plain Vacant); the \
                             replacement confirmation watcher owns the release");
                        self.spawn_abort_target_reconfirmation(&payload);
                    }
                }
                false
            }
        };
        // b8ke focused round-5 review R5-2: broadcast the post-abort
        // AUTHORITATIVE owner state — connected devices hold the stale
        // `handoff-started` record otherwise (no fenced marker/reason, no
        // restored owner, no vacancy) until a reconnect heals through the
        // ready replay. Same envelope as the other transitions: the
        // fenced outcomes carry the r4 `fenced: true` marker + the typed
        // reason (the fenced prior's kind — "vacant" for a no-prior
        // fence); the restored prior is named as the authoritative owner;
        // the vacancy is the `released` frame.
        self.broadcast_post_abort_authority(
            provider,
            session_id,
            operation_id,
            payload.target_kind,
            prior.as_ref().map(|(owner, _)| owner.kind),
            // b8ke e4r3 F1: the abort's OWN generation — the broadcast
            // refuses to publish when the record has moved on.
            *generation,
        )
        .await;
        tracing::warn!(target: "freshell_ownership",
            event = "ownership.handoff.abort_settled",
            operation_id = %operation_id, provider = %provider, session_id = %session_id,
            epoch = self.ownership.boot_epoch(), generation,
            outcome = if confirmed_live { "restored_prior_owner" } else { "vacant" },
            target_reap = ?target_outcome,
            failure_reason = "RUNNER_ABORTED",
            "handoff runner aborted inside the prior-reap window; liveness re-probed before restore");
    }

    /// b8ke focused round-5 review R5-2: broadcast the post-abort
    /// AUTHORITATIVE owner state — connected devices hold the stale
    /// `handoff-started` record otherwise (no fenced marker/reason, no
    /// restored owner, no vacancy) until a reconnect heals through the
    /// ready replay. Same envelope as the other transitions: the fenced
    /// outcomes carry the r4 `fenced: true` marker + the typed reason
    /// (the fenced prior's kind — "vacant" for a no-prior fence); the
    /// restored prior is named as the authoritative owner; the vacancy is
    /// the `released` frame. A foreign in-progress transition owns the
    /// record in the snapshot's place — its own operation broadcasts its
    /// frames, never this one.
    async fn broadcast_post_abort_authority(
        &self,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        target_kind: RuntimeOwnerKind,
        previous_kind: Option<RuntimeOwnerKind>,
        abort_generation: u64,
    ) {
        // b8ke e4r3 F1: the deterministic entry hold for the
        // foreign-commit race test — park BEFORE the snapshot observe
        // (never armed in production; the ONCE flag parks only the first
        // call).
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks
                .pause_post_abort_broadcast_once
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                if let Some(pause) = hooks.pause_post_abort_broadcast.as_ref() {
                    hooks
                        .pause_post_abort_broadcast_parked
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = pause.notified().await;
                }
            }
        }
        let snapshot = self.ownership.observe(provider, session_id);
        // b8ke e4r3 F1: the abort broadcast is ORDERED with the failed
        // transition — the sync-abort path releases the coordinator
        // (disarm_and_fail) and then queues this broadcast as an
        // independent task, so a lifecycle request on another device can
        // claim and commit the NEXT generation before the task runs.
        // REFUSE to publish when the observed generation has moved past
        // the abort's own: the record belongs to the newer operation,
        // whose own frames own it. (Pre-e4r3 this task observed the new
        // Live state and stamped the OLD operation's
        // RUNNER_ABORTED/handoff-failed frame with the NEW generation —
        // the client folds every same-generation frame, so the stale
        // abort frame overwrote the new operation's handoff-committed
        // transition, leaving opposite-kind panes at "being reopened
        // elsewhere" with the attach action suppressed.)
        if snapshot.generation != abort_generation {
            tracing::warn!(target: "freshell_ownership",
                operation_id = %operation_id, provider = %provider, session_id = %session_id,
                epoch = self.ownership.boot_epoch(),
                abort_generation,
                observed_generation = snapshot.generation,
                event = "ownership.handoff.abort_broadcast_superseded",
                "the post-abort broadcast was superseded — the record moved to \
                 a newer generation before the queued task ran; the newer \
                 operation's own frames own the record"
            );
            return;
        }
        let cleanup_req = self.cleanup_request(provider, session_id, target_kind);
        match &snapshot.state {
            freshell_ownership::OwnershipState::Fenced {
                prior: fenced_prior,
                reason,
                ..
            } => {
                let (owner_kind, terminal_id) = match fenced_prior {
                    Some((owner, _)) => (Some(owner.kind), owner.terminal_id.clone()),
                    None => (None, None),
                };
                self.broadcast_owner(
                    &cleanup_req,
                    "handoff-failed",
                    owner_kind,
                    terminal_id,
                    operation_id,
                    snapshot.generation,
                    previous_kind,
                    Some(reason.wire_str()),
                    Some(true),
                );
            }
            freshell_ownership::OwnershipState::Live { .. } => {
                // The restored prior is the authoritative owner — the
                // failure-truth envelope reads and names it (or the
                // vacancy if the record moved on).
                self.broadcast_failure_truth(
                    &cleanup_req,
                    operation_id,
                    snapshot.generation,
                    previous_kind,
                    "RUNNER_ABORTED",
                )
                .await;
            }
            freshell_ownership::OwnershipState::Vacant => {
                self.broadcast_owner(
                    &cleanup_req,
                    "released",
                    None,
                    None,
                    operation_id,
                    snapshot.generation,
                    previous_kind,
                    Some("RUNNER_ABORTED"),
                    None,
                );
            }
            // A foreign in-progress transition owns the record — its own
            // operation broadcasts its frames; never assert over it.
            _ => {}
        }
    }

    /// b8ke focused round-5 review R5-1: the replacement confirmation
    /// watcher for an aborted handoff's UNCONFIRMED target — the
    /// r2/e3887a378 pattern, applied to the abort-cleanup fence. The
    /// bounded probe re-issues the TARGET's lane kill-and-confirm (the
    /// recorded condemned identity the lane kill armed) and ONLY a
    /// confirmed death releases the fence — never a watcher-less
    /// WatcherFailed fence. The probe identity is the uncommitted target
    /// itself: the known spawn identity when `start_target` returned, or
    /// the canonical session key (fresh lanes probe
    /// `confirm_fenced_prior_dead(sessionId)` by id) for a target whose
    /// spawn await was dropped mid-flight.
    fn spawn_abort_target_reconfirmation(self: &Arc<Self>, payload: &AbortPayload) {
        let AbortPayload {
            provider,
            session_id,
            operation_id,
            generation,
            target_kind,
            target,
            spawn_watch,
            ..
        } = payload;
        let probe_target = target.clone().unwrap_or_else(|| OwnerIdentity {
            kind: *target_kind,
            terminal_id: None,
            live_session_key: Some(session_id.clone()),
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        });
        let cleanup_req = self.cleanup_request(provider, session_id, *target_kind);
        // b8ke ext r10 F3: when the abort left a DETACHED TERMINAL SPAWN
        // unsettled (the pre-publication window — the cleanup's bounded
        // settle-wait timed out, so the outcome fenced Unconfirmed), the
        // confirmation is the SETTLE-THEN-REAP future: await the spawn's
        // settle (unbounded — the key holds until the spawn publishes or
        // dies), reap the terminal it published (plus the registry
        // sessionRef sweep's provider-matched rows), and only the
        // confirmed death releases the fence. The identity-probing
        // `prior_death_reconfirmation` cannot resolve this shape (a
        // pre-publication terminal target has NO terminal id to probe —
        // its fail-closed loop would hold the fence forever while the
        // late-published spawn ran on unowned).
        let confirmation: std::pin::Pin<Box<dyn std::future::Future<Output = ReapAnswer> + Send>> =
            if target.is_none() && spawn_watch.is_some() {
                Box::pin(self.spawn_settle_reconfirmation(
                    provider,
                    session_id,
                    spawn_watch.clone().expect("checked Some"),
                ))
            } else {
                Box::pin(self.prior_death_reconfirmation(provider, session_id, &probe_target))
            };
        self.spawn_reap_confirmation_watcher(
            &cleanup_req,
            operation_id,
            *generation,
            "handoff-guard-cleanup",
            &probe_target,
            "RUNNER_ABORTED",
            confirmation,
        );
    }

    /// b8ke ext r10 F3: the SETTLE-THEN-REAP confirmation for an aborted
    /// handoff's detached, unsettled terminal spawn — the fail-closed
    /// timeout arm's resolution future. Awaits the spawn's settle, reaps
    /// whatever it published (the published terminal + the registry
    /// sessionRef sweep's provider-matched rows), and answers Confirmed
    /// once the published terminal is dead (or the settle finished with
    /// nothing published — the spawn died pre-publication). Never
    /// answers while a published terminal may still run: the fence holds
    /// until the late-published spawn is killed.
    fn spawn_settle_reconfirmation(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        watch: crate::terminal_tabs::HandoffSpawnWatch,
    ) -> impl std::future::Future<Output = ReapAnswer> + Send + 'static {
        let registry = self.registry.clone();
        let reap_timeout_ms = self.reap_timeout_ms;
        let provider = provider.to_string();
        let session_id = session_id.to_string();
        async move {
            // HOLD until the spawn settles — publishes or dies (unbounded:
            // an unsettled spawn means the target's state is unconfirmed).
            watch.wait_settled_unbounded().await;
            // b8ke ext r16 F1: the confirmation boolean PROPAGATES —
            // Confirmed only when every reaped target's death was
            // actually confirmed (the recorded PID's OS-level death). An
            // unconfirmed outcome answers Lost, keeping the typed fence +
            // the replacement-watcher regime armed (pre-r16 the boolean
            // was discarded and the answer was unconditionally Confirmed,
            // so a concurrent kill that removed the row while the
            // recorded PID stayed alive released the fence and licensed
            // another writer beside the abandoned target).
            let mut all_confirmed = true;
            if let Some(terminal_id) = watch.published_terminal() {
                // b8ke ext r13 F7: the watch's RECORDED PID (captured at
                // publication) is the death evidence — the row's absence
                // is not.
                let recorded_pid = watch.published_pid();
                if !kill_and_confirm_terminal_pid(
                    &registry,
                    &terminal_id,
                    recorded_pid,
                    reap_timeout_ms,
                )
                .await
                {
                    all_confirmed = false;
                }
            }
            // The registry sessionRef sweep backstop (the cleanup arm's
            // same provider-matched join — an opaque-id collision across
            // providers must never abort an unrelated terminal).
            for entry in registry.directory() {
                if entry.mode == provider.as_str()
                    && entry.resume_session_id.as_deref() == Some(session_id.as_str())
                    && !kill_and_confirm_terminal_pid(
                        &registry,
                        &entry.terminal_id,
                        registry.pid_of(&entry.terminal_id),
                        reap_timeout_ms,
                    )
                    .await
                {
                    all_confirmed = false;
                }
            }
            if all_confirmed {
                ReapAnswer::Confirmed
            } else {
                tracing::error!(target: "invariant",
                    provider = %provider, session_id = %session_id,
                    "spawn_settle_reconfirmation_unconfirmed: the recorded target \
                     PID outlived the reap budget — the fence STAYS (the typed \
                     WatcherFailed regime + the replacement watcher own the resolution)"
                );
                ReapAnswer::Lost
            }
        }
    }

    /// Round-3 review I-1: the abort/panic cleanup's target half — reap the
    /// uncommitted target runtime so no live unowned writer survives:
    /// (a) the KNOWN identity (the spawn returned but the commit never
    ///     happened — round-1 review's window),
    /// (b) the in-flight terminal settle (the spawn await was dropped; the
    ///     settle runs detached to completion — wait for its settlement,
    ///     then reap the terminal it published, with the registry
    ///     sessionRef sweep as the backstop),
    /// (c) a fresh target's registered session (the dropped resume skipped
    ///     its in-function cleanup — the lane kill is idempotent and only
    ///     reached once `start_target` was entered, so the reaped prior can
    ///     never be its victim).
    ///
    /// b8ke focused round-3 review R3-6: the fresh-lane kill's answer is
    /// FULLY consumed — a `NotConfirmed` continuation is AWAITED (the
    /// caller's coordinator record stays fenced in `Handoff` while it
    /// runs), a `PlatformLimited` answer is never a confirmed reap, and
    /// only `Reaped`/`AlreadyGone` release the lane lease. The returned
    /// outcome tells the cleanup's coordinator half whether the record may
    /// fail (Reaped/NothingToDo) or must fence typed instead.
    async fn abort_reap_uncommitted_target(
        self: &Arc<Self>,
        payload: &AbortPayload,
    ) -> UncommittedTargetOutcome {
        let AbortPayload {
            provider,
            session_id,
            operation_id,
            generation,
            target_kind,
            target_spawn_begun,
            target,
            spawn_watch,
            ..
        } = payload;
        if let Some(target) = target.as_ref() {
            // b8ke e4r2 F1: the post-spawn abort's teardown OUTCOME is
            // CONSUMED, identically to the runner's flavor/stale-commit
            // callers — the target RETURNED before the abort landed (the
            // flavor-window cancellation), so THIS teardown owns the
            // confirmation regime: a fenced timeout keeps the kill's
            // confirmation DETACHED (the watcher spawned inside resolves
            // the fence) and a platform-limited teardown can never confirm
            // — neither may vacate. Pre-e4r2 the outcome was discarded and
            // the second lane kill below ran over it: it answered
            // AlreadyGone (the map entry the first teardown removed),
            // which was converted to Reaped, and `abort_cleanup` VACATED
            // while the first teardown was unconfirmed — a competing
            // lifecycle request could start a second writer.
            let req = self.cleanup_request(provider, session_id, target.kind);
            let outcome = self
                .reap_uncommitted_target(&req, target, operation_id, *generation)
                .await;
            match outcome {
                // Confirmed death (or the pre-kill short-circuit proved
                // nothing was spawned): the second lane kill is redundant
                // idempotence — the first teardown already owns the reap,
                // and its AlreadyGone can only ever repeat the confirmed
                // truth. Release the fresh lane's held lease exactly like
                // the second-kill arm did (the awaited confirmed tree
                // death is the precise release).
                StopOutcomePriv::Reaped | StopOutcomePriv::ReapTimeout { fenced: false } => {
                    if target.kind == RuntimeOwnerKind::FreshAgent {
                        self.release_fresh_lane_lease(provider, session_id);
                    }
                    return UncommittedTargetOutcome::Reaped;
                }
                // Unconfirmed first teardown: NEVER vacate — the typed
                // verdicts fence (abort_cleanup's Unconfirmed arm fences
                // + the replacement confirmation watcher; the
                // PlatformLimited arm fences the typed reason). The
                // confirmation watcher owns the resolution, and the second
                // lane kill never runs — its AlreadyGone can never be
                // converted to a confirmed reap over the unconfirmed first
                // teardown.
                StopOutcomePriv::ReapTimeout { fenced: true } => {
                    tracing::warn!(target: "freshell_ownership",
                        operation_id = %operation_id, provider = %provider,
                        session_id = %session_id,
                        event = "ownership.handoff.abort_target_teardown_unconfirmed",
                        "the aborted handoff's post-spawn target teardown is \
                         unconfirmed — the key fences typed (never Vacant over \
                         an unconfirmed target); the confirmation watcher owns \
                         the resolution");
                    return UncommittedTargetOutcome::Unconfirmed;
                }
                StopOutcomePriv::PlatformLimitedFenced => {
                    return UncommittedTargetOutcome::PlatformLimited;
                }
            }
        }
        if let Some(watch) = spawn_watch.as_ref() {
            // b8ke ext r10 F3: the bounded settle-wait's result is
            // CONSUMED — an UNSETTLED spawn means the target's state is
            // UNCONFIRMED, and the cleanup FAILS CLOSED: the key fences
            // typed (never release-and-hope) and the replacement
            // confirmation watcher owns the resolution — it awaits the
            // spawn's settle (publishes or dies), reaps the terminal it
            // published, and only a confirmed death releases the fence.
            // Pre-r10 the timeout was discarded: the cleanup saw no
            // published terminal, classified NothingToDo, and RELEASED —
            // the detached spawn could then publish a live unowned writer.
            if !watch.wait_settled().await {
                tracing::error!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id,
                    event = "ownership.handoff.abort_target_spawn_settle_unsettle",
                    "the aborted handoff's detached terminal spawn never settled within \
                     the cleanup budget — the target's state is unconfirmed; the key \
                     fences typed (never release-and-hope); the replacement confirmation \
                     watcher awaits the spawn's settle and reaps what it publishes"
                );
                return UncommittedTargetOutcome::Unconfirmed;
            }
            // b8ke ext r19 F1: the confirmation result PROPAGATES. The
            // published arm kills with the WATCH's recorded PID (captured
            // at publication — the row may already be gone) and an
            // unconfirmed reap answers `Unconfirmed` (NOT NothingToDo):
            // ownership is retained/fenced and the existing
            // reconfirmation/replacement-watcher path starts — a
            // competing lifecycle request can never acquire the key while
            // the uncommitted terminal writer stays alive.
            let mut all_confirmed = true;
            if let Some(terminal_id) = watch.published_terminal() {
                let recorded_pid = watch.published_pid();
                if !kill_and_confirm_terminal_pid(
                    &self.registry,
                    &terminal_id,
                    recorded_pid,
                    self.reap_timeout_ms,
                )
                .await
                {
                    all_confirmed = false;
                    tracing::error!(target: "invariant",
                        terminal_id = %terminal_id,
                        provider = %provider, session_id = %session_id,
                        "abort_published_target_reap_unconfirmed: the recorded PID \
                         outlived the reap budget — the abort answers Unconfirmed (the \
                         fence + replacement watcher own the resolution), never \
                         NothingToDo"
                    );
                }
            }
            // Backstop: any registry row still holding the canonical
            // sessionRef UNDER THIS HANDOFF'S PROVIDER is an uncommitted
            // spawn for this handoff — reap it. b8ke delta review F6: the
            // row must ALSO match the provider (the registry-row join every
            // sessionRef lookup uses: `mode == provider`) — an opaque-id
            // collision across providers must never abort an unrelated
            // terminal.
            for entry in self.registry.directory() {
                if entry.mode == provider.as_str()
                    && entry.resume_session_id.as_deref() == Some(session_id.as_str())
                    && !self.kill_and_confirm_terminal(&entry.terminal_id).await
                {
                    all_confirmed = false;
                    tracing::error!(target: "invariant",
                        terminal_id = %entry.terminal_id,
                        provider = %provider, session_id = %session_id,
                        "abort_sweep_target_reap_unconfirmed: the row's runtime \
                         outlived the reap budget — the abort answers Unconfirmed"
                    );
                }
            }
            if !all_confirmed {
                return UncommittedTargetOutcome::Unconfirmed;
            }
        }
        if *target_spawn_begun && *target_kind == RuntimeOwnerKind::FreshAgent {
            let initiator = "handoff-guard-cleanup";
            let result = match provider.as_str() {
                "codex" => {
                    self.fresh_codex
                        .kill_for_handoff(session_id, initiator)
                        .await
                }
                "claude" => {
                    self.fresh_claude
                        .kill_for_handoff(session_id, initiator)
                        .await
                }
                "opencode" => {
                    self.fresh_opencode
                        .opencode_kill_for_handoff(session_id, initiator)
                        .await
                }
                _ => return UncommittedTargetOutcome::Unconfirmed,
            };
            let reaped = match result {
                StopResult::Reaped | StopResult::AlreadyGone => true,
                // R3-6: a platform-limited teardown (the direct child's
                // awaited exit is the portable floor, the descendant tree is
                // unverifiable) must never count as the confirmed reap of
                // the uncommitted target — the caller fences typed.
                StopResult::PlatformLimited => {
                    return UncommittedTargetOutcome::PlatformLimited;
                }
                // R3-6: the lane's escalation continuation IS the
                // confirmation — await it (the coordinator record stays
                // fenced in Handoff while it runs). A lost/unconfirmed
                // continuation never reopens the key.
                StopResult::NotConfirmed { confirmation } => {
                    // b8ke focused round-5 review R5-1 test seam: model
                    // the LOST continuation (the dropped escalation) —
                    // the cleanup answers Unconfirmed and the fence's
                    // replacement watcher owns the confirmation. Never
                    // armed in production.
                    if let Some(hooks) = self.test_hooks.as_ref() {
                        if hooks
                            .drop_abort_target_confirmation_once
                            .swap(false, std::sync::atomic::Ordering::SeqCst)
                        {
                            tracing::warn!(target: "freshell_ownership",
                                operation_id = %operation_id, provider = %provider,
                                session_id = %session_id,
                                event = "ownership.handoff.abort_target_confirmation_dropped_seam",
                                "test seam: the uncommitted target's NotConfirmed continuation \
                                 is dropped — the cleanup answers Unconfirmed"
                            );
                            return UncommittedTargetOutcome::Unconfirmed;
                        }
                    }
                    confirmation.await
                }
            };
            // b8ke focused ep5 r4 F1: the SAME failed-transition repair as
            // `reap_uncommitted_target`'s identified-target arm — this is
            // the spawned-but-identity-unrecorded target (the abort landed
            // between the spawn and start_target's return), whose binding
            // write is equally in flight or landed.
            self.repair_failed_transition_binding_row(provider, session_id, *generation)
                .await;
            if reaped {
                // The aborted resume's lease guard dropped ARMED with its
                // kill handle set (the child existed), so the lease is held
                // for TTL recovery — but the teardown we just awaited IS
                // the confirmed tree death, so the precise release applies
                // and the typed RETRYABLE failure stays honestly retryable.
                self.release_fresh_lane_lease(provider, session_id);
                UncommittedTargetOutcome::Reaped
            } else {
                UncommittedTargetOutcome::Unconfirmed
            }
        } else {
            UncommittedTargetOutcome::NothingToDo
        }
    }

    /// Release a fresh lane's held sessionRef lease after a CONFIRMED tree
    /// kill (the `force_release_after_confirmed_kill` contract). No-op for
    /// unknown providers (nothing was reaped).
    fn release_fresh_lane_lease(&self, provider: &str, session_id: &str) {
        match provider {
            "codex" => self
                .fresh_codex
                .leases()
                .force_release_after_confirmed_kill(provider, session_id),
            "claude" => self
                .fresh_claude
                .leases()
                .force_release_after_confirmed_kill(provider, session_id),
            "opencode" => self
                .fresh_opencode
                .leases
                .force_release_after_confirmed_kill(provider, session_id),
            _ => {}
        }
    }

    /// Registry kill + bounded confirmed death (the runner's reap shape).
    /// b8ke ext r19 F1: the wrapper now RETURNS the typed confirmation —
    /// no call site can silently discard a timed-out reap as
    /// success-or-nothing (pre-r19 the bool was dropped, so a
    /// cancellation after publication with the recorded PID outliving the
    /// budget classified `NothingToDo` and the cleanup vacated to plain
    /// Vacant while the uncommitted writer stayed alive).
    async fn kill_and_confirm_terminal(&self, terminal_id: &str) -> bool {
        // b8ke ext r13 F7: the recorded-PID OS-level death is the
        // confirmation — never the row's absence (a concurrent kill
        // removes the row before its blocking PTY kill completes).
        kill_and_confirm_terminal_pid(&self.registry, terminal_id, None, self.reap_timeout_ms).await
    }

    /// Stop the prior runtime and await the CONFIRMED reap (bounded by
    /// `reap_timeout_ms`). Terminal priors: the registry group-kill +
    /// dead-poll (the `kill_session_ref_holder_and_confirm` discipline);
    /// fresh priors: the lane's `kill_for_handoff` teardown (never the shared
    /// opencode serve). `force_reap_timeout` (test hook) short-circuits
    /// BEFORE any kill is issued.
    ///
    /// b8ke delta review F3: a REAL timeout (the kill issued, the death
    /// delayed past the budget) must NOT drop the in-flight teardown —
    /// `tokio::select!` polls the confirmation WITHOUT consuming it, so the
    /// timeout branch hands the still-running teardown to a DETACHED
    /// watcher and reports the fenced timeout. The watcher owns the
    /// coordinator release from there ([`Self::spawn_reap_confirmation_watcher`]).
    ///
    /// b8ke focused review FR5: every fenced branch broadcasts the
    /// `handoff-failed` frame BEFORE spawning the detached watcher — the
    /// broadcast is a synchronous channel send on THIS task, so no
    /// `released` frame can ever precede the failure frame on the bus (a
    /// same-generation client fold would otherwise latch the stale
    /// prior-owner frame over the corrective release).
    ///
    /// b8ke focused review FR3: a lane answering
    /// [`StopResult::NotConfirmed`] (its bounded tree-death confirmation
    /// window expired with the runtime still alive) takes the SAME fenced
    /// path — the carried continuation is the watcher's confirmation.
    /// b8ke d4 F1: the test hooks' deterministic forced outcomes — the
    /// pre-kill `fenced:false` short-circuit, plus the fenced timeout /
    /// PlatformLimited shapes gated on the shared skip counters (so a
    /// test can pass the prior stop normally and force the TARGET reap —
    /// consulted at the top of BOTH `stop_runtime` and
    /// `reap_uncommitted_target`, one shared counter budget).
    fn forced_stop_outcome(
        self: &Arc<Self>,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
    ) -> Option<StopOutcomePriv> {
        let hooks = self.test_hooks.as_ref()?;
        if hooks
            .force_reap_timeout
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Some(StopOutcomePriv::ReapTimeout { fenced: false });
        }
        if hooks
            .force_reap_timeout_fenced
            .load(std::sync::atomic::Ordering::SeqCst)
            && hooks
                .force_reap_timeout_fenced_skip
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |n| if n == 0 { None } else { Some(n - 1) },
                )
                .is_err()
        {
            self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
            self.spawn_noop_reap_watcher(req, operation_id, generation, owner);
            return Some(StopOutcomePriv::ReapTimeout { fenced: true });
        }
        if hooks
            .force_platform_limited
            .load(std::sync::atomic::Ordering::SeqCst)
            && hooks
                .force_platform_limited_skip
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |n| if n == 0 { None } else { Some(n - 1) },
                )
                .is_err()
        {
            self.broadcast_fenced_stop_refusal(
                req,
                owner,
                operation_id,
                generation,
                "PLATFORM_LIMITED",
            );
            return Some(StopOutcomePriv::PlatformLimitedFenced);
        }
        None
    }

    /// The stop a kill began for a terminal in a pane unit (`None` for a
    /// terminal outside any unit): such a terminal is dead only at that
    /// stop's Gone, which resolves after its row was ended and its
    /// conversations released, and can come after its screen's death.
    fn unit_stop_of(&self, terminal_id: &str) -> Option<freshell_containment::StopHandle> {
        self.fresh_agent
            .units
            .by_terminal(terminal_id)
            .and_then(|entry| entry.unit.stop_in_flight())
    }

    async fn stop_runtime(
        self: &Arc<Self>,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        initiator: &str,
        operation_id: &str,
        generation: u64,
    ) -> StopOutcomePriv {
        if let Some(outcome) = self.forced_stop_outcome(req, owner, operation_id, generation) {
            return outcome;
        }
        let budget = std::time::Duration::from_millis(self.reap_timeout_ms);
        match owner.kind {
            RuntimeOwnerKind::Terminal => {
                let Some(terminal_id) = owner.terminal_id.as_deref() else {
                    return StopOutcomePriv::Reaped; // no runtime identity: nothing to stop
                };
                // b8ke ext r6 F2: confirmed death is the recorded pid's
                // OS-LEVEL death — NEVER registry.kill()'s return and never
                // the row-based predicate. kill_internal removes the row
                // BEFORE signaling/reaping the PTY, so a concurrent kill can
                // own the removed row while the process lives: the old
                // kill()=false arm answered Reaped and the handoff started
                // the replacement before confirmed reap. Issue the kill
                // (idempotent — false only means the row is gone) and poll
                // the pid within the budget; the row-removed-but-pid-alive
                // window fences with the watcher regime (the same fix the
                // uncommitted-target reap took).
                match owner.pid {
                    Some(pid) => {
                        self.registry.kill(terminal_id);
                        // A prior in a pane unit is dead only at its unit's
                        // Gone (the stop the kill began): its row stays until
                        // then, and a target spawned earlier is refused while
                        // the conversation still has that running terminal.
                        let unit_gone = self.unit_stop_of(terminal_id);
                        // Round-3 review I-1 (prior-reap window): the kill is
                        // now ISSUED (SIGKILL sent) but unconfirmed — the
                        // abort-window test's deterministic hold parks HERE,
                        // inside the window where a dropped runner must
                        // re-probe before any restore.
                        if let Some(hooks) = self.test_hooks.as_ref() {
                            if let Some(pause) = hooks.pause_after_terminal_prior_kill.as_ref() {
                                let _ = pause.notified().await;
                            }
                        }
                        let watcher_gone = unit_gone.clone();
                        let mut confirm = std::pin::pin!(async {
                            while freshell_terminal::registry::pid_alive(pid) {
                                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            }
                            if let Some(stop) = unit_gone.as_ref() {
                                stop.wait().await;
                            }
                        });
                        tokio::select! {
                            () = &mut confirm => StopOutcomePriv::Reaped,
                            _ = tokio::time::sleep(budget) => {
                                // The SIGKILL was issued (ours or the
                                // concurrent one); the process's death is
                                // merely unobserved. Keep polling DETACHED
                                // (the watcher releases the fenced key once
                                // the pid is dead) — the failure frame FIRST
                                // (FR5), strictly before the watcher exists.
                                self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                                self.spawn_reap_confirmation_watcher(
                                    req,
                                    operation_id,
                                    generation,
                                    initiator,
                                    owner,
                                    "REAP_TIMEOUT",
                                    async move {
                                        while freshell_terminal::registry::pid_alive(pid) {
                                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                                        }
                                        if let Some(stop) = watcher_gone.as_ref() {
                                            stop.wait().await;
                                        }
                                        ReapAnswer::Confirmed
                                    },
                                );
                                StopOutcomePriv::ReapTimeout { fenced: true }
                            }
                        }
                    }
                    None => {
                        // No recorded pid (a degenerate identity): the best
                        // available evidence is the row-based poll after our
                        // OWN kill — a pid-less identity has no
                        // concurrent-kill window (a real row would carry a
                        // pid).
                        if !self.registry.kill(terminal_id) {
                            // Already gone (killed/exited elsewhere): the row
                            // is dead.
                            return StopOutcomePriv::Reaped;
                        }
                        // Round-3 review I-1 (prior-reap window): the kill is
                        // now ISSUED (SIGKILL sent) but unconfirmed — the
                        // abort-window test's deterministic hold parks HERE,
                        // inside the window where a dropped runner must
                        // re-probe before any restore.
                        if let Some(hooks) = self.test_hooks.as_ref() {
                            if let Some(pause) = hooks.pause_after_terminal_prior_kill.as_ref() {
                                let _ = pause.notified().await;
                            }
                        }
                        let mut confirm =
                            std::pin::pin!(await_terminal_dead(&self.registry, terminal_id));
                        tokio::select! {
                            () = &mut confirm => StopOutcomePriv::Reaped,
                            _ = tokio::time::sleep(budget) => {
                                self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                                let registry = self.registry.clone();
                                let tid = terminal_id.to_string();
                                self.spawn_reap_confirmation_watcher(
                                    req,
                                    operation_id,
                                    generation,
                                    initiator,
                                    owner,
                                    "REAP_TIMEOUT",
                                    async move {
                                        await_terminal_dead(&registry, &tid).await;
                                        // The registry row is dead — confirmed.
                                        ReapAnswer::Confirmed
                                    },
                                );
                                StopOutcomePriv::ReapTimeout { fenced: true }
                            }
                        }
                    }
                }
            }
            RuntimeOwnerKind::FreshAgent => {
                // The teardown future must be 'static: the timeout branch
                // SPAWNS it (never drops it mid-sequence) — each lane is
                // cheaply-cloneable state owning its own copies of the ids.
                let session_id = req.session_id.clone();
                let initiator = initiator.to_string();
                let mut kill: std::pin::Pin<
                    Box<dyn std::future::Future<Output = StopResult> + Send>,
                > = match req.provider.as_str() {
                    "codex" => {
                        let lane = self.fresh_codex.clone();
                        let initiator = initiator.clone();
                        Box::pin(
                            async move { lane.kill_for_handoff(&session_id, &initiator).await },
                        )
                    }
                    "claude" => {
                        let lane = self.fresh_claude.clone();
                        let initiator = initiator.clone();
                        Box::pin(
                            async move { lane.kill_for_handoff(&session_id, &initiator).await },
                        )
                    }
                    "opencode" => {
                        let lane = self.fresh_opencode.clone();
                        let initiator = initiator.clone();
                        Box::pin(async move {
                            lane.opencode_kill_for_handoff(&session_id, &initiator)
                                .await
                        })
                    }
                    _ => return StopOutcomePriv::Reaped,
                };
                // `select!` polls the pinned teardown WITHOUT consuming it:
                // in budget → the lane teardown awaited its own watcher (the
                // confirmed reap; AlreadyGone is the same truth); over
                // budget → the still-running teardown is SPAWNED (never
                // dropped) and the key is fenced until its watcher settles.
                // A lane answering `NotConfirmed` (its bounded window could
                // not confirm the tree's death — b8ke focused FR3) takes the
                // same fenced path with the lane's own continuation as the
                // confirmation; the failure frame is broadcast BEFORE the
                // watcher exists in every arm (b8ke focused FR5).
                tokio::select! {
                    result = &mut kill => match result {
                        // The lane teardown awaited its own watcher — the confirmed
                        // reap. AlreadyGone is the same truth (nothing to stop).
                        StopResult::Reaped | StopResult::AlreadyGone => StopOutcomePriv::Reaped,
                        // b8ke focused round-2 review R2-3: a platform-limited
                        // teardown (non-Linux: the direct child's awaited exit
                        // is the portable floor, the descendant tree is
                        // unverifiable) must NOT satisfy confirmed-reap — the
                        // failure frame (reason PLATFORM_LIMITED) precedes the
                        // fence, and the caller answers the typed failure. No
                        // watcher: nothing on that platform can ever confirm
                        // the descendant death.
                        StopResult::PlatformLimited => {
                            self.broadcast_fenced_stop_refusal(
                                req, owner, operation_id, generation, "PLATFORM_LIMITED",
                            );
                            StopOutcomePriv::PlatformLimitedFenced
                        }
                        StopResult::NotConfirmed { confirmation } => {
                            self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                            self.spawn_reap_confirmation_watcher(
                                req,
                                operation_id,
                                generation,
                                &initiator,
                                owner,
                                "REAP_TIMEOUT",
                                async move {
                                    if confirmation.await {
                                        ReapAnswer::Confirmed
                                    } else {
                                        ReapAnswer::Lost
                                    }
                                },
                            );
                            StopOutcomePriv::ReapTimeout { fenced: true }
                        }
                    },
                    _ = tokio::time::sleep(budget) => {
                        self.broadcast_fenced_reap_timeout(req, owner, operation_id, generation);
                        let confirmation = tokio::spawn(kill);
                        let hooks = self.test_hooks.clone();
                        self.spawn_reap_confirmation_watcher(
                            req,
                            operation_id,
                            generation,
                            &initiator,
                            owner,
                            "REAP_TIMEOUT",
                            async move {
                                // b8ke focused FR6's test seam: the armed hook
                                // aborts the spawned teardown task — a REAL
                                // JoinError (cancelled) surfaces through the
                                // await, exercising the watcher's typed fenced
                                // state + replacement probe (round-2 R2-1).
                                // Never armed in production.
                                if let Some(hooks) = hooks.as_ref() {
                                    if hooks.abort_reap_confirmation_once.swap(
                                        false,
                                        std::sync::atomic::Ordering::SeqCst,
                                    ) {
                                        confirmation.abort();
                                    }
                                }
                                // b8ke focused round-2 review: the spawned
                                // teardown's COMPLETED answer is confirmed
                                // death ONLY for Reaped/AlreadyGone — a
                                // completed-but-PlatformLimited answer fences
                                // (R2-3), and a NotConfirmed answer's own
                                // escalation continuation IS the confirmation.
                                // A JoinError (the teardown task panicked or
                                // was cancelled) is `Lost`: death is
                                // UNCONFIRMED, the watcher fences with the
                                // typed WatcherFailed reason and the
                                // replacement probe settles it (R2-1).
                                match confirmation.await {
                                    Ok(StopResult::Reaped) | Ok(StopResult::AlreadyGone) => {
                                        ReapAnswer::Confirmed
                                    }
                                    Ok(StopResult::PlatformLimited) => ReapAnswer::PlatformLimited,
                                    Ok(StopResult::NotConfirmed { confirmation }) => {
                                        if confirmation.await {
                                            ReapAnswer::Confirmed
                                        } else {
                                            ReapAnswer::Lost
                                        }
                                    }
                                    Err(_) => ReapAnswer::Lost,
                                }
                            },
                        );
                        StopOutcomePriv::ReapTimeout { fenced: true }
                    }
                }
            }
        }
    }

    /// b8ke focused review FR5: the fenced reap-timeout failure frame,
    /// broadcast from the runner's OWN task strictly BEFORE any detached
    /// watcher is spawned. The frame's truth: the PRIOR is still the
    /// fenced owner (its kind/runtime identity) — never the target kind,
    /// never a lie about vacancy. The watcher's `released` frame supersedes
    /// it once death is confirmed. b8ke focused round-4 R4-5: the frame
    /// carries the `fenced` marker so an online same-kind pane keeps the
    /// typed recovery state (no polling resumption as a healthy owner).
    fn broadcast_fenced_reap_timeout(
        &self,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
    ) {
        let prior_kind = Some(owner.kind);
        self.broadcast_owner(
            req,
            "handoff-failed",
            prior_kind,
            owner.terminal_id.clone(),
            operation_id,
            generation,
            prior_kind,
            Some("REAP_TIMEOUT"),
            Some(true),
        );
    }

    /// b8ke focused round-2 review R2-3: the platform-limited stop's fenced
    /// failure frame — the same FR5 truth (the PRIOR still owns the fenced
    /// key) with the typed PLATFORM_LIMITED reason. b8ke focused round-4
    /// R4-5: the frame carries the `fenced` marker (the same-kind recovery
    /// state persists on every device).
    fn broadcast_fenced_stop_refusal(
        &self,
        req: &HandoffRequest,
        owner: &OwnerIdentity,
        operation_id: &str,
        generation: u64,
        reason: &str,
    ) {
        let prior_kind = Some(owner.kind);
        self.broadcast_owner(
            req,
            "handoff-failed",
            prior_kind,
            owner.terminal_id.clone(),
            operation_id,
            generation,
            prior_kind,
            Some(reason),
            Some(true),
        );
    }

    /// b8ke delta review F3: the detached reap-confirmation watcher for a
    /// REAL reap timeout (kill issued, death delayed past the runner's
    /// budget). The key stays fenced in `Handoff` — every competing
    /// begin (start/handoff/stop) is Blocked with the typed in-flight
    /// answer, so no new writer can start while the old runtime's death is
    /// unconfirmed — until `confirmation` resolves
    /// [`ReapAnswer::Confirmed`] (the lane teardown's own watcher for
    /// fresh priors; the registry dead-probe for terminal priors), then
    /// the key releases to Vacant, the corrective `released` broadcast
    /// supersedes the fenced `handoff-failed` frame, and the uniform
    /// done-line logs the settlement. A retry during the fence is
    /// typed-refused; after the release it succeeds.
    ///
    /// b8ke focused round-2 review R2-1: a `Lost` resolution (the
    /// confirmation future itself failed — the spawned teardown
    /// JoinError'd, or a NotConfirmed continuation was lost) NEVER
    /// fail-opens the key: the watcher moves it to the TYPED
    /// `Fenced{WatcherFailed}` state and spawns the REPLACEMENT watcher
    /// whose bounded recorded-identity probe re-issues the death
    /// confirmation (the terminal registry dead-poll; each fresh lane's
    /// condemn-record kill-and-confirm) — only that probe's `Confirmed`
    /// answer releases the fence. There is no path from here to plain
    /// Vacant.
    ///
    /// b8ke focused round-2 review R2-3: a `PlatformLimited` resolution
    /// (the teardown completed but its platform cannot verify the
    /// descendant tree) fences with the typed `PlatformLimited` reason
    /// and spawns nothing — no probe on that platform can ever confirm,
    /// so the fence persists for the boot epoch (the documented
    /// tradeoff; the session stays recoverable and the operator can kill
    /// leftover processes by other means).
    #[allow(clippy::too_many_arguments)] // the watcher field set (the spawn-call shape it has always had)
    fn spawn_reap_confirmation_watcher(
        self: &Arc<Self>,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        initiator: &str,
        prior: &OwnerIdentity,
        release_reason: &'static str,
        confirmation: impl std::future::Future<Output = ReapAnswer> + Send + 'static,
    ) {
        let runner = Arc::clone(self);
        let provider = req.provider.clone();
        let session_id = req.session_id.clone();
        let operation_id = operation_id.to_string();
        let initiator = initiator.to_string();
        let prior = prior.clone();
        let prior_kind = Some(prior.kind);
        let broadcast_req = self.cleanup_request(&provider, &session_id, req.target_kind);
        let settled = std::time::Instant::now();
        tokio::spawn(async move {
            match confirmation.await {
                ReapAnswer::Lost => {
                    // R2-1: the confirmation future was lost — FENCE with
                    // the typed WatcherFailed reason (never a fail-open to
                    // Vacant), then re-spawn the replacement watcher whose
                    // bounded recorded-identity probe settles the fence
                    // ONLY on confirmed death.
                    let outcome = runner.ownership.fence_unconfirmed_handoff(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::WatcherFailed,
                    );
                    if !matches!(outcome, freshell_ownership::FenceOutcome::Fenced) {
                        // The record moved on (a foreign op/generation, or
                        // already settled) — the typed no-op; nothing on the
                        // bus (a stale-generation frame would be dropped by
                        // the clients' monotonic fold anyway).
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.reap_watcher_failed_foreign",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = runner.ownership.boot_epoch(), generation,
                            outcome = "foreign_noop", failure_reason = "WATCHER_FAILED",
                            "the watcher-failed fence landed after the coordinator record moved on");
                        return;
                    }
                    // The fence's corrective frame: the truth is unchanged
                    // from the REAP_TIMEOUT `handoff-failed` frame already
                    // on the bus (the prior still owns the fenced key), so
                    // no new frame here — only the done-line.
                    runner.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &provider,
                            session_id: &session_id,
                            initiator: &initiator,
                            epoch: runner.ownership.boot_epoch(),
                            generation,
                            live_session_key: prior.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: None,
                            runtime_id: prior.terminal_id.as_deref(),
                            pid: prior.pid,
                            outcome: "reap_watcher_failed_fenced",
                            duration_ms: settled.elapsed().as_millis() as u64,
                            failure_reason: Some("WATCHER_FAILED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    // The replacement probe — same watcher shape, settling
                    // ONLY on a positive death confirmation (it loops the
                    // bounded lane/registry probe until then; it can never
                    // resolve Lost or PlatformLimited).
                    let replacement =
                        runner.prior_death_reconfirmation(&provider, &session_id, &prior);
                    runner.spawn_reap_confirmation_watcher(
                        &broadcast_req,
                        &operation_id,
                        generation,
                        &initiator,
                        &prior,
                        "WATCHER_FAILED",
                        replacement,
                    );
                    // The replacement watcher owns the release from here —
                    // this watcher's job ended with the fence (falling
                    // through would run the Confirmed-release code below and
                    // immediately reopen the key it just fenced).
                    return;
                }
                ReapAnswer::PlatformLimited => {
                    // R2-3: the teardown completed but the platform cannot
                    // verify the descendant tree — fence with the typed
                    // PlatformLimited reason and settle for the epoch.
                    let outcome = runner.ownership.fence_unconfirmed_handoff(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                    if !matches!(outcome, freshell_ownership::FenceOutcome::Fenced) {
                        tracing::warn!(target: "freshell_ownership",
                            event = "ownership.handoff.reap_platform_limited_foreign",
                            operation_id = %operation_id, provider = %provider, session_id = %session_id,
                            epoch = runner.ownership.boot_epoch(), generation,
                            outcome = "foreign_noop", failure_reason = "PLATFORM_LIMITED",
                            "the platform-limited fence landed after the coordinator record moved on");
                        return;
                    }
                    runner.log_transition(
                        TransitionLog {
                            operation_id: &operation_id,
                            provider: &provider,
                            session_id: &session_id,
                            initiator: &initiator,
                            epoch: runner.ownership.boot_epoch(),
                            generation,
                            live_session_key: prior.live_session_key.as_deref(),
                            from_kind: prior_kind,
                            to_kind: None,
                            runtime_id: prior.terminal_id.as_deref(),
                            pid: prior.pid,
                            outcome: "reap_platform_limited_fenced",
                            duration_ms: settled.elapsed().as_millis() as u64,
                            failure_reason: Some("PLATFORM_LIMITED"),
                            stale: None,
                        },
                        "ownership.handoff.done",
                        TransitionLevel::Error,
                    );
                    // b8ke focused round-3 R3-3: the fence is TERMINAL on
                    // this platform — RETURN, exactly like the Lost arm.
                    // Falling through would run the Confirmed-release code
                    // below, reopening the key (and broadcasting
                    // `released`) over a descendant tree nobody ever
                    // confirmed dead — the fail-open the delayed-crossing
                    // test pins.
                    return;
                }
                ReapAnswer::Confirmed => {}
            }
            // The confirmation IS the observed death (the lane teardown
            // awaited its own watcher; the registry row is dead; the
            // replacement probe kill-and-confirmed): release the fenced
            // key — never restore a dead runtime as Live. The subject is
            // either the original `Handoff` (`fail`) or — for the
            // replacement watcher — the `Fenced` record itself
            // (`release_fenced`); a foreign op/gen on either path is the
            // typed no-op.
            let released = match runner.ownership.fail(
                &provider,
                &session_id,
                &operation_id,
                generation,
                false,
            ) {
                freshell_ownership::FailOutcome::Vacant { .. } => true,
                _ => matches!(
                    runner.ownership.release_fenced(
                        &provider,
                        &session_id,
                        &operation_id,
                        generation,
                    ),
                    freshell_ownership::CommitOutcome::Committed
                ),
            };
            if !released {
                // The record moved on (a foreign op/generation, or already
                // settled) — log it and say nothing on the bus (a
                // stale-generation frame would be dropped by the clients'
                // monotonic fold anyway).
                tracing::warn!(target: "freshell_ownership",
                    event = "ownership.handoff.reap_settled_foreign",
                    operation_id = %operation_id, provider = %provider, session_id = %session_id,
                    epoch = runner.ownership.boot_epoch(), generation,
                    outcome = "foreign_noop", failure_reason = "REAP_TIMEOUT",
                    "the detached reap settled after the coordinator record moved on");
                return;
            }
            // The corrective frame: the key is vacant now (the fenced
            // handoff-failed frame said the prior still owned it — the
            // same-generation fold applies this one).
            runner.broadcast_owner(
                &broadcast_req,
                "released",
                None,
                None,
                &operation_id,
                generation,
                prior_kind,
                Some(release_reason),
                None,
            );
            runner.log_transition(
                TransitionLog {
                    operation_id: &operation_id,
                    provider: &provider,
                    session_id: &session_id,
                    initiator: &initiator,
                    epoch: runner.ownership.boot_epoch(),
                    generation,
                    live_session_key: prior.live_session_key.as_deref(),
                    from_kind: prior_kind,
                    to_kind: None,
                    runtime_id: prior.terminal_id.as_deref(),
                    pid: prior.pid,
                    outcome: "reap_timeout_settled_vacant",
                    duration_ms: settled.elapsed().as_millis() as u64,
                    failure_reason: Some(release_reason),
                    stale: None,
                },
                "ownership.handoff.done",
                TransitionLevel::Warn,
            );
        });
    }

    /// b8ke focused round-2 review R2-1: the replacement death confirmation
    /// for a `Fenced{WatcherFailed}` key — a BOUNDED probe of the recorded
    /// prior identity that re-issues the kill where the lost teardown left
    /// it and resolves [`ReapAnswer::Confirmed`] ONLY once death is
    /// positively confirmed. Terminal priors: the registry dead-poll of the
    /// recorded terminal id. Fresh priors: the lane's own recorded-identity
    /// kill-and-confirm (claude/codex: the condemned (pid, tag) tree sweep;
    /// opencode: the condemned daemon-side turn abort), with a full lane
    /// teardown re-run for a session the cancelled kill never reached.
    /// Never resolves anything but `Confirmed` — it loops (bounded steps,
    /// fail-closed) until death is proven.
    fn prior_death_reconfirmation(
        self: &Arc<Self>,
        provider: &str,
        session_id: &str,
        prior: &OwnerIdentity,
    ) -> impl std::future::Future<Output = ReapAnswer> + Send + 'static {
        let registry = self.registry.clone();
        let fresh_claude = self.fresh_claude.clone();
        let fresh_codex = self.fresh_codex.clone();
        let fresh_opencode = self.fresh_opencode.clone();
        let provider = provider.to_string();
        let session_id = session_id.to_string();
        let prior = prior.clone();
        async move {
            let mut logged_wait = false;
            loop {
                match prior.kind {
                    RuntimeOwnerKind::Terminal => {
                        // b8ke ext r7 F5: the recorded PID's OS-level death
                        // is the confirmation — NEVER the registry row's
                        // disappearance (kill_internal removes the row BEFORE
                        // the blocking kill/reap, so a concurrent kill can
                        // create a short row-absent/live-pid window; the
                        // row-based predicate released the fence over the
                        // still-live prior in that window). The pid-less
                        // degenerate identity keeps the row-based poll (no
                        // concurrent-kill window can apply to a pid-less
                        // row).
                        if let Some(pid) = prior.pid {
                            if !freshell_terminal::registry::pid_alive(pid) {
                                return ReapAnswer::Confirmed;
                            }
                        } else if let Some(tid) = prior.terminal_id.as_deref() {
                            await_terminal_dead(&registry, tid).await;
                            return ReapAnswer::Confirmed;
                        }
                        // A Live terminal owner always carries its
                        // terminal id; None is unreachable — stay
                        // fail-closed (the fence holds).
                    }
                    RuntimeOwnerKind::FreshAgent => {
                        let confirmed = match provider.as_str() {
                            "claude" => fresh_claude.confirm_fenced_prior_dead(&session_id).await,
                            "codex" => fresh_codex.confirm_fenced_prior_dead(&session_id).await,
                            "opencode" => {
                                fresh_opencode.confirm_fenced_prior_dead(&session_id).await
                            }
                            _ => false,
                        };
                        if confirmed {
                            return ReapAnswer::Confirmed;
                        }
                    }
                }
                if !logged_wait {
                    logged_wait = true;
                    tracing::warn!(target: "freshell_ownership",
                        event = "ownership.handoff.replacement_probe_waiting",
                        provider = %provider, session_id = %session_id,
                        runtime_id = ?prior.terminal_id, pid = ?prior.pid,
                        "the replacement death probe has not yet confirmed the fenced prior's \
                         death — the key stays fenced (fail-closed) while the probe retries");
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }

    /// Start/attach the target UNDER-TICKET — the target paths skip their own
    /// coordinator commit (Tasks 3/4 under-ticket mode) and return the
    /// `OwnerIdentity`; THIS runner performs the single `commit_live`.
    /// Session-ID preservation (round-1 review scope): a returned runtime
    /// that does not serve the canonical `(provider, req.session_id)` is a
    /// `TARGET_SPAWN_FAILED` — never accept a respawned-new-thread runtime
    /// as handoff success, never mint a new session id.
    ///
    /// ep2-r5: the Ok payload additionally carries the freshopencode
    /// target's committed session INSTANCE
    /// ([`crate::opencode_ws::OpencodeSessionHandle`]) — `None` for every
    /// other target kind — so the runner's post-commit rescue re-check can
    /// verify the exact `Arc` its under-ticket continuation installed
    /// (a same-key replacement can never satisfy it).
    async fn start_target(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        target_spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
    ) -> Result<
        (
            OwnerIdentity,
            Option<crate::opencode_ws::OpencodeSessionHandle>,
        ),
        (String, String),
    > {
        // b8ke ext r23 F2: the attempt marker — start_target was ENTERED
        // (the spawn/resume is being attempted on this call). The
        // spawn-failure tests assert this event so a regression that
        // answers the failure BEFORE the attempt (the pre-r23 pre-check
        // shape) fails the tests: the cleanup contract is only proven by
        // an actually-attempted-and-failed start.
        if let Some(hooks) = self.test_hooks.as_ref() {
            hooks.record("TargetSpawnAttempted");
        }
        // b8ke ext r23 F2: the failure hook at the REAL error site —
        // after all pre-spawn bookkeeping, right before the actual
        // spawn/resume attempt, so the tests drive the actually-attempted-
        // and-failed start (the real Err arm + the guard's cleanup of any
        // partially registered target). Pre-r23 the knob was consumed at
        // the pre-check (before start_target was called) so the tests
        // never reached the real error arm.
        if let Some(hooks) = self.test_hooks.as_ref() {
            if hooks
                .fail_target_spawn_once
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err((
                    "TARGET_SPAWN_FAILED".to_string(),
                    "the target spawn was attempted and failed (the fixture's \
                     deterministic failure)"
                        .to_string(),
                ));
            }
        }
        match req.target_kind {
            RuntimeOwnerKind::Terminal => {
                let mode = req.mode.clone().unwrap_or_else(|| req.provider.clone());
                let body = json!({
                    "mode": mode,
                    "cwd": req.cwd,
                    "sessionRef": { "provider": req.provider, "sessionId": req.session_id },
                });
                let tab_id = req
                    .tab_id
                    .clone()
                    .unwrap_or_else(|| format!("handoff-tab-{}", uuid::Uuid::new_v4()));
                let pane_id = req
                    .pane_id
                    .clone()
                    .unwrap_or_else(|| format!("handoff-pane-{}", uuid::Uuid::new_v4()));
                let token = crate::terminal_tabs::HandoffToken {
                    operation_id: operation_id.to_string(),
                    generation,
                    watch: target_spawn_watch
                        .unwrap_or_else(|| crate::terminal_tabs::HandoffSpawnWatch::new(None)),
                };
                let spawned = match crate::terminal_tabs::spawn_terminal_pane_with_handoff(
                    &self.fresh_agent,
                    &body,
                    &tab_id,
                    &pane_id,
                    Some(&token),
                )
                .await
                {
                    Ok(spawned) => spawned,
                    Err(resp) => {
                        // b8ke ext r27 F3: the typed spawn refusal's code +
                        // message ride the handoff failure — the response's
                        // OWN typed envelope (a registration failure answers
                        // TARGET_BINDING_FAILED), never a Debug dump that
                        // would bury the code.
                        let status = resp.status();
                        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                            .await
                            .unwrap_or_default();
                        let body: serde_json::Value =
                            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
                        let code = body
                            .get("code")
                            .and_then(Value::as_str)
                            .unwrap_or("terminal spawn failed")
                            .to_string();
                        let message = body
                            .get("message")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("terminal spawn failed (status {status})"));
                        return Err((code, message));
                    }
                };
                // Session-ID preservation: the spawned pane must carry the
                // canonical sessionRef — a gate-fired mint (a stale resume
                // id healed into a fresh one) is a handoff FAILURE, never a
                // silently-blank new session.
                let echoed = spawned
                    .pane_content
                    .get("sessionRef")
                    .and_then(|v| v.get("sessionId"))
                    .and_then(Value::as_str);
                if echoed != Some(req.session_id.as_str()) {
                    let _ = self.registry.kill(&spawned.terminal_id);
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(self.reap_timeout_ms),
                        await_terminal_dead(&self.registry, &spawned.terminal_id),
                    )
                    .await;
                    return Err((
                        "terminal spawn did not preserve the session id".to_string(),
                        format!("expected sessionRef {}, got {:?}", req.session_id, echoed),
                    ));
                }
                let owner = spawned.owner_identity.unwrap_or_else(|| OwnerIdentity {
                    kind: RuntimeOwnerKind::Terminal,
                    terminal_id: Some(spawned.terminal_id.clone()),
                    live_session_key: None,
                    pid: self.registry.pid_of(&spawned.terminal_id),
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                });
                if let Some(hooks) = self.test_hooks.as_ref() {
                    hooks.record("TargetStarted");
                }
                Ok((owner, None))
            }
            RuntimeOwnerKind::FreshAgent => match req.session_type.as_deref() {
                Some("freshcodex") | None => self
                    .fresh_codex
                    .resume_for_handoff(
                        &req.session_id,
                        req.cwd.as_deref(),
                        operation_id,
                        generation,
                    )
                    .await
                    .map(|owner| (owner, None)),
                Some("freshopencode") => self
                    .fresh_opencode
                    .opencode_resume_for_handoff(
                        &req.session_id,
                        req.cwd.as_deref(),
                        operation_id,
                        generation,
                    )
                    .await
                    .map(|(owner, committed)| (owner, Some(committed))),
                // Round-2 review: BOTH claude-lane flavors — the flavor is a
                // param (claude.rs), so a kilroy session resumes as kilroy
                // (the created/owner frames keep the flavor) and a freshclaude
                // session as freshclaude. Never map by provider alone.
                Some("freshclaude") => self
                    .fresh_claude
                    .resume_for_handoff(
                        "freshclaude",
                        &req.session_id,
                        req.cwd.as_deref(),
                        operation_id,
                        generation,
                    )
                    .await
                    .map(|owner| (owner, None)),
                Some("kilroy") => self
                    .fresh_claude
                    .resume_for_handoff(
                        "kilroy",
                        &req.session_id,
                        req.cwd.as_deref(),
                        operation_id,
                        generation,
                    )
                    .await
                    .map(|owner| (owner, None)),
                Some(other) => Err(("unsupported sessionType".to_string(), other.to_string())),
            },
        }
    }

    /// Retain the fresh target's lane stamp after the runner's `commit_live`
    /// (single commit authority): the stamp the lane's later kill/exit-watcher
    /// paths build their fenced claims from, matching the committed Live
    /// record exactly (same operation id, generation, runtime identity).
    /// b8ke ext r30 F1: publish the handoff's FRESH target owner WITH its
    /// release evidence ATOMICALLY — the terminal registry's
    /// normal-commit template applied to the fresh-agent lane: the
    /// LANE's stamps lock is held across the liveness check, the
    /// commit-to-Live, AND the retained-stamp insertion, and the exit
    /// watcher's release consult (`release_retained_stamp` →
    /// `take_retained_stamp`) takes the SAME lock. The (commit, stamp)
    /// pair is therefore atomic to the watcher: a watcher blocked on
    /// this critical section finds the stamp and releases the owner it
    /// names; a watcher that consulted before it found nothing — and
    /// because the liveness check runs UNDER the lock after that
    /// consult, the publication then REFUSES (`ForeignOperation`, the
    /// callers' existing stale-commit arm: reap + typed recoverable
    /// failure + the failed-transition repair): a target whose sidecar
    /// already exited is NEVER published Live. Pre-r30 the stamp was
    /// retained only AFTER the commit, so a target exiting between the
    /// two left a dead runtime advertised globally Live with the stamp
    /// inserted too late for the completed watcher to consume. TERMINAL
    /// targets use the terminal registry's commit template here so the
    /// coordinator commit and its retained release evidence are published
    /// at the same publication boundary.
    fn commit_live_target_with_release_evidence(
        &self,
        req: &HandoffRequest,
        operation_id: &str,
        generation: u64,
        owner: &OwnerIdentity,
    ) -> CommitOutcome {
        // Terminal targets publish through the terminal registry's commit
        // template. The under-ticket spawn deliberately skips its own
        // coordinator commit, so this is the publication boundary that must
        // retain the PTY's fenced release evidence for its exit/kill path.
        if owner.kind == RuntimeOwnerKind::Terminal {
            let Some(terminal_id) = owner.terminal_id.as_deref() else {
                tracing::error!(target: "invariant",
                    provider = %req.provider,
                    session_id = %req.session_id,
                    operation_id = %operation_id,
                    event = "ownership.handoff.terminal_publication_missing_id",
                    "terminal handoff target has no terminal id at publication"
                );
                return CommitOutcome::ForeignOperation;
            };
            let locator = freshell_protocol::SessionLocator {
                provider: req.provider.clone(),
                session_id: req.session_id.clone(),
            };
            return self.registry.commit_session_ref_ownership(
                &locator,
                operation_id,
                generation,
                terminal_id,
            );
        }
        let stamps = match req.provider.as_str() {
            "codex" => &self.fresh_codex.ownership_stamps,
            "claude" => &self.fresh_claude.ownership_stamps,
            _ => &self.fresh_opencode.fresh_agent().ownership_stamps,
        };
        let mut stamps_guard = stamps.lock().expect("ownership stamps lock");
        // (1) LIVENESS under the lock: a sidecar that already exited
        // never publishes. Non-Linux never confirms a pid gone (the
        // documented platform limitation) — fail closed toward the
        // publish, exactly as before there.
        if let Some(pid) = owner.pid {
            if crate::ownership_lane::partial_pid_confirmed_dead(pid) {
                tracing::error!(target: "invariant",
                    provider = %req.provider,
                    session_id = %req.session_id,
                    operation_id = %operation_id,
                    pid,
                    event = "ownership.handoff.publication_refused_dead_target",
                    "the handoff target's sidecar exited before the commit-to-Live — \
                     a dead runtime is never published; the stale-commit arm reaps it \
                     and the handoff answers the typed recoverable failure (kata b8ke \
                     ext r30 F1)"
                );
                return CommitOutcome::ForeignOperation;
            }
        }
        // (2) THE commit, and (3) the stamp insertion — one lock scope.
        let outcome = self.ownership.commit_live(
            &req.provider,
            &req.session_id,
            operation_id,
            generation,
            owner.clone(),
        );
        if matches!(outcome, CommitOutcome::Committed) {
            let mut stamped = owner.clone();
            if stamped.ownership_id.is_none() {
                stamped.ownership_id = Some(operation_id.to_string());
            }
            stamps_guard.insert(
                req.session_id.clone(),
                crate::ownership_lane::OwnershipStamp {
                    epoch: self.ownership.boot_epoch(),
                    generation,
                    operation_id: operation_id.to_string(),
                    owner: stamped,
                },
            );
        }
        outcome
    }

    /// Every frame carries the boot epoch, `previousKind` (the transition's
    /// from-kind when one exists), and — on failure frames — the typed
    /// `reason`. `owner_kind: None` broadcasts "vacant". R4-5: `fenced` is
    /// `Some(true)` ONLY on the fenced failure frames (the prior is the
    /// FENCED owner — no live writer exists), so an online same-kind pane
    /// keeps the typed recovery state instead of resuming as a healthy
    /// owner; every other frame omits it.
    #[allow(clippy::too_many_arguments)] // the uniform broadcast field set (round-2 review)
    fn broadcast_owner(
        &self,
        req: &HandoffRequest,
        transition: &str,
        owner_kind: Option<RuntimeOwnerKind>,
        terminal_id: Option<String>,
        operation_id: &str,
        generation: u64,
        previous_kind: Option<RuntimeOwnerKind>,
        reason: Option<&str>,
        fenced: Option<bool>,
    ) {
        let frame = serde_json::to_string(&freshell_protocol::ServerMessage::SessionRuntimeOwner(
            freshell_protocol::SessionRuntimeOwner {
                provider: req.provider.clone(),
                session_id: req.session_id.clone(),
                epoch: self.ownership.boot_epoch(),
                generation,
                owner_kind: match owner_kind {
                    Some(RuntimeOwnerKind::Terminal) => "terminal".into(),
                    Some(RuntimeOwnerKind::FreshAgent) => "fresh-agent".into(),
                    None => "vacant".into(),
                },
                previous_kind: previous_kind.map(|k| match k {
                    RuntimeOwnerKind::Terminal => "terminal".to_string(),
                    RuntimeOwnerKind::FreshAgent => "fresh-agent".to_string(),
                }),
                terminal_id,
                operation_id: operation_id.to_string(),
                transition: transition.to_string(),
                reason: reason.map(str::to_string),
                fenced,
                alias_of: None,
            },
        ))
        .unwrap_or_default();
        let _ = self.broadcast_tx.send(frame);
    }

    /// The Step-5 refactor: one emission point so every
    /// `ownership.handoff.done` outcome line carries the same full field set
    /// (operation id, provider/session id, generation, kinds, runtime id/pid,
    /// initiator, duration, outcome, typed failure reason).
    fn log_transition(&self, log: TransitionLog<'_>, event: &'static str, level: TransitionLevel) {
        log.emit(event, level);
    }
}

/// The uniform `ownership.handoff.done` field set (the Step-5 refactor's
/// single source): every outcome line is built through this struct so the
/// join-critical fields can never drift between branches.
struct TransitionLog<'a> {
    operation_id: &'a str,
    provider: &'a str,
    session_id: &'a str,
    initiator: &'a str,
    epoch: u64,
    generation: u64,
    live_session_key: Option<&'a str>,
    from_kind: Option<RuntimeOwnerKind>,
    to_kind: Option<RuntimeOwnerKind>,
    runtime_id: Option<&'a str>,
    pid: Option<u32>,
    outcome: &'a str,
    duration_ms: u64,
    failure_reason: Option<&'a str>,
    stale: Option<&'a CommitOutcome>,
}

/// The emission level for [`TransitionLog`] (committed is info; recoverable
/// failures warn; contract violations — a stale commit — error).
enum TransitionLevel {
    Info,
    Warn,
    Error,
}

impl TransitionLog<'_> {
    /// Emit the event with the uniform field set on the crate's stable
    /// ownership target (event fields, never span fields).
    fn emit(self, event: &'static str, level: TransitionLevel) {
        // Every arm carries the IDENTICAL field set (plus failure_reason on
        // the failure arms) — the observability contract's requirement.
        match level {
            TransitionLevel::Error => tracing::error!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                stale = ?self.stale,
                "handoff terminal transition"
            ),
            TransitionLevel::Warn => tracing::warn!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                stale = ?self.stale,
                "handoff terminal transition"
            ),
            TransitionLevel::Info => tracing::info!(
                target: "freshell_ownership",
                event,
                operation_id = self.operation_id,
                provider = self.provider,
                session_id = self.session_id,
                initiator = self.initiator,
                epoch = self.epoch,
                generation = self.generation,
                live_session_key = ?self.live_session_key,
                from_kind = ?self.from_kind,
                to_kind = ?self.to_kind,
                runtime_id = ?self.runtime_id,
                pid = ?self.pid,
                outcome = self.outcome,
                duration_ms = self.duration_ms,
                failure_reason = self.failure_reason.unwrap_or(""),
                "handoff terminal transition"
            ),
        }
    }
}

/// Poll the registry's sync dead-probe at the 25ms cadence until the row is
/// gone or no longer Running (the tokio-free registry keeps the predicate
/// sync; the awaitable loop lives here).
async fn await_terminal_dead(registry: &freshell_terminal::TerminalRegistry, terminal_id: &str) {
    while !registry.terminal_is_dead(terminal_id) {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// b8ke ext r13 F7: kill a terminal and confirm its death by the
/// RECORDED-PID OS-level probe — the registry removes a row BEFORE its
/// blocking PTY kill completes, so the ROW's absence (or its Exited
/// status flip) is NOT death proof: a concurrent kill can leave the PID
/// alive while `terminal_is_dead` already reports true. The recorded PID
/// (captured while the row existed — the spawn watch's publication, or
/// pid_of before the kill) is the evidence (the ext-r7 F5 discipline).
/// `None` (no pid handle ever recorded): the legacy row-based poll. The
/// bounded wait returns `false` on timeout — the caller treats an
/// unconfirmed reap per its fail-closed discipline, never as Confirmed.
async fn kill_and_confirm_terminal_pid(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
    recorded_pid: Option<u32>,
    reap_timeout_ms: u64,
) -> bool {
    let pid = recorded_pid.or_else(|| registry.pid_of(terminal_id));
    if !registry.kill(terminal_id) && pid.is_none() {
        // No row AND no pid evidence: nothing to probe — the legacy
        // absent-row answer (a pre-recorded terminal this cleanup never
        // saw publish).
        return true;
    }
    match pid {
        Some(pid) => {
            let _ =
                tokio::time::timeout(std::time::Duration::from_millis(reap_timeout_ms), async {
                    while freshell_terminal::registry::pid_alive(pid) {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                })
                .await;
            !freshell_terminal::registry::pid_alive(pid)
        }
        None => {
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(reap_timeout_ms),
                await_terminal_dead(registry, terminal_id),
            )
            .await;
            registry.terminal_is_dead(terminal_id)
        }
    }
}

/// The prior-stop phase at abort time (round-3 review I-1 — the
/// cancellation-safety windows). The Drop's restore discipline keys off it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PriorStopPhase {
    /// The stop was never issued (the abort landed before the kill await):
    /// the prior is untouched — restore it directly (test 5's window; its
    /// retained stamp is intact, and the restore repairs it FORWARD to the
    /// restored generation so the exit watcher still releases —
    /// whole-branch M-1).
    NotIssued,
    /// The stop was issued but its confirmed reap was lost to the abort:
    /// re-probe prior liveness BEFORE any restore (the reap-timeout
    /// discipline) — a dying prior is never restored as Live; a
    /// confirmed-live one is restored WITH its lane claims (fresh stamp /
    /// terminal retained claim) repaired to the restored generation (the
    /// lane kill already took the stamp).
    KillInFlight,
    /// Confirmed reaped (or there never was a prior): never restore — the
    /// runner folded the exit; the key ends Vacant.
    Reaped,
}

/// The Drop's detached abort payload (round-3 review I-1): everything the
/// cleanup needs, moved out of the guard when the task is cancelled or
/// panics mid-flight.
struct AbortPayload {
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    prior: Option<(OwnerIdentity, u64)>,
    target_kind: RuntimeOwnerKind,
    target_spawn_begun: bool,
    target: Option<OwnerIdentity>,
    spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
}

/// b8ke focused round-3 review R3-6: what the abort cleanup's
/// uncommitted-target reap established — the coordinator half's ending
/// keys off it (fail to the probed prior/Vacant, or fence typed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UncommittedTargetOutcome {
    /// No target cleanup was owed (nothing spawned/begun), or the reap
    /// confirmed the target's death — the record may fail.
    NothingToDo,
    /// The target's death was confirmed (lane teardown awaited, terminal
    /// dead-poll, or AlreadyGone idempotence) — the record may fail.
    Reaped,
    /// The lane's teardown confirmed the direct child's awaited exit but
    /// cannot verify the descendant tree (non-Linux) — never a confirmed
    /// reap; the record fences typed instead of failing.
    PlatformLimited,
    /// The escalation continuation was lost or resolved unconfirmed — a
    /// live unowned writer may remain; the record fences typed instead of
    /// failing.
    Unconfirmed,
}

/// How the abort cleanup decides the prior's liveness for its `fail`:
/// `Probe` re-probes (the KillInFlight window — the kill was issued but
/// its confirmation was lost to the abort); `Known` carries the guard's
/// already-settled value (NotIssued: the untouched prior; Reaped: never
/// restore a dead runtime).
#[derive(Debug, Clone, Copy)]
enum AbortFailDecision {
    Probe,
    Known(bool),
}

/// RAII: fail the coordinator entry if the handoff task is cancelled or
/// panics before commit (armed + not disarmed => fail on Drop) — the
/// `FreshSessionLeaseGuard` drop-discipline precedent. Round-1 review: the
/// guard TRACKS whether the prior runtime is still live — the runner sets
/// `prior_still_live = false` once its awaited kill/reap confirms the prior's
/// death (the runner folds exit-watcher events; they are no-ops in Handoff
/// state by Task 1's fence). `fail` restores the prior ONLY when
/// `prior_still_live` is true; otherwise the key ends Vacant — never a dead
/// runtime recorded as Live. On a reap TIMEOUT the runner does NOT assume
/// liveness either way — it sets `prior_still_live` from the POSITIVE
/// re-probe before failing, and an exit watcher arriving after the boundary
/// still releases/repairs the key (a restored prior is a normal Live
/// record; its fenced watcher fires on the real exit — no permanent wedge).
/// Round-3 review I-1: the phase refines the abort semantics — a kill
/// issued but unconfirmed (`KillInFlight`) defers the restore decision to
/// the Drop's detached cleanup (re-probe, then restore-only-a-confirmed-
/// live prior, repairing the lane claims — the fresh stamp the lane kill
/// took, the terminal's retained claim — to the restored generation).
/// `target_runtime`: a spawned-but-uncommitted target runtime is REAPED on
/// Drop (the cancellation-safety window between spawn and commit);
/// `target_spawn_watch`/`target_spawn_begun` cover the window INSIDE the
/// spawn await itself (an in-flight settle, or a fresh resume that already
/// registered its session).
struct HandoffGuard {
    runner: Arc<SessionHandoffRunner>,
    provider: String,
    session_id: String,
    operation_id: String,
    generation: u64,
    /// The prior owner captured at enter, WITH its Live generation
    /// (historical — the stop source; the restore's claim repairs fence at
    /// the record's current generation instead, whole-branch M-1).
    prior: Option<(OwnerIdentity, u64)>,
    prior_still_live: bool,
    prior_stop: PriorStopPhase,
    target_kind: RuntimeOwnerKind,
    target_runtime: Option<OwnerIdentity>,
    target_spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
    /// `true` once `start_target` was entered — gates the fresh-lane
    /// uncommitted-session sweep (never before: the prior may still be
    /// live on that lane).
    target_spawn_begun: bool,
    disarmed: bool,
}

impl HandoffGuard {
    fn disarm(&mut self) {
        self.disarmed = true;
    }

    fn disarm_and_fail(&mut self) -> FailOutcome {
        self.disarmed = true;
        self.runner.ownership.fail(
            &self.provider,
            &self.session_id,
            &self.operation_id,
            self.generation,
            self.prior_still_live,
        )
    }

    /// The target-half payload: the given target identity + spawn watch in
    /// place of the guard's own (already-taken) ones.
    fn abort_payload_with(
        &self,
        target: Option<OwnerIdentity>,
        spawn_watch: Option<crate::terminal_tabs::HandoffSpawnWatch>,
    ) -> AbortPayload {
        AbortPayload {
            provider: self.provider.clone(),
            session_id: self.session_id.clone(),
            operation_id: self.operation_id.clone(),
            generation: self.generation,
            prior: self.prior.clone(),
            target_kind: self.target_kind,
            target_spawn_begun: self.target_spawn_begun,
            target,
            spawn_watch,
        }
    }
}

impl Drop for HandoffGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }
        let reactor = tokio::runtime::Handle::try_current();
        // b8ke focused round-3 review R3-6: whenever an uncommitted-target
        // cleanup is owed, the global fail is DEFERRED into the detached
        // cleanup — the record stays in this operation's `Handoff` (every
        // competing begin Blocked with the typed in-flight answer) until
        // the target's reap settles (the NotConfirmed continuation, or a
        // bounded kill). Only when NOTHING is owed (or no reactor exists —
        // runtime shutdown, nothing can run) does the sync fail below run.
        let target = self.target_runtime.take();
        let spawn_watch = self.target_spawn_watch.take();
        let owes_target_cleanup = target.is_some()
            || spawn_watch.is_some()
            || (self.target_spawn_begun && self.target_kind == RuntimeOwnerKind::FreshAgent);
        if let Ok(handle) = &reactor {
            if matches!(self.prior_stop, PriorStopPhase::KillInFlight) || owes_target_cleanup {
                // Round-3 review I-1 (prior-reap window): the kill was
                // issued but its confirmed reap was lost to the abort —
                // the detached cleanup re-probes the prior's liveness
                // first (a dying prior is never restored as Live) and
                // repairs the lane claims on a confirmed-live restore.
                let decision = match self.prior_stop {
                    PriorStopPhase::KillInFlight => AbortFailDecision::Probe,
                    PriorStopPhase::NotIssued => AbortFailDecision::Known(self.prior_still_live),
                    PriorStopPhase::Reaped => AbortFailDecision::Known(false),
                };
                let runner = Arc::clone(&self.runner);
                let payload = self.abort_payload_with(target, spawn_watch);
                self.disarmed = true;
                handle.spawn(async move {
                    runner.abort_cleanup(payload, decision).await;
                });
                return;
            }
        }
        // Sync fail: NotIssued restores the untouched prior (true); Reaped
        // never restores (false); KillInFlight with NO reactor (runtime
        // shutdown — nothing can be spawned) fails CLOSED to Vacant — never
        // restore a possibly-dying prior, and the OS reaps the children
        // with the process anyway.
        if matches!(self.prior_stop, PriorStopPhase::KillInFlight) {
            self.prior_still_live = false;
        }
        let fail_outcome = self.disarm_and_fail();
        // Whole-branch M-1 (the claim repairs): a SYNC-path restore must
        // also bring the lane claims (fresh stamp / terminal retained
        // claim) to the restored generation — the untouched prior's own
        // stamp still fences at its COMMIT generation, which the restored
        // record (at the handoff generation) no longer holds, so its
        // later kill/exit paths would never match without the repair.
        if matches!(fail_outcome, FailOutcome::RestoredPriorOwner) {
            if let Some((owner, _)) = self.prior.as_ref() {
                self.runner.repair_restored_prior_claims(
                    &self.provider,
                    &self.session_id,
                    owner,
                    self.generation,
                );
            }
        }
        // b8ke focused round-5 review R5-2: the SYNC unwind broadcasts the
        // post-abort authority too — the detached-cleanup path and this
        // one are the two abort exits, and devices hold the stale
        // `handoff-started` record after either (the same envelope: the
        // restored owner, the vacancy, or the fenced marker/reason).
        // b8ke e4r2 F3: the failure-truth broadcast is ASYNC (the
        // send-then-recheck regime) — spawn it on the current reactor; a
        // Drop with NO reactor (runtime shutdown) has nothing left to
        // serve the frames anyway.
        if let Ok(handle) = &reactor {
            let runner = Arc::clone(&self.runner);
            let provider = self.provider.clone();
            let session_id = self.session_id.clone();
            let operation_id = self.operation_id.clone();
            let target_kind = self.target_kind;
            let previous_kind = self.prior.as_ref().map(|(owner, _)| owner.kind);
            // b8ke e4r3 F1: the abort's OWN generation — the queued
            // broadcast refuses to publish when the record has moved on.
            let abort_generation = self.generation;
            handle.spawn(async move {
                runner
                    .broadcast_post_abort_authority(
                        &provider,
                        &session_id,
                        &operation_id,
                        target_kind,
                        previous_kind,
                        abort_generation,
                    )
                    .await;
            });
        }
    }
}

/// The cancellation-capable spawn handle. `completion` is the HTTP reply
/// channel (dropping it never cancels the operation); `task` is the detached
/// JoinHandle — `abort()` cancels deterministically (the HandoffGuard Drop
/// then fails the coordinator entry and reaps an uncommitted target).
pub struct HandoffHandle {
    pub completion: oneshot::Receiver<Value>,
    pub task: tokio::task::JoinHandle<()>,
}

impl HandoffHandle {
    pub fn abort(&self) {
        self.task.abort();
    }
}

fn typed_failure(code: &str, message: &str, retryable: bool, generation: u64) -> Value {
    json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
            "ownerGeneration": generation,
        }
    })
}

fn owner_json(owner: &OwnerIdentity, req: &HandoffRequest) -> Value {
    match owner.kind {
        RuntimeOwnerKind::Terminal => json!({
            "kind": "terminal",
            "terminalId": owner.terminal_id,
            "mode": req.mode.clone().unwrap_or_else(|| req.provider.clone()),
        }),
        RuntimeOwnerKind::FreshAgent => json!({
            "kind": "fresh-agent",
            "sessionId": req.session_id,
            "sessionType": req.session_type.clone().unwrap_or_else(|| "freshcodex".into()),
            "provider": req.provider,
        }),
    }
}

/// Parse the public handoff action exactly once at the REST boundary. The
/// pre-action acknowledgment remains a compatibility alias only when no
/// explicit action is present; sending both is rejected so an old caller
/// cannot silently change the meaning of a newer action.
fn parse_handoff_action(body: &Value) -> Result<HandoffAction, &'static str> {
    let explicit = body.get("action");
    let explicit_name = explicit.and_then(Value::as_str);
    if explicit.is_some() && explicit_name.is_none() {
        return Err(
            "action must be \"switch\", \"clear-stale-bookkeeping\", or \"stop-and-reopen\"",
        );
    }
    let legacy = body.get("acknowledgePlatformLimitedRisk");
    let legacy_ack = match legacy {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or("acknowledgePlatformLimitedRisk must be a boolean")?,
    };
    if explicit.is_some() && legacy.is_some() {
        return Err("action cannot be combined with acknowledgePlatformLimitedRisk");
    }
    match explicit_name {
        None if legacy_ack => Ok(HandoffAction::ClearStaleBookkeeping),
        None => Ok(HandoffAction::Switch),
        Some("switch") => Ok(HandoffAction::Switch),
        Some("clear-stale-bookkeeping") => Ok(HandoffAction::ClearStaleBookkeeping),
        Some("stop-and-reopen") => Ok(HandoffAction::StopAndReopen),
        Some(_) => {
            Err("action must be \"switch\", \"clear-stale-bookkeeping\", or \"stop-and-reopen\"")
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `POST /api/sessions/handoff` — mounted in `freshell-server::main` beside
/// the other REST routers. The handler validates, parses, and awaits the
/// detached task's oneshot with a bounded HTTP timeout (the operation
/// itself outlives the request; the endpoint keeps ONLY the completion
/// receiver — the exposed JoinHandle stays available to the runner's host).
pub fn handoff_router(runner: Arc<SessionHandoffRunner>) -> Router {
    Router::new()
        .route(HANDOFF_ROUTE, post(handoff_handler))
        .with_state(runner)
}

async fn handoff_handler(
    State(runner): State<Arc<SessionHandoffRunner>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !crate::authorized(&headers, &runner.auth_token) {
        // Round-3 review N-2: the typed code now matches the status (the
        // plan sketch's "BAD_REQUEST" read oddly for a 401).
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "ok": false,
                "error": { "code": "UNAUTHORIZED", "message": "unauthorized", "retryable": false }
            })),
        );
    }
    let Some(provider) = body
        .get("provider")
        .and_then(Value::as_str)
        .map(String::from)
    else {
        return typed_bad_request("body must carry a string `provider`");
    };
    let Some(session_id) = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(String::from)
    else {
        return typed_bad_request("body must carry a string `sessionId`");
    };
    let target_kind = match body.get("targetKind").and_then(Value::as_str) {
        Some("terminal") => RuntimeOwnerKind::Terminal,
        Some("fresh-agent") => RuntimeOwnerKind::FreshAgent,
        _ => {
            return typed_bad_request("targetKind must be \"terminal\" or \"fresh-agent\"");
        }
    };
    let action = match parse_handoff_action(&body) {
        Ok(action) => action,
        Err(message) => return typed_bad_request(message),
    };
    // b8ke delta review F7: a half-sent observed pair (exactly one of
    // epoch/generation) is the typed invalid-fence refusal — never a silent
    // downgrade to the unfenced legacy path. No handoff is spawned.
    let observed_epoch = body.get("observedEpoch").and_then(Value::as_u64);
    let observed_generation = body.get("observedGeneration").and_then(Value::as_u64);
    if let Err(err) = crate::ownership_lane::wire_fence(observed_epoch, observed_generation) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": { "code": err.code(), "message": err.message(), "retryable": false }
            })),
        );
    }
    let session_type = body
        .get("sessionType")
        .and_then(Value::as_str)
        .map(String::from);
    let mode = body.get("mode").and_then(Value::as_str).map(String::from);
    // b8ke delta review F5: the provider↔target validation, refused
    // PRE-SPAWN — a sessionType that is not one of the provider's canonical
    // fresh-agent types (or an ambiguous absent one), or a terminal mode
    // that does not match the provider, is a typed 400: the prior runtime is
    // never stopped, the coordinator never touched.
    if let Err(reason) = validate_handoff_target(
        &provider,
        target_kind,
        session_type.as_deref(),
        mode.as_deref(),
        &runner.cli_commands,
    ) {
        return typed_bad_request(&reason);
    }
    let req = HandoffRequest {
        action,
        provider,
        session_id,
        target_kind,
        session_type,
        mode,
        cwd: body.get("cwd").and_then(Value::as_str).map(String::from),
        tab_id: body.get("tabId").and_then(Value::as_str).map(String::from),
        pane_id: body.get("paneId").and_then(Value::as_str).map(String::from),
        observed_epoch,
        observed_generation,
        device_id: body
            .get("deviceId")
            .and_then(Value::as_str)
            .map(String::from),
    };
    // The reply rides the handle's oneshot with a bounded HTTP timeout; the
    // operation itself is detached and outlives the request.
    let handle = runner.spawn_handoff(req);
    let mut completion = handle.completion;
    match tokio::time::timeout(std::time::Duration::from_secs(30), &mut completion).await {
        Ok(Ok(value)) => {
            let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
            (
                if ok {
                    StatusCode::OK
                } else {
                    StatusCode::CONFLICT
                },
                Json(value),
            )
        }
        _ => (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": {
                    "code": "HANDOFF_IN_PROGRESS",
                    "message": "handoff still in flight; the operation continues server-side",
                    "retryable": true
                }
            })),
        ),
    }
}

fn typed_bad_request(message: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "ok": false,
            "error": { "code": "BAD_REQUEST", "message": message, "retryable": false }
        })),
    )
}

/// The provider's canonical fresh-agent session types — the lane derivation
/// (`model_capabilities`'s `SessionType::runtime_provider` mapping, the same
/// one every lane and model-capability surface uses): freshcodex rides the
/// codex lane, freshopencode the opencode lane, and BOTH claude flavors
/// (freshclaude, kilroy) ride the claude lane.
pub(crate) fn canonical_session_types(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "codex" => Some(&["freshcodex"]),
        "opencode" => Some(&["freshopencode"]),
        "claude" => Some(&["freshclaude", "kilroy"]),
        _ => None,
    }
}

/// b8ke delta review F5: validate the request's target against its provider
/// BEFORE any coordinator state change (the HTTP handler refuses pre-spawn
/// with the typed 400; [`SessionHandoffRunner::run`] re-checks at entry for
/// direct `spawn_handoff` callers). (a) a fresh-agent target's `sessionType`
/// must be one of the provider's canonical types — an ABSENT sessionType
/// resolves only when unambiguous (claude is two flavors: rejected — the
/// safer choice, consistent with the lane derivation that never maps a
/// claude session by provider alone); (b) a terminal target's `mode` must
/// be the provider's own CLI mode (the registry-row join every sessionRef
/// lookup uses: `mode == provider`) and a registered session-bearing mode.
/// A mismatch never stops the prior runtime, never bumps the generation,
/// and never spawns a blank wrong-provider CLI.
pub(crate) fn validate_handoff_target(
    provider: &str,
    target_kind: RuntimeOwnerKind,
    session_type: Option<&str>,
    mode: Option<&str>,
    cli_commands: &[freshell_platform::CliCommandSpec],
) -> Result<(), String> {
    match target_kind {
        RuntimeOwnerKind::FreshAgent => {
            let Some(canonical) = canonical_session_types(provider) else {
                return Err(format!(
                    "provider {provider:?} has no fresh-agent lane (expected codex | claude | opencode)"
                ));
            };
            match session_type {
                Some(st) if canonical.contains(&st) => Ok(()),
                Some(st) => Err(format!(
                    "sessionType {st:?} is not a {provider:?} fresh-agent session type \
                     (expected one of {canonical:?})"
                )),
                None if canonical.len() == 1 => Ok(()), // unambiguous: the provider's single flavor
                None => Err(format!(
                    "provider {provider:?} has multiple fresh-agent session types {canonical:?}; \
                     sessionType is required"
                )),
            }
        }
        RuntimeOwnerKind::Terminal => {
            let mode_ref = mode.unwrap_or(provider);
            if mode_ref != provider {
                return Err(format!(
                    "terminal mode {mode_ref:?} does not match provider {provider:?} (a handoff \
                     terminal target must run the provider's own CLI mode)"
                ));
            }
            if !cli_commands.iter().any(|spec| spec.name == mode_ref) {
                return Err(format!(
                    "unknown CLI mode {mode_ref:?} (a handoff terminal target must be a \
                     registered coding-CLI mode)"
                ));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;

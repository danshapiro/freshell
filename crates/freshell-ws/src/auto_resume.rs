//! Bounded auto-resume for crashed coding-agent terminals (Lane D1).
//!
//! Policy: a coding-agent terminal (mode ∈ AUTO_RESUME_MODES) that exits
//! NON-ZERO is auto-resumed up to `delays.len()` times with backoff, from its
//! server-side identity (identity registry / pane ledger). Clean exits
//! (code 0) and user kills (structurally excluded upstream — `kill_internal`
//! removes the registry row so `finish_pty_exit` returns `false` and no
//! CrashEvent is ever sent) NEVER auto-resume. The registry's
//! respawn-generation cap is the outer loop bound (campaign plan §7.5).
//! Schedule shape mirrors the repo exemplar `activity.rs::lane_retry_delay_ms`.
//!
//! Coverage boundary: only WS-created terminals feed CrashEvents — their exit
//! hook is built by `terminal::build_pty_exit_hook`. REST/freshagent-created
//! agent panes (`freshell-freshagent/src/terminal_tabs.rs`'s own exit hook)
//! are out of scope for auto-resume in this lane and keep today's behavior.
//! (Both hooks funnel through `finish_pty_exit`, so a future registry-layer
//! observation could cover all paths; recorded as future work.)

pub(crate) const AUTO_RESUME_MODES: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

/// Backoff before retry N (index = attempts already made). 2 retries max
/// per user ruling 2026-07-27. After the last entry: exhausted and LOUD.
pub(crate) const AUTO_RESUME_DEFAULT_DELAYS_MS: [u64; 2] = [2_000, 10_000];

/// Grace before settling `no_resumable_identity` (kata kmbs): identity can
/// legitimately land SECONDS after the crash decision — codex/opencode
/// locator adoption windows are 2s (`codex_locator.rs` /
/// `opencode_locator.rs`), and a claude instant-crash races the create-path
/// identity upsert. Total 5s sits inside the repo's own unresolved-identity
/// alarm budget (`IDENTITY_RESOLUTION_GRACE_MS = 10_000`, invariants.rs).
/// Empty via env = grace disabled (escape hatch). Bounded and LOUD:
/// exhaustion still settles `no_resumable_identity`.
pub(crate) const AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS: [u64; 2] = [2_500, 2_500];

/// A crashed generation that lived at least this long proves the previous
/// resume was healthy — the attempt counter resets (mirrors
/// `DEFAULT_RESPAWN_LIVENESS_WINDOW_MS` in freshell-terminal).
pub(crate) const AUTO_RESUME_HEALTHY_LIFETIME_MS: i64 = 30_000;

/// Flap circuit breaker (kata znhn item 2, user ruling: bounded-and-loud,
/// never infinite-and-silent). A "cycle" is one SUCCESSFUL auto-resume.
/// Cycles are pruned to a rolling window at each crash and are NEVER reset
/// by healthy generations — that is the cross-reset bound (it also bounds
/// the out-of-band `kill` resurrection loop). When a crash arrives with
/// cycles >= max, settle exited instead of resuming; Relaunch stays
/// available.
pub(crate) const AUTO_RESUME_DEFAULT_MAX_CYCLES: u32 = 5;
pub(crate) const AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS: i64 = 3_600_000;

/// Settle reason for a user cancel — shared by the WS cancel handler's
/// immediate frame (`terminal::handle_auto_resume_cancel`) and the hub's
/// post-sleep re-emit below, so the two frames can never drift. Tests pin
/// the literal on purpose (protocol value, not an internal name).
pub(crate) const SETTLE_REASON_CANCELLED: &str = "auto-resume cancelled";

use crate::env_parse;

pub(crate) fn auto_resume_max_cycles() -> u32 {
    env_parse(
        "FRESHELL_AUTO_RESUME_MAX_CYCLES",
        AUTO_RESUME_DEFAULT_MAX_CYCLES,
    )
}
pub(crate) fn auto_resume_cycle_window_ms() -> i64 {
    env_parse(
        "FRESHELL_AUTO_RESUME_CYCLE_WINDOW_MS",
        AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS,
    )
}
/// e2e knob: shrinking this lets tests exercise healthy-reset flap loops in
/// milliseconds. Production default matches the frozen 30s semantics.
pub(crate) fn auto_resume_healthy_lifetime_ms() -> i64 {
    env_parse(
        "FRESHELL_AUTO_RESUME_HEALTHY_LIFETIME_MS",
        AUTO_RESUME_HEALTHY_LIFETIME_MS,
    )
}

/// Hub policy knobs, resolved once at spawn (env-overridable for e2e).
#[derive(Debug, Clone)]
pub(crate) struct HubConfig {
    pub delays: Vec<u64>,
    /// Bounded identity-grace re-check schedule (kata kmbs), stepped through
    /// by the hub loop before a `no_resumable_identity` settle. Empty =
    /// grace disabled (env escape hatch).
    pub identity_grace_delays: Vec<u64>,
    pub healthy_lifetime_ms: i64,
    pub max_cycles: u32,
    pub cycle_window_ms: i64,
}

impl HubConfig {
    pub(crate) fn from_env() -> Self {
        Self {
            delays: auto_resume_delays(),
            identity_grace_delays: auto_resume_identity_grace_delays(),
            healthy_lifetime_ms: auto_resume_healthy_lifetime_ms(),
            max_cycles: auto_resume_max_cycles(),
            cycle_window_ms: auto_resume_cycle_window_ms(),
        }
    }

    /// Test/harness constructor: explicit backoff AND identity-grace
    /// schedules, everything else from env defaults.
    pub(crate) fn with_schedules(delays: Vec<u64>, identity_grace_delays: Vec<u64>) -> Self {
        Self {
            delays,
            identity_grace_delays,
            ..HubConfig::from_env()
        }
    }
}

/// Per-createRequestId resume history. `attempts` is the consecutive
/// fast-fail budget (reset by a healthy generation); `cycles` is the
/// wall-clock record of every successful auto-resume, pruned to the rolling
/// window — deliberately NOT reset by healthy generations.
#[derive(Debug, Default, Clone)]
pub(crate) struct ResumeHistory {
    pub attempts: u32,
    pub cycles: Vec<i64>,
}

/// Crash notification from the PTY exit hook. Only sent for NATURAL exits
/// (`finish_pty_exit` returned `true`) — user kills never produce one.
/// `pub` (not `pub(crate)`): it rides the public `WsState.auto_resume_tx`
/// field, and integration tests drain it until the hub (Task 5) exists.
#[derive(Debug, Clone)]
pub struct CrashEvent {
    pub terminal_id: String,
    pub exit_code: i64,
    pub mode: String,
    pub create_request_id: Option<String>,
    /// `now - created_at` of the generation that just died.
    pub lifetime_ms: i64,
    /// kata b8ke Task 4: the dead generation's last-known coordinator
    /// `(epoch, generation)` (its committed ownership stamp) — the observed
    /// fence the respawn's coordinator claim carries, so a delayed recovery
    /// can never recreate ownership a newer generation superseded. `None`
    /// when the terminal never committed ownership.
    pub observed_fence: Option<(u64, u64)>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CrashContext<'a> {
    pub exit_code: i64,
    pub mode: &'a str,
    pub create_request_id: Option<&'a str>,
    pub has_resumable_identity: bool,
    pub lifetime_ms: i64,
    /// Consecutive auto-resume attempts already made for this createRequestId.
    pub prior_attempts: u32,
    /// `registry.respawn_exhausted(create_request_id)` — outer loop bound.
    pub cap_exhausted: bool,
    /// Successful auto-resumes inside the rolling window (flap breaker,
    /// znhn item 2) — NEVER reset by healthy generations.
    pub recent_cycles: u32,
    /// Breaker threshold (cfg.max_cycles).
    pub max_cycles: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoResumeDecision {
    Resume { attempt: u32, delay_ms: u64 },
    SettleExited { reason: &'static str },
}

pub(crate) fn decide(
    ctx: &CrashContext<'_>,
    delays: &[u64],
    healthy_lifetime_ms: i64,
) -> AutoResumeDecision {
    use AutoResumeDecision::SettleExited;
    if ctx.exit_code == 0 {
        return SettleExited {
            reason: "clean_exit",
        };
    }
    if !AUTO_RESUME_MODES.contains(&ctx.mode) {
        return SettleExited {
            reason: "not_agent_mode",
        };
    }
    if ctx.create_request_id.is_none() {
        return SettleExited {
            reason: "no_create_request_id",
        };
    }
    if !ctx.has_resumable_identity {
        return SettleExited {
            reason: "no_resumable_identity",
        };
    }
    // Flap circuit breaker (znhn item 2): checked BEFORE the healthy-reset —
    // a flap loop is exactly the case where every generation looks healthy.
    if ctx.recent_cycles >= ctx.max_cycles {
        return SettleExited {
            reason: "flap_circuit_breaker",
        };
    }
    if ctx.cap_exhausted {
        return SettleExited {
            reason: "respawn_cap_exhausted",
        };
    }
    let effective_prior = if ctx.lifetime_ms >= healthy_lifetime_ms {
        0
    } else {
        ctx.prior_attempts
    };
    match delays.get(effective_prior as usize).copied() {
        Some(delay_ms) => AutoResumeDecision::Resume {
            attempt: effective_prior + 1,
            delay_ms,
        },
        None => SettleExited {
            reason: "retries_exhausted",
        },
    }
}

/// `FRESHELL_AUTO_RESUME_DELAYS_MS="2000,10000"` — e2e tests set tiny values.
pub(crate) fn parse_delays_env(raw: &str) -> Option<Vec<u64>> {
    let parsed: Option<Vec<u64>> = raw
        .split(',')
        .map(|s| s.trim().parse::<u64>().ok().filter(|v| *v > 0))
        .collect();
    parsed.filter(|v| !v.is_empty())
}

pub(crate) fn auto_resume_delays() -> Vec<u64> {
    match std::env::var("FRESHELL_AUTO_RESUME_DELAYS_MS") {
        Ok(raw) => parse_delays_env(&raw).unwrap_or_else(|| {
            // Misconfiguration (e.g. trailing comma, non-numeric, zero) must
            // be observable — the override silently reverting to defaults is
            // otherwise indistinguishable from the env var not being set.
            tracing::warn!(
                raw,
                "FRESHELL_AUTO_RESUME_DELAYS_MS is set but unparseable — falling back to default delays"
            );
            AUTO_RESUME_DEFAULT_DELAYS_MS.to_vec()
        }),
        Err(_) => AUTO_RESUME_DEFAULT_DELAYS_MS.to_vec(),
    }
}

/// `FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS="2500,2500"` (kata kmbs) —
/// bounded identity-grace schedule. Zero/invalid values fall back LOUDLY to
/// the default; an explicit empty string disables the grace (escape hatch).
pub(crate) fn auto_resume_identity_grace_delays() -> Vec<u64> {
    match std::env::var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS") {
        Ok(raw) if raw.trim().is_empty() => Vec::new(),
        Ok(raw) => parse_delays_env(&raw).unwrap_or_else(|| {
            tracing::warn!(
                raw,
                "FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS is set but unparseable — falling back to default grace delays"
            );
            AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec()
        }),
        Err(_) => AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec(),
    }
}

/// The auto-resume orchestrator: consumes [`CrashEvent`]s, applies
/// [`decide`], and drives the retry pipeline (recovering frame → backoff →
/// post-sleep guards → lease claim → respawn → lease completion → replaced
/// frame) through an [`AutoResumeDriver`].
/// Backoff (ms) between hub-body restarts after a driver panic — escalating so
/// a hot-panicking driver cannot spin a restart loop, capped at the last entry
/// so auto-resume is NEVER permanently lost (council 7w4h/xkhx, crusty: an
/// unsupervised panic silently ending auto-resume forever would reinstate the
/// exact overnight-grey-pane incident this feature prevents). The counter
/// resets after a body that ran healthy for [`AUTO_RESUME_HEALTHY_LIFETIME_MS`].
const HUB_SUPERVISOR_BACKOFF_MS: &[u64] = &[1_000, 5_000, 30_000, 60_000];

pub(crate) fn spawn_hub_with_driver<D: AutoResumeDriver + Sync>(
    driver: D,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    cfg: HubConfig,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // SUPERVISOR: `rx` and the attempts map are owned HERE, outside the
        // catch_unwind boundary, so a driver panic mid-event drops only the
        // in-flight body future — the crash-event channel (whose senders live
        // in every PTY exit hook) and the retry bookkeeping both survive the
        // restart. (Respawning with a fresh channel would NOT work: exit
        // hooks clone the sender at hook-build time.)
        let mut attempts: std::collections::HashMap<String, ResumeHistory> =
            std::collections::HashMap::new();
        let mut consecutive_panics: u32 = 0;
        loop {
            let body_started = std::time::Instant::now();
            let body =
                std::panic::AssertUnwindSafe(run_hub_body(&driver, &mut rx, &cfg, &mut attempts));
            match futures_util::FutureExt::catch_unwind(body).await {
                // Channel closed: every sender dropped (server shutdown).
                Ok(()) => return,
                Err(panic) => {
                    // Deliberate const (NOT cfg.healthy_lifetime_ms): panic
                    // supervision health is orthogonal to the attempts/cycles
                    // policy and must not follow the e2e knob — a shrunken
                    // env value would let a hot-panicking driver reset its
                    // own backoff.
                    if body_started.elapsed().as_millis() as i64 >= AUTO_RESUME_HEALTHY_LIFETIME_MS
                    {
                        consecutive_panics = 0;
                    }
                    let idx =
                        (consecutive_panics as usize).min(HUB_SUPERVISOR_BACKOFF_MS.len() - 1);
                    let backoff_ms = HUB_SUPERVISOR_BACKOFF_MS[idx];
                    consecutive_panics = consecutive_panics.saturating_add(1);
                    let message: String = panic
                        .downcast_ref::<&'static str>()
                        .map(|s| (*s).to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "<non-string panic payload>".to_string());
                    // The payload box is `dyn Any + Send` (not Sync): drop it
                    // BEFORE the backoff await so this future stays Send.
                    drop(panic);
                    tracing::error!(
                        panic = %message,
                        consecutive_panics,
                        restart_in_ms = backoff_ms,
                        "terminal.auto_resume.hub_panicked — restarting driver"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                }
            }
        }
    })
}

/// The create-answer hold's poll cadence: how long the hub parks between
/// requeue rotations of a crash event whose originating create is still
/// unanswered. Keeps an otherwise-idle crash-event channel from hot-spinning
/// while the create's post-spawn tail (spawn-blocking hops, durable ledger
/// writes, coordinator settle) runs to its `terminal.created` reply.
const CREATE_ANSWER_HOLD_POLL_MS: u64 = 10;

/// One incarnation of the hub loop. Returns only when the crash-event channel
/// closes; a driver panic unwinds out to the supervisor in
/// [`spawn_hub_with_driver`], which restarts this body with the same `rx` and
/// `attempts` after a bounded backoff.
async fn run_hub_body<D: AutoResumeDriver + Sync>(
    driver: &D,
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    cfg: &HubConfig,
    attempts: &mut std::collections::HashMap<String, ResumeHistory>,
) {
    {
        // Retaining exhausted / pane-closed entries is DELIBERATE (not a
        // leak): evicting on exhaustion would refill the retry budget for an
        // immediate manual-Relaunch re-crash.
        let max_attempts = cfg.delays.len() as u32;
        // Design note (serialization): handling events sequentially in ONE
        // task means a backoff sleep delays other panes' resumes by up to
        // 10s worst-case. Acceptable at v1 — crashes are rare, the budget is
        // tiny, and full serialization is the strongest anti-storm property
        // (one respawn in flight, ever).
        'events: while let Some(ev) = rx.recv().await {
            // CREATE-ANSWER ORDERING GUARD (Gate 1): a terminal whose
            // originating `terminal.create` has not yet answered must not
            // have its crash lifecycle broadcast. The client learns the
            // terminalId from the `terminal.created` reply; a
            // recovering/settled frame that is admitted to the creating
            // connection's outbox BEFORE that reply is unassociatable and
            // silently lost (the crash can beat the reply because the
            // create worker's post-spawn tail — durable ledger writes,
            // coordinator settle — awaits AFTER the PTY's exit watcher is
            // already armed). Hold the event until the create-dedupe
            // sentinel reports the create answered (settle follows the
            // reply's admission; every failure/cancel path clears it), by
            // requeueing it to the BACK of the channel: other terminals'
            // events keep flowing, the event survives hub-body restarts
            // (it lives in the channel, not hub-local state), and the
            // short sleep keeps an otherwise-idle channel from hot-spinning.
            if let Some(key) = ev.create_request_id.as_deref() {
                if driver.create_reply_pending(key) {
                    driver.requeue_crash_event(ev);
                    tokio::time::sleep(std::time::Duration::from_millis(
                        CREATE_ANSWER_HOLD_POLL_MS,
                    ))
                    .await;
                    continue 'events;
                }
            }
            let mut sref = driver.resumable_session_ref(&ev.terminal_id);
            // Identity grace (kata kmbs): `no_resumable_identity` used to be
            // a one-shot, never-reconsidered settle — a permanently dead pane
            // when identity legitimately landed seconds later (locator
            // adoption windows, load-race upsert lag). Re-check here, at the
            // single decision choke point, through a BOUNDED schedule before
            // deciding: identity arriving in grace converts the settle into
            // the normal Resume path with zero special-casing below. Skipped
            // unless no_resumable_identity is the reason `decide` WOULD
            // settle on — same predicate order: clean_exit / not_agent_mode /
            // no_create_request_id settle immediately, grace-free.
            if sref.is_none()
                && ev.exit_code != 0
                && AUTO_RESUME_MODES.contains(&ev.mode.as_str())
                && ev.create_request_id.is_some()
                && cfg.identity_grace_delays.iter().any(|s| *s > 0)
            {
                tracing::info!(
                    terminal_id = %ev.terminal_id,
                    "terminal.auto_resume.identity_grace_entered"
                );
                for step in &cfg.identity_grace_delays {
                    if *step == 0 {
                        continue;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(*step)).await;
                    // Cancel during grace stays LOUD (mirrors the Resume
                    // arm's post-sleep take_cancel) — never consumed
                    // silently by the settle tail's hygiene cleanup.
                    if driver.take_cancel(&ev.terminal_id) {
                        // iteration-tail invariant: every exit path from an
                        // event ends by retiring the dead terminal's identity;
                        // retire is idempotent and tombstone-free
                        // (identity.rs), so unconditional calls are safe —
                        // revival can land before query#1, during any
                        // grace/backoff sleep, or between the final recheck
                        // and the tail. (Residual: an upsert racing in AFTER
                        // the final retire of the iteration is outside any
                        // in-hub fix — no writer today upserts a terminal id
                        // whose pane is already dead AND settled (locators /
                        // signal-rebinds target live panes); this residual is
                        // accepted.)
                        driver.retire_identity(&ev.terminal_id);
                        driver.emit_settled(&ev.terminal_id, SETTLE_REASON_CANCELLED, None);
                        driver.log_settled(&ev.terminal_id, "user_cancelled");
                        continue 'events;
                    }
                    sref = driver.resumable_session_ref(&ev.terminal_id);
                    if sref.is_some() {
                        tracing::info!(
                            terminal_id = %ev.terminal_id,
                            "terminal.auto_resume.identity_grace_resolved"
                        );
                        break;
                    }
                }
            }
            // Prune the cycle record to the rolling window BEFORE deciding
            // (znhn item 2): recent_cycles feeds the breaker threshold.
            let now = crate::terminal::now_ms();
            // Read-only lookup: entries are materialized ONLY by the Resume
            // arm. Inserting here would grow the map by one entry per
            // terminal ever exited (shell panes and clean exits included)
            // with nothing to evict it — and an absent entry is
            // semantically identical to a zeroed one.
            let (prior_attempts, recent_cycles) = match ev
                .create_request_id
                .as_deref()
                .and_then(|k| attempts.get_mut(k))
            {
                Some(h) => {
                    h.cycles.retain(|t| now - *t <= cfg.cycle_window_ms);
                    (h.attempts, h.cycles.len() as u32)
                }
                None => (0, 0),
            };
            let ctx = CrashContext {
                exit_code: ev.exit_code,
                mode: &ev.mode,
                create_request_id: ev.create_request_id.as_deref(),
                has_resumable_identity: sref.is_some(),
                lifetime_ms: ev.lifetime_ms,
                prior_attempts,
                cap_exhausted: ev
                    .create_request_id
                    .as_deref()
                    .map(|k| driver.cap_exhausted(k))
                    .unwrap_or(true),
                recent_cycles,
                max_cycles: cfg.max_cycles,
            };
            match decide(&ctx, &cfg.delays, cfg.healthy_lifetime_ms) {
                AutoResumeDecision::SettleExited { reason } => {
                    if ev.mode != "shell" {
                        driver.emit_settled(
                            &ev.terminal_id,
                            reason,
                            if reason == "flap_circuit_breaker" {
                                Some(recent_cycles)
                            } else {
                                None
                            },
                        );
                        driver.log_settled(&ev.terminal_id, reason);
                    }
                    if reason == "clean_exit" || ev.lifetime_ms >= cfg.healthy_lifetime_ms {
                        if let Some(k) = &ev.create_request_id {
                            // Reset attempts only, KEEP cycles: the breaker's
                            // cross-reset bound requires cycles to survive
                            // healthy generations (znhn item 2; validated A8:
                            // this condition must use the SAME configured
                            // healthy-lifetime as `decide`).
                            if let Some(h) = attempts.get_mut(k) {
                                h.attempts = 0;
                                // A zeroed budget with no cycles left in the
                                // window is indistinguishable from an absent
                                // entry — evict, or the map grows one dead
                                // entry per healthy terminal ever run.
                                if h.cycles.is_empty() {
                                    attempts.remove(k);
                                }
                            }
                        }
                    }
                    // Iteration-tail invariant (see the grace-cancel tail).
                    driver.retire_identity(&ev.terminal_id);
                    // Fresh-eyes fix: a cancel whose terminal settles without
                    // ever reaching the Resume arm's take_cancel check would
                    // otherwise leak in auto_resume_cancels forever — the
                    // "removed on consumption" invariant must hold on EVERY
                    // settle tail. Consumed silently: the pane is already
                    // settled, there is nothing left to abort.
                    let _ = driver.take_cancel(&ev.terminal_id);
                }
                AutoResumeDecision::Resume { attempt, delay_ms } => {
                    let (provider, session_id, cwd) = sref.expect("checked by decide");
                    let key = ev.create_request_id.clone().expect("checked by decide");
                    attempts.entry(key.clone()).or_default().attempts = attempt;
                    // Re-retire BEFORE the recovering frame: a revival that
                    // landed before query#1 or during the grace must not
                    // leave the dead identity live between the decision and
                    // the respawn (iteration-tail invariant, grace-cancel
                    // tail).
                    driver.retire_identity(&ev.terminal_id);
                    driver.emit_recovering(
                        &ev.terminal_id,
                        &ev.mode,
                        ev.exit_code,
                        attempt,
                        max_attempts,
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    // Guards AFTER the sleep — the world may have moved on.
                    if driver.take_cancel(&ev.terminal_id) {
                        // D-4 (validated A5): re-emit the settle frame here
                        // too. The handler's immediate frame covers the
                        // click-latency story; THIS frame guarantees a
                        // late-consumed or pre-seeded cancel is loud and can
                        // never strand a recovering notice. Idempotent
                        // client-side (recordAutoResumeSettled).
                        driver.emit_settled(&ev.terminal_id, SETTLE_REASON_CANCELLED, None);
                        driver.log_settled(&ev.terminal_id, "user_cancelled");
                        // Iteration-tail invariant (see the grace-cancel tail).
                        driver.retire_identity(&ev.terminal_id);
                        continue;
                    }
                    if let Some(reason) =
                        driver.pre_respawn_guard(&provider, &session_id, &ev.terminal_id)
                    {
                        driver.emit_settled(&ev.terminal_id, reason, None);
                        driver.log_settled(&ev.terminal_id, reason);
                        // Cancel-set hygiene (fresh-eyes fix): a cancel that
                        // landed after the take_cancel check above must not
                        // leak — every settle tail cleans it up.
                        let _ = driver.take_cancel(&ev.terminal_id);
                        // Iteration-tail invariant (see the grace-cancel tail).
                        driver.retire_identity(&ev.terminal_id);
                        continue;
                    }
                    if !driver
                        .claim_session(
                            &provider,
                            &session_id,
                            &key,
                            ev.observed_fence.map(|(epoch, generation)| {
                                freshell_ownership::ObservedFence { epoch, generation }
                            }),
                        )
                        .await
                    {
                        driver.emit_settled(&ev.terminal_id, "session_lease_held", None);
                        driver.log_settled(&ev.terminal_id, "session_lease_held");
                        // Cancel-set hygiene (see the guard tail above).
                        let _ = driver.take_cancel(&ev.terminal_id);
                        // Iteration-tail invariant (see the grace-cancel tail).
                        driver.retire_identity(&ev.terminal_id);
                        continue;
                    }
                    let spec = RespawnSpec {
                        mode: ev.mode.clone(),
                        provider: provider.clone(),
                        session_id: session_id.clone(),
                        create_request_id: key.clone(),
                        cwd,
                    };
                    match driver.respawn(&spec).await {
                        Ok(new_tid) => {
                            if driver
                                .complete_claim(&provider, &session_id, &key, &new_tid)
                                .await
                            {
                                driver.emit_replaced(
                                    &ev.terminal_id,
                                    &new_tid,
                                    ev.exit_code,
                                    attempt,
                                    max_attempts,
                                );
                                // One successful auto-resume = one breaker
                                // cycle (znhn item 2). Re-fetch the entry —
                                // the earlier borrow ended before the awaits.
                                attempts
                                    .entry(key.clone())
                                    .or_default()
                                    .cycles
                                    .push(crate::terminal::now_ms());
                            } else {
                                // Binding raced away between claim and completion; the
                                // driver already killed its own orphan child. No
                                // terminal.replaced — the pane stays settled exited.
                                driver.emit_settled(&ev.terminal_id, "lease_completion_lost", None);
                                driver.log_settled(&ev.terminal_id, "lease_completion_lost");
                            }
                        }
                        Err(err) => {
                            driver.fail_claim(&provider, &session_id, &key);
                            tracing::warn!(terminal_id = %ev.terminal_id, error = %err, "terminal.auto_resume.respawn_failed");
                            driver.emit_settled(&ev.terminal_id, "respawn_failed", None);
                            driver.log_settled(&ev.terminal_id, "respawn_failed");
                        }
                    }
                    // Cancel-set hygiene (fresh-eyes fix): a cancel landing
                    // DURING the respawn await — after the post-sleep
                    // take_cancel check — would otherwise leak forever. Too
                    // late to abort (the resume already ran); clean up on
                    // every tail of the respawn match (replaced /
                    // lease_completion_lost / respawn_failed).
                    let _ = driver.take_cancel(&ev.terminal_id);
                    // Arm-end retire (iteration-tail invariant, grace-cancel
                    // tail): covers a revival landing during the backoff
                    // sleep — after the pre-emit retire already ran.
                    driver.retire_identity(&ev.terminal_id);
                }
            }
        }
    }
}

/// Orchestrator-facing effects, faked in unit tests.
///
/// LEASE-SHAPE NOTE (fresh-eyes fix): the trait mirrors the REAL registry
/// lease API, which is asymmetric — success binds the lease to the NEW
/// terminal via `complete_session_ref_claim(locator, holder_create_request_id,
/// terminal_id) -> bool` (registry.rs:1964), failure releases it via
/// `fail_session_ref_claim(locator, holder_create_request_id)` (registry.rs:2007).
/// A single symmetric `release_claim` cannot implement that discipline, so the
/// trait exposes `complete_claim` / `fail_claim` distinctly, and the claim call
/// carries the holder create-request-id the registry keys the lease by.
///
/// ASYNC-SHAPE NOTE: `claim_session` and `complete_claim` return futures (the
/// same RPITIT shape as `respawn`) because the production impl must AWAIT the
/// kill→confirm discipline on its lease paths — `ExpiredNeedsKill` in the
/// claim rounds, and the kill-own-child mirror on a lost completion — exactly
/// like the create ingress does (`terminal.rs` claim rounds / complete==false
/// path). A sync signature would force blocking a runtime worker.
pub(crate) trait AutoResumeDriver: Send + 'static {
    fn cap_exhausted(&self, create_request_id: &str) -> bool;

    /// CREATE-ANSWER ORDERING GUARD (Gate 1): true while the originating
    /// `terminal.create` for this request id has not yet answered its client
    /// — the server-wide create-dedupe sentinel is still InFlight, meaning
    /// the `terminal.created` reply naming the terminal has not been
    /// admitted to the creating connection's outbox. A terminal-scoped
    /// crash broadcast (recovering/settled/replaced) that precedes that
    /// reply is UNASSOCIABLE by the client (it keys auto-resume state by a
    /// terminalId it has not learned yet) and is silently lost — exactly the
    /// gate-1 e2e failure where the first `terminal.status{recovering}`
    /// landed before `terminal.created` and the test (like the SPA) could
    /// only match the attempt-2 frame naming the replacement. The hub HOLDS
    /// the crash event while this returns true.
    fn create_reply_pending(&self, create_request_id: &str) -> bool;

    /// Return a held [`CrashEvent`] to the BACK of the crash-event channel
    /// (the create-answer hold's requeue): other terminals' events keep
    /// flowing while one create is unanswered, and the held event is retried
    /// on the hub's next poll instead of being dropped or processed early.
    /// Living in the channel (not a hub-local stash) also keeps the event
    /// alive across a driver-panic body restart.
    fn requeue_crash_event(&self, ev: CrashEvent);

    /// (provider, session_id, cwd)
    fn resumable_session_ref(&self, terminal_id: &str) -> Option<(String, String, Option<String>)>;
    /// Post-backoff guard. Some(reason) aborts the resume and settles with that
    /// reason ("session_owned_live" when a live terminal already owns the
    /// session-ref; "pane_closed" when the pane's ledger binding was retired
    /// during the backoff). None = clear to claim.
    fn pre_respawn_guard(
        &self,
        provider: &str,
        session_id: &str,
        old_terminal_id: &str,
    ) -> Option<&'static str>;
    /// Acquire the session-ref lease for this holder; false = not acquirable → abort.
    /// The PRODUCTION impl runs the create ingress's full bounded claim
    /// discipline internally — the hub only sees the outcome. `observed` is
    /// the crash event's fence pair: the COORDINATOR claim (kata b8ke Task 4)
    /// consumes it as the delayed-request fence.
    fn claim_session(
        &self,
        provider: &str,
        session_id: &str,
        create_request_id: &str,
        observed: Option<freshell_ownership::ObservedFence>,
    ) -> impl std::future::Future<Output = bool> + Send;
    /// Bind the acquired lease to the freshly spawned terminal
    /// (complete_session_ref_claim). false = the binding raced away; the
    /// PRODUCTION impl has already killed its own orphan child before
    /// returning (mirror of the ingress complete==false path).
    fn complete_claim(
        &self,
        provider: &str,
        session_id: &str,
        create_request_id: &str,
        new_terminal_id: &str,
    ) -> impl std::future::Future<Output = bool> + Send;
    /// Release a claim whose respawn failed (fail_session_ref_claim).
    fn fail_claim(&self, provider: &str, session_id: &str, create_request_id: &str);
    fn respawn(
        &self,
        req: &RespawnSpec,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
    fn emit_recovering(
        &self,
        terminal_id: &str,
        mode: &str,
        exit_code: i64,
        attempt: u32,
        max_attempts: u32,
    );
    fn emit_replaced(&self, old: &str, new: &str, exit_code: i64, attempt: u32, max_attempts: u32);
    /// Broadcast the settle frame — `terminal.status { status: 'exited' }`
    /// for the OLD terminal id (znhn item 3). Every agent-mode settle emits
    /// it: the client clears the recovering notice on a FRAME, never on a
    /// timer. `resume_cycles` is Some only for flap-circuit-breaker settles.
    fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>);
    /// Consume a pending user cancel for this terminal id (znhn item 2).
    fn take_cancel(&self, terminal_id: &str) -> bool;
    fn log_settled(&self, terminal_id: &str, reason: &str);
    /// Restore the crash invariant — the dead terminal's identity stays
    /// retired — at every iteration tail. The exit hook retires before the
    /// CrashEvent is sent, but an identity landed via upsert AFTER the hook
    /// un-retires it (identity.rs:123). Called UNCONDITIONALLY at the end of
    /// every event path (the iteration-tail invariant in `run_hub_body`):
    /// idempotent and tombstone-free, so paths that saw no revival retire a
    /// no-op.
    fn retire_identity(&self, terminal_id: &str);
}

/// Everything a respawn needs, resolved by the hub before the driver call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RespawnSpec {
    pub mode: String,
    pub provider: String,
    pub session_id: String,
    pub create_request_id: String,
    pub cwd: Option<String>,
}

/// The production [`AutoResumeDriver`]: delegates to the real registry /
/// identity / ledger / respawn seam / broadcast bus.
pub(crate) struct WsAutoResumeDriver {
    pub(crate) state: crate::WsState,
    /// kata b8ke Task 4: the in-flight coordinator claim ticket for the
    /// respawn currently being driven (claim_session → complete/fail_claim).
    /// The hub processes crash events sequentially, so one slot suffices;
    /// Arc-shared with the claim future so a registry-lease refusal inside
    /// it can drop (typed-fail) the parked ticket.
    pending_ownership: std::sync::Arc<std::sync::Mutex<Option<PendingOwnershipClaim>>>,
    /// b8ke ext r13 F2: the crash-recovery Adopt path's held authority —
    /// the ext-r12 attach guard armed when the claim Adopts a live
    /// same-kind owner (the incumbent terminal's death is in flight), held
    /// across the resume's spawn window and dropped at complete/fail_claim.
    /// While held, a handoff or stop begin on the key answers the typed
    /// Blocked outcome.
    pending_attach_guard: std::sync::Arc<std::sync::Mutex<Option<freshell_ownership::AttachGuard>>>,
    /// A failed respawn whose replacement start was given up inside its
    /// unit: `fail_claim` hands the claim (ticket, attach guard, lease
    /// release) through this relay to that start, which drops it only once
    /// the unit is Gone, so the conversation is never released while the
    /// replacement's Codex may still hold it. The hub never waits for it.
    pending_claim_relay: std::sync::Arc<std::sync::Mutex<Option<ClaimRelaySender>>>,
}

/// The sending half of a respawn start's [`crate::unit_lifecycle::ClaimRelay`].
type ClaimRelaySender = tokio::sync::oneshot::Sender<Box<dyn std::any::Any + Send>>;

/// Releases a respawn's sessionRef lease when dropped (the headless
/// driver's failure-path release, carried to a given-up start's Gone).
struct FailSessionRefClaim {
    registry: freshell_terminal::TerminalRegistry,
    locator: freshell_protocol::SessionLocator,
    create_request_id: String,
}

impl Drop for FailSessionRefClaim {
    fn drop(&mut self) {
        self.registry
            .fail_session_ref_claim(&self.locator, &self.create_request_id);
    }
}

/// The coordinator claim a respawn holds between `claim_session` and
/// `complete_claim`/`fail_claim` (kata b8ke Task 4).
struct PendingOwnershipClaim {
    locator: freshell_protocol::SessionLocator,
    ticket: freshell_ownership::OperationTicket,
}

/// A replacement in its unit (a Codex pane) that must die is stopped
/// through its unit's single stop path instead of a registry kill (which
/// would leave its app-server running): its sessionRef lease and retained
/// claim are released once the unit is Gone, on a spawned task. `false`
/// when the replacement is not a unit row.
fn stop_unit_replacement(
    state: &crate::WsState,
    terminal_id: &str,
    locator: &freshell_protocol::SessionLocator,
) -> bool {
    let Some(stop) = crate::unit_lifecycle::stop_unit_row(
        state,
        terminal_id,
        freshell_containment::StopReason::StartCancelled,
        "auto-resume-unowned-replacement",
        false,
    ) else {
        return false;
    };
    let registry = state.registry.clone();
    let locator = locator.clone();
    tokio::spawn(async move {
        stop.wait().await;
        registry.force_release_after_confirmed_kill(&locator);
    });
    true
}

fn session_locator(provider: &str, session_id: &str) -> freshell_protocol::SessionLocator {
    freshell_protocol::SessionLocator {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    }
}

impl AutoResumeDriver for WsAutoResumeDriver {
    fn cap_exhausted(&self, create_request_id: &str) -> bool {
        self.state.registry.respawn_exhausted(create_request_id)
    }

    fn create_reply_pending(&self, create_request_id: &str) -> bool {
        // The create-dedupe InFlight sentinel is installed at create
        // receipt and flips to Settled only AFTER the `terminal.created`
        // reply has been admitted to the creating connection's outbox
        // (terminal.rs settle ordering); every failure/cancel path clears
        // it (the interactive Job's Drop guard / create_gate's clears), so
        // the hold is bounded by the create's own lifetime.
        self.state.create_dedupe.is_in_flight(create_request_id)
    }

    fn requeue_crash_event(&self, ev: CrashEvent) {
        let _ = self.state.auto_resume_tx.send(ev);
    }

    /// Identity registry first (retired-inclusive — the exit hook retires
    /// the entry before the CrashEvent is handled), pane-ledger binding as
    /// the fallback home.
    fn resumable_session_ref(&self, terminal_id: &str) -> Option<(String, String, Option<String>)> {
        if let Some(entry) = self.state.identity.get(terminal_id) {
            if let (Some(provider), Some(session_id)) = (entry.provider, entry.session_id) {
                return Some((provider, session_id, entry.cwd));
            }
        }
        let locator = self
            .state
            .pane_ledger
            .bound_session_ref_for_terminal(terminal_id)?;
        let cwd = self
            .state
            .pane_ledger
            .list_bindings()
            .into_iter()
            .find(|r| r.provider == locator.provider && r.session_id == locator.session_id)
            .and_then(|r| r.cwd);
        Some((locator.provider, locator.session_id, cwd))
    }

    fn pre_respawn_guard(
        &self,
        provider: &str,
        session_id: &str,
        old_terminal_id: &str,
    ) -> Option<&'static str> {
        // The user already relaunched this session during the backoff.
        if self
            .state
            .registry
            .live_terminal_for_session_ref(&session_locator(provider, session_id))
            .is_some()
        {
            return Some("session_owned_live");
        }
        // The pane was closed during the backoff: `terminal.kill` retires the
        // ledger binding (`retire_closed`), so a still-Bound row is the
        // "pane still wants this session" signal. Ledger-disabled caveat:
        // `bound_session_ref_for_terminal` returns `None` both when retired
        // and when the ledger is disabled — only a RETIRED binding means
        // pane_closed, so skip the sub-check when the ledger is disabled
        // (the live-owner check and the lease still guard).
        if self.state.pane_ledger.is_enabled()
            && self
                .state
                .pane_ledger
                .bound_session_ref_for_terminal(old_terminal_id)
                .is_none()
        {
            return Some("pane_closed");
        }
        None
    }

    /// The create ingress's FULL bounded claim discipline, headless
    /// (mirror of `terminal.rs::handle_create`'s claim rounds): at most one
    /// ExpiredNeedsKill kill→confirm→force-release round, then re-claim;
    /// `Held`/`BoundElsewhere` (and rounds exhausted) are `false`.
    ///
    /// `holder_conn` is MINTED via `registry.new_connection_id()` — never a
    /// literal that could collide with a real WS connection id, or a client
    /// disconnect sweep could release the orchestrator's lease mid-respawn.
    /// A minted id is never swept, so the orchestrator OWNS the full release
    /// discipline on every path: success (`complete_claim`), respawn failure
    /// (`fail_claim`), completion failure (kill own child, below). No
    /// connection-death safety net exists for this holder.
    fn claim_session(
        &self,
        provider: &str,
        session_id: &str,
        create_request_id: &str,
        observed: Option<freshell_ownership::ObservedFence>,
    ) -> impl std::future::Future<Output = bool> + Send {
        let state = self.state.clone();
        let locator = session_locator(provider, session_id);
        let create_request_id = create_request_id.to_string();
        // kata b8ke Task 4: the COORDINATOR claim runs FIRST — before the
        // registry lease — with the crash event's fence pair (the dead
        // generation's committed (epoch, generation); a recovery observing a
        // superseded generation is typed-refused stale). Granted wraps the
        // RAII ticket and parks it in the driver's pending slot (the hub is
        // sequential; `complete_claim` commits it, `fail_claim` — or a
        // registry-lease refusal below — drops it for the typed fail). A
        // refusal aborts the resume (the key belongs to a newer owner or an
        // in-flight transition).
        let pending_slot = std::sync::Arc::clone(&self.pending_ownership);
        let pending_attach_guard_slot = std::sync::Arc::clone(&self.pending_attach_guard);
        // b8ke ext r13 F2: defensive hygiene — drop any stale guard from an
        // aborted prior iteration (its Drop closes the window).
        *pending_attach_guard_slot
            .lock()
            .expect("pending attach guard lock") = None;
        // The sync claim: Granted parks the ticket; the ADOPT shape defers
        // to the async resolution below (b8ke ext r13 F2 — the wait needs
        // awaits, and the pending lock must never live across one).
        let mut adopt_resolution_needed = false;
        let coordinator_refused = {
            let mut pending = pending_slot.lock().expect("pending ownership lock");
            // Defensive hygiene: drop any stale ticket from an aborted prior
            // iteration (its RAII drop performs the typed fail).
            *pending = None;
            match freshell_freshagent::ownership_lane::begin_terminal_lane_claim(
                &state.ownership,
                provider,
                session_id,
                &format!("auto-resume-{create_request_id}"),
                observed,
                "auto-resume",
                crate::terminal::now_ms().max(0) as u64,
            ) {
                freshell_freshagent::ownership_lane::TerminalLaneClaim::Granted(ticket) => {
                    *pending = Some(PendingOwnershipClaim {
                        locator: locator.clone(),
                        ticket,
                    });
                    false
                }
                freshell_freshagent::ownership_lane::TerminalLaneClaim::Unwired => false,
                freshell_freshagent::ownership_lane::TerminalLaneClaim::Adopt => {
                    // b8ke ext r13 F2: resolved ASYNC below (the dead
                    // incumbent's release wait).
                    adopt_resolution_needed = true;
                    false
                }
                freshell_freshagent::ownership_lane::TerminalLaneClaim::Refused(outcome) => {
                    tracing::warn!(target: "freshell_ws::auto_resume",
                        provider, session_id, create_request_id = %create_request_id,
                        outcome = ?outcome,
                        "auto_resume_ownership_refused: the coordinator refused the respawn claim"
                    );
                    true
                }
            }
        };
        let provider = provider.to_string();
        let session_id = session_id.to_string();
        async move {
            // b8ke ext r13 F2: the crash-recovery Adopt path RETAINS
            // AUTHORITY through spawn/commit. A live same-kind owner held
            // the key at the claim — the crashed incumbent's exit release
            // (or another terminal's ownership). The DEAD-incumbent shape
            // (its row is Exited/gone but the watcher's release trails the
            // crash event) waits for the imminent release and RE-CLAIMS
            // into a real Granted ticket — the parked ticket is the spawn
            // window's authority and complete_claim commits it (the
            // ordinary path; never a live unowned replacement beside a
            // vacant key — pre-r13 the Adopt path stored NO ticket and the
            // replacement stayed live while the key sat vacant). A
            // genuinely-RUNNING incumbent owns the session — the resume
            // ABORTS typed (never a second writer).
            let mut coordinator_refused = coordinator_refused;
            if !coordinator_refused && adopt_resolution_needed {
                coordinator_refused = true;
                if let Some(ownership) = state.ownership.as_ref() {
                    let incumbent = match &ownership.observe(&provider, &session_id).state {
                        freshell_ownership::OwnershipState::Live { owner, .. } => {
                            owner.terminal_id.clone()
                        }
                        _ => None,
                    };
                    let incumbent_row_running = incumbent.as_deref().is_some_and(|tid| {
                        matches!(
                            state.registry.probe(tid).map(|row| row.status),
                            Some(freshell_protocol::TerminalRunStatus::Running)
                        )
                    });
                    if incumbent_row_running {
                        tracing::warn!(target: "freshell_ws::auto_resume",
                            provider = %provider, session_id = %session_id,
                            create_request_id = %create_request_id,
                            incumbent = ?incumbent,
                            "auto_resume_adopt_aborted: a live terminal owns the session — \
                             the resume aborts typed (never a second writer)"
                        );
                    } else {
                        // The dead incumbent's release is imminent — wait
                        // for it (bounded, never a panic inside the hub
                        // task), then re-claim into a Granted ticket.
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_millis(2_000);
                        let released = loop {
                            if !matches!(
                                ownership.observe(&provider, &session_id).state,
                                freshell_ownership::OwnershipState::Live { .. }
                            ) {
                                break true;
                            }
                            if std::time::Instant::now() >= deadline {
                                break false;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        };
                        if !released {
                            tracing::error!(target: "invariant",
                                provider = %provider, session_id = %session_id,
                                create_request_id = %create_request_id,
                                "auto_resume_adopt_release_timeout: the dead incumbent's \
                                 ownership release never landed — the resume aborts \
                                 (fail-closed)"
                            );
                        } else {
                            match freshell_freshagent::ownership_lane::begin_terminal_lane_claim(
                                &state.ownership,
                                &provider,
                                &session_id,
                                &format!("auto-resume-{create_request_id}"),
                                // b8ke ext r14 F4: the retry carries the
                                // SAME observed fence as the first claim
                                // (the crash event's dead-generation pair)
                                // — a newer stop/handoff advancing the
                                // generation and returning the key to
                                // Vacant during the polling interval is
                                // rejected by generation arithmetic (the
                                // stale crash request can never claim the
                                // NEW generation and respawn what the
                                // newer operation deliberately stopped;
                                // pre-r14 the retry passed None, so the
                                // old request claimed whatever generation
                                // the key reached).
                                observed,
                                "auto-resume/adopt-reclaim",
                                crate::terminal::now_ms().max(0) as u64,
                            ) {
                                freshell_freshagent::ownership_lane::TerminalLaneClaim::Granted(
                                    ticket,
                                ) => {
                                    *pending_slot.lock().expect("pending ownership lock") =
                                        Some(PendingOwnershipClaim {
                                            locator: locator.clone(),
                                            ticket,
                                        });
                                    tracing::info!(target: "freshell_ws::auto_resume",
                                        provider = %provider, session_id = %session_id,
                                        create_request_id = %create_request_id,
                                        "auto_resume_adopt_reclaimed: the crashed incumbent's \
                                         release landed — the respawn proceeds under a real \
                                         Granted ticket"
                                    );
                                    coordinator_refused = false;
                                }
                                freshell_freshagent::ownership_lane::TerminalLaneClaim::Refused(
                                    outcome,
                                ) => {
                                    tracing::warn!(target: "freshell_ws::auto_resume",
                                        provider = %provider, session_id = %session_id,
                                        create_request_id = %create_request_id,
                                        outcome = ?outcome,
                                        "auto_resume_adopt_reclaim_refused: the resume aborts"
                                    );
                                }
                                freshell_freshagent::ownership_lane::TerminalLaneClaim::Unwired
                                | freshell_freshagent::ownership_lane::TerminalLaneClaim::Adopt => {
                                }
                            }
                        }
                    }
                }
            }
            if coordinator_refused {
                return false;
            }
            use freshell_terminal::registry::SessionRefClaim;
            // The registry-lease loop's verdict; EVERY false exit drops the
            // parked coordinator ticket (RAII typed fail) at the single tail.
            let acquired = {
                let holder_conn = state.registry.new_connection_id();
                let mut acquired = false;
                'rounds: for round in 0..2u8 {
                    match state.registry.claim_session_ref(
                        &locator,
                        &create_request_id,
                        holder_conn,
                        crate::terminal::now_ms().max(0) as u64,
                    ) {
                        SessionRefClaim::Acquired => {
                            acquired = true;
                            break 'rounds;
                        }
                        SessionRefClaim::BoundElsewhere { .. } | SessionRefClaim::Held { .. } => {
                            break 'rounds;
                        }
                        SessionRefClaim::ExpiredNeedsKill { pid } => {
                            if round == 0
                                && crate::terminal::kill_session_ref_holder_and_confirm(
                                    &state.registry,
                                    pid,
                                )
                                .await
                            {
                                state.registry.force_release_after_confirmed_kill(&locator);
                                continue; // the slot is now free — re-claim
                            }
                            // Unconfirmed kill (or a second expiry): hold the
                            // lease closed and abort, mirroring the ingress.
                            tracing::error!(target: "invariant",
                                provider = %locator.provider,
                                session_id = %locator.session_id,
                                pid,
                                "session_ref_lease_expired_kill_unconfirmed: holding lease closed");
                            break 'rounds;
                        }
                    }
                }
                acquired
            };
            if !acquired {
                drop(pending_slot.lock().expect("pending ownership lock").take());
            }
            acquired
        }
    }

    /// Mirror of the ingress complete==false path (`terminal.rs`): a lease
    /// revoked while spawning means killing OUR OWN just-spawned child via
    /// the registry handle, confirming death, then force-releasing — only
    /// then does `false` go back to the hub. kata b8ke Task 4: on the
    /// registry completion's success the COORDINATOR claim commits
    /// `Live{Terminal}` for the replacement (retained in the registry for
    /// the exit/kill release); on failure the parked ticket drops (typed
    /// fail) and the kill's own release path covers any committed runtime.
    fn complete_claim(
        &self,
        provider: &str,
        session_id: &str,
        create_request_id: &str,
        new_terminal_id: &str,
    ) -> impl std::future::Future<Output = bool> + Send {
        let state = self.state.clone();
        let pending_slot = std::sync::Arc::clone(&self.pending_ownership);
        let pending_attach_guard_slot = std::sync::Arc::clone(&self.pending_attach_guard);
        let locator = session_locator(provider, session_id);
        let create_request_id = create_request_id.to_string();
        let new_terminal_id = new_terminal_id.to_string();
        async move {
            if state.registry.complete_session_ref_claim(
                &locator,
                &create_request_id,
                &new_terminal_id,
            ) {
                // The coordinator winner commit (the ONE settle point for
                // the respawn's claim). A stale/foreign commit means the key
                // was recovered mid-respawn — kill our own child (the
                // registry kill's release covers any partial state) and
                // answer false exactly like the revoked-lease shape.
                let parked = pending_slot.lock().expect("pending ownership lock").take();
                // b8ke ext r13 F2: the Adopt path's held window closes at
                // the settle — the guard dropped here, the replacement's
                // ownership is decided BELOW (the fresh claim).
                drop(
                    pending_attach_guard_slot
                        .lock()
                        .expect("pending attach guard lock")
                        .take(),
                );
                if let Some(mut claim) = parked {
                    // b8ke fence-heal (plan Task 3), r32 F2: capture the
                    // claim ticket's OWN pair BEFORE the consuming commit —
                    // the broadcast below carries THIS pair, never a
                    // re-observed current generation.
                    let owner_operation_id = claim.ticket.operation_id().to_string();
                    let owner_generation = claim.ticket.generation();
                    let outcome = state.registry.commit_session_ref_ownership(
                        &claim.locator,
                        &owner_operation_id,
                        owner_generation,
                        &new_terminal_id,
                    );
                    if !matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
                        tracing::error!(target: "invariant",
                            terminal_id = %new_terminal_id,
                            provider = %locator.provider,
                            session_id = %locator.session_id,
                            outcome = ?outcome,
                            "auto_resume_ownership_commit_stale: the coordinator moved on \
                             while the respawn settled; killing the unowned child"
                        );
                        if stop_unit_replacement(&state, &new_terminal_id, &locator) {
                            return false;
                        }
                        let pid = state.registry.pid_of(&new_terminal_id);
                        state.registry.kill(&new_terminal_id);
                        let confirmed = match pid {
                            Some(pid) => crate::terminal::confirm_pid_dead_within_500ms(pid).await,
                            None => true,
                        };
                        if confirmed {
                            state.registry.force_release_after_confirmed_kill(&locator);
                        }
                        return false;
                    }
                    // b8ke fence-heal (plan Task 3): the respawn settle is a
                    // terminal-lane commit-to-Live — it broadcasts its own
                    // committed pair (r29 F1 invariant / r32 F2 pair) so
                    // every connected client folds the replacement's fresh
                    // fence instead of wedging behind its pre-respawn
                    // observed fence.
                    crate::identity_ownership::broadcast_owner_frame(
                        &state,
                        &claim.locator.provider,
                        &claim.locator.session_id,
                        &new_terminal_id,
                        &owner_operation_id,
                        owner_generation,
                        "handoff-committed",
                    );
                    // b8ke d4 F4: the successful commit consumed the claim —
                    // DISARM the ticket so its Drop (the end of this scope)
                    // does not also perform the typed fail
                    // (`ownership.ticket.dropped_unarmed`/TICKET_DROPPED
                    // would misclassify every successful respawn as an
                    // abandoned claim; the Live record survives the foreign
                    // fail, but the diagnostics noise is false). The stale
                    // arm above keeps the RAII fail (the claim never
                    // committed).
                    claim.ticket.disarm();
                } else {
                    // b8ke ext r13 F2: the ADOPT path now resolves at the
                    // CLAIM (the dead incumbent's release wait + the
                    // re-claimed Granted ticket), so a wired coordinator
                    // reaching the settle with NO parked ticket means the
                    // claim's authority was lost — the replacement is an
                    // unowned live runtime and MUST die (the fail-closed
                    // backstop; never a live unowned runtime beside a
                    // vacant key). Unwired coordinators keep the legacy
                    // proceed.
                    if state.ownership.is_some() {
                        tracing::error!(target: "invariant",
                            terminal_id = %new_terminal_id,
                            provider = %locator.provider,
                            session_id = %locator.session_id,
                            "auto_resume_settle_without_authority: no parked ticket at the \
                             settle — the replacement is unowned and must die"
                        );
                        if stop_unit_replacement(&state, &new_terminal_id, &locator) {
                            return false;
                        }
                        let pid = state.registry.pid_of(&new_terminal_id);
                        state.registry.kill(&new_terminal_id);
                        let confirmed = match pid {
                            Some(pid) => crate::terminal::confirm_pid_dead_within_500ms(pid).await,
                            None => true,
                        };
                        if confirmed {
                            state.registry.force_release_after_confirmed_kill(&locator);
                        }
                        return false;
                    }
                }
                return true;
            }
            if stop_unit_replacement(&state, &new_terminal_id, &locator) {
                return false;
            }
            let pid = state.registry.pid_of(&new_terminal_id);
            state.registry.kill(&new_terminal_id);
            let confirmed = match pid {
                Some(pid) => crate::terminal::confirm_pid_dead_within_500ms(pid).await,
                // No pid handle to probe: the registry kill removed the row;
                // nothing is left to signal, so treat as confirmed.
                None => true,
            };
            if confirmed {
                state.registry.force_release_after_confirmed_kill(&locator);
            } else {
                tracing::error!(target: "invariant",
                    terminal_id = %new_terminal_id,
                    provider = %locator.provider,
                    session_id = %locator.session_id,
                    "session_ref_lease_revoked_child_kill_unconfirmed: holding lease closed");
            }
            false
        }
    }

    /// The headless driver holds no RAII `SessionRefLeaseGuard` (the WS
    /// ingress's failure-path release) — this explicit call IS its
    /// failure-path release. kata b8ke Task 4: the parked coordinator
    /// ticket drops here too (RAII typed fail — no orphan `Starting`).
    fn fail_claim(&self, provider: &str, session_id: &str, create_request_id: &str) {
        // b8ke ext r13 F2: the Adopt path's held window closes on failure
        // too (with the ticket and the lease below).
        let claim: Box<dyn std::any::Any + Send> = Box::new((
            self.pending_ownership
                .lock()
                .expect("pending ownership lock")
                .take(),
            self.pending_attach_guard
                .lock()
                .expect("pending attach guard lock")
                .take(),
            FailSessionRefClaim {
                registry: self.state.registry.clone(),
                locator: session_locator(provider, session_id),
                create_request_id: create_request_id.to_string(),
            },
        ));
        // A replacement given up inside its unit takes the claim and drops
        // it at the unit's Gone; otherwise (nothing was started, or the
        // start already let its relay go) it is released now.
        let relay = self
            .pending_claim_relay
            .lock()
            .expect("pending claim relay lock")
            .take();
        match relay {
            Some(relay) => {
                if let Err(claim) = relay.send(claim) {
                    drop(claim);
                }
            }
            None => drop(claim),
        }
    }

    fn respawn(
        &self,
        req: &RespawnSpec,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send {
        let state = self.state.clone();
        let req = crate::terminal::AgentRespawnRequest {
            mode: req.mode.clone(),
            provider: req.provider.clone(),
            session_id: req.session_id.clone(),
            create_request_id: req.create_request_id.clone(),
            cwd: req.cwd.clone(),
        };
        // This respawn's claim relay (a stale one from an earlier respawn
        // is dropped, so its start stops waiting for it).
        let (relay_tx, relay_rx) = tokio::sync::oneshot::channel();
        let relay_slot = std::sync::Arc::clone(&self.pending_claim_relay);
        drop(relay_slot.lock().expect("pending claim relay lock").take());
        async move {
            let respawned = crate::terminal::respawn_agent_terminal_relaying_claim(
                &state,
                &req,
                Some(relay_rx),
            )
            .await;
            if respawned.is_err() {
                *relay_slot.lock().expect("pending claim relay lock") = Some(relay_tx);
            }
            respawned.map_err(|err| match err {
                crate::terminal::RespawnError::LaunchUnresolvable(msg) => msg,
                crate::terminal::RespawnError::Spawn(io) => io.to_string(),
            })
        }
    }

    fn emit_recovering(
        &self,
        terminal_id: &str,
        mode: &str,
        exit_code: i64,
        attempt: u32,
        max_attempts: u32,
    ) {
        let msg = freshell_protocol::ServerMessage::TerminalStatus(freshell_protocol::TerminalStatus {
            status: freshell_protocol::RuntimeStatus::Recovering,
            terminal_id: terminal_id.to_string(),
            attempt: Some(attempt as i64),
            // The client renders attempt/max/exit from these typed FIELDS;
            // `reason` below is purely presentational and safe to reword
            // (council 7w4h/xkhx: prose must never be protocol).
            max_attempts: Some(max_attempts as i64),
            exit_code: Some(exit_code),
            reason: Some(format!(
                "{mode} crashed (exit {exit_code}) — auto-resuming, attempt {attempt}/{max_attempts}"
            )),
            resume_cycles: None,
        });
        broadcast_frame(&self.state, terminal_id, "recovering", &msg);
    }

    fn emit_replaced(&self, old: &str, new: &str, exit_code: i64, attempt: u32, max_attempts: u32) {
        let msg = freshell_protocol::ServerMessage::TerminalReplaced(
            freshell_protocol::TerminalReplaced {
                old_terminal_id: old.to_string(),
                new_terminal_id: new.to_string(),
                exit_code,
                attempt,
                max_attempts,
            },
        );
        broadcast_frame(&self.state, old, "replaced", &msg);
    }

    fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>) {
        broadcast_settled_frame(&self.state, terminal_id, reason, resume_cycles);
    }

    fn take_cancel(&self, terminal_id: &str) -> bool {
        self.state
            .auto_resume_cancels
            .lock()
            .expect("auto_resume_cancels lock")
            .remove(terminal_id)
    }

    fn log_settled(&self, terminal_id: &str, reason: &str) {
        tracing::info!(terminal_id, reason, "terminal.auto_resume.settled");
    }

    fn retire_identity(&self, terminal_id: &str) {
        // Idempotent (identity.rs:205); the bool is irrelevant here.
        let _ = self.state.identity.retire(terminal_id);
    }
}

/// Build + broadcast the settle frame (`terminal.status status:exited`).
/// The ONE constructor for this frame — used by both the hub driver
/// ([`WsAutoResumeDriver::emit_settled`]) and the WS cancel handler
/// (`terminal::handle_auto_resume_cancel`), so the two paths can never
/// drift in shape or serialize-error policy.
pub(crate) fn broadcast_settled_frame(
    state: &crate::WsState,
    terminal_id: &str,
    reason: &str,
    resume_cycles: Option<u32>,
) {
    let msg = freshell_protocol::ServerMessage::TerminalStatus(freshell_protocol::TerminalStatus {
        status: freshell_protocol::RuntimeStatus::Exited,
        terminal_id: terminal_id.to_string(),
        attempt: None,
        max_attempts: None,
        exit_code: state.registry.exit_code_of(terminal_id),
        reason: Some(reason.to_string()),
        resume_cycles: resume_cycles.map(i64::from),
    });
    broadcast_frame(state, terminal_id, "settled", &msg);
}

/// Serialize + broadcast one auto-resume protocol frame. The ONE home for
/// the serialize/send/log-on-failure policy shared by every emitter in this
/// module (`emit_recovering`, `emit_replaced`, [`broadcast_settled_frame`]),
/// so the paths can never drift. `frame` names the frame kind in the
/// (should-be-impossible) serialize-failure log.
fn broadcast_frame(
    state: &crate::WsState,
    terminal_id: &str,
    frame: &str,
    msg: &freshell_protocol::ServerMessage,
) {
    match serde_json::to_string(msg) {
        Ok(json) => {
            let _ = state.broadcast_tx.send(json);
        }
        Err(err) => {
            tracing::error!(terminal_id, frame, error = %err, "terminal.auto_resume.frame_serialize_failed");
        }
    }
}

/// Spawn the production auto-resume hub (delays from
/// [`auto_resume_delays`] — env-overridable). Wired in
/// `freshell-server/src/main.rs` next to the `spawn_idle_monitor` precedent.
pub fn spawn_auto_resume_hub(
    state: crate::WsState,
    rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
) -> tokio::task::JoinHandle<()> {
    spawn_hub_with_driver(
        WsAutoResumeDriver {
            state,
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        },
        rx,
        HubConfig::from_env(),
    )
}

/// [`spawn_auto_resume_hub`] with explicit backoff AND identity-grace
/// schedules. The harness injects tiny values: it is in-process, so env
/// writes would leak across parallel tests in one binary.
pub fn spawn_auto_resume_hub_with_schedules(
    state: crate::WsState,
    rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    delays: Vec<u64>,
    identity_grace_delays: Vec<u64>,
) -> tokio::task::JoinHandle<()> {
    spawn_hub_with_driver(
        WsAutoResumeDriver {
            state,
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        },
        rx,
        HubConfig::with_schedules(delays, identity_grace_delays),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> CrashContext<'a> {
        CrashContext {
            exit_code: 1,
            mode: "claude",
            create_request_id: Some("cr-1"),
            has_resumable_identity: true,
            lifetime_ms: 5_000,
            prior_attempts: 0,
            cap_exhausted: false,
            recent_cycles: 0,
            max_cycles: AUTO_RESUME_DEFAULT_MAX_CYCLES,
        }
    }
    const DELAYS: [u64; 2] = [2_000, 10_000];

    fn test_cfg(delays: Vec<u64>) -> HubConfig {
        HubConfig {
            delays,
            identity_grace_delays: AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec(),
            healthy_lifetime_ms: AUTO_RESUME_HEALTHY_LIFETIME_MS,
            max_cycles: AUTO_RESUME_DEFAULT_MAX_CYCLES,
            cycle_window_ms: AUTO_RESUME_DEFAULT_CYCLE_WINDOW_MS,
        }
    }

    #[test]
    fn nonzero_agent_exit_resumes_with_schedule() {
        assert_eq!(
            decide(&ctx(), &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::Resume {
                attempt: 1,
                delay_ms: 2_000
            }
        );
        let c = CrashContext {
            prior_attempts: 1,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::Resume {
                attempt: 2,
                delay_ms: 10_000
            }
        );
    }

    #[test]
    fn clean_exit_never_resumes() {
        let c = CrashContext {
            exit_code: 0,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "clean_exit"
            }
        );
    }

    #[test]
    fn shell_mode_never_resumes() {
        let c = CrashContext {
            mode: "shell",
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "not_agent_mode"
            }
        );
        // Unknown future modes are fail-safe too:
        let c = CrashContext {
            mode: "mystery",
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "not_agent_mode"
            }
        );
    }

    #[test]
    fn all_four_agent_modes_are_eligible() {
        for mode in AUTO_RESUME_MODES {
            let c = CrashContext { mode, ..ctx() };
            assert!(
                matches!(
                    decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
                    AutoResumeDecision::Resume { .. }
                ),
                "mode {mode}"
            );
        }
    }

    #[test]
    fn missing_identity_settles_exited_immediately() {
        let c = CrashContext {
            has_resumable_identity: false,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "no_resumable_identity"
            }
        );
        let c = CrashContext {
            create_request_id: None,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "no_create_request_id"
            }
        );
    }

    #[test]
    fn respawn_cap_exhaustion_settles_exited() {
        let c = CrashContext {
            cap_exhausted: true,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "respawn_cap_exhausted"
            }
        );
    }

    #[test]
    fn retries_are_bounded_and_exhaust_loudly() {
        let c = CrashContext {
            prior_attempts: 2,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "retries_exhausted"
            }
        );
    }

    #[test]
    fn healthy_lifetime_resets_the_attempt_counter() {
        // A generation that lived >= 30s means the previous resume was healthy:
        // this crash starts a fresh budget even with prior attempts recorded.
        let c = CrashContext {
            prior_attempts: 2,
            lifetime_ms: AUTO_RESUME_HEALTHY_LIFETIME_MS,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::Resume {
                attempt: 1,
                delay_ms: 2_000
            }
        );
    }

    #[test]
    fn flap_circuit_breaker_settles_when_cycles_reach_max() {
        let c = CrashContext {
            lifetime_ms: i64::MAX, // healthy — attempts would reset
            recent_cycles: 5,
            max_cycles: 5,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::SettleExited {
                reason: "flap_circuit_breaker"
            }
        );
    }

    #[test]
    fn cycles_below_max_still_resume_even_when_healthy_reset_applies() {
        let c = CrashContext {
            lifetime_ms: i64::MAX,
            recent_cycles: 4,
            max_cycles: 5,
            ..ctx()
        };
        assert_eq!(
            decide(&c, &DELAYS, AUTO_RESUME_HEALTHY_LIFETIME_MS),
            AutoResumeDecision::Resume {
                attempt: 1,
                delay_ms: 2_000
            }
        );
    }

    #[test]
    fn delays_env_override_is_parsed_and_bad_values_fall_back() {
        assert_eq!(parse_delays_env("50,100"), Some(vec![50, 100]));
        assert_eq!(parse_delays_env("2000"), Some(vec![2000]));
        assert_eq!(parse_delays_env(""), None);
        assert_eq!(parse_delays_env("fast,slow"), None);
        assert_eq!(parse_delays_env("0"), None); // zero-delay loops are forbidden
    }

    #[test]
    fn identity_grace_env_defaults_and_escape_hatch() {
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = ENV_LOCK.lock().unwrap();
        let prior = std::env::var_os("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS");
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS", v),
                    None => std::env::remove_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS"),
                }
            }
        }
        let _r = Restore(prior);

        std::env::remove_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS");
        assert_eq!(
            auto_resume_identity_grace_delays(),
            AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec()
        );
        std::env::set_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS", "");
        assert!(
            auto_resume_identity_grace_delays().is_empty(),
            "explicit empty value disables the grace (escape hatch)"
        );
        std::env::set_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS", "100,,0");
        assert_eq!(
            auto_resume_identity_grace_delays(),
            AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec(),
            "unparseable output falls back loudly to the default"
        );
        std::env::set_var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS", "100,200");
        assert_eq!(auto_resume_identity_grace_delays(), vec![100, 200]);
    }

    // ---- Task 5: hub orchestration (fake driver, paused tokio time) ----

    use std::sync::{Arc, Mutex};

    fn crash(
        terminal_id: &str,
        exit_code: i64,
        mode: &str,
        create_request_id: Option<&str>,
        lifetime_ms: i64,
    ) -> CrashEvent {
        CrashEvent {
            terminal_id: terminal_id.to_string(),
            exit_code,
            mode: mode.to_string(),
            create_request_id: create_request_id.map(str::to_string),
            lifetime_ms,
            observed_fence: None,
        }
    }

    #[derive(Debug)]
    struct FakeState {
        cap_exhausted: bool,
        session: Option<(String, String, Option<String>)>,
        guard: Option<&'static str>,
        /// Pending user cancels (znhn item 2) — consumed by `take_cancel`.
        cancels: std::collections::HashSet<String>,
        /// Test knob: when true, `respawn` inserts the spec's OLD terminal id
        /// into `cancels` — simulates a user cancel landing DURING the
        /// respawn await, i.e. after the hub's post-sleep take_cancel check
        /// (the leak window the fresh-eyes review flagged).
        insert_cancel_on_respawn: bool,
        claim_ok: bool,
        complete_ok: bool,
        panic_next_recovering: bool,
        respawn_result: Result<String, String>,
        recovering: Vec<(String, u32, u32)>,
        replaced: Vec<(String, String, u32)>,
        respawns: Vec<RespawnSpec>,
        claims: Vec<String>,
        completes: Vec<String>,
        fails: Vec<String>,
        settled: Vec<(String, String)>,
        /// (terminal_id, reason, resume_cycles) — settle FRAMES broadcast
        /// (znhn item 3), distinct from the `settled` log records.
        settled_frames: Vec<(String, String, Option<u32>)>,
        /// Terminal ids retired by the hub's unconditional iteration-tail
        /// retires (delta fix 1) — the restored crash invariant.
        retired: Vec<String>,
        /// Gate-1 hold knobs: request ids whose originating create is still
        /// unanswered (`create_reply_pending`), and the channel a held event
        /// is requeued onto (None = record the requeue but drop the event —
        /// tests that don't drive the hold don't need the loopback).
        unanswered: std::collections::HashSet<String>,
        requeue_tx: Option<tokio::sync::mpsc::UnboundedSender<CrashEvent>>,
        /// Terminal ids the hub requeued through the create-answer hold.
        requeued: Vec<String>,
    }

    /// Records every orchestrator effect; each knob is mutable mid-test so
    /// one hub can be driven through per-event configurations.
    #[derive(Clone)]
    struct FakeDriver {
        inner: Arc<Mutex<FakeState>>,
    }

    impl FakeDriver {
        /// Identity present, cap ok, guard clear, claim ok, respawn -> Ok("t-new").
        fn healthy() -> Self {
            Self {
                inner: Arc::new(Mutex::new(FakeState {
                    cap_exhausted: false,
                    session: Some(("claude".into(), "sess-1".into(), None)),
                    guard: None,
                    cancels: std::collections::HashSet::new(),
                    insert_cancel_on_respawn: false,
                    claim_ok: true,
                    complete_ok: true,
                    panic_next_recovering: false,
                    respawn_result: Ok("t-new".into()),
                    recovering: Vec::new(),
                    replaced: Vec::new(),
                    respawns: Vec::new(),
                    claims: Vec::new(),
                    completes: Vec::new(),
                    fails: Vec::new(),
                    settled: Vec::new(),
                    settled_frames: Vec::new(),
                    retired: Vec::new(),
                    unanswered: std::collections::HashSet::new(),
                    requeue_tx: None,
                    requeued: Vec::new(),
                })),
            }
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
            self.inner.lock().expect("fake driver lock")
        }

        fn set_cap_exhausted(&self, v: bool) {
            self.lock().cap_exhausted = v;
        }
        fn set_session(&self, v: Option<(String, String, Option<String>)>) {
            self.lock().session = v;
        }
        fn set_guard(&self, v: Option<&'static str>) {
            self.lock().guard = v;
        }
        fn set_claim_ok(&self, v: bool) {
            self.lock().claim_ok = v;
        }
        fn set_complete_ok(&self, v: bool) {
            self.lock().complete_ok = v;
        }
        fn set_respawn_result(&self, v: Result<String, String>) {
            self.lock().respawn_result = v;
        }
        fn set_panic_next_recovering(&self, v: bool) {
            self.lock().panic_next_recovering = v;
        }
        fn set_cancelled(&self, terminal_id: &str) {
            self.lock().cancels.insert(terminal_id.to_string());
        }
        fn set_insert_cancel_on_respawn(&self, v: bool) {
            self.lock().insert_cancel_on_respawn = v;
        }
        /// Gate-1 hold: mark this create's reply as still pending (the
        /// create-dedupe InFlight sentinel, faked).
        fn hold_create_reply(&self, create_request_id: &str) {
            self.lock().unanswered.insert(create_request_id.to_string());
        }
        /// Gate-1 hold: the create answered (sentinel Settled/cleared).
        fn answer_create(&self, create_request_id: &str) {
            self.lock().unanswered.remove(create_request_id);
        }
        /// Install the loopback a held event is requeued onto.
        fn install_requeue_tx(&self, tx: tokio::sync::mpsc::UnboundedSender<CrashEvent>) {
            self.lock().requeue_tx = Some(tx);
        }
        /// Terminal ids the hub requeued through the create-answer hold.
        fn requeued(&self) -> Vec<String> {
            self.lock().requeued.clone()
        }
        /// Pending (unconsumed) cancel entries — the leak the fresh-eyes
        /// review flagged: must drain to zero on every settle/replaced tail.
        fn pending_cancels(&self) -> usize {
            self.lock().cancels.len()
        }

        /// (old_terminal_id, attempt, max_attempts)
        fn recovering_calls(&self) -> Vec<(String, u32, u32)> {
            self.lock().recovering.clone()
        }
        /// (old_terminal_id, new_terminal_id, attempt)
        fn replaced_calls(&self) -> Vec<(String, String, u32)> {
            self.lock().replaced.clone()
        }
        fn respawn_calls(&self) -> Vec<RespawnSpec> {
            self.lock().respawns.clone()
        }
        fn claim_calls(&self) -> Vec<String> {
            self.lock().claims.clone()
        }
        fn complete_calls(&self) -> Vec<String> {
            self.lock().completes.clone()
        }
        fn fail_calls(&self) -> Vec<String> {
            self.lock().fails.clone()
        }
        fn settled_reasons(&self) -> Vec<String> {
            self.lock().settled.iter().map(|(_, r)| r.clone()).collect()
        }
        /// (terminal_id, reason, resume_cycles) settle FRAMES (znhn item 3).
        fn settled_frames(&self) -> Vec<(String, String, Option<u32>)> {
            self.lock().settled_frames.clone()
        }
        /// Terminal ids retired by the hub's iteration-tail retires.
        fn retired(&self) -> Vec<String> {
            self.lock().retired.clone()
        }
        /// Retire-call count for ONE terminal id (delta fix 2) — the
        /// discriminating pin a `contains` check cannot express when a tail
        /// retires the same id more than once (pre-recovering retire +
        /// arm-end retire on the mid-backoff revival path).
        fn retired_count_for(&self, terminal_id: &str) -> usize {
            self.lock()
                .retired
                .iter()
                .filter(|t| t == &terminal_id)
                .count()
        }
    }

    impl AutoResumeDriver for FakeDriver {
        fn cap_exhausted(&self, _create_request_id: &str) -> bool {
            self.lock().cap_exhausted
        }
        fn create_reply_pending(&self, create_request_id: &str) -> bool {
            self.lock().unanswered.contains(create_request_id)
        }
        fn requeue_crash_event(&self, ev: CrashEvent) {
            let tx = {
                let mut s = self.lock();
                s.requeued.push(ev.terminal_id.clone());
                s.requeue_tx.clone()
            };
            if let Some(tx) = tx {
                let _ = tx.send(ev);
            }
        }
        fn resumable_session_ref(
            &self,
            _terminal_id: &str,
        ) -> Option<(String, String, Option<String>)> {
            self.lock().session.clone()
        }
        fn pre_respawn_guard(
            &self,
            _provider: &str,
            _session_id: &str,
            _old_terminal_id: &str,
        ) -> Option<&'static str> {
            self.lock().guard
        }
        fn claim_session(
            &self,
            _provider: &str,
            _session_id: &str,
            create_request_id: &str,
            _observed: Option<freshell_ownership::ObservedFence>,
        ) -> impl std::future::Future<Output = bool> + Send {
            let ok = {
                let mut s = self.lock();
                s.claims.push(create_request_id.to_string());
                s.claim_ok
            };
            std::future::ready(ok)
        }
        fn complete_claim(
            &self,
            _provider: &str,
            _session_id: &str,
            create_request_id: &str,
            _new_terminal_id: &str,
        ) -> impl std::future::Future<Output = bool> + Send {
            let ok = {
                let mut s = self.lock();
                s.completes.push(create_request_id.to_string());
                s.complete_ok
            };
            std::future::ready(ok)
        }
        fn fail_claim(&self, _provider: &str, _session_id: &str, create_request_id: &str) {
            self.lock().fails.push(create_request_id.to_string());
        }
        fn respawn(
            &self,
            req: &RespawnSpec,
        ) -> impl std::future::Future<Output = Result<String, String>> + Send {
            let result = {
                let mut s = self.lock();
                s.respawns.push(req.clone());
                if s.insert_cancel_on_respawn {
                    // Simulate a user cancel landing DURING the respawn —
                    // after the hub's post-sleep take_cancel check. The hub
                    // must still clean this entry up on the replaced tail.
                    let old_tid = s
                        .recovering
                        .last()
                        .map(|(tid, _, _)| tid.clone())
                        .unwrap_or_default();
                    s.cancels.insert(old_tid);
                }
                s.respawn_result.clone()
            };
            std::future::ready(result)
        }
        fn emit_recovering(
            &self,
            terminal_id: &str,
            _mode: &str,
            _exit_code: i64,
            attempt: u32,
            max_attempts: u32,
        ) {
            // One-shot injected panic for the supervision test. The flag is
            // consumed and the guard DROPPED before panicking so the mutex is
            // never poisoned for subsequent events.
            let should_panic = {
                let mut s = self.lock();
                if s.panic_next_recovering {
                    s.panic_next_recovering = false;
                    true
                } else {
                    s.recovering
                        .push((terminal_id.to_string(), attempt, max_attempts));
                    false
                }
            };
            if should_panic {
                panic!("test-injected driver panic");
            }
        }
        fn emit_replaced(
            &self,
            old: &str,
            new: &str,
            _exit_code: i64,
            attempt: u32,
            _max_attempts: u32,
        ) {
            self.lock()
                .replaced
                .push((old.to_string(), new.to_string(), attempt));
        }
        fn emit_settled(&self, terminal_id: &str, reason: &str, resume_cycles: Option<u32>) {
            self.lock().settled_frames.push((
                terminal_id.to_string(),
                reason.to_string(),
                resume_cycles,
            ));
        }
        fn take_cancel(&self, terminal_id: &str) -> bool {
            self.lock().cancels.remove(terminal_id)
        }
        fn log_settled(&self, terminal_id: &str, reason: &str) {
            self.lock()
                .settled
                .push((terminal_id.to_string(), reason.to_string()));
        }
        fn retire_identity(&self, terminal_id: &str) {
            self.lock().retired.push(terminal_id.to_string());
        }
    }

    /// Let the hub task run to its next await point (a few yields — the hub's
    /// non-timer awaits are all ready futures, so it runs whole iterations).
    async fn drain() {
        for _ in 0..5u8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn crash_resumes_after_first_backoff_and_emits_frames() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy(); // identity present, cap ok, claim ok, respawn -> Ok("t-new")
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));
        tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000))
            .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
        assert!(fake.respawn_calls().is_empty(), "must wait out the backoff");
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        tokio::task::yield_now().await;
        assert_eq!(fake.respawn_calls().len(), 1);
        assert_eq!(
            fake.replaced_calls(),
            vec![("t1".into(), "t-new".into(), 1u32)]
        );
        // Delta-fix-1: identity was Some from the very first query (a revival
        // landing BEFORE query#1 is hub-level indistinguishable from healthy)
        // — the unconditional pre-emit tail retire must still restore the
        // crash invariant.
        assert!(fake.retired().contains(&"t1".to_string()));
    }

    /// Gate-1 pin (create-answer ordering guard): a crash whose originating
    /// `terminal.create` has not yet answered is HELD — no
    /// recovering/replaced/settled frame may reach the wire before the
    /// `terminal.created` reply that names the terminal, because the client
    /// (and the e2e helper) keys that state by a terminalId it has not
    /// learned yet and silently drops the frame. Other terminals' crashes
    /// keep flowing while the hold is pending, and the held event is
    /// processed — original content intact — once the create answers.
    #[tokio::test(start_paused = true)]
    async fn crash_event_for_an_unanswered_create_is_held_until_the_create_answers() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.hold_create_reply("cr-held");
        fake.install_requeue_tx(tx.clone());
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        // The held terminal's crash arrives FIRST, an unrelated terminal's
        // crash second: the hub must not let the first event block the
        // second (requeue-to-back, not a head-of-line stall). Drive the
        // hub segment by segment under the paused clock: one yield parks it
        // on the hold's first poll sleep, the advance fires that poll, the
        // next yield lets it dequeue t-other and broadcast its recovering
        // (then park on t-other's 2s backoff).
        tx.send(crash("t-held", 1, "claude", Some("cr-held"), 5_000))
            .unwrap();
        tx.send(crash("t-other", 1, "claude", Some("cr-other"), 5_000))
            .unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(std::time::Duration::from_millis(10)).await;
        tokio::task::yield_now().await;

        // (1) The unrelated terminal's resume is in flight (recovering
        // broadcast, backoff pending); the held one broadcast NOTHING and
        // was requeued, never dropped.
        assert_eq!(
            fake.recovering_calls(),
            vec![("t-other".into(), 1u32, 2u32)],
            "the unanswered create's crash must not broadcast; other terminals keep flowing"
        );
        assert!(fake.respawn_calls().is_empty(), "t-other is mid-backoff");
        assert!(fake.requeued().contains(&"t-held".to_string()));

        // (2) The create answers: with t-other's backoff fired, the hub
        // completes t-other's replacement and then processes the HELD
        // event on its next dequeue — original content intact (attempt 1
        // for the ORIGINAL terminal id).
        fake.answer_create("cr-held");
        tokio::time::advance(std::time::Duration::from_millis(2_050)).await;
        tokio::task::yield_now().await;
        assert_eq!(
            fake.replaced_calls(),
            vec![("t-other".into(), "t-new".into(), 1u32)]
        );
        assert!(
            fake.recovering_calls()
                .contains(&("t-held".into(), 1u32, 2u32)),
            "the held crash must be processed once the create answers"
        );
    }

    /// Delta-fix-1: a revival landing DURING the resume backoff (after the
    /// pre-emit retire already ran) is re-retired by the unconditional retire
    /// at the resume arm's END — the mid-sleep revival family the
    /// `identity_revived` flag never observed.
    #[tokio::test(start_paused = true)]
    async fn mid_backoff_identity_revival_is_re_retired_at_the_arm_end() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy(); // identity Some from the start
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000))
            .unwrap();
        drain().await;
        assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
        // Second "revival" upsert lands while the hub is parked in the
        // backoff sleep.
        fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 1);
        assert_eq!(
            fake.replaced_calls(),
            vec![("t1".into(), "t-new".into(), 1u32)]
        );
        assert_eq!(
            fake.retired_count_for("t1"),
            2,
            "pre-recovering retire + arm-end retire"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn second_crash_uses_second_delay_then_exhausts() {
        // crash cr-1 (lifetime 1s) -> attempt 1 @2s; crash again -> attempt 2 @10s;
        // crash again -> settled("retries_exhausted"), NO third respawn.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 1);

        tx.send(crash("t-new", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        assert_eq!(
            fake.recovering_calls(),
            vec![("t1".into(), 1u32, 2u32), ("t-new".into(), 2u32, 2u32)]
        );
        // The first delay is NOT enough for attempt 2.
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(
            fake.respawn_calls().len(),
            1,
            "attempt 2 waits the full 10s"
        );
        tokio::time::advance(std::time::Duration::from_millis(8_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 2);

        tx.send(crash("t-new2", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        assert_eq!(
            fake.respawn_calls().len(),
            2,
            "budget exhausted: no third respawn"
        );
        assert_eq!(
            fake.settled_reasons(),
            vec!["retries_exhausted".to_string()]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn healthy_generation_resets_attempts() {
        // two crashes (attempts 1,2), then a crash with lifetime_ms = 60_000:
        // attempt resets to 1 with the first delay again.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        tx.send(crash("t2", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(10_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 2);

        // Healthy generation (>= 30s): fresh budget, attempt 1, first delay.
        tx.send(crash("t3", 1, "claude", Some("cr-1"), 60_000))
            .unwrap();
        drain().await;
        assert_eq!(
            fake.recovering_calls(),
            vec![
                ("t1".into(), 1u32, 2u32),
                ("t2".into(), 2u32, 2u32),
                ("t3".into(), 1u32, 2u32)
            ]
        );
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn live_session_owner_aborts_resume_silently() {
        // pre_respawn_guard -> Some("session_owned_live") (user already relaunched):
        // no respawn, no claim, settled("session_owned_live").
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_guard(Some("session_owned_live"));
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert!(fake.respawn_calls().is_empty());
        assert!(fake.claim_calls().is_empty());
        assert_eq!(
            fake.settled_reasons(),
            vec!["session_owned_live".to_string()]
        );
        // znhn #3: even the "silent" guard-abort broadcasts the settle frame.
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "session_owned_live".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn pane_closed_during_backoff_settles_pane_closed() {
        // pre_respawn_guard -> Some("pane_closed") (ledger binding retired during
        // the backoff): no respawn, no claim, settled("pane_closed").
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        // The pane is closed DURING the backoff — the guard runs after it.
        fake.set_guard(Some("pane_closed"));
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert!(fake.respawn_calls().is_empty());
        assert!(fake.claim_calls().is_empty());
        assert_eq!(fake.settled_reasons(), vec!["pane_closed".to_string()]);
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "pane_closed".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lost_lease_claim_aborts_resume() {
        // claim_session -> false: no respawn, settled("session_lease_held").
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_claim_ok(false);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.claim_calls(), vec!["cr-1".to_string()]);
        assert!(fake.respawn_calls().is_empty());
        assert_eq!(
            fake.settled_reasons(),
            vec!["session_lease_held".to_string()]
        );
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "session_lease_held".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn failed_respawn_settles_loudly() {
        // respawn -> Err("spawn failed"): fail_claim called (NOT complete_claim),
        // settled("respawn_failed").
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_respawn_result(Err("spawn failed".into()));
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 1);
        assert_eq!(fake.fail_calls(), vec!["cr-1".to_string()]);
        assert!(fake.complete_calls().is_empty());
        assert_eq!(fake.settled_reasons(), vec!["respawn_failed".to_string()]);
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "respawn_failed".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn lost_lease_completion_settles_without_replaced_frame() {
        // respawn -> Ok("t-new") but complete_claim -> false (binding raced away;
        // production driver kills its own child before returning false):
        // NO terminal.replaced emitted, settled("lease_completion_lost").
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_complete_ok(false);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 1);
        assert_eq!(fake.complete_calls(), vec!["cr-1".to_string()]);
        assert!(fake.replaced_calls().is_empty());
        assert!(
            fake.fail_calls().is_empty(),
            "completion loss is NOT fail_claim"
        );
        assert_eq!(
            fake.settled_reasons(),
            vec!["lease_completion_lost".to_string()]
        );
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "lease_completion_lost".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cap_exhausted_and_no_identity_and_clean_and_shell_settle_without_respawn() {
        // four events: cap_exhausted=true / resumable_session_ref=None /
        // exit_code=0 / mode="shell" — zero respawn calls, zero recovering frames.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(
            fake.clone(),
            rx,
            HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]),
        );

        fake.set_cap_exhausted(true);
        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;

        fake.set_cap_exhausted(false);
        fake.set_session(None);
        tx.send(crash("t2", 1, "claude", Some("cr-2"), 1_000))
            .unwrap();
        drain().await;
        // Identity grace (kata kmbs): t2's no_resumable_identity settle is no
        // longer one-shot — identity stays absent through the WHOLE two-step
        // grace before the settle lands. (t1's cap-exhausted settle frame is
        // already in the list; the intermediate assertions are t2-scoped.)
        assert!(
            !fake.settled_frames().iter().any(|(t, _, _)| t == "t2"),
            "the grace must run before t2 settles: {:?}",
            fake.settled_frames()
        );
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert!(
            !fake.settled_frames().iter().any(|(t, _, _)| t == "t2"),
            "t2's second grace step is still pending: {:?}",
            fake.settled_frames()
        );
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert!(
            fake.settled_frames().contains(&(
                "t2".to_string(),
                "no_resumable_identity".to_string(),
                None
            )),
            "grace exhausted: t2 settles no_resumable_identity"
        );

        fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
        tx.send(crash("t3", 0, "claude", Some("cr-3"), 1_000))
            .unwrap();
        tx.send(crash("t4", 1, "shell", Some("cr-4"), 1_000))
            .unwrap();
        drain().await;

        assert!(fake.respawn_calls().is_empty());
        assert!(fake.recovering_calls().is_empty());
        assert!(fake.claim_calls().is_empty());
        // znhn #3: agent-mode settles are LOUD (frame emitted), shell is not.
        assert_eq!(
            fake.settled_frames(),
            vec![
                ("t1".to_string(), "respawn_cap_exhausted".to_string(), None),
                ("t2".to_string(), "no_resumable_identity".to_string(), None),
                ("t3".to_string(), "clean_exit".to_string(), None),
            ],
            "shell-mode settles must NOT emit a settle frame"
        );
    }

    /// Kata kmbs (primary RED pin): identity landing mid-grace converts the
    /// previously one-shot `no_resumable_identity` settle into a normal
    /// resume. Per-step `advance` + `drain`: paused-clock `advance` wakes
    /// only timers ALREADY scheduled, so each grace step gets its own
    /// advance.
    #[tokio::test(start_paused = true)]
    async fn identity_arriving_during_grace_converts_no_identity_settle_into_resume() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_session(None); // identity absent at crash-decision time
        let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000))
            .unwrap();
        drain().await;
        assert!(fake.settled_frames().is_empty(), "no settle during grace");
        assert!(
            fake.recovering_calls().is_empty(),
            "no recover before identity"
        );

        // Grace step 1 elapses with no identity: re-check sees None, loop holds.
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert!(fake.settled_frames().is_empty());
        assert!(fake.recovering_calls().is_empty());

        // Identity lands before grace step 2 completes.
        fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
        assert!(
            fake.respawn_calls().is_empty(),
            "resume backoff still respected"
        );
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(
            fake.replaced_calls(),
            vec![("t1".into(), "t-new".into(), 1u32)]
        );
        assert!(fake.settled_frames().is_empty(), "no exited settle at all");
        // The crash invariant — dead terminal's identity retired — is restored:
        assert!(fake.retired().contains(&"t1".to_string()));
    }

    /// Kata kmbs: grace exhaustion still settles loudly — the SAME
    /// `no_resumable_identity` frame as pre-grace behavior, bounded-late.
    #[tokio::test(start_paused = true)]
    async fn no_identity_after_grace_exhaustion_settles_exited_loudly() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_session(None); // stays None for the whole grace
        let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        tx.send(crash("t2", 1, "claude", Some("cr-2"), 1_000))
            .unwrap();
        drain().await;
        assert!(fake.settled_frames().is_empty(), "grace must run first");
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert!(
            fake.settled_frames().is_empty(),
            "second grace step pending"
        );
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert_eq!(
            fake.settled_frames(),
            vec![("t2".to_string(), "no_resumable_identity".to_string(), None)]
        );
        assert!(fake.respawn_calls().is_empty());
        // Delta-fix-1: the exhaustion tail retires unconditionally — a
        // revival slipping in between the final recheck and the tail (or a
        // cancel/settle tail that never set the old flag) cannot leak the
        // dead terminal into live-only lookups.
        assert!(fake.retired().contains(&"t2".to_string()));
    }

    /// Grace eligibility gate — clean exit, shell mode, AND missing
    /// create_request_id all settle IMMEDIATELY (no grace sleeps).
    #[tokio::test(start_paused = true)]
    async fn non_identity_settles_skip_the_grace_entirely() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        tx.send(crash("t3", 0, "claude", Some("cr-3"), 1_000))
            .unwrap(); // clean_exit
        tx.send(crash("t4", 1, "shell", Some("cr-4"), 1_000))
            .unwrap(); // not_agent_mode (silent)
        tx.send(crash("t5", 1, "claude", None, 1_000)).unwrap(); // no_create_request_id
        drain().await; // NO time advance — ineligible settles must already have happened
        assert_eq!(
            fake.settled_frames(),
            vec![
                ("t3".to_string(), "clean_exit".to_string(), None),
                ("t5".to_string(), "no_create_request_id".to_string(), None),
            ],
            "shell settles silently; both non-identity settles are grace-free"
        );
    }

    /// Kata kmbs: cancel during grace settles loudly at a grace-step
    /// boundary (ordering under paused time: the crash event must be drained
    /// into the hub BEFORE the cancel is seeded, so the hub is parked inside
    /// its first grace sleep).
    #[tokio::test(start_paused = true)]
    async fn cancel_during_grace_settles_cancelled_and_skips_further_rechecks() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_session(None);
        let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        tx.send(crash("t6", 1, "claude", Some("cr-6"), 1_000))
            .unwrap();
        drain().await; // hub is now parked in grace sleep #1
                       // Cancel AND identity revival land in the same grace sleep (the race
                       // round-3 flagged): both must be handled — cancelled settle AND
                       // re-retire, never a live leftover.
        fake.set_cancelled("t6");
        fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert_eq!(
            fake.settled_frames(),
            vec![(
                "t6".to_string(),
                super::SETTLE_REASON_CANCELLED.to_string(),
                None
            )]
        );
        assert!(
            fake.retired().contains(&"t6".to_string()),
            "identity revived during the cancelled sleep must be re-retired"
        );
        // Neither a further identity nor further steps resurrect anything:
        tokio::time::advance(std::time::Duration::from_millis(5_000)).await;
        drain().await;
        assert!(fake.recovering_calls().is_empty());
        assert!(fake.respawn_calls().is_empty());
    }

    /// Review-round-2 pin: a grace-revived identity is re-retired even when
    /// the decision is a SETTLE (cap exhausted at decision time).
    #[tokio::test(start_paused = true)]
    async fn grace_revived_identity_is_re_retired_even_on_settle_outcomes() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_cap_exhausted(true); // settle, not resume, after revival
        fake.set_session(None);
        let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        tx.send(crash("t7", 1, "claude", Some("cr-7"), 5_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
        tokio::time::advance(std::time::Duration::from_millis(500)).await;
        drain().await;
        assert!(fake.respawn_calls().is_empty(), "cap was exhausted");
        assert_eq!(
            fake.settled_frames(),
            vec![("t7".to_string(), "respawn_cap_exhausted".to_string(), None)]
        );
        // The revived identity did NOT leak into live-only registry lookups:
        assert!(fake.retired().contains(&"t7".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn flap_loop_trips_the_circuit_breaker_and_settles_loud() {
        // 3 healthy flap cycles (lifetime >= healthy: attempts reset each
        // time — pre-breaker this loops forever), then crash #4 must settle
        // with the breaker reason + typed cycle count, and respawn nothing.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let cfg = HubConfig {
            max_cycles: 3,
            healthy_lifetime_ms: 1,
            ..test_cfg(vec![2_000, 10_000])
        };
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        for _ in 0..3 {
            tx.send(crash("t1", 1, "claude", Some("cr-1"), 60_000))
                .unwrap();
            drain().await;
            tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
            drain().await;
        }
        assert_eq!(fake.respawn_calls().len(), 3);

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 60_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 3, "no 4th respawn");
        assert_eq!(
            fake.settled_frames().last().unwrap(),
            &(
                "t1".to_string(),
                "flap_circuit_breaker".to_string(),
                Some(3)
            )
        );
        assert_eq!(
            fake.recovering_calls().len(),
            3,
            "no recovering frame for the breaker settle"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cycle_window_prunes_old_cycles_and_the_loop_may_continue() {
        // max_cycles 2, cycle_window_ms 1 — every prior cycle is stale
        // (wall-clock) by the time the next crash arrives, so the breaker
        // never trips: 4 crash/resume rounds all succeed.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let cfg = HubConfig {
            max_cycles: 2,
            cycle_window_ms: 1,
            healthy_lifetime_ms: 1,
            ..test_cfg(vec![2_000, 10_000])
        };
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        for _ in 0..4 {
            // Real (not virtual) sleep: cycle timestamps are wall-clock, so
            // >1ms of real time must pass for the window to prune them.
            std::thread::sleep(std::time::Duration::from_millis(10));
            tx.send(crash("t1", 1, "claude", Some("cr-1"), 60_000))
                .unwrap();
            drain().await;
            tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
            drain().await;
        }
        assert_eq!(fake.respawn_calls().len(), 4, "breaker must never trip");
        assert_eq!(fake.replaced_calls().len(), 4);
        assert!(fake.settled_frames().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn healthy_generations_reset_attempts_but_never_cycles() {
        // Healthy crashes reset the attempt budget (each resume is attempt 1)
        // while the cycle record accumulates and trips the breaker at max.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let cfg = HubConfig {
            max_cycles: 2,
            ..test_cfg(vec![2_000, 10_000])
        };
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        // Fast-fail crash: attempt 1.
        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        // Healthy crash: attempts reset — attempt 1 again (not 2).
        tx.send(crash("t2", 1, "claude", Some("cr-1"), 60_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(
            fake.recovering_calls(),
            vec![("t1".into(), 1u32, 2u32), ("t2".into(), 1u32, 2u32)]
        );
        assert_eq!(fake.respawn_calls().len(), 2);

        // Two successful resumes accumulated DESPITE the healthy reset:
        // crash #3 trips the breaker.
        tx.send(crash("t3", 1, "claude", Some("cr-1"), 60_000))
            .unwrap();
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 2, "breaker blocks the 3rd");
        assert_eq!(
            fake.settled_frames().last().unwrap(),
            &(
                "t3".to_string(),
                "flap_circuit_breaker".to_string(),
                Some(2)
            )
        );
    }

    #[tokio::test(start_paused = true)]
    async fn eviction_and_decide_agree_on_the_configured_healthy_lifetime() {
        // Between-thresholds pin (validated A8): cfg.healthy_lifetime_ms =
        // 500, generation lifetime 1_000ms — ABOVE the config but BELOW the
        // 30_000 compile-time const. Both the decide-time reset AND the
        // eviction branch must treat this as healthy. 60_000 lifetimes
        // CANNOT detect a const/cfg split — this one can.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let cfg = HubConfig {
            max_cycles: 100,
            healthy_lifetime_ms: 500,
            ..test_cfg(vec![2_000, 10_000])
        };
        let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

        // Two fast-fail crashes drain the budget to attempt 2.
        tx.send(crash("t1", 1, "claude", Some("cr-1"), 100))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        tx.send(crash("t2", 1, "claude", Some("cr-1"), 100))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(10_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 2);

        // Between-thresholds crash: healthy per CFG (1_000 >= 500) — decide
        // must reset to attempt 1, NOT settle retries_exhausted (which the
        // 30_000 const would produce).
        tx.send(crash("t3", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 3);

        // Eviction-branch pin: a between-thresholds SETTLE must reset the
        // attempts entry (cfg agreement), so the NEXT fast crash is attempt 1.
        fake.set_cap_exhausted(true);
        tx.send(crash("t4", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        fake.set_cap_exhausted(false);
        tx.send(crash("t5", 1, "claude", Some("cr-1"), 100))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(
            fake.recovering_calls(),
            vec![
                ("t1".into(), 1u32, 2u32),
                ("t2".into(), 2u32, 2u32),
                ("t3".into(), 1u32, 2u32),
                ("t5".into(), 1u32, 2u32),
            ],
            "t5 must start a fresh budget: the eviction branch reset attempts on t4's settle"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn user_cancel_during_backoff_aborts_the_respawn_and_settles_loud() {
        // Crash schedules a resume; the cancel lands during the backoff.
        // The hub must consume the flag, respawn NOTHING, and EMIT the
        // settle frame itself (D-4, validated A5): the take_cancel arm is
        // loud so a late-consumed or pre-seeded cancel can never strand a
        // recovering notice. Idempotent with the WS handler's immediate
        // frame — the client folds duplicates.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        // Pre-seed the cancel BEFORE the crash event (the flag is checked
        // post-sleep, so a pre-seeded flag exercises the late-consume path).
        fake.set_cancelled("t1");
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert!(fake.respawn_calls().is_empty(), "cancel aborts the respawn");
        assert!(fake.claim_calls().is_empty());
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "auto-resume cancelled".to_string(), None)]
        );
        assert_eq!(fake.settled_reasons(), vec!["user_cancelled".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_for_a_settling_terminal_is_cleaned_up_not_leaked() {
        // Fresh-eyes fix: a cancel whose terminal settles WITHOUT reaching
        // the post-sleep take_cancel check (here: decide settles on
        // cap_exhausted, no Resume arm at all) must still be removed from
        // the set — "removed on consumption" has to hold on every path.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_cap_exhausted(true);
        fake.set_cancelled("t1");
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        assert_eq!(
            fake.settled_frames(),
            vec![("t1".to_string(), "respawn_cap_exhausted".to_string(), None)]
        );
        assert_eq!(
            fake.pending_cancels(),
            0,
            "the stale cancel entry must be cleaned up on the settle tail"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_landing_during_the_respawn_is_cleaned_up_on_the_replaced_tail() {
        // Fresh-eyes fix: a cancel that lands AFTER the hub's post-sleep
        // take_cancel check (simulated: inserted during the respawn await)
        // used to leak in auto_resume_cancels forever. The replaced tail
        // must remove it. (It is too late to abort — the resume already
        // happened — so cleanup, not abort, is the correct semantics.)
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_insert_cancel_on_respawn(true);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        assert_eq!(fake.replaced_calls().len(), 1, "the resume completed");
        assert_eq!(
            fake.pending_cancels(),
            0,
            "the late cancel entry must be cleaned up on the replaced tail"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn guard_abort_emits_a_settle_frame() {
        // pane_closed guard-abort must broadcast the settle frame so the
        // client clears the recovering notice deterministically (znhn #3).
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        fake.set_guard(Some("pane_closed"));
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        let settled = fake.settled_frames();
        assert_eq!(
            settled,
            vec![("t1".to_string(), "pane_closed".to_string(), None)]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retries_exhausted_emits_a_settle_frame() {
        // Same shape as second_crash_uses_second_delay_then_exhausts: after
        // the budget drains, the final crash must broadcast a settle frame.
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![2_000, 10_000]));

        tx.send(crash("t1", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
        drain().await;
        tx.send(crash("t-new", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        tokio::time::advance(std::time::Duration::from_millis(10_000)).await;
        drain().await;
        assert_eq!(fake.respawn_calls().len(), 2);

        tx.send(crash("t-new2", 1, "claude", Some("cr-1"), 1_000))
            .unwrap();
        drain().await;
        let settled = fake.settled_frames();
        assert!(
            settled
                .iter()
                .any(|(t, r, _)| t == "t-new2" && r == "retries_exhausted"),
            "exhaustion must be a LOUD settle frame: {settled:?}"
        );
    }

    /// Council MEDIUM fix (crusty, 7w4h/xkhx review): a driver panic must not
    /// silently end auto-resume forever — that would reinstate the exact
    /// incident this feature exists to prevent (a crashed pane sitting grey
    /// for hours). The hub is supervised: the panic is caught, logged ERROR,
    /// and the loop restarted after a bounded backoff, with the crash-event
    /// receiver surviving the restart.
    ///
    /// Real time (not start_paused): the supervision backoff is a real sleep.
    #[tokio::test(flavor = "multi_thread")]
    async fn hub_survives_driver_panic_and_processes_subsequent_crashes() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = FakeDriver::healthy();
        fake.set_panic_next_recovering(true);
        let _hub = spawn_hub_with_driver(fake.clone(), rx, test_cfg(vec![10]));

        // Event 1: the driver panics mid-processing (inside emit_recovering).
        tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000))
            .unwrap();
        // Event 2: must still be processed by the restarted hub body.
        tx.send(crash("t2", 1, "claude", Some("cr-2"), 5_000))
            .unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let respawned: Vec<String> = fake
                .respawn_calls()
                .iter()
                .map(|r| r.create_request_id.clone())
                .collect();
            if respawned.contains(&"cr-2".to_string()) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "hub never recovered from the driver panic: respawns={respawned:?}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    // ── b8ke ext r13 F2: the crash-recovery Adopt path retains authority ─────

    /// The F2 fixture: a WsState with the coordinator wired into both the
    /// state and the registry, plus the real production driver.
    fn ownership_state() -> (
        crate::WsState,
        std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) {
        let auth_token = std::sync::Arc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let ownership = std::sync::Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry = freshell_terminal::TerminalRegistry::new()
            .with_ownership(std::sync::Arc::clone(&ownership));
        let state = crate::WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            terminal_meta: Default::default(),
            identity: crate::identity::TerminalIdentityRegistry::new(),
            auth_token: std::sync::Arc::clone(&auth_token),
            server_instance_id: std::sync::Arc::new("srv-1111".to_string()),
            boot_id: std::sync::Arc::new("boot-2222".to_string()),
            settings: std::sync::Arc::new(crate::test_settings()),
            handshake_settings: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::test_settings(),
            )),
            broadcast_tx: std::sync::Arc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                std::sync::Arc::clone(&auth_token),
                std::sync::Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(std::sync::Arc::clone(
                &broadcast_tx,
            )),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, broadcast_tx.clone()),
            ),
            registry,
            shutdown: std::sync::Arc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(broadcast_tx),
            subagent_interest: Default::default(),
            host_stats: Default::default(),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: std::sync::Arc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: std::sync::Arc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: std::sync::Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: None,
            codex_locator: None,
            activity: None,
            session_existence: std::sync::Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
            ownership: Some(std::sync::Arc::clone(&ownership)),
            units: Default::default(),
        };
        (state, ownership)
    }

    fn spawn_real_shell_row(state: &crate::WsState, tid: &str, mode: &str) {
        let spec = freshell_platform::build_spawn_spec(
            freshell_platform::ShellType::System,
            freshell_platform::detect::HostOs::Linux,
            false,
            Some("/tmp"),
            &freshell_platform::RealEnv,
            &freshell_platform::RealFileProbe,
            &std::collections::BTreeMap::new(),
            None,
            None,
        );
        state
            .registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                tid.to_string(),
                format!("stream-{tid}"),
                mode,
                None,
                None,
                None,
                None,
            )
            .expect("spawn a real shell row for the test PTY");
    }

    /// A failed respawn whose replacement start was given up inside its
    /// unit receives the hub's claim through the start's relay:
    /// `fail_claim` hands the coordinator ticket and the sessionRef lease
    /// over instead of releasing them, so the conversation stays held until
    /// that start drops them (at its unit's Gone). With no start waiting,
    /// `fail_claim` releases at once (Task 12 review M1, the respawn path).
    #[tokio::test(flavor = "multi_thread")]
    async fn fail_claim_hands_the_claim_to_a_given_up_respawn_start() {
        let (state, ownership) = ownership_state();
        let driver = WsAutoResumeDriver {
            state: state.clone(),
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        };
        let locator = freshell_protocol::SessionLocator {
            provider: "codex".to_string(),
            session_id: "ses-relay".to_string(),
        };
        let lease_free = || match state
            .registry
            .claim_session_ref(&locator, "crq-probe", 0, 1_000)
        {
            freshell_terminal::registry::SessionRefClaim::Acquired => {
                state.registry.fail_session_ref_claim(&locator, "crq-probe");
                true
            }
            _ => false,
        };
        let starting = || {
            matches!(
                ownership.observe("codex", "ses-relay").state,
                freshell_ownership::OwnershipState::Starting { .. }
            )
        };

        // A start given up inside its unit waits on the relay.
        assert!(
            driver
                .claim_session("codex", "ses-relay", "crq-relay", None)
                .await
        );
        assert!(starting() && !lease_free(), "the hub holds the claim");
        let (relay_tx, relay_rx) = tokio::sync::oneshot::channel();
        *driver.pending_claim_relay.lock().unwrap() = Some(relay_tx);
        driver.fail_claim("codex", "ses-relay", "crq-relay");
        assert!(
            starting() && !lease_free(),
            "handed to the given-up start, the claim is still held"
        );
        let claim = relay_rx.await.expect("the claim reached the start");
        drop(claim); // the start's unit is Gone
        assert!(
            matches!(
                ownership.observe("codex", "ses-relay").state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "released when the start drops it"
        );
        assert!(lease_free(), "the lease is released with it");

        // Nothing waits: released at once.
        assert!(
            driver
                .claim_session("codex", "ses-relay", "crq-relay-2", None)
                .await
        );
        assert!(starting());
        driver.fail_claim("codex", "ses-relay", "crq-relay-2");
        assert!(matches!(
            ownership.observe("codex", "ses-relay").state,
            freshell_ownership::OwnershipState::Vacant
        ));
        assert!(lease_free());
    }

    /// b8ke ext r13 F2: the crash-recovery Adopt path retains authority
    /// through spawn/commit. The claim Adopts a live same-kind incumbent
    /// whose ROW IS DEAD (the crash shape — the watcher's ownership
    /// release trails the crash event); the claim's Adopt resolution
    /// WAITS for the imminent release and RE-CLAIMS into a real Granted
    /// ticket, which complete_claim commits: the replacement becomes the
    /// Live{Terminal} owner. Pre-r13 the Adopt path stored NO ticket and
    /// complete_claim committed NOTHING — the replacement stayed live
    /// while the key sat Vacant (a Fresh Agent could claim the session
    /// and become a second writer).
    #[tokio::test(flavor = "multi_thread")]
    async fn the_adopt_crash_recovery_commits_the_replacement_after_the_incumbent_vanishes() {
        let (state, ownership) = ownership_state();
        let driver = WsAutoResumeDriver {
            state: state.clone(),
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        };
        let sid = "ses-r13-f2-adopt".to_string();
        spawn_real_shell_row(&state, "t-incumbent", "claude");
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "claude",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-incumbent",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            state.registry.seed_live_session_ref_ownership_for_test(
                &freshell_protocol::SessionLocator {
                    provider: "claude".to_string(),
                    session_id: sid.clone(),
                },
                "op-incumbent",
                generation,
                "t-incumbent",
            ),
            freshell_ownership::CommitOutcome::Committed
        );

        // The crash shape: the incumbent's ROW dies (its ownership release
        // trails — scheduled to land shortly after the claim starts).
        state.registry.kill("t-incumbent");
        let delayed_release = {
            let ownership = std::sync::Arc::clone(&ownership);
            let sid = sid.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                ownership.release(
                    "claude",
                    &sid,
                    &freshell_ownership::ReleaseClaim {
                        operation_id: "op-incumbent".to_string(),
                        generation,
                        runtime: Some(freshell_ownership::OwnerIdentity {
                            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                            terminal_id: Some("t-incumbent".into()),
                            live_session_key: None,
                            pid: None,
                            ownership_id: None,
                            unit_id: None,
                            hold: freshell_ownership::HoldKind::Main,
                        }),
                    },
                    "test",
                );
            })
        };

        // THE CLAIM: Adopt (the release has not landed yet) → the
        // resolution waits → the release lands → the re-claim GRANTS →
        // the ticket parks. Returns true under held authority.
        assert!(
            driver
                .claim_session("claude", &sid, "req-r13-f2", None)
                .await,
            "the Adopt claim re-claims into a Granted ticket"
        );

        // The replacement spawns (a real row) and the settle commits the
        // parked ticket.
        spawn_real_shell_row(&state, "t-replacement", "claude");
        assert!(
            driver
                .complete_claim("claude", &sid, "req-r13-f2", "t-replacement")
                .await,
            "the settle succeeds under the held authority"
        );

        // THE CONTRACT: the replacement is the committed Live owner —
        // never a live unowned runtime beside a vacant key (pre-r13 the
        // key stayed Vacant here).
        match ownership.observe("claude", &sid).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::Terminal);
                assert_eq!(owner.terminal_id.as_deref(), Some("t-replacement"));
            }
            other => panic!("the replacement must commit Live(Terminal) — got {other:?}"),
        }
        state.registry.kill("t-replacement");
        let _ = delayed_release.await;
    }

    /// b8ke fence-heal (plan Task 3): the respawn settle is a terminal-lane
    /// commit-to-Live — it must BROADCAST its own committed (epoch,
    /// generation) pair (the r29 F1 "every ownership transition broadcasts"
    /// invariant; r32 F2: the pair captured from the claim ticket BEFORE
    /// the consuming commit, never a re-observed current generation).
    /// Pre-Task-3 the settle committed Live with NO broadcast, so every
    /// connected client kept its pre-respawn observed fence and later
    /// lifecycle controls against the replacement were refused typed
    /// until a reload or an unrelated transition supplied one.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_completed_respawn_claim_broadcasts_its_committed_owner_pair() {
        let (state, ownership) = ownership_state();
        let driver = WsAutoResumeDriver {
            state: state.clone(),
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        };
        let sid = "ses-fenceheal-t3-respawn".to_string();
        // The broadcast receiver subscribed BEFORE the commit (the shared
        // bus every connected client folds owner frames from).
        let mut rx = state.broadcast_tx.subscribe();

        // The claim: a vacant key GRANTS and parks the ticket (the
        // ordinary crash-recovery shape — no incumbent to Adopt).
        assert!(
            driver
                .claim_session("claude", &sid, "req-fenceheal-t3", None)
                .await,
            "the vacant-key claim parks the Granted ticket"
        );
        // The ticket's committed generation: the Granted claim's Starting
        // record generation — the exact pair the settle's commit consumes.
        let committed_generation = ownership.observe("claude", &sid).generation;

        // The replacement spawns (a real row) and the settle commits the
        // parked ticket.
        spawn_real_shell_row(&state, "t-fenceheal-t3-replacement", "claude");
        assert!(
            driver
                .complete_claim(
                    "claude",
                    &sid,
                    "req-fenceheal-t3",
                    "t-fenceheal-t3-replacement"
                )
                .await,
            "the settle succeeds under the held authority"
        );

        // THE CONTRACT: the commit's own pair rode the bus — same drain
        // discipline as identity_ownership's race tests.
        let mut owner_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).expect("bus json");
            if frame["type"] == "session.runtimeOwner"
                && frame["sessionId"] == serde_json::json!(sid)
            {
                owner_frame = Some(frame);
            }
        }
        let frame = owner_frame.expect("the respawn settle broadcast its committed owner pair");
        assert_eq!(frame["ownerKind"], serde_json::json!("terminal"));
        assert_eq!(frame["transition"], serde_json::json!("handoff-committed"));
        assert_eq!(frame["generation"], serde_json::json!(committed_generation));
        assert_eq!(frame["epoch"], serde_json::json!(ownership.boot_epoch()));
        assert_eq!(
            frame["terminalId"],
            serde_json::json!("t-fenceheal-t3-replacement")
        );
        state.registry.kill("t-fenceheal-t3-replacement");
    }

    /// b8ke ext r13 F2: the losing shape — the incumbent's row is still
    /// RUNNING at the claim (a genuinely live terminal owns the session).
    /// The resume ABORTS typed — never a second writer — and nothing
    /// spawns.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_adopt_crash_recovery_aborts_typed_beside_a_live_incumbent() {
        let (state, ownership) = ownership_state();
        let driver = WsAutoResumeDriver {
            state: state.clone(),
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        };
        let sid = "ses-r13-f2-adopt-live".to_string();
        spawn_real_shell_row(&state, "t-incumbent-live", "claude");
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "claude",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-incumbent-live",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            state.registry.seed_live_session_ref_ownership_for_test(
                &freshell_protocol::SessionLocator {
                    provider: "claude".to_string(),
                    session_id: sid.clone(),
                },
                "op-incumbent-live",
                generation,
                "t-incumbent-live",
            ),
            freshell_ownership::CommitOutcome::Committed
        );

        // THE CLAIM: Adopt with a RUNNING incumbent → aborts typed
        // (pre-r13 it proceeded and spawned a second writer).
        assert!(
            !driver
                .claim_session("claude", &sid, "req-r13-f2-live", None)
                .await,
            "the resume aborts typed beside a live incumbent — never a second writer"
        );
        // The incumbent's record is untouched and no ticket parked.
        assert!(matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.terminal_id.as_deref() == Some("t-incumbent-live")
        ));
        assert!(driver
            .pending_ownership
            .lock()
            .expect("pending ownership lock")
            .is_none());
        state.registry.kill("t-incumbent-live");
    }

    /// b8ke ext r14 F4: the delayed Adopt/release retry carries the SAME
    /// observed fence as the crash event — a NEWER STOP that advances the
    /// generation and returns the key to Vacant during the polling
    /// interval rejects the stale crash request by generation arithmetic:
    /// the retry is REFUSED TYPED and NOTHING respawns (pre-r14 the retry
    /// passed None, so the old crash request claimed the NEW generation
    /// and respawned the session the newer operation deliberately
    /// stopped).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_crash_recovery_retry_after_a_newer_stop_is_refused_typed() {
        let (state, ownership) = ownership_state();
        let driver = std::sync::Arc::new(WsAutoResumeDriver {
            state: state.clone(),
            pending_ownership: Default::default(),
            pending_attach_guard: Default::default(),
            pending_claim_relay: Default::default(),
        });
        let sid = "ses-r14-f4-stale-retry".to_string();
        spawn_real_shell_row(&state, "t-crashed", "claude");
        // The coordinator record seeded DIRECTLY (no retained registry
        // claim): the crashed row's kill finds NO claim to release, so
        // the key STAYS LIVE while the row dies — the exact trailing-
        // release window the Adopt resolution waits in.
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "claude",
            &sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-crashed-owner",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            ownership.commit_live(
                "claude",
                &sid,
                "op-crashed-owner",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-crashed".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        // The crash shape: the row dies (its un-claimed release trails).
        state.registry.kill("t-crashed");
        assert!(
            matches!(
                ownership.observe("claude", &sid).state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "fixture: the key stays Live over the dead row (the trailing-release window)"
        );
        // The crash event's observed fence: the dead generation's pair.
        let crash_fence = freshell_ownership::ObservedFence {
            epoch: ownership.boot_epoch(),
            generation,
        };

        // The claim ADOPTS the live record over the dead row and enters
        // the release-wait.
        let claim_driver = std::sync::Arc::clone(&driver);
        let claim_sid = sid.clone();
        let claim = tokio::spawn(async move {
            claim_driver
                .claim_session("claude", &claim_sid, "req-r14-f4", Some(crash_fence))
                .await
        });

        // Let the claim ADOPT and enter its release-wait BEFORE the
        // newer stop (the wait polls every 10ms; 100ms is ample).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // THE NEWER STOP during the polling interval: it advances the
        // generation (G+1) and returns the key to Vacant — the session
        // is DELIBERATELY stopped.
        let freshell_ownership::StopOutcome::Granted {
            generation: stop_gen,
        } = ownership.begin_stop(
            "claude",
            &sid,
            "op-newer-stop",
            &freshell_ownership::StopClaim {
                expected_kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                expected_runtime: Some(freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-crashed".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                }),
                observed: crash_fence,
            },
            "test",
            freshell_ownership::now_epoch_ms(),
        )
        else {
            panic!("the newer stop must begin")
        };
        assert_eq!(
            ownership.commit_stop("claude", &sid, "op-newer-stop", stop_gen),
            freshell_ownership::CommitOutcome::Committed
        );
        assert!(matches!(
            ownership.observe("claude", &sid).state,
            freshell_ownership::OwnershipState::Vacant
        ));

        // THE STALE RETRY: the crash request's re-claim carries the OLD
        // fence (generation G) against the key's NEW generation (G+1) —
        // REFUSED TYPED, no respawn, no ticket.
        let claimed = claim.await.expect("the claim resolves");
        assert!(
            !claimed,
            "the stale crash-recovery retry is refused typed — no respawn"
        );
        assert!(
            driver
                .pending_ownership
                .lock()
                .expect("pending ownership lock")
                .is_none(),
            "no ticket parked for the stale retry"
        );
        assert!(
            matches!(
                ownership.observe("claude", &sid).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the newer stop's Vacant verdict stands"
        );
    }
}

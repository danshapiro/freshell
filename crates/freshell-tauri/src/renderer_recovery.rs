//! Renderer crash recovery — the Rust analog of `electron/renderer-recovery.ts`
//! (331 ln) + the window-replacement proxy (`entry.ts:53-224`). This is the
//! **hardest** feature to port (`electron-tauri.md §3.7`, §9 Risk 1).
//!
//! ## Capability gap (documented, NOT faked)
//!
//! WRY / Tauri exposes **none** of the Electron signals this feature is built on:
//!   * `render-process-gone` (renderer crashed),
//!   * `did-fail-load` with error codes,
//!   * `unresponsive` / `responsive`,
//!   * `webContents.forcefullyCrashRenderer()`,
//!   * cheap live `BrowserWindow` re-creation with state transfer.
//!
//! So the Electron **triggers cannot fire** on this platform. Per the mitigation in
//! §9 Risk 1, the port keeps the *decision core* faithful — the circuit breaker,
//! backoff schedule, unresponsive threshold, and the `did-fail-load` filter — as a
//! pure, unit-tested state machine ([`RecoveryCircuit`]), and drives it from a
//! **best-effort [`ReachabilityWatchdog`]** (poll the server; if it was reachable
//! and goes unreachable past a grace, request a `load-url` recovery — the analog of
//! `did-fail-load` we *can* detect headlessly) plus a manual `window.reload()`.
//!
//! What is covered vs not, explicitly:
//!
//! | Electron trigger | Covered in the port? | How |
//! |---|---|---|
//! | `render-process-gone` (webview process crash) | ❌ no WRY signal | — (platform gap) |
//! | `did-fail-load` (navigation/server failure) | ⚠️ approximated | reachability watchdog → `load-url` |
//! | `unresponsive` (JS main-thread hang) | ❌ no WRY signal | — (platform gap) |
//! | manual reload | ✅ | tray/menu → `window.reload()` |
//!
//! The circuit-breaker/backoff logic below is byte-faithful to the reference so
//! that whichever triggers a future per-OS webview instrumentation wires in
//! (WebKitGTK `web-process-terminated`, WebView2 `ProcessFailed`) inherit the exact
//! throttling. **Do not read this as parity** — it is a best-effort approximation,
//! oracle-scoped as fixture-only (`electron-tauri.md §8` item 11).

use std::time::Duration;

/// Circuit-breaker window — `renderer-recovery.ts:46` (60 s).
pub const CIRCUIT_WINDOW: Duration = Duration::from_millis(60_000);
/// Max recovery attempts per window — `renderer-recovery.ts:47` (3).
pub const MAX_ATTEMPTS_PER_WINDOW: usize = 3;
/// Backoff delays indexed by prior consecutive failures — `renderer-recovery.ts:48`.
pub const RETRY_DELAYS_MS: [u64; 3] = [250, 1000, 3000];
/// Unresponsive threshold before force-recover — `renderer-recovery.ts:49` (15 s).
pub const UNRESPONSIVE_THRESHOLD: Duration = Duration::from_millis(15_000);
/// The `ABORTED (-3)` navigation code that must NOT trigger recovery —
/// `renderer-recovery.ts:50`.
pub const ABORTED_NAVIGATION_ERROR_CODE: i32 = -3;

/// A recovery trigger — the events `renderer-recovery.ts` listens for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryTrigger {
    /// Renderer process gone (`render-process-gone`). No WRY equivalent — modeled
    /// for the state machine's completeness + future per-OS wiring.
    RenderProcessGone,
    /// Navigation failed (`did-fail-load`). `error_code`/`is_main_frame` gate
    /// whether it recovers (`renderer-recovery.ts:267-301`).
    DidFailLoad {
        error_code: i32,
        is_main_frame: bool,
    },
    /// Main thread unresponsive past the threshold (`unresponsive`).
    Unresponsive,
}

/// How to recover — `renderer-recovery.ts` `RecoveryMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryMode {
    /// Reload the webview in place (`render-process-gone`, `unresponsive`).
    Reload,
    /// Re-navigate to the load URL (`did-fail-load`).
    LoadUrl,
}

/// Whether a trigger should recover, and in which mode. Mirrors the per-event
/// decisions: `render-process-gone`→reload; `did-fail-load`→load-url ONLY for a
/// main-frame, non-aborted failure (`renderer-recovery.ts:288-301`);
/// `unresponsive`→reload (with a pre-crash in Electron; N/A here).
pub fn recovery_mode_for(trigger: RecoveryTrigger) -> Option<RecoveryMode> {
    match trigger {
        RecoveryTrigger::RenderProcessGone => Some(RecoveryMode::Reload),
        RecoveryTrigger::Unresponsive => Some(RecoveryMode::Reload),
        RecoveryTrigger::DidFailLoad {
            error_code,
            is_main_frame,
        } => {
            if is_main_frame && error_code != ABORTED_NAVIGATION_ERROR_CODE {
                Some(RecoveryMode::LoadUrl)
            } else {
                None
            }
        }
    }
}

/// The plan the circuit produces for a trigger at a given time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryPlan {
    /// Start recovery now in this mode.
    Immediate(RecoveryMode),
    /// Start recovery after a backoff delay (consecutive-failure backoff).
    Delayed(RecoveryMode, Duration),
    /// Skip: recovery already in flight or already scheduled
    /// (`renderer-recovery.ts:186-207`).
    Skip(SkipReason),
    /// The circuit is open — too many attempts in the window
    /// (`renderer-recovery.ts:216-227`).
    CircuitOpen,
    /// The trigger does not warrant recovery (e.g. a subframe/aborted load).
    NoRecovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    RecoveryInFlight,
    RecoveryAlreadyScheduled,
}

/// The circuit-breaker + backoff state machine of `renderer-recovery.ts`. Pure and
/// time-injected (`now_ms` passed in), so the whole throttling contract is tested
/// deterministically without timers.
#[derive(Debug, Default)]
pub struct RecoveryCircuit {
    /// Timestamps (ms) of recovery attempts started, pruned to the window.
    attempts: Vec<u64>,
    /// Consecutive failures — drives the backoff index (`renderer-recovery.ts:210-214`).
    consecutive_failures: usize,
    in_flight: bool,
    scheduled: bool,
}

impl RecoveryCircuit {
    pub fn new() -> Self {
        Self::default()
    }

    /// The backoff for the current consecutive-failure count
    /// (`renderer-recovery.ts:210-214`): 0 on the first attempt, else
    /// `RETRY_DELAYS_MS[min(failures-1, 2)]`.
    pub fn backoff(&self) -> Duration {
        if self.consecutive_failures == 0 {
            Duration::ZERO
        } else {
            let idx = (self.consecutive_failures - 1).min(RETRY_DELAYS_MS.len() - 1);
            Duration::from_millis(RETRY_DELAYS_MS[idx])
        }
    }

    fn prune(&mut self, now_ms: u64) {
        let window = CIRCUIT_WINDOW.as_millis() as u64;
        self.attempts.retain(|&t| now_ms.saturating_sub(t) < window);
    }

    /// Decide what to do for `trigger` at `now_ms`. Does NOT mutate attempt history
    /// (that happens in [`record_started`]); it only prunes the sliding window and
    /// reads flags — mirroring `requestRecovery` (`renderer-recovery.ts:185-235`).
    pub fn plan(&mut self, trigger: RecoveryTrigger, now_ms: u64) -> RecoveryPlan {
        let Some(mode) = recovery_mode_for(trigger) else {
            return RecoveryPlan::NoRecovery;
        };
        if self.in_flight {
            return RecoveryPlan::Skip(SkipReason::RecoveryInFlight);
        }
        if self.scheduled {
            return RecoveryPlan::Skip(SkipReason::RecoveryAlreadyScheduled);
        }
        self.prune(now_ms);
        if self.attempts.len() >= MAX_ATTEMPTS_PER_WINDOW {
            return RecoveryPlan::CircuitOpen;
        }
        let delay = self.backoff();
        if delay.is_zero() {
            RecoveryPlan::Immediate(mode)
        } else {
            self.scheduled = true;
            RecoveryPlan::Delayed(mode, delay)
        }
    }

    /// Mark a recovery attempt started at `now_ms` (`renderer-recovery.ts:150-155`):
    /// records the timestamp, sets in-flight, clears the scheduled flag.
    pub fn record_started(&mut self, now_ms: u64) {
        self.attempts.push(now_ms);
        self.in_flight = true;
        self.scheduled = false;
    }

    /// Mark the in-flight recovery succeeded (`renderer-recovery.ts:168-176`):
    /// resets the consecutive-failure backoff.
    pub fn record_succeeded(&mut self) {
        self.consecutive_failures = 0;
        self.in_flight = false;
    }

    /// Mark the in-flight recovery failed (`renderer-recovery.ts:178-183`):
    /// increments the consecutive-failure backoff.
    pub fn record_failed(&mut self) {
        self.consecutive_failures += 1;
        self.in_flight = false;
    }

    /// Attempts currently counted in the sliding window (test/inspection helper).
    pub fn attempts_in_window(&mut self, now_ms: u64) -> usize {
        self.prune(now_ms);
        self.attempts.len()
    }
}

/// A best-effort **server-reachability watchdog** — the headlessly-detectable
/// approximation of `did-fail-load` (`electron-tauri.md §9 Risk 1` mitigation).
/// It tracks whether the server was last reachable; a reachable→unreachable
/// transition sustained past `grace` requests a `LoadUrl` recovery. This is the
/// ONLY renderer-recovery trigger the port can actually source without Electron
/// webContents signals.
#[derive(Debug)]
pub struct ReachabilityWatchdog {
    grace: Duration,
    /// When the server was first observed unreachable in the current outage (ms).
    unreachable_since: Option<u64>,
    /// Whether we have ever seen it reachable (so startup-not-yet-up ≠ an outage).
    ever_reachable: bool,
}

impl ReachabilityWatchdog {
    pub fn new(grace: Duration) -> Self {
        Self {
            grace,
            unreachable_since: None,
            ever_reachable: false,
        }
    }

    /// Feed one reachability observation at `now_ms`. Returns a trigger when a
    /// sustained outage (past `grace`) is first detected, else `None`.
    pub fn observe(&mut self, reachable: bool, now_ms: u64) -> Option<RecoveryTrigger> {
        if reachable {
            self.ever_reachable = true;
            self.unreachable_since = None;
            return None;
        }
        // Unreachable. Ignore if we never came up (still booting).
        if !self.ever_reachable {
            return None;
        }
        match self.unreachable_since {
            None => {
                self.unreachable_since = Some(now_ms);
                None
            }
            Some(since) => {
                if now_ms.saturating_sub(since) >= self.grace.as_millis() as u64 {
                    // Emit once, then reset the clock so we don't spam.
                    self.unreachable_since = Some(now_ms);
                    Some(RecoveryTrigger::DidFailLoad {
                        error_code: -1, // synthetic: server unreachable (not aborted -3)
                        is_main_frame: true,
                    })
                } else {
                    None
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn did_fail_load_filters_subframe_and_aborted() {
        // Main-frame, real error → recover via load-url.
        assert_eq!(
            recovery_mode_for(RecoveryTrigger::DidFailLoad {
                error_code: -105,
                is_main_frame: true
            }),
            Some(RecoveryMode::LoadUrl)
        );
        // Aborted (-3) → no recovery, even on the main frame.
        assert_eq!(
            recovery_mode_for(RecoveryTrigger::DidFailLoad {
                error_code: -3,
                is_main_frame: true
            }),
            None
        );
        // Subframe → no recovery.
        assert_eq!(
            recovery_mode_for(RecoveryTrigger::DidFailLoad {
                error_code: -105,
                is_main_frame: false
            }),
            None
        );
    }

    #[test]
    fn crash_and_unresponsive_reload() {
        assert_eq!(
            recovery_mode_for(RecoveryTrigger::RenderProcessGone),
            Some(RecoveryMode::Reload)
        );
        assert_eq!(
            recovery_mode_for(RecoveryTrigger::Unresponsive),
            Some(RecoveryMode::Reload)
        );
    }

    #[test]
    fn first_recovery_is_immediate() {
        let mut c = RecoveryCircuit::new();
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 0),
            RecoveryPlan::Immediate(RecoveryMode::Reload)
        );
    }

    #[test]
    fn backoff_grows_with_consecutive_failures() {
        let mut c = RecoveryCircuit::new();
        assert_eq!(c.backoff(), Duration::ZERO);
        c.record_started(0);
        c.record_failed();
        assert_eq!(c.backoff(), Duration::from_millis(250));
        c.record_started(10);
        c.record_failed();
        assert_eq!(c.backoff(), Duration::from_millis(1000));
        c.record_started(20);
        c.record_failed();
        assert_eq!(c.backoff(), Duration::from_millis(3000));
        // Saturates at the last delay.
        c.record_started(30);
        c.record_failed();
        assert_eq!(c.backoff(), Duration::from_millis(3000));
    }

    #[test]
    fn success_resets_backoff() {
        let mut c = RecoveryCircuit::new();
        c.record_started(0);
        c.record_failed();
        assert_eq!(c.backoff(), Duration::from_millis(250));
        c.record_started(10);
        c.record_succeeded();
        assert_eq!(c.backoff(), Duration::ZERO);
    }

    #[test]
    fn after_a_failure_next_plan_is_delayed() {
        let mut c = RecoveryCircuit::new();
        c.record_started(0);
        c.record_failed();
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 100),
            RecoveryPlan::Delayed(RecoveryMode::Reload, Duration::from_millis(250))
        );
    }

    #[test]
    fn circuit_opens_after_three_attempts_in_window() {
        let mut c = RecoveryCircuit::new();
        // Three attempts within the 60 s window.
        c.record_started(0);
        c.record_succeeded();
        c.record_started(1000);
        c.record_succeeded();
        c.record_started(2000);
        c.record_succeeded();
        // Fourth request within the window → circuit open.
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 3000),
            RecoveryPlan::CircuitOpen
        );
    }

    #[test]
    fn circuit_reopens_after_window_elapses() {
        let mut c = RecoveryCircuit::new();
        c.record_started(0);
        c.record_succeeded();
        c.record_started(1000);
        c.record_succeeded();
        c.record_started(2000);
        c.record_succeeded();
        // 63 s after the last attempt (t=2000) all three have aged out of the 60 s
        // window → the circuit reopens (immediate again) and the window is empty.
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 63_000),
            RecoveryPlan::Immediate(RecoveryMode::Reload)
        );
        assert_eq!(c.attempts_in_window(63_000), 0);
    }

    #[test]
    fn in_flight_and_scheduled_skip() {
        let mut c = RecoveryCircuit::new();
        c.record_started(0); // in flight
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 10),
            RecoveryPlan::Skip(SkipReason::RecoveryInFlight)
        );
        c.record_failed(); // clears in_flight, sets consecutive=1
                           // Now a plan schedules (delayed) and sets the scheduled flag.
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 20),
            RecoveryPlan::Delayed(RecoveryMode::Reload, Duration::from_millis(250))
        );
        // A second request while scheduled is skipped.
        assert_eq!(
            c.plan(RecoveryTrigger::RenderProcessGone, 30),
            RecoveryPlan::Skip(SkipReason::RecoveryAlreadyScheduled)
        );
    }

    #[test]
    fn no_recovery_trigger_returns_no_recovery() {
        let mut c = RecoveryCircuit::new();
        assert_eq!(
            c.plan(
                RecoveryTrigger::DidFailLoad {
                    error_code: -3,
                    is_main_frame: true
                },
                0
            ),
            RecoveryPlan::NoRecovery
        );
    }

    // ---- ReachabilityWatchdog -------------------------------------------------

    #[test]
    fn watchdog_ignores_outage_before_first_reachable() {
        let mut w = ReachabilityWatchdog::new(Duration::from_secs(5));
        // Still booting: never reachable yet → no trigger even if long.
        assert_eq!(w.observe(false, 0), None);
        assert_eq!(w.observe(false, 10_000), None);
    }

    #[test]
    fn watchdog_triggers_after_sustained_outage() {
        let mut w = ReachabilityWatchdog::new(Duration::from_secs(5));
        assert_eq!(w.observe(true, 0), None); // came up
        assert_eq!(w.observe(false, 1000), None); // outage starts
        assert_eq!(w.observe(false, 3000), None); // within grace
                                                  // 5 s past the outage start → trigger a load-url recovery.
        let t = w.observe(false, 6000);
        assert_eq!(
            t,
            Some(RecoveryTrigger::DidFailLoad {
                error_code: -1,
                is_main_frame: true
            })
        );
        // The synthetic trigger recovers (not aborted).
        assert_eq!(recovery_mode_for(t.unwrap()), Some(RecoveryMode::LoadUrl));
    }

    #[test]
    fn watchdog_recovery_clears_on_reachable_again() {
        let mut w = ReachabilityWatchdog::new(Duration::from_secs(5));
        w.observe(true, 0);
        w.observe(false, 1000);
        // Recovered before grace → back to reachable, no trigger, clock reset.
        assert_eq!(w.observe(true, 2000), None);
        assert_eq!(w.observe(false, 3000), None); // new outage, clock restarts
        assert_eq!(w.observe(false, 7000), None); // only 4 s in
        assert!(w.observe(false, 8500).is_some()); // now past grace
    }
}

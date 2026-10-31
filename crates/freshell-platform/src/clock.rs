//! HARNESS-14 — the shared controllable test clock.
//!
//! One optional process-wide epoch-milliseconds clock, env-gated by
//! `FRESHELL_TEST_CLOCK` (`1`/`true`). When the gate is OFF — every normal
//! build and run — [`now_ms`] is a dead passthrough to `SystemTime::now()`
//! and every control function returns [`ClockError::Disabled`]; no behavior
//! change, no control surface (the REST endpoints that drive this module are
//! only mounted under the same gate — see `freshell-server`'s
//! `test_clock_router` and the legacy `server/test-clock.ts` port, whose
//! semantics this module mirrors exactly).
//!
//! ## Semantics (identical in both server implementations)
//!
//! State is `{ offset_ms, frozen_at }`. Effective time is `frozen_at` when
//! frozen, `real_now + offset_ms` when live. The control verbs:
//!
//! * [`advance_ms`] — advance-only (`0 <= ms <= MAX_ADVANCE_MS`). Frozen adds
//!   to the held value; live adds to the offset. Advance-only guarantees the
//!   clock is **monotonic** — every consumer computes
//!   `now.saturating_sub(stamp)`, and a backward jump would wedge idle/TTL
//!   math. There is deliberately no arbitrary `set` verb.
//! * [`freeze`] — capture the current effective time (idempotent).
//! * [`resume`] — continue LIVE time forward FROM the held value
//!   (`offset = held - real_now`), so unfreezing produces no catch-up jump.
//! * [`reset`] — clear offset + unfrozen: pure wall clock again.
//!
//! ## Why the seams route through one clock
//!
//! Idle cleanup, rate windows, tab/device TTLs, and retention all derive
//! from epoch-ms stamps recorded earlier; sharing one clock lets a spec
//! advance past ALL of their thresholds in a single step with no wall-clock
//! sleep (see `docs/plans/df1/HARNESS-14.md` for the seam inventory).

use std::sync::atomic::{AtomicI8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// The gate env var. Trimmed/lowercased; enabled on `1` or `true`.
pub const TEST_CLOCK_ENV: &str = "FRESHELL_TEST_CLOCK";

/// Upper bound for one [`advance_ms`] call (31 days). Bounds runaway test
/// bugs while comfortably covering every threshold in the codebase (the
/// largest is the 24h agent idle hard cap).
pub const MAX_ADVANCE_MS: i64 = 31 * 24 * 60 * 60 * 1000;

/// Why a control verb failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockError {
    /// `FRESHELL_TEST_CLOCK` was not set at boot (or a test override forced
    /// disabled): the clock is inert and control verbs must not take effect.
    Disabled,
    /// [`advance_ms`] input outside `0..=MAX_ADVANCE_MS`.
    InvalidAdvance,
}

/// Live vs frozen, surfaced by [`ClockSnapshot::mode`] and the REST state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockMode {
    Live,
    Frozen,
}

impl ClockMode {
    /// The exact `mode` string the REST surface emits (parity with
    /// `server/test-clock.ts`).
    pub fn as_str(self) -> &'static str {
        match self {
            ClockMode::Live => "live",
            ClockMode::Frozen => "frozen",
        }
    }
}

/// A point-in-time read of the clock (REST state payload shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockSnapshot {
    pub enabled: bool,
    pub mode: ClockMode,
    /// Effective epoch milliseconds right now.
    pub now_ms: i64,
    /// Current live-mode offset from wall clock (ms). Present-tense even
    /// while frozen so `resume` math is observable.
    pub offset_ms: i64,
}

/// The pure transition core (no env, no statics) — the testable heart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClockCore {
    offset_ms: i64,
    frozen_at: Option<i64>,
}

impl ClockCore {
    const ZERO: Self = Self {
        offset_ms: 0,
        frozen_at: None,
    };

    fn effective_now(&self, real_now_ms: i64) -> i64 {
        match self.frozen_at {
            Some(held) => held,
            None => real_now_ms.saturating_add(self.offset_ms),
        }
    }

    fn advance(&mut self, ms: i64) {
        match self.frozen_at {
            Some(held) => self.frozen_at = Some(held.saturating_add(ms)),
            None => self.offset_ms = self.offset_ms.saturating_add(ms),
        }
    }

    /// Idempotent: re-freezing while frozen never moves the held value.
    fn freeze(&mut self, real_now_ms: i64) {
        if self.frozen_at.is_none() {
            self.frozen_at = Some(self.effective_now(real_now_ms));
        }
    }

    /// Continue live from the held value (monotonic: the instant after
    /// resume, effective time equals the value held at freeze).
    fn resume(&mut self, real_now_ms: i64) {
        if let Some(held) = self.frozen_at.take() {
            self.offset_ms = held.saturating_sub(real_now_ms);
        }
    }

    fn reset(&mut self) {
        *self = Self::ZERO;
    }
}

/// Process-wide state. A single Mutex over the tiny core (not paired
/// atomics) so `freeze`/`resume` read-modify-write cycles stay atomic
/// against concurrent control verbs; `now_ms` short-circuits before the
/// lock on the gate-off fast path, so production pays nothing.
static CORE: Mutex<ClockCore> = Mutex::new(ClockCore::ZERO);

/// Gate cache: read from the environment ONCE (a server boot either has the
/// test clock or does not; mid-run flips via env mutation are not a
/// supported mode).
static ENV_ENABLED: OnceLock<bool> = OnceLock::new();

/// Test override tri-state (-1 = unset, 0 = forced off, 1 = forced on).
/// Lets in-crate tests exercise the enabled path despite the once-only env
/// read, and lets cross-crate callers (e.g. the freshell-server router
/// tests) opt in via [`set_enabled_override_for_tests`].
static ENABLED_OVERRIDE: AtomicI8 = AtomicI8::new(-1);

fn env_enabled() -> bool {
    *ENV_ENABLED.get_or_init(|| {
        std::env::var(TEST_CLOCK_ENV)
            .map(|v| {
                let v = v.trim().to_ascii_lowercase();
                v == "1" || v == "true"
            })
            .unwrap_or(false)
    })
}

/// Whether the test clock is active in this process.
pub fn enabled() -> bool {
    match ENABLED_OVERRIDE.load(Ordering::SeqCst) {
        -1 => env_enabled(),
        0 => false,
        _ => true,
    }
}

/// `#[doc(hidden)]` test seam — installs (`Some`) or clears (`None`) a
/// process-wide override of the env gate. Never called by production code
/// paths; the REST surface is mounted only under `enabled()` already.
#[doc(hidden)]
pub fn set_enabled_override_for_tests(value: Option<bool>) {
    ENABLED_OVERRIDE.store(
        match value {
            None => -1,
            Some(false) => 0,
            Some(true) => 1,
        },
        Ordering::SeqCst,
    );
}

/// Wall-clock epoch milliseconds (the gate-off fast path AND the live-mode
/// base). `unwrap_or(0)` mirrors every other `Date.now()` port in the repo.
fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Effective epoch milliseconds. Gate OFF: identical to `system_now_ms()`
/// with zero lock/atomic traffic. Gate ON: the offset/frozen value.
pub fn now_ms() -> i64 {
    if !enabled() {
        return system_now_ms();
    }
    let real = system_now_ms();
    CORE.lock()
        .expect("test clock poisoned")
        .effective_now(real)
}

/// Current clock state. The gate-off answer is deliberately INERT (live,
/// zero offset, wall-clock now) so disabled-state callers can never observe
/// leftover virtual state.
pub fn snapshot() -> ClockSnapshot {
    let real = system_now_ms();
    let core = *CORE.lock().expect("test clock poisoned");
    if !enabled() {
        return ClockSnapshot {
            enabled: false,
            mode: ClockMode::Live,
            now_ms: real,
            offset_ms: 0,
        };
    }
    ClockSnapshot {
        enabled: true,
        mode: if core.frozen_at.is_some() {
            ClockMode::Frozen
        } else {
            ClockMode::Live
        },
        now_ms: core.effective_now(real),
        offset_ms: core.offset_ms,
    }
}

/// Drive a control verb, gating + validating uniformly. `f` receives the
/// core and the real now; `validate` runs before any mutation.
fn drive(f: impl FnOnce(&mut ClockCore, i64)) -> Result<ClockSnapshot, ClockError> {
    if !enabled() {
        return Err(ClockError::Disabled);
    }
    let real = system_now_ms();
    {
        let mut core = CORE.lock().expect("test clock poisoned");
        f(&mut core, real);
    }
    Ok(snapshot())
}

/// Advance effective time by `ms` (frozen: steps the held value; live: adds
/// to the offset). See the module docs for the advance-only/monotonic rule.
pub fn advance_ms(ms: i64) -> Result<ClockSnapshot, ClockError> {
    if !(0..=MAX_ADVANCE_MS).contains(&ms) {
        return Err(ClockError::InvalidAdvance);
    }
    drive(|core, _real| core.advance(ms))
}

/// Hold effective time at its current value until [`resume`] (idempotent).
pub fn freeze() -> Result<ClockSnapshot, ClockError> {
    drive(|core, real| core.freeze(real))
}

/// Resume live time continuing from the held value (no catch-up jump).
pub fn resume() -> Result<ClockSnapshot, ClockError> {
    drive(|core, real| core.resume(real))
}

/// Back to pure wall clock (offset 0, live).
pub fn reset() -> Result<ClockSnapshot, ClockError> {
    if !enabled() {
        return Err(ClockError::Disabled);
    }
    CORE.lock().expect("test clock poisoned").reset();
    Ok(snapshot())
}

#[cfg(test)]
mod tests {
    //! RED-first for HARNESS-14 (T1). The enabled-path tests share the
    //! process-global core, so every one takes `GATE_TEST_LOCK` and resets +
    //! clears the override on exit (guard) — a poisoned leak would turn
    //! other tests' `now_ms` virtual.
    use super::*;

    static GATE_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct OverrideGuard;
    impl OverrideGuard {
        /// Serialize against every other override-using test and install the
        /// requested gate state. Poison-tolerant (`into_inner`) so one
        /// panicking sibling cannot cascade the whole clock suite red.
        fn locked(enabled_state: bool) -> (std::sync::MutexGuard<'static, ()>, Self) {
            let guard = GATE_TEST_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            set_enabled_override_for_tests(Some(enabled_state));
            if enabled_state {
                reset().expect("override just enabled; reset must succeed");
            }
            (guard, Self)
        }
    }
    impl Drop for OverrideGuard {
        fn drop(&mut self) {
            let _ = reset();
            set_enabled_override_for_tests(None);
        }
    }

    // ── gate-off identity ────────────────────────────────────────────────

    #[test]
    fn gate_off_now_ms_is_identity_and_controls_are_disabled() {
        // Forced-DISABLED under the same lock (the default env-unset path is
        // what production always runs; the `env_enabled` half is pinned
        // separately below without touching shared state).
        let (_lock, _guard) = OverrideGuard::locked(false);
        let before = system_now_ms();
        let t = now_ms();
        let after = system_now_ms();
        assert!(before <= t && t <= after, "now_ms must equal wall clock");

        assert_eq!(advance_ms(1000), Err(ClockError::Disabled));
        assert_eq!(freeze(), Err(ClockError::Disabled));
        assert_eq!(resume(), Err(ClockError::Disabled));
        assert_eq!(reset(), Err(ClockError::Disabled));

        let snap = snapshot();
        assert!(!snap.enabled);
        assert_eq!(snap.mode, ClockMode::Live);
        assert_eq!(snap.offset_ms, 0);
        assert!(before <= snap.now_ms && snap.now_ms <= system_now_ms());
    }

    #[test]
    fn gate_off_default_env_is_disabled() {
        // The env var is absent in the test environment unless a developer
        // exported it; with no override ever installed, `enabled()` must be
        // false (this also pins that mere PRESENCE of a wrong value like
        // `0`/`yes` does not enable).
        if std::env::var(TEST_CLOCK_ENV).is_ok() {
            eprintln!("{TEST_CLOCK_ENV} set in environment; skipping");
            return;
        }
        assert!(!env_enabled());
    }

    // ── enabled-path transitions ─────────────────────────────────────────

    #[test]
    fn advance_moves_live_time_forward_by_exactly_the_delta() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        let real_before = system_now_ms();
        let before = snapshot();
        // Live time keeps moving during advance; exercise that movement rather
        // than requiring both snapshots to land in the same millisecond.
        std::thread::sleep(std::time::Duration::from_millis(2));
        advance_ms(90_000).unwrap();
        let after = snapshot();
        let real_after = system_now_ms();
        let delta = after.now_ms - before.now_ms;
        assert!(delta >= 90_000 && delta <= 90_000 + real_after - real_before);
        assert_eq!(after.offset_ms - before.offset_ms, 90_000);
        assert_eq!(after.offset_ms, 90_000);
        assert_eq!(after.mode, ClockMode::Live);
    }

    #[test]
    fn freeze_holds_time_constant_and_advance_steps_the_held_value() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        advance_ms(60_000).unwrap();
        let frozen = freeze().unwrap();
        assert_eq!(frozen.mode, ClockMode::Frozen);
        // Frozen: consecutive reads do not move even though real time does.
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert_eq!(snapshot().now_ms, frozen.now_ms);

        // Advancing while frozen steps the held value EXACTLY (and two
        // steps compose: T0+5 then +11 lands on T0+16).
        let stepped = advance_ms(5 * 60_000).unwrap();
        assert_eq!(stepped.now_ms, frozen.now_ms + 5 * 60_000);
        let stepped2 = advance_ms(11 * 60_000).unwrap();
        assert_eq!(stepped2.now_ms, frozen.now_ms + 16 * 60_000);
        assert_eq!(stepped2.mode, ClockMode::Frozen);
    }

    #[test]
    fn freeze_is_idempotent() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        let f1 = freeze().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let f2 = freeze().unwrap();
        assert_eq!(f1.now_ms, f2.now_ms, "re-freeze must not re-capture");
    }

    #[test]
    fn resume_continues_from_the_held_value_without_a_jump() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        advance_ms(120_000).unwrap();
        let frozen = freeze().unwrap();
        let resumed = resume().unwrap();
        assert_eq!(resumed.mode, ClockMode::Live);
        // The instant after resume, effective time ≈ the held value: no
        // catch-up jump back to wall clock (which would be a ~120s
        // BACKWARD move) and no leap forward.
        let drift = (resumed.now_ms - frozen.now_ms).abs();
        assert!(drift < 1_000, "resume jumped by {drift}ms");
        // And from there it tracks real time again.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let later = snapshot();
        assert!(later.now_ms >= resumed.now_ms, "live clock must advance");
        assert!(
            later.now_ms - resumed.now_ms < 1_000,
            "live clock must advance by REAL elapsed time, not retroactively"
        );
    }

    #[test]
    fn reset_restores_pure_wall_clock() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        advance_ms(600_000).unwrap();
        freeze().unwrap();
        let snap = reset().unwrap();
        assert_eq!(snap.mode, ClockMode::Live);
        assert_eq!(snap.offset_ms, 0);
        let real = system_now_ms();
        assert!(
            (snap.now_ms - real).abs() < 1_000,
            "after reset, now_ms ({}) must equal wall clock ({real})",
            snap.now_ms
        );
    }

    #[test]
    fn monotonic_across_every_verb() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        let mut last = snapshot().now_ms;
        let mut check = |snap: ClockSnapshot| {
            assert!(snap.now_ms >= last, "clock went backwards");
            last = snap.now_ms;
        };
        check(advance_ms(1).unwrap());
        check(freeze().unwrap());
        check(advance_ms(1000 * 60 * 60).unwrap());
        check(resume().unwrap());
        check(advance_ms(0).unwrap());
        // `reset()` is deliberately NOT in this chain: returning to pure wall
        // clock UNDOES the accumulated offset, which is a backward step by
        // design (it exists so specs can restore a pristine clock). Its
        // back-to-wall behavior is pinned by `reset_restores_pure_wall_clock`.
    }

    // ── validation ───────────────────────────────────────────────────────

    #[test]
    fn advance_rejects_out_of_range_inputs_without_mutating() {
        let (_lock, _guard) = OverrideGuard::locked(true);
        let before = snapshot();
        assert_eq!(advance_ms(-1), Err(ClockError::InvalidAdvance));
        assert_eq!(
            advance_ms(MAX_ADVANCE_MS + 1),
            Err(ClockError::InvalidAdvance)
        );
        assert_eq!(advance_ms(i64::MAX), Err(ClockError::InvalidAdvance));
        let after = snapshot();
        // A rejected advance must not drift the clock (modulo real elapsed).
        assert!((after.now_ms - before.now_ms).abs() < 1_000);
        // ^ 31 days exactly is IN range (boundary is inclusive). Asserted
        // on a FROZEN clock: the whole-snapshot equality below compares the
        // snapshot `advance_ms` captured with a fresh `snapshot()`, and on
        // the live path each sample calls `system_now_ms()` separately —
        // a real-time ms tick between them would flake the equality.
        // Frozen makes `now_ms` a pure function of core state, so the
        // boundary probe is deterministic. (Input validation runs before
        // `drive` on both paths, so the frozen advance still pins
        // boundary inclusiveness.)
        freeze().unwrap();
        assert_eq!(advance_ms(MAX_ADVANCE_MS), Ok(snapshot()));
    }

    #[test]
    fn disabled_clock_control_verbs_do_not_mutate_state() {
        // Even with state left over in the core, disabling turns every verb
        // into a Disabled no-op and `now_ms` back into wall time.
        let (_lock, _guard) = OverrideGuard::locked(true);
        advance_ms(60_000).unwrap();
        set_enabled_override_for_tests(Some(false));
        assert!(!enabled());
        assert_eq!(advance_ms(1000), Err(ClockError::Disabled));
        let snap = snapshot();
        assert!(!snap.enabled);
        let real = system_now_ms();
        assert!((snap.now_ms - real).abs() < 1_000);
        // Re-enable: the stale offset must still be there (reset is the
        // ONLY way to clear) — no hidden clearing on the gate edge.
        set_enabled_override_for_tests(Some(true));
        let snap2 = snapshot();
        assert!(snap2.offset_ms >= 60_000);
    }

    #[test]
    fn snapshot_mode_strings_match_the_rest_surface() {
        assert_eq!(ClockMode::Live.as_str(), "live");
        assert_eq!(ClockMode::Frozen.as_str(), "frozen");
    }
}

//! Server-side `terminal.create` protection knobs + the per-connection
//! sliding-window rate limiter (legacy parity: `server/ws-handler.ts:240-241,
//! 2376-2389`).
//!
//! Legacy semantics reproduced EXACTLY:
//! - default 10 creates per 10_000 ms sliding window, per WS connection
//! - env `TERMINAL_CREATE_RATE_LIMIT` / `TERMINAL_CREATE_RATE_WINDOW_MS`
//!   (same names; parsing deliberately DIVERGES — see below)
//! - prune predicate is strict: a timestamp survives while `now - t < window`
//! - a REJECTED create consumes no budget (timestamps push on accept only)
//! - `restore:true` creates bypass the limiter entirely (the CALLER enforces
//!   the bypass; this type is bypass-agnostic)
//!
//! Deliberate env-parsing divergence from legacy: legacy is
//! `Number(env || default)`, which silently DISABLES the limiter on an
//! unparseable value (`NaN` comparisons are false) and blocks ALL creates on
//! `'0'`/negatives (truthy strings). We sanitize instead: unset, unparseable,
//! zero, or negative -> default. Parity holds for unset and valid positive
//! values — the cases that matter.
//!
//! The spawn-gate knobs (new Rust-side work, no legacy analogue — see
//! [`crate::spawn_gate`]) live in the same config struct to keep the
//! `WsState` surface change to two fields.

use std::collections::VecDeque;

#[derive(Debug, Clone, Copy)]
pub struct CreateProtectConfig {
    /// Max accepted non-restore `terminal.create` per window, per connection.
    pub rate_limit: usize,
    /// Sliding-window length, ms.
    pub rate_window_ms: u64,
    /// Server-wide max concurrent PTY spawns (spawn-gate permits).
    pub spawn_concurrency: usize,
    /// Max creates queued waiting on the gate before failing loud. Also the
    /// per-connection ordinary-create worker queue depth
    /// (`terminal::interactive_creates`): one operator-level ceiling for
    /// "creates parked, not running" anywhere.
    pub spawn_queue_cap: usize,
    /// Max wait for a spawn-gate permit before failing loud, ms. Must stay
    /// far below the frozen client's ~38s RATE_LIMITED ladder patience
    /// (interactive, REST, and auto-resume doors — the WS restore door
    /// waits unbounded-cancel-aware since graceful restore/resume S1).
    pub spawn_timeout_ms: u64,
}

impl Default for CreateProtectConfig {
    fn default() -> Self {
        Self {
            rate_limit: 10,
            rate_window_ms: 10_000,
            spawn_concurrency: 4,
            spawn_queue_cap: 64,
            spawn_timeout_ms: 10_000,
        }
    }
}

use crate::env_parse;

impl CreateProtectConfig {
    /// Resolve from process env. Rate-limit names mirror legacy
    /// (`server/ws-handler.ts:240-241`); gate names are new Rust-side knobs.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            rate_limit: env_parse("TERMINAL_CREATE_RATE_LIMIT", d.rate_limit),
            rate_window_ms: env_parse("TERMINAL_CREATE_RATE_WINDOW_MS", d.rate_window_ms),
            spawn_concurrency: env_parse("FRESHELL_SPAWN_GATE_CONCURRENCY", d.spawn_concurrency),
            spawn_queue_cap: env_parse("FRESHELL_SPAWN_GATE_QUEUE_CAP", d.spawn_queue_cap),
            spawn_timeout_ms: env_parse("FRESHELL_SPAWN_GATE_TIMEOUT_MS", d.spawn_timeout_ms),
        }
    }
}

/// Per-connection sliding window of accept timestamps (epoch ms). One
/// instance per WS connection, constructed in `terminal::run` — fresh/empty
/// on reconnect, exactly like legacy `ClientState.terminalCreateTimestamps`.
#[derive(Debug)]
pub struct CreateRateLimiter {
    timestamps: VecDeque<u64>,
    limit: usize,
    window_ms: u64,
}

impl CreateRateLimiter {
    pub fn new(limit: usize, window_ms: u64) -> Self {
        Self {
            timestamps: VecDeque::new(),
            limit,
            window_ms,
        }
    }

    /// Prune expired entries (strict `now - t < window` survival, legacy
    /// parity), then either reject (recording NOTHING) or record-and-accept.
    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        while let Some(&oldest) = self.timestamps.front() {
            if now_ms.saturating_sub(oldest) < self.window_ms {
                break;
            }
            self.timestamps.pop_front();
        }
        if self.timestamps.len() >= self.limit {
            return false;
        }
        self.timestamps.push_back(now_ms);
        true
    }
}

/// Wall-clock epoch milliseconds for limiter stamping.
///
/// HARNESS-14: routed through the shared, env-gated test clock
/// (`freshell_platform::clock`; gate-off identity passthrough), so a
/// `FRESHELL_TEST_CLOCK=1` test boot can advance past the create-rate
/// window without wall-clock sleeps.
pub fn epoch_ms() -> u64 {
    freshell_platform::clock::now_ms().max(0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_up_to_limit_then_rejects() {
        let mut l = CreateRateLimiter::new(10, 10_000);
        for _ in 0..10 {
            assert!(l.try_acquire(0));
        }
        assert!(
            !l.try_acquire(0),
            "11th create in the window must be rejected"
        );
    }

    #[test]
    fn rejection_consumes_no_budget() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(0));
        assert!(!l.try_acquire(1_000));
        assert!(!l.try_acquire(2_000));
        // At t=10_000 both accepted stamps (t=0) expire (strict `<`).
        // If the two REJECTIONS had been recorded, capacity would still be 0.
        assert!(l.try_acquire(10_000));
        assert!(l.try_acquire(10_000));
    }

    #[test]
    fn prune_boundary_is_strict_legacy_parity() {
        // Legacy keeps `now - t < windowMs`: at exactly `window` the stamp expires.
        let mut l = CreateRateLimiter::new(1, 10_000);
        assert!(l.try_acquire(0));
        assert!(
            !l.try_acquire(9_999),
            "at now-t=9_999 the stamp still counts"
        );
        assert!(l.try_acquire(10_000), "at now-t=10_000 the stamp is pruned");
    }

    #[test]
    fn window_slides_per_entry() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(5_000));
        assert!(!l.try_acquire(9_999));
        // t=0 expired at 10_000; t=5_000 still live; one slot free.
        assert!(l.try_acquire(10_000));
        assert!(!l.try_acquire(10_001), "5_000 and 10_000 both in window");
    }

    #[test]
    fn config_defaults_match_legacy() {
        let c = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, 10);
        assert_eq!(c.rate_window_ms, 10_000);
        assert_eq!(c.spawn_concurrency, 4);
        assert_eq!(c.spawn_queue_cap, 64);
        assert_eq!(c.spawn_timeout_ms, 10_000);
    }

    #[test]
    fn config_from_env_overrides_and_zero_falls_back() {
        // Clean slate: remove all env vars to test fallback defaults.
        std::env::remove_var("TERMINAL_CREATE_RATE_LIMIT");
        std::env::remove_var("TERMINAL_CREATE_RATE_WINDOW_MS");
        std::env::remove_var("FRESHELL_SPAWN_GATE_CONCURRENCY");
        std::env::remove_var("FRESHELL_SPAWN_GATE_QUEUE_CAP");
        std::env::remove_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS");

        // Test: unset -> defaults
        let c = CreateProtectConfig::from_env();
        let d = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, d.rate_limit);
        assert_eq!(c.rate_window_ms, d.rate_window_ms);
        assert_eq!(c.spawn_concurrency, d.spawn_concurrency);
        assert_eq!(c.spawn_queue_cap, d.spawn_queue_cap);
        assert_eq!(c.spawn_timeout_ms, d.spawn_timeout_ms);

        // Test: valid positive override takes effect
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "20");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "20000");
        std::env::set_var("FRESHELL_SPAWN_GATE_CONCURRENCY", "8");
        std::env::set_var("FRESHELL_SPAWN_GATE_QUEUE_CAP", "128");
        std::env::set_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS", "20000");
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, 20);
        assert_eq!(c.rate_window_ms, 20000);
        assert_eq!(c.spawn_concurrency, 8);
        assert_eq!(c.spawn_queue_cap, 128);
        assert_eq!(c.spawn_timeout_ms, 20000);

        // Test: '0' -> fallback to default
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "0");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "0");
        std::env::set_var("FRESHELL_SPAWN_GATE_CONCURRENCY", "0");
        std::env::set_var("FRESHELL_SPAWN_GATE_QUEUE_CAP", "0");
        std::env::set_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS", "0");
        let c = CreateProtectConfig::from_env();
        let d = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, d.rate_limit);
        assert_eq!(c.rate_window_ms, d.rate_window_ms);
        assert_eq!(c.spawn_concurrency, d.spawn_concurrency);
        assert_eq!(c.spawn_queue_cap, d.spawn_queue_cap);
        assert_eq!(c.spawn_timeout_ms, d.spawn_timeout_ms);

        // Test: unparseable -> fallback to default
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "not-a-number");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "not-a-number");
        std::env::set_var("FRESHELL_SPAWN_GATE_CONCURRENCY", "not-a-number");
        std::env::set_var("FRESHELL_SPAWN_GATE_QUEUE_CAP", "not-a-number");
        std::env::set_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS", "not-a-number");
        let c = CreateProtectConfig::from_env();
        let d = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, d.rate_limit);
        assert_eq!(c.rate_window_ms, d.rate_window_ms);
        assert_eq!(c.spawn_concurrency, d.spawn_concurrency);
        assert_eq!(c.spawn_queue_cap, d.spawn_queue_cap);
        assert_eq!(c.spawn_timeout_ms, d.spawn_timeout_ms);

        // Cleanup
        std::env::remove_var("TERMINAL_CREATE_RATE_LIMIT");
        std::env::remove_var("TERMINAL_CREATE_RATE_WINDOW_MS");
        std::env::remove_var("FRESHELL_SPAWN_GATE_CONCURRENCY");
        std::env::remove_var("FRESHELL_SPAWN_GATE_QUEUE_CAP");
        std::env::remove_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS");
    }

    #[test]
    fn epoch_ms_returns_nonzero() {
        let ms = epoch_ms();
        assert!(ms > 0, "epoch_ms should return a nonzero value");
    }
}

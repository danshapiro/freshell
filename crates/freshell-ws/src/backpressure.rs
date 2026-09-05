//! TERM-09: per-connection terminal-output backpressure configuration and the
//! catastrophic-backpressure monitor (legacy: `client-output-queue.ts`'
//! tunables and `broker.ts`'s `catastrophicBlocked`,
//! `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES` / `_STALL_MS`, `constants.ts:8-16`).
//!
//! The bounded queue itself is the connection writer's byte-fair delivery
//! queue (`terminal::connection_writer`'s `terminal_delivery_queue`), with the
//! default cap exported from `freshell_terminal::output_queue`: producers
//! route output frames into it through the writer's single admission lock,
//! and the writer leases one frame at a time to the socket.
//!
//! ## Architectural mapping (why this differs from `broker.ts`)
//!
//! Legacy checks `ws.bufferedAmount` -- a value the underlying socket reports
//! WITHOUT blocking -- before every send attempt, so a stalled write is
//! observed instantly on the next flush tick. `axum`'s `WebSocket::send` has
//! no non-blocking "how much is buffered" query; the only signal is the
//! `send().await` call itself resolving (or not). This crate therefore uses
//! the writer's pending output bytes (everything queued PLUS the one frame
//! currently leased to the socket) as the OBSERVABLE proxy for
//! `bufferedAmount`: if the writer can't keep up, frames pile up there BEFORE
//! ever reaching the socket, so sustained queue pressure is the same signal
//! legacy reads off the socket directly.
//!
//! [`CatastrophicMonitor::tick`] runs on the connection's own periodic ticker
//! in its select loop. Before the writer split this ticker shared a task with
//! network writes, so a permanently blocked send could starve it; with the
//! split, the ticker is independent of socket state, and the writer's own
//! per-send timeout bounds a truly wedged send separately. Regardless of
//! whether the ticker ever fires, the queue's bound is unconditional:
//! eviction happens on every `push`, independent of whether anything is
//! currently being sent, so the "bounded server memory" half of TERM-09 holds
//! even in the worst case.
//!
//! Visible-first pacing / background throttling (legacy's
//! `TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES` /
//! `TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES` differential) lives in the
//! connection writer's byte-fair delivery queue
//! (`terminal::connection_writer`'s `terminal_delivery_queue`): focused,
//! visible, and background terminals receive roughly an 8:3:1 byte share
//! under continuous backlog, driven by the `terminalInterestV1` client's
//! presentation snapshots, with `terminal.attach.priority` as the
//! pre-snapshot fallback. This module holds the caps plus the catastrophic
//! monitor, not the scheduling.

use std::time::{Duration, Instant};

use freshell_terminal::output_queue::DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES;

/// TERM-09 tunables (legacy parity: `server/terminal-stream/constants.ts`).
/// Bundled into one struct (rather than three separate `WsState` fields) to
/// keep the state surface change minimal.
#[derive(Debug, Clone, Copy)]
pub struct Term09Config {
    /// Per-connection bounded output-queue cap (legacy:
    /// `client-output-queue.ts:33` `DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES`,
    /// env `TERMINAL_CLIENT_QUEUE_MAX_BYTES`).
    pub queue_max_bytes: usize,
    /// Catastrophic-backpressure threshold (legacy: `constants.ts:8-11`
    /// `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES`, env same name).
    pub catastrophic_buffered_bytes: usize,
    /// How long the threshold must be sustained before closing (legacy:
    /// `constants.ts:13-16` `TERMINAL_WS_CATASTROPHIC_STALL_MS`, env same
    /// name).
    pub catastrophic_stall_ms: u64,
}

impl Default for Term09Config {
    fn default() -> Self {
        Self {
            queue_max_bytes: DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES,
            catastrophic_buffered_bytes: 16 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
        }
    }
}

use crate::env_parse;

impl Term09Config {
    /// Resolve from process env, mirroring `server/terminal-stream/constants.ts`
    /// exactly (same env var names, same defaults).
    pub fn from_env() -> Self {
        let defaults = Self::default();
        Self {
            queue_max_bytes: env_parse("TERMINAL_CLIENT_QUEUE_MAX_BYTES", defaults.queue_max_bytes),
            catastrophic_buffered_bytes: env_parse(
                "TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES",
                defaults.catastrophic_buffered_bytes,
            ),
            catastrophic_stall_ms: env_parse(
                "TERMINAL_WS_CATASTROPHIC_STALL_MS",
                defaults.catastrophic_stall_ms,
            ),
        }
    }
}

/// Tracks how long the connection writer's pending output bytes (queued plus
/// in-flight frame) have been continuously over `catastrophic_buffered_bytes`.
/// Mirrors `catastrophicBlocked` (`broker.ts:1087-1109`): the threshold must
/// be exceeded for the FULL stall duration, uninterrupted, before firing; any
/// tick that observes recovery resets the clock.
pub struct CatastrophicMonitor {
    threshold_bytes: usize,
    stall: Duration,
    since: Option<Instant>,
}

impl CatastrophicMonitor {
    pub fn new(threshold_bytes: usize, stall_ms: u64) -> Self {
        Self {
            threshold_bytes: threshold_bytes.max(1),
            stall: Duration::from_millis(stall_ms.max(1)),
            since: None,
        }
    }

    /// Call on each periodic check with the CURRENT pending-byte count.
    /// Returns `true` the moment sustained overflow has crossed the stall
    /// duration (fires exactly once per sustained episode; the caller is
    /// expected to close the connection immediately on `true`).
    pub fn tick(&mut self, pending_bytes: usize) -> bool {
        if pending_bytes <= self.threshold_bytes {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert_with(Instant::now);
        since.elapsed() >= self.stall
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn term09_config_defaults_match_legacy_constants() {
        let cfg = Term09Config::default();
        assert_eq!(cfg.queue_max_bytes, 32 * 1024 * 1024);
        assert_eq!(cfg.catastrophic_buffered_bytes, 16 * 1024 * 1024);
        assert_eq!(cfg.catastrophic_stall_ms, 10_000);
    }

    #[test]
    fn catastrophic_monitor_never_fires_under_threshold() {
        let mut m = CatastrophicMonitor::new(100, 10);
        for _ in 0..5 {
            assert!(!m.tick(50));
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    #[test]
    fn catastrophic_monitor_resets_on_recovery_before_stall_elapses() {
        let mut m = CatastrophicMonitor::new(100, 1000);
        assert!(!m.tick(200)); // starts the clock
        assert!(!m.tick(50)); // recovers immediately -> resets
        std::thread::sleep(Duration::from_millis(5));
        // Overflow again: a FRESH clock, so it must not have carried over
        // elapsed time from the first (reset) episode.
        assert!(!m.tick(200));
    }

    #[test]
    fn catastrophic_monitor_fires_after_sustained_overflow() {
        let mut m = CatastrophicMonitor::new(100, 20);
        assert!(!m.tick(200));
        std::thread::sleep(Duration::from_millis(35));
        assert!(
            m.tick(200),
            "sustained overflow past the stall duration must fire"
        );
    }
}

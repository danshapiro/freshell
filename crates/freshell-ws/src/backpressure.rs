//! TERM-09: per-connection terminal-output backpressure -- the async plumbing
//! a `tokio::select!` connection loop needs around
//! `freshell_terminal::output_queue::OutputQueue` (legacy: `ClientOutputQueue`),
//! plus the catastrophic-backpressure monitor (legacy: `broker.ts`'s
//! `catastrophicBlocked`, `TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES` /
//! `_STALL_MS`, `constants.ts:8-16`).
//!
//! ## Architectural mapping (why this differs from `broker.ts`)
//!
//! Legacy checks `ws.bufferedAmount` -- a value the underlying socket reports
//! WITHOUT blocking -- before every send attempt, so a stalled write is
//! observed instantly on the next flush tick. `axum`'s `WebSocket::send` has
//! no non-blocking "how much is buffered" query; the only signal is the
//! `send().await` call itself resolving (or not). This crate's connection
//! loop therefore uses [`ConnectionOutputQueue::pending_bytes`] (this
//! connection's own bounded queue depth) as the OBSERVABLE proxy for
//! `bufferedAmount`: if the drain loop can't keep up, frames pile up here
//! BEFORE ever reaching the socket, so sustained queue pressure is the same
//! signal legacy reads off the socket directly.
//!
//! One real trade-off from this mapping: [`CatastrophicMonitor::tick`] is
//! driven by a periodic ticker in the connection's `tokio::select!` loop
//! (`terminal::run`), checked BETWEEN drain attempts. If a single
//! `ws_tx.send().await` blocks indefinitely (the peer's TCP receive window is
//! fully closed and never opens again), the ticker cannot preempt that one
//! in-flight send -- the OS TCP stack's own retransmission timeout is what
//! eventually errors it out, not this monitor. Every OTHER case (a client
//! that is merely slow, or reads occasionally so each send eventually
//! resolves) is caught by the ticker exactly as intended. Regardless of
//! whether the ticker ever fires, [`ConnectionOutputQueue`]'s bound is
//! unconditional: eviction happens on every `push`, independent of whether
//! anything is currently being sent, so the "bounded server memory" half of
//! TERM-09 holds even in that worst case.
//!
//! Visible-first pacing / background throttling (legacy's
//! `TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES` /
//! `TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES` differential) is NOT ported
//! here: it depends on the attach-priority concept (`AttachPriority`,
//! foreground vs. background) that TERM-07 owns, and TERM-07 is not yet
//! implemented in this port (no connection/attachment currently carries a
//! priority at all). This module has one pacing tier, not two.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use freshell_protocol::ServerMessage;
use freshell_terminal::output_queue::{
    output_frame_meta, OutputQueue, DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES,
};

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

/// The per-connection bounded output-frame queue plus the wake signal a
/// `tokio::select!` loop needs to notice new pending output.
pub struct ConnectionOutputQueue {
    inner: Mutex<OutputQueue>,
    notify: tokio::sync::Notify,
}

impl ConnectionOutputQueue {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: Mutex::new(OutputQueue::new(max_bytes)),
            notify: tokio::sync::Notify::new(),
        }
    }

    /// Route one server message: a live terminal-output frame is measured and
    /// pushed into the bounded queue, returning `None`. Anything else is
    /// handed straight back (`Some(msg)`) so the caller sends it directly and
    /// unconditionally -- mirrors legacy exactly: only replay/live output
    /// passes through `ClientOutputQueue`; every other frame family
    /// (`attach.ready`, `terminal.created`, ...) is sent immediately and is
    /// never subject to eviction. ONE deliberate deviation: `terminal.exit`
    /// also travels the queue (non-evictable, zero-weight) to preserve its
    /// output-then-exit wire order -- see the comment inside.
    pub fn route(&self, msg: ServerMessage) -> Option<ServerMessage> {
        // `terminal.exit` is the ONE non-output frame with a producer-side
        // ordering guarantee AGAINST output: it is only ever emitted after
        // the final `terminal.output` frame (`freshell_terminal::pty`'s
        // ExitHook contract; the registry's attach enqueues ready -> replay
        // -> exit). Sending it on the direct channel while output waits in
        // this queue would invert that order on the wire -- the connection
        // loop drains direct frames FIRST -- and the client's exit teardown
        // then discards the still-queued replay/final output (blank exited
        // pane on attach-to-exited; truncated tail on a busy live exit). It
        // therefore travels the SAME FIFO, as a non-evictable, zero-weight
        // sequenced frame (never dropped, never counted as backpressure).
        if matches!(msg, ServerMessage::TerminalExit(_)) {
            {
                let mut queue = self.inner.lock().expect("output queue mutex poisoned");
                queue.push_sequenced(msg);
            }
            self.notify.notify_one();
            return None;
        }
        let Some(meta) = output_frame_meta(&msg) else {
            // Not a queueable output frame -- hand it straight back so the
            // caller sends it directly and unconditionally.
            return Some(msg);
        };
        let bytes = serde_json::to_vec(&msg).map(|v| v.len()).unwrap_or(0);
        {
            let mut queue = self.inner.lock().expect("output queue mutex poisoned");
            queue.push(msg, bytes, meta);
        }
        self.notify.notify_one();
        None
    }

    /// Resolves whenever new output has been routed here since the last
    /// resolution (a single missed wake still resolves immediately -- the
    /// caller always drains everything pending, so no wake-up is lost).
    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    /// Drain everything currently queued (gaps first, then frames, in order).
    pub fn drain_all(&self) -> Vec<ServerMessage> {
        self.inner
            .lock()
            .expect("output queue mutex poisoned")
            .drain_all()
    }

    /// Bytes currently retained -- the OBSERVABLE backpressure proxy (see
    /// module doc) fed to [`CatastrophicMonitor::tick`].
    pub fn pending_bytes(&self) -> usize {
        self.inner
            .lock()
            .expect("output queue mutex poisoned")
            .pending_bytes()
    }
}

/// Tracks how long [`ConnectionOutputQueue::pending_bytes`] has been
/// continuously over `catastrophic_buffered_bytes`. Mirrors
/// `catastrophicBlocked` (`broker.ts:1087-1109`): the threshold must be
/// exceeded for the FULL stall duration, uninterrupted, before firing; any
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

    /// The producer-side invariant "terminal.exit can never overtake the
    /// final terminal.output frames" (freshell-terminal/src/pty.rs:47-55;
    /// registry attach enqueues ready -> replay -> exit) must survive the
    /// connection loop's dual-channel design: output frames travel this
    /// bounded queue while direct frames travel `conn_rx`, and the loop
    /// drains `conn_rx` FIRST (terminal.rs `output_queue.notified()` arm).
    /// If `route` hands a `TerminalExit` straight back while output is
    /// pending here, the exit deterministically overtakes the replay on the
    /// wire and the client's exit teardown discards the still-queued
    /// scrollback (blank exited pane -- DEFECT 5b resurfaced at the ws
    /// layer). `terminal.exit` must therefore travel the SAME FIFO.
    #[test]
    fn terminal_exit_never_overtakes_queued_output() {
        let q = ConnectionOutputQueue::new(1_000_000);
        let output = ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "final error text".to_string(),
            seq_start: 1,
            seq_end: 1,
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
            attach_request_id: Some("req-1".to_string()),
            source: None,
            runtime: None,
        });
        assert!(q.route(output).is_none(), "output frame is queued");

        let exit = ServerMessage::TerminalExit(freshell_protocol::TerminalExit {
            exit_code: 1,
            terminal_id: "t".to_string(),
            runtime: None,
        });
        assert!(
            q.route(exit).is_none(),
            "terminal.exit must travel the same FIFO as queued output, \
             else it overtakes the replay/final output on the wire"
        );

        let drained = q.drain_all();
        assert_eq!(drained.len(), 2);
        assert!(
            matches!(drained[0], ServerMessage::TerminalOutput(_)),
            "output first, got {:?}",
            drained[0]
        );
        assert!(
            matches!(drained[1], ServerMessage::TerminalExit(_)),
            "exit strictly after the output it followed, got {:?}",
            drained[1]
        );
    }

    #[test]
    fn connection_output_queue_routes_output_frames_and_passes_through_others() {
        let q = ConnectionOutputQueue::new(1_000_000);
        let output = ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "hi".to_string(),
            seq_end: 0,
            seq_start: 0,
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
            attach_request_id: None,
            source: None,
            runtime: None,
        });
        assert!(
            q.route(output).is_none(),
            "an output frame must be consumed by the queue"
        );
        assert!(q.pending_bytes() > 0);

        let non_output = ServerMessage::TerminalDetached(freshell_protocol::TerminalIdOnly {
            terminal_id: "t".to_string(),
        });
        let bounced = q.route(non_output.clone());
        assert_eq!(
            bounced,
            Some(non_output),
            "a non-output frame must be handed straight back for direct send"
        );
    }

    /// Mode replay-sync DIRECT-CHANNEL PIN (plan round-4 pin): unlike
    /// `terminal.exit`'s deliberate carve-out INTO the queue (to preserve
    /// output-then-exit order), `terminal.modes.sync` must route the DIRECT
    /// channel — its whole contract is ready < sync < replay emitted inside
    /// the attach critical section, and queueing it would both reorder it
    /// behind prior live output and expose it to overflow eviction. Covers
    /// the `route` path that the TerminalExit carve-out refactor could
    /// otherwise capture it through.
    #[test]
    fn terminal_modes_sync_routes_direct_channel_never_queued() {
        let q = ConnectionOutputQueue::new(1_000_000);
        // ... even with output already pending in the queue.
        let output = ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "pending output".to_string(),
            seq_end: 0,
            seq_start: 0,
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
            attach_request_id: None,
            source: None,
            runtime: None,
        });
        assert!(q.route(output).is_none(), "output frame is queued");

        let sync = ServerMessage::TerminalModesSync(freshell_protocol::TerminalModesSync {
            attach_request_id: "req-1".to_string(),
            data: "\u{1b}[?1003h".to_string(),
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
        });
        let bounced = q.route(sync.clone());
        assert_eq!(
            bounced,
            Some(sync),
            "modes.sync must be handed back for direct send, never queued"
        );
        let drained = q.drain_all();
        assert_eq!(
            drained.len(),
            1,
            "only the output frame may be retained: {drained:?}"
        );
    }
}

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
//! One consequence of that mapping shaped this module's second half:
//! [`CatastrophicMonitor::tick`] is driven by a periodic ticker in the
//! connection's `tokio::select!` loop (`terminal::run`), checked BETWEEN
//! drain attempts -- so a single `send().await` that blocks indefinitely
//! (the peer's TCP receive window fully closed and never opens again)
//! would park the whole loop and hide the stall from the ticker forever.
//! To keep the monitor's reach total, EVERY send the loop itself performs
//! is bounded by a stall window ([`Term09Config::send_stall_window_ms`],
//! legacy's `TERMINAL_STREAM_RETRY_FLUSH_MS`, `constants.ts:18-21`):
//!
//! * Terminal-OUTPUT sends -- the only autonomously-bulk family, and the
//!   one TERM-09 owns -- run as a two-phase `feed` + `flush` pass over
//!   [`HeldOutput`]. A frame is popped from the held buffer the moment the
//!   sink ACCEPTS it (`feed` resolves): transport-accepted, exactly-once,
//!   never resent and never gap-eligible -- the same line legacy draws at
//!   "`ws.send()` returned". If either phase exceeds the window the pass
//!   ends: a frame the sink never accepted goes straight back to the front
//!   of the held buffer (FIFO intact), and the caller re-arms a retry on
//!   the window cadence (legacy's `scheduleFlush(retryMs)`,
//!   `broker.ts:829-839`). Held bytes still count toward the catastrophic
//!   threshold (`pending_bytes() + HeldOutput::bytes()` at the call site),
//!   so a client that stops reading mid-flood is closed 4008 exactly as
//!   before -- an indefinitely-blocked in-flight send can no longer hide
//!   the stall from the ticker.
//! * Every OTHER send the loop performs (direct channel frames, broadcast
//!   frames, keepalive pings, close frames) uses the same bounded window
//!   via [`send_guarded`]; a stall there is treated like a hard send
//!   failure and closes the connection. Those frame families are ones
//!   legacy never drops silently, and legacy's own remedy for a socket
//!   that can't accept them is closing (`ws-send.ts`'s
//!   buffered>2 MiB -> `close(4008)`); the client's reconnect re-runs the
//!   full handshake resync. Because EVERY send the loop performs carries
//!   the window, the loop can never park inside ANY in-flight send: each
//!   `select!` arm stays live, ordinary frames keep flowing between stall
//!   retries, the catastrophic ticker keeps ticking, and a wedged client
//!   with BELOW-catastrophic pressure still falls to the ordinary
//!   keepalive close -- the same end state as legacy's missed-pong
//!   `ws.terminate()` (`ws-handler.ts:745-755`, `PING_INTERVAL_MS` default
//!   30s, matched by `WsState::ping_interval_ms`).
//!
//! Regardless of whether any close ever fires, [`ConnectionOutputQueue`]'s
//! bound remains unconditional (eviction on every `push`), and
//! [`HeldOutput`] holds at most one drain generation, so the "bounded
//! server memory" half of TERM-09 holds in every case.
//!
//! Honest residual (pre-existing, deliberately unchanged): sends issued
//! INSIDE inbound-message handling (`handle_client_text` error/ack/create
//! replies) still await without the window. Those replies only exist in
//! response to an inbound frame the client managed to send, they are
//! small, and threading the window through that call tree is out of
//! TERM-09's lane.
//!
//! Visible-first pacing / background throttling (legacy's
//! `TERMINAL_FOREGROUND_REPLAY_BUFFERED_PAUSE_BYTES` /
//! `TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES` differential) is NOT ported
//! here: it depends on the attach-priority concept (`AttachPriority`,
//! foreground vs. background) that TERM-07 owns, and TERM-07 is not yet
//! implemented in this port (no connection/attachment currently carries a
//! priority at all). This module has one pacing tier, not two.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::Message;
use futures_util::{Sink, SinkExt};

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
    /// Stall window applied to EVERY send the connection loop performs
    /// (legacy: `constants.ts:18-21` `TERMINAL_STREAM_RETRY_FLUSH_MS`, env
    /// same name). Doubles as the wedged-flush retry cadence (legacy's
    /// `scheduleFlush(retryMs)`); see the module doc for why a bounded send
    /// is what makes the catastrophic monitor's reach total in the Rust port.
    pub send_stall_window_ms: u64,
}

impl Default for Term09Config {
    fn default() -> Self {
        Self {
            queue_max_bytes: DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES,
            catastrophic_buffered_bytes: 16 * 1024 * 1024,
            catastrophic_stall_ms: 10_000,
            send_stall_window_ms: 50,
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
            send_stall_window_ms: env_parse(
                "TERMINAL_STREAM_RETRY_FLUSH_MS",
                defaults.send_stall_window_ms,
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
    /// (`attach.ready`, `terminal.created`, `terminal.exit`, ...) is sent
    /// immediately and is never subject to eviction.
    pub fn route(&self, msg: ServerMessage) -> Option<ServerMessage> {
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

/// Tracks how long this connection's output pressure
/// ([`ConnectionOutputQueue::pending_bytes`] PLUS any [`HeldOutput`] bytes
/// -- drained-but-not-yet-transport-accepted frames are still this
/// connection's pressure) has been continuously over
/// `catastrophic_buffered_bytes`. Mirrors `catastrophicBlocked`
/// (`broker.ts:1087-1109`): the threshold must be exceeded for the FULL
/// stall duration, uninterrupted, before firing; any tick that observes
/// recovery resets the clock.
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

/// Frames DRAINED out of the bounded queue but not yet accepted by the
/// transport, held while the connection's sink is wedged (the
/// Rust-observable form of legacy pausing a flush on `bufferedAmount`).
///
/// Pure FIFO + byte accounting; the `terminal::run` flush pass pops a frame
/// ONLY when the sink accepts it and pushes it back to the front untouched
/// when the sink stalls before acceptance, so a frame in here is either
/// delivered exactly-once later or never put on the wire at all -- the
/// bytes-and-order auditable half of the "no silent loss, no duplicates"
/// contract. Bounded: at most one `drain_all` generation is ever absorbed
/// while non-empty, so `bytes() <= queue_max_bytes` always.
pub(crate) struct HeldOutput {
    /// (frame, pre-measured serialized byte len) -- measured exactly like
    /// [`ConnectionOutputQueue::route`] measures at push time, so
    /// `pending_bytes + held.bytes()` is one consistent accounting unit.
    frames: VecDeque<(ServerMessage, usize)>,
    bytes: usize,
}

impl HeldOutput {
    pub(crate) fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
        }
    }

    /// Absorb one `drain_all` batch (gaps first, then frames -- order is
    /// preserved verbatim; gap events ride along like any other drained
    /// message, they are client-visible wire traffic too).
    pub(crate) fn absorb(&mut self, drained: Vec<ServerMessage>) {
        for msg in drained {
            let bytes = serde_json::to_vec(&msg).map(|v| v.len()).unwrap_or(0);
            self.bytes += bytes;
            self.frames.push_back((msg, bytes));
        }
    }

    /// Take the oldest held frame (and its byte count) for a send attempt.
    pub(crate) fn pop_front(&mut self) -> Option<(ServerMessage, usize)> {
        let (msg, bytes) = self.frames.pop_front()?;
        self.bytes -= bytes;
        Some((msg, bytes))
    }

    /// Put back a frame the sink NEVER accepted (the `feed` phase stalled
    /// before `start_send`) -- nothing was put on the wire, so re-offering
    /// it next pass cannot duplicate anything.
    pub(crate) fn push_front(&mut self, msg: ServerMessage, bytes: usize) {
        self.bytes += bytes;
        self.frames.push_front((msg, bytes));
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Bytes still held (not yet accepted by the transport) -- the held
    /// half of the catastrophic monitor's pressure signal.
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
}

/// The result of one stall-windowed sink write (TERM-09; see module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendDisposition {
    /// The sink accepted and flushed the message within the window.
    Sent,
    /// The sink (or serialization) errored.
    Failed,
    /// The write did not complete within the stall window -- the
    /// Rust-observable form of legacy's "bufferedAmount not draining". The
    /// fate of the message itself is the caller's policy (see module doc).
    Stalled,
}

/// One send bounded by the stall window. Wraps `SinkExt::send` in
/// `tokio::time::timeout`; on timeout the in-flight future is dropped, which
/// for this sink family simply leaves any already-accepted bytes in the
/// transport's own buffer (the socket is being treated as wedged/doomed by
/// every caller, so its residual state is immaterial).
pub(crate) async fn send_guarded<S>(sink: &mut S, msg: Message, window: Duration) -> SendDisposition
where
    S: Sink<Message> + Unpin,
{
    match tokio::time::timeout(window, sink.send(msg)).await {
        Ok(Ok(())) => SendDisposition::Sent,
        Ok(Err(_)) => SendDisposition::Failed,
        Err(_) => SendDisposition::Stalled,
    }
}

/// The exact catastrophic-backpressure close frame (legacy: `broker.ts:1123`
/// `ws.close(4008, 'Catastrophic backpressure')`).
pub(crate) fn catastrophic_close_frame() -> axum::extract::ws::CloseFrame {
    axum::extract::ws::CloseFrame {
        code: 4008,
        reason: "Catastrophic backpressure".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    fn out_msg(seq: i64) -> ServerMessage {
        ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "x".repeat(8),
            seq_end: seq,
            seq_start: seq,
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
            attach_request_id: None,
            source: None,
        })
    }

    #[test]
    fn term09_config_defaults_match_legacy_constants() {
        let cfg = Term09Config::default();
        assert_eq!(cfg.queue_max_bytes, 32 * 1024 * 1024);
        assert_eq!(cfg.catastrophic_buffered_bytes, 16 * 1024 * 1024);
        assert_eq!(cfg.catastrophic_stall_ms, 10_000);
        // constants.ts:18-21 TERMINAL_STREAM_RETRY_FLUSH_MS.
        assert_eq!(cfg.send_stall_window_ms, 50);
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

    #[test]
    fn held_output_fifo_and_byte_accounting() {
        let mut held = HeldOutput::new();
        assert!(held.is_empty());
        assert_eq!(held.bytes(), 0);

        let m1 = out_msg(1);
        let m2 = out_msg(2);
        let b1 = serde_json::to_vec(&m1).unwrap().len();
        let b2 = serde_json::to_vec(&m2).unwrap().len();
        held.absorb(vec![m1, m2]);
        assert!(!held.is_empty());
        assert_eq!(held.bytes(), b1 + b2);

        // Pop m1, "stall" (sink never accepted it), push it back to the
        // front: order and byte total must be restored exactly.
        let (popped, pb) = held.pop_front().expect("one frame held");
        assert_eq!(pb, b1);
        assert_eq!(held.bytes(), b2);
        held.push_front(popped, pb);
        assert_eq!(held.bytes(), b1 + b2);

        let (first, _) = held.pop_front().unwrap();
        let (second, _) = held.pop_front().unwrap();
        let ServerMessage::TerminalOutput(first) = first else {
            panic!("expected TerminalOutput");
        };
        let ServerMessage::TerminalOutput(second) = second else {
            panic!("expected TerminalOutput");
        };
        assert_eq!(first.seq_start, 1, "FIFO order must be preserved");
        assert_eq!(second.seq_start, 2);
        assert!(held.is_empty());
        assert_eq!(held.bytes(), 0);
        assert!(held.pop_front().is_none());
    }

    /// A sink that never accepts anything: poll_ready/poll_flush always
    /// pending.
    struct NeverReadySink;
    impl Sink<Message> for NeverReadySink {
        type Error = std::convert::Infallible;
        fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            unreachable!("never-ready sink never accepts")
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }
        fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A sink that errors immediately on send.
    struct FailSink;
    impl Sink<Message> for FailSink {
        type Error = std::io::Error;
        fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "boom"))
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// A sink that accepts everything immediately, recording what it took.
    #[derive(Default)]
    struct CollectSink(Vec<Message>);
    impl Sink<Message> for CollectSink {
        type Error = std::io::Error;
        fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn start_send(mut self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
            self.0.push(item);
            Ok(())
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
        fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn send_guarded_sent_when_sink_accepts() {
        let mut sink = CollectSink::default();
        let d = send_guarded(&mut sink, Message::Text("hi".into()), Duration::from_secs(5)).await;
        assert_eq!(d, SendDisposition::Sent);
        assert_eq!(sink.0.len(), 1, "the accepted message must not be lost");
    }

    #[tokio::test(start_paused = true)]
    async fn send_guarded_stalled_when_sink_never_accepts() {
        let mut sink = NeverReadySink;
        let d = send_guarded(&mut sink, Message::Text("hi".into()), Duration::from_secs(5)).await;
        assert_eq!(
            d,
            SendDisposition::Stalled,
            "a send that never completes inside the window must be observable"
        );
    }

    #[tokio::test]
    async fn send_guarded_failed_when_sink_errors() {
        let mut sink = FailSink;
        let d = send_guarded(&mut sink, Message::Text("hi".into()), Duration::from_secs(5)).await;
        assert_eq!(d, SendDisposition::Failed);
    }

    #[test]
    fn catastrophic_close_frame_matches_legacy() {
        let f = catastrophic_close_frame();
        assert_eq!(f.code, 4008);
        assert_eq!(f.reason, "Catastrophic backpressure");
    }
}

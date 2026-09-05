//! One socket writer, independent of command dispatch. No socket I/O is awaited
//! by a handler. Readiness/mode preludes and output are admitted under ONE lock,
//! preventing a replay frame from racing ahead of its prelude. Output remains
//! FIFO within each terminal (including terminal.exit), with explicit overflow
//! gaps. Cross-terminal scheduling uses focused/visible/background byte fairness
//! (connection-local presentation interest; scheduling never edits terminal
//! bytes and never attaches, resizes, spawns, or kills execution).
//!
//! Each write leases only ONE queued frame. Output already handed to the socket
//! is still included in pressure accounting until its flush finishes. Cancelling
//! an in-progress send always terminates the socket; the started frame is NEVER
//! retried on that socket (SinkExt::send is not assumed cancellation-safe) — a
//! stop carrying a close code first lets that one started frame finish
//! (bounded), then attempts a whole Close frame, never a mixed byte stream.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message};
use freshell_protocol::ServerMessage;
#[path = "terminal_delivery_queue.rs"]
mod delivery;
#[path = "terminal_interest.rs"]
mod terminal_interest;
use delivery::{Delivery, DeliveryQueue, Range};
use freshell_terminal::output_queue::output_frame_meta;
use futures_util::{Sink, SinkExt};
use terminal_interest::InterestState;
use tokio::sync::{oneshot, watch, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriterExit {
    Stopped,
    SendFailed,
    SendTimedOut,
    ControlOverflow,
    SerializationFailed,
    OutputCapacityExceeded,
}

impl WriterExit {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::Stopped => "writer_stopped",
            Self::SendFailed => "send_error",
            Self::SendTimedOut => "writer_stalled",
            Self::ControlOverflow => "control_backpressure",
            Self::SerializationFailed => "serialization_error",
            Self::OutputCapacityExceeded => "output_capacity_exceeded",
        }
    }

    pub(super) fn close_code(self) -> Option<u16> {
        match self {
            Self::SendTimedOut | Self::ControlOverflow | Self::OutputCapacityExceeded => Some(4008),
            Self::SerializationFailed => Some(1011),
            _ => None,
        }
    }
}

#[derive(Clone)]
struct Stop {
    exit: WriterExit,
    close: Option<(u16, String)>,
}

struct Control {
    frame: Message,
    bytes: usize,
    /// Admission stamp (per-connection, strictly increasing under the queue
    /// lock): decides whether an output frame may leapfrog this control.
    seq: u64,
    /// Keepalive observes the ping's flush receipt for liveness bookkeeping
    /// (pump-gone fast detection) — deadlines are tick-counted, not timed.
    flushed: Option<oneshot::Sender<()>>,
}

/// Consecutive control leases after which a pending output frame MAY be
/// leased instead of the next control — but ONLY if that output frame was
/// admitted before the oldest pending control (its admission stamp is
/// lower). Controls normally preempt (they are how the reader's answers and
/// liveness traffic jump a backlog), and ordering-bound admissions (an
/// attach's `attach.ready`/`modes.sync` prelude vs. its replay, pushed in
/// that order under one lock) must never be reordered: the stamp check keeps
/// leapfrogging restricted to strictly-older output. An unbounded control
/// stream therefore cannot starve old output all the way to the
/// catastrophic monitor, while a prelude is never overtaken by its newer
/// replay.
const CONTROL_STREAK_LIMIT: usize = 8;

struct Queues {
    output: DeliveryQueue<Message>,
    interest: InterestState,
    controls: VecDeque<Control>,
    // Includes a control frame currently being flushed, not just queued frames.
    control_bytes: usize,
    in_flight_output_bytes: usize,
    /// Consecutive control frames leased since the last output frame. See
    /// `CONTROL_STREAK_LIMIT`.
    controls_since_last_output: usize,
    /// Next admission stamp. Under the same lock as the queues, so stamps
    /// are strictly increasing in true admission order.
    next_seq: u64,
    closed: bool,
}

struct Shared {
    queues: Mutex<Queues>,
    output_limit: usize,
    control_limit: usize,
    ready: Notify,
    stop: watch::Sender<Option<Stop>>,
}

/// A nonblocking, bounded outbox. Its Sink flush means "accepted by this
/// connection's outbox", NOT "written to the network". Only WriterPump owns
/// the actual socket. Reader supervision observes that pump's result.
#[derive(Clone)]
pub(crate) struct WriterSender {
    shared: Arc<Shared>,
}

pub(super) struct WriterPump {
    shared: Arc<Shared>,
    stop: watch::Receiver<Option<Stop>>,
    write_timeout: Duration,
}

struct NextFrame {
    /// Wire-ready frame. Gap deliveries are materialized into a
    /// `terminal.output.gap` message at lease time.
    frame: Message,
    output_bytes: usize,
    control_bytes: usize,
    flushed: Option<oneshot::Sender<()>>,
}

impl WriterSender {
    pub(super) fn new(
        output_limit: usize,
        control_limit: usize,
        write_timeout: Duration,
    ) -> (Self, WriterPump) {
        let (stop_tx, stop_rx) = watch::channel(None);
        let shared = Arc::new(Shared {
            queues: Mutex::new(Queues {
                output: DeliveryQueue::new(output_limit, metadata_limit(output_limit)),
                interest: InterestState::default(),
                controls: VecDeque::new(),
                control_bytes: 0,
                in_flight_output_bytes: 0,
                controls_since_last_output: 0,
                next_seq: 0,
                closed: false,
            }),
            output_limit: output_limit.max(1),
            control_limit: control_limit.max(1),
            ready: Notify::new(),
            stop: stop_tx,
        });
        (
            Self {
                shared: Arc::clone(&shared),
            },
            WriterPump {
                shared,
                stop: stop_rx,
                write_timeout,
            },
        )
    }

    fn stop(&self, stop: Stop) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return;
        }
        queues.closed = true;
        // Publish while holding the admission lock: no later producer can be
        // accepted between closure and publication of the stop reason.
        self.shared.stop.send_replace(Some(stop));
    }

    pub(super) fn stop_without_close(&self) {
        self.stop(Stop {
            exit: WriterExit::Stopped,
            close: None,
        });
    }

    fn fail(&self, exit: WriterExit) {
        self.stop(Stop {
            exit,
            close: exit
                .close_code()
                .map(|code| (code, exit.reason().to_string())),
        });
    }

    fn push_control(
        &self,
        frame: Message,
        flushed: Option<oneshot::Sender<()>>,
        supersedes_terminal: Option<&str>,
    ) -> Result<(), WriterExit> {
        if let Message::Close(close) = frame {
            self.stop(Stop {
                exit: WriterExit::Stopped,
                close: close.map(|close| (close.code, close.reason.to_string())),
            });
            return Ok(());
        }
        // Charge a fixed per-entry allowance as well: zero-byte pings must
        // not create a count-unbounded control queue. This is a memory budget.
        // Note the worst case adds to the output cap: one connection can hold
        // up to output_limit + control_limit bytes.
        let bytes = frame_bytes(&frame).saturating_add(128);
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Err(WriterExit::Stopped);
        }
        let would_exceed = bytes
            > self
                .shared
                .control_limit
                .saturating_sub(queues.control_bytes);
        // Always admit ONE frame into an empty lane, even one larger than the
        // budget itself (a screenshot frame can legitimately exceed a small
        // configured budget): an oversize single control must not close an
        // otherwise-idle connection. CONTINUED flooding still overflows —
        // admission fails while any oversize frame remains in flight.
        if would_exceed && queues.control_bytes > 0 {
            drop(queues);
            self.fail(WriterExit::ControlOverflow);
            return Err(WriterExit::ControlOverflow);
        }
        if let Some(terminal_id) = supersedes_terminal {
            queues.output.discard_terminal(terminal_id);
        }
        queues.control_bytes += bytes;
        let seq = queues.next_seq;
        queues.next_seq += 1;
        queues.controls.push_back(Control {
            frame,
            bytes,
            seq,
            flushed,
        });
        drop(queues);
        self.shared.ready.notify_one();
        Ok(())
    }

    /// Registry/screenshot callbacks use this route rather than bypassing the
    /// outbox. Prelude insertion is complete before the producer appends replay.
    pub(super) fn push_server(&self, msg: ServerMessage) -> bool {
        let supersedes = match &msg {
            ServerMessage::TerminalAttachReady(ready) => Some(ready.terminal_id.clone()),
            _ => None,
        };
        let meta = output_frame_meta(&msg);
        let exit = matches!(&msg, ServerMessage::TerminalExit(_));
        // Serialized exactly once, at admission: the delivery queue stores wire
        // frames, because byte cost and class fairness are admission-time
        // properties and scheduling treats payloads as opaque. (This supersedes
        // the typed-message queue's lease-time serialization, which measured at
        // push and re-serialized at every lease.)
        let json = match serde_json::to_string(&msg) {
            Ok(json) => json,
            Err(_) => {
                self.fail(WriterExit::SerializationFailed);
                return false;
            }
        };
        if meta.is_none() && !exit {
            return self
                .push_control(Message::Text(json.into()), None, supersedes.as_deref())
                .is_ok();
        }
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return false;
        }
        let seq = queues.next_seq;
        queues.next_seq += 1;
        let bytes = json.len();
        if let Some(meta) = meta {
            let range = Range {
                stream_id: meta.stream_id,
                attach_request_id: meta.attach_request_id,
                from_seq: meta.seq_start,
                to_seq: meta.seq_end,
            };
            let priority = queues.interest.priority(&meta.terminal_id);
            if queues
                .output
                .push(
                    &meta.terminal_id,
                    priority,
                    Message::Text(json.into()),
                    bytes,
                    Some(range),
                    seq,
                )
                .is_err()
            {
                drop(queues);
                self.fail(WriterExit::OutputCapacityExceeded);
                return false;
            }
        } else {
            // Preserve final-output -> exit. It must not use the control lane.
            let ServerMessage::TerminalExit(exit) = msg else {
                unreachable!("sequenced exit only")
            };
            let priority = queues.interest.priority(&exit.terminal_id);
            // Sequenced exits are zero-weight, exactly as legacy queued them:
            // they can never force an eviction nor close the connection, and
            // they still cost one service unit per frame (count-bounded by
            // the metadata limit).
            if queues
                .output
                .push(
                    &exit.terminal_id,
                    priority,
                    Message::Text(json.into()),
                    0,
                    None,
                    seq,
                )
                .is_err()
            {
                drop(queues);
                self.fail(WriterExit::OutputCapacityExceeded);
                return false;
            }
            // A dead terminal never needs its attach fallback again.
            queues.interest.detach(&exit.terminal_id);
        }
        drop(queues);
        self.shared.ready.notify_one();
        true
    }

    pub(super) fn enable_terminal_interest(&self) {
        self.shared
            .queues
            .lock()
            .expect("writer queue lock")
            .interest
            .enable();
    }

    /// Apply one full presentation-interest snapshot. A rejected snapshot is
    /// returned without replacing the last accepted state; scheduling changes
    /// are queued-data-only (no attach, resize, spawn, or kill).
    pub(super) fn set_terminal_interest(
        &self,
        snapshot: &freshell_protocol::client_messages::TerminalInterest,
    ) -> Result<(), &'static str> {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Err("Connection writer is closed");
        }
        if queues.interest.apply(snapshot)? {
            let Queues {
                output, interest, ..
            } = &mut *queues;
            output.update_priorities(|id| interest.priority(id));
        }
        drop(queues);
        self.shared.ready.notify_one();
        Ok(())
    }

    /// Pre-snapshot fallback: a client that never negotiated terminalInterestV1
    /// still gets its declared `terminal.attach.priority` honored.
    pub(super) fn set_attachment_priority(&self, terminal_id: &str, background: bool) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return;
        }
        queues.interest.attach(terminal_id, background);
        let Queues {
            output, interest, ..
        } = &mut *queues;
        output.update_priorities(|id| interest.priority(id));
    }

    /// Detach drops this connection's queued delivery AND its fallback
    /// attachment priority. The next attach sets its own fallback before its
    /// replay is admitted.
    pub(super) fn discard_terminal_delivery(&self, terminal_id: &str) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        queues.output.discard_terminal(terminal_id);
        queues.interest.detach(terminal_id);
    }

    pub(super) fn queue_ping(&self) -> Result<oneshot::Receiver<()>, WriterExit> {
        let (tx, rx) = oneshot::channel();
        self.push_control(Message::Ping(Vec::new().into()), Some(tx), None)?;
        Ok(rx)
    }

    pub(super) fn pending_output_bytes(&self) -> usize {
        let queues = self.shared.queues.lock().expect("writer queue lock");
        queues
            .output
            .pending_bytes()
            .saturating_add(queues.in_flight_output_bytes)
    }
}

impl Sink<Message> for WriterSender {
    type Error = WriterExit;

    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let closed = self.shared.queues.lock().expect("writer queue lock").closed;
        Poll::Ready(if closed {
            Err(WriterExit::Stopped)
        } else {
            Ok(())
        })
    }

    fn start_send(self: Pin<&mut Self>, frame: Message) -> Result<(), Self::Error> {
        self.push_control(frame, None, None)
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.stop_without_close();
        Poll::Ready(Ok(()))
    }
}

// Count-bound metadata independently of the wire-byte budget. Gap metadata
// and zero-byte sequenced controls (terminal.exit) cannot form an unbounded
// queue.
fn metadata_limit(output_limit: usize) -> usize {
    (output_limit / 64).clamp(64, 262_144)
}

fn frame_bytes(frame: &Message) -> usize {
    match frame {
        Message::Text(text) => text.len(),
        Message::Binary(data) | Message::Ping(data) | Message::Pong(data) => data.len(),
        Message::Close(Some(close)) => 2 + close.reason.len(),
        Message::Close(None) => 0,
    }
}

impl WriterPump {
    fn take_next(&self) -> Result<Option<NextFrame>, WriterExit> {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        if queues.closed {
            return Ok(None);
        }
        let output_pending = queues.output.has_pending();
        let control_waiting = !queues.controls.is_empty();
        // Fairness never reorders a control behind output that was admitted
        // AFTER it (a prelude must stay ahead of its replay): only output
        // stamped strictly before the oldest pending control may leapfrog.
        // Gap heads carry no stamp and never leapfrog; sequenced exits DO
        // keep their admission stamp and may leapfrog a control streak —
        // admission order (and hence exit-behind-final-output within a
        // terminal) is preserved either way.
        let output_may_leapfrog = match (queues.output.front_stamp(), queues.controls.front()) {
            (Some(stamp), Some(control)) => stamp < control.seq,
            (Some(_), None) => true,
            (None, _) => false,
        };
        let take_output = output_pending
            && (!control_waiting
                || (queues.controls_since_last_output >= CONTROL_STREAK_LIMIT
                    && output_may_leapfrog));
        if take_output {
            let Some(delivery) = queues.output.pop() else {
                return Ok(None);
            };
            let (frame, bytes) = match delivery {
                Delivery::Frame { payload, bytes } => (payload, bytes),
                Delivery::Gap { terminal_id, range } => {
                    let message =
                        ServerMessage::TerminalOutputGap(freshell_protocol::TerminalOutputGap {
                            terminal_id,
                            stream_id: range.stream_id,
                            attach_request_id: range.attach_request_id,
                            from_seq: range.from_seq,
                            to_seq: range.to_seq,
                            reason: freshell_protocol::TerminalOutputGapReason::QueueOverflow,
                        });
                    let json = serde_json::to_string(&message)
                        .map_err(|_| WriterExit::SerializationFailed)?;
                    let bytes = json.len();
                    (Message::Text(json.into()), bytes)
                }
            };
            // The leased frame stays charged to the budget until its flush
            // finishes (or the writer dies); the rest of the backlog remains
            // queued and accounted.
            queues.in_flight_output_bytes = bytes;
            queues.output.set_reserved_bytes(bytes);
            queues.controls_since_last_output = 0;
            return Ok(Some(NextFrame {
                frame,
                control_bytes: 0,
                output_bytes: bytes,
                flushed: None,
            }));
        }
        if let Some(control) = queues.controls.pop_front() {
            queues.controls_since_last_output += 1;
            return Ok(Some(NextFrame {
                frame: control.frame,
                control_bytes: control.bytes,
                output_bytes: 0,
                flushed: control.flushed,
            }));
        }
        Ok(None)
    }

    fn finish_frame(&self, output_bytes: usize, control_bytes: usize) {
        let mut queues = self.shared.queues.lock().expect("writer queue lock");
        queues.control_bytes = queues.control_bytes.saturating_sub(control_bytes);
        queues.in_flight_output_bytes = queues.in_flight_output_bytes.saturating_sub(output_bytes);
        let reserved = queues.in_flight_output_bytes;
        queues.output.set_reserved_bytes(reserved);
    }

    /// Generic over the real transport so tests can stop a flush at a precise
    /// boundary without depending on OS socket buffer sizes or wall-clock races.
    pub(super) async fn run<S>(mut self, mut socket: S) -> WriterExit
    where
        S: Sink<Message> + Unpin,
    {
        loop {
            let stop = self.stop.borrow().clone();
            if let Some(stop) = stop {
                // There is no pending send at this boundary. A bounded best-
                // effort close preserves 4009/4008 when the transport can write.
                if let Some((code, reason)) = stop.close {
                    let _ = tokio::time::timeout(
                        Duration::from_millis(250),
                        socket.send(Message::Close(Some(CloseFrame {
                            code,
                            reason: reason.into(),
                        }))),
                    )
                    .await;
                }
                return stop.exit;
            }
            let next = match self.take_next() {
                Ok(Some(next)) => next,
                Ok(None) => {
                    tokio::select! {
                        _ = self.shared.ready.notified() => {},
                        _ = self.stop.changed() => {},
                    }
                    continue;
                }
                Err(exit) => return exit,
            };
            let NextFrame {
                frame,
                output_bytes,
                control_bytes,
                flushed,
            } = next;
            // Never cancel-and-restart a send to service another frame. Stop or
            // timeout below returns from run and drops the entire socket.
            let sent = tokio::select! {
                biased;
                result = tokio::time::timeout(self.write_timeout, socket.send(frame)) => {
                    match result {
                        Ok(Ok(())) => true,
                        Ok(Err(_)) => return WriterExit::SendFailed,
                        Err(_) => return WriterExit::SendTimedOut,
                    }
                },
                _ = self.stop.changed() => false,
            };
            if !sent {
                let (exit, close) = {
                    // End the watch borrow before Drop acquires the queue lock.
                    let stop = self.stop.borrow();
                    let exit = stop
                        .as_ref()
                        .map(|stop| stop.exit)
                        .unwrap_or(WriterExit::Stopped);
                    let close = stop.as_ref().and_then(|stop| stop.close.clone());
                    (exit, close)
                };
                if let Some((code, reason)) = close {
                    // The cancelled send may have left a started frame
                    // buffered inside the transport; CONTINUING that flush is
                    // unambiguous (it resumes the same frame — this is not a
                    // retry). Only once the buffer has drained may a whole
                    // Close frame be written. Both steps are bounded; failure
                    // simply falls through to exit, and the peer sees the
                    // abnormal close that real network failure always meant.
                    let finished =
                        tokio::time::timeout(Duration::from_millis(250), socket.flush()).await;
                    if matches!(finished, Ok(Ok(()))) {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(250),
                            socket.send(Message::Close(Some(CloseFrame {
                                code,
                                reason: reason.into(),
                            }))),
                        )
                        .await;
                    }
                }
                return exit;
            }
            self.finish_frame(output_bytes, control_bytes);
            if let Some(receipt) = flushed {
                let _ = receipt.send(());
            }
            // No drain-all local vector: reconsider newly admitted controls
            // between every output frame, and yield even on an always-ready sink.
            tokio::task::yield_now().await;
        }
    }
}

impl Drop for WriterPump {
    fn drop(&mut self) {
        // Also runs if the connection task aborts the writer. Stale FrameSink
        // callbacks cannot keep filling an outbox with no consumer.
        if let Ok(mut queues) = self.shared.queues.lock() {
            queues.closed = true;
            queues.controls.clear();
            queues.control_bytes = 0;
            queues.in_flight_output_bytes = 0;
            queues.controls_since_last_output = 0;
            queues.output = DeliveryQueue::new(
                self.shared.output_limit,
                metadata_limit(self.shared.output_limit),
            );
            queues.interest = InterestState::default();
        }
    }
}

struct Outstanding {
    /// Flush receipt; `None` once the ping's flush has been observed. Pure
    /// liveness bookkeeping (a Closed receipt detects a dead pump one tick
    /// early) — deadlines are never derived from it.
    receipt: Option<oneshot::Receiver<()>>,
}

/// Tracks the keepalive transaction in TICK CYCLES, not wall clock — exactly
/// the legacy `pong_since_last_ping` contract (`ws.on('pong')`,
/// ws-handler.ts:1149-1150): a ping queued at tick N must be answered before
/// tick N+1 fires, or the connection is dead. Detection lands at exactly one
/// tick boundary by construction, immune to interval-timer jitter, and
/// healthy connections emit exactly one ping per tick. At most one ping is
/// outstanding. A pong arrival while nothing is outstanding is consumed when
/// the next ping is queued and grants NO exemption (legacy's initial-flag
/// consumption has the same shape; a transport pong carries no cookie, so
/// only arrival order matters).
#[derive(Default)]
pub(super) struct Keepalive {
    outstanding: Option<Outstanding>,
    pong: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum KeepaliveError {
    TimedOut,
    Writer(WriterExit),
}

impl Keepalive {
    pub(super) fn observe_pong(&mut self) {
        self.pong = true;
    }

    pub(super) fn tick(&mut self, sender: &WriterSender) -> Result<(), KeepaliveError> {
        if let Some(outstanding) = &mut self.outstanding {
            if let Some(receipt) = &mut outstanding.receipt {
                match receipt.try_recv() {
                    Ok(()) => outstanding.receipt = None, // flush observed
                    Err(oneshot::error::TryRecvError::Empty) => {}
                    // The pump is gone without ever flushing this ping; its
                    // task result carries the precise cause
                    // (SendFailed/SendTimedOut/…) — "stopped" is the only
                    // fact this edge can know.
                    Err(oneshot::error::TryRecvError::Closed) => {
                        return Err(KeepaliveError::Writer(WriterExit::Stopped));
                    }
                }
            }
            if !self.pong {
                // One full cycle with no answer — dead peer (flushed but
                // unanswered) or a wedged socket (never even flushed:
                // controls preempt output, so a full silent cycle is never
                // the peer's fault).
                return Err(KeepaliveError::TimedOut);
            }
            self.outstanding = None; // answered within its cycle
        }
        let receipt = sender.queue_ping().map_err(KeepaliveError::Writer)?;
        self.outstanding = Some(Outstanding {
            receipt: Some(receipt),
        });
        self.pong = false;
        Ok(())
    }
}

/// A dropping connection must not detach a blocked socket-writer task.
pub(super) struct AbortWriterOnDrop(pub(super) tokio::task::AbortHandle);
impl Drop for AbortWriterOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
#[path = "connection_writer_tests.rs"]
mod tests;

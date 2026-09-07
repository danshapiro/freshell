//! TERM-09 output-frame identity and the default per-connection byte cap.
//!
//! The bounded, drop-oldest, byte-fair per-connection terminal-output queue
//! itself lives in `freshell-ws::terminal::connection_writer`'s
//! `terminal_delivery_queue` module: connection-local focused/visible/
//! background scheduling with a global-oldest evictable index, generation-
//! scoped gap coalescing, and non-evictable ZERO-WEIGHT sequenced controls
//! (`terminal.exit` can never be dropped, evicted, or trip the byte cap;
//! it is count-bounded by the independent metadata limit). Connection death
//! with 4008 happens only when evictable output is exhausted while over the
//! cap. This module keeps only the pieces that are referenced
//! across crate boundaries: the default cap and the output-frame metadata
//! extraction the writer needs to classify and (on eviction) synthesize a
//! [`ServerMessage::TerminalOutputGap`] with
//! `reason: TerminalOutputGapReason::QueueOverflow` (legacy parity:
//! `client-output-queue.ts` `extendGap` + `broker.ts` `sendGap`).

use std::collections::VecDeque;

use freshell_protocol::{ServerMessage, TerminalOutputGap, TerminalOutputGapReason};

/// Default cap (legacy: `client-output-queue.ts:33`
/// `DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES = 32 * 1024 * 1024`).
pub const DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// The identity fields a queued output frame needs so a gap event can be
/// built if it's later evicted. Mirrors the fields `ReplayFrame` carries in
/// legacy (`seqStart`/`seqEnd`/`streamId`) plus the `attachRequestId`
/// `client-output-queue.ts`'s `GapEvent` omits but `broker.ts` attaches when
/// sending (`sendGap`, `broker.ts:1717-1739`) -- carried here instead so
/// the delivery queue alone is sufficient to build the exact wire shape.
#[derive(Debug, Clone)]
pub struct OutputFrameMeta {
    pub terminal_id: String,
    pub stream_id: String,
    pub seq_start: i64,
    pub seq_end: i64,
    pub attach_request_id: Option<String>,
}

/// Extract [`OutputFrameMeta`] from a `ServerMessage` if it's a live terminal
/// output frame (`TerminalOutput` or `TerminalOutputBatch`) -- the ONLY two
/// variants legacy's `ClientOutputQueue` ever queues. Returns `None` for
/// every other variant, telling the caller to deliver it directly instead
/// (unbounded, exactly as legacy never subjects it to the cap).
pub fn output_frame_meta(msg: &ServerMessage) -> Option<OutputFrameMeta> {
    match msg {
        ServerMessage::TerminalOutput(out) => Some(OutputFrameMeta {
            terminal_id: out.terminal_id.clone(),
            stream_id: out.stream_id.clone(),
            seq_start: out.seq_start,
            seq_end: out.seq_end,
            attach_request_id: out.attach_request_id.clone(),
        }),
        ServerMessage::TerminalOutputBatch(batch) => Some(OutputFrameMeta {
            terminal_id: batch.terminal_id.clone(),
            stream_id: batch.stream_id.clone(),
            seq_start: batch.seq_start,
            seq_end: batch.seq_end,
            attach_request_id: Some(batch.attach_request_id.clone()),
        }),
        _ => None,
    }
}

struct QueuedItem {
    msg: ServerMessage,
    bytes: usize,
    /// `Some` for a measured, evictable output frame; `None` for a sequenced
    /// control frame ([`OutputQueue::push_sequenced`]) that must keep its
    /// FIFO position relative to output but is NEVER evicted and carries no
    /// queued-byte weight.
    meta: Option<OutputFrameMeta>,
}

/// A pending, not-yet-delivered gap. Kept per-stream (mirrors legacy's
/// `pendingGaps: GapEvent[]`) so two different terminals overflowing on the
/// same connection don't clobber each other's gap range.
#[derive(Debug, Clone, PartialEq)]
struct PendingGap {
    terminal_id: String,
    stream_id: String,
    from_seq: i64,
    to_seq: i64,
    attach_request_id: Option<String>,
}

/// Bounded, drop-oldest queue of live terminal-output frames for ONE
/// connection. See the module doc for the full legacy mapping.
pub struct OutputQueue {
    max_bytes: usize,
    items: VecDeque<QueuedItem>,
    total_bytes: usize,
    pending_gaps: Vec<PendingGap>,
    dropped_frames: u64,
}

impl OutputQueue {
    /// Mirrors `resolveMaxBytes` (`client-output-queue.ts:35-46`): no
    /// artificial floor beyond avoiding zero (a zero cap would still work --
    /// every frame is immediately evicted -- but is never a legacy-observed
    /// configuration, so it's guarded to `1` for sanity).
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes: max_bytes.max(1),
            items: VecDeque::new(),
            total_bytes: 0,
            pending_gaps: Vec::new(),
            dropped_frames: 0,
        }
    }

    pub fn with_default_max_bytes() -> Self {
        Self::new(DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES)
    }

    /// Configured cap, for callers that need to report/compare it (e.g. the
    /// catastrophic-backpressure monitor uses a SEPARATE, larger threshold
    /// against [`Self::pending_bytes`]).
    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// Push one live output frame with its pre-measured serialized byte size
    /// (mirrors `enqueue(frame, queuedBytes = frame.bytes)`). Evicts the
    /// oldest frames first if this push takes the queue over `max_bytes`.
    pub fn push(&mut self, msg: ServerMessage, bytes: usize, meta: OutputFrameMeta) {
        self.items.push_back(QueuedItem {
            msg,
            bytes,
            meta: Some(meta),
        });
        self.total_bytes += bytes;
        self.evict_overflow();
    }

    /// Push a sequenced CONTROL frame (e.g. `terminal.exit`) that must be
    /// delivered strictly AFTER every output frame already queued here, but
    /// is never itself evicted and never counts toward the byte budget.
    ///
    /// Why: the producer side guarantees `terminal.exit` is emitted only
    /// after the final `terminal.output` frame (`crate::pty`'s ExitHook
    /// contract; the registry's attach enqueues ready -> replay -> exit). A
    /// connection loop that sends direct frames ahead of this queue would
    /// invert that order whenever output is still pending -- the client's
    /// exit teardown then discards the queued replay (a blank exited pane).
    /// Routing the exit through the SAME FIFO preserves the wire order.
    /// Zero-byte weight keeps `evict_overflow`'s loop invariant airtight
    /// (`total_bytes > max_bytes` always implies an evictable frame exists)
    /// and keeps [`Self::pending_bytes`] an output-only backpressure proxy.
    pub fn push_sequenced(&mut self, msg: ServerMessage) {
        self.items.push_back(QueuedItem {
            msg,
            bytes: 0,
            meta: None,
        });
    }

    /// Bytes currently retained (NEVER exceeds `max_bytes` after `push`
    /// returns -- the bounded-memory guarantee TERM-09 requires).
    pub fn pending_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn pending_frames(&self) -> usize {
        self.items.len()
    }

    /// Total frames evicted over this queue's lifetime (diagnostic/testing
    /// only; not part of the wire protocol).
    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }

    pub fn has_pending(&self) -> bool {
        !self.pending_gaps.is_empty() || !self.items.is_empty()
    }

    /// Drain everything currently queued, IN ORDER: every pending gap FIRST
    /// (mirrors `prepareBatch`, which always emits `pendingGaps` ahead of
    /// frames, `client-output-queue.ts:76-78`), then every retained frame in
    /// FIFO order. Resets the queue to empty.
    pub fn drain_all(&mut self) -> Vec<ServerMessage> {
        let mut out = Vec::with_capacity(self.pending_gaps.len() + self.items.len());
        for gap in self.pending_gaps.drain(..) {
            out.push(ServerMessage::TerminalOutputGap(TerminalOutputGap {
                from_seq: gap.from_seq,
                to_seq: gap.to_seq,
                reason: TerminalOutputGapReason::QueueOverflow,
                stream_id: gap.stream_id,
                terminal_id: gap.terminal_id,
                attach_request_id: gap.attach_request_id,
                runtime: None,
            }));
        }
        for item in self.items.drain(..) {
            out.push(item.msg);
        }
        self.total_bytes = 0;
        out
    }

    fn evict_overflow(&mut self) {
        while self.total_bytes > self.max_bytes {
            // Evict the OLDEST measured output frame; sequenced control
            // frames (`push_sequenced`, meta `None`) keep their FIFO slot and
            // are never dropped -- losing a queued `terminal.exit` would
            // leave the client's pane running forever. They carry zero bytes,
            // so `total_bytes > max_bytes` guarantees an evictable frame
            // exists (the `else break` is unreachable-in-practice safety).
            let Some(index) = self.items.iter().position(|item| item.meta.is_some()) else {
                break;
            };
            let Some(dropped) = self.items.remove(index) else {
                break;
            };
            self.total_bytes -= dropped.bytes;
            self.dropped_frames += 1;
            let meta = dropped.meta.expect("evicted items carry output meta");
            self.extend_gap(meta);
        }
    }

    /// Coalesce a newly-evicted frame's range into the LAST pending gap if it
    /// shares the same stream and is contiguous with (or overlapping) it;
    /// otherwise start a new pending gap. Mirrors `extendGap`
    /// (`client-output-queue.ts:196-211`) exactly, including checking only
    /// the LAST entry (not a full scan) -- evictions are always FIFO-ordered
    /// per stream, so the last entry is always the correct merge candidate.
    fn extend_gap(&mut self, meta: OutputFrameMeta) {
        if let Some(last) = self.pending_gaps.last_mut() {
            if last.stream_id == meta.stream_id && meta.seq_start <= last.to_seq + 1 {
                last.from_seq = last.from_seq.min(meta.seq_start);
                last.to_seq = last.to_seq.max(meta.seq_end);
                return;
            }
        }
        self.pending_gaps.push(PendingGap {
            terminal_id: meta.terminal_id,
            stream_id: meta.stream_id,
            from_seq: meta.seq_start,
            to_seq: meta.seq_end,
            attach_request_id: meta.attach_request_id,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output_msg(seq_start: i64, seq_end: i64) -> (ServerMessage, OutputFrameMeta) {
        let msg = ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "x".repeat(10),
            seq_end,
            seq_start,
            stream_id: "stream-1".to_string(),
            terminal_id: "term-1".to_string(),
            attach_request_id: Some("req-1".to_string()),
            source: None,
            runtime: None,
        });
        let meta = output_frame_meta(&msg).expect("TerminalOutput is queueable");
        (msg, meta)
    }

    fn push_frame(q: &mut OutputQueue, seq_start: i64, seq_end: i64, bytes: usize) {
        let (msg, meta) = output_msg(seq_start, seq_end);
        q.push(msg, bytes, meta);
    }

    #[test]
    fn output_frame_meta_recognizes_only_output_variants() {
        let (msg, _) = output_msg(0, 0);
        assert!(output_frame_meta(&msg).is_some());

        let non_output = ServerMessage::TerminalOutputGap(TerminalOutputGap {
            from_seq: 0,
            to_seq: 0,
            reason: TerminalOutputGapReason::QueueOverflow,
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
            attach_request_id: None,
            runtime: None,
        });
        assert!(
            output_frame_meta(&non_output).is_none(),
            "non-output frames must never be treated as queueable output"
        );
    }

    /// Mode replay-sync DIRECT-CHANNEL PIN (plan round-4 pin): a
    /// `terminal.modes.sync` frame is control-plane by wire contract — the
    /// registry emits it inside the attach critical section, strictly between
    /// `attach.ready` and the replay, and it carries no seq fields. The whole
    /// ready < sync < replay ordering guarantee relies on it NEVER entering
    /// this queue (where overflow eviction or supersede/detach discards could
    /// lose or reorder it). If a future edit teaches `output_frame_meta` to
    /// match this variant, this test must fail — the reroute would be a wire
    /// regression, not a refactor.
    #[test]
    fn modes_sync_is_never_treated_as_queueable_output() {
        let sync = ServerMessage::TerminalModesSync(freshell_protocol::TerminalModesSync {
            attach_request_id: "req-1".to_string(),
            data: "\u{1b}[?1003h".to_string(),
            stream_id: "s".to_string(),
            terminal_id: "t".to_string(),
        });
        assert!(
            output_frame_meta(&sync).is_none(),
            "terminal.modes.sync must stay on the direct channel, never the output queue"
        );
    }

    #[test]
    fn frames_within_cap_are_all_retained_in_order_with_no_gap() {
        let mut q = OutputQueue::new(1_000_000);
        push_frame(&mut q, 0, 0, 100);
        push_frame(&mut q, 1, 1, 100);
        push_frame(&mut q, 2, 2, 100);

        assert_eq!(q.pending_bytes(), 300);
        assert_eq!(q.dropped_frames(), 0);

        let drained = q.drain_all();
        assert_eq!(drained.len(), 3, "no gap event; exactly the 3 frames");
        for (i, msg) in drained.iter().enumerate() {
            let ServerMessage::TerminalOutput(out) = msg else {
                panic!("expected TerminalOutput, got {msg:?}");
            };
            assert_eq!(out.seq_start, i as i64);
        }
    }

    /// Core TERM-09 bounded-memory proof: pushing far past the cap NEVER
    /// leaves more than `max_bytes` retained.
    #[test]
    fn pending_bytes_never_exceeds_the_configured_cap_under_flood() {
        let max_bytes = 1_000usize;
        let mut q = OutputQueue::new(max_bytes);
        for i in 0..500i64 {
            push_frame(&mut q, i, i, 100);
            assert!(
                q.pending_bytes() <= max_bytes,
                "pending_bytes {} exceeded cap {} after frame {i}",
                q.pending_bytes(),
                max_bytes
            );
        }
        assert!(q.dropped_frames() > 0, "flood should have evicted frames");
    }

    /// Drop-oldest: the newest frames survive, the oldest are evicted first.
    #[test]
    fn overflow_evicts_oldest_frames_first() {
        let mut q = OutputQueue::new(250); // room for ~2 frames of 100 bytes
        push_frame(&mut q, 0, 0, 100);
        push_frame(&mut q, 1, 1, 100);
        push_frame(&mut q, 2, 2, 100); // pushes total to 300 > 250 -> evict seq 0

        let drained = q.drain_all();
        // First entry is the coalesced gap for the evicted frame(s); the rest
        // are the retained frames in order.
        let ServerMessage::TerminalOutputGap(gap) = &drained[0] else {
            panic!("expected a gap event first, got {:?}", drained[0]);
        };
        assert_eq!(gap.reason, TerminalOutputGapReason::QueueOverflow);
        assert_eq!(gap.from_seq, 0);
        assert_eq!(gap.to_seq, 0);

        let surviving: Vec<i64> = drained[1..]
            .iter()
            .map(|m| match m {
                ServerMessage::TerminalOutput(out) => out.seq_start,
                other => panic!("expected TerminalOutput, got {other:?}"),
            })
            .collect();
        assert_eq!(
            surviving,
            vec![1, 2],
            "oldest (seq 0) must be dropped first"
        );
    }

    /// Contiguous evictions on the SAME stream coalesce into ONE gap event,
    /// not one per dropped frame (mirrors `extendGap`).
    #[test]
    fn contiguous_drops_on_the_same_stream_coalesce_into_one_gap() {
        let mut q = OutputQueue::new(150); // room for ~1 frame; every push after evicts
        for i in 0..10i64 {
            push_frame(&mut q, i, i, 100);
        }
        let drained = q.drain_all();
        let gap_count = drained
            .iter()
            .filter(|m| matches!(m, ServerMessage::TerminalOutputGap(_)))
            .count();
        assert_eq!(
            gap_count, 1,
            "contiguous same-stream drops must coalesce into exactly one gap event"
        );
        let ServerMessage::TerminalOutputGap(gap) = &drained[0] else {
            panic!("expected gap first");
        };
        assert_eq!(gap.from_seq, 0);
        // 10 pushes of 100 bytes each into a 150-byte cap: only the LAST
        // frame (seq 9) fits after eviction settles.
        assert_eq!(gap.to_seq, 8);
    }

    fn exit_msg(terminal_id: &str) -> ServerMessage {
        ServerMessage::TerminalExit(freshell_protocol::TerminalExit {
            exit_code: 0,
            terminal_id: terminal_id.to_string(),
            runtime: None,
        })
    }

    /// A sequenced control frame keeps its FIFO position: output pushed
    /// before it drains before it, output pushed after drains after it.
    #[test]
    fn sequenced_frame_preserves_fifo_position_relative_to_output() {
        let mut q = OutputQueue::new(1_000_000);
        push_frame(&mut q, 1, 1, 100);
        q.push_sequenced(exit_msg("term-1"));

        let drained = q.drain_all();
        assert_eq!(drained.len(), 2);
        assert!(matches!(drained[0], ServerMessage::TerminalOutput(_)));
        assert!(
            matches!(drained[1], ServerMessage::TerminalExit(_)),
            "exit stays strictly after the output it followed"
        );
    }

    /// A sequenced control frame is NEVER evicted by an overflow (losing a
    /// queued `terminal.exit` would leave the pane running forever), carries
    /// no byte weight, and never appears in a gap range.
    #[test]
    fn sequenced_frame_survives_overflow_eviction_and_carries_no_weight() {
        let mut q = OutputQueue::new(150); // room for ~1 output frame
        push_frame(&mut q, 1, 1, 100);
        q.push_sequenced(exit_msg("term-1"));
        assert_eq!(q.pending_bytes(), 100, "sequenced frames weigh nothing");

        // Another terminal floods the SAME connection queue past the cap:
        // eviction must skip the sequenced frame and drop output only.
        push_frame(&mut q, 2, 2, 100); // 200 > 150 -> evict oldest OUTPUT (seq 1)
        assert!(q.pending_bytes() <= 150);

        let drained = q.drain_all();
        let ServerMessage::TerminalOutputGap(gap) = &drained[0] else {
            panic!("expected the overflow gap first, got {:?}", drained[0]);
        };
        assert_eq!((gap.from_seq, gap.to_seq), (1, 1), "gap covers output only");
        assert!(
            drained
                .iter()
                .any(|m| matches!(m, ServerMessage::TerminalExit(_))),
            "the sequenced exit must survive eviction: {drained:?}"
        );
        // And it still sits BEFORE the output that was pushed after it.
        let exit_pos = drained
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalExit(_)))
            .unwrap();
        let out_pos = drained
            .iter()
            .position(|m| matches!(m, ServerMessage::TerminalOutput(_)))
            .unwrap();
        assert!(exit_pos < out_pos, "FIFO position preserved: {drained:?}");
    }

    /// Two different terminals/streams overflowing on the SAME connection's
    /// queue get SEPARATE gap events, never merged across streams.
    #[test]
    fn drops_on_different_streams_produce_separate_gap_events() {
        let mut q = OutputQueue::new(150);
        // Stream A overflows first.
        let (msg_a0, meta_a0) = output_msg(0, 0);
        q.push(msg_a0, 100, meta_a0);
        let (msg_a1, meta_a1) = output_msg(1, 1);
        q.push(msg_a1, 100, meta_a1); // evicts A's seq 0

        // Stream B frames (different stream_id).
        let mut msg_b = ServerMessage::TerminalOutput(freshell_protocol::TerminalOutput {
            data: "y".repeat(10),
            seq_end: 0,
            seq_start: 0,
            stream_id: "stream-2".to_string(),
            terminal_id: "term-2".to_string(),
            attach_request_id: None,
            source: None,
            runtime: None,
        });
        let meta_b = output_frame_meta(&msg_b).unwrap();
        q.push(msg_b.clone(), 100, meta_b); // evicts A's seq 1 (queue already at 100, +100 = 200 > 150)

        // A second B frame evicts the FIRST B frame -- a different stream
        // than A's already-pending gap, so it must start its own entry.
        if let ServerMessage::TerminalOutput(ref mut out) = msg_b {
            out.seq_start = 1;
            out.seq_end = 1;
        }
        let meta_b2 = output_frame_meta(&msg_b).unwrap();
        q.push(msg_b, 100, meta_b2);

        let drained = q.drain_all();
        let gaps: Vec<&TerminalOutputGap> = drained
            .iter()
            .filter_map(|m| match m {
                ServerMessage::TerminalOutputGap(g) => Some(g),
                _ => None,
            })
            .collect();
        assert_eq!(
            gaps.len(),
            2,
            "stream-1 and stream-2 overflow independently -> two gap events, got {gaps:?}"
        );
        assert!(gaps.iter().any(|g| g.stream_id == "stream-1"));
        assert!(gaps.iter().any(|g| g.stream_id == "stream-2"));
    }
}

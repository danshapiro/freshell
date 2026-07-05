//! The authoritative seq'd replay buffer — an **identical port** of
//! `server/terminal-stream/replay-deque.ts` (`ReplayDeque`) and the byte-truncation
//! slice of `server/terminal-stream/replay-ring.ts` (`ReplayRing`).
//!
//! This is the **highest-fidelity area (T1)** — spec `terminal-core.md §3`. The
//! seq/byte contract lives entirely here, not in the char scrollback:
//!
//! - `nextSeq` starts at **1**, `head` at **0** (`replay-deque.ts:41-42`).
//! - Each append: `seq = nextSeq++`, `seqStart = seqEnd = seq`, `head = seq`
//!   (`59-66`). **One appended fragment = one seq = one frame.**
//! - `bytes = Buffer.byteLength(data, 'utf8')` — **UTF-8 byte length** (`68`),
//!   even though batch offsets (deferred to 3.3b) are UTF-16.
//! - Byte-budget eviction is **whole-frame, FIFO** (`159-187`); default cap is
//!   `DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 1 MiB` (`replay-ring.ts:22`).
//!
//! ## 3.3a scope boundary (see `stub_3b`)
//!
//! [`ReplayRing::append`] performs the deterministic byte-boundary truncation
//! (`normalizeFrameData`) but **not** the stateful VT barrier scanner: every frame
//! is emitted as `barrier = false` (transparent ground). The barrier classification
//! and the `wasTruncated -> conservative 'control'` path (`replay-ring.ts:63-78,
//! 115-129`) are 3.3b. This is a faithful subset: `barrier` only drives
//! `terminal.output.batch` framing, which is itself deferred.

use std::time::{SystemTime, UNIX_EPOCH};

/// `DEFAULT_STREAM_ID = 'stream-1'` (`replay-deque.ts:12`).
pub const DEFAULT_STREAM_ID: &str = "stream-1";
/// `DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 1024 * 1024` (`replay-ring.ts:22`).
pub const DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES: usize = 1024 * 1024;
/// `COMPACT_MIN_EVICTED_FRAMES = 1024` (`replay-deque.ts:14`).
const COMPACT_MIN_EVICTED_FRAMES: usize = 1024;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One retained replay frame (`ReplayFrame`, `replay-ring.ts:9-20`).
///
/// The 3.3b barrier-scanner fields (`barrierReason`, `scannerStateBefore/After`)
/// are omitted here; `barrier` is present but always `false` in 3.3a.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplayFrame {
    pub seq_start: i64,
    pub seq_end: i64,
    pub data: String,
    /// `Buffer.byteLength(data, 'utf8')` — UTF-8 byte length.
    pub bytes: usize,
    /// `Date.now()` at append; not byte-diffed by the oracle (masked `<TS:n>`).
    pub at: u64,
    pub stream_id: String,
    /// Always `false` in 3.3a (barrier scanner deferred to 3.3b).
    pub barrier: bool,
}

/// `ReplayDequeAppendInput` (`replay-deque.ts:16-24`) — the 3.3a subset.
#[derive(Debug, Clone, Default)]
pub struct ReplayFrameInput {
    pub data: String,
    /// Defaults to [`DEFAULT_STREAM_ID`] when `None`.
    pub stream_id: Option<String>,
    /// Defaults to `false`.
    pub barrier: bool,
    /// Defaults to `Date.now()` when `None`.
    pub at: Option<u64>,
}

/// Result of a replay query (`{ frames, missedFromSeq? }`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReplaySince {
    pub frames: Vec<ReplayFrame>,
    pub missed_from_seq: Option<i64>,
}

/// `normalizeMaxBytes` (`replay-deque.ts:26-31`): finite & > 0 -> floor, else 0.
fn normalize_max_bytes(max_bytes: i64) -> usize {
    if max_bytes > 0 {
        max_bytes as usize
    } else {
        0
    }
}

/// `ReplayDeque` (`replay-deque.ts:37`) — seq assignment, UTF-8 byte accounting,
/// whole-frame FIFO byte-budget eviction, and seq-window replay.
#[derive(Debug)]
pub struct ReplayDeque {
    frames: Vec<ReplayFrame>,
    start_index: usize,
    retained_bytes: usize,
    next_seq: i64,
    head: i64,
    max_bytes: usize,
    retention_loss_pending: bool,
}

impl ReplayDeque {
    pub fn new(max_bytes: i64) -> Self {
        Self {
            frames: Vec::new(),
            start_index: 0,
            retained_bytes: 0,
            next_seq: 1,
            head: 0,
            max_bytes: normalize_max_bytes(max_bytes),
            retention_loss_pending: false,
        }
    }

    /// `setMaxBytes` (`replay-deque.ts:50-55`).
    pub fn set_max_bytes(&mut self, next_max_bytes: i64) {
        let normalized = normalize_max_bytes(next_max_bytes);
        if normalized == self.max_bytes {
            return;
        }
        self.max_bytes = normalized;
        self.evict_if_needed();
    }

    /// `append` (`replay-deque.ts:57-81`). Assigns the next seq, appends one frame,
    /// then evicts front-to-back until within the byte budget.
    pub fn append(&mut self, input: ReplayFrameInput) -> ReplayFrame {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.head = seq;

        let bytes = input.data.len(); // Rust String::len() == UTF-8 byte length.
        let frame = ReplayFrame {
            seq_start: seq,
            seq_end: seq,
            data: input.data,
            bytes,
            at: input.at.unwrap_or_else(now_ms),
            stream_id: input.stream_id.unwrap_or_else(|| DEFAULT_STREAM_ID.to_string()),
            barrier: input.barrier,
        };

        self.frames.push(frame.clone());
        self.retained_bytes += bytes;
        self.evict_if_needed();
        frame
    }

    /// `consumeRetentionLoss` (`replay-deque.ts:83-87`) — read-and-clear.
    pub fn consume_retention_loss(&mut self) -> bool {
        let pending = self.retention_loss_pending;
        self.retention_loss_pending = false;
        pending
    }

    /// `replaySince` (`replay-deque.ts:89-98`).
    pub fn replay_since(&self, since_seq: Option<i64>) -> ReplaySince {
        let normalized = self.normalize_since_seq(since_seq);
        let missed_from_seq = self.missed_from_seq(normalized);
        if self.retained_count() == 0 {
            return ReplaySince { frames: Vec::new(), missed_from_seq };
        }
        let frames = self.collect_replay_frames(normalized, i64::MAX);
        ReplaySince { frames, missed_from_seq }
    }

    /// `totalBytes` (`replay-deque.ts:131-133`).
    pub fn total_bytes(&self) -> usize {
        self.retained_bytes
    }

    /// `headSeq` (`replay-deque.ts:135-137`) — 0 when empty, else last assigned seq.
    pub fn head_seq(&self) -> i64 {
        self.head
    }

    /// `tailSeq` (`replay-deque.ts:139-142`) — first retained `seqStart`, else `head + 1`.
    pub fn tail_seq(&self) -> i64 {
        match self.first_frame() {
            Some(first) => first.seq_start,
            None => self.head + 1,
        }
    }

    // --- private ------------------------------------------------------------

    /// `normalizeSinceSeq` (`144-146`): `undefined | 0 -> 0`; else the value.
    fn normalize_since_seq(&self, since_seq: Option<i64>) -> i64 {
        match since_seq {
            None | Some(0) => 0,
            Some(v) => v,
        }
    }

    /// `missedFromSeq` (`148-157`) — the gap detector.
    fn missed_from_seq(&self, normalized_since_seq: i64) -> Option<i64> {
        match self.first_frame() {
            None => {
                if normalized_since_seq < self.head {
                    Some(normalized_since_seq + 1)
                } else {
                    None
                }
            }
            Some(first) => {
                if normalized_since_seq < first.seq_start - 1 {
                    Some(normalized_since_seq + 1)
                } else {
                    None
                }
            }
        }
    }

    /// `evictIfNeeded` (`159-168`) — whole-frame FIFO eviction to the byte budget.
    fn evict_if_needed(&mut self) {
        while self.retained_bytes > self.max_bytes && self.retained_count() > 0 {
            let removed_bytes = self.frames[self.start_index].bytes;
            self.start_index += 1;
            self.retained_bytes -= removed_bytes;
            self.retention_loss_pending = true;
        }
        self.compact_if_needed();
    }

    /// `compactIfNeeded` (`170-187`) — reclaim the evicted prefix once it is both
    /// large in absolute terms and no smaller than the retained window.
    fn compact_if_needed(&mut self) {
        if self.start_index == 0 {
            return;
        }
        let retained = self.retained_count();
        if retained == 0 {
            self.frames.clear();
            self.start_index = 0;
            return;
        }
        if self.start_index < COMPACT_MIN_EVICTED_FRAMES || self.start_index < retained {
            return;
        }
        // frames.slice(startIndex): keep the retained tail.
        self.frames = self.frames.split_off(self.start_index);
        self.start_index = 0;
    }

    fn retained_count(&self) -> usize {
        self.frames.len() - self.start_index
    }

    fn first_frame(&self) -> Option<&ReplayFrame> {
        if self.retained_count() > 0 {
            Some(&self.frames[self.start_index])
        } else {
            None
        }
    }

    /// `firstFrameIndexAfter` (`197-209`) — binary search for the first retained
    /// frame with `seqEnd > seq`.
    fn first_frame_index_after(&self, seq: i64) -> usize {
        let mut low = self.start_index;
        let mut high = self.frames.len();
        while low < high {
            let mid = (low + high) / 2;
            if self.frames[mid].seq_end <= seq {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }

    /// `iterReplayFrames` (`211-218`) materialized — frames with `seqStart <= toSeq`
    /// starting after `sinceSeq`.
    fn collect_replay_frames(&self, since_seq: i64, to_seq: i64) -> Vec<ReplayFrame> {
        let start = self.first_frame_index_after(since_seq);
        let mut out = Vec::new();
        for frame in &self.frames[start..] {
            if frame.seq_start > to_seq {
                break;
            }
            out.push(frame.clone());
        }
        out
    }
}

/// `resolveMaxBytes` (`replay-ring.ts:31-42`): explicit > 0 -> floor; else env
/// `TERMINAL_REPLAY_RING_MAX_BYTES`; else `DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES`.
fn resolve_max_bytes(explicit: Option<i64>) -> usize {
    if let Some(v) = explicit {
        if v > 0 {
            return v as usize;
        }
    }
    let from_env = std::env::var("TERMINAL_REPLAY_RING_MAX_BYTES")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as usize);
    from_env.unwrap_or(DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES)
}

/// `ReplayRing` (`replay-ring.ts:44`) — wraps [`ReplayDeque`] and applies the
/// deterministic byte-boundary truncation before storage. Barrier classification
/// is deferred (3.3b); see the module docs.
#[derive(Debug)]
pub struct ReplayRing {
    storage: ReplayDeque,
    max_bytes: usize,
}

impl ReplayRing {
    pub fn new(max_bytes: Option<i64>) -> Self {
        let resolved = resolve_max_bytes(max_bytes);
        Self {
            storage: ReplayDeque::new(resolved as i64),
            max_bytes: resolved,
        }
    }

    /// `append` (`replay-ring.ts:62-79`) — 3.3a subset: normalize (truncate) then
    /// store as a non-barrier ground frame.
    pub fn append(&mut self, data: &str, stream_id: &str) -> ReplayFrame {
        let normalized = self.normalize_frame_data(data);
        // 3.3b: `wasTruncated` would flip this frame to a conservative 'control'
        // barrier via the scanner. Never triggers for the < maxBytes chunks T1
        // produces. See `stub_3b::conservative_truncated_classification`.
        self.storage.append(ReplayFrameInput {
            data: normalized,
            stream_id: Some(stream_id.to_string()),
            barrier: false,
            at: Some(now_ms()),
        })
    }

    pub fn consume_retention_loss(&mut self) -> bool {
        self.storage.consume_retention_loss()
    }

    pub fn replay_since(&self, since_seq: Option<i64>) -> ReplaySince {
        self.storage.replay_since(since_seq)
    }

    pub fn head_seq(&self) -> i64 {
        self.storage.head_seq()
    }

    pub fn tail_seq(&self) -> i64 {
        self.storage.tail_seq()
    }

    pub fn retained_bytes(&self) -> usize {
        self.storage.total_bytes()
    }

    pub fn retention_max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub fn set_max_bytes(&mut self, next_max_bytes: Option<i64>) {
        let resolved = resolve_max_bytes(next_max_bytes);
        if resolved == self.max_bytes {
            return;
        }
        self.max_bytes = resolved;
        self.storage.set_max_bytes(resolved as i64);
    }

    /// `normalizeFrameData` (`replay-ring.ts:139-154`) — if a single chunk exceeds
    /// `maxBytes`, truncate to the **last `maxBytes` bytes on a valid UTF-8 boundary**
    /// (the fatal-decoder walk). No-op for the sub-1-MiB chunks T1 produces.
    fn normalize_frame_data(&self, data: &str) -> String {
        if data.is_empty() {
            return String::new();
        }
        if self.max_bytes == 0 {
            return String::new();
        }
        let encoded = data.as_bytes();
        if encoded.len() <= self.max_bytes {
            return data.to_string();
        }
        let start_offset = encoded.len() - self.max_bytes;
        for start in start_offset..=encoded.len() {
            // str::from_utf8 == the fatal UTF-8 decoder: first valid boundary wins.
            if let Ok(decoded) = std::str::from_utf8(&encoded[start..]) {
                return decoded.to_string();
            }
        }
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring_input(data: &str, stream: &str) -> ReplayFrameInput {
        ReplayFrameInput {
            data: data.to_string(),
            stream_id: Some(stream.to_string()),
            barrier: false,
            at: Some(0),
        }
    }

    #[test]
    fn seq_starts_at_one_and_is_contiguous_one_per_fragment() {
        let mut deque = ReplayDeque::new(1024 * 1024);
        assert_eq!(deque.head_seq(), 0, "empty head is 0");
        assert_eq!(deque.tail_seq(), 1, "empty tail is head + 1");

        let f1 = deque.append(ring_input("a", "s"));
        assert_eq!((f1.seq_start, f1.seq_end), (1, 1));
        let f2 = deque.append(ring_input("b", "s"));
        assert_eq!((f2.seq_start, f2.seq_end), (2, 2));
        let f3 = deque.append(ring_input("c", "s"));
        assert_eq!((f3.seq_start, f3.seq_end), (3, 3));
        assert_eq!(deque.head_seq(), 3);
        assert_eq!(deque.tail_seq(), 1);
    }

    #[test]
    fn bytes_is_utf8_byte_length_not_char_count() {
        let mut deque = ReplayDeque::new(1024 * 1024);
        // "é" is 1 scalar but 2 UTF-8 bytes; "😀" is 1 scalar but 4 bytes.
        let f = deque.append(ring_input("é😀", "s"));
        assert_eq!(f.data.chars().count(), 2);
        assert_eq!(f.bytes, 6);
        assert_eq!(deque.total_bytes(), 6);
    }

    #[test]
    fn whole_frame_fifo_eviction_on_byte_budget() {
        // Budget 3 bytes: appending 1-byte frames evicts oldest whole frames.
        let mut deque = ReplayDeque::new(3);
        for c in ["a", "b", "c"] {
            deque.append(ring_input(c, "s"));
        }
        assert_eq!(deque.total_bytes(), 3);
        assert!(!deque.consume_retention_loss(), "no loss yet at exactly budget");

        let f4 = deque.append(ring_input("d", "s")); // pushes over -> evict "a"
        assert_eq!(f4.seq_start, 4);
        assert_eq!(deque.total_bytes(), 3, "still 3 retained bytes (b,c,d)");
        assert!(deque.consume_retention_loss(), "eviction set retention loss");
        assert_eq!(deque.head_seq(), 4, "head keeps advancing");
        assert_eq!(deque.tail_seq(), 2, "tail advanced past evicted seq 1");

        // seq 1 is now older than the retained window -> replay reports a gap.
        let r = deque.replay_since(Some(1));
        assert_eq!(r.frames.iter().map(|f| f.seq_start).collect::<Vec<_>>(), vec![2, 3, 4]);
        let r0 = deque.replay_since(Some(0));
        assert_eq!(r0.missed_from_seq, Some(1), "since 0 < firstSeq-1 -> missed from 1");
    }

    #[test]
    fn replay_since_window_semantics() {
        let mut deque = ReplayDeque::new(1024 * 1024);
        for c in ["a", "b", "c"] {
            deque.append(ring_input(c, "s"));
        }
        // since 0 -> all frames, no gap (window intact).
        let all = deque.replay_since(Some(0));
        assert_eq!(all.frames.len(), 3);
        assert_eq!(all.missed_from_seq, None);
        // since 1 -> frames after seq 1.
        let after1 = deque.replay_since(Some(1));
        assert_eq!(after1.frames.iter().map(|f| f.seq_start).collect::<Vec<_>>(), vec![2, 3]);
        // since head -> empty, no gap.
        let after_head = deque.replay_since(Some(3));
        assert!(after_head.frames.is_empty());
        assert_eq!(after_head.missed_from_seq, None);
    }

    #[test]
    fn ring_append_default_ring_is_1mib_and_no_op_normalizes() {
        let mut ring = ReplayRing::new(None);
        assert_eq!(ring.retention_max_bytes(), DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES);
        let f = ring.append("hello\r\n", "stream-x");
        assert_eq!(f.data, "hello\r\n");
        assert_eq!(f.bytes, 7);
        assert_eq!(f.stream_id, "stream-x");
        assert!(!f.barrier, "3.3a frames are non-barrier ground");
        assert_eq!(ring.head_seq(), 1);
    }

    #[test]
    fn normalize_truncates_oversize_chunk_on_utf8_boundary() {
        // Ring capped at 4 bytes; append "AAAA😀" (8 bytes). Must keep the last
        // 4 bytes ON a valid boundary: the 4-byte "😀" (not a split of it).
        let mut ring = ReplayRing::new(Some(4));
        let f = ring.append("AAAA😀", "s");
        assert_eq!(f.data, "😀");
        assert_eq!(f.bytes, 4);
    }

    #[test]
    fn reassembly_by_seq_start_concatenates_data_in_order() {
        // The T1 invariant at deque level: sort retained frames by seqStart, join
        // data -> the exact appended byte stream.
        let mut deque = ReplayDeque::new(1024 * 1024);
        for chunk in ["hel", "lo\r", "\n"] {
            deque.append(ring_input(chunk, "s"));
        }
        let mut frames = deque.replay_since(Some(0)).frames;
        frames.sort_by_key(|f| f.seq_start);
        let reassembled: String = frames.iter().map(|f| f.data.as_str()).collect();
        assert_eq!(reassembled, "hello\r\n");
    }
}

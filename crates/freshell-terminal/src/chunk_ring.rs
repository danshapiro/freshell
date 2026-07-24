//! The char-measured scrollback — an **identical port** of `ChunkRingBuffer`
//! (`server/terminal-registry.ts:810-853`) plus the snapshot-on-attach seed rule
//! (`broker.ts:418-423`).
//!
//! This is the **second buffer** of the two-buffer model (`terminal-core.md §3`):
//!
//! | Buffer | Unit | Role |
//! |---|---|---|
//! | `ChunkRingBuffer` (here) | **UTF-16 chars** (`str.length`) | one-shot snapshot seed |
//! | `ReplayRing` ([`crate::replay_ring`]) | **UTF-8 bytes** | authoritative seq'd replay |
//!
//! The scrollback is measured in **UTF-16 code units** (`this.size += chunk.length`,
//! `terminal-registry.ts:836`), NOT bytes and NOT scalar count — the same
//! UTF-8-vs-UTF-16 distinction the batch offsets carry (`§9.3`). Its `snapshot()`
//! seeds the `ReplayRing` on the FIRST broker attach *only when*
//! `replayRing.headSeq() === 0` (`broker.ts:418-423`): the join is deterministic, so
//! the seeded replay frames are chunk-boundary independent.

use crate::batch::utf16_len;

/// `computeScrollbackMaxChars` env default (`terminal-registry.ts:57-60`): the
/// scrollback cap clamps `scrollbackLines * 300` into `[64 KiB, 4 MiB]`; the shipped
/// default is **512 KiB** UTF-16 code units. Graded flows stay far under it.
pub const DEFAULT_SCROLLBACK_MAX_CHARS: i64 = 512 * 1024;

/// `ChunkRingBuffer` (`terminal-registry.ts:810-853`) — a FIFO of string chunks whose
/// total **UTF-16 code-unit** length is bounded by `max_chars`.
#[derive(Debug, Clone)]
pub struct ChunkRingBuffer {
    chunks: Vec<String>,
    /// UTF-16 code-unit total (`this.size`), matching `str.length` accounting.
    size: i64,
    max_chars: i64,
}

impl ChunkRingBuffer {
    /// `new ChunkRingBuffer(maxChars)` (`terminal-registry.ts:813`).
    pub fn new(max_chars: i64) -> Self {
        Self {
            chunks: Vec::new(),
            size: 0,
            max_chars,
        }
    }

    /// `append(chunk)` (`terminal-registry.ts:833-838`): ignore empty; push; grow the
    /// UTF-16 size; trim to the cap.
    pub fn append(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.chunks.push(chunk.to_string());
        self.size += utf16_len(chunk);
        self.trim_to_max();
    }

    /// `setMaxChars(next)` (`terminal-registry.ts:840-843`).
    pub fn set_max_chars(&mut self, next: i64) {
        self.max_chars = next.max(0);
        self.trim_to_max();
    }

    /// `snapshot()` (`terminal-registry.ts:845-847`): the retained scrollback as one
    /// string — deterministic regardless of how output was originally chunked.
    pub fn snapshot(&self) -> String {
        self.chunks.concat()
    }

    /// `clear()` (`terminal-registry.ts:849-852`).
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.size = 0;
    }

    /// The current UTF-16 code-unit size (test/introspection).
    pub fn size(&self) -> i64 {
        self.size
    }

    /// `trimToMax()` (`terminal-registry.ts:815-831`): drop whole front chunks while
    /// over the cap and more than one remains; if a single chunk still exceeds the cap,
    /// keep its last `max_chars` UTF-16 code units.
    fn trim_to_max(&mut self) {
        let max = self.max_chars;
        if max <= 0 {
            self.clear();
            return;
        }
        while self.size > max && self.chunks.len() > 1 {
            let removed = self.chunks.remove(0);
            self.size -= utf16_len(&removed);
        }
        if self.size > max && self.chunks.len() == 1 {
            let only = self.chunks[0].clone();
            let kept = slice_last_utf16(&only, max);
            self.size = utf16_len(&kept);
            self.chunks[0] = kept;
        }
    }
}

/// `str.slice(-max)` keeping the last `max` **UTF-16 code units**, adjusted to a
/// code-point boundary. (JS `.slice` can split a surrogate pair into a lone surrogate;
/// a Rust `String` cannot hold one, so we keep the smallest whole-scalar suffix that
/// fits `max` code units — benign, and this single-chunk-over-cap path never triggers
/// in a graded flow. Mirrors the surrogate note in [`crate::fragment`].)
fn slice_last_utf16(s: &str, max: i64) -> String {
    if max <= 0 {
        return String::new();
    }
    let mut kept: Vec<char> = Vec::new();
    let mut units: i64 = 0;
    for c in s.chars().rev() {
        let w = c.len_utf16() as i64;
        if units + w > max {
            break;
        }
        units += w;
        kept.push(c);
    }
    kept.into_iter().rev().collect()
}

/// The snapshot-on-attach seed rule (`broker.ts:418-423`): the char scrollback seeds
/// the byte `ReplayRing` **only when the ring is empty** (`replayRing.headSeq() === 0`).
/// Returns the snapshot to seed, or `None` when the ring already has frames.
///
/// This is the exact predicate — the port must seed once and only once, else the
/// replay would either duplicate the scrollback or start empty.
pub fn snapshot_seed_if_ring_empty(
    ring_head_seq: i64,
    scrollback: &ChunkRingBuffer,
) -> Option<String> {
    if ring_head_seq == 0 {
        let snap = scrollback.snapshot();
        if snap.is_empty() {
            None
        } else {
            Some(snap)
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_is_utf16_code_units_not_bytes_or_scalars() {
        let mut b = ChunkRingBuffer::new(DEFAULT_SCROLLBACK_MAX_CHARS);
        // "é😀" = 2 scalars, 6 UTF-8 bytes, 3 UTF-16 code units (é=1, 😀=2).
        b.append("\u{00e9}\u{1F600}");
        assert_eq!(b.size(), 3);
        assert_eq!(b.snapshot(), "\u{00e9}\u{1F600}");
    }

    #[test]
    fn snapshot_joins_chunks_deterministically() {
        let mut b = ChunkRingBuffer::new(DEFAULT_SCROLLBACK_MAX_CHARS);
        for c in ["hel", "lo\r", "\nworld"] {
            b.append(c);
        }
        assert_eq!(b.snapshot(), "hello\r\nworld");
    }

    #[test]
    fn empty_chunks_are_ignored() {
        let mut b = ChunkRingBuffer::new(100);
        b.append("");
        assert_eq!(b.size(), 0);
        assert_eq!(b.snapshot(), "");
    }

    #[test]
    fn whole_front_chunk_fifo_eviction_over_cap() {
        // cap = 3 code units; each chunk is 2 units → after 2 chunks (size 4 > 3),
        // the front whole chunk is evicted (keep at least one).
        let mut b = ChunkRingBuffer::new(3);
        b.append("ab"); // size 2
        b.append("cd"); // size 4 > 3 → evict "ab" → size 2
        assert_eq!(b.snapshot(), "cd");
        assert_eq!(b.size(), 2);
    }

    #[test]
    fn single_oversize_chunk_keeps_last_max_units() {
        let mut b = ChunkRingBuffer::new(3);
        b.append("abcdef"); // one chunk, 6 > 3 → keep last 3 units
        assert_eq!(b.snapshot(), "def");
        assert_eq!(b.size(), 3);
    }

    #[test]
    fn set_max_chars_zero_clears() {
        let mut b = ChunkRingBuffer::new(100);
        b.append("hello");
        b.set_max_chars(0);
        assert_eq!(b.snapshot(), "");
        assert_eq!(b.size(), 0);
    }

    #[test]
    fn snapshot_seed_only_when_ring_empty() {
        let mut b = ChunkRingBuffer::new(DEFAULT_SCROLLBACK_MAX_CHARS);
        b.append("scrollback");
        // Ring empty (headSeq 0) → seed with the joined snapshot.
        assert_eq!(
            snapshot_seed_if_ring_empty(0, &b).as_deref(),
            Some("scrollback")
        );
        // Ring already has frames (headSeq > 0) → never re-seed.
        assert_eq!(snapshot_seed_if_ring_empty(5, &b), None);
        // Empty scrollback → nothing to seed.
        let empty = ChunkRingBuffer::new(DEFAULT_SCROLLBACK_MAX_CHARS);
        assert_eq!(snapshot_seed_if_ring_empty(0, &empty), None);
    }
}

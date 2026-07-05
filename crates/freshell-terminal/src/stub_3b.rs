//! Deferred surface for **Phase 3.3b** — clearly-marked stubs, **no behavior**.
//!
//! Everything here is explicitly OUT of the 3.3a CORE (real PTY spawn + the seq'd
//! ReplayRing + `terminal.output` framing that reproduces the T1 goldens). These
//! entry points name the remaining terminal-core behavior so the shape is visible
//! and reviewable, but each `todo!()`s — nothing in 3.3a calls them, and the T1
//! goldens do not exercise any of them.
//!
//! Each stub cites the reference `file:line` it will port. See
//! `port/machine/specs/terminal-core.md` §§3.5, 3.7, 4.2, 4.4, 5.3, 6.1.

use crate::replay_ring::ReplayFrame;

// ===========================================================================
// §4.4 — stateful VT barrier scanner (`server/terminal-stream/output-barrier-scanner.ts`)
// ===========================================================================

/// The barrier-scanner classification a frame carries once the VT parser runs
/// (`output-barrier-scanner.ts:1-6`). In 3.3a every frame is transparent ground
/// (`barrier = false`); this enum is the 3.3b target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarrierReason {
    Control,
    Osc52,
    RequestMode,
    TurnComplete,
    StartupProbe,
}

/// Port of the stateful VT parser over code points (`ground|esc|csi|osc|dcs|apc`,
/// `output-barrier-scanner.ts:8`). **[PORT RISK — highest]** (`terminal-core.md §4.4`):
/// byte-exact and stateful *across frames* (`scannerStateBefore/After` persist in the
/// ring, `replay-ring.ts:62-78`); it decides batch merge boundaries.
///
/// 3.3b. Not needed for plain `terminal.output` (one frame per message).
pub fn scan_barriers(_data: &str) -> BarrierReason {
    todo!("3.3b: port output-barrier-scanner.ts (stateful VT parser, §4.4)")
}

/// `wasTruncated -> conservative 'control'` classification (`replay-ring.ts:115-129`).
/// Only reachable when a single chunk exceeds the 1 MiB ring cap (never in T1).
pub fn conservative_truncated_classification() -> BarrierReason {
    todo!("3.3b: conservative barrier classification for truncated frames (§3.3)")
}

// ===========================================================================
// §4.2 — terminal.output.batch (`server/terminal-stream/output-batch.ts`)
// ===========================================================================

/// Merge contiguous transparent-ground frames into `terminal.output.batch` payloads
/// (`output-batch.ts:235-249,355-415`; wire build `broker.ts:1452-1520`). Gated by
/// the `terminalOutputBatchV1` capability + `attachRequestId` (`broker.ts:1315-1343`);
/// the T1 harness advertises no capabilities, so only legacy `terminal.output` is
/// emitted (`pty-capture.ts:314-315`).
///
/// 3.3b.
pub fn build_terminal_output_batches(_frames: &[ReplayFrame]) {
    todo!("3.3b: port output-batch.ts merge rule + over-budget splitting (§4.2)")
}

/// **Top risk #2** (`terminal-core.md §9.3`): `frame.bytes` is UTF-8 but a batch
/// `segment.endOffset` is a cumulative **UTF-16 code-unit** offset
/// (`output-batch.ts:194`, `str.length` units), and `serializedBytes` is a
/// self-referential JSON size fixpoint (`broker.ts:1486-1494`). A Rust port must
/// track UTF-16 offsets explicitly (Rust strings are UTF-8) — this is where a naive
/// byte-offset port diverges.
///
/// 3.3b.
pub fn segment_end_offset_utf16(_data: &str) -> i64 {
    todo!("3.3b: UTF-16 code-unit offset accounting for batch segments (§4.2/§9.3)")
}

// ===========================================================================
// §3.5 — char-measured ChunkRingBuffer attach snapshot (`terminal-registry.ts:810-853`)
// ===========================================================================

/// The second buffer: a **UTF-16 char-measured** scrollback (`TerminalRecord.buffer`,
/// `terminal-registry.ts:810-853,1644`) whose one-shot `snapshot()` seeds the ReplayRing
/// on first attach *only when* `replayRing.headSeq() === 0` (`broker.ts:418-423`).
///
/// 3.3a captures live output straight into the ReplayRing from spawn, so the snapshot
/// seed is not needed to reproduce the T1 goldens (the reassembled bytes are identical
/// either way — the golden is compared by bytes, not seq structure).
///
/// 3.3b.
pub fn attach_snapshot_seed() {
    todo!("3.3b: port ChunkRingBuffer + snapshot-on-attach seeding (§3.5)")
}

// ===========================================================================
// §3.7 — gap emission (`terminal.output.gap`)
// ===========================================================================

/// `terminal.output.gap {fromSeq,toSeq,reason}` for `replay_window_exceeded` /
/// `replay_budget_exceeded` / `queue_overflow` (`broker.ts:521-567,979-997,915-937`).
/// The T1 goldens fit the 1 MiB ring with no client backpressure, so no gap is ever
/// emitted (`pty-capture.ts` asserts `gaps` is empty).
///
/// 3.3b.
pub fn emit_output_gap() {
    todo!("3.3b: port terminal.output.gap emission (§3.7)")
}

// ===========================================================================
// §5.3 — resize / geometry epoch
// ===========================================================================

/// `terminal.resize` -> `pty.resize` with `unchanged` short-circuit
/// (`terminal-registry.ts:3975-3995`) and the broker `geometryEpoch` (+1 only on a
/// real change, `broker.ts:666-686`). The T1 harness attaches at the spawn geometry
/// (120x30) so no resize occurs.
///
/// 3.3b.
pub fn resize(_cols: u16, _rows: u16) {
    todo!("3.3b: port terminal.resize + geometryEpoch (§5.3)")
}

// ===========================================================================
// §6.1 — coding-CLI turn.complete
// ===========================================================================

/// `terminal.turn.complete {at,completionSeq,provider,...}` — **coding-CLI only**
/// (`ws-handler.ts:3742-3754`). A plain shell terminal never emits it
/// (`terminal-core.md §6.1`). Out of scope for `freshell-terminal` entirely; belongs
/// to the coding-CLI layer, listed here only to mark the boundary.
///
/// 3.3b / coding-CLI layer.
pub fn broadcast_turn_complete() {
    todo!("out of scope: terminal.turn.complete is a coding-CLI concern (§6.1)")
}

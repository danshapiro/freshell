//! `terminal.output.batch` framing — an **identical port** of
//! `server/terminal-stream/output-batch.ts` (`buildTerminalOutputBatches`, the merge
//! rule + UTF-16 segment offsets) and the broker WIRE projection
//! `broker.ts:1377-1520` (`buildTerminalOutputBatchPayloads` /
//! `buildTerminalOutputBatchPayload` / `buildTerminalOutputBatchWireSegments` + the
//! self-referential `serializedBytes` 4-pass fixpoint).
//!
//! ## Two units, one contract (`terminal-core.md §9.3`, **Top risk #2**)
//!
//! - `frame.bytes` is a **UTF-8** byte length (`replay-deque.ts:68`).
//! - a segment `offset`/`endOffset` is a cumulative **UTF-16 code-unit** offset
//!   (`output-batch.ts:194` `endOffset: offset + frame.data.length`, `str.length`).
//! - `data.slice(startOffset, endOffset)` (`broker.ts:1476`) slices by **UTF-16**
//!   code units. A Rust `&str` is UTF-8, so we track UTF-16 offsets explicitly and
//!   slice via [`slice_utf16`]. A naive byte-offset port produces wrong
//!   `endOffset`/`serializedBytes` — this module is where that bug is avoided.
//!
//! `serializedBytes` is `Buffer.byteLength(JSON.stringify(payload), 'utf8')`; JSON
//! byte length is invariant under key order and `serde_json` escapes exactly the
//! characters `JSON.stringify` does, so the fixpoint converges to the identical value.

use serde_json::{json, Map, Value};

use crate::barrier_scanner::{BarrierReason, BarrierScanner, ScannerMode, ScannerState};

/// One classified input frame to the batcher (an annotated `ReplayFrame`,
/// `output-batch.ts:56`). `bytes` is the UTF-8 byte length; `data` is the raw string.
#[derive(Debug, Clone)]
pub struct BatchInputFrame {
    pub seq_start: i64,
    pub seq_end: i64,
    pub data: String,
    pub bytes: usize,
    pub stream_id: String,
    pub barrier: bool,
    pub barrier_reason: Option<BarrierReason>,
    pub state_before: ScannerState,
    pub state_after: ScannerState,
}

impl BatchInputFrame {
    /// Build a frame + classify it with a fresh scanner (test/standalone helper).
    /// Production frames carry the ring's persisted classification.
    pub fn classified(seq: i64, data: &str, scanner: &mut BarrierScanner, stream_id: &str) -> Self {
        let c = scanner.scan(data);
        Self {
            seq_start: seq,
            seq_end: seq,
            data: data.to_string(),
            bytes: data.len(),
            stream_id: stream_id.to_string(),
            barrier: c.barrier,
            barrier_reason: c.reason,
            state_before: c.state_before,
            state_after: c.state_after,
        }
    }
}

/// A batch segment with the cumulative **UTF-16** `offset`/`endOffset`
/// (`TerminalOutputBatchSegment`, `output-batch.ts:14-25`).
#[derive(Debug, Clone, PartialEq)]
pub struct BatchSegment {
    pub seq_start: i64,
    pub seq_end: i64,
    pub stream_id: String,
    pub offset: i64,
    pub end_offset: i64,
    pub bytes: usize,
    pub barrier: bool,
    pub barrier_reason: Option<BarrierReason>,
    pub state_before: ScannerState,
    pub state_after: ScannerState,
}

/// A merged batch (`TerminalOutputBatch`, `output-batch.ts:27-36`). `data` is the
/// concatenated raw UTF-8 of the merged frames; `segments` carry per-frame UTF-16
/// offsets. `legacy_output_serialized_bytes` is the merge-budget measure (the legacy
/// `terminal.output` envelope size), NOT the wire `serializedBytes`.
#[derive(Debug, Clone)]
pub struct OutputBatch {
    pub seq_start: i64,
    pub seq_end: i64,
    pub data: String,
    pub bytes: usize,
    pub stream_id: String,
    pub attach_request_id: Option<String>,
    pub source: Option<String>,
    pub barrier: bool,
    pub barrier_reason: Option<BarrierReason>,
    pub state_before: ScannerState,
    pub state_after: ScannerState,
    pub segments: Vec<BatchSegment>,
    pub legacy_output_serialized_bytes: usize,
}

// ── UTF-16 helpers ─────────────────────────────────────────────────────────

/// `str.length` — the UTF-16 code-unit length of a string (`output-batch.ts:194`).
pub fn utf16_len(s: &str) -> i64 {
    s.chars().map(|c| c.len_utf16() as i64).sum()
}

/// `data.slice(start, end)` with **UTF-16 code-unit** offsets (`broker.ts:1476`).
/// Batch offsets always fall on code-point boundaries (frames are code-point
/// fragmented), so no surrogate is ever bisected.
pub fn slice_utf16(s: &str, start: i64, end: i64) -> String {
    let start = start.max(0);
    let end = end.max(start);
    let mut pos: i64 = 0;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16() as i64;
        // Fully inside [start, end): include (boundaries are always code-point aligned).
        if pos >= start && pos + w <= end {
            out.push(c);
        }
        pos += w;
        if pos >= end {
            break;
        }
    }
    out
}

// ── serialized-byte measurement (parity with JSON.stringify) ───────────────

/// `measureSerializedJsonBytes(payload)` = `Buffer.byteLength(JSON.stringify(payload),
/// 'utf8')` (`serialized-budget.ts:9-11`).
fn measure_json_bytes(value: &Value) -> usize {
    serde_json::to_string(value)
        .expect("terminal payload is always serializable")
        .len()
}

/// `defaultPayloadForFrame` (`output-batch.ts:83-99`) measured as the legacy
/// `terminal.output` envelope — the merge-budget size for `data`.
fn measure_legacy_output_bytes(
    terminal_id: &str,
    stream_id: &str,
    seq_start: i64,
    seq_end: i64,
    data: &str,
    attach_request_id: Option<&str>,
    source: Option<&str>,
) -> usize {
    let mut m = Map::new();
    m.insert("type".into(), json!("terminal.output"));
    m.insert("terminalId".into(), json!(terminal_id));
    m.insert("streamId".into(), json!(stream_id));
    m.insert("seqStart".into(), json!(seq_start));
    m.insert("seqEnd".into(), json!(seq_end));
    m.insert("data".into(), json!(data));
    if let Some(a) = attach_request_id {
        m.insert("attachRequestId".into(), json!(a));
    }
    if let Some(s) = source {
        m.insert("source".into(), json!(s));
    }
    measure_json_bytes(&Value::Object(m))
}

// ── the merge builder (output-batch.ts) ────────────────────────────────────

fn is_transparent_ground(frame: &BatchInputFrame) -> bool {
    !frame.barrier
        && frame.state_before.mode == ScannerMode::Ground
        && frame.state_after.mode == ScannerMode::Ground
}

fn segment_for_frame(frame: &BatchInputFrame, offset: i64) -> BatchSegment {
    BatchSegment {
        seq_start: frame.seq_start,
        seq_end: frame.seq_end,
        stream_id: frame.stream_id.clone(),
        offset,
        end_offset: offset + utf16_len(&frame.data),
        bytes: frame.bytes,
        barrier: frame.barrier,
        barrier_reason: if frame.barrier {
            frame.barrier_reason
        } else {
            None
        },
        state_before: frame.state_before,
        state_after: frame.state_after,
    }
}

/// A batch under construction (`MutableTerminalOutputBatch`, `output-batch.ts:58-72`).
struct MutableBatch {
    seq_start: i64,
    seq_end: i64,
    chunks: Vec<String>,
    data_length: i64, // cumulative UTF-16 length
    bytes: usize,
    stream_id: String,
    attach_request_id: Option<String>,
    source: Option<String>,
    state_before: ScannerState,
    state_after: ScannerState,
    segments: Vec<BatchSegment>,
    legacy_output_serialized_bytes: usize,
}

/// Input parameters shared across the merge (`TerminalOutputBatchBuildInput`).
pub struct BatchBuildInput<'a> {
    pub frames: &'a [BatchInputFrame],
    pub max_serialized_bytes: i64,
    pub max_total_serialized_bytes: Option<i64>,
    pub terminal_id: String,
    pub attach_request_id: Option<String>,
    pub source: Option<String>,
}

fn normalize_budget(v: i64) -> i64 {
    if v > 0 {
        v
    } else {
        0
    }
}

impl<'a> BatchBuildInput<'a> {
    fn frame_attach_request_id(&self, frame: &BatchInputFrame) -> Option<String> {
        // frame.attachRequestId ?? input.attachRequestId — the ring frames don't carry
        // a per-frame attachRequestId in this port, so this is always the input value.
        let _ = frame;
        self.attach_request_id.clone()
    }

    fn measure_legacy_for(
        &self,
        data: &str,
        seq_start: i64,
        seq_end: i64,
        stream_id: &str,
    ) -> usize {
        measure_legacy_output_bytes(
            &self.terminal_id,
            stream_id,
            seq_start,
            seq_end,
            data,
            self.attach_request_id.as_deref(),
            self.source.as_deref(),
        )
    }
}

fn can_merge(current: &MutableBatch, next: &BatchInputFrame, input: &BatchBuildInput) -> bool {
    if !is_transparent_ground(next) {
        return false;
    }
    if current.state_before.mode != ScannerMode::Ground
        || current.state_after.mode != ScannerMode::Ground
    {
        return false;
    }
    if next.seq_start != current.seq_end + 1 {
        return false;
    }
    if next.stream_id != current.stream_id {
        return false;
    }
    if input.frame_attach_request_id(next) != current.attach_request_id {
        return false;
    }
    if input.source != current.source {
        return false;
    }
    true
}

fn start_mutable_batch(frame: &BatchInputFrame, input: &BatchBuildInput) -> MutableBatch {
    let attach_request_id = input.frame_attach_request_id(frame);
    let legacy = input.measure_legacy_for(
        &frame.data,
        frame.seq_start,
        frame.seq_end,
        &frame.stream_id,
    );
    MutableBatch {
        seq_start: frame.seq_start,
        seq_end: frame.seq_end,
        chunks: vec![frame.data.clone()],
        data_length: utf16_len(&frame.data),
        bytes: frame.bytes,
        stream_id: frame.stream_id.clone(),
        attach_request_id,
        source: input.source.clone(),
        state_before: frame.state_before,
        state_after: frame.state_after,
        segments: vec![segment_for_frame(frame, 0)],
        legacy_output_serialized_bytes: legacy,
    }
}

/// `measureMergedBatch` (`output-batch.ts:305-335`) — legacy envelope size of the
/// merged data if `next` were appended.
fn measure_merged(
    current: &MutableBatch,
    next: &BatchInputFrame,
    input: &BatchBuildInput,
) -> usize {
    let mut data = current.chunks.concat();
    data.push_str(&next.data);
    input.measure_legacy_for(&data, current.seq_start, next.seq_end, &current.stream_id)
}

fn append_mutable(current: &mut MutableBatch, next: &BatchInputFrame, legacy: usize) {
    let offset = current.data_length;
    current.seq_end = next.seq_end;
    current.chunks.push(next.data.clone());
    current.data_length += utf16_len(&next.data);
    current.bytes += next.bytes;
    current.state_after = next.state_after;
    current.segments.push(segment_for_frame(next, offset));
    current.legacy_output_serialized_bytes = legacy;
}

fn flush_mutable(b: MutableBatch) -> OutputBatch {
    OutputBatch {
        seq_start: b.seq_start,
        seq_end: b.seq_end,
        data: b.chunks.concat(),
        bytes: b.bytes,
        stream_id: b.stream_id,
        attach_request_id: b.attach_request_id,
        source: b.source,
        barrier: false,
        barrier_reason: None,
        state_before: b.state_before,
        state_after: b.state_after,
        segments: b.segments,
        legacy_output_serialized_bytes: b.legacy_output_serialized_bytes,
    }
}

fn build_single_batch(frame: &BatchInputFrame, input: &BatchBuildInput) -> OutputBatch {
    let attach_request_id = input.frame_attach_request_id(frame);
    let legacy = input.measure_legacy_for(
        &frame.data,
        frame.seq_start,
        frame.seq_end,
        &frame.stream_id,
    );
    OutputBatch {
        seq_start: frame.seq_start,
        seq_end: frame.seq_end,
        data: frame.data.clone(),
        bytes: frame.bytes,
        stream_id: frame.stream_id.clone(),
        attach_request_id,
        source: input.source.clone(),
        barrier: frame.barrier,
        barrier_reason: if frame.barrier {
            frame.barrier_reason
        } else {
            None
        },
        state_before: frame.state_before,
        state_after: frame.state_after,
        segments: vec![segment_for_frame(frame, 0)],
        legacy_output_serialized_bytes: legacy,
    }
}

/// `buildTerminalOutputBatches` (`output-batch.ts:355-415`).
#[allow(unused_assignments)] // `total_legacy` is read by the pushBatch cap on the next iter; the final write is intentionally dead.
pub fn build_terminal_output_batches(input: &BatchBuildInput) -> Vec<OutputBatch> {
    let max_serialized_bytes = normalize_budget(input.max_serialized_bytes);
    let max_total = match input.max_total_serialized_bytes {
        None => i64::MAX,
        Some(v) => normalize_budget(v),
    };
    if max_serialized_bytes <= 0 || max_total <= 0 {
        return Vec::new();
    }

    let mut batches: Vec<OutputBatch> = Vec::new();
    let mut current: Option<MutableBatch> = None;
    let mut total_legacy: i64 = 0;

    // pushBatch honoring the maxTotalSerializedBytes cap (keeps at least one).
    macro_rules! push_batch {
        ($batch:expr) => {{
            let batch: OutputBatch = $batch;
            if max_total != i64::MAX
                && total_legacy + batch.legacy_output_serialized_bytes as i64 > max_total
                && !batches.is_empty()
            {
                false
            } else {
                total_legacy += batch.legacy_output_serialized_bytes as i64;
                batches.push(batch);
                true
            }
        }};
    }

    for frame in input.frames {
        if !is_transparent_ground(frame) {
            if let Some(cur) = current.take() {
                if !push_batch!(flush_mutable(cur)) {
                    return batches;
                }
            }
            if !push_batch!(build_single_batch(frame, input)) {
                return batches;
            }
            continue;
        }

        if let Some(cur) = current.as_mut() {
            if can_merge(cur, frame, input) {
                let merged = measure_merged(cur, frame, input);
                if merged as i64 <= max_serialized_bytes {
                    append_mutable(cur, frame, merged);
                    continue;
                }
            }
        }

        if let Some(cur) = current.take() {
            if !push_batch!(flush_mutable(cur)) {
                return batches;
            }
        }
        current = Some(start_mutable_batch(frame, input));
    }

    if let Some(cur) = current.take() {
        let _ = push_batch!(flush_mutable(cur));
    }

    batches
}

// ── the wire projection (broker.ts:1377-1520) ──────────────────────────────

/// `buildTerminalOutputBatchWireSegments` (`broker.ts:1502-1520`): relative UTF-16
/// `endOffset`, `rawFrameCount`, and the `barrier` REASON string (only when a barrier).
fn wire_segments(batch: &OutputBatch, start: usize, end: usize, base_offset: i64) -> Vec<Value> {
    let mut previous_end_offset: i64 = 0;
    let mut out = Vec::new();
    for seg in &batch.segments[start..end] {
        let relative = previous_end_offset.max(seg.end_offset - base_offset);
        previous_end_offset = relative;
        let mut m = Map::new();
        m.insert("seqStart".into(), json!(seg.seq_start));
        m.insert("seqEnd".into(), json!(seg.seq_end));
        m.insert("endOffset".into(), json!(relative));
        m.insert(
            "rawFrameCount".into(),
            json!((seg.seq_end - seg.seq_start + 1).max(1)),
        );
        if seg.barrier {
            if let Some(reason) = seg.barrier_reason {
                m.insert("barrier".into(), json!(reason.as_str()));
            }
        }
        out.push(Value::Object(m));
    }
    out
}

/// `buildTerminalOutputBatchPayload` (`broker.ts:1452-1500`): one
/// `terminal.output.batch` wire payload over `segments[start..end]`, with the
/// self-referential `serializedBytes` 4-pass fixpoint.
fn build_batch_payload(
    terminal_id: &str,
    batch: &OutputBatch,
    attach_request_id: &str,
    source: &str,
    start: usize,
    end: usize,
) -> Value {
    let first = &batch.segments[start];
    let last = &batch.segments[end - 1];
    let start_offset = if start == 0 {
        0
    } else {
        batch.segments[start - 1].end_offset
    };
    let end_offset = last.end_offset;
    let data = slice_utf16(&batch.data, start_offset, end_offset);
    let segments = wire_segments(batch, start, end, start_offset);

    // basePayload with serializedBytes filled by the fixpoint.
    let base = |serialized_bytes: i64| -> Value {
        let mut m = Map::new();
        m.insert("type".into(), json!("terminal.output.batch"));
        m.insert("terminalId".into(), json!(terminal_id));
        m.insert("streamId".into(), json!(batch.stream_id));
        m.insert("attachRequestId".into(), json!(attach_request_id));
        m.insert("source".into(), json!(source));
        m.insert("seqStart".into(), json!(first.seq_start));
        m.insert("seqEnd".into(), json!(last.seq_end));
        m.insert("data".into(), json!(data));
        m.insert("serializedBytes".into(), json!(serialized_bytes));
        m.insert("segments".into(), Value::Array(segments.clone()));
        Value::Object(m)
    };

    let mut serialized_bytes: i64 = 0;
    for _ in 0..4 {
        let measured = measure_json_bytes(&base(serialized_bytes)) as i64;
        if measured == serialized_bytes {
            break;
        }
        serialized_bytes = measured;
    }
    base(serialized_bytes)
}

/// `buildTerminalOutputPayload` fallback for one oversize segment (`broker.ts:1425-1450`).
fn single_segment_fallback(
    terminal_id: &str,
    batch: &OutputBatch,
    attach_request_id: &str,
    source: &str,
    segment_index: usize,
) -> Value {
    let seg = &batch.segments[segment_index];
    let start_offset = if segment_index == 0 {
        0
    } else {
        batch.segments[segment_index - 1].end_offset
    };
    let end_offset = start_offset.max(seg.end_offset);
    let data = slice_utf16(&batch.data, start_offset, end_offset);
    let mut m = Map::new();
    m.insert("type".into(), json!("terminal.output"));
    m.insert("terminalId".into(), json!(terminal_id));
    m.insert("streamId".into(), json!(batch.stream_id));
    m.insert("seqStart".into(), json!(seg.seq_start));
    m.insert("seqEnd".into(), json!(seg.seq_end));
    m.insert("data".into(), json!(data));
    m.insert("attachRequestId".into(), json!(attach_request_id));
    m.insert("source".into(), json!(source));
    Value::Object(m)
}

fn payload_serialized_bytes(payload: &Value) -> i64 {
    payload
        .get("serializedBytes")
        .and_then(|v| v.as_i64())
        .unwrap_or(i64::MAX)
}

/// `buildTerminalOutputBatchPayloads` (`broker.ts:1377-1422`): the full batch if it
/// fits `batch_max_bytes`, else greedily repacked `terminal.output.batch` payloads
/// (a single oversize segment falls back to one `terminal.output`).
pub fn build_batch_wire_payloads(
    terminal_id: &str,
    batch: &OutputBatch,
    attach_request_id: &str,
    source: &str,
    batch_max_bytes: i64,
) -> Vec<Value> {
    let seg_count = batch.segments.len();
    if seg_count == 0 {
        return Vec::new();
    }
    let full = build_batch_payload(terminal_id, batch, attach_request_id, source, 0, seg_count);
    if payload_serialized_bytes(&full) <= batch_max_bytes {
        return vec![full];
    }
    if seg_count <= 1 {
        return vec![single_segment_fallback(
            terminal_id,
            batch,
            attach_request_id,
            source,
            0,
        )];
    }

    let mut payloads = Vec::new();
    let mut start = 0usize;
    while start < seg_count {
        let mut end = start + 1;
        let current =
            build_batch_payload(terminal_id, batch, attach_request_id, source, start, end);
        if payload_serialized_bytes(&current) > batch_max_bytes {
            payloads.push(single_segment_fallback(
                terminal_id,
                batch,
                attach_request_id,
                source,
                start,
            ));
            start = end;
            continue;
        }
        let mut best = current;
        while end < seg_count {
            let candidate = build_batch_payload(
                terminal_id,
                batch,
                attach_request_id,
                source,
                start,
                end + 1,
            );
            if payload_serialized_bytes(&candidate) > batch_max_bytes {
                break;
            }
            best = candidate;
            end += 1;
        }
        payloads.push(best);
        start = end;
    }
    payloads
}

/// Convenience: run the merge + wire projection end-to-end over classified frames,
/// producing the ordered `terminal.output.batch` / `terminal.output` wire payloads a
/// batch-capable client receives (the flush path, `broker.ts:1315-1343`).
pub fn frames_to_wire_payloads(
    frames: &[BatchInputFrame],
    terminal_id: &str,
    attach_request_id: &str,
    source: &str,
    batch_max_bytes: i64,
) -> Vec<Value> {
    let input = BatchBuildInput {
        frames,
        max_serialized_bytes: batch_max_bytes,
        max_total_serialized_bytes: None,
        terminal_id: terminal_id.to_string(),
        attach_request_id: Some(attach_request_id.to_string()),
        source: Some(source.to_string()),
    };
    let batches = build_terminal_output_batches(&input);
    let mut out = Vec::new();
    for batch in &batches {
        out.extend(build_batch_wire_payloads(
            terminal_id,
            batch,
            attach_request_id,
            source,
            batch_max_bytes,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ground(seq: i64, data: &str) -> BatchInputFrame {
        BatchInputFrame {
            seq_start: seq,
            seq_end: seq,
            data: data.to_string(),
            bytes: data.len(),
            stream_id: "stream-1".into(),
            barrier: false,
            barrier_reason: None,
            state_before: ScannerState {
                mode: ScannerMode::Ground,
            },
            state_after: ScannerState {
                mode: ScannerMode::Ground,
            },
        }
    }
    fn barrier(seq: i64, data: &str, reason: BarrierReason) -> BatchInputFrame {
        let mut f = ground(seq, data);
        f.barrier = true;
        f.barrier_reason = Some(reason);
        f
    }
    fn build(frames: Vec<BatchInputFrame>, max: i64) -> Vec<OutputBatch> {
        build_terminal_output_batches(&BatchBuildInput {
            frames: &frames,
            max_serialized_bytes: max,
            max_total_serialized_bytes: None,
            terminal_id: "term-1".into(),
            attach_request_id: Some("attach-1".into()),
            source: Some("replay".into()),
        })
    }

    // Mirrors test/unit/server/terminal-stream/output-batch.test.ts (the reference's
    // own committed expectations) — the batch builder is a faithful port.

    #[test]
    fn coalesces_contiguous_transparent_frames_with_segment_metadata() {
        let batches = build(vec![ground(1, "a"), ground(2, "b")], 16 * 1024);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].data, "ab");
        assert_eq!(batches[0].seq_start, 1);
        assert_eq!(batches[0].seq_end, 2);
        assert!(!batches[0].barrier);
        let segs = &batches[0].segments;
        assert_eq!((segs[0].offset, segs[0].end_offset), (0, 1));
        assert_eq!((segs[1].offset, segs[1].end_offset), (1, 2));
    }

    #[test]
    fn does_not_coalesce_across_barriers() {
        let batches = build(
            vec![
                ground(1, "a"),
                barrier(2, "\u{0007}", BarrierReason::TurnComplete),
                ground(3, "b"),
            ],
            16 * 1024,
        );
        assert_eq!(
            batches.iter().map(|b| b.data.clone()).collect::<Vec<_>>(),
            vec!["a", "\u{0007}", "b"]
        );
        assert_eq!(
            batches.iter().map(|b| b.seq_start).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(batches[1].barrier);
        assert_eq!(batches[1].barrier_reason, Some(BarrierReason::TurnComplete));
    }

    #[test]
    fn does_not_coalesce_across_stream_boundaries() {
        let mut f1 = ground(1, "old");
        f1.stream_id = "stream-old".into();
        let mut f2 = ground(2, "new");
        f2.stream_id = "stream-new".into();
        let batches = build(vec![f1, f2], 16 * 1024);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].data, "old");
        assert_eq!(batches[1].data, "new");
    }

    #[test]
    fn utf16_code_unit_segment_offsets_on_code_point_boundaries() {
        // "😀" is 1 scalar / 4 UTF-8 bytes / **2 UTF-16 code units**.
        let batches = build(vec![ground(1, "\u{1F600}"), ground(2, "b")], 16 * 1024);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].data, "\u{1F600}b");
        assert_eq!(
            (
                batches[0].segments[0].offset,
                batches[0].segments[0].end_offset
            ),
            (0, 2)
        );
        assert_eq!(
            (
                batches[0].segments[1].offset,
                batches[0].segments[1].end_offset
            ),
            (2, 3)
        );
    }

    #[test]
    fn coalesces_many_small_frames_without_changing_offsets() {
        let frames: Vec<_> = (1..=4096).map(|i| ground(i, "x")).collect();
        let batches = build(frames, 16 * 1024);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].seq_start, 1);
        assert_eq!(batches[0].seq_end, 4096);
        assert_eq!(batches[0].segments.len(), 4096);
        assert_eq!(
            (
                batches[0].segments[4095].offset,
                batches[0].segments[4095].end_offset
            ),
            (4095, 4096)
        );
    }

    #[test]
    fn wire_endoffset_is_utf16_not_bytes() {
        // A batch containing an emoji: the wire endOffset must be UTF-16 (2 per emoji),
        // NOT the 4-byte UTF-8 length. Slicing the data by the wire endOffsets must
        // reproduce the data exactly.
        let payloads = frames_to_wire_payloads(
            &[ground(1, "a\u{1F600}b")],
            "term-1",
            "attach-1",
            "live",
            16 * 1024,
        );
        assert_eq!(payloads.len(), 1);
        let p = &payloads[0];
        assert_eq!(p["type"], json!("terminal.output.batch"));
        let data = p["data"].as_str().unwrap();
        assert_eq!(data, "a\u{1F600}b");
        let seg = &p["segments"][0];
        // "a😀b" = 'a'(1) + 😀(2) + 'b'(1) = 4 UTF-16 units, but 6 UTF-8 bytes.
        assert_eq!(seg["endOffset"], json!(4));
        assert_ne!(seg["endOffset"], json!(6), "must NOT be the byte length");
        // serializedBytes present and self-consistent.
        assert!(p["serializedBytes"].as_i64().unwrap() > 0);
    }

    #[test]
    fn serialized_bytes_is_fixpoint_of_the_payload_json() {
        let payloads = frames_to_wire_payloads(
            &[ground(1, "hello world")],
            "term-1",
            "attach-1",
            "live",
            16 * 1024,
        );
        let p = &payloads[0];
        let claimed = p["serializedBytes"].as_i64().unwrap();
        // Re-measure the exact emitted payload: serializedBytes must equal its own
        // JSON byte length (the fixpoint converged).
        let actual = measure_json_bytes(p) as i64;
        assert_eq!(
            claimed, actual,
            "serializedBytes must equal the payload's own JSON byte length"
        );
    }

    #[test]
    fn slice_utf16_respects_code_units() {
        assert_eq!(slice_utf16("a\u{1F600}b", 0, 1), "a");
        assert_eq!(slice_utf16("a\u{1F600}b", 1, 3), "\u{1F600}");
        assert_eq!(slice_utf16("a\u{1F600}b", 3, 4), "b");
        assert_eq!(utf16_len("a\u{1F600}b"), 4);
    }
}

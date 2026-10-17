//! Bounded retained-output codec. Filesystem ownership and writer settlement
//! belong to the session host and supervisor, never to this codec.
use crate::{IncarnationId, RuntimeOutputBatch, RuntimeOutputFrame};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Seek, SeekFrom, Write};

pub const MAX_OUTPUT_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_SPOOL_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SPOOL_LINE_BYTES: usize = 6 * MAX_OUTPUT_FRAME_BYTES + 4096;
pub const SPOOL_DESCRIPTOR_FILE: &str = "terminal-spool-descriptor.json";
pub const SPOOL_COMPLETION_FILE: &str = "terminal-spool-completion.json";
pub const SPOOL_CURRENT_FILE: &str = "terminal-spool-current.jsonl";
pub const SPOOL_PREVIOUS_FILE: &str = "terminal-spool-previous.jsonl";
pub const SPOOL_CURRENT_INDEX_FILE: &str = "terminal-spool-current.index.jsonl";
pub const SPOOL_PREVIOUS_INDEX_FILE: &str = "terminal-spool-previous.index.jsonl";
pub const SPOOL_INDEX_STRIDE_BYTES: u64 = 64 * 1024;
pub const MAX_SPOOL_INDEX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpoolDescriptor {
    pub schema_version: u32,
    pub incarnation_id: IncarnationId,
    pub terminal_id: String,
    pub stream_epoch: String,
    pub segment_limit_bytes: u64,
}
impl TerminalSpoolDescriptor {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.terminal_id.is_empty()
            || self.terminal_id.len() > 1024
            || self.stream_epoch.is_empty()
            || self.stream_epoch.len() > 1024
            || self.segment_limit_bytes == 0
            || self.segment_limit_bytes > MAX_SPOOL_SEGMENT_BYTES
        {
            return Err("invalid retained output descriptor".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "availability", rename_all = "snake_case")]
pub enum TerminalExitObservation {
    Known { code: i64 },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpoolCompletion {
    pub incarnation_id: IncarnationId,
    pub terminal_id: String,
    pub stream_epoch: String,
    pub retained_from_seq: u64,
    pub head_seq: u64,
    pub exit: TerminalExitObservation,
}
impl TerminalSpoolCompletion {
    pub fn validate(&self, source: &TerminalSpoolDescriptor, head: u64) -> Result<(), String> {
        if self.incarnation_id != source.incarnation_id
            || self.terminal_id != source.terminal_id
            || self.stream_epoch != source.stream_epoch
            || self.head_seq != head
            || self.retained_from_seq == 0
            || self.retained_from_seq > head.saturating_add(1)
        {
            return Err("retained completion does not match settled source".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalSpoolFrame {
    pub frame: RuntimeOutputFrame,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "record", rename_all = "snake_case")]
pub enum TerminalSpoolIndexRecord {
    Header {
        descriptor: TerminalSpoolDescriptor,
        #[serde(default)]
        scanned_through_offset: u64,
        #[serde(default)]
        torn_tail: bool,
    },
    Checkpoint {
        seq: u64,
        offset: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSpoolIndexEntry {
    pub seq: u64,
    pub offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalSpoolIndex {
    pub checkpoints: Vec<TerminalSpoolIndexEntry>,
    /// With no matching-epoch checkpoints, this is the last complete record
    /// boundary already scanned, including records from older epochs.
    pub scanned_through_offset: u64,
    pub torn_tail: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexedSpoolReadError {
    /// The sidecar points to the wrong spool records and may be rebuilt.
    InvalidIndex(String),
    /// The source or requested page failed; retrying with a full scan is not useful.
    Other(String),
}

impl From<String> for IndexedSpoolReadError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl From<&str> for IndexedSpoolReadError {
    fn from(message: &str) -> Self {
        Self::Other(message.into())
    }
}

impl std::fmt::Display for IndexedSpoolReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidIndex(message) | Self::Other(message) => formatter.write_str(message),
        }
    }
}

pub struct IndexedSpoolSegment<R> {
    pub reader: R,
    pub file_bytes: u64,
    pub checkpoints: Vec<TerminalSpoolIndexEntry>,
    pub torn_tail: bool,
}

pub struct IndexedSpoolRead {
    pub batch: RuntimeOutputBatch,
    pub bytes_scanned: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpoolScanSummary {
    pub torn_tail: bool,
    pub bytes_scanned: u64,
    pub stopped_early: bool,
    pub last_complete_offset: u64,
}

pub fn read_spool_index<R: BufRead>(
    mut reader: R,
    source: &TerminalSpoolDescriptor,
    spool_bytes: u64,
) -> Result<TerminalSpoolIndex, String> {
    source.validate()?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut reader)
        .take((MAX_SPOOL_INDEX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "retained output index read failed")?;
    if bytes.is_empty() || bytes.len() > MAX_SPOOL_INDEX_BYTES || bytes.last() != Some(&b'\n') {
        return Err("invalid retained output index size or framing".into());
    }

    let mut lines = bytes.split(|byte| *byte == b'\n');
    let header_line = lines
        .next()
        .filter(|line| !line.is_empty())
        .ok_or("retained output index header missing")?;
    let header: TerminalSpoolIndexRecord =
        serde_json::from_slice(header_line).map_err(|_| "invalid retained output index header")?;
    let TerminalSpoolIndexRecord::Header {
        descriptor,
        scanned_through_offset,
        torn_tail,
    } = header
    else {
        return Err("retained output index header missing".into());
    };
    if descriptor != *source || scanned_through_offset > spool_bytes {
        return Err("retained output index source mismatch".into());
    }

    let mut entries = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let record: TerminalSpoolIndexRecord =
            serde_json::from_slice(line).map_err(|_| "invalid retained output index checkpoint")?;
        let TerminalSpoolIndexRecord::Checkpoint { seq, offset } = record else {
            return Err("unexpected retained output index header".into());
        };
        entries.push(TerminalSpoolIndexEntry { seq, offset });
    }
    validate_spool_index_entries(&entries, spool_bytes)?;
    Ok(TerminalSpoolIndex {
        checkpoints: entries,
        scanned_through_offset,
        torn_tail,
    })
}

pub fn validate_spool_index_entries(
    entries: &[TerminalSpoolIndexEntry],
    spool_bytes: u64,
) -> Result<(), String> {
    let maximum_entries = spool_bytes / SPOOL_INDEX_STRIDE_BYTES + 2;
    if entries.len() as u64 > maximum_entries {
        return Err("retained output index exceeds checkpoint bound".into());
    }
    let mut previous = None;
    for entry in entries {
        if entry.seq == 0
            || entry.seq >= i64::MAX as u64
            || entry.offset >= spool_bytes
            || previous.is_some_and(|(seq, offset)| entry.seq <= seq || entry.offset <= offset)
        {
            return Err("invalid retained output index checkpoint bounds".into());
        }
        previous = Some((entry.seq, entry.offset));
    }
    Ok(())
}

pub fn build_spool_index<R: BufRead>(
    reader: R,
    source: &TerminalSpoolDescriptor,
    start_offset: u64,
) -> Result<(Vec<TerminalSpoolIndexEntry>, u64, SpoolScanSummary), String> {
    let mut checkpoints = Vec::new();
    let mut head = 0;
    let summary = scan_spool_from(reader, source, start_offset, |offset, frame| {
        if checkpoints
            .last()
            .is_none_or(|last: &TerminalSpoolIndexEntry| {
                offset.saturating_sub(last.offset) >= SPOOL_INDEX_STRIDE_BYTES
            })
        {
            checkpoints.push(TerminalSpoolIndexEntry {
                seq: frame.seq_start,
                offset,
            });
        }
        head = frame.seq_end;
        Ok(false)
    })?;
    Ok((checkpoints, head, summary))
}

pub fn encode_spool_index(
    source: &TerminalSpoolDescriptor,
    checkpoints: &[TerminalSpoolIndexEntry],
    spool_bytes: u64,
    scanned_through_offset: u64,
    torn_tail: bool,
) -> Result<Vec<u8>, String> {
    validate_spool_index_entries(checkpoints, spool_bytes)?;
    if scanned_through_offset > spool_bytes {
        return Err("retained output index scan bound exceeds spool".into());
    }
    let mut bytes = Vec::new();
    write_spool_index_header(&mut bytes, source, scanned_through_offset, torn_tail)?;
    for checkpoint in checkpoints {
        write_spool_index_checkpoint(&mut bytes, *checkpoint)?;
    }
    if bytes.len() > MAX_SPOOL_INDEX_BYTES {
        return Err("retained output index exceeds byte bound".into());
    }
    Ok(bytes)
}

pub fn write_spool_index_header<W: Write>(
    writer: &mut W,
    source: &TerminalSpoolDescriptor,
    scanned_through_offset: u64,
    torn_tail: bool,
) -> Result<(), String> {
    let record = TerminalSpoolIndexRecord::Header {
        descriptor: source.clone(),
        scanned_through_offset,
        torn_tail,
    };
    serde_json::to_writer(&mut *writer, &record)
        .map_err(|_| "retained output index encoding failed")?;
    writer
        .write_all(b"\n")
        .map_err(|_| "retained output index write failed")?;
    Ok(())
}

pub fn write_spool_index_checkpoint<W: Write>(
    writer: &mut W,
    entry: TerminalSpoolIndexEntry,
) -> Result<(), String> {
    let record = TerminalSpoolIndexRecord::Checkpoint {
        seq: entry.seq,
        offset: entry.offset,
    };
    serde_json::to_writer(&mut *writer, &record)
        .map_err(|_| "retained output index encoding failed")?;
    writer
        .write_all(b"\n")
        .map_err(|_| "retained output index write failed")?;
    Ok(())
}

/// Keeps one bounded JSON line in memory. A non-newline final record is an
/// uncommitted torn tail, including valid JSON without its commit newline.
pub fn scan_spool<R: BufRead>(
    mut reader: R,
    source: &TerminalSpoolDescriptor,
    mut accept: impl FnMut(RuntimeOutputFrame) -> Result<(), String>,
) -> Result<bool, String> {
    Ok(scan_spool_from(&mut reader, source, 0, |_, frame| {
        accept(frame)?;
        Ok(false)
    })?
    .torn_tail)
}

/// Scan a spool starting at a known record boundary. The callback returns
/// `true` to stop after the current frame. `start_offset` is the byte offset
/// of the first record in `reader`; callers seeking through a sparse index
/// use it to preserve absolute offsets in the result.
pub fn scan_spool_from<R: BufRead>(
    mut reader: R,
    source: &TerminalSpoolDescriptor,
    start_offset: u64,
    mut accept: impl FnMut(u64, RuntimeOutputFrame) -> Result<bool, String>,
) -> Result<SpoolScanSummary, String> {
    source.validate()?;
    let mut bytes = Vec::new();
    let mut offset = start_offset;
    let mut summary = SpoolScanSummary {
        last_complete_offset: start_offset,
        ..SpoolScanSummary::default()
    };
    loop {
        bytes.clear();
        let length = Read::by_ref(&mut reader)
            .take((MAX_SPOOL_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "retained output read failed")?;
        if length == 0 {
            return Ok(summary);
        }
        summary.bytes_scanned = summary.bytes_scanned.saturating_add(length as u64);
        let frame_offset = offset;
        offset = offset.saturating_add(length as u64);
        if length > MAX_SPOOL_LINE_BYTES {
            return Err("retained output frame exceeds codec bound".into());
        }
        if bytes.last() != Some(&b'\n') {
            summary.torn_tail = true;
            return Ok(summary);
        }
        let row: TerminalSpoolFrame = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid committed retained output frame")?;
        summary.last_complete_offset = offset;
        let frame = row.frame;
        // A restarted host can leave its prior epoch in the bounded segments.
        if frame.stream_epoch != source.stream_epoch {
            continue;
        }
        if frame.terminal_id != source.terminal_id
            || frame.seq_start == 0
            || frame.seq_start != frame.seq_end
            || frame.seq_end >= i64::MAX as u64
            || frame.data.len() > MAX_OUTPUT_FRAME_BYTES
        {
            return Err("retained output frame ownership or bounds mismatch".into());
        }
        if accept(frame_offset, frame)? {
            summary.stopped_early = true;
            return Ok(summary);
        }
    }
}

/// Streaming page accumulator: no full-spool collection and no partial frame
/// with an advanced cursor. A too-small caller budget is an explicit error.
pub struct RetainedOutputPage {
    source: TerminalSpoolDescriptor,
    after: u64,
    budget: usize,
    first: Option<u64>,
    head: u64,
    used: usize,
    more: bool,
    frames: Vec<RuntimeOutputFrame>,
}
impl RetainedOutputPage {
    pub fn new(source: TerminalSpoolDescriptor, after: u64, budget: u64) -> Result<Self, String> {
        source.validate()?;
        Ok(Self {
            source,
            after,
            budget: budget.clamp(1, MAX_OUTPUT_FRAME_BYTES as u64) as usize,
            first: None,
            head: 0,
            used: 0,
            more: false,
            frames: vec![],
        })
    }
    pub fn accept(&mut self, frame: RuntimeOutputFrame) -> Result<(), String> {
        if self.first.is_some() && frame.seq_start != self.head.saturating_add(1) {
            return Err("retained output sequences are not contiguous".into());
        }
        self.first.get_or_insert(frame.seq_start);
        self.head = frame.seq_end;
        if frame.seq_end <= self.after {
            return Ok(());
        }
        let cost = frame.data.len().max(1);
        if self.frames.is_empty() && cost > self.budget {
            return Err("output budget cannot hold a complete retained frame".into());
        }
        if self.more || self.used.saturating_add(cost) > self.budget {
            self.more = true;
        } else {
            self.used += cost;
            self.frames.push(frame);
        }
        Ok(())
    }

    pub fn should_stop_scanning(&self) -> bool {
        self.more
    }

    pub fn finish(
        self,
        torn: bool,
        completion: Option<TerminalSpoolCompletion>,
    ) -> Result<RuntimeOutputBatch, String> {
        let retained = self.first.unwrap_or(self.head.saturating_add(1));
        let head = self.head;
        self.finish_with_bounds(torn, completion, retained, head)
    }

    pub fn finish_with_bounds(
        self,
        torn: bool,
        completion: Option<TerminalSpoolCompletion>,
        retained: u64,
        head: u64,
    ) -> Result<RuntimeOutputBatch, String> {
        if retained == 0 || retained > head.saturating_add(1) {
            return Err("invalid retained output bounds".into());
        }
        if let Some(c) = &completion {
            c.validate(&self.source, head)?;
        }
        let reset = self.after > head || self.after.saturating_add(1) < retained;
        Ok(RuntimeOutputBatch {
            incarnation_id: self.source.incarnation_id,
            terminal_id: self.source.terminal_id,
            stream_epoch: self.source.stream_epoch,
            retained_from_seq: retained,
            head_seq: head,
            reset_required: reset,
            truncated: reset || torn || self.more,
            exited: completion.is_some(),
            exit_code: completion.as_ref().and_then(|c| match c.exit {
                TerminalExitObservation::Known { code } => Some(code),
                TerminalExitObservation::Unavailable => None,
            }),
            completion,
            native_session_id: None,
            frames: self.frames,
        })
    }
}

pub fn read_indexed_spool<R: BufRead + Seek>(
    source: TerminalSpoolDescriptor,
    mut segments: Vec<IndexedSpoolSegment<R>>,
    after: u64,
    budget: u64,
    completion: Option<TerminalSpoolCompletion>,
) -> Result<IndexedSpoolRead, IndexedSpoolReadError> {
    source.validate()?;
    let mut segment_bounds = Vec::with_capacity(segments.len());
    let mut torn = segments.iter().any(|segment| segment.torn_tail);
    let mut bytes_scanned = 0_u64;

    for segment in &mut segments {
        validate_spool_index_entries(&segment.checkpoints, segment.file_bytes)
            .map_err(IndexedSpoolReadError::InvalidIndex)?;
        let Some(last_checkpoint) = segment.checkpoints.last().copied() else {
            segment_bounds.push(None);
            continue;
        };

        segment
            .reader
            .seek(SeekFrom::Start(last_checkpoint.offset))
            .map_err(|_| "retained output seek failed")?;
        let mut first = true;
        let mut head = None;
        let mut invalid_index = false;
        let summary = scan_spool_from(
            &mut segment.reader,
            &source,
            last_checkpoint.offset,
            |_, frame| {
                if first {
                    first = false;
                    if frame.seq_start != last_checkpoint.seq {
                        invalid_index = true;
                        return Err("retained output index does not match its spool".into());
                    }
                } else if head.is_some_and(|previous| frame.seq_start != previous + 1) {
                    return Err("retained output sequences are not contiguous".into());
                }
                head = Some(frame.seq_end);
                Ok(false)
            },
        )
        .map_err(|error| {
            if invalid_index {
                IndexedSpoolReadError::InvalidIndex(error)
            } else {
                IndexedSpoolReadError::Other(error)
            }
        })?;
        if first {
            return Err(IndexedSpoolReadError::InvalidIndex(
                "retained output index checkpoint is missing from its spool".into(),
            ));
        }
        torn |= summary.torn_tail;
        bytes_scanned = bytes_scanned.saturating_add(summary.bytes_scanned);
        segment_bounds.push(Some((segment.checkpoints[0].seq, head.unwrap_or(0))));
    }

    let mut previous_head: Option<u64> = None;
    for bounds in segment_bounds.iter().flatten() {
        if let Some(head) = previous_head {
            if bounds.0 != head.saturating_add(1) {
                return Err(IndexedSpoolReadError::InvalidIndex(
                    "retained output segments are not contiguous".into(),
                ));
            }
        }
        previous_head = Some(bounds.1);
    }
    let retained = segment_bounds
        .iter()
        .flatten()
        .next()
        .map(|bounds| bounds.0)
        .unwrap_or(1);
    let head = previous_head.unwrap_or(0);
    let reset = after > head || after.saturating_add(1) < retained;
    let effective = if reset {
        retained.saturating_sub(1)
    } else {
        after
    };
    let mut page = RetainedOutputPage::new(source.clone(), effective, budget)?;

    for (segment, bounds) in segments.iter_mut().zip(segment_bounds.iter()) {
        let Some((_, segment_head)) = bounds else {
            continue;
        };
        if *segment_head <= effective {
            continue;
        }
        let checkpoint = segment
            .checkpoints
            .iter()
            .take_while(|checkpoint| checkpoint.seq <= effective)
            .last()
            .or_else(|| segment.checkpoints.first())
            .copied()
            .ok_or("retained output index checkpoint missing")?;
        segment
            .reader
            .seek(SeekFrom::Start(checkpoint.offset))
            .map_err(|_| "retained output seek failed")?;
        let mut first = true;
        let mut invalid_index = false;
        let summary = scan_spool_from(
            &mut segment.reader,
            &source,
            checkpoint.offset,
            |_, frame| {
                if first {
                    first = false;
                    if frame.seq_start != checkpoint.seq {
                        invalid_index = true;
                        return Err("retained output index does not match its spool".into());
                    }
                }
                page.accept(frame)?;
                Ok(page.should_stop_scanning())
            },
        )
        .map_err(|error| {
            if invalid_index {
                IndexedSpoolReadError::InvalidIndex(error)
            } else {
                IndexedSpoolReadError::Other(error)
            }
        })?;
        if first {
            return Err(IndexedSpoolReadError::InvalidIndex(
                "retained output index checkpoint is missing from its spool".into(),
            ));
        }
        torn |= summary.torn_tail;
        bytes_scanned = bytes_scanned.saturating_add(summary.bytes_scanned);
        if summary.stopped_early {
            break;
        }
    }

    let mut batch = page.finish_with_bounds(torn, completion, retained, head)?;
    batch.reset_required |= reset;
    batch.truncated |= reset;
    Ok(IndexedSpoolRead {
        batch,
        bytes_scanned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> TerminalSpoolDescriptor {
        TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id: IncarnationId::new(),
            terminal_id: "owned".into(),
            stream_epoch: "launch-hostboot".into(),
            segment_limit_bytes: MAX_SPOOL_SEGMENT_BYTES,
        }
    }
    fn frame(source: &TerminalSpoolDescriptor, seq: u64, data: &str) -> RuntimeOutputFrame {
        RuntimeOutputFrame {
            terminal_id: source.terminal_id.clone(),
            stream_epoch: source.stream_epoch.clone(),
            seq_start: seq,
            seq_end: seq,
            data: data.into(),
        }
    }
    fn line(frame: RuntimeOutputFrame) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&TerminalSpoolFrame { frame }).unwrap();
        bytes.push(b'\n');
        bytes
    }
    #[test]
    fn indexed_spool_reads_a_near_tail_page_without_scanning_its_prefix() {
        let source = source();
        let mut bytes = Vec::new();
        let mut checkpoints: Vec<TerminalSpoolIndexEntry> = Vec::new();
        for seq in 1..=128 {
            let offset = bytes.len() as u64;
            if checkpoints.is_empty()
                || offset.saturating_sub(checkpoints.last().unwrap().offset)
                    >= SPOOL_INDEX_STRIDE_BYTES
            {
                checkpoints.push(TerminalSpoolIndexEntry { seq, offset });
            }
            bytes.extend(line(frame(
                &source,
                seq,
                &"x".repeat(MAX_OUTPUT_FRAME_BYTES),
            )));
        }
        let file_bytes = bytes.len() as u64;

        let read = read_indexed_spool(
            source,
            vec![IndexedSpoolSegment {
                reader: std::io::Cursor::new(bytes),
                file_bytes,
                checkpoints,
                torn_tail: false,
            }],
            126,
            MAX_OUTPUT_FRAME_BYTES as u64,
            None,
        )
        .unwrap();

        assert_eq!(read.batch.frames.len(), 1);
        assert_eq!(read.batch.frames[0].seq_start, 127);
        assert_eq!(read.batch.head_seq, 128);
        assert!(
            read.bytes_scanned < file_bytes / 2,
            "near-tail page scanned {} of {} spool bytes",
            read.bytes_scanned,
            file_bytes
        );
    }

    #[test]
    fn empty_sparse_index_preserves_a_torn_tail_marker() {
        let source = source();
        let bytes = b"partial committed frame".to_vec();
        let (checkpoints, _, summary) =
            build_spool_index(std::io::Cursor::new(bytes.clone()), &source, 0).unwrap();
        assert!(checkpoints.is_empty());
        assert!(summary.torn_tail);

        let index_bytes = encode_spool_index(
            &source,
            &checkpoints,
            bytes.len() as u64,
            summary.last_complete_offset,
            summary.torn_tail,
        )
        .unwrap();
        let index = read_spool_index(
            std::io::Cursor::new(index_bytes),
            &source,
            bytes.len() as u64,
        )
        .unwrap();
        assert!(index.torn_tail);

        let read = read_indexed_spool(
            source,
            vec![IndexedSpoolSegment {
                reader: std::io::Cursor::new(bytes.clone()),
                file_bytes: bytes.len() as u64,
                checkpoints: index.checkpoints,
                torn_tail: index.torn_tail,
            }],
            0,
            MAX_OUTPUT_FRAME_BYTES as u64,
            None,
        )
        .unwrap();
        assert!(read.batch.truncated);
    }

    #[test]
    fn retained_output_codec_preserves_utf8_full_pages_for_two_readers() {
        let source = source();
        let data = "🦀".repeat(16384);
        let bytes = [
            line(frame(&source, 1, &data)),
            line(frame(&source, 2, "final diagnostic")),
        ]
        .concat();
        for _ in 0..2 {
            let mut cursor = 0;
            let mut output = String::new();
            while cursor < 2 {
                let mut page = RetainedOutputPage::new(source.clone(), cursor, 65536).unwrap();
                let torn = scan_spool(std::io::Cursor::new(&bytes), &source, |frame| {
                    page.accept(frame)
                })
                .unwrap();
                let batch = page.finish(torn, None).unwrap();
                assert!(!batch.frames.is_empty());
                for frame in batch.frames {
                    cursor = frame.seq_end;
                    output += &frame.data;
                }
            }
            assert_eq!(output, data.clone() + "final diagnostic");
        }
    }
    #[test]
    fn retained_output_codec_rejects_oversized_committed_frames_without_allocating_spool() {
        let source = source();
        let bytes = line(frame(&source, 1, &"x".repeat(MAX_SPOOL_LINE_BYTES + 1)));
        let mut seen = false;
        assert!(scan_spool(std::io::Cursor::new(bytes), &source, |_| {
            seen = true;
            Ok(())
        })
        .is_err());
        assert!(!seen);
    }
    #[test]
    fn retained_output_codec_rejects_foreign_and_repeated_sequences() {
        let source = source();
        let mut foreign = frame(&source, 1, "other");
        foreign.terminal_id = "other".into();
        assert!(scan_spool(std::io::Cursor::new(line(foreign)), &source, |_| Ok(())).is_err());
        let mut page = RetainedOutputPage::new(source.clone(), 0, 65536).unwrap();
        page.accept(frame(&source, 1, "first")).unwrap();
        assert!(page.accept(frame(&source, 1, "duplicate")).is_err());
    }
    #[test]
    fn retained_output_codec_never_advances_a_cursor_over_partial_frame() {
        let source = source();
        let mut page = RetainedOutputPage::new(source.clone(), 0, 2).unwrap();
        assert!(page.accept(frame(&source, 1, "🦀")).is_err());
    }
    #[test]
    fn retained_output_completion_rejects_stale_head_epoch_and_foreign_incarnation() {
        let source = source();
        let mut completion = TerminalSpoolCompletion {
            incarnation_id: source.incarnation_id.clone(),
            terminal_id: source.terminal_id.clone(),
            stream_epoch: source.stream_epoch.clone(),
            retained_from_seq: 1,
            head_seq: 2,
            exit: TerminalExitObservation::Unavailable,
        };
        assert!(completion.validate(&source, 1).is_err());
        completion.head_seq = 1;
        completion.stream_epoch = "foreign".into();
        assert!(completion.validate(&source, 1).is_err());
        completion.stream_epoch = source.stream_epoch.clone();
        completion.incarnation_id = IncarnationId::new();
        assert!(completion.validate(&source, 1).is_err());
    }
}

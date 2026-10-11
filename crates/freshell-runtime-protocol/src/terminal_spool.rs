//! Bounded retained-output codec. Filesystem ownership and writer settlement
//! belong to the session host and supervisor, never to this codec.
use crate::{IncarnationId, RuntimeOutputBatch, RuntimeOutputFrame};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read};

pub const MAX_OUTPUT_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_SPOOL_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SPOOL_LINE_BYTES: usize = 6 * MAX_OUTPUT_FRAME_BYTES + 4096;
pub const SPOOL_DESCRIPTOR_FILE: &str = "terminal-spool-descriptor.json";
pub const SPOOL_COMPLETION_FILE: &str = "terminal-spool-completion.json";
pub const SPOOL_CURRENT_FILE: &str = "terminal-spool-current.jsonl";
pub const SPOOL_PREVIOUS_FILE: &str = "terminal-spool-previous.jsonl";

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

/// Keeps one bounded JSON line in memory. A non-newline final record is an
/// uncommitted torn tail, including valid JSON without its commit newline.
pub fn scan_spool<R: BufRead>(
    mut reader: R,
    source: &TerminalSpoolDescriptor,
    mut accept: impl FnMut(RuntimeOutputFrame) -> Result<(), String>,
) -> Result<bool, String> {
    source.validate()?;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let length = Read::by_ref(&mut reader)
            .take((MAX_SPOOL_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "retained output read failed")?;
        if length == 0 {
            return Ok(false);
        }
        if length > MAX_SPOOL_LINE_BYTES {
            return Err("retained output frame exceeds codec bound".into());
        }
        if bytes.last() != Some(&b'\n') {
            return Ok(true);
        }
        let row: TerminalSpoolFrame = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid committed retained output frame")?;
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
        accept(frame)?;
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
    pub fn finish(
        self,
        torn: bool,
        completion: Option<TerminalSpoolCompletion>,
    ) -> Result<RuntimeOutputBatch, String> {
        if let Some(c) = &completion {
            c.validate(&self.source, self.head)?;
        }
        let retained = self.first.unwrap_or(self.head.saturating_add(1));
        let reset = self.after > self.head || self.after.saturating_add(1) < retained;
        Ok(RuntimeOutputBatch {
            incarnation_id: self.source.incarnation_id,
            terminal_id: self.source.terminal_id,
            stream_epoch: self.source.stream_epoch,
            retained_from_seq: retained,
            head_seq: self.head,
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

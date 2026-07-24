//! Port of `server/coding-cli/amplifier-events-tailer.ts` (frozen parity
//! reference).
//!
//! Offset-based incremental reader for Amplifier's `events.jsonl`. Remembers a
//! byte offset; on caller-driven reads (an inotify change event or a
//! force-read failsafe — this module owns NO watchers and NO timers), reads
//! only appended bytes via positional reads; buffers a partial trailing line
//! until it is completed; applies a cheap substring pre-filter before
//! `serde_json` so the ~450KB/turn of `content_block:*`/`tool:*` noise is
//! skipped without parsing; validates the schema once per file; `size <
//! offset` means file reset — degrade, never guess.
//!
//! CRITICAL sizing facts (session-storage knowledge): individual lines can be
//! multi-MB (`llm:request` embeds full conversation history). The partial
//! buffer is capped ([`PARTIAL_MAX_BYTES`]); an oversized line is dropped by
//! skipping to the next newline — never a lane degrade, never an unbounded
//! allocation, never a whole-line `JSON.parse` of unbounded input (only
//! prefilter-matched lifecycle lines are parsed at all).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use super::reducer::{check_amplifier_record_schema, ParsedRecord};

const READ_CHUNK_BYTES: usize = 64 * 1024;
const NEWLINE: u8 = 0x0a;

/// Cap on the buffered partial-line remainder (`AMPLIFIER_TAILER_PARTIAL_MAX_BYTES`).
pub const PARTIAL_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Cap on a single positional read batch (`AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES`).
pub const READ_BATCH_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Lifecycle event-name prefixes the reducer cares about; lines are checked
/// with plain substring scans (both `"event":"x` and `"event": "x`).
const EVENT_PREFIXES: [&str; 4] = ["session:", "prompt:", "execution:", "orchestrator:steering"];

fn matches_prefilter(line: &str) -> bool {
    EVENT_PREFIXES.iter().any(|prefix| {
        line.contains(&format!("\"event\":\"{prefix}"))
            || line.contains(&format!("\"event\": \"{prefix}"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailerDegradeReason {
    FileReset,
    SchemaMismatch,
    ReadError,
}

#[derive(Debug)]
pub enum TailerReadOutcome {
    Ok {
        records: Vec<ParsedRecord>,
        /// Complete lines dropped by the pre-filter (or unparseable).
        skipped_lines: u64,
        /// Bytes consumed from the file by this read.
        bytes_consumed: u64,
        offset: u64,
    },
    Degraded {
        reason: TailerDegradeReason,
        message: String,
    },
}

/// Where to attach: `Start` = fresh session (offset 0); `Eof` = resume attach.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachAt {
    Start,
    Eof,
}

#[derive(Debug)]
pub struct AmplifierEventsTailer {
    file_path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    skipping_oversized_line: bool,
    oversized_line_logged: bool,
    schema_validated: bool,
    degraded: Option<(TailerDegradeReason, String)>,
}

impl AmplifierEventsTailer {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
            offset: 0,
            partial: Vec::new(),
            skipping_oversized_line: false,
            oversized_line_logged: false,
            schema_validated: false,
            degraded: None,
        }
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn buffered_bytes(&self) -> usize {
        self.partial.len()
    }

    pub fn is_degraded(&self) -> bool {
        self.degraded.is_some()
    }

    /// Attach at the start (fresh session) or EOF (resume).
    pub fn attach(&mut self, at: AttachAt) -> Result<u64, (TailerDegradeReason, String)> {
        if let Some(degraded) = &self.degraded {
            return Err(degraded.clone());
        }
        match at {
            AttachAt::Eof => match std::fs::metadata(&self.file_path) {
                Ok(meta) => self.offset = meta.len(),
                Err(error) => {
                    return Err(self.degrade(
                        TailerDegradeReason::ReadError,
                        format!("Could not stat amplifier events file for EOF attach: {error}"),
                    ));
                }
            },
            AttachAt::Start => self.offset = 0,
        }
        self.partial.clear();
        self.skipping_oversized_line = false;
        Ok(self.offset)
    }

    fn degrade(
        &mut self,
        reason: TailerDegradeReason,
        message: String,
    ) -> (TailerDegradeReason, String) {
        self.degraded = Some((reason, message.clone()));
        (reason, message)
    }

    /// Incremental read of appended bytes. Driven by callers (an inotify
    /// change event, or the deadman force-read failsafe — same code path,
    /// `forceRead` in the reference is a distinct entry point over the same
    /// stat + incremental read).
    pub fn read(&mut self) -> TailerReadOutcome {
        if let Some((reason, message)) = &self.degraded {
            return TailerReadOutcome::Degraded {
                reason: *reason,
                message: message.clone(),
            };
        }

        let size = match std::fs::metadata(&self.file_path) {
            Ok(meta) => meta.len(),
            Err(error) => {
                let (reason, message) = self.degrade(
                    TailerDegradeReason::ReadError,
                    format!("Could not stat amplifier events file: {error}"),
                );
                return TailerReadOutcome::Degraded { reason, message };
            }
        };

        if size < self.offset {
            let (reason, message) = self.degrade(
                TailerDegradeReason::FileReset,
                format!(
                    "Amplifier events file shrank (size {size} < offset {}); refusing to guess.",
                    self.offset
                ),
            );
            return TailerReadOutcome::Degraded { reason, message };
        }
        if size == self.offset {
            return TailerReadOutcome::Ok {
                records: Vec::new(),
                skipped_lines: 0,
                bytes_consumed: 0,
                offset: self.offset,
            };
        }

        let mut records = Vec::new();
        let mut skipped_lines = 0u64;
        let mut bytes_consumed = 0u64;

        // Bounded batches: no single allocation scales with the backlog size
        // (events files of hundreds of MB exist).
        while self.offset < size {
            let batch_length = (size - self.offset).min(READ_BATCH_MAX_BYTES);
            let appended = match read_range(&self.file_path, self.offset, batch_length) {
                Ok(appended) => appended,
                Err(error) => {
                    let (reason, message) = self.degrade(
                        TailerDegradeReason::ReadError,
                        format!("Could not read amplifier events file: {error}"),
                    );
                    return TailerReadOutcome::Degraded { reason, message };
                }
            };
            if appended.is_empty() {
                break;
            }
            bytes_consumed += appended.len() as u64;
            self.offset += appended.len() as u64;

            let mut chunk: &[u8] = &appended;
            if self.skipping_oversized_line {
                match chunk.iter().position(|&b| b == NEWLINE) {
                    None => continue, // still inside the oversized line: drop bytes
                    Some(newline_index) => {
                        self.skipping_oversized_line = false;
                        skipped_lines += 1; // the dropped oversized line finally ended
                        chunk = &chunk[newline_index + 1..];
                    }
                }
            }

            let combined: Vec<u8> = if self.partial.is_empty() {
                chunk.to_vec()
            } else {
                let mut combined = std::mem::take(&mut self.partial);
                combined.extend_from_slice(chunk);
                combined
            };
            let (lines, remainder) = split_complete_lines(&combined);
            if remainder.len() > PARTIAL_MAX_BYTES {
                // Oversized line (multi-MB llm:request payloads are normal):
                // drop the buffered bytes and skip to the next newline. Never
                // degrade the lane.
                self.partial.clear();
                self.skipping_oversized_line = true;
                if !self.oversized_line_logged {
                    self.oversized_line_logged = true;
                    tracing::debug!(
                        component = "amplifier-events-tailer",
                        event = "amplifier_tailer_oversized_line_dropped",
                        file_path = %self.file_path.display(),
                        buffered_bytes = remainder.len(),
                        "Amplifier events line exceeded the partial-buffer cap; dropping to next newline."
                    );
                }
            } else {
                self.partial = remainder.to_vec();
            }

            for line_bytes in lines {
                let line = String::from_utf8_lossy(line_bytes);
                let line = line.trim_end_matches('\r');
                if line.trim().is_empty() {
                    continue;
                }
                if !matches_prefilter(line) {
                    skipped_lines += 1;
                    continue;
                }
                let value: serde_json::Value = match serde_json::from_str(line) {
                    Ok(value) => value,
                    Err(_) => {
                        skipped_lines += 1;
                        continue;
                    }
                };
                let Some(record) = ParsedRecord::from_json(&value) else {
                    skipped_lines += 1;
                    continue;
                };
                if !self.schema_validated {
                    if check_amplifier_record_schema(&record).is_some() {
                        let (reason, message) = self.degrade(
                            TailerDegradeReason::SchemaMismatch,
                            "Amplifier events schema gate failed; expected amplifier.log major version 1.".to_string(),
                        );
                        return TailerReadOutcome::Degraded { reason, message };
                    }
                    self.schema_validated = true;
                }
                records.push(record);
            }
        }

        TailerReadOutcome::Ok {
            records,
            skipped_lines,
            bytes_consumed,
            offset: self.offset,
        }
    }
}

fn split_complete_lines(buffer: &[u8]) -> (Vec<&[u8]>, &[u8]) {
    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < buffer.len() {
        match buffer[start..].iter().position(|&b| b == NEWLINE) {
            None => break,
            Some(relative) => {
                lines.push(&buffer[start..start + relative]);
                start += relative + 1;
            }
        }
    }
    (lines, &buffer[start..])
}

fn read_range(path: &PathBuf, position: u64, length: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(position))?;
    let mut remaining = length as usize;
    let mut out = Vec::with_capacity(remaining.min(READ_CHUNK_BYTES * 4));
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];
    while remaining > 0 {
        let want = remaining.min(READ_CHUNK_BYTES);
        let read = file.read(&mut chunk[..want])?;
        if read == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..read]);
        remaining -= read;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(event: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "ts": "2026-07-23T10:00:00.000Z",
                "schema": { "name": "amplifier.log", "ver": "1.0.0" },
                "event": event,
                "session_id": "sess-1",
                "data": {}
            })
        )
    }

    #[test]
    fn incremental_reads_only_consume_appended_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(&path, line("session:start")).unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();

        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].event, "session:start");
            }
            other => panic!("expected ok, got {other:?}"),
        }

        // No new bytes: zero consumed, zero records.
        match tailer.read() {
            TailerReadOutcome::Ok {
                records,
                bytes_consumed,
                ..
            } => {
                assert!(records.is_empty());
                assert_eq!(bytes_consumed, 0);
            }
            other => panic!("expected ok, got {other:?}"),
        }

        // Append: only the new line is read.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(line("prompt:submit").as_bytes()).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].event, "prompt:submit");
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn eof_attach_skips_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(
            &path,
            [line("session:start"), line("prompt:submit")].concat(),
        )
        .unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Eof).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn partial_trailing_line_is_buffered_until_completed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let full = line("prompt:complete");
        let (head, tail) = full.split_at(20);
        std::fs::write(&path, head).unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
        assert!(tailer.buffered_bytes() > 0);

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(tail.as_bytes()).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].event, "prompt:complete");
            }
            other => panic!("expected ok, got {other:?}"),
        }
        assert_eq!(tailer.buffered_bytes(), 0);
    }

    #[test]
    fn prefilter_skips_noise_without_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let noise = format!(
            "{}\n",
            serde_json::json!({
                "schema": { "name": "amplifier.log", "ver": "1.0.0" },
                "event": "content_block:delta",
                "data": { "big": "x".repeat(1000) }
            })
        );
        std::fs::write(
            &path,
            [line("session:start"), noise, line("prompt:submit")].concat(),
        )
        .unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok {
                records,
                skipped_lines,
                ..
            } => {
                assert_eq!(
                    records.iter().map(|r| r.event.as_str()).collect::<Vec<_>>(),
                    vec!["session:start", "prompt:submit"]
                );
                assert_eq!(skipped_lines, 1);
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn file_reset_degrades_never_guesses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(
            &path,
            [line("session:start"), line("prompt:submit")].concat(),
        )
        .unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        let _ = tailer.read();

        // Truncate the file below the offset.
        std::fs::write(&path, line("session:start")).unwrap();
        match tailer.read() {
            TailerReadOutcome::Degraded { reason, .. } => {
                assert_eq!(reason, TailerDegradeReason::FileReset)
            }
            other => panic!("expected degraded, got {other:?}"),
        }
        assert!(tailer.is_degraded());
    }

    #[test]
    fn schema_gate_degrades_on_first_lifecycle_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let bad = format!(
            "{}\n",
            serde_json::json!({
                "schema": { "name": "amplifier.log", "ver": "9.0.0" },
                "event": "prompt:submit"
            })
        );
        std::fs::write(&path, bad).unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            TailerReadOutcome::Degraded { reason, .. } => {
                assert_eq!(reason, TailerDegradeReason::SchemaMismatch)
            }
            other => panic!("expected degraded, got {other:?}"),
        }
    }

    #[test]
    fn oversized_line_is_dropped_without_degrading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        // A lifecycle-looking line WITHOUT a newline that exceeds the partial
        // cap: must be dropped (skip-to-newline), not buffered forever and
        // not a lane degrade. Use a prefilter-matching prefix so the guard is
        // exercised on the worst case.
        let mut oversized = String::from("{\"event\":\"prompt:submit\",\"pad\":\"");
        oversized.push_str(&"x".repeat(PARTIAL_MAX_BYTES + 1024));
        std::fs::write(&path, &oversized).unwrap();

        let mut tailer = AmplifierEventsTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
        assert_eq!(tailer.buffered_bytes(), 0);

        // Finish the oversized line and append a good one: parsing resumes.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(b"\"}\n").unwrap();
        f.write_all(line("prompt:submit").as_bytes()).unwrap();
        match tailer.read() {
            TailerReadOutcome::Ok {
                records,
                skipped_lines,
                ..
            } => {
                assert_eq!(records.len(), 1);
                assert_eq!(skipped_lines, 1, "the oversized line counts as skipped");
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }
}

use freshell_runtime_protocol::{
    terminal_spool::{
        scan_spool, RetainedOutputPage, TerminalSpoolFrame as SpoolFrame, SPOOL_COMPLETION_FILE,
        SPOOL_DESCRIPTOR_FILE,
    },
    IncarnationId, RuntimeOutputBatch, RuntimeOutputFrame, TerminalExitObservation,
    TerminalSpoolCompletion, TerminalSpoolDescriptor,
};
use std::{
    collections::VecDeque,
    fs::OpenOptions,
    io::{BufReader, Write},
    path::{Path, PathBuf},
};

pub const DEFAULT_RING_BYTES: usize = 1024 * 1024;
pub const DEFAULT_SPOOL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TRANSPORT_CHUNK_BYTES: usize = 64 * 1024;

pub struct OutputJournal {
    incarnation_id: IncarnationId,
    terminal_id: String,
    stream_epoch: String,
    state_dir: PathBuf,
    ring: VecDeque<RuntimeOutputFrame>,
    ring_bytes: usize,
    ring_limit: usize,
    spool_limit: u64,
    next_seq: u64,
    completion: Option<TerminalSpoolCompletion>,
    failure: Option<String>,
}

impl OutputJournal {
    pub fn new(
        state_dir: impl Into<PathBuf>,
        incarnation_id: IncarnationId,
        terminal_id: String,
        stream_epoch: String,
    ) -> Result<Self, String> {
        // Production defaults are the Phase 2 contract; test/deployment
        // overrides are bounded and explicit so an operator can tune them
        // without changing PTY semantics. Invalid/zero values fail back to
        // the documented defaults rather than creating an unbounded journal.
        let ring = configured_bytes(
            "FRESHELL_RUNTIME_OUTPUT_RING_BYTES",
            DEFAULT_RING_BYTES as u64,
        ) as usize;
        let spool = configured_bytes("FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES", DEFAULT_SPOOL_BYTES);
        Self::with_limits(
            state_dir,
            incarnation_id,
            terminal_id,
            stream_epoch,
            ring,
            spool,
        )
    }

    pub fn with_limits(
        state_dir: impl Into<PathBuf>,
        incarnation_id: IncarnationId,
        terminal_id: String,
        stream_epoch: String,
        ring_limit: usize,
        spool_limit: u64,
    ) -> Result<Self, String> {
        let state_dir = state_dir.into();
        std::fs::create_dir_all(&state_dir).map_err(|e| e.to_string())?;
        let mut journal = Self {
            incarnation_id,
            terminal_id,
            stream_epoch,
            state_dir,
            ring: VecDeque::new(),
            ring_bytes: 0,
            ring_limit: ring_limit.max(MAX_TRANSPORT_CHUNK_BYTES),
            spool_limit: spool_limit
                .clamp((MAX_TRANSPORT_CHUNK_BYTES * 4) as u64, DEFAULT_SPOOL_BYTES),
            next_seq: 1,
            completion: None,
            failure: None,
        };
        atomic_json(
            &journal.state_dir.join(SPOOL_DESCRIPTOR_FILE),
            &journal.descriptor(),
        )?;
        // Create a committed empty source before the PTY output writer exists.
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(journal.current_path())
            .and_then(|file| file.sync_all())
            .map_err(|_| "initialize retained spool failed")?;
        journal.seed_sequence_from_spool()?;
        Ok(journal)
    }

    pub fn append(&mut self, data: &str) -> Result<Vec<RuntimeOutputFrame>, String> {
        let mut written = Vec::new();
        for chunk in split_utf8(data, MAX_TRANSPORT_CHUNK_BYTES) {
            let seq = self.next_seq;
            let frame = RuntimeOutputFrame {
                terminal_id: self.terminal_id.clone(),
                stream_epoch: self.stream_epoch.clone(),
                seq_start: seq,
                seq_end: seq,
                data: chunk.to_string(),
            };
            self.append_spool(&frame)?;
            self.next_seq = self
                .next_seq
                .checked_add(1)
                .ok_or("output sequence exhausted")?;
            self.ring_bytes = self.ring_bytes.saturating_add(frame.data.len());
            self.ring.push_back(frame.clone());
            while self.ring_bytes > self.ring_limit {
                let Some(evicted) = self.ring.pop_front() else {
                    break;
                };
                self.ring_bytes = self.ring_bytes.saturating_sub(evicted.data.len());
            }
            written.push(frame);
        }
        Ok(written)
    }

    fn descriptor(&self) -> TerminalSpoolDescriptor {
        TerminalSpoolDescriptor {
            schema_version: 1,
            incarnation_id: self.incarnation_id.clone(),
            terminal_id: self.terminal_id.clone(),
            stream_epoch: self.stream_epoch.clone(),
            segment_limit_bytes: self.spool_limit / 2,
        }
    }

    pub fn record_failure(&mut self) {
        self.failure = Some("retained output writer failed".into());
    }

    pub fn complete(&mut self, code: i64) -> Result<(), String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let batch = self.read(0, MAX_TRANSPORT_CHUNK_BYTES as u64)?;
        let completion = TerminalSpoolCompletion {
            incarnation_id: self.incarnation_id.clone(),
            terminal_id: self.terminal_id.clone(),
            stream_epoch: self.stream_epoch.clone(),
            retained_from_seq: batch.retained_from_seq,
            head_seq: batch.head_seq,
            exit: TerminalExitObservation::Known { code },
        };
        atomic_json(&self.state_dir.join(SPOOL_COMPLETION_FILE), &completion)?;
        self.completion = Some(completion);
        Ok(())
    }

    fn scan(
        &self,
        mut accept: impl FnMut(RuntimeOutputFrame) -> Result<(), String>,
    ) -> Result<bool, String> {
        let source = self.descriptor();
        let mut torn = false;
        for (path, required) in [(self.previous_path(), false), (self.current_path(), true)] {
            let file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("retained output spool unavailable".into()),
            };
            if file
                .metadata()
                .map_err(|_| "retained spool metadata unavailable")?
                .len()
                > source.segment_limit_bytes
            {
                return Err("retained spool exceeds segment bound".into());
            }
            torn |= scan_spool(BufReader::new(file), &source, &mut accept)?;
        }
        Ok(torn)
    }

    pub fn read(&self, after_seq: u64, max_bytes: u64) -> Result<RuntimeOutputBatch, String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        // First scan establishes bounds without retaining the spool in memory.
        let mut first = None;
        let mut head = 0;
        self.scan(|frame| {
            first.get_or_insert(frame.seq_start);
            head = frame.seq_end;
            Ok(())
        })?;
        let retained = first.unwrap_or(head.saturating_add(1));
        let reset = after_seq > head || after_seq.saturating_add(1) < retained;
        let effective = if reset {
            retained.saturating_sub(1)
        } else {
            after_seq
        };
        let mut page = RetainedOutputPage::new(self.descriptor(), effective, max_bytes)?;
        let torn = self.scan(|frame| page.accept(frame))?;
        let mut batch = page.finish(torn, self.completion.clone())?;
        batch.reset_required |= reset;
        batch.truncated |= reset;
        Ok(batch)
    }

    pub fn head_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }
    #[cfg(test)]
    pub fn ring_bytes(&self) -> usize {
        self.ring_bytes
    }
    pub fn spool_bytes(&self) -> u64 {
        [self.previous_path(), self.current_path()]
            .into_iter()
            .filter_map(|p| p.metadata().ok().map(|m| m.len()))
            .sum()
    }

    fn append_spool(&self, frame: &RuntimeOutputFrame) -> Result<(), String> {
        let line = serde_json::to_vec(&SpoolFrame {
            frame: frame.clone(),
        })
        .map_err(|e| e.to_string())?;
        let segment_limit = self.spool_limit / 2;
        let current = self.current_path();
        let current_len = current.metadata().map(|m| m.len()).unwrap_or(0);
        if current_len > 0 && current_len.saturating_add(line.len() as u64 + 1) > segment_limit {
            let previous = self.previous_path();
            let _ = std::fs::remove_file(&previous);
            std::fs::rename(&current, &previous).map_err(|e| e.to_string())?;
            sync_parent(&current)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&current)
            .map_err(|e| e.to_string())?;
        file.write_all(&line)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| e.to_string())?;
        file.sync_data().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn seed_sequence_from_spool(&mut self) -> Result<(), String> {
        let mut head = 0;
        self.scan(|frame| {
            head = frame.seq_end;
            Ok(())
        })?;
        self.next_seq = head.checked_add(1).ok_or("output sequence exhausted")?;
        Ok(())
    }

    fn current_path(&self) -> PathBuf {
        self.state_dir.join("terminal-spool-current.jsonl")
    }
    fn previous_path(&self) -> PathBuf {
        self.state_dir.join("terminal-spool-previous.jsonl")
    }
}

pub fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(value).map_err(|_| "retained metadata encoding failed")?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "retained metadata unavailable")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "retained metadata write failed")?;
    std::fs::rename(temporary, path).map_err(|_| "retained metadata commit failed")?;
    sync_parent(path)
}

fn configured_bytes(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= 1024 * 1024 * 1024)
        .unwrap_or(default)
}

fn split_utf8(data: &str, max_bytes: usize) -> Vec<&str> {
    if data.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < data.len() {
        let mut end = (start + max_bytes.max(1)).min(data.len());
        while end > start && !data.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = data[start..]
                .char_indices()
                .nth(1)
                .map(|(i, _)| start + i)
                .unwrap_or(data.len());
        }
        out.push(&data[start..end]);
        start = end;
    }
    out
}

fn sync_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_output_requires_existing_spool_instead_of_empty_success() {
        let dir = tempfile::tempdir().unwrap();
        let journal =
            OutputJournal::new(dir.path(), IncarnationId::new(), "t".into(), "e".into()).unwrap();
        // No append has happened: even an empty stream needs a durable source
        // association and an existing empty spool before its writer can start.
        assert!(dir.path().join("terminal-spool-current.jsonl").is_file());
        std::fs::remove_file(dir.path().join("terminal-spool-current.jsonl")).unwrap();
        assert!(
            journal.read(0, 65536).is_err(),
            "missing spool cannot masquerade as retained empty output"
        );
    }

    #[test]
    fn retained_output_ignores_only_a_torn_final_frame_and_keeps_complete_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal =
            OutputJournal::new(dir.path(), IncarnationId::new(), "t".into(), "e".into()).unwrap();
        journal.append("complete diagnostic").unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(journal.current_path())
            .unwrap();
        file.write_all(b"{\"frame\":{\"data\":\"partial").unwrap();
        file.sync_data().unwrap();
        let read = journal
            .read(0, 65536)
            .expect("a torn tail preserves complete committed frames");
        assert_eq!(read.frames.len(), 1);
        assert_eq!(read.frames[0].data, "complete diagnostic");
        assert!(read.truncated, "torn tail must be visible");
    }

    #[test]
    fn retained_output_rejects_foreign_terminal_frames_in_same_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal =
            OutputJournal::new(dir.path(), IncarnationId::new(), "t".into(), "e".into()).unwrap();
        journal.append("owned diagnostic").unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(journal.current_path())
            .unwrap();
        let foreign = RuntimeOutputFrame {
            terminal_id: "foreign".into(),
            stream_epoch: "e".into(),
            seq_start: 2,
            seq_end: 2,
            data: "wrong soul".into(),
        };
        serde_json::to_writer(&mut file, &SpoolFrame { frame: foreign }).unwrap();
        file.write_all(b"\n").unwrap();
        assert!(
            journal.read(0, 65536).is_err(),
            "matching epoch alone does not prove owned terminal"
        );
    }

    #[test]
    fn bounds_ring_and_returns_explicit_reset_for_expired_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = OutputJournal::with_limits(
            dir.path(),
            IncarnationId::new(),
            "t".into(),
            "epoch".into(),
            64 * 1024,
            256 * 1024,
        )
        .unwrap();
        for i in 0..20 {
            journal
                .append(&format!("line-{i}-{}\n", "x".repeat(20_000)))
                .unwrap();
        }
        assert!(journal.ring_bytes() <= 64 * 1024);
        assert!(journal.spool_bytes() <= 256 * 1024 + 4096);
        let batch = journal.read(1, 64 * 1024).unwrap();
        assert!(batch.reset_required);
        assert!(batch.truncated);
        assert!(!batch.frames.is_empty());
    }

    #[test]
    fn cursor_from_a_previous_host_cannot_hide_a_new_epochs_output() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = OutputJournal::new(
            dir.path(),
            IncarnationId::new(),
            "same-terminal".into(),
            "new-host-epoch".into(),
        )
        .unwrap();
        journal.append("restored native conversation").unwrap();
        let batch = journal.read(206, 64 * 1024).unwrap();
        assert!(
            batch.reset_required,
            "a cursor ahead of this epoch must reset, not wait forever"
        );
        assert_eq!(batch.frames.len(), 1);
        assert_eq!(batch.frames[0].seq_start, 1);
        assert_eq!(batch.frames[0].data, "restored native conversation");
        assert!(journal.read(1, 64 * 1024).unwrap().frames.is_empty());
    }

    #[test]
    fn transport_frames_never_split_utf8_or_exceed_64k() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal =
            OutputJournal::new(dir.path(), IncarnationId::new(), "t".into(), "e".into()).unwrap();
        let frames = journal.append(&"🦀".repeat(40_000)).unwrap();
        assert!(frames.len() > 1);
        assert!(frames
            .iter()
            .all(|f| f.data.len() <= MAX_TRANSPORT_CHUNK_BYTES));
        assert_eq!(
            frames.iter().map(|f| f.data.as_str()).collect::<String>(),
            "🦀".repeat(40_000)
        );
    }
}

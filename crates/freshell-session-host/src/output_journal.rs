use freshell_runtime_protocol::{IncarnationId, RuntimeOutputBatch, RuntimeOutputFrame};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

pub const DEFAULT_RING_BYTES: usize = 1024 * 1024;
pub const DEFAULT_SPOOL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_TRANSPORT_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpoolFrame {
    frame: RuntimeOutputFrame,
}

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
}

impl OutputJournal {
    pub fn new(
        state_dir: impl Into<PathBuf>,
        incarnation_id: IncarnationId,
        terminal_id: String,
        stream_epoch: String,
    ) -> Result<Self, String> {
        Self::with_limits(
            state_dir,
            incarnation_id,
            terminal_id,
            stream_epoch,
            DEFAULT_RING_BYTES,
            DEFAULT_SPOOL_BYTES,
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
            spool_limit: spool_limit.max((MAX_TRANSPORT_CHUNK_BYTES * 4) as u64),
            next_seq: 1,
        };
        journal.seed_sequence_from_spool()?;
        Ok(journal)
    }

    pub fn append(&mut self, data: &str) -> Result<Vec<RuntimeOutputFrame>, String> {
        let mut written = Vec::new();
        for chunk in split_utf8(data, MAX_TRANSPORT_CHUNK_BYTES) {
            let seq = self.next_seq;
            self.next_seq = self.next_seq.saturating_add(1);
            let frame = RuntimeOutputFrame {
                terminal_id: self.terminal_id.clone(),
                stream_epoch: self.stream_epoch.clone(),
                seq_start: seq,
                seq_end: seq,
                data: chunk.to_string(),
            };
            self.append_spool(&frame)?;
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

    pub fn read(&self, after_seq: u64, max_bytes: u64) -> Result<RuntimeOutputBatch, String> {
        let budget = max_bytes.clamp(1, MAX_TRANSPORT_CHUNK_BYTES as u64) as usize;
        let mut by_seq = BTreeMap::<u64, RuntimeOutputFrame>::new();
        for path in [self.previous_path(), self.current_path()] {
            if !path.exists() {
                continue;
            }
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if line.trim().is_empty() {
                    continue;
                }
                let row: SpoolFrame = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                if row.frame.stream_epoch == self.stream_epoch {
                    by_seq.insert(row.frame.seq_start, row.frame);
                }
            }
        }
        for frame in &self.ring {
            by_seq.insert(frame.seq_start, frame.clone());
        }
        let retained_from_seq = by_seq.keys().next().copied().unwrap_or(self.next_seq);
        let head_seq = self.next_seq.saturating_sub(1);
        let reset_required = after_seq.saturating_add(1) < retained_from_seq;
        let effective_after = if reset_required {
            retained_from_seq.saturating_sub(1)
        } else {
            after_seq
        };
        let mut frames = Vec::new();
        let mut used = 0usize;
        let mut more = false;
        for (_, frame) in by_seq.range((effective_after.saturating_add(1))..) {
            let cost = frame.data.len().max(1);
            if !frames.is_empty() && used.saturating_add(cost) > budget {
                more = true;
                break;
            }
            if cost > budget && frames.is_empty() {
                // append() already chunks at <=64KiB, but a smaller caller budget
                // should still make forward progress without emitting an oversized frame.
                let Some(first) = split_utf8(&frame.data, budget).first().copied() else {
                    continue;
                };
                let mut partial = frame.clone();
                partial.data = first.to_string();
                frames.push(partial);
                more = true;
                break;
            }
            used = used.saturating_add(cost);
            frames.push(frame.clone());
        }
        Ok(RuntimeOutputBatch {
            incarnation_id: self.incarnation_id.clone(),
            terminal_id: self.terminal_id.clone(),
            stream_epoch: self.stream_epoch.clone(),
            retained_from_seq,
            head_seq,
            reset_required,
            truncated: reset_required || more,
            frames,
        })
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
        let segment_limit = (self.spool_limit / 2).max((MAX_TRANSPORT_CHUNK_BYTES * 2) as u64);
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
        let mut max = 0;
        for path in [self.previous_path(), self.current_path()] {
            if !path.exists() {
                continue;
            }
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| e.to_string())?;
                if let Ok(row) = serde_json::from_str::<SpoolFrame>(&line) {
                    if row.frame.stream_epoch == self.stream_epoch {
                        max = max.max(row.frame.seq_end);
                    }
                }
            }
        }
        self.next_seq = max.saturating_add(1).max(1);
        Ok(())
    }

    fn current_path(&self) -> PathBuf {
        self.state_dir.join("terminal-spool-current.jsonl")
    }
    fn previous_path(&self) -> PathBuf {
        self.state_dir.join("terminal-spool-previous.jsonl")
    }
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

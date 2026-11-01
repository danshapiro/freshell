//! Incremental claude transcript projection (transcript-live plan §4.3, C4).
//!
//! A live pane refetches its snapshot after every message the CLI persists,
//! and every connected device does the same. Re-reading and re-projecting
//! the whole transcript each time costs O(transcript) per message; the CLI
//! only ever appends, so this cache keeps a projector per transcript and
//! feeds it only the complete lines added since the last read.
//!
//! Each entry holds the file's identity (its inode on unix), the byte offset
//! the projector has consumed (always just after a newline), the 4 KiB before
//! that offset, and the projector. A read:
//! - parses the complete lines after the offset into the cached projector
//!   when the file still has those 4 KiB in place (it grew, or is unchanged);
//! - parses the whole file afresh when the file is new to the cache, shorter
//!   than the offset, has different bytes before the offset (a rewrite), or
//!   is a different file at the same path (a replace);
//! - never consumes an unterminated last line (a write in progress): a tail
//!   that already parses as JSON is projected for this read only, so the
//!   result always equals a full parse of the file as read.
//!
//! Subagent transcripts are attached per read through the caller's
//! [`SubagentSource`] (the filesystem one has its own per-file cache), so a
//! subagent that grows while the main transcript does not is still reflected.
//! Reads are blocking; callers run them off the async runtime.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use crate::claude_projection::{ClaudeProjection, ClaudeTranscriptProjector, SubagentSource};

/// How many transcripts the process keeps projectors for (the open panes'
/// sessions, roughly).
const CACHED_TRANSCRIPTS: usize = 8;

/// How many bytes before the consumed offset must be unchanged for an
/// incremental read.
const FINGERPRINT_BYTES: u64 = 4096;

/// Why a read parsed the whole file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FullReason {
    /// The cache had no projector for this transcript.
    Uncached,
    /// The file is shorter than what was consumed.
    Shrunk,
    /// The bytes before the consumed offset changed.
    Rewritten,
    /// Another file now sits at the path.
    Replaced,
}

impl FullReason {
    fn label(self) -> &'static str {
        match self {
            Self::Uncached => "uncached",
            Self::Shrunk => "shrunk",
            Self::Rewritten => "rewritten",
            Self::Replaced => "replaced",
        }
    }
}

/// What one read parsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadOutcome {
    /// No complete line was added since the last read.
    Unchanged,
    /// Only the complete lines added since the last read (`bytes` of them).
    Appended { bytes: u64 },
    /// The whole file (its `bytes` of complete lines).
    Full { reason: FullReason, bytes: u64 },
}

/// A read's projection and what it took.
pub(crate) struct TranscriptRead {
    pub projection: ClaudeProjection,
    pub outcome: ReadOutcome,
}

/// What identifies a file beyond its path.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileId {
    #[cfg(unix)]
    inode: u64,
}

impl FileId {
    fn of(_metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            #[cfg(unix)]
            inode: _metadata.ino(),
        }
    }
}

struct Entry {
    file: FileId,
    /// Bytes consumed (just after a newline).
    offset: u64,
    /// The [`FINGERPRINT_BYTES`] before `offset`.
    fingerprint: Vec<u8>,
    projector: ClaudeTranscriptProjector,
    has_records: bool,
    last_used: u64,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<(PathBuf, String), Entry>,
    /// Bumped on every store; an entry's `last_used` orders eviction.
    clock: u64,
}

/// Projectors by transcript, least recently used dropped past the capacity.
pub(crate) struct ProjectionCache {
    capacity: usize,
    state: Mutex<CacheState>,
}

/// The process-wide cache every snapshot read shares.
static PROJECTIONS: LazyLock<ProjectionCache> =
    LazyLock::new(|| ProjectionCache::new(CACHED_TRANSCRIPTS));

/// Project the transcript at `path` through the process-wide cache, logging
/// what the read took. Blocking.
pub(crate) fn read_transcript(
    path: &Path,
    thread_id: &str,
    subagents: &dyn SubagentSource,
) -> std::io::Result<ClaudeProjection> {
    let started = Instant::now();
    let read = PROJECTIONS.read(path, thread_id, subagents)?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match read.outcome {
        ReadOutcome::Unchanged => tracing::debug!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.transcript_projection",
            outcome = "unchanged",
            thread_id,
            elapsed_ms,
            "projected a claude transcript from the cache"
        ),
        ReadOutcome::Appended { bytes } => tracing::debug!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.transcript_projection",
            outcome = "appended",
            thread_id,
            bytes,
            elapsed_ms,
            "projected the lines appended to a claude transcript"
        ),
        ReadOutcome::Full { reason, bytes } => tracing::debug!(
            target: "freshell_freshagent::claude",
            event = "freshagent.claude.transcript_projection",
            outcome = "full",
            reason = reason.label(),
            thread_id,
            bytes,
            elapsed_ms,
            "projected a whole claude transcript"
        ),
    }
    Ok(read.projection)
}

impl ProjectionCache {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            state: Mutex::new(CacheState::default()),
        }
    }

    /// The projection of the transcript at `path` (see the module docs).
    pub(crate) fn read(
        &self,
        path: &Path,
        thread_id: &str,
        subagents: &dyn SubagentSource,
    ) -> std::io::Result<TranscriptRead> {
        let key = (path.to_path_buf(), thread_id.to_string());
        let mut transcript = std::fs::File::open(path)?;
        let metadata = transcript.metadata()?;
        let file = FileId::of(&metadata);
        // The entry leaves the cache while this read works on it: a concurrent
        // read of the same transcript parses in full (correct, only slower).
        let cached = self.take(&key);
        let (mut projector, start, full, mut has_records) = match cached {
            None => (
                ClaudeTranscriptProjector::new(thread_id),
                0,
                Some(FullReason::Uncached),
                false,
            ),
            Some(entry) => match Self::continuation(&mut transcript, &metadata, file, &entry)? {
                None => (entry.projector, entry.offset, None, entry.has_records),
                Some(reason) => (
                    ClaudeTranscriptProjector::new(thread_id),
                    0,
                    Some(reason),
                    false,
                ),
            },
        };

        transcript.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        transcript.read_to_end(&mut bytes)?;
        let complete = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |newline| newline + 1);
        let lines = std::str::from_utf8(&bytes[..complete])
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        for line in lines.split('\n') {
            has_records |= projector.push_line(line);
        }
        let offset = start + complete as u64;
        let fingerprint = Self::fingerprint(&mut transcript, offset)?;

        // An unterminated last line is a write in progress: a tail that
        // already parses counts for this read only, never for the cache.
        let mut result = projector.clone();
        match std::str::from_utf8(&bytes[complete..]) {
            Ok(tail) => {
                result.push_line(tail);
            }
            Err(error) if !has_records => {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
            }
            // A native writer can stop halfway through its next UTF-8 line.
            // Keep the valid prefix instead of hiding its existing history.
            Err(_) => {}
        }
        self.store(
            key,
            Entry {
                file,
                offset,
                fingerprint,
                projector,
                has_records,
                last_used: 0,
            },
        );
        let parsed = complete as u64;
        let outcome = match full {
            Some(reason) => ReadOutcome::Full {
                reason,
                bytes: parsed,
            },
            None if parsed == 0 => ReadOutcome::Unchanged,
            None => ReadOutcome::Appended { bytes: parsed },
        };
        Ok(TranscriptRead {
            projection: result.finish_with(subagents),
            outcome,
        })
    }

    /// Whether `entry` continues the file as it is now: `None` when it does,
    /// else why the file must be parsed in full.
    fn continuation(
        transcript: &mut std::fs::File,
        metadata: &std::fs::Metadata,
        file: FileId,
        entry: &Entry,
    ) -> std::io::Result<Option<FullReason>> {
        if entry.file != file {
            return Ok(Some(FullReason::Replaced));
        }
        if metadata.len() < entry.offset {
            return Ok(Some(FullReason::Shrunk));
        }
        if Self::fingerprint(transcript, entry.offset)? != entry.fingerprint {
            return Ok(Some(FullReason::Rewritten));
        }
        Ok(None)
    }

    /// The [`FINGERPRINT_BYTES`] before `offset`.
    fn fingerprint(transcript: &mut std::fs::File, offset: u64) -> std::io::Result<Vec<u8>> {
        let start = offset.saturating_sub(FINGERPRINT_BYTES);
        transcript.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::with_capacity((offset - start) as usize);
        transcript
            .by_ref()
            .take(offset - start)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    fn take(&self, key: &(PathBuf, String)) -> Option<Entry> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.entries.remove(key)
    }

    fn store(&self, key: (PathBuf, String), mut entry: Entry) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.clock += 1;
        entry.last_used = state.clock;
        state.entries.insert(key, entry);
        while state.entries.len() > self.capacity {
            let Some(oldest) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            state.entries.remove(&oldest);
        }
    }
}

#[cfg(test)]
#[path = "claude_projection_cache_tests.rs"]
mod tests;

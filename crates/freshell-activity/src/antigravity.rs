//! Antigravity terminal-mode activity (antigravity plan Task 8): the
//! transcript-record lane.
//!
// Stage-1 candidate contract: the record vocabulary below comes from the
//! antigravity CLI's fixture-format transcripts (brain/<id>/.system_generated/
//! logs/transcript.jsonl) as pinned by `crates/freshell-sessions`'s parser
//! and the Task 6 locator — `user_message` and `turn_settled{outcome,
//! fullyIdle}` records. No pinned real binary was available at planning time,
//! so the classification is deliberately CONSERVATIVE:
//!
//! * `user_message` ⇒ Busy (a new submit — the pane's prompt landed).
//! * `turn_settled{fullyIdle:true}` ⇒ exactly ONE TurnComplete, deduped per
//!   settle (a settle while not Busy is a no-op — replayed/duplicate settles
//!   never ring twice).
//! * `turn_settled{fullyIdle:false}` ⇒ stay Busy (outstanding async work —
//!   invocation completion is NOT turn completion).
//! * `turn_settled{outcome:"errored"}` ⇒ TurnComplete (attention is
//!   outcome-uniform: an errored turn end is still a turn end).
//! * Deadman `ANTIGRAVITY_BUSY_DEADMAN_MS` quiet while confirmed-busy ⇒
//!   ForceRead (re-read the transcript; a found settle completes, else the
//!   pane stays busy — the deadman NEVER fabricates a completion).
//!
//! Only `turn_settled` records mint completions; the PTY lane (a flushed
//! submit) is a PROVISIONAL busy with a submit-grace reversion (the amplifier
//! [`AmplifierActivityTracker`](crate::amplifier::tracker) model — an empty or
//! rejected submit can never wedge the pane busy), confirmed by the
//! transcript's own `user_message`.
//!
//! The tailer ([`AntigravityTranscriptTailer`]) is the amplifier
//! `AmplifierEventsTailer` pattern: an offset-based incremental reader that
//! owns NO watchers and NO timers — reads are driven by the hub's inotify
//! change events and the deadman's force-read failsafes. It reads ONLY the
//! pane's bound transcript (the Task 6 locator's bound path — never the
//! last-conversations cache).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use freshell_protocol::AntigravityActivityRecord;
use freshell_protocol::AntigravityPhase;

use crate::amplifier::tailer::AttachAt;
use crate::ledger::TurnCompletionLedger;
use crate::TrackerEffect;

pub const ANTIGRAVITY_BUSY_DEADMAN_MS: i64 = 120_000;
pub const ANTIGRAVITY_SUBMIT_GRACE_MS: i64 = 2_000;

pub type AntigravityEffect = TrackerEffect<AntigravityActivityRecord>;

/// One classified lifecycle record from the pane's bound transcript.
/// Every other record type (`session_start`, `assistant_message`, tool
/// records, ...) is intentionally NOT represented: the classification is
/// conservative and those records carry no turn-boundary information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravityRecordKind {
    /// `{"type":"user_message",...}` — the pane's prompt landed (a submit).
    UserMessage,
    /// `{"type":"turn_settled",...}` — an invocation settled. `fully_idle`
    /// mirrors the record's `fullyIdle` (absent ⇒ false — conservative);
    /// `errored` mirrors `outcome == "errored"` (anything else ⇒ false).
    TurnSettled { fully_idle: bool, errored: bool },
}

/// One tailer-parsed transcript record with its coerced `at` timestamp
/// (`None` when absent/unparseable — the tracker then folds in `now`; the
/// timestamp is only carried onto `updatedAt`/effect fields, never used to
/// gate transitions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AntigravityTranscriptRecord {
    pub kind: AntigravityRecordKind,
    pub at: Option<i64>,
}

/// Classify one parsed transcript JSON line into a lifecycle record.
/// `None` for every non-lifecycle type (the tailer's prefilter skips those
/// lines before parsing, so this is the single classification seam).
pub fn parse_transcript_record(value: &serde_json::Value) -> Option<AntigravityRecordKind> {
    let kind = value.get("type")?.as_str()?;
    match kind {
        "user_message" => Some(AntigravityRecordKind::UserMessage),
        "turn_settled" => Some(AntigravityRecordKind::TurnSettled {
            fully_idle: value
                .get("fullyIdle")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            errored: value
                .get("outcome")
                .and_then(serde_json::Value::as_str)
                .map(|outcome| outcome == "errored")
                .unwrap_or(false),
        }),
        _ => None,
    }
}

/// Coerce a record's `at` field to epoch-ms: numeric epoch-ms (the rebind
/// fixtures' shape) or an ISO-8601 string (the CLI's documented shape).
/// `None` for anything else.
pub fn record_at_ms(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => {
            number.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)
        }
        serde_json::Value::String(s) => crate::amplifier::tracker::chrono_free_parse_iso_ms(s),
        _ => None,
    }
}

// ── the transcript tailer (the amplifier events-tailer pattern) ────────────

const READ_CHUNK_BYTES: usize = 64 * 1024;
const NEWLINE: u8 = 0x0a;

/// Cap on the buffered partial-line remainder (amplifier parity:
/// `AMPLIFIER_TAILER_PARTIAL_MAX_BYTES`).
pub const PARTIAL_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Cap on a single positional read batch (amplifier parity:
/// `AMPLIFIER_TAILER_READ_BATCH_MAX_BYTES`).
pub const READ_BATCH_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Lifecycle record types the classifier consumes; checked with plain
/// substring scans (both `"type":"x` and `"type": "x` forms) so the
/// transcript's other records (assistant/tool noise, potentially large) are
/// skipped without parsing.
const LIFECYCLE_TYPE_PREFIXES: [&str; 2] = ["user_message", "turn_settled"];

fn matches_prefilter(line: &str) -> bool {
    LIFECYCLE_TYPE_PREFIXES.iter().any(|record_type| {
        line.contains(&format!("\"type\":\"{record_type}"))
            || line.contains(&format!("\"type\": \"{record_type}"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravityTailerDegradeReason {
    /// The transcript shrank below the read offset (rotation/truncation) —
    /// refuse to guess.
    FileReset,
    ReadError,
}

#[derive(Debug)]
pub enum AntigravityTailerReadOutcome {
    Ok {
        records: Vec<AntigravityTranscriptRecord>,
        /// Complete lines dropped by the pre-filter (or unparseable).
        skipped_lines: u64,
        /// Bytes consumed from the file by this read.
        bytes_consumed: u64,
        offset: u64,
    },
    Degraded {
        reason: AntigravityTailerDegradeReason,
        message: String,
    },
}

/// Offset-based incremental reader for one bound conversation transcript.
/// Owns no watcher and no timer — reads are caller-driven (the hub's inotify
/// change events and the deadman's force-read failsafes).
#[derive(Debug)]
pub struct AntigravityTranscriptTailer {
    file_path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    skipping_oversized_line: bool,
    degraded: Option<(AntigravityTailerDegradeReason, String)>,
}

impl AntigravityTranscriptTailer {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
            offset: 0,
            partial: Vec::new(),
            skipping_oversized_line: false,
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

    /// Attach at the start (fresh conversation — replays the young file,
    /// which is exactly the `user_message` that confirms the provisional
    /// busy) or EOF (resume/rebind — live records take over; foreign
    /// history is never replayed).
    pub fn attach(
        &mut self,
        at: AttachAt,
    ) -> Result<u64, (AntigravityTailerDegradeReason, String)> {
        if let Some(degraded) = &self.degraded {
            return Err(degraded.clone());
        }
        match at {
            AttachAt::Eof => match std::fs::metadata(&self.file_path) {
                Ok(meta) => self.offset = meta.len(),
                Err(error) => {
                    return Err(self.degrade(
                        AntigravityTailerDegradeReason::ReadError,
                        format!("Could not stat antigravity transcript for EOF attach: {error}"),
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
        reason: AntigravityTailerDegradeReason,
        message: String,
    ) -> (AntigravityTailerDegradeReason, String) {
        self.degraded = Some((reason, message.clone()));
        (reason, message)
    }

    /// Incremental read of appended bytes.
    pub fn read(&mut self) -> AntigravityTailerReadOutcome {
        if let Some((reason, message)) = &self.degraded {
            return AntigravityTailerReadOutcome::Degraded {
                reason: *reason,
                message: message.clone(),
            };
        }

        let size = match std::fs::metadata(&self.file_path) {
            Ok(meta) => meta.len(),
            Err(error) => {
                let (reason, message) = self.degrade(
                    AntigravityTailerDegradeReason::ReadError,
                    format!("Could not stat antigravity transcript: {error}"),
                );
                return AntigravityTailerReadOutcome::Degraded { reason, message };
            }
        };

        if size < self.offset {
            let (reason, message) = self.degrade(
                AntigravityTailerDegradeReason::FileReset,
                format!(
                    "Antigravity transcript shrank (size {size} < offset {}); refusing to guess.",
                    self.offset
                ),
            );
            return AntigravityTailerReadOutcome::Degraded { reason, message };
        }
        if size == self.offset {
            return AntigravityTailerReadOutcome::Ok {
                records: Vec::new(),
                skipped_lines: 0,
                bytes_consumed: 0,
                offset: self.offset,
            };
        }

        let mut records = Vec::new();
        let mut skipped_lines = 0u64;
        let mut bytes_consumed = 0u64;

        // Bounded batches: no single allocation scales with the backlog.
        while self.offset < size {
            let batch_length = (size - self.offset).min(READ_BATCH_MAX_BYTES);
            let appended = match read_range(&self.file_path, self.offset, batch_length) {
                Ok(appended) => appended,
                Err(error) => {
                    let (reason, message) = self.degrade(
                        AntigravityTailerDegradeReason::ReadError,
                        format!("Could not read antigravity transcript: {error}"),
                    );
                    return AntigravityTailerReadOutcome::Degraded { reason, message };
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
                // Oversized line (records can embed large content): drop the
                // buffered bytes and skip to the next newline. Never a lane
                // degrade.
                self.partial.clear();
                self.skipping_oversized_line = true;
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
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    skipped_lines += 1;
                    continue;
                };
                let Some(kind) = parse_transcript_record(&value) else {
                    skipped_lines += 1;
                    continue;
                };
                let at = value.get("at").and_then(record_at_ms);
                records.push(AntigravityTranscriptRecord { kind, at });
            }
        }

        AntigravityTailerReadOutcome::Ok {
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

// ── the tracker ────────────────────────────────────────────────────────────

#[derive(Debug)]
struct TerminalActivity {
    terminal_id: String,
    session_id: Option<String>,
    phase: AntigravityPhase,
    updated_at: i64,
    last_observed_at: i64,
    busy_confirmed: bool,
    submit_grace_deadline: Option<i64>,
    submit_grace_retried: bool,
    force_read_logged: bool,
    next_force_read_at: Option<i64>,
}

impl TerminalActivity {
    fn to_record(&self) -> AntigravityActivityRecord {
        AntigravityActivityRecord {
            terminal_id: self.terminal_id.clone(),
            phase: self.phase,
            updated_at: self.updated_at,
            session_id: self.session_id.clone(),
        }
    }
}

fn has_public_change(
    previous: Option<&AntigravityActivityRecord>,
    next: &AntigravityActivityRecord,
) -> bool {
    match previous {
        None => true,
        Some(previous) => previous.phase != next.phase || previous.session_id != next.session_id,
    }
}

fn changed(
    previous: Option<&AntigravityActivityRecord>,
    next: AntigravityActivityRecord,
) -> Vec<AntigravityEffect> {
    if !has_public_change(previous, &next) {
        return Vec::new();
    }
    vec![TrackerEffect::Changed {
        upsert: vec![next],
        remove: Vec::new(),
    }]
}

#[derive(Debug, Default)]
pub struct AntigravityActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
}

impl AntigravityActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<AntigravityActivityRecord> {
        self.states.values().map(|s| s.to_record()).collect()
    }

    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot> {
        self.ledger.list_latest_completions()
    }

    pub fn track_terminal(
        &mut self,
        terminal_id: &str,
        session_id: Option<&str>,
        at: i64,
    ) -> Vec<AntigravityEffect> {
        if let Some(existing) = self.states.get_mut(terminal_id) {
            if let Some(session_id) = session_id {
                if existing.session_id.as_deref() != Some(session_id) {
                    let previous = existing.to_record();
                    existing.session_id = Some(session_id.to_string());
                    let next = existing.to_record();
                    return changed(Some(&previous), next);
                }
            }
            return Vec::new();
        }
        let state = TerminalActivity {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.map(str::to_string),
            phase: AntigravityPhase::Idle,
            updated_at: at,
            last_observed_at: at,
            busy_confirmed: false,
            submit_grace_deadline: None,
            submit_grace_retried: false,
            force_read_logged: false,
            next_force_read_at: None,
        };
        let next = state.to_record();
        self.states.insert(terminal_id.to_string(), state);
        changed(None, next)
    }

    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() == Some(session_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.session_id = Some(session_id.to_string());
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// A flushed submit line (the association's Enter capture): PROVISIONAL
    /// busy with a submit-grace reversion (the amplifier PTY-Enter model).
    /// A submit during busy re-arms NOTHING — mid-turn typing is queued
    /// steering within the same turn; it only refreshes liveness.
    pub fn note_submit(&mut self, terminal_id: &str, at: i64) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        if state.phase == AntigravityPhase::Busy {
            return Vec::new();
        }
        let previous = state.to_record();
        state.phase = AntigravityPhase::Busy;
        state.busy_confirmed = false;
        state.submit_grace_retried = false;
        state.updated_at = at;
        state.submit_grace_deadline = Some(at + ANTIGRAVITY_SUBMIT_GRACE_MS);
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// PTY output only refreshes liveness (feeds the deadman). It never
    /// ends a turn.
    pub fn note_output(&mut self, terminal_id: &str, at: i64) {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return;
        };
        if state.phase != AntigravityPhase::Busy {
            return;
        }
        state.last_observed_at = at;
        state.force_read_logged = false;
    }

    /// The lane attached with fresh evidence a turn is in flight (a rebind:
    /// the locator's match IS the pane's own prompt as the transcript's
    /// latest user record). Confirms busy without a public flap.
    pub fn note_confirm_busy(&mut self, terminal_id: &str, at: i64) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        if state.phase == AntigravityPhase::Busy {
            state.busy_confirmed = true;
            state.submit_grace_deadline = None;
            state.force_read_logged = false;
            state.next_force_read_at = None;
            return Vec::new();
        }
        let previous = state.to_record();
        state.phase = AntigravityPhase::Busy;
        state.busy_confirmed = true;
        state.submit_grace_deadline = None;
        state.updated_at = at;
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// Consume one classified transcript record (the Stage-1 candidate
    /// contract — see the module doc for the full classification table).
    pub fn note_record(
        &mut self,
        terminal_id: &str,
        record: &AntigravityTranscriptRecord,
        now: i64,
    ) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let at = record.at.unwrap_or(now);
        match record.kind {
            AntigravityRecordKind::UserMessage => {
                // The transcript's own user record confirms the submit —
                // provisional busy becomes confirmed; a record-armed busy
                // (Start-attach replay) is idempotent.
                state.last_observed_at = at;
                state.submit_grace_deadline = None;
                state.busy_confirmed = true;
                state.force_read_logged = false;
                state.next_force_read_at = None;
                if state.phase != AntigravityPhase::Busy {
                    let previous = state.to_record();
                    state.phase = AntigravityPhase::Busy;
                    state.updated_at = at;
                    let next = state.to_record();
                    return changed(Some(&previous), next);
                }
                Vec::new()
            }
            AntigravityRecordKind::TurnSettled {
                fully_idle,
                errored,
            } => {
                // Invocation completion is NOT turn completion: a partial
                // settle keeps the busy light on (outstanding async work)
                // and only refreshes liveness. A settle while not Busy is
                // a no-op (deduped per settle — replayed/duplicate settles
                // never ring twice).
                if !(fully_idle || errored) {
                    state.last_observed_at = at;
                    return Vec::new();
                }
                state.last_observed_at = at;
                if state.phase != AntigravityPhase::Busy {
                    return Vec::new();
                }
                let previous = state.to_record();
                state.submit_grace_deadline = None;
                state.phase = AntigravityPhase::Idle;
                state.busy_confirmed = false;
                state.force_read_logged = false;
                state.next_force_read_at = None;
                state.updated_at = at;
                let seq = self.ledger.record_turn_completion(terminal_id, at);
                let session_id = self
                    .states
                    .get(terminal_id)
                    .and_then(|s| s.session_id.clone());
                let next = self.states.get(terminal_id).unwrap().to_record();
                let mut effects = changed(Some(&previous), next);
                effects.push(TrackerEffect::TurnComplete {
                    terminal_id: terminal_id.to_string(),
                    session_id,
                    at,
                    completion_seq: seq,
                });
                effects
            }
        }
    }

    /// PTY exit is the authoritative end — unconditional.
    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<AntigravityEffect> {
        if self.states.remove(terminal_id).is_none() {
            return Vec::new();
        }
        vec![TrackerEffect::Changed {
            upsert: Vec::new(),
            remove: vec![terminal_id.to_string()],
        }]
    }

    /// The transcript lane degraded past recovery (a shrunk/unreadable file
    /// with no bounded re-attach): a CONFIRMED busy turn is unverifiable —
    /// crash semantics (owner ruling: probe failure = crash): clear busy
    /// AND ring the attention boundary. A PROVISIONAL busy reverts silently
    /// (no confirmed turn existed). No-op unless Busy (repeated
    /// escalations never double-ring).
    pub fn note_verify_failed(&mut self, terminal_id: &str, at: i64) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.phase != AntigravityPhase::Busy {
            return Vec::new();
        }
        let was_confirmed = state.busy_confirmed;
        tracing::error!(
            component = "antigravity-activity-tracker",
            event = "antigravity_verify_failed",
            terminal_id = %state.terminal_id,
            was_confirmed,
            "antigravity transcript lane unreadable; clearing busy (attention rings only for a confirmed turn — owner ruling: probe failure = crash)"
        );
        state.busy_confirmed = false;
        state.submit_grace_deadline = None;
        state.next_force_read_at = None;
        let previous = state.to_record();
        state.phase = AntigravityPhase::Idle;
        state.updated_at = at;
        state.last_observed_at = at;
        let next = state.to_record();
        let mut effects = changed(Some(&previous), next);
        if was_confirmed {
            effects.push(TrackerEffect::AttentionBoundary {
                terminal_id: terminal_id.to_string(),
                at,
            });
        }
        effects
    }

    /// Process due grace deadlines and the stuck-busy deadman.
    pub fn expire(&mut self, at: i64) -> Vec<AntigravityEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            // Submit-grace: first expiry force-reads and extends once; the
            // second silently reverts (no completion) — a submit that never
            // became a transcript user_message.
            if let Some(deadline) = state.submit_grace_deadline {
                if at >= deadline && state.phase == AntigravityPhase::Busy && !state.busy_confirmed
                {
                    if !state.submit_grace_retried {
                        state.submit_grace_retried = true;
                        state.submit_grace_deadline = Some(at + ANTIGRAVITY_SUBMIT_GRACE_MS);
                        effects.push(TrackerEffect::ForceRead {
                            terminal_id: state.terminal_id.clone(),
                            at,
                        });
                    } else {
                        state.submit_grace_deadline = None;
                        let previous = state.to_record();
                        state.phase = AntigravityPhase::Idle;
                        state.updated_at = at;
                        state.last_observed_at = at;
                        let next = state.to_record();
                        effects.extend(changed(Some(&previous), next));
                    }
                    continue;
                }
                if at >= deadline {
                    // Confirmed (or no longer busy) before the deadline hit.
                    state.submit_grace_deadline = None;
                }
            }

            // Deadman: a confirmed-busy terminal silent past the window
            // requests a force-read and STAYS busy — never fabricate a
            // completion.
            if state.phase == AntigravityPhase::Busy && state.busy_confirmed {
                let idle_age_ms = at - state.last_observed_at;
                let due = state
                    .next_force_read_at
                    .map(|next| at >= next)
                    .unwrap_or(idle_age_ms > ANTIGRAVITY_BUSY_DEADMAN_MS);
                if idle_age_ms > ANTIGRAVITY_BUSY_DEADMAN_MS && due {
                    if !state.force_read_logged {
                        state.force_read_logged = true;
                        tracing::warn!(
                            component = "antigravity-activity-tracker",
                            event = "antigravity_activity_deadman_force_read",
                            terminal_id = %state.terminal_id,
                            age_ms = idle_age_ms,
                            "Antigravity terminal silent past deadman; requesting force-read (staying busy)."
                        );
                    }
                    state.next_force_read_at = Some(at + ANTIGRAVITY_BUSY_DEADMAN_MS);
                    effects.push(TrackerEffect::ForceRead {
                        terminal_id: state.terminal_id.clone(),
                        at,
                    });
                }
            }
        }
        effects
    }

    /// Earliest instant [`Self::expire`] could act. `None` when nothing is
    /// busy — zero timers, zero wakes.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter_map(|state| {
                let grace = state
                    .submit_grace_deadline
                    .filter(|_| state.phase == AntigravityPhase::Busy && !state.busy_confirmed);
                let deadman = if state.phase == AntigravityPhase::Busy && state.busy_confirmed {
                    Some(
                        state
                            .next_force_read_at
                            .unwrap_or(state.last_observed_at + ANTIGRAVITY_BUSY_DEADMAN_MS + 1),
                    )
                } else {
                    None
                };
                match (grace, deadman) {
                    (Some(g), Some(d)) => Some(g.min(d)),
                    (Some(g), None) => Some(g),
                    (None, Some(d)) => Some(d),
                    (None, None) => None,
                }
            })
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn phases(effects: &[AntigravityEffect]) -> Vec<AntigravityPhase> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::Changed { upsert, .. } => {
                    Some(upsert.iter().map(|r| r.phase).collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn completions(effects: &[AntigravityEffect]) -> Vec<i64> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::TurnComplete { completion_seq, .. } => Some(*completion_seq),
                _ => None,
            })
            .collect()
    }

    fn force_reads(effects: &[AntigravityEffect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, TrackerEffect::ForceRead { .. }))
            .count()
    }

    fn user_message(at: Option<i64>) -> AntigravityTranscriptRecord {
        AntigravityTranscriptRecord {
            kind: AntigravityRecordKind::UserMessage,
            at,
        }
    }

    fn settled(fully_idle: bool, errored: bool, at: Option<i64>) -> AntigravityTranscriptRecord {
        AntigravityTranscriptRecord {
            kind: AntigravityRecordKind::TurnSettled {
                fully_idle,
                errored,
            },
            at,
        }
    }

    #[test]
    fn deadman_constant_is_the_pinned_window() {
        assert_eq!(ANTIGRAVITY_BUSY_DEADMAN_MS, 120_000);
        assert_eq!(ANTIGRAVITY_SUBMIT_GRACE_MS, 2_000);
    }

    #[test]
    fn submit_then_settle_emits_exactly_one_completion_with_monotonic_seq() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);

        let effects = tracker.note_submit("t1", 10);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Busy]);

        // The transcript's own user_message confirms — no public flap.
        let effects = tracker.note_record("t1", &user_message(Some(20)), 20);
        assert!(effects.is_empty());

        let effects = tracker.note_record("t1", &settled(true, false, Some(900)), 900);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);

        // A duplicate settle replayed while idle NEVER completes again.
        let effects = tracker.note_record("t1", &settled(true, false, Some(950)), 950);
        assert!(effects.is_empty());

        // A second turn mints the next monotonic seq.
        tracker.note_submit("t1", 1_000);
        let effects = tracker.note_record("t1", &user_message(Some(1_010)), 1_010);
        assert!(effects.is_empty());
        let effects = tracker.note_record("t1", &settled(true, false, Some(2_000)), 2_000);
        assert_eq!(completions(&effects), vec![2]);
        assert_eq!(tracker.list_latest_completions()[0].completion_seq, 2);
    }

    #[test]
    fn partial_settle_stays_busy_and_a_later_full_settle_completes_once() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);

        // Invocation completion is NOT turn completion: async work remains.
        let effects = tracker.note_record("t1", &settled(false, false, Some(100)), 100);
        assert!(completions(&effects).is_empty());
        assert!(phases(&effects).is_empty(), "no public flap — stays busy");
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // A repeated partial settle changes nothing.
        let effects = tracker.note_record("t1", &settled(false, false, Some(110)), 110);
        assert!(effects.is_empty());

        // The full settle completes exactly once.
        let effects = tracker.note_record("t1", &settled(true, false, Some(500)), 500);
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
    }

    #[test]
    fn errored_settle_completes_even_while_async_work_outstanding() {
        // Outcome-uniform attention: an errored turn end is still a turn end.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);

        let effects = tracker.note_record("t1", &settled(false, true, Some(300)), 300);
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
    }

    #[test]
    fn deadman_force_reads_after_120s_quiet_and_stays_busy() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);

        let effects = tracker.expire(20 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);
        assert!(
            completions(&effects).is_empty(),
            "the deadman NEVER fabricates a completion"
        );

        // Not due again until the repeat interval.
        assert!(tracker
            .expire(20 + ANTIGRAVITY_BUSY_DEADMAN_MS + 2)
            .is_empty());

        // The next window force-reads again (still busy, never a completion).
        let effects = tracker.expire(20 + 2 * ANTIGRAVITY_BUSY_DEADMAN_MS + 2);
        assert_eq!(force_reads(&effects), 1);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);
    }

    #[test]
    fn untracked_terminal_yields_no_effects() {
        let mut tracker = AntigravityActivityTracker::new();
        assert!(tracker.note_submit("t-unknown", 10).is_empty());
        assert!(tracker
            .note_record("t-unknown", &user_message(Some(20)), 20)
            .is_empty());
        assert!(tracker
            .note_record("t-unknown", &settled(true, false, Some(30)), 30)
            .is_empty());
        tracker.note_output("t-unknown", 40);
        assert!(tracker
            .expire(40 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1)
            .is_empty());
        assert!(tracker.note_exit("t-unknown").is_empty());
        assert!(tracker.list().is_empty());
    }

    #[test]
    fn provisional_submit_grace_force_reads_once_then_reverts() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);

        // First grace expiry: one force-read retry, still busy (no flap).
        let first = tracker.expire(10 + ANTIGRAVITY_SUBMIT_GRACE_MS);
        assert_eq!(force_reads(&first), 1);
        assert!(phases(&first).is_empty());
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // Second expiry: silent reversion, NO completion.
        let second = tracker.expire(10 + 2 * ANTIGRAVITY_SUBMIT_GRACE_MS);
        assert_eq!(phases(&second), vec![AntigravityPhase::Idle]);
        assert!(completions(&second).is_empty());
    }

    #[test]
    fn a_settle_found_by_the_force_read_completes() {
        // The deadman's ForceRead asks the hub to re-read the transcript; a
        // settle found there completes the turn normally.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        assert_eq!(
            force_reads(&tracker.expire(20 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1)),
            1
        );
        let effects = tracker.note_record("t1", &settled(true, false, Some(500)), 500);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn pty_output_feeds_the_deadman_only() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        tracker.note_output("t1", 100_000);
        assert!(tracker
            .expire(20 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1)
            .is_empty());
        let effects = tracker.expire(100_000 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1);
    }

    #[test]
    fn exit_removes_unconditionally() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        let effects = tracker.note_exit("t1");
        assert_eq!(
            effects,
            vec![TrackerEffect::Changed {
                upsert: vec![],
                remove: vec!["t1".to_string()]
            }]
        );
    }

    #[test]
    fn verify_failed_clears_confirmed_busy_and_rings_attention() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        let effects = tracker.note_verify_failed("t1", 5000);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert!(completions(&effects).is_empty());
        // Effect-order contract: the boundary must be the LAST element, so
        // the gate arms only after the Idle upsert landed.
        assert!(matches!(
            effects.last(),
            Some(TrackerEffect::AttentionBoundary { at: 5000, .. })
        ));
        // Idempotent: a second failure while idle is a no-op.
        assert!(tracker.note_verify_failed("t1", 6000).is_empty());
    }

    #[test]
    fn verify_failed_reverts_provisional_busy_silently() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_submit("t1", 10);
        let effects = tracker.note_verify_failed("t1", 100);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert!(completions(&effects).is_empty());
        assert!(
            !effects
                .iter()
                .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })),
            "no confirmed turn existed — no attention ring"
        );
    }

    #[test]
    fn rebind_confirm_busy_holds_the_light_without_a_flap() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-old"), 0);
        tracker.note_submit("t1", 10);
        // The rebind attach confirms busy (the locator's match IS the
        // pane's own prompt as the new transcript's latest user record) and
        // rebinds identity in one step.
        let mut effects = tracker.bind_session("t1", "conv-new");
        let confirm = tracker.note_confirm_busy("t1", 50);
        effects.extend(confirm);
        assert!(
            effects.iter().all(|e| match e {
                TrackerEffect::Changed { upsert, .. } => upsert
                    .iter()
                    .all(|r| r.phase == AntigravityPhase::Busy),
                _ => true,
            }),
            "already busy from the provisional submit — the light never goes idle (the bind upsert legitimately re-asserts Busy)"
        );
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);
        // The grace no longer reverts a confirmed busy.
        assert!(tracker
            .expire(10 + 2 * ANTIGRAVITY_SUBMIT_GRACE_MS)
            .is_empty());
        // A later full settle in the new conversation completes once.
        let effects = tracker.note_record("t1", &settled(true, false, Some(900)), 900);
        assert_eq!(completions(&effects), vec![1]);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("conv-new".to_string())));
    }

    #[test]
    fn next_deadline_tracks_grace_then_deadman_then_none() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        assert_eq!(tracker.next_deadline(), None);

        tracker.note_submit("t1", 10);
        assert_eq!(
            tracker.next_deadline(),
            Some(10 + ANTIGRAVITY_SUBMIT_GRACE_MS)
        );

        tracker.note_record("t1", &user_message(Some(20)), 20);
        assert_eq!(
            tracker.next_deadline(),
            Some(20 + ANTIGRAVITY_BUSY_DEADMAN_MS + 1)
        );

        tracker.note_record("t1", &settled(true, false, Some(30)), 30);
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn bind_session_flows_into_completions() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.bind_session("t1", "conv-7");
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        let effects = tracker.note_record("t1", &settled(true, false, Some(30)), 30);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("conv-7".to_string())));
    }

    #[test]
    fn record_at_coercion_accepts_numeric_and_iso_forms() {
        // Numeric epoch-ms (the rebind fixtures' shape)...
        assert_eq!(
            record_at_ms(&serde_json::json!(1_700_000_000_000i64)),
            Some(1_700_000_000_000)
        );
        // ...and ISO strings (the fake CLI's shape).
        assert_eq!(
            record_at_ms(&serde_json::json!("2026-07-23T10:00:00.500Z")),
            Some(1_784_800_800_500)
        );
        assert_eq!(record_at_ms(&serde_json::json!("garbage")), None);
        assert_eq!(record_at_ms(&serde_json::json!(null)), None);
    }

    #[test]
    fn classify_is_conservative() {
        // user_message arms a submit.
        assert_eq!(
            parse_transcript_record(&serde_json::json!({
                "type": "user_message", "conversationId": "c", "text": "hi", "at": 5
            })),
            Some(AntigravityRecordKind::UserMessage)
        );
        // turn_settled with both flags.
        assert_eq!(
            parse_transcript_record(&serde_json::json!({
                "type": "turn_settled", "conversationId": "c",
                "outcome": "completed", "fullyIdle": true, "at": 5
            })),
            Some(AntigravityRecordKind::TurnSettled {
                fully_idle: true,
                errored: false
            })
        );
        assert_eq!(
            parse_transcript_record(&serde_json::json!({
                "type": "turn_settled", "conversationId": "c",
                "outcome": "errored", "fullyIdle": false, "at": 5
            })),
            Some(AntigravityRecordKind::TurnSettled {
                fully_idle: false,
                errored: true
            })
        );
        // Conservative defaults: an absent fullyIdle is NOT full idle, and an
        // unknown outcome is NOT an error.
        assert_eq!(
            parse_transcript_record(&serde_json::json!({
                "type": "turn_settled", "conversationId": "c", "at": 5
            })),
            Some(AntigravityRecordKind::TurnSettled {
                fully_idle: false,
                errored: false
            })
        );
        // Unknown record types and non-objects are not lifecycle records.
        assert_eq!(
            parse_transcript_record(&serde_json::json!({
                "type": "assistant_message", "conversationId": "c", "at": 5
            })),
            None
        );
        assert_eq!(
            parse_transcript_record(&serde_json::json!("plain string")),
            None
        );
    }

    // ── the transcript tailer (the amplifier tailer model) ─────────────

    fn transcript_line(kind: &str, extra: &str) -> String {
        format!(
            "{{\"type\":\"{kind}\",\"conversationId\":\"conv-1\",\"at\":\"2026-10-29T20:00:01.000Z\"{extra}}}\n"
        )
    }

    #[test]
    fn tailer_incremental_reads_only_consume_appended_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            [
                transcript_line("session_start", ""),
                transcript_line("user_message", ",\"text\":\"first prompt\""),
            ]
            .concat(),
        )
        .unwrap();

        let mut tailer = AntigravityTranscriptTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok {
                records,
                skipped_lines,
                ..
            } => {
                assert_eq!(records.len(), 1, "the prefilter skips session_start");
                assert_eq!(records[0].kind, AntigravityRecordKind::UserMessage);
                assert_eq!(skipped_lines, 1);
                assert_eq!(records[0].at, Some(1_793_304_001_000));
            }
            other => panic!("expected ok, got {other:?}"),
        }

        // No new bytes: nothing consumed.
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok {
                records,
                bytes_consumed,
                ..
            } => {
                assert!(records.is_empty());
                assert_eq!(bytes_consumed, 0);
            }
            other => panic!("expected ok, got {other:?}"),
        }

        // Append a settle: only the new line is read.
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(
            transcript_line(
                "turn_settled",
                ",\"outcome\":\"completed\",\"fullyIdle\":true",
            )
            .as_bytes(),
        )
        .unwrap();
        drop(f);
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => {
                assert_eq!(records.len(), 1);
                assert_eq!(
                    records[0].kind,
                    AntigravityRecordKind::TurnSettled {
                        fully_idle: true,
                        errored: false
                    }
                );
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn tailer_eof_attach_skips_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            [
                transcript_line("user_message", ",\"text\":\"old\""),
                transcript_line(
                    "turn_settled",
                    ",\"outcome\":\"completed\",\"fullyIdle\":true",
                ),
            ]
            .concat(),
        )
        .unwrap();

        let mut tailer = AntigravityTranscriptTailer::new(&path);
        tailer.attach(AttachAt::Eof).unwrap();
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn tailer_partial_trailing_line_is_buffered_until_completed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let full = transcript_line(
            "turn_settled",
            ",\"outcome\":\"completed\",\"fullyIdle\":true",
        );
        let (head, tail) = full.split_at(20);
        std::fs::write(&path, head).unwrap();

        let mut tailer = AntigravityTranscriptTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
        assert!(tailer.buffered_bytes() > 0);

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(tail.as_bytes()).unwrap();
        drop(f);
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => assert_eq!(records.len(), 1),
            other => panic!("expected ok, got {other:?}"),
        }
        assert_eq!(tailer.buffered_bytes(), 0);
    }

    #[test]
    fn tailer_file_reset_degrades_never_guesses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, transcript_line("user_message", ",\"text\":\"x\"")).unwrap();

        let mut tailer = AntigravityTranscriptTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        let _ = tailer.read();

        // Truncate below the offset: degrade, never guess.
        std::fs::write(&path, "").unwrap();
        match tailer.read() {
            AntigravityTailerReadOutcome::Degraded { reason, .. } => {
                assert_eq!(reason, AntigravityTailerDegradeReason::FileReset)
            }
            other => panic!("expected degraded, got {other:?}"),
        }
        assert!(tailer.is_degraded());
    }

    #[test]
    fn tailer_oversized_line_is_dropped_without_degrading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        let mut oversized = String::from("{\"type\":\"user_message\",\"pad\":\"");
        oversized.push_str(&"x".repeat(PARTIAL_MAX_BYTES + 1024));
        std::fs::write(&path, &oversized).unwrap();

        let mut tailer = AntigravityTranscriptTailer::new(&path);
        tailer.attach(AttachAt::Start).unwrap();
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => assert!(records.is_empty()),
            other => panic!("expected ok, got {other:?}"),
        }
        assert_eq!(tailer.buffered_bytes(), 0);

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(b"\"}\n").unwrap();
        f.write_all(transcript_line("user_message", ",\"text\":\"after\"").as_bytes())
            .unwrap();
        drop(f);
        match tailer.read() {
            AntigravityTailerReadOutcome::Ok { records, .. } => assert_eq!(records.len(), 1),
            other => panic!("expected ok, got {other:?}"),
        }
    }
}

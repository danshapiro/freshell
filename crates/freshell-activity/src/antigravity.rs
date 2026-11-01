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
//!   settle (a settle while not Busy is a no-op, and a settle whose `at` is
//!   at/before the last COMPLETED settle's `at` is a replayed record —
//!   inert in every phase; replayed/duplicate settles never ring twice).
//! * `turn_settled{fullyIdle:false}` ⇒ stay Busy (outstanding async work —
//!   invocation completion is NOT turn completion).
//! * `turn_settled{outcome:"errored"}` ⇒ TurnComplete (attention is
//!   outcome-uniform: an errored turn end is still a turn end).
//! * Deadman `ANTIGRAVITY_BUSY_DEADMAN_MS` quiet while confirmed-busy ⇒
//!   ForceRead (re-read the transcript; a found fresh settle completes,
//!   else the pane stays busy — the deadman NEVER fabricates a completion).
//!
//! Only `turn_settled` records mint completions; the PTY lane (a flushed
//! submit) is a PROVISIONAL busy with a submit-grace reversion (the amplifier
//! [`AmplifierActivityTracker`](crate::amplifier::tracker) model — an empty or
//! rejected submit can never wedge the pane busy), confirmed by the
//! transcript's own `user_message`.
//!
//! ATTACH BASELINE, SUBMIT-ANCHORED (whole-delta review round 2, Major 2;
//! round 1 established the baseline itself): the records already on a
//! transcript at lane attach (resume, rebind, restart-restore — the
//! transcript can carry the conversation's whole history) are fed to
//! [`AntigravityActivityTracker::note_attach_baseline`] together with
//! the SUBMIT that armed the pane (the located Enter's `at` — the
//! locator's match proved that submit is the pane's own). The baseline
//! boundary is that submit's `at`, widened by the locator's recency
//! tolerance (round 4, Minor 1):
//!
//! * a record whose own `at` predates the submit by MORE than
//!   [`ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS`] is HISTORY: it seeds
//!   the per-settle dedupe watermark and the busy state WITHOUT
//!   emitting effects — historical settles never mint completions, and
//!   the current in-flight turn (a user record after the last settle)
//!   is recognized as busy (round 1's property, unchanged);
//! * a record whose own `at` is at/after `submit_at - tolerance` is a
//!   LIVE turn event even though the first drain reads it from disk.
//!   The `>=` floor matches the locator's recency rule EXACTLY (the
//!   same operator, the same shared constant — round 2 compared
//!   against the bare submit, which round 3's backward tolerance
//!   silently diverged from): the registry writes the PTY bytes BEFORE
//!   stamping the Input event, and the CLI's own clock can lag ours, so
//!   the pane's own prompt — and a QUICK turn's settle — can land on
//!   disk stamped within the tolerance BEFORE the captured submit.
//!   Identity binds (the locator's tolerance admits the record) and the
//!   settle rings EXACTLY ONCE through the same `note_record` path a
//!   streamed record takes (the ledger + seeded watermark dedupe makes
//!   re-drains of it inert). Without this alignment the settle folded
//!   as history and the turn's completion alert was lost.
//! * a record with an UNPARSEABLE `at` cannot PROVE its recency — it
//!   fails toward history/silence (unlike a live-streamed record, whose
//!   ARRIVAL after attach proves recency and which folds `now` in).
//!
//! A pane attached with NO captured submit (the `None` boundary — e.g.
//! a future restart-resume arming purely from on-disk state) has its
//! boundary defined honestly from what the records themselves prove:
//! the LATEST user record's `at` stands in as the effective submit
//! (the newest deliberate user action the transcript shows). That
//! derived boundary keeps its STRICT floor (records at/after it live,
//! everything before history): the tolerance exists to absorb the
//! cross-process/cross-clock skew between the REGISTRY's submit stamp
//! and the CLI's record stamps — a skew that cannot arise when the
//! boundary is itself one of the records' own stamps (one clock). The
//! last turn's settle therefore rings — the attention contract's
//! tiebreaker (a turn end the user may not have witnessed must ring;
//! the settle may have landed while the pane was disconnected);
//! everything before the latest user record is history and stays
//! silent. Residual: if the user DID witness that last turn end (the
//! restart happened long after it settled), this rings one false bell
//! per restored pane — accepted because the pane owes exactly the turn
//! ends it cannot prove were witnessed, and every current attach path
//! (locator-driven) carries a real captured submit anyway. A
//! transcript with NO user record proves no user action at all:
//! everything is history.
//!
//! This is why the hub attaches the tailer at `Start` for EVERY
//! transcript size (the amplifier's catch-up cap does not apply here:
//! replayed history classifies as baseline, never as live attention,
//! and a settle written during the locator's window is classified by
//! the submit boundary instead of being skipped by an Eof attach).
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
use freshell_protocol::TerminalTurnOutcome;
// The locator's recency tolerance (round 4, Minor 1): the SHARED constant —
// the baseline's live/history floor and the locator's match rule accept the
// same window, so a record the locator binds can never classify as history
// here (and vice versa). Canonical home: `freshell_protocol`; re-exported
// by `freshell_sessions::antigravity_locator`.
use freshell_protocol::ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS;

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

    /// Attach at the start (the hub's only form post-review-Major-1: the
    /// initial drain reads the whole existing file as the tracker's
    /// BASELINE — history classifies without effects, so a young
    /// conversation and a months-old resume take the same path) or EOF
    /// (a raw tailer capability the hub no longer selects: it would
    /// skip a settle already on disk). Which records classify as
    /// baseline vs live is the CALLER's decision (the hub marks the
    /// first drain after attach); the tailer only owns the offset.
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
    /// The attach-time BASELINE watermark (whole-delta review Major 1,
    /// submit-anchored in round 2): the `at` of the last COMPLETING
    /// settle among the records that PREDATE the boundary submit when
    /// the lane attached. Consulted beside the ledger's
    /// `last_completion_at` by the per-settle dedupe, so replays of
    /// pre-submit settles are inert and the FIRST live settle after the
    /// boundary must postdate every historical one. Resides on the
    /// per-track state (a respawn re-seeds it), unlike the ledger's
    /// deliberately-surviving snapshots.
    attach_baseline_completed_at: Option<i64>,
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

    /// The crash-semantics busy resolution shared by the lane-degrade
    /// ([`AntigravityActivityTracker::note_verify_failed`]) and
    /// failed-attach
    /// ([`AntigravityActivityTracker::note_lane_attach_failed`])
    /// transitions (owner ruling: probe failure = crash): clears every
    /// busy flag and flips the phase to Idle. Returns whether the
    /// cleared turn was CONFIRMED (the caller rings the attention
    /// boundary exactly once for it).
    fn resolve_busy_crash(&mut self, at: i64) -> bool {
        let was_confirmed = self.busy_confirmed;
        self.busy_confirmed = false;
        self.submit_grace_deadline = None;
        self.next_force_read_at = None;
        self.phase = AntigravityPhase::Idle;
        self.updated_at = at;
        self.last_observed_at = at;
        was_confirmed
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
            attach_baseline_completed_at: None,
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

    /// The attach-time BASELINE, anchored to the SUBMIT (whole-delta
    /// review round 1 established the baseline; round 2, Major 2 anchored
    /// it; round 4, Minor 1 aligned its floor with the locator's
    /// tolerance): seed the tracker from the transcript's records that
    /// are ALREADY on disk at lane attach, classified at the baseline
    /// boundary — the captured submit's `at` (`submit_at`) widened by
    /// [`ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS`]. What the baseline
    /// seeds:
    ///
    /// * HISTORICAL records (own `at` before `submit_at - tolerance`,
    ///   or `at` unparseable — unprovable recency fails toward silence):
    ///   the per-settle dedupe watermark (the `at` of the last
    ///   completing settle among them; replays of pre-window settles are
    ///   inert forever after) and the busy state, judged from their
    ///   sequence: a user record after the last completing settle means
    ///   the turn was in flight at the submit — the pane arms confirmed
    ///   busy (the [`Self::note_confirm_busy`] transition, flap-free
    ///   when the pane is already provisionally busy); otherwise the
    ///   pre-submit history ended settled and the pane seeds idle — a
    ///   provisionally-busy pane whose pre-submit history ended settled
    ///   resolves with a public Busy→Idle upsert but NO completion and
    ///   NO attention boundary (the gate treats an idle phase report as
    ///   inert, so this rings nothing).
    /// * LIVE records (own `at` at/after `submit_at - tolerance` — the
    ///   locator's exact recency rule, same operator, same shared
    ///   constant): replayed through [`Self::note_record`] exactly as if
    ///   the tailer had streamed them — the pane's own prompt confirms
    ///   busy, and a QUICK turn's settle that landed on disk stamped
    ///   within the tolerance before the captured submit (the
    ///   write-before-stamp skew the tolerance exists for) mints its
    ///   completion ONCE (the ledger dedupe makes re-drains of the same
    ///   record inert).
    ///
    /// `submit_at == None` (no captured submit — e.g. a future
    /// restart-resume arming from on-disk state): the boundary is
    /// derived honestly from the records (the module header's contract):
    /// the LATEST user record's `at` stands in as the effective submit,
    /// with its STRICT floor (no cross-clock skew can arise between one
    /// clock's own stamps — the tolerance is not applied); with no user
    /// record at all, everything is history. When live records exist
    /// they alone drive the phase (the pane's own post-submit turn);
    /// the historical in-flight fold then only applies to an
    /// all-historical baseline. Records appended after the baseline
    /// stream live through [`Self::note_record`] exactly as before.
    /// Untracked terminal: a no-op, like every note.
    pub fn note_attach_baseline(
        &mut self,
        terminal_id: &str,
        records: &[AntigravityTranscriptRecord],
        now: i64,
        submit_at: Option<i64>,
    ) -> Vec<AntigravityEffect> {
        // The boundary: the captured submit's `at`, or — with none — the
        // latest user record's `at` (the module header's None contract);
        // a transcript with no user record (or an unparseable one) proves
        // no provable user action: everything is history (`now`).
        let boundary = match submit_at {
            Some(at) => at,
            None => records
                .iter()
                .rev()
                .find(|record| matches!(record.kind, AntigravityRecordKind::UserMessage))
                .and_then(|record| record.at)
                .unwrap_or(now),
        };
        // The LIVE floor (round 4, Minor 1): with a captured submit, the
        // locator's recency rule — the same tolerance that admitted the
        // matching user record — decides liveness, so a record stamped
        // within the window BEFORE the submit is the pane's own LIVE turn
        // (a strict `>= boundary` here folded a quickly settled turn's
        // records as history and silently lost its completion alert,
        // while the locator had still bound identity). With no captured
        // submit the derived boundary keeps its STRICT floor: it is one
        // of the records' own stamps, so the cross-clock skew the
        // tolerance absorbs cannot arise.
        let live_floor = match submit_at {
            Some(_) => boundary - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS,
            None => boundary,
        };
        // Historical fold (file order): records whose own `at` predates
        // the live floor — plus unparseable-`at` records (unprovable
        // recency fails toward silence). Live records are collected for
        // the replay below.
        let mut baseline_completed_at: Option<i64> = None;
        let mut in_flight = false;
        let mut live: Vec<AntigravityTranscriptRecord> = Vec::new();
        for record in records {
            let is_live = record.at.map(|at| at >= live_floor).unwrap_or(false);
            if is_live {
                live.push(*record);
                continue;
            }
            let at = record.at.unwrap_or(now);
            match record.kind {
                AntigravityRecordKind::UserMessage => in_flight = true,
                AntigravityRecordKind::TurnSettled {
                    fully_idle,
                    errored,
                } => {
                    if fully_idle || errored {
                        in_flight = false;
                        baseline_completed_at =
                            Some(baseline_completed_at.map_or(at, |prev: i64| prev.max(at)));
                    }
                    // A partial settle (outstanding async work) never ends
                    // a turn: in_flight holds.
                }
            }
        }
        {
            let Some(state) = self.states.get_mut(terminal_id) else {
                return Vec::new();
            };
            state.attach_baseline_completed_at = baseline_completed_at;
        }
        // LIVE replay: records at/after the submit flow through
        // `note_record` exactly as a streamed record would — minting the
        // pane's own prompt (busy) and a window-settle's completion
        // (exactly once; the ledger records it, so re-drains of the same
        // record are inert). When live records exist, they alone drive
        // the phase: the pane's own post-submit turn is the current
        // truth.
        let mut effects = Vec::new();
        for record in &live {
            effects.extend(self.note_record(terminal_id, record, now));
        }
        if !live.is_empty() {
            return effects;
        }
        // All-historical baseline: resolve the phase from the fold.
        if in_flight {
            // The transcript's pre-submit records show a turn in flight:
            // the pane arms (confirmed) busy through the exact
            // rebind-attach confirm transition.
            effects.extend(self.note_confirm_busy(terminal_id, now));
            return effects;
        }
        // Fully settled on disk: seed idle-with-baseline. A provisional
        // busy resolves here (the transcript already proved the turn's
        // fate); a confirmed stale busy (a rebind away from a conversation
        // whose records ended settled) clears too — the baseline is the
        // pane's CURRENT truth.
        if let Some(state) = self.states.get_mut(terminal_id) {
            state.busy_confirmed = false;
            state.submit_grace_deadline = None;
            state.force_read_logged = false;
            state.next_force_read_at = None;
            state.last_observed_at = now;
            if state.phase != AntigravityPhase::Idle {
                let previous = state.to_record();
                state.phase = AntigravityPhase::Idle;
                state.updated_at = now;
                let next = state.to_record();
                effects.extend(changed(Some(&previous), next));
            }
        }
        effects
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
                // Per-settle dedupe (plan Task 13's `/dup:` scenario): a
                // settle whose `at` is at/before the last COMPLETED settle's
                // `at` for this terminal is a REPLAY of that settle record
                // (a byte-faithful duplicate the CLI re-appended — the
                // same `at` by construction), not a new turn end. The
                // replay is inert even while Busy (the `/dup:` line's own
                // Enter arms the provisional busy before the record lands,
                // so the phase no-op above cannot catch it): no second
                // completion, no phase flap, no liveness feed — a stale
                // record is not evidence the running turn is alive.
                // The watermark is the LEDGER's last completion OR the
                // attach baseline (whole-delta review Major 1, round 2)
                // — a replay of a pre-submit settle is the same settle.
                let last_completed_at = self
                    .ledger
                    .last_completion_at(terminal_id)
                    .max(state.attach_baseline_completed_at);
                if let Some(last_completed_at) = last_completed_at {
                    if at <= last_completed_at {
                        return Vec::new();
                    }
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
                    // The settle record's own outcome: `errored` maps to
                    // Failed, anything else to Completed (the module header's
                    // outcome-uniform rule — an errored turn end is still a
                    // turn end, never a silent drop).
                    outcome: Some(if errored {
                        TerminalTurnOutcome::Failed
                    } else {
                        TerminalTurnOutcome::Completed
                    }),
                    outcome_update: false,
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
        let previous = state.to_record();
        let was_confirmed = state.resolve_busy_crash(at);
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

    /// A failed (re)attach — the transcript lane could not be
    /// ESTABLISHED (whole-delta review round 4, Minor 2): the hub's
    /// tailer-attach or watcher-install failure on a rebind. The lane
    /// transitions to the honest NO-IDENTITY state:
    ///
    /// * the STALE session binding clears — the UI must not retain the
    ///   old conversation's id (the identity layer has already moved to
    ///   the NEW conversation, but the activity lane can never watch
    ///   it, so the activity truth is "no session");
    /// * busy resolves with the SAME crash semantics as
    ///   [`Self::note_verify_failed`]: a CONFIRMED busy turn is
    ///   unverifiable (its settle can never be observed through this
    ///   pane again) and rings the attention boundary exactly once; a
    ///   provisional busy reverts silently. Without this, a rebind
    ///   whose watcher could not install left the pane stuck busy
    ///   forever — the deadman's force-reads had no lane to read —
    ///   while the activity record still claimed the old session id;
    /// * the pane keeps its PTY-only activity: the next submit re-opens
    ///   the locator window and the sweep's successful attach re-binds
    ///   identity and re-establishes busy through the attach baseline.
    ///
    /// Idempotent: a repeat while already cleared is a no-op (never a
    /// second boundary). Untracked terminal: a no-op, like every note.
    pub fn note_lane_attach_failed(
        &mut self,
        terminal_id: &str,
        at: i64,
    ) -> Vec<AntigravityEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        if state.session_id.is_some() {
            let previous = state.to_record();
            state.session_id = None;
            effects.extend(changed(Some(&previous), state.to_record()));
        }
        if state.phase == AntigravityPhase::Busy {
            let was_confirmed = state.busy_confirmed;
            tracing::warn!(
                component = "antigravity-activity-tracker",
                event = "antigravity_lane_attach_failed",
                terminal_id = %state.terminal_id,
                was_confirmed,
                "antigravity transcript lane could not be established; clearing the stale session binding and resolving busy (crash attention rings only for a confirmed turn — the same owner ruling as verify-failed)"
            );
            let previous = state.to_record();
            state.resolve_busy_crash(at);
            effects.extend(changed(Some(&previous), state.to_record()));
            if was_confirmed {
                effects.push(TrackerEffect::AttentionBoundary {
                    terminal_id: terminal_id.to_string(),
                    at,
                });
            }
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

    /// Plan Task 13's duplicate-settle scenario (the fake's `/dup:` verb):
    /// a byte-faithful replay of an ALREADY-COMPLETED settle record (same
    /// `at`) must be inert even when it arrives while the pane is Busy —
    /// the replay is submitted through a fresh Enter, so the provisional
    /// busy is armed BEFORE the record lands and the "settle while not
    /// Busy" no-op cannot catch it. The per-settle identity (`at`) is the
    /// dedupe: a settle at/before the last COMPLETED settle's `at` is the
    /// same settle — no second completion, no phase flap, and the next
    /// genuine settle still completes with the next monotonic seq.
    #[test]
    fn duplicate_settle_replayed_while_busy_never_completes_again() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        let effects = tracker.note_record("t1", &settled(true, false, Some(900)), 900);
        assert_eq!(completions(&effects), vec![1]);

        // The `/dup:` shape: a fresh submit arms the provisional busy, then
        // the byte-faithful copy of the SAME settle (same `at`) lands.
        let effects = tracker.note_submit("t1", 5_000);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Busy]);
        let effects = tracker.note_record("t1", &settled(true, false, Some(900)), 5_000);
        assert!(
            effects.is_empty(),
            "the replayed settle is inert: no completion, no phase flap — got {effects:?}"
        );
        assert_eq!(
            tracker.list()[0].phase,
            AntigravityPhase::Busy,
            "the provisional busy stays armed for the submit-grace to revert"
        );

        // The next GENUINE settle (a fresh `at` past the last completed one)
        // still completes exactly once, with the next monotonic seq.
        tracker.note_record("t1", &user_message(Some(5_010)), 5_010);
        let effects = tracker.note_record("t1", &settled(true, false, Some(6_000)), 6_000);
        assert_eq!(completions(&effects), vec![2]);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
    }

    /// The same guard protects a CONFIRMED turn in flight: a stale replay of
    /// a previous turn's settle must never complete (or clear) the running
    /// turn — the phantom-completion hazard the plan's scenario rules out.
    #[test]
    fn duplicate_settle_replayed_mid_turn_keeps_the_running_turn_busy() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        tracker.note_record("t1", &settled(true, false, Some(900)), 900);

        // A new CONFIRMED turn starts (submit + user_message)…
        tracker.note_submit("t1", 5_000);
        tracker.note_record("t1", &user_message(Some(5_010)), 5_010);
        // …and the dead launch's stale settle copy lands mid-turn.
        let effects = tracker.note_record("t1", &settled(true, false, Some(900)), 5_050);
        assert!(
            effects.is_empty(),
            "a stale replay never completes or clears the running turn — got {effects:?}"
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // The running turn's OWN settle completes exactly once.
        let effects = tracker.note_record("t1", &settled(true, false, Some(7_000)), 7_000);
        assert_eq!(completions(&effects), vec![2]);
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

    /// Whole-delta review round 4, Minor 2: a rebind whose lane cannot be
    /// installed (watcher construction / watch registration / tailer
    /// attach failure at the hub) must leave the honest NO-IDENTITY
    /// state — the stale session binding clears (the UI must not retain
    /// the old conversation's id), a CONFIRMED busy clears with crash
    /// attention (exactly one boundary, last in the effect order), and
    /// no busy assertion leaks (the deadman can never fire again — the
    /// pane is idle with no lane to force-read). A later successful
    /// bind re-establishes identity, and the next turn's completion
    /// carries the NEW conversation id.
    #[test]
    fn lane_attach_failure_clears_stale_identity_and_confirmed_busy_then_rebinds() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-old"), 0);
        tracker.note_submit("t1", 10);
        tracker.note_record("t1", &user_message(Some(20)), 20);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // The failed rebind: the lane never attaches to conv-new.
        let effects = tracker.note_lane_attach_failed("t1", 100);
        // The stale session binding cleared in a public upsert…
        assert!(
            effects.iter().any(|e| match e {
                TrackerEffect::Changed { upsert, .. } =>
                    upsert.iter().any(|r| r.session_id.is_none()),
                _ => false,
            }),
            "the old conversation id must clear: {effects:?}"
        );
        // …busy cleared with crash attention — exactly ONE boundary, the
        // LAST effect (the gate arms only after the Idle upsert landed).
        assert_eq!(
            effects
                .iter()
                .filter(|e| matches!(e, TrackerEffect::AttentionBoundary { .. }))
                .count(),
            1,
            "a confirmed turn became unverifiable — exactly one crash ring: {effects:?}"
        );
        assert!(matches!(
            effects.last(),
            Some(TrackerEffect::AttentionBoundary { at: 100, .. })
        ));
        let record = &tracker.list()[0];
        assert_eq!(record.session_id, None, "no stale id survives");
        assert_eq!(record.phase, AntigravityPhase::Idle, "busy cleared");
        // No busy assertion leaks: expire at any far-future instant
        // force-reads nothing (the deadman only arms on confirmed busy).
        assert!(
            tracker
                .expire(100 + 10 * ANTIGRAVITY_BUSY_DEADMAN_MS)
                .is_empty(),
            "no deadman force-read may leak from a lane-less pane"
        );
        // Idempotent: a repeat failure while already cleared is a no-op.
        assert!(tracker.note_lane_attach_failed("t1", 200).is_empty());

        // A later successful bind re-establishes identity, and the next
        // turn's completion carries the NEW conversation id.
        tracker.bind_session("t1", "conv-new");
        assert_eq!(tracker.list()[0].session_id, Some("conv-new".to_string()));
        tracker.note_submit("t1", 1_000);
        tracker.note_record("t1", &user_message(Some(1_010)), 1_010);
        let effects = tracker.note_record("t1", &settled(true, false, Some(2_000)), 2_000);
        assert_eq!(completions(&effects), vec![1]);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("conv-new".to_string())));
    }

    /// The provisional and no-session variants of the failed-attach
    /// transition: a PROVISIONAL busy reverts silently (no boundary —
    /// no confirmed turn existed), an idle pane only clears its session
    /// binding, and an untracked terminal is a no-op like every note.
    #[test]
    fn lane_attach_failure_reverts_provisional_busy_silently_and_is_honest_when_idle() {
        // Provisional busy (submit only — the transcript never
        // confirmed a turn): clears with NO attention boundary.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-old"), 0);
        tracker.note_submit("t1", 10);
        let effects = tracker.note_lane_attach_failed("t1", 100);
        // Effect order: the session binding clears FIRST (its upsert
        // legitimately re-asserts the still-armed Busy phase — the bind
        // upsert's precedent), then the provisional busy resolves to
        // Idle. No completion, no boundary.
        assert_eq!(
            phases(&effects),
            vec![AntigravityPhase::Busy, AntigravityPhase::Idle],
            "session clears first, then the provisional busy resolves: {effects:?}"
        );
        assert!(
            completions(&effects).is_empty()
                && !effects
                    .iter()
                    .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })),
            "no confirmed turn existed — the reversion is silent: {effects:?}"
        );
        assert_eq!(tracker.list()[0].session_id, None);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);

        // An idle pane with a session binding: ONLY the session clears
        // (no phase flap, no boundary).
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t2", Some("conv-idle"), 0);
        let effects = tracker.note_lane_attach_failed("t2", 100);
        assert!(
            effects.iter().all(|e| match e {
                TrackerEffect::Changed { upsert, .. } =>
                    upsert.iter().all(|r| r.phase == AntigravityPhase::Idle),
                _ => false,
            }),
            "idle stays idle: {effects:?}"
        );
        assert_eq!(tracker.list()[0].session_id, None);

        // Untracked terminal: a no-op.
        let mut tracker = AntigravityActivityTracker::new();
        assert!(tracker.note_lane_attach_failed("t-unknown", 100).is_empty());
        assert!(tracker.list().is_empty());
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

    /// Whole-delta review Major 1: the attach-time BASELINE. Attaching a
    /// lane to a transcript that already carries history (resume, rebind,
    /// restart-restore) must seed the tracker from what is on disk
    /// WITHOUT emitting effects — historical settles never mint
    /// completions — while the current in-flight turn (a user record
    /// after the last settle) is recognized as busy.
    #[test]
    fn seed_attach_baseline_swallows_history_and_seeds_the_in_flight_turn() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        // The pane's submit armed the provisional busy (the hub's Enter
        // capture), as in production. (Round 4, Minor 1 re-scaled the
        // fixture: the submit sits at 100_000 so the history below is
        // ~80 s older — far outside the 5 s recency tolerance, which the
        // compressed millisecond-scale stamps of the original fixture
        // could no longer express.)
        tracker.note_submit("t1", 100_000);

        // On disk at attach: two settled historical turns, then the pane's
        // own prompt as the latest record (the in-flight turn).
        let records = vec![
            user_message(Some(10_000)),
            settled(true, false, Some(20_000)),
            user_message(Some(30_000)),
            settled(true, false, Some(40_000)),
            user_message(Some(100_050)),
        ];
        // The boundary is the pane's submit (100_000): everything on disk
        // except the pane's own prompt predates it by more than the
        // tolerance — history (round 1's property: pre-window settles
        // never ring; the boundary classification replaces round 1's
        // attach-instant classification).
        let effects = tracker.note_attach_baseline("t1", &records, 100_100, Some(100_000));
        assert!(
            effects.is_empty(),
            "no completion, no attention, no public flap — the pane is already \
             provisionally busy and the baseline only CONFIRMS it: {effects:?}"
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);
        // Confirmed busy: the submit grace no longer reverts.
        assert!(tracker
            .expire(100_000 + 10 * ANTIGRAVITY_SUBMIT_GRACE_MS)
            .is_empty());

        // A byte-faithful replay of a HISTORICAL settle (its old `at`,
        // at/before the seeded baseline watermark) is inert.
        let effects = tracker.note_record("t1", &settled(true, false, Some(20_000)), 200_000);
        assert!(
            effects.is_empty(),
            "the seeded dedupe baseline swallows replays of historical settles: {effects:?}"
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // The in-flight turn's own settle completes exactly once, and the
        // historical settles consumed none of the sequence.
        let effects = tracker.note_record("t1", &settled(true, false, Some(300_000)), 300_000);
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
    }

    /// A fully-settled PRE-SUBMIT history (the resumed pane whose fresh
    /// submit is still awaiting its user record): everything on disk
    /// predates the submit, so it is all history — the provisional busy
    /// resolves to the transcript's settled truth silently (a public
    /// Busy→Idle upsert, but never a completion or attention boundary —
    /// the gate treats an idle phase report as inert), the seeded
    /// watermark swallows a replay of the same settle, and the
    /// FOLLOW-UP turn completes exactly once.
    #[test]
    fn seed_attach_baseline_fully_settled_resolves_the_provisional_busy_silently() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        // (Round 4, Minor 1 re-scaled the fixture: the submit sits at
        // 100_000 so the settled history is ~80 s older — outside the
        // 5 s recency tolerance, which the compressed millisecond-scale
        // stamps of the original fixture could no longer express.)
        tracker.note_submit("t1", 100_000);

        let records = vec![
            user_message(Some(10_000)),
            settled(true, false, Some(20_000)),
        ];
        let effects = tracker.note_attach_baseline("t1", &records, 100_100, Some(100_000));
        assert_eq!(
            phases(&effects),
            vec![AntigravityPhase::Idle],
            "the provisional busy resolves to the transcript's settled truth"
        );
        assert!(
            completions(&effects).is_empty(),
            "a baseline settle never mints a completion"
        );
        assert!(
            !effects
                .iter()
                .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })),
            "a baseline resolve never rings the attention boundary"
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);

        // A byte-faithful replay of the SAME settle (same `at`) is inert
        // against the seeded watermark.
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(20_000)), 200_000)
            .is_empty());

        // The next genuine turn completes exactly once, with seq 1 (the
        // baseline settle consumed none of the sequence).
        tracker.note_submit("t1", 300_000);
        tracker.note_record("t1", &user_message(Some(300_050)), 300_050);
        let effects = tracker.note_record("t1", &settled(true, false, Some(400_000)), 400_000);
        assert_eq!(completions(&effects), vec![1]);
    }

    /// Whole-delta review round 2, Major 2: the baseline is anchored to
    /// the pane's SUBMIT — a settle already on disk at attach is
    /// HISTORICAL only when its own `at` predates the live floor at the
    /// submit that armed the pane (round 4, Minor 1 widened that floor
    /// from the bare submit to `submit - tolerance`). A quick first turn
    /// can settle during the locator's 2 s window (before the tailer
    /// attaches): that settle's `at` is AFTER the submit, so it is a
    /// LIVE turn end the user may not have witnessed — it must ring
    /// EXACTLY ONCE (the per-settle dedupe covers re-drains of the same
    /// record).
    #[test]
    fn seed_attach_baseline_rings_a_settle_landed_after_the_submit() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        // The pane's captured submit (the hub's Enter capture) armed the
        // provisional busy, as in production. (Round 4, Minor 1 re-scaled
        // the fixture: the submit sits at 100_000 so the older turn is
        // ~80 s old — outside the 5 s recency tolerance, which the
        // compressed millisecond-scale stamps of the original fixture
        // could no longer express.)
        tracker.note_submit("t1", 100_000);

        // On disk at attach: an older settled turn (its settle predates
        // the submit by more than the tolerance — historical), then the
        // pane's own prompt + its QUICK settle, both written during the
        // locator's window (their `at`s postdate the submit — live).
        let records = vec![
            user_message(Some(10_000)),
            settled(true, false, Some(20_000)),
            user_message(Some(100_010)),
            settled(true, false, Some(100_050)),
        ];
        let effects = tracker.note_attach_baseline("t1", &records, 100_200, Some(100_000));
        assert_eq!(
            completions(&effects),
            vec![1],
            "a settle whose `at` is AFTER the submit rings as a live completion \
             even though it was already on disk at attach: {effects:?}"
        );
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);

        // Exactly once: a byte-faithful replay of the rung settle (same
        // `at`) is inert against the ledger's recorded completion.
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(100_050)), 200_000)
            .is_empty());
        // The pre-window settle rang nothing either — a replay of it is
        // inert too (the seeded historical watermark).
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(20_000)), 200_100)
            .is_empty());

        // The FOLLOW-UP turn completes exactly once, with seq 2 (the
        // window settle consumed seq 1).
        tracker.note_submit("t1", 300_000);
        tracker.note_record("t1", &user_message(Some(300_050)), 300_050);
        let effects = tracker.note_record("t1", &settled(true, false, Some(400_000)), 400_000);
        assert_eq!(completions(&effects), vec![2]);
    }

    /// Whole-delta review round 4, Minor 1: the baseline's live floor
    /// must match the locator's recency TOLERANCE, not the bare submit.
    /// The registry writes the PTY bytes BEFORE stamping the Input
    /// event, and the CLI's own clock can lag ours, so a QUICK turn can
    /// write BOTH its records — the user message the locator matches AND
    /// its settle — stamped within the tolerance BEFORE the captured
    /// submit. Identity binds (the locator's tolerance admits the user
    /// record); the settle is the pane's own turn end and must ring
    /// EXACTLY ONCE, or the turn's completion alert is silently lost.
    /// Pre-window history stays silent.
    #[test]
    fn seed_attach_baseline_rings_a_settle_landed_within_the_backward_tolerance() {
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        // The pane's captured submit (the post-write Input stamp).
        let submit_at = 100_000_i64;
        tracker.note_submit("t1", submit_at);

        // On disk at attach: an OLD settled turn (its records predate the
        // tolerance window — history), then the pane's own QUICK turn:
        // the user record the locator matched and its settle, both
        // stamped within the tolerance BEFORE the captured submit (the
        // write→stamp skew the tolerance exists for).
        let records = vec![
            user_message(Some(10_000)),
            settled(true, false, Some(20_000)),
            user_message(Some(submit_at - 4_000)),
            settled(true, false, Some(submit_at - 3_500)),
        ];
        let effects = tracker.note_attach_baseline("t1", &records, 100_200, Some(submit_at));
        assert_eq!(
            completions(&effects),
            vec![1],
            "a settle stamped within the locator's backward tolerance before the \
             submit is the pane's own LIVE turn end and rings exactly once, even \
             though both of its records precede the captured submit: {effects:?}"
        );
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);

        // Exactly once: a byte-faithful replay of the rung settle (same
        // `at`) is inert against the ledger's recorded completion.
        assert!(tracker
            .note_record(
                "t1",
                &settled(true, false, Some(submit_at - 3_500)),
                200_000
            )
            .is_empty());
        // The PRE-WINDOW settle rang nothing — a replay of it is inert
        // too (the seeded historical watermark).
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(20_000)), 200_100)
            .is_empty());

        // The FOLLOW-UP turn completes exactly once, with seq 2 (the
        // tolerance-window settle consumed seq 1).
        tracker.note_submit("t1", 300_000);
        tracker.note_record("t1", &user_message(Some(300_050)), 300_050);
        let effects = tracker.note_record("t1", &settled(true, false, Some(400_000)), 400_000);
        assert_eq!(completions(&effects), vec![2]);
    }

    /// The tolerance floor is INCLUSIVE at its edge and history starts
    /// behind it: a settle stamped EXACTLY `submit - tolerance` is live
    /// (the locator's rule accepts the matching record at exactly that
    /// bound), while a settle ONE MILLISECOND earlier is history —
    /// silent, seeding the watermark so its replay is inert.
    #[test]
    fn seed_attach_baseline_tolerance_floor_is_inclusive_and_history_starts_behind_it() {
        let submit_at = 100_000_i64;

        // The edge itself: a turn whose records sit at EXACTLY the floor.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        tracker.note_submit("t1", submit_at);
        let floor = submit_at - ANTIGRAVITY_RECENCY_BACKWARD_TOLERANCE_MS;
        let records = vec![
            user_message(Some(floor)),
            settled(true, false, Some(floor + 100)),
        ];
        let effects = tracker.note_attach_baseline("t1", &records, 100_200, Some(submit_at));
        assert_eq!(
            completions(&effects),
            vec![1],
            "a settle at exactly the tolerance floor is live — the same bound the \
             locator's recency rule applies: {effects:?}"
        );

        // One millisecond earlier: history. The turn's BOTH records sit
        // behind the floor (the settle at exactly `floor - 1`). The
        // provisional busy resolves to the transcript's settled truth
        // SILENTLY (no completion, no attention), and the seeded
        // watermark swallows the replay.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t2", Some("conv-2"), 0);
        tracker.note_submit("t2", submit_at);
        let records = vec![
            user_message(Some(floor - 101)),
            settled(true, false, Some(floor - 1)),
        ];
        let effects = tracker.note_attach_baseline("t2", &records, 100_200, Some(submit_at));
        assert!(
            completions(&effects).is_empty(),
            "a settle one millisecond behind the tolerance floor is history and \
             never rings: {effects:?}"
        );
        assert_eq!(phases(&effects), vec![AntigravityPhase::Idle]);
        assert!(tracker
            .note_record("t2", &settled(true, false, Some(floor - 1)), 200_000)
            .is_empty());
    }

    /// Baseline edge shapes: an empty baseline seeds idle-with-baseline;
    /// a baseline ending in a PARTIAL settle (fullyIdle:false — async
    /// work outstanding) seeds busy; an untracked terminal is a no-op.
    #[test]
    fn seed_attach_baseline_empty_partial_and_untracked_stay_honest() {
        // Empty baseline (a transcript with no lifecycle records yet):
        // idle, no effects; the pane's first live turn behaves normally.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        assert!(tracker
            .note_attach_baseline("t1", &[], 100, None)
            .is_empty());
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);
        tracker.note_submit("t1", 1_000);
        tracker.note_record("t1", &user_message(Some(1_050)), 1_050);
        let effects = tracker.note_record("t1", &settled(true, false, Some(2_000)), 2_000);
        assert_eq!(completions(&effects), vec![1]);

        // Partial settle outstanding: the turn has NOT ended — busy seeds.
        // No captured submit (`None`): the boundary derives to the latest
        // user record (100), so the user record + its partial settle
        // replay LIVE and arm busy on the previously-idle pane.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t2", Some("conv-2"), 0);
        let records = vec![user_message(Some(100)), settled(false, false, Some(200))];
        let effects = tracker.note_attach_baseline("t2", &records, 300, None);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Busy]);
        assert!(completions(&effects).is_empty());
        // No completing settle was on disk: the watermark stays unset and
        // the turn's eventual full settle mints seq 1.
        let effects = tracker.note_record("t2", &settled(true, false, Some(1_000)), 1_000);
        assert_eq!(completions(&effects), vec![1]);

        // An errored HISTORICAL settle (before the live floor at an
        // explicit submit boundary — round 4 re-scaled the stamps so the
        // history sits ~80 s outside the tolerance) ENDS the turn
        // (attention is outcome-uniform): the pane seeds idle (no public
        // change — it was already idle) and the watermark seeds from the
        // errored settle's `at`, so a replay of it is inert.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t3", Some("conv-3"), 0);
        let records = vec![
            user_message(Some(10_000)),
            settled(false, true, Some(20_000)),
        ];
        let effects = tracker.note_attach_baseline("t3", &records, 700_000, Some(700_000));
        assert!(effects.is_empty());
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);
        assert!(tracker
            .note_record("t3", &settled(false, true, Some(20_000)), 800_000)
            .is_empty());

        // Untracked terminal: a no-op like every other note.
        let mut tracker = AntigravityActivityTracker::new();
        assert!(tracker
            .note_attach_baseline("t-unknown", &[user_message(Some(10))], 20, None)
            .is_empty());
        assert!(tracker.list().is_empty());
    }

    /// The NO-CAPTURED-SUBMIT boundary (the module header's None
    /// contract): the latest user record's `at` stands in as the
    /// effective submit — settles before it are history (silent), the
    /// LAST turn's settle is a live (potentially unwitnessed) turn end
    /// and rings exactly once; a transcript with no user record at all
    /// proves no user action and stays entirely silent.
    #[test]
    fn seed_attach_baseline_without_a_captured_submit_uses_the_latest_user_record() {
        // Two settled turns; the second (latest) turn's settle postdates
        // the derived boundary (its own user record) and rings.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t1", Some("conv-1"), 0);
        let records = vec![
            user_message(Some(100)),
            settled(true, false, Some(200)),
            user_message(Some(300)),
            settled(true, false, Some(400)),
        ];
        let effects = tracker.note_attach_baseline("t1", &records, 500, None);
        assert_eq!(
            completions(&effects),
            vec![1],
            "the latest turn's settle rings once (the effective-submit \
             boundary is the latest user record): {effects:?}"
        );
        // The live replay mints the turn's own phase arc: the replayed
        // prompt flips the fresh pane Busy, the settle flips it Idle.
        assert_eq!(
            phases(&effects),
            vec![AntigravityPhase::Busy, AntigravityPhase::Idle]
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);
        // Replays are inert: the rung settle via the LEDGER, the older
        // settle via the seeded historical watermark.
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(400)), 600)
            .is_empty());
        assert!(tracker
            .note_record("t1", &settled(true, false, Some(200)), 700)
            .is_empty());

        // No user record at all: no provable user action, everything is
        // history — silent, and the pane seeds from the settled fold.
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t2", Some("conv-2"), 0);
        let records = vec![settled(true, false, Some(150))];
        let effects = tracker.note_attach_baseline("t2", &records, 300, None);
        assert!(
            effects.is_empty(),
            "a transcript with no user record owes no bell: {effects:?}"
        );
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Idle);

        // An in-flight tail with no captured submit: the latest user
        // record IS the boundary, so it replays live and arms busy (the
        // restored pane shows the turn still running).
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t3", Some("conv-3"), 0);
        let records = vec![
            user_message(Some(100)),
            settled(true, false, Some(200)),
            user_message(Some(250)),
        ];
        let effects = tracker.note_attach_baseline("t3", &records, 300, None);
        assert_eq!(phases(&effects), vec![AntigravityPhase::Busy]);
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, AntigravityPhase::Busy);

        // Round 4, Minor 1 pin — the None boundary keeps its STRICT floor
        // (the tolerance is NOT applied): the derived boundary is one of
        // the records' own stamps, so the cross-clock skew the tolerance
        // absorbs cannot arise, and a settle stamped even 1 ms before the
        // latest user record — let alone a tolerance-window before it —
        // stays HISTORY. (Applying the window here would ring the
        // PREVIOUS turn's settle on every restored pane.)
        let mut tracker = AntigravityActivityTracker::new();
        tracker.track_terminal("t4", Some("conv-4"), 0);
        let records = vec![
            user_message(Some(10_000)),
            settled(true, false, Some(10_000 + 100)),
            user_message(Some(10_000 + 4_999)),
        ];
        let effects = tracker.note_attach_baseline("t4", &records, 10_000 + 5_000, None);
        assert!(
            completions(&effects).is_empty(),
            "the None boundary stays strict — the previous turn's settle (stamped \
             4.9 s before the derived boundary) never rings: {effects:?}"
        );
        assert_eq!(
            phases(&effects),
            vec![AntigravityPhase::Busy],
            "the latest user record replays live and arms busy"
        );
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

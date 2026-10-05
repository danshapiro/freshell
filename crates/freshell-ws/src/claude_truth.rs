//! #606/#611: claude session-JSONL truth source ("ask the agent" via its
//! transcript ledger). Spike-verified against claude-code 2.1.223 and
//! corpus-validated 2026-08-06 (1561 files / 240k records). Corrected
//! semantics baked in:
//! - Turn end = `system`/`turn_duration` OR the interrupt marker, whose
//!   `message.content` is ARRAY-wrapped (`[{type:"text",text:"[Request
//!   interrupted by user…]"}]`; a "for tool use" variant exists — match
//!   by prefix on string OR array shapes). ESC writes no turn_duration;
//!   an EARLY ESC (before any output) writes no record at all (accepted
//!   residual: stale blue that self-heals on next input).
//! - "Ended" means the end-boundary is genuinely LAST among
//!   non-sidechain user/assistant activity: hook/slash continuations
//!   legitimately append records AFTER a turn_duration, and activity
//!   after the boundary means a continuation is running (InFlight).
//! - Submit confirmation accepts ANY appended parseable non-sidechain
//!   transcript record: slash-command turns write no promptSource
//!   record, and a phantom Enter appends nothing.
//! - The tail scan is ADAPTIVE (256 KiB doubling to an 8 MiB cap):
//!   individual lines reach 1.37 MB, so a fixed window can land inside
//!   one record. Zero parseable records at the cap ⇒ Unavailable + the
//!   A8 drift tripwire (`claude_format_anomaly`).
//! - Files are append-only with in-place compaction, BUT resume/fork
//!   mints a NEW `<session-id>.jsonl` seeded with copied records —
//!   callers must treat offsets as valid only for the session they were
//!   captured against (Task 11) and rebind on session change (Task 10).
//!
//! Append order is truth (timestamps are NOT monotonic); files reach
//! tens of MB, so probes tail-seek and never slurp. Probes apply to
//! cli-entrypoint panes (`entrypoint:"cli"`) — exactly what freshell
//! PTY claude panes run; sdk-entrypoint sessions never write
//! turn_duration and are out of scope.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

/// Initial tail window for a turn-state probe. The boundary records
/// (turn-start / turn_duration / interrupt) are small and frequent, so
/// 256 KiB usually contains the decisive record — but corpus lines reach
/// 1,365,273 bytes, so the window DOUBLES until it parses ≥1 record or
/// hits [`TAIL_PROBE_MAX_BYTES`].
const TAIL_PROBE_INITIAL_BYTES: u64 = 256 * 1024;

/// Adaptive-window cap: 8 MiB = 5.9× the largest line observed in the
/// 1561-file corpus. Zero parseable records at this cap is a format
/// anomaly (A8 tripwire) and answers Unavailable — crash semantics
/// upstream, never a silent guess.
const TAIL_PROBE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// A8 drift tripwire counter: transcript-format anomalies since boot.
/// Read by GET /api/server-info as "claudeTruthAnomalies" (Task 10).
pub static CLAUDE_TRUTH_ANOMALIES: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
fn same_windows_path(left: &Path, right: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Component;

    const CSTR_EQUAL: i32 = 2;
    const TRUE: i32 = 1;

    let components_match = |left: Component<'_>, right: Component<'_>| {
        let left = left.as_os_str().encode_wide().collect::<Vec<_>>();
        let right = right.as_os_str().encode_wide().collect::<Vec<_>>();
        let (Ok(left_len), Ok(right_len)) = (i32::try_from(left.len()), i32::try_from(right.len()))
        else {
            return false;
        };
        if left_len == 0 || right_len == 0 {
            return false;
        }

        // SAFETY: both buffers remain alive for the call, and each explicit
        // length is the number of valid UTF-16 code units in that buffer.
        unsafe {
            compare_string_ordinal(left.as_ptr(), left_len, right.as_ptr(), right_len, TRUE)
                == CSTR_EQUAL
        }
    };

    let mut left = left.components();
    let mut right = right.components();
    loop {
        match (left.next(), right.next()) {
            (Some(left), Some(right)) if components_match(left, right) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    #[link_name = "CompareStringOrdinal"]
    fn compare_string_ordinal(
        string1: *const u16,
        count1: i32,
        string2: *const u16,
        count2: i32,
        ignore_case: i32,
    ) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnProbe {
    /// Non-sidechain user/assistant activity after the last end-boundary
    /// (turn_duration or interrupt marker) — or activity with no boundary
    /// in the window at all: the agent is working (this includes
    /// hook/slash continuations that run AFTER a turn_duration).
    InFlight,
    /// An end-boundary is genuinely LAST among user/assistant activity.
    Ended,
    /// No transcript found / unreadable / zero parseable records at the
    /// adaptive-window cap — no truth source (crash semantics upstream).
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmitProbe {
    /// ANY parseable non-sidechain transcript record (user/assistant/
    /// system) was appended at/after the given offset — slash turns
    /// write no promptSource record, and a phantom Enter appends
    /// nothing, so "anything appended" is the discriminator.
    Confirmed,
    /// The appended region parsed but contains no transcript record.
    NoTurnStarted,
    /// Transcript missing/unreadable — cannot verify.
    Unavailable,
}

pub trait ClaudeTruth: Send + Sync {
    fn probe_turn_state(&self, session_id: &str) -> TurnProbe;
    /// Byte length of the transcript right now (None if not found) —
    /// captured at submit time so probe_submit reads only appended bytes.
    fn transcript_len(&self, session_id: &str) -> Option<u64>;
    fn probe_submit(&self, session_id: &str, from_offset: u64) -> SubmitProbe;
}

pub struct FsClaudeTruth {
    roots: Vec<PathBuf>,
}

/// A8 drift tripwire: claude-code self-updates roughly daily and these
/// markers churned within the last month — when the format drifts out
/// from under the probes, say so LOUDLY (with the newest record's
/// "version" field, so the log names the build that drifted) instead of
/// silently mis-lighting. Log-only here; the counter is surfaced on
/// /api/server-info in Task 10.
fn note_format_anomaly(session_id: &str, records: &[serde_json::Value], reason: &str) {
    CLAUDE_TRUTH_ANOMALIES.fetch_add(1, AtomicOrdering::SeqCst);
    let version = records
        .iter()
        .rev()
        .find_map(|r| r.get("version").and_then(|v| v.as_str()))
        .unwrap_or("unknown");
    tracing::warn!(
        component = "claude-truth",
        event = "claude_format_anomaly",
        session_id = %session_id,
        version = %version,
        reason = %reason,
        "claude transcript format anomaly (A8 drift tripwire); probe answers Unavailable/unclassifiable and crash semantics apply upstream"
    );
}

impl FsClaudeTruth {
    /// Candidate roots, priority order — the same ladder as
    /// `claude_snapshot.rs`: CLAUDE_CONFIG_DIR > CLAUDE_HOME > platform
    /// default `~/.claude`.
    /// Empty-string values are SKIPPED (claude_snapshot.rs precedent —
    /// an empty env var must not produce a bogus relative root).
    pub fn from_env() -> Self {
        let mut roots = Vec::new();
        if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
            if !dir.is_empty() {
                roots.push(PathBuf::from(dir));
            }
        }
        if let Ok(dir) = std::env::var("CLAUDE_HOME") {
            if !dir.is_empty() {
                roots.push(PathBuf::from(dir));
            }
        }
        #[cfg(windows)]
        if let Some(home) = std::env::home_dir() {
            let default_root = home.join(".claude");
            if !roots
                .iter()
                .any(|root| same_windows_path(root, &default_root))
            {
                roots.push(default_root);
            }
        }
        #[cfg(not(windows))]
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                roots.push(PathBuf::from(home).join(".claude"));
            }
        }
        Self { roots }
    }

    pub fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self { roots }
    }

    /// The cwd→project-dir slug is LOSSY, so location is a filename scan
    /// over `<root>/projects/*/<session_id>.jsonl`. Only the slug level
    /// is scanned: main transcripts live there (verified live); subagent
    /// sidechain files one level deeper are intentionally NOT scanned.
    /// Basename uniqueness is EMPIRICAL (0 duplicates in 1561 corpus
    /// files), not structural — multiple matches warn and the first by
    /// root-priority order wins.
    fn locate(&self, session_id: &str) -> Option<PathBuf> {
        let file_name = format!("{session_id}.jsonl");
        let mut found: Option<PathBuf> = None;
        let mut duplicates = 0usize;
        for root in &self.roots {
            let projects = root.join("projects");
            let Ok(entries) = std::fs::read_dir(&projects) else {
                continue;
            };
            for entry in entries.flatten() {
                let candidate = entry.path().join(&file_name);
                if candidate.is_file() {
                    if found.is_none() {
                        found = Some(candidate);
                    } else {
                        duplicates += 1;
                    }
                }
            }
        }
        if duplicates > 0 {
            tracing::warn!(
                component = "claude-truth",
                session_id = %session_id,
                duplicates,
                "multiple transcript files share this session basename; using the first by root priority (uniqueness is empirical, not structural)"
            );
        }
        found
    }

    /// Adaptive backward tail scan: read the last `window` bytes, double
    /// the window until ≥1 record parses, the window covers the whole
    /// file, or the 8 MiB cap is hit. Returns the parsed records (which
    /// may be empty AT THE CAP — the caller treats that as an anomaly).
    fn read_tail_records(path: &Path) -> Option<Vec<serde_json::Value>> {
        let len = std::fs::metadata(path).ok()?.len();
        let mut window = TAIL_PROBE_INITIAL_BYTES;
        loop {
            let from = len.saturating_sub(window);
            let records = Self::read_records_from(path, from)?;
            if !records.is_empty() || from == 0 {
                return Some(records);
            }
            if window >= TAIL_PROBE_MAX_BYTES {
                return Some(records); // empty at cap — anomaly upstream
            }
            window = (window * 2).min(TAIL_PROBE_MAX_BYTES);
        }
    }

    /// Read [from, EOF) as lossy UTF-8, split lines, and parse each line
    /// as JSON. The first line may be a partial record when `from`
    /// landed mid-record — it fails to parse and is skipped (whole-line
    /// records always parse); any later parse failure is also skipped
    /// (a torn concurrent append).
    fn read_records_from(path: &Path, from: u64) -> Option<Vec<serde_json::Value>> {
        let mut file = std::fs::File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        let start = from.min(len);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::with_capacity((len - start) as usize);
        file.read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        let mut records = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(line) {
                Ok(v) => records.push(v),
                Err(_) => continue,
            }
        }
        Some(records)
    }
}

fn is_sidechain(record: &serde_json::Value) -> bool {
    record
        .get("isSidechain")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// The interrupt marker's text — matched by PREFIX so the
/// "…for tool use]" variant (both exist in the constructor) is covered.
const INTERRUPT_PREFIX: &str = "[Request interrupted by user";

/// Turn end: `system`/`turn_duration` (exact subtype match — never any
/// other trailing system record) OR the interrupt marker user record.
/// Corpus-validated: interrupt `message.content` is ARRAY-wrapped
/// (`[{type:"text",text:"[Request interrupted by user…]"}]`, 17/17
/// corpus records); the bare-string shape is kept defensively for older
/// builds. Prefix match covers the "for tool use" variant.
fn is_turn_end(record: &serde_json::Value) -> bool {
    if is_sidechain(record) {
        return false;
    }
    let ty = record.get("type").and_then(|v| v.as_str());
    if ty == Some("system") {
        return record.get("subtype").and_then(|v| v.as_str()) == Some("turn_duration");
    }
    if ty == Some("user") {
        let Some(content) = record.get("message").and_then(|m| m.get("content")) else {
            return false;
        };
        // String shape (legacy/defensive).
        if let Some(text) = content.as_str() {
            return text.starts_with(INTERRUPT_PREFIX);
        }
        // Array-of-blocks shape (corpus reality): any {type:"text",text}
        // block carrying the marker terminates the turn.
        if let Some(blocks) = content.as_array() {
            return blocks.iter().any(|block| {
                block.get("type").and_then(|v| v.as_str()) == Some("text")
                    && block
                        .get("text")
                        .and_then(|v| v.as_str())
                        .is_some_and(|t| t.starts_with(INTERRUPT_PREFIX))
            });
        }
    }
    false
}

/// Model ACTIVITY: a non-sidechain user or assistant record. Activity
/// after the last end-boundary means a continuation is running (corpus:
/// 236 user + 13 assistant post-turn_duration records — hook and
/// slash-command continuations). Trailing housekeeping (queue-operation,
/// away_summary, attachment, …) is NOT activity and neither reopens nor
/// closes a turn. The end-boundary records themselves are excluded so an
/// interrupt marker (a user record) does not read as its own
/// continuation.
fn is_activity(record: &serde_json::Value) -> bool {
    !is_sidechain(record)
        && !is_turn_end(record)
        && matches!(
            record.get("type").and_then(|v| v.as_str()),
            Some("user") | Some("assistant")
        )
}

/// Any transcript-shaped record — the submit-probe discriminator (#611):
/// slash turns write no promptSource record, and a phantom Enter appends
/// NOTHING, so any appended non-sidechain user/assistant/system record
/// confirms the agent is running.
fn is_transcript_record(record: &serde_json::Value) -> bool {
    !is_sidechain(record)
        && matches!(
            record.get("type").and_then(|v| v.as_str()),
            Some("user") | Some("assistant") | Some("system")
        )
}

impl ClaudeTruth for FsClaudeTruth {
    fn probe_turn_state(&self, session_id: &str) -> TurnProbe {
        let Some(path) = self.locate(session_id) else {
            return TurnProbe::Unavailable;
        };
        let Some(records) = Self::read_tail_records(&path) else {
            return TurnProbe::Unavailable;
        };
        if records.is_empty() {
            // Adaptive window hit the 8 MiB cap without one parseable
            // record: format anomaly (A8 tripwire), no truth source.
            note_format_anomaly(
                session_id,
                &records,
                "zero parseable records at the 8 MiB adaptive-window cap",
            );
            return TurnProbe::Unavailable;
        }
        // Append order is truth. Track the last end-boundary and whether
        // any ACTIVITY (non-sidechain user/assistant) followed it —
        // activity-after-end means a hook/slash continuation is running.
        let mut saw_boundary = false;
        let mut activity_after_boundary = false;
        let mut any_activity = false;
        let mut any_transcript = false;
        for record in &records {
            any_transcript |= is_transcript_record(record);
            if is_turn_end(record) {
                saw_boundary = true;
                activity_after_boundary = false;
            } else if is_activity(record) {
                any_activity = true;
                if saw_boundary {
                    activity_after_boundary = true;
                }
            }
        }
        if saw_boundary {
            if activity_after_boundary {
                TurnProbe::InFlight // continuation past the boundary
            } else {
                TurnProbe::Ended // boundary genuinely last among activity
            }
        } else if any_activity || any_transcript {
            // No boundary in the (adaptive) window but records present:
            // a mid-turn streaming tail — conservative toward busy,
            // never toward a false green.
            TurnProbe::InFlight
        } else {
            // Parseable records, none transcript-shaped: this is not a
            // session transcript we understand (A8 tripwire).
            note_format_anomaly(
                session_id,
                &records,
                "parseable records but no boundary and no transcript records",
            );
            TurnProbe::Unavailable
        }
    }

    fn transcript_len(&self, session_id: &str) -> Option<u64> {
        let path = self.locate(session_id)?;
        std::fs::metadata(&path).ok().map(|m| m.len())
    }

    fn probe_submit(&self, session_id: &str, from_offset: u64) -> SubmitProbe {
        let Some(path) = self.locate(session_id) else {
            return SubmitProbe::Unavailable;
        };
        let Some(records) = Self::read_records_from(&path, from_offset) else {
            return SubmitProbe::Unavailable;
        };
        // #611 (A1 corrected): ANY appended parseable non-sidechain
        // transcript record confirms — a tool_result proves the agent is
        // running; slash turns write no promptSource record; a phantom
        // Enter appends nothing.
        if records.iter().any(is_transcript_record) {
            SubmitProbe::Confirmed
        } else {
            SubmitProbe::NoTurnStarted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_transcript(root: &std::path::Path, session: &str, lines: &[&str]) {
        let dir = root.join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{session}.jsonl")), lines.join("\n")).unwrap();
    }

    const TURN_START: &str = r#"{"type":"user","promptSource":"typed","origin":{"kind":"human"},"promptId":"p1","isSidechain":false,"message":{"role":"user","content":"hi"},"uuid":"u1","timestamp":"2026-08-06T08:00:00.000Z","sessionId":"S","entrypoint":"cli","version":"2.1.223"}"#;
    const TOOL_RESULT: &str = r#"{"type":"user","promptId":"p1","isSidechain":false,"toolUseResult":"x","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"uuid":"u2","timestamp":"2026-08-06T08:00:05.000Z","version":"2.1.223"}"#;
    const ASSISTANT: &str = r#"{"type":"assistant","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"…"}],"stop_reason":"tool_use"},"uuid":"u3","timestamp":"2026-08-06T08:00:06.000Z","version":"2.1.223"}"#;
    const TURN_END: &str = r#"{"type":"system","subtype":"turn_duration","durationMs":1234,"messageCount":3,"isSidechain":false,"uuid":"u4","timestamp":"2026-08-06T08:00:07.000Z","version":"2.1.223"}"#;
    // Corpus-validated interrupt shape (17/17): message.content is
    // ARRAY-wrapped, not a bare string.
    const INTERRUPT: &str = r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"uuid":"u5","timestamp":"2026-08-06T08:00:08.000Z","version":"2.1.223"}"#;
    // The constructor's second literal (interrupted tool call).
    const INTERRUPT_TOOL_USE: &str = r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]},"uuid":"u5b","timestamp":"2026-08-06T08:00:08.500Z","version":"2.1.223"}"#;
    // Defensive: the string-typed shape older builds used.
    const INTERRUPT_LEGACY: &str = r#"{"type":"user","isSidechain":false,"message":{"role":"user","content":"[Request interrupted by user]"},"uuid":"u5c","timestamp":"2026-08-06T08:00:09.000Z","version":"2.1.202"}"#;
    const AWAY: &str = r#"{"type":"system","subtype":"away_summary","isSidechain":false,"uuid":"u6","timestamp":"2026-08-06T08:03:00.000Z","version":"2.1.223"}"#;
    const SIDECHAIN: &str = r#"{"type":"user","promptSource":"typed","isSidechain":true,"message":{"role":"user","content":"sidechain"},"uuid":"u7","timestamp":"2026-08-06T08:00:10.000Z","version":"2.1.223"}"#;

    fn append_lines(root: &std::path::Path, session: &str, lines: &[&str]) {
        use std::io::Write;
        let dir = root.join("projects").join("-home-user-proj");
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join(format!("{session}.jsonl")))
            .unwrap();
        writeln!(f).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    #[test]
    fn probe_turn_state_classifies_the_tail() {
        let dir = tempfile::tempdir().unwrap();
        let truth = FsClaudeTruth::with_roots(vec![dir.path().to_path_buf()]);
        assert!(matches!(
            truth.probe_turn_state("S"),
            TurnProbe::Unavailable
        ));

        write_transcript(dir.path(), "S", &[TURN_START, TOOL_RESULT, ASSISTANT]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::InFlight));

        write_transcript(dir.path(), "S", &[TURN_START, ASSISTANT, TURN_END]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));

        // Interrupt terminates a turn (NO turn_duration is written) —
        // corpus shape: content is ARRAY-wrapped; the "for tool use"
        // variant and the legacy string shape all end the turn.
        write_transcript(dir.path(), "S", &[TURN_START, ASSISTANT, INTERRUPT]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));
        write_transcript(
            dir.path(),
            "S",
            &[TURN_START, ASSISTANT, INTERRUPT_TOOL_USE],
        );
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));
        write_transcript(dir.path(), "S", &[TURN_START, ASSISTANT, INTERRUPT_LEGACY]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));

        // Activity AFTER a turn_duration = a hook/slash continuation is
        // running (corpus: 236 user + 13 assistant post-td records) —
        // "ended" requires the boundary to be genuinely last among
        // user/assistant activity.
        write_transcript(
            dir.path(),
            "S",
            &[TURN_START, ASSISTANT, TURN_END, TOOL_RESULT, ASSISTANT],
        );
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::InFlight));

        // away_summary (and other trailing housekeeping) is NOT activity
        // and NOT an end marker: it neither reopens nor closes anything.
        write_transcript(dir.path(), "S", &[TURN_START, ASSISTANT, TURN_END, AWAY]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));
        write_transcript(dir.path(), "S", &[TURN_END, TURN_START, ASSISTANT, AWAY]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::InFlight));

        // Redundant end (compaction/resume boundary): tolerated.
        write_transcript(dir.path(), "S", &[TURN_END]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));

        // Sidechain records are invisible to classification.
        write_transcript(dir.path(), "S", &[TURN_START, TURN_END, SIDECHAIN]);
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::Ended));
    }

    /// Run the real env lookup in a fresh process so environment values from
    /// parallel Rust tests cannot affect the Windows home-directory contract.
    /// Both roots are scratch directories; this never reads a real Claude
    /// profile.
    #[cfg(windows)]
    #[test]
    fn windows_from_env_uses_userprofile_default_and_ignores_home() {
        const CHILD_FLAG: &str = "FRESHELL_CLAUDE_TRUTH_WINDOWS_TEST_CHILD";

        if let Some(mode) = std::env::var_os(CHILD_FLAG) {
            let truth = FsClaudeTruth::from_env();
            match mode.to_string_lossy().as_ref() {
                "classify" => {
                    assert_eq!(
                        truth.probe_turn_state("windows-profile-in-flight"),
                        TurnProbe::InFlight
                    );
                    assert_eq!(
                        truth.probe_turn_state("windows-profile-ended"),
                        TurnProbe::Ended
                    );
                }
                "dedupe" => {
                    let configured = PathBuf::from(std::env::var_os("CLAUDE_CONFIG_DIR").unwrap());
                    assert_eq!(truth.roots, vec![configured]);
                }
                other => panic!("unexpected child mode: {other}"),
            }
            return;
        }

        let scratch = tempfile::tempdir().unwrap();
        let profile_root = scratch.path().join("user-profile");
        let home_root = scratch.path().join("conflicting-home");
        let profile_claude = profile_root.join(".claude");
        let home_claude = home_root.join(".claude");

        write_transcript(
            &profile_claude,
            "windows-profile-in-flight",
            &[TURN_START, ASSISTANT],
        );
        write_transcript(
            &profile_claude,
            "windows-profile-ended",
            &[TURN_START, ASSISTANT, TURN_END],
        );
        // If HOME is treated as a second Windows home candidate, these
        // opposite classifications expose it even though the session ids
        // also exist below USERPROFILE.
        write_transcript(
            &home_claude,
            "windows-profile-in-flight",
            &[TURN_START, ASSISTANT, TURN_END],
        );
        write_transcript(
            &home_claude,
            "windows-profile-ended",
            &[TURN_START, ASSISTANT],
        );

        let run_child = |mode: &str, config_dir: Option<&std::path::Path>| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "claude_truth::tests::windows_from_env_uses_userprofile_default_and_ignores_home",
                    "--nocapture",
                ])
                .env(CHILD_FLAG, mode)
                .env("USERPROFILE", &profile_root)
                .env("HOME", &home_root)
                .env_remove("CLAUDE_HOME");
            if let Some(config_dir) = config_dir {
                command.env("CLAUDE_CONFIG_DIR", config_dir);
            } else {
                command.env_remove("CLAUDE_CONFIG_DIR");
            }
            command
                .status()
                .expect("launch isolated Windows transcript test process")
        };

        // The classification case leaves both explicit roots unset and gives
        // HOME conflicting transcripts for the same session ids.
        let status = run_child("classify", None);
        assert!(status.success(), "isolated Windows transcript test failed");

        // A differently cased spelling of the Windows default is the same
        // directory and must not cause a duplicate transcript scan.
        let equivalent_spelling = profile_claude
            .to_string_lossy()
            .chars()
            .map(|ch| match ch {
                'a'..='z' => ch.to_ascii_uppercase(),
                'A'..='Z' => ch.to_ascii_lowercase(),
                _ => ch,
            })
            .collect::<String>()
            .replace('\\', "/");
        let equivalent_spelling = PathBuf::from(format!("{equivalent_spelling}/"));
        assert!(equivalent_spelling.exists());
        let status = run_child("dedupe", Some(&equivalent_spelling));
        assert!(status.success(), "Windows default-root dedupe test failed");
    }

    #[test]
    fn adaptive_window_grows_past_a_giant_line() {
        // Corpus: individual lines reach 1,365,273 bytes — a fixed
        // 256 KiB window can land INSIDE one record and parse nothing.
        // The adaptive scan doubles until it finds parseable records.
        let dir = tempfile::tempdir().unwrap();
        let truth = FsClaudeTruth::with_roots(vec![dir.path().to_path_buf()]);
        let giant = format!(
            r#"{{"type":"assistant","isSidechain":false,"message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}},"uuid":"u9","timestamp":"2026-08-06T08:01:00.000Z","version":"2.1.223"}}"#,
            "x".repeat(400 * 1024)
        );
        write_transcript(dir.path(), "S", &[TURN_START, TURN_END, &giant]);
        // The giant assistant record is ACTIVITY after the boundary:
        // a mid-turn streaming tail ⇒ InFlight (never a false green,
        // never a false Unavailable crash bell).
        assert!(matches!(truth.probe_turn_state("S"), TurnProbe::InFlight));
    }

    #[test]
    fn zero_parseable_records_at_cap_is_unavailable() {
        // > 8 MiB of unparseable tail (a pathological/foreign file):
        // the scan stops at the cap, notes the A8 format anomaly, and
        // answers Unavailable (crash semantics upstream — owner ruling).
        let dir = tempfile::tempdir().unwrap();
        let truth = FsClaudeTruth::with_roots(vec![dir.path().to_path_buf()]);
        let blob = "x".repeat(9 * 1024 * 1024);
        write_transcript(dir.path(), "S", &[&blob]);
        assert!(matches!(
            truth.probe_turn_state("S"),
            TurnProbe::Unavailable
        ));
    }

    #[test]
    fn probe_submit_reads_only_appended_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let truth = FsClaudeTruth::with_roots(vec![dir.path().to_path_buf()]);
        write_transcript(dir.path(), "S", &[TURN_START, TURN_END]);
        let offset = truth.transcript_len("S").unwrap();
        // Nothing appended yet: a phantom Enter appends NOTHING.
        assert!(matches!(
            truth.probe_submit("S", offset),
            SubmitProbe::NoTurnStarted
        ));
        // Append a new turn-start: confirmed.
        append_lines(dir.path(), "S", &[TURN_START]);
        assert!(matches!(
            truth.probe_submit("S", offset),
            SubmitProbe::Confirmed
        ));
        // Missing transcript: unavailable.
        assert!(matches!(
            truth.probe_submit("MISSING", 0),
            SubmitProbe::Unavailable
        ));
    }

    #[test]
    fn any_transcript_append_confirms_a_submit() {
        // A1 corrected: slash-command turns (e.g. /goal) run with ZERO
        // promptSource records, so the probe confirms on ANY appended
        // non-sidechain transcript record. A tool_result record PROVES
        // the agent is running — that is a correct confirmation, not a
        // false positive (deliberate inversion of the earlier
        // promptSource-only design).
        let dir = tempfile::tempdir().unwrap();
        let truth = FsClaudeTruth::with_roots(vec![dir.path().to_path_buf()]);
        write_transcript(dir.path(), "S", &[TURN_START, TURN_END]);
        let offset = truth.transcript_len("S").unwrap();
        append_lines(dir.path(), "S", &[TOOL_RESULT]);
        assert!(matches!(
            truth.probe_submit("S", offset),
            SubmitProbe::Confirmed
        ));
        // A slash-command turn's records carry no promptSource — still
        // confirmed (assistant output counts too).
        let offset = truth.transcript_len("S").unwrap();
        append_lines(dir.path(), "S", &[ASSISTANT]);
        assert!(matches!(
            truth.probe_submit("S", offset),
            SubmitProbe::Confirmed
        ));
        // Sidechain-only appends do NOT confirm.
        let offset = truth.transcript_len("S").unwrap();
        append_lines(dir.path(), "S", &[SIDECHAIN]);
        assert!(matches!(
            truth.probe_submit("S", offset),
            SubmitProbe::NoTurnStarted
        ));
    }
}

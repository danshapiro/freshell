//! Codex rollout-reconcile lane plumbing (G9): a raw-line offset tailer for
//! rollout JSONL files, the task-event folder (the three `event_msg`
//! discriminators), and the resume-time rollout locator.
//!
//! Deviations from the legacy lane are documented in
//! `freshell-activity/src/codex.rs`'s module doc (per-terminal tailing,
//! tail-trusting bounded initial read, no latent/association distrust).

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use freshell_activity::codex::CodexTaskEvents;
use freshell_sessions::time::parse_timestamp_ms;

/// Initial attach reads at most this much of the rollout's tail. Rollouts
/// reach 28MB+ (p99, V5 sampling); the latest task events
/// live at the end, and trusting the tail is the legacy sanitizer's
/// converged behavior for truncated snapshots.
pub(crate) const INITIAL_TAIL_BYTES: u64 = 256 * 1024;

/// Raw-line offset tailer for an append-only rollout JSONL file. Owns no
/// watcher and no timer -- reads are entirely caller-driven (same contract
/// as `AmplifierEventsTailer`, which is hard-wired to the amplifier schema
/// and therefore not reusable here).
#[derive(Debug)]
pub(crate) struct RolloutTailer {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// True until the first complete line after a mid-file attach is dropped.
    skip_first_partial: bool,
}

impl RolloutTailer {
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            partial: Vec::new(),
            skip_first_partial: false,
        }
    }

    /// Position the tailer: start of file for small files, else
    /// `len - INITIAL_TAIL_BYTES` (the first, almost-certainly partial line
    /// after that offset is dropped on the first read).
    pub(crate) fn attach(&mut self) -> std::io::Result<u64> {
        let len = std::fs::metadata(&self.path)?.len();
        if len > INITIAL_TAIL_BYTES {
            self.offset = len - INITIAL_TAIL_BYTES;
            self.skip_first_partial = true;
        } else {
            self.offset = 0;
        }
        Ok(self.offset)
    }

    /// Read bytes appended since the last read and return the COMPLETE lines
    /// among them; an unterminated trailing fragment is buffered for the next
    /// read. IO errors and a shrunk file yield an empty batch -- fail quiet;
    /// the codex busy-deadman (kata namg) retries the read every
    /// BUSY_DEADMAN_MS while the terminal stays busy, so a transient IO
    /// error costs at most one window. DEFERRED (adjudicated, kata namg /
    /// docs/plans/2026-07-29-codex-lane-self-healing.md D2): a
    /// TailerReadOutcome-style loud degrade signal + LaneRetry-equivalent
    /// bounded re-attach (amplifier parity) -- a permanently unreadable
    /// rollout currently retries quietly on the deadman cadence instead of
    /// degrading loudly.
    pub(crate) fn read_new_lines(&mut self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let Ok(len) = file.metadata().map(|m| m.len()) else {
            return Vec::new();
        };
        if len < self.offset {
            // Truncated/replaced file: restart from the top.
            self.offset = 0;
            self.partial.clear();
            self.skip_first_partial = false;
        }
        if len == self.offset {
            return Vec::new();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        if file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.offset = len;
        self.partial.extend_from_slice(&buf);

        let mut lines = Vec::new();
        while let Some(newline_at) = self.partial.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = self.partial.drain(..=newline_at).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1])
                .trim_end_matches('\r')
                .to_string();
            if self.skip_first_partial {
                self.skip_first_partial = false;
                continue;
            }
            if !line.is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

/// Fold rollout JSONL lines into the latest task-event timestamps.
/// Discriminators mirror `freshell_sessions::parse::codex` (parse/codex.rs
/// :433-447) and the legacy `providers/codex.ts:344-359`: top-level
/// `type == "event_msg"`, `payload.type` in
/// {`task_started`, `task_complete`, `turn_aborted`}.
pub(crate) fn fold_task_events(lines: &[String]) -> CodexTaskEvents {
    let mut events = CodexTaskEvents::default();
    for line in lines {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let ts = value.get("timestamp").and_then(parse_timestamp_ms);
        let payload = value.get("payload");
        let slot = match payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) {
            Some("task_started") => &mut events.latest_task_started_at,
            Some("task_complete") => &mut events.latest_task_completed_at,
            Some("turn_aborted") => {
                // Newest-wins PAIRING: the reason always corresponds to the
                // winning `latest_turn_aborted_at`, and is None when that
                // abort carried no reason (legacy lines).
                if timestamp_beats(events.latest_turn_aborted_at, ts) {
                    events.latest_turn_aborted_at = ts;
                    events.latest_turn_aborted_reason = payload
                        .and_then(|p| p.get("reason"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                }
                continue;
            }
            _ => continue,
        };
        *slot = match (*slot, ts) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, None) => a,
            (None, b) => b,
        };
    }
    events
}

/// True when `candidate` becomes the new max over `current` (the fold's
/// max-assign idiom, expressed as a predicate so paired fields can move
/// together). A timestamp-less candidate never wins; ties keep the current.
fn timestamp_beats(current: Option<i64>, candidate: Option<i64>) -> bool {
    match (current, candidate) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(current), Some(candidate)) => candidate > current,
    }
}

/// Resume-time rollout locator: find the rollout owned by `session_id` under
/// the codex sessions root. Filename containment is only a cheap PREFILTER;
/// ownership is proven by the first line being a `session_meta` whose
/// `payload.id` equals the session id -- filename/substring matching alone is
/// documented-unsafe (V5 sampling: 40% of sampled rollouts
/// contain foreign uuids as fork/resume lineage). Bounded recursive walk (the tree is
/// `sessions/YYYY/MM/DD/rollout-*.jsonl`, flat `<id>.jsonl` in tests).
pub fn locate_codex_rollout(sessions_root: &Path, session_id: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, session_id: &str, depth: u8, hit: &mut Option<PathBuf>) {
        if depth > 5 || hit.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if hit.is_some() {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, session_id, depth + 1, hit);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".jsonl") && n.contains(session_id))
                .unwrap_or(false)
                && first_line_owns(&path, session_id)
            {
                *hit = Some(path);
            }
        }
    }
    let mut hit = None;
    walk(sessions_root, session_id, 0, &mut hit);
    hit
}

/// Bounded first-line ownership proof (same predicate as
/// `verify_rollout_path`, without the containment checks -- we generated the
/// candidate path ourselves from a walk of the root).
fn first_line_owns(path: &Path, session_id: &str) -> bool {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file).take(1024 * 1024);
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(first.trim()) else {
        return false;
    };
    value.get("type").and_then(|t| t.as_str()) == Some("session_meta")
        && value
            .get("payload")
            .and_then(|p| p.get("id"))
            .and_then(|i| i.as_str())
            == Some(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn event_line(payload_type: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#
        )
    }

    #[test]
    fn fold_extracts_latest_task_event_timestamps() {
        let lines = vec![
            event_line("task_started", "2026-07-25T08:00:00.000Z"),
            event_line("task_complete", "2026-07-25T08:00:10.000Z"),
            event_line("task_started", "2026-07-25T08:01:00.000Z"),
            r#"{"timestamp":"2026-07-25T08:01:01.000Z","type":"response_item","payload":{"type":"message"}}"#.to_string(),
            "not json at all".to_string(),
        ];
        let events = fold_task_events(&lines);
        assert!(events.latest_task_started_at > events.latest_task_completed_at);
        assert!(events.latest_task_started_at.is_some());
        assert!(events.latest_turn_aborted_at.is_none());
    }

    #[test]
    fn fold_handles_turn_aborted_and_numeric_timestamps() {
        let lines = vec![
            r#"{"timestamp":1753430400000,"type":"event_msg","payload":{"type":"turn_aborted"}}"#
                .to_string(),
        ];
        let events = fold_task_events(&lines);
        assert_eq!(events.latest_turn_aborted_at, Some(1_753_430_400_000));
        assert_eq!(
            events.latest_turn_aborted_reason, None,
            "a reason-less legacy line yields None"
        );
    }

    #[test]
    fn fold_pairs_the_abort_reason_with_the_newest_abort_timestamp() {
        // Newest-wins pairing: the reason belongs to the WINNING abort, even
        // when an older reasoned abort arrives later in the batch.
        let lines = vec![
            r#"{"timestamp":"2026-07-25T08:00:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"x","reason":"interrupted"}}"#
                .to_string(),
            r#"{"timestamp":"2026-07-25T07:00:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"w","reason":"replaced"}}"#
                .to_string(),
        ];
        let events = fold_task_events(&lines);
        assert_eq!(
            events.latest_turn_aborted_reason,
            Some("interrupted".to_string())
        );
    }

    #[test]
    fn fold_newer_reasonless_abort_clears_a_stale_reason() {
        // The pairing invariant also holds in reverse: a NEWER reason-less
        // abort must not inherit the older abort's reason.
        let lines = vec![
            r#"{"timestamp":"2026-07-25T07:00:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"w","reason":"interrupted"}}"#
                .to_string(),
            r#"{"timestamp":"2026-07-25T08:00:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"x"}}"#
                .to_string(),
        ];
        let events = fold_task_events(&lines);
        assert_eq!(events.latest_turn_aborted_reason, None);
    }

    #[test]
    fn tailer_reads_appended_lines_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(&path, "line1\nline2\n").unwrap();

        let mut tailer = RolloutTailer::new(&path);
        tailer.attach().unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["line1", "line2"]);
        assert!(
            tailer.read_new_lines().is_empty(),
            "no new bytes -> no lines"
        );

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        write!(f, "line3\npart").unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["line3"]);

        writeln!(f, "ial4").unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["partial4"]);
    }

    #[test]
    fn tailer_initial_attach_is_bounded_and_drops_the_partial_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        // > INITIAL_TAIL_BYTES of filler, then two real lines at the end.
        let filler = "x".repeat(INITIAL_TAIL_BYTES as usize + 1024);
        std::fs::write(&path, format!("{filler}\nreal1\nreal2\n")).unwrap();
        let mut tailer = RolloutTailer::new(&path);
        tailer.attach().unwrap();
        let lines = tailer.read_new_lines();
        // The truncated filler tail must be dropped; only complete lines
        // inside the window survive (tail-trusting semantics).
        assert_eq!(lines, vec!["real1", "real2"]);
    }

    #[test]
    fn locate_finds_dated_rollout_by_first_line_ownership_proof() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let day = root.join("2026").join("07").join("25");
        std::fs::create_dir_all(&day).unwrap();
        const SID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        const OTHER: &str = "99999999-8888-7777-6666-555555555555";
        // Decoy: filename embeds SID but first line proves OTHER owns it
        // (foreign-lineage spoof -- filename matching alone is unsafe).
        std::fs::write(
            day.join(format!("rollout-2026-07-25T07-00-00-{SID}.decoy.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{OTHER}"}}}}"#) + "\n",
        )
        .unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-07-25T08-00-00-{SID}.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{SID}"}}}}"#) + "\n",
        )
        .unwrap();
        let found = locate_codex_rollout(&root, SID).expect("locates the owned rollout");
        assert!(found.to_string_lossy().contains("T08-00-00"));
        assert!(locate_codex_rollout(&root, "no-such-id").is_none());
    }

    #[test]
    fn locate_finds_flat_test_shape_rollouts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        const SID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        std::fs::write(
            root.join(format!("{SID}.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{SID}"}}}}"#) + "\n",
        )
        .unwrap();
        assert!(locate_codex_rollout(&root, SID).is_some());
    }
}

//! Amplifier session source: `<amplifier_home>/projects/**/sessions/**/metadata.json`.
//!
//! 1:1 port of `server/coding-cli/providers/amplifier.ts`'s discovery/parse logic,
//! feeding the same [`crate::directory_index::SessionSource`] abstraction
//! `ClaudeSource`/`CodexSource` implement. Kept in its own module (not added
//! inline to `directory_index.rs`, unlike those two) so this file's history is
//! disjoint from that file's cache-persistence internals during concurrent
//! development -- it reuses only the `pub` `SessionSource`/`IndexedSession`/
//! `FileStat` contract from there, nothing private.
//!
//! **Canonical record is `metadata.json`, not `events.jsonl`.** A session dir
//! (`<amplifier_home>/projects/<slug>/sessions/<id>/`) holds three files side
//! by side: `metadata.json` (small, one JSON object -- session id/cwd/title/
//! timestamps), `transcript.jsonl` (the message log), and `events.jsonl` (the
//! live lifecycle event log). Only `metadata.json` is read+parsed for the
//! session-directory listing; `events.jsonl` is `stat`-ed ONLY (never read) --
//! `getActivityMtimeMs` (`providers/amplifier.ts:183-201`) needs just its
//! mtime, to fold sidecar activity into recency
//! (`session-indexer.ts:977`). `events.jsonl` lines can be enormous (a single
//! line can embed the ENTIRE conversation history so far -- 100k+ tokens is
//! normal for a long session), but since this module never reads its content,
//! that hazard doesn't apply here. The hazard THIS module DOES guard against
//! is `transcript.jsonl`: also JSONL, and in principle its first line could be
//! just as large, so the sibling-transcript read for the first-user-message
//! preview is capped at [`FIRST_USER_MESSAGE_MAX_READ_BYTES`] --
//! `AMPLIFIER_FIRST_USER_MESSAGE_MAX_READ_BYTES` (`providers/amplifier.ts:8-10`)
//! -- never the whole file, mirroring `readFirstUserMessageFromTranscript`
//! (`providers/amplifier.ts:106-140`) byte-for-byte.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::directory_index::{FileStat, IndexedSession, SessionSource};
use crate::meta::ParsedSessionMeta;
use crate::text::normalize_first_user_message;
use crate::time::parse_timestamp_ms;

/// `AMPLIFIER_FIRST_USER_MESSAGE_MAX_READ_BYTES` (`providers/amplifier.ts:10`):
/// bounded prefix read of the sibling `transcript.jsonl` for the first-user-message
/// preview -- never the whole (potentially tens-of-MB) file.
const FIRST_USER_MESSAGE_MAX_READ_BYTES: u64 = 64 * 1024;

/// `defaultAmplifierHome()` (`providers/amplifier.ts:12-14`): `AMPLIFIER_HOME`
/// env else `<home>/.amplifier`. Mirrors `claude_home`/`codex_home`
/// (`crates/freshell-server/src/session_directory.rs:376-390`) but lives here
/// since this module owns its own home resolution (that file's internals are
/// out of scope for this change).
pub fn amplifier_home(home: &Path) -> PathBuf {
    match std::env::var("AMPLIFIER_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".amplifier"),
    }
}

/// Amplifier source: recursively walks
/// `<amplifier_home>/projects/**/sessions/**/metadata.json`. A faithful lift of
/// `amplifierProvider.listSessionFiles()` (`providers/amplifier.ts:217-224`,
/// `walkMetadataFiles` at :142-161).
pub struct AmplifierSource {
    amplifier_home: PathBuf,
}

impl AmplifierSource {
    pub fn new(amplifier_home: PathBuf) -> Self {
        Self { amplifier_home }
    }

    /// Convenience: discover + parse every currently-visible file in one call,
    /// ignoring any incremental cache. Test/perf use only -- mirrors
    /// `ClaudeSource::scan()`/`CodexSource::scan()`.
    pub fn scan(&self) -> Vec<IndexedSession> {
        self.discover()
            .into_iter()
            .filter_map(|stat| self.parse(&stat.path))
            .collect()
    }
}

impl SessionSource for AmplifierSource {
    fn discover(&self) -> Vec<FileStat> {
        let projects_dir = self.amplifier_home.join("projects");
        let mut stats = Vec::new();
        walk_metadata_files(&projects_dir, &projects_dir, &mut stats);
        stats
    }

    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        parse_amplifier_file(path)
    }
}

/// Recursively find every `metadata.json` under `dir` (never
/// `metadata.json.backup` -- exact filename match only, mirroring
/// `walkMetadataFiles`'s `entry.name === 'metadata.json'` check,
/// `providers/amplifier.ts:155`), then keep only files whose path (relative to
/// `root`, the `projects/` dir) has a `sessions` path segment -- mirroring
/// `listSessionFiles`'s `path.relative(projectsDir, file).split(path.sep).includes('sessions')`
/// filter (`providers/amplifier.ts:217-224`). Sorted per directory level for
/// determinism (readdir order is filesystem-dependent), same convention
/// `ClaudeSource`/`CodexSource` use.
fn walk_metadata_files(root: &Path, dir: &Path, out: &mut Vec<FileStat>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            walk_metadata_files(root, &path, out);
        } else if path.file_name().and_then(|n| n.to_str()) == Some("metadata.json") {
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let under_sessions = relative.components().any(|c| c.as_os_str() == "sessions");
            if under_sessions {
                if let Some(stat) = stat_metadata_file(&path) {
                    out.push(stat);
                }
            }
        }
    }
}

/// `fs::metadata` a single file into a [`FileStat`], `None` on any stat
/// failure -- same tolerance as `directory_index.rs`'s private `stat_file`,
/// duplicated here (not imported) since that helper isn't `pub(crate)` and
/// this module deliberately avoids editing `directory_index.rs`'s internals.
fn stat_metadata_file(path: &Path) -> Option<FileStat> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(FileStat {
        path: path.to_path_buf(),
        mtime_ms,
        size: meta.len(),
    })
}

/// `fs::metadata(path).modified()` in milliseconds, `None` on any stat
/// failure (including "doesn't exist").
fn file_mtime_ms(path: &Path) -> Option<i64> {
    stat_metadata_file(path).map(|s| s.mtime_ms)
}

/// `maxDefined` (`providers/amplifier.ts:26-33`): the max of two optional
/// values, treating a missing side as "no opinion" rather than `0`.
fn max_defined(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (None, None) => None,
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (Some(x), Some(y)) => Some(x.max(y)),
    }
}

/// `parseAmplifierMetadata` (`providers/amplifier.ts:66-99`): pure,
/// synchronous mapping of a `metadata.json` document's parsed JSON into
/// [`ParsedSessionMeta`]. Malformed JSON or a non-object document yields the
/// all-`None` default (`providers/amplifier.ts:68-73`), matching the
/// reference's `try { JSON.parse } catch { return {} }`.
pub fn parse_amplifier_metadata(content: &str) -> ParsedSessionMeta {
    let Ok(data) = serde_json::from_str::<Value>(content) else {
        return ParsedSessionMeta::default();
    };
    if !data.is_object() {
        return ParsedSessionMeta::default();
    }

    // `createdAt` (:75) + `lastActivityAt` = max(description_updated_at,
    // name_generated_at, createdAt) (:76-80).
    let created_at = data.get("created").and_then(parse_timestamp_ms);
    let last_activity_at = max_defined(
        max_defined(
            data.get("description_updated_at")
                .and_then(parse_timestamp_ms),
            data.get("name_generated_at").and_then(parse_timestamp_ms),
        ),
        created_at,
    );

    // `name` -> title (:82-85): trimmed, empty-after-trim treated as absent.
    let title = data
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // `description` -> summary (:94): same trim/empty rule.
    let summary = data
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // `data.parent_id != null` (:97): true only when the key is PRESENT and
    // not JSON `null` -- an absent key must NOT count as a subagent.
    let is_subagent = data.get("parent_id").map(|v| !v.is_null()).unwrap_or(false);

    ParsedSessionMeta {
        session_id: data
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        cwd: data
            .get("working_dir")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at,
        last_activity_at,
        title,
        summary,
        is_subagent: Some(is_subagent),
        ..Default::default()
    }
}

/// `readFirstUserMessageFromTranscript` (`providers/amplifier.ts:106-140`):
/// best-effort, BOUNDED read of the first user message from the sibling
/// `transcript.jsonl`. Reads at most [`FIRST_USER_MESSAGE_MAX_READ_BYTES`]
/// bytes from the start of the file -- never the whole file, regardless of
/// how large it (or its first line) is. If the read didn't reach EOF, the
/// final (possibly truncated mid-line) line is dropped, mirroring the
/// reference's `bytesRead >= stat.size ? lines : lines.slice(0, -1)`.
/// Corruption-tolerant: any I/O or parse failure yields `None`, never panics.
fn read_first_user_message_from_transcript(path: &Path) -> Option<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let to_read = size.min(FIRST_USER_MESSAGE_MAX_READ_BYTES) as usize;
    let mut buf = vec![0u8; to_read];
    let bytes_read = file.read(&mut buf).ok()?;
    buf.truncate(bytes_read);
    let chunk = String::from_utf8_lossy(&buf);

    let mut lines: Vec<&str> = chunk.split('\n').collect();
    if (bytes_read as u64) < size && !lines.is_empty() {
        // Didn't read the entire file -- the final line may be truncated.
        lines.pop();
    }

    for line in lines {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let is_user = obj.get("role").and_then(Value::as_str) == Some("user");
        if !is_user {
            continue;
        }
        if let Some(content) = obj.get("content").and_then(Value::as_str) {
            // Keep scanning if this user line normalizes to empty
            // (whitespace-only) -- matches the reference exactly.
            if let Some(normalized) = normalize_first_user_message(content) {
                return Some(normalized);
            }
        }
    }
    None
}

/// Map a parsed [`ParsedSessionMeta`] + folded activity mtime into an
/// [`IndexedSession`] for the `amplifier` provider. `fallback_session_id` is
/// used when `meta.session_id` is absent (`extractSessionId`,
/// `providers/amplifier.ts:240-243`: the metadata.json parent dir name).
/// `last_activity_at` folds `meta.last_activity_at` with the sidecar
/// `activity_mtime_ms` exactly as `session-indexer.ts:977` does:
/// `Math.floor(maxDefined(lastActivityAt, activityMtimeMs) ?? 0)`.
fn indexed_from_meta(
    meta: &ParsedSessionMeta,
    fallback_session_id: &str,
    activity_mtime_ms: Option<i64>,
) -> IndexedSession {
    let last_activity_at = max_defined(meta.last_activity_at, activity_mtime_ms)
        .unwrap_or(0)
        .max(0);
    IndexedSession {
        session_id: meta
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.to_string()),
        provider: "amplifier".to_string(),
        // Raw `cwd`, not git-root-resolved -- matches the established Rust-port
        // convention for `project_path` (`item_from_meta`/`opencode_session_to_indexed`
        // in `directory_index.rs` both use raw `cwd` too; git-root resolution
        // is not currently ported for any provider).
        project_path: meta.cwd.clone().unwrap_or_else(|| "unknown".to_string()),
        title: meta.title.clone(),
        summary: meta.summary.clone(),
        first_user_message: meta.first_user_message.clone(),
        last_activity_at,
        created_at: meta.created_at,
        cwd: meta.cwd.clone(),
        is_subagent: meta.is_subagent.unwrap_or(false),
        is_non_interactive: meta.is_non_interactive.unwrap_or(false),
    }
}

/// Read + parse one `metadata.json` into an [`IndexedSession`].
/// Corruption-tolerant (never panics); an unreadable file is skipped
/// (`None`). Enforces R10b (`session-indexer.ts:1247`'s discovery-time
/// `if (!meta.cwd) continue`, which applies to every provider, not just
/// claude/codex -- `parse_claude_file`/`parse_codex_file` in
/// `directory_index.rs` enforce the same gate).
fn parse_amplifier_file(path: &Path) -> Option<IndexedSession> {
    let content = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    let mut meta = parse_amplifier_metadata(&content);
    meta.cwd.as_ref()?;

    let dir = path.parent()?;
    let transcript_path = dir.join("transcript.jsonl");
    meta.first_user_message = read_first_user_message_from_transcript(&transcript_path);

    // `getActivityMtimeMs` (`providers/amplifier.ts:183-201`): max of the two
    // activity-sidecar mtimes, STAT-only -- their CONTENT is never read here.
    let events_path = dir.join("events.jsonl");
    let activity_mtime_ms =
        max_defined(file_mtime_ms(&transcript_path), file_mtime_ms(&events_path));

    // `extractSessionId` (`providers/amplifier.ts:240-243`): metadata.json's
    // own parent dir name, when `session_id` is absent from the document.
    let fallback = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    Some(indexed_from_meta(&meta, &fallback, activity_mtime_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directory_index::{ClaudeSource, SessionIndex};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-amplifier-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Writes `<home>/projects/<slug>/sessions/<id>/metadata.json` (+ optional
    /// sibling transcript.jsonl / events.jsonl) and returns the session dir.
    fn write_session(
        home: &Path,
        slug: &str,
        id: &str,
        metadata_json: &str,
        transcript_jsonl: Option<&str>,
    ) -> PathBuf {
        let dir = home.join("projects").join(slug).join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("metadata.json"), metadata_json).unwrap();
        if let Some(t) = transcript_jsonl {
            std::fs::write(dir.join("transcript.jsonl"), t).unwrap();
        }
        dir
    }

    fn sample_metadata(session_id: &str, cwd: &str, name: &str) -> String {
        format!(
            r#"{{"session_id":"{session_id}","working_dir":"{cwd}","created":"2026-03-01T00:00:00.000Z","description_updated_at":"2026-03-01T00:05:00.000Z","name":"{name}","description":"a summary","turn_count":3}}"#
        )
    }

    // -- parse_amplifier_metadata: pure field mapping --

    #[test]
    fn parse_amplifier_metadata_maps_fields() {
        let content = sample_metadata("sess-1", "/home/dan/proj", "My Session");
        let meta = parse_amplifier_metadata(&content);
        assert_eq!(meta.session_id.as_deref(), Some("sess-1"));
        assert_eq!(meta.cwd.as_deref(), Some("/home/dan/proj"));
        assert_eq!(meta.title.as_deref(), Some("My Session"));
        assert_eq!(meta.summary.as_deref(), Some("a summary"));
        assert_eq!(meta.created_at, Some(1_772_323_200_000));
        // last_activity_at = max(description_updated_at, name_generated_at, created_at)
        assert_eq!(meta.last_activity_at, Some(1_772_323_500_000));
        assert_eq!(meta.is_subagent, Some(false));
    }

    #[test]
    fn parse_amplifier_metadata_marks_subagent_when_parent_id_present() {
        let content = r#"{"session_id":"s","working_dir":"/p","parent_id":"parent-1"}"#;
        let meta = parse_amplifier_metadata(content);
        assert_eq!(meta.is_subagent, Some(true));
    }

    #[test]
    fn parse_amplifier_metadata_last_activity_falls_back_to_created() {
        // No description_updated_at/name_generated_at -> falls back to created.
        let content = r#"{"session_id":"s","working_dir":"/p","created":1738231200000}"#;
        let meta = parse_amplifier_metadata(content);
        assert_eq!(meta.last_activity_at, Some(1_738_231_200_000));
    }

    #[test]
    fn parse_amplifier_metadata_malformed_json_yields_default() {
        let meta = parse_amplifier_metadata("not json at all");
        assert_eq!(meta, ParsedSessionMeta::default());
    }

    // -- R10b: cwd-less sessions are excluded at discovery --

    #[test]
    fn amplifier_source_skips_cwdless_sessions() {
        let home = unique_temp_dir("cwdless");
        // No `working_dir` field anywhere -> no resolvable cwd.
        write_session(
            &home,
            "proj",
            "no-cwd",
            r#"{"session_id":"no-cwd","name":"x"}"#,
            None,
        );
        write_session(
            &home,
            "proj",
            "has-cwd",
            &sample_metadata("has-cwd", "/p", "y"),
            None,
        );
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "has-cwd");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- fixture parse: full session with first-user-message from transcript --

    #[test]
    fn amplifier_source_parses_fixture_session_with_first_user_message() {
        let home = unique_temp_dir("fixture");
        write_session(
            &home,
            "myproj",
            "sess-42",
            &sample_metadata("sess-42", "/home/dan/myproj", "Fixture Session"),
            Some(
                "{\"role\":\"user\",\"content\":\"fix the login bug\"}\n{\"role\":\"assistant\",\"content\":\"done\"}\n",
            ),
        );
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.session_id, "sess-42");
        assert_eq!(item.provider, "amplifier");
        assert_eq!(item.cwd.as_deref(), Some("/home/dan/myproj"));
        assert_eq!(item.title.as_deref(), Some("Fixture Session"));
        assert_eq!(item.summary.as_deref(), Some("a summary"));
        assert_eq!(
            item.first_user_message.as_deref(),
            Some("fix the login bug")
        );
        assert_eq!(item.key(), "amplifier:sess-42");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- session id fallback: dirname of metadata.json's parent when absent --

    #[test]
    fn amplifier_source_falls_back_to_dirname_for_session_id() {
        let home = unique_temp_dir("fallback-id");
        write_session(
            &home,
            "proj",
            "dir-id-123",
            r#"{"working_dir":"/p"}"#, // no session_id field
            None,
        );
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "dir-id-123");
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- activity mtime fold: sidecar mtime newer than metadata bumps recency --

    #[test]
    fn amplifier_source_folds_sidecar_mtime_into_last_activity_at() {
        let home = unique_temp_dir("mtime-fold");
        let dir = write_session(
            &home,
            "proj",
            "sess-mtime",
            r#"{"session_id":"sess-mtime","working_dir":"/p","created":1000}"#,
            None,
        );
        // events.jsonl mtime is "now" -- far newer than the metadata's created:1000.
        std::fs::write(dir.join("events.jsonl"), "{\"event\":\"x\"}\n").unwrap();
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1);
        assert!(
            items[0].last_activity_at > 1000,
            "sidecar mtime must be folded into last_activity_at, got {}",
            items[0].last_activity_at
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- metadata.json.backup is never treated as a session file --

    #[test]
    fn amplifier_source_ignores_metadata_backup_files() {
        let home = unique_temp_dir("backup");
        let dir = home
            .join("projects")
            .join("proj")
            .join("sessions")
            .join("sess-1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("metadata.json.backup"), "{}").unwrap();
        let source = AmplifierSource::new(home.clone());
        assert!(source.scan().is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- empty/missing ~/.amplifier tolerated silently --

    #[test]
    fn amplifier_source_missing_home_returns_empty() {
        let home = unique_temp_dir("missing");
        let _ = std::fs::remove_dir_all(&home); // never created
        let source = AmplifierSource::new(home);
        assert!(source.discover().is_empty());
        assert!(source.scan().is_empty());
    }

    // -- bounded read safety: a huge single line never hangs or panics --

    #[test]
    fn bounded_read_handles_huge_single_line_without_hang_or_panic() {
        let home = unique_temp_dir("huge-line");
        let dir = write_session(
            &home,
            "proj",
            "huge",
            &sample_metadata("huge", "/p", "Huge"),
            None,
        );
        // One line, no trailing newline, far larger than the 64KB read cap --
        // and NOT valid JSON once truncated, so it must be safely dropped.
        let mut f = std::fs::File::create(dir.join("transcript.jsonl")).unwrap();
        let huge = "x".repeat(3 * 1024 * 1024);
        write!(f, "{{\"role\":\"user\",\"content\":\"{huge}\"").unwrap();
        drop(f);

        let started = std::time::Instant::now();
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        let elapsed = started.elapsed();

        assert_eq!(items.len(), 1);
        // The truncated (64KB) line never closes its JSON string/object, so it's
        // unparseable -- no first-user-message, but also no panic/hang.
        assert_eq!(items[0].first_user_message, None);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "bounded read must stay fast regardless of file size, took {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bounded_read_extracts_first_message_before_huge_trailing_line() {
        let home = unique_temp_dir("huge-trailing");
        let dir = write_session(
            &home,
            "proj",
            "huge2",
            &sample_metadata("huge2", "/p", "Huge2"),
            None,
        );
        let mut content = String::from("{\"role\":\"user\",\"content\":\"small first message\"}\n");
        content.push_str(&"y".repeat(3 * 1024 * 1024));
        std::fs::write(dir.join("transcript.jsonl"), content).unwrap();

        let started = std::time::Instant::now();
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        let elapsed = started.elapsed();

        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].first_user_message.as_deref(),
            Some("small first message")
        );
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "bounded read must stay fast regardless of file size, took {elapsed:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- merge/sort with another provider inside SessionIndex --

    #[tokio::test]
    async fn amplifier_source_merges_and_sorts_with_claude_source_in_session_index() {
        let home = unique_temp_dir("merge");
        write_session(
            &home,
            "proj",
            "amp-1",
            r#"{"session_id":"amp-1","working_dir":"/p","created":5000,"description_updated_at":5000}"#,
            None,
        );
        let claude_home = home.join(".claude");
        let claude_dir = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::write(
            claude_dir.join("claude-1.jsonl"),
            "{\"cwd\":\"/p\",\"sessionId\":\"claude-1\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"},\"timestamp\":\"2026-03-01T00:00:01.000Z\"}\n",
        )
        .unwrap();

        let index = SessionIndex::new(vec![
            Arc::new(AmplifierSource::new(home.clone())) as Arc<dyn SessionSource>,
            Arc::new(ClaudeSource::new(claude_home)) as Arc<dyn SessionSource>,
        ]);
        let snapshot = index.snapshot().await;
        let providers: Vec<&str> = snapshot.iter().map(|s| s.provider.as_str()).collect();
        assert!(providers.contains(&"amplifier"));
        assert!(providers.contains(&"claude"));
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- override key format: provider-qualified, auto-compatible with overrides --

    #[test]
    fn amplifier_session_key_is_provider_qualified() {
        let home = unique_temp_dir("key");
        write_session(
            &home,
            "proj",
            "override-me",
            &sample_metadata("override-me", "/p", "Overridable"),
            None,
        );
        let source = AmplifierSource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key(), "amplifier:override-me");
        let _ = std::fs::remove_dir_all(&home);
    }
}

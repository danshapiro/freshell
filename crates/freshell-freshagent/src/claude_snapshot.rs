//! Claude fresh-agent snapshot adapter (restart-resilience plan §2.8 item 4).
//!
//! Reads the Claude CLI's own transcript store (`<store-root>/projects/<cwd-slug>/
//! <uuid>.jsonl`) directly -- the first file-reading snapshot source in the Rust port.
//! Design choice over codex's resume-and-ask: the sidecar protocol has no history op,
//! the SDK's own `getSessionMessages` is itself just a local JSONL read with the same
//! root resolution (ledger A16), a sidecar resume burns a real SDK process per
//! snapshot GET, and the legacy Node server already proved direct-read viable
//! (`server/session-history-loader.ts` -- with real-store parsing fixes, ledger A5).
//! Store-root resolution is ORDERED CANDIDATES (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
//! `$HOME/.claude`) because the real CLI honors CLAUDE_CONFIG_DIR and IGNORES
//! CLAUDE_HOME (ledger A3) -- reading a single root risks false positive denial.
//! The transcript store is also the AUTHORITY for lost-vs-alive on attach
//! ([`crate::FreshClaudeState::handle_attach`]): file present => resumable, file
//! absent in EVERY candidate root => positively gone (mirrors opencode's 404 rule;
//! honest even under claude's 30-day `cleanupPeriodDays` GC -- an expired transcript
//! is unresumable by the CLI too, ledger A4).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO, TOOL_ERROR_LABEL, TOOL_RESULT_LABEL};

/// Ordered candidate store roots. The real CLI resolves its store as
/// `CLAUDE_CONFIG_DIR ?? $HOME/.claude` and IGNORES `CLAUDE_HOME` (verified against
/// cli.js 2.1.220 -- ledger A3); `CLAUDE_HOME` is freshell's legacy knob
/// (`server/claude-home.ts`, `session_directory.rs` -- `pub(crate)` to that crate).
/// We read ALL candidates so a reader/writer root mismatch can never turn a live
/// session into a false positive denial.
pub(crate) fn claude_home_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(v) = std::env::var("CLAUDE_HOME") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            push(PathBuf::from(h).join(".claude"));
        }
    }
    out
}

/// `find_transcript` across every candidate root, in resolution order.
/// Positive denial (attach) and snapshot 404 both require a miss EVERYWHERE.
/// `pub` + re-exported at the crate root (kata 09v1): `freshell-server`'s
/// `IndexExistenceProbe` consults this SAME check before finalizing a
/// warm-index `Absent` for claude — an on-disk transcript can be cwd-less
/// (fixture's create-time 0-byte file; crash-window partial writes) and so
/// fail the index's R10b cwd gate while the attach arm would still attempt
/// resume on it; the reconcile arm and the attach arm must share one
/// definition of "the transcript exists".
pub fn locate_transcript(session_id: &str) -> Option<PathBuf> {
    claude_home_candidates()
        .iter()
        .find_map(|root| find_transcript(root, session_id))
}

/// The session's ORIGINAL cwd: first non-empty `cwd` field among the transcript's
/// lines (100% of real user/assistant lines carry it -- ledger A5 census). Needed
/// because the CLI's resume lookup is scoped to the original cwd's project slug
/// (ledger A15). Reads lazily, stops at the first hit; malformed lines skipped.
pub fn transcript_cwd(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(serde_json::Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Node's `CWD_SCAN_BYTES` (`claude-transcript-locator.ts:31`): the resolve
/// endpoint's cwd read never scans past the first 64 KiB of a transcript.
const CWD_SCAN_BYTES: u64 = 64 * 1024;

/// Bounded variant of [`transcript_cwd`] for the resume-resolve claude
/// exact-id fallback (`crates/freshell-server/src/main.rs`). Node parity
/// (`claude-transcript-locator.ts:121-152` `readCwdFromTranscript`): read AT
/// MOST the first [`CWD_SCAN_BYTES`] of the file, split that prefix on
/// `\n`, and attempt to parse EVERY segment INCLUDING the final one —
/// Node's `head.split('\n')` loop has no discard-the-truncated-tail rule (a
/// fragment cut at the 64 KiB boundary simply fails `JSON.parse` and is
/// skipped, while a COMPLETE final line with no trailing newline still
/// parses). First non-empty string `cwd` wins. One resolve request against
/// a multi-GB transcript (or a single enormous line) must not allocate or
/// scan past the 64 KiB prefix — do NOT swap this for [`transcript_cwd`]'s
/// unbounded `BufRead::lines()` loop.
///
/// Errors are swallowed to `None` like [`transcript_cwd`]; the
/// error-PROPAGATING variant for the provider-error channel is
/// [`transcript_cwd_checked`].
pub fn transcript_cwd_bounded(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(CWD_SCAN_BYTES).read_to_end(&mut head).ok()?;
    // Node's Buffer.toString('utf8') is lossy at the truncation boundary;
    // from_utf8_lossy matches (replacement chars only ever land in the
    // final fragment, which then fails to parse — same as Node).
    let head = String::from_utf8_lossy(&head);
    for segment in head.split('\n') {
        let trimmed = segment.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Locate `<claude_home>/projects/*/<session_id>.jsonl` (or one subdir deeper, e.g.
/// `<project>/<session-id-dir>/...` layouts). Filename scan, NEVER slug re-derivation:
/// the cwd->slug encoding is lossy (`docs/port-plan.md:45`). Sorted dirs for
/// determinism (mirrors `directory_index.rs::discover_claude_home`).
pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let filename = format!("{session_id}.jsonl");
    let projects = claude_home.join("projects");
    let entries = std::fs::read_dir(&projects).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for dir in &dirs {
        let direct = dir.join(&filename);
        if direct.is_file() {
            return Some(direct);
        }
        let Ok(nested) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = nested
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        for sub in &subdirs {
            let candidate = sub.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Error-AWARE variant of [`locate_transcript`] for the resolve endpoint's
/// provider-health channel (#586 parity): an unreadable claude store must
/// surface as a provider error, never a silent miss. A missing projects dir
/// (`NotFound`) is a genuine miss for that root; any OTHER io error
/// propagates.
///
/// The projects roots are a PARAMETER, exactly like Node's locator takes
/// `projectsDir` (`claude-transcript-locator.ts:65-67`) — the CALLER resolves
/// the environment. Do NOT resolve roots via `claude_home_candidates()`
/// here: that helper adds `CLAUDE_CONFIG_DIR` and bare-`CLAUDE_HOME` roots
/// that Node's resolver (`getSessionRoots()` = `getClaudeHome()/projects`,
/// `providers/claude.ts:524-535`, `server/claude-home.ts:4-7`) and the Rust
/// session index intentionally exclude — with an explicit `CLAUDE_HOME`
/// override it would expose transcripts from a root Node never searches.
/// Parameterizing the roots also keeps the unit tests hermetic: they pass
/// temp dirs and never mutate process-global env.
///
/// Traversal order is Node's GLOBAL two-pass order
/// (`claude-transcript-locator.ts:69-88`): PASS 1 probes the DIRECT layout
/// across ALL roots, then PASS 2 probes the subagent layout across all roots
/// — NOT per-root direct+subagent. (With roots `[A, B]`: A direct, B direct,
/// A subagent, B subagent.)
pub fn locate_transcript_checked(
    projects_roots: &[PathBuf],
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    // PASS 1 — direct layout across all roots.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_direct(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    // PASS 2 — subagent layout, only when the direct layout missed everywhere.
    for projects in projects_roots {
        if let Some(path) = find_transcript_checked_subagent(projects, session_id)? {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Node parity (`claude-transcript-locator.ts:33-37`): expected absence is
/// `ENOENT || ENOTDIR` — a missing dir OR a non-directory path component is
/// a genuine miss; everything else is a provider failure.
fn is_expected_absence(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// The traversal guard [`find_transcript`] applies, shared by the checked
/// helpers: reject ids that could escape the store root.
fn is_safe_session_id(session_id: &str) -> bool {
    !(session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains(".."))
}

/// Sorted entry paths of `dir` — Node's `readdirOrEmpty`
/// (`claude-transcript-locator.ts:95-102`): expected absence reads as an
/// EMPTY listing; any other error PROPAGATES. No file-type filtering: Node
/// probes every entry and lets a non-directory read as an ENOTDIR miss at
/// the candidate probe. Sorted for determinism (the unchecked
/// `find_transcript` convention).
fn read_dir_sorted_or_empty(dir: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if is_expected_absence(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries {
        out.push(entry?.path());
    }
    out.sort();
    Ok(out)
}

/// One candidate probe (Node's `probeTranscript` stat,
/// `claude-transcript-locator.ts:105-113`): `Ok(true)` iff a regular file
/// exists at `path`; expected absence (incl. ENOTDIR from a file path
/// component) is a miss; any OTHER error propagates. `std::fs::metadata`,
/// never the error-swallowing `Path::is_file()`.
fn candidate_is_file(path: &Path) -> Result<bool, std::io::Error> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.is_file()),
        Err(e) if is_expected_absence(&e) => Ok(false),
        Err(e) => Err(e),
    }
}

/// PASS-1 helper: Node's DIRECT layout `<projects>/<project-dir>/<id>.jsonl`
/// (`claude-transcript-locator.ts:39-44,71-76`), with error propagation.
/// CAUTION: intentionally NOT the unchecked [`find_transcript`] layout — that
/// one probes `<project-dir>/<subdir>/<id>.jsonl` without the `subagents`
/// segment, which diverges from Node and misses child sessions.
fn find_transcript_checked_direct(
    projects: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    if !is_safe_session_id(session_id) {
        return Ok(None);
    }
    let filename = format!("{session_id}.jsonl");
    for dir in read_dir_sorted_or_empty(projects)? {
        let candidate = dir.join(&filename);
        if candidate_is_file(&candidate)? {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// PASS-2 helper: Node's SUBAGENT layout
/// `<projects>/<project-dir>/<parent-session>/subagents/<id>.jsonl`
/// (`claude-transcript-locator.ts:45-48,78-88`), with error propagation.
fn find_transcript_checked_subagent(
    projects: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, std::io::Error> {
    if !is_safe_session_id(session_id) {
        return Ok(None);
    }
    let filename = format!("{session_id}.jsonl");
    for dir in read_dir_sorted_or_empty(projects)? {
        for parent in read_dir_sorted_or_empty(&dir)? {
            let candidate = parent.join("subagents").join(&filename);
            if candidate_is_file(&candidate)? {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

/// Error-AWARE variant of [`transcript_cwd_bounded`] for the resolve
/// endpoint's provider-health channel. An open error of expected-absence
/// kind is `Ok(None)` — the file existed a moment ago (the locate probe
/// succeeded), so absence = raced deletion and the hit survives, cwd-less
/// (Node behaves the same, `claude-transcript-locator.ts:121-129`); any
/// OTHER open/read error PROPAGATES (Node wraps these in
/// `ClaudeTranscriptLocatorError`). Same 64 KiB bounded read + tolerant
/// per-segment parse as [`transcript_cwd_bounded`] — malformed lines are
/// skipped, the final unterminated segment is still attempted.
pub fn transcript_cwd_checked(path: &Path) -> Result<Option<String>, std::io::Error> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if is_expected_absence(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut head = Vec::new();
    file.take(CWD_SCAN_BYTES).read_to_end(&mut head)?;
    let head = String::from_utf8_lossy(&head);
    for segment in head.split('\n') {
        let trimmed = segment.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                return Ok(Some(cwd.to_string()));
            }
        }
    }
    Ok(None)
}

/// Why a claude snapshot could not be served.
#[derive(Debug)]
pub(crate) enum ClaudeSnapshotError {
    /// No transcript file for this id -- the store positively does not know it
    /// (maps to 404 FRESH_AGENT_LOST_SESSION, the codex/opencode convention).
    NotFound,
    /// The file exists but could not be read; the message becomes the 500 error body.
    Io(String),
}

/// One transcript JSONL line -> zero-or-one snapshot turn. Parsing rules are the
/// legacy `extractChatMessagesFromJsonl` contract (`server/session-history-loader.ts:36-131`)
/// PLUS the real-store fixes from the ledger A5 census (23,615 real lines): keep only
/// type user|assistant; message may be a plain string, `{content: [...]}`, or
/// `{content: "<string>"}` (the DOMINANT real prompt shape, which legacy-as-coded
/// drops); lines flagged isMeta/isSidechain/isCompactSummary/isVisibleInTranscriptOnly
/// are synthetic/subagent noise and are SKIPPED; malformed lines and unknown block
/// kinds are skipped, never fatal.
fn parse_transcript_turns(thread_id: &str, transcript: &str) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    for line in transcript.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = match obj.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // Real transcripts flag synthetic/subagent lines (ledger A5): skip them.
        if [
            "isMeta",
            "isSidechain",
            "isCompactSummary",
            "isVisibleInTranscriptOnly",
        ]
        .iter()
        .any(|k| obj.get(*k).and_then(Value::as_bool) == Some(true))
        {
            continue;
        }
        let msg = obj.get("message");
        let blocks: Vec<Value> = match msg {
            Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
            Some(Value::Object(m)) => match m.get("content") {
                Some(Value::Array(arr)) => arr.clone(),
                Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
                _ => continue,
            },
            _ => continue,
        };

        let ordinal = turns.len();
        let turn_id = format!("{thread_id}:{ordinal}");
        let mut items: Vec<Value> = Vec::new();
        for (j, block) in blocks.iter().enumerate() {
            let item_id = format!("{turn_id}-i{j}");
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        items.push(json!({ "id": item_id, "kind": "text", "text": text }));
                    }
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    items.push(json!({ "id": item_id, "kind": "thinking", "text": text }));
                }
                Some("tool_use") => {
                    let tool_use_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let mut item = Map::new();
                    item.insert("id".into(), json!(item_id));
                    item.insert("kind".into(), json!("tool_use"));
                    item.insert("toolUseId".into(), json!(tool_use_id));
                    item.insert("name".into(), json!(name));
                    if let Some(input) = block.get("input") {
                        item.insert("input".into(), input.clone());
                    }
                    items.push(Value::Object(item));
                }
                Some("tool_result") => {
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let is_error = block
                        .get("is_error")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    items.push(json!({
                        "id": item_id,
                        "kind": "tool_result",
                        "toolUseId": tool_use_id,
                        "content": tool_result_text(block),
                        "isError": is_error,
                    }));
                }
                _ => {}
            }
        }
        if items.is_empty() {
            continue;
        }

        let summary = summarize(&items);
        let mut turn = Map::new();
        turn.insert("id".into(), json!(turn_id));
        turn.insert("turnId".into(), json!(turn_id));
        if let Some(message_id) = msg
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("messageId".into(), json!(message_id));
        }
        turn.insert("ordinal".into(), json!(ordinal));
        turn.insert("source".into(), json!("durable"));
        turn.insert("role".into(), json!(role));
        if let Some(ts) = obj.get("timestamp").and_then(Value::as_str) {
            turn.insert("timestamp".into(), json!(ts));
        }
        if let Some(model) = msg
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("model".into(), json!(model));
        }
        turn.insert("summary".into(), json!(summary));
        turn.insert("summaryKind".into(), json!(SUMMARY_KIND_ECHO));
        turn.insert("items".into(), json!(items));
        turns.push(Value::Object(turn));
    }
    turns
}

/// Flatten a tool_result block's content (string, or array of text blocks) to a string.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Turn summary: first non-empty `text` item's text, falling back to the first
/// non-empty `thinking` item's text (char-safe truncate to the shared
/// [`SUMMARY_MAX_CHARS`] policy), else a tool label -- `FreshAgentTurnSchema.summary`
/// is REQUIRED. Text is preferred over thinking so an assistant turn's summary
/// is its visible answer, not its reasoning preamble (golden fixture turn 1:
/// items `[thinking "pondering", text "first answer"]` must summarize to
/// `"first answer"`). Every claude summary is a mechanical projection of the
/// turn's own items, so every claude turn tags `summaryKind: "echo"`.
fn summarize(items: &[Value]) -> String {
    let first_text_of = |kind: &str| -> Option<String> {
        items.iter().find_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some(kind) {
                return None;
            }
            let trimmed = item.get("text").and_then(Value::as_str)?.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(truncate_summary(trimmed))
            }
        })
    };
    if let Some(summary) = first_text_of("text").or_else(|| first_text_of("thinking")) {
        return summary;
    }
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    // Tool names count as summaries too: the shared 140-char
                    // policy MUST apply here (one Rust-side truncation policy
                    // for every summary arm — fresh-eyes round 1, Finding 2).
                    return truncate_summary(name);
                }
            }
            Some("tool_result") => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                return if is_error {
                    TOOL_ERROR_LABEL
                } else {
                    TOOL_RESULT_LABEL
                }
                .to_string();
            }
            _ => {}
        }
    }
    "[claude turn]".to_string()
}

/// Build the `FreshAgentSnapshotSchema`-exact JSON (`shared/fresh-agent-contract.ts:230-246`,
/// zod `.strict()` -- every key here is either required or schema-known; NOTHING extra).
pub(crate) fn build_claude_snapshot_json(
    session_type: &str,
    thread_id: &str,
    transcript: &str,
    revision: i64,
) -> Value {
    let turns = parse_transcript_turns(thread_id, transcript);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "sessionType": session_type,
        "provider": "claude",
        "threadId": thread_id,
        "sessionId": thread_id,
        "revision": revision.max(0),
        "latestTurnId": latest_turn_id,
        // Deliberate divergence from codex (which serves live status from session
        // state): this adapter is disk-only and always reports "idle" -- live status
        // is authoritative via the WS status events, so the client ignores this on
        // live sessions.
        "status": "idle",
        "capabilities": {
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": false,
        },
        "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": [],
        "childThreads": [],
        "turns": turns,
        "extensions": {},
    })
}

/// Locate + read + build. `revision` = transcript mtime in ms (monotonic as the file
/// grows -- `mergeSnapshotForDisplay` DROPS revision regressions), fallback turn count.
pub(crate) async fn get_claude_snapshot(
    session_type: &str,
    thread_id: &str,
) -> Result<Value, ClaudeSnapshotError> {
    // Cannot check => must not deny (the attach arm in claude.rs treats this exact
    // state as Transient): with NO resolvable store root we cannot assert the
    // session is gone, so this is Io (-> 500), never NotFound (-> 404 lost).
    if claude_home_candidates().is_empty() {
        return Err(ClaudeSnapshotError::Io(
            "no claude store root resolvable (CLAUDE_CONFIG_DIR/CLAUDE_HOME/HOME all unset)".into(),
        ));
    }
    // Miss in EVERY candidate root => 404 (positive denial; ledger A3/A4).
    let path = locate_transcript(thread_id).ok_or(ClaudeSnapshotError::NotFound)?;
    let mtime_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ClaudeSnapshotError::Io(e.to_string()))?;
    let mut snapshot = build_claude_snapshot_json(session_type, thread_id, &content, 0);
    let turn_count = snapshot["turns"]
        .as_array()
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    snapshot["revision"] = json!(mtime_ms.unwrap_or(turn_count).max(0));
    Ok(snapshot)
}

/// Task 3 (reload-while-pending): overlay a session's LIVE pending approvals/questions
/// onto the disk-built snapshot — the legacy `normalizeClaudeThreadSnapshot` behavior
/// (`normalize.ts:186-204`: `pendingApprovals`/`pendingQuestions` come from the live
/// session, not the transcript). The `capabilities.approvals`/`capabilities.questions`
/// gates are driven by PRESENCE OF PENDING (`normalize.ts:226-232`), never by provider
/// capability constants. Entry values arrive already in the `.strict()` contract shape
/// ([`crate::claude::FreshClaudeState::snapshot_pending_overlay`] builds them); this fn
/// stamps them verbatim. An EMPTY overlay re-stamps the same empty arrays + false gates
/// the builder produces, so the no-pending output stays byte-identical to the golden
/// fixture (`builder_output_matches_the_golden_snapshot_fixture`).
pub(crate) fn apply_pending_overlay(
    snapshot: &mut Value,
    approvals: Vec<Value>,
    questions: Vec<Value>,
) {
    snapshot["capabilities"]["approvals"] = json!(!approvals.is_empty());
    snapshot["capabilities"]["questions"] = json!(!questions.is_empty());
    snapshot["pendingApprovals"] = Value::Array(approvals);
    snapshot["pendingQuestions"] = Value::Array(questions);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn find_transcript_locates_a_direct_project_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "11111111-1111-4111-8111-111111111111"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_locates_a_one_level_nested_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p").join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "22222222-2222-4222-8222-222222222222"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_misses_cleanly_and_rejects_traversal() {
        let home = temp_home();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        assert_eq!(
            find_transcript(home.path(), "33333333-3333-4333-8333-333333333333"),
            None
        );
        assert_eq!(find_transcript(home.path(), "../etc/passwd"), None);
        assert_eq!(find_transcript(home.path(), "a/b"), None);
        assert_eq!(find_transcript(home.path(), ""), None);
    }

    #[test]
    fn transcript_cwd_reads_the_first_cwd_field() {
        let home = temp_home();
        let file = home.path().join("t.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\",\"message\":\"hi\"}\n",
        )
        .unwrap();
        assert_eq!(transcript_cwd(&file), Some("/home/user/proj".to_string()));
        let empty = home.path().join("e.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(transcript_cwd(&empty), None);
    }

    #[test]
    fn transcript_cwd_bounded_never_scans_past_the_64kib_prefix() {
        // Node parity (`CWD_SCAN_BYTES`, `claude-transcript-locator.ts`): a
        // cwd line that begins beyond the first 64 KiB is invisible to the
        // resolve fallback's bounded reader — while the unbounded
        // `transcript_cwd` (other consumers) still finds it. Also covers the
        // boundary-straddling case: the line cut at the 64 KiB edge is a
        // truncated fragment that fails to parse and is skipped, like Node's
        // JSON.parse catch.
        let home = temp_home();
        let file = home.path().join("big.jsonl");
        let filler_line = "{\"type\":\"noise\"}\n";
        let mut content = String::new();
        while content.len() <= 64 * 1024 {
            content.push_str(filler_line);
        }
        content.push_str("{\"type\":\"user\",\"cwd\":\"/beyond/prefix\"}\n");
        std::fs::write(&file, &content).unwrap();
        assert_eq!(transcript_cwd_bounded(&file), None);
        assert_eq!(transcript_cwd(&file), Some("/beyond/prefix".to_string()));
    }

    #[test]
    fn transcript_cwd_bounded_parses_a_complete_unterminated_final_line() {
        // Node's `head.split('\n')` loop has no discard-the-tail rule: a
        // COMPLETE final line with no trailing newline (small transcript)
        // still parses. Do not drop the final segment.
        let home = temp_home();
        let file = home.path().join("small.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\"}",
        )
        .unwrap();
        assert_eq!(
            transcript_cwd_bounded(&file),
            Some("/home/user/proj".to_string())
        );
        // First non-empty string cwd wins; empty-string cwd is skipped.
        let skip = home.path().join("skip.jsonl");
        std::fs::write(&skip, "{\"cwd\":\"\"}\n{\"cwd\":42}\n{\"cwd\":\"/real\"}\n").unwrap();
        assert_eq!(transcript_cwd_bounded(&skip), Some("/real".to_string()));
        // Missing file: swallowed to None (checked variant is deferred).
        assert_eq!(
            transcript_cwd_bounded(&home.path().join("absent.jsonl")),
            None
        );
    }

    // -- Task 6 (resolve parity): checked locator + checked cwd reader ------
    //
    // HERMETIC BY CONSTRUCTION: every test below builds a temp projects dir
    // and passes it via the `projects_roots` parameter; NO test mutates
    // process-global env (CLAUDE_HOME/CLAUDE_CONFIG_DIR/HOME), so there is
    // nothing to race against the crate's env-mutating claude tests.

    #[test]
    fn locate_transcript_checked_misses_on_an_absent_projects_dir() {
        let home = temp_home();
        let roots = vec![home.path().join("projects")]; // never created
        assert_eq!(
            locate_transcript_checked(&roots, "11111111-1111-4111-8111-111111111111").unwrap(),
            None
        );
    }

    #[test]
    fn locate_transcript_checked_finds_the_subagent_child_layout() {
        // Node layout pass 2 (`claude-transcript-locator.ts:39-48`):
        // <projects>/<project-dir>/<parent-session>/subagents/<id>.jsonl.
        let home = temp_home();
        let projects = home.path().join("projects");
        let sub = projects
            .join("-repo-alpha")
            .join("99999999-9999-4999-8999-999999999999")
            .join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[projects], "22222222-2222-4222-8222-222222222222").unwrap(),
            Some(file)
        );
    }

    #[test]
    fn locate_transcript_checked_treats_a_file_project_entry_as_a_miss_enotdir_parity() {
        // Node reports ENOTDIR as a normal miss (`claude-transcript-locator
        // .ts:33-37`): a candidate path whose component is a REGULAR FILE
        // (descending into it fails NotADirectory) yields Ok(None), not Err.
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::write(projects.join("-not-a-dir"), "i am a file\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[projects], "33333333-3333-4333-8333-333333333333").unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn locate_transcript_checked_propagates_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home();
        let projects = home.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root / CAP_DAC_OVERRIDE bypasses mode bits — probe first.
        if std::fs::read_dir(&projects).is_ok() {
            std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let err = locate_transcript_checked(
            std::slice::from_ref(&projects),
            "44444444-4444-4444-8444-444444444444",
        )
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        // Restore so TempDir cleanup works.
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn locate_transcript_checked_probes_direct_across_all_roots_before_any_subagent() {
        // Node's GLOBAL two-pass order (`claude-transcript-locator.ts:69-88`):
        // with roots [A, B], a DIRECT hit in B outranks a SUBAGENT hit in A —
        // NOT per-root direct+subagent.
        let home = temp_home();
        let root_a = home.path().join("a-projects");
        let root_b = home.path().join("b-projects");
        let id = "55555555-5555-4555-8555-555555555555";
        let sub = root_a
            .join("-repo")
            .join("88888888-8888-4888-8888-888888888888")
            .join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join(format!("{id}.jsonl")), "{}\n").unwrap();
        let direct_dir = root_b.join("-repo");
        std::fs::create_dir_all(&direct_dir).unwrap();
        let direct = direct_dir.join(format!("{id}.jsonl"));
        std::fs::write(&direct, "{}\n").unwrap();
        assert_eq!(
            locate_transcript_checked(&[root_a, root_b], id).unwrap(),
            Some(direct)
        );
    }

    #[test]
    fn transcript_cwd_checked_is_bounded_to_the_64kib_prefix() {
        // Node parity (`CWD_SCAN_BYTES`, `claude-transcript-locator.ts:30-31,
        // 131-135`): a cwd line starting beyond the first 64 KiB is invisible.
        let home = temp_home();
        let file = home.path().join("big.jsonl");
        let filler_line = "{\"type\":\"noise\"}\n";
        let mut content = String::new();
        while content.len() <= 64 * 1024 {
            content.push_str(filler_line);
        }
        content.push_str("{\"type\":\"user\",\"cwd\":\"/beyond/prefix\"}\n");
        std::fs::write(&file, &content).unwrap();
        assert_eq!(transcript_cwd_checked(&file).unwrap(), None);
        // A COMPLETE final line with no trailing newline still parses — Node's
        // `head.split('\n')` loop has no discard-the-tail rule.
        let small = home.path().join("small.jsonl");
        std::fs::write(
            &small,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\"}",
        )
        .unwrap();
        assert_eq!(
            transcript_cwd_checked(&small).unwrap(),
            Some("/home/user/proj".to_string())
        );
    }

    #[test]
    fn transcript_cwd_checked_treats_a_raced_deletion_as_a_cwdless_hit() {
        // Expected-absence open error ⇒ Ok(None): the locate hit survives,
        // cwd-less — Node behaves the same (`claude-transcript-locator.ts:
        // 121-129`).
        let home = temp_home();
        assert_eq!(
            transcript_cwd_checked(&home.path().join("absent.jsonl")).unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn transcript_cwd_checked_propagates_a_permission_denied_open() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home();
        let file = home.path().join("locked.jsonl");
        std::fs::write(&file, "{\"cwd\":\"/x\"}\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&file).is_ok() {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let err = transcript_cwd_checked(&file).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    const SAMPLE_TRANSCRIPT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-transcript-sample.jsonl"
    ));
    const GOLDEN_SNAPSHOT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-snapshot-golden.json"
    ));

    #[test]
    fn builder_output_matches_the_golden_snapshot_fixture() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
        );
        let golden: serde_json::Value =
            serde_json::from_str(GOLDEN_SNAPSHOT).expect("golden parses");
        assert_eq!(built, golden);
    }

    #[test]
    fn claude_turns_tag_every_summary_echo() {
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
        let turns = built["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 6);
        for turn in turns {
            assert_eq!(
                turn["summaryKind"],
                json!("echo"),
                "turn {:?}",
                turn["turnId"]
            );
        }
    }

    #[test]
    fn summarize_unifies_truncation_and_tool_result_labels() {
        let long_text = "x".repeat(200);
        let items = vec![json!({ "kind": "text", "text": long_text })];
        assert_eq!(summarize(&items).chars().count(), 140);

        let ok = vec![json!({ "kind": "tool_result", "content": "out", "isError": false })];
        assert_eq!(summarize(&ok), "Tool result");
        let err = vec![json!({ "kind": "tool_result", "content": "boom", "isError": true })];
        assert_eq!(summarize(&err), "Tool error");

        // Tool names count as summaries: a >140-char tool_use name truncates
        // through the same shared policy (fresh-eyes round 1, Finding 2 — this is
        // the arm a `return name.to_string()` would bypass).
        let long_name = "mcp__server__".to_string() + &"n".repeat(200);
        let tools = vec![json!({ "kind": "tool_use", "name": long_name.clone() })];
        let expected: String = long_name.chars().take(140).collect();
        assert_eq!(summarize(&tools), expected);
    }

    #[test]
    fn claude_zero_item_messages_are_dropped_before_summarizing() {
        // Preservation pin (passes immediately — it guards an EXISTING invariant,
        // see Step 2): `summarize`'s final fallback is the non-blank literal
        // "[claude turn]", so the `if items.is_empty() { continue; }` guard ahead
        // of it is the only thing keeping zero-item non-blank-summary turns
        // unreachable (load-bearing validation LB-4). A message whose blocks are
        // all unrecognized yields no items and must emit NO turn at all.
        let transcript: &str = concat!(
            r#"{"type":"assistant","message":{"content":[{"type":"future_block","data":"x"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"msg_ok","content":[{"type":"text","text":"real answer"}]}}"#,
            "\n",
        );
        let built = build_claude_snapshot_json("freshclaude", "t", transcript, 0);
        let turns = built["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["summary"], json!("real answer"));
        assert!(turns
            .iter()
            .all(|turn| !turn["items"].as_array().unwrap().is_empty()));
    }

    /// Task 3 (presence-of-pending gate, `normalize.ts:226-232`): an EMPTY overlay must
    /// leave the disk-built snapshot untouched — the reload-while-idle read keeps the
    /// exact golden shape (the route's byte-identical guarantee, pinned at unit level).
    #[test]
    fn pending_overlay_with_empty_sets_leaves_the_snapshot_unchanged() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
        );
        let mut overlaid = built.clone();
        apply_pending_overlay(&mut overlaid, Vec::new(), Vec::new());
        assert_eq!(overlaid, built, "an empty overlay is a strict no-op");
    }

    /// Task 3: a non-empty overlay populates `pendingApprovals`/`pendingQuestions` and
    /// flips the presence-of-pending gates; untouched capabilities/fields stay put.
    #[test]
    fn pending_overlay_populates_entries_and_flips_the_presence_gates() {
        let mut built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 7);
        let approvals = vec![json!({
            "requestId": "req-1", "toolName": "Bash", "toolUseID": "toolu_1",
            "input": { "command": "ls" },
        })];
        let questions = vec![json!({
            "requestId": "q-1", "questions": [{ "question": "Continue?" }],
        })];
        apply_pending_overlay(&mut built, approvals.clone(), questions.clone());
        assert_eq!(built["pendingApprovals"], json!(approvals));
        assert_eq!(built["pendingQuestions"], json!(questions));
        assert_eq!(built["capabilities"]["approvals"], json!(true));
        assert_eq!(built["capabilities"]["questions"], json!(true));
        // Untouched gates and fields.
        assert_eq!(built["capabilities"]["send"], json!(true));
        assert_eq!(built["capabilities"]["interrupt"], json!(true));
        assert_eq!(built["capabilities"]["fork"], json!(false));
        assert_eq!(built["sessionType"], json!("freshclaude"));
        assert_eq!(built["revision"], json!(7));
    }

    /// Task 3: the two gates track their own pending kind independently — approvals
    /// pending with NO questions leaves `capabilities.questions` false.
    #[test]
    fn pending_overlay_gates_track_each_pending_kind_independently() {
        let mut built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0);
        apply_pending_overlay(&mut built, vec![json!({ "requestId": "r-2" })], Vec::new());
        assert_eq!(built["pendingApprovals"], json!([{ "requestId": "r-2" }]));
        assert!(built["pendingQuestions"].as_array().unwrap().is_empty());
        assert_eq!(built["capabilities"]["approvals"], json!(true));
        assert_eq!(built["capabilities"]["questions"], json!(false));
    }

    #[test]
    fn user_turns_carry_role_user_and_literal_prompt_text() {
        // Load-bearing for the frozen client's local-echo clearing: claude's
        // send.accepted has no submittedTurnId, so the client matches prompt text
        // against role:'user' turns (freshAgentSlice fold).
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
        let turns = built["turns"].as_array().unwrap();
        let first = &turns[0];
        assert_eq!(first["role"], "user");
        assert_eq!(first["items"][0]["kind"], "text");
        assert_eq!(first["items"][0]["text"], "first question");
    }

    #[test]
    fn turn_ids_are_unique_and_ordering_is_transcript_order() {
        let built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0);
        assert_eq!(built["sessionType"], "kilroy");
        let turns = built["turns"].as_array().unwrap();
        let mut ids: Vec<&str> = turns
            .iter()
            .map(|t| t["turnId"].as_str().unwrap())
            .collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(
            ids.len(),
            before,
            "turnIds must be unique (historyBodies map key)"
        );
        assert_eq!(turns.len(), 6); // summary + malformed + isMeta lines skipped
        assert_eq!(built["latestTurnId"], turns[5]["turnId"]);
        // The dominant real prompt shape (object-with-string-content, ledger A5)
        // must yield a text turn -- local-echo clearing depends on it.
        assert_eq!(turns[3]["items"][0]["text"], "cli string content question");
    }

    /// Saves the named env vars on construction and restores them on drop (so the
    /// restore also runs on panic while the caller still holds `CLAUDE_ENV_LOCK` --
    /// locals drop in reverse declaration order, lock guard last).
    struct EnvVarsRestore {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl EnvVarsRestore {
        fn remove_all(keys: &[&'static str]) -> Self {
            let saved = keys
                .iter()
                .map(|k| {
                    let v = std::env::var(k).ok();
                    std::env::remove_var(k);
                    (*k, v)
                })
                .collect();
            Self { saved }
        }
    }
    impl Drop for EnvVarsRestore {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(v) => std::env::set_var(k, v),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    #[tokio::test]
    async fn snapshot_with_no_resolvable_store_root_is_io_not_notfound() {
        // Cannot check => must not deny: with every store-root env var unset the
        // server cannot assert the session is gone, so the error must be Io (-> 500),
        // never NotFound (-> 404 FRESH_AGENT_LOST_SESSION). Env vars are
        // process-global -- serialize under the shared claude env lock.
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let _restore = EnvVarsRestore::remove_all(&["CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "HOME"]);
        assert!(claude_home_candidates().is_empty());
        let result =
            get_claude_snapshot("freshclaude", "55555555-5555-4555-8555-555555555555").await;
        match result {
            Err(ClaudeSnapshotError::Io(msg)) => {
                assert!(msg.contains("no claude store root resolvable"), "{msg}");
            }
            other => panic!("expected Io (cannot-check must not deny), got {other:?}"),
        }
    }
}

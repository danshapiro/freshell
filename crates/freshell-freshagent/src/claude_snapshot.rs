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
        let line_uuid = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        // kata 1wxv: real message uuids are the rollback-addressable turn identity;
        // the synthetic {thread}:{ordinal} stays as the fallback for uuid-less lines.
        let turn_id = line_uuid
            .map(str::to_string)
            .unwrap_or_else(|| format!("{thread_id}:{ordinal}"));
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

// ── kata 1wxv Task 4: raw parentUuid-chain math (rollback resume math) ────────
//
// Stage-2-verified SDK semantics (the fork-at-point contract):
// * `resumeSessionAt` keeps messages up to AND INCLUDING the named uuid along
//   the RAW parentUuid chain — including lines the display parser filters out
//   (tool_result carriers, sidechain/meta lines, structured_output carriers).
//   Chain POSITION is therefore always computed over the raw links; display
//   filtering applies ONLY to the removed-turns PROJECTION.
// * Transcript matching for LCP/markers compares `uuid` + `message` content
//   ONLY, skips fork bookend line kinds (`mode`, `atis-latch`,
//   `queue-operation`, `last-prompt`), and never compares sessionId/entrypoint/
//   gitBranch/promptId (a fork rewrites those on the kept prefix lines).
// * The child preserves original uuid/parentUuid for prefix lines (the LCP and
//   marker math rely on it).

/// One parsed chain carrier: uuid + raw parent link + the whole line value.
#[derive(Clone)]
struct ChainLine {
    uuid: String,
    parent: Option<String>,
    obj: Value,
}

/// Fork header/tail line kinds (Stage-2 verified): they bookend a fork's
/// transcript and never carry conversation truth — skipped for chain membership,
/// tip, and LCP matching.
const FORK_BOOKEND_KINDS: [&str; 4] = ["mode", "atis-latch", "queue-operation", "last-prompt"];

/// Parse every uuid-bearing line (skipping fork bookend kinds), in file order.
fn parse_chain_candidates(transcript: &str) -> Vec<ChainLine> {
    let mut out = Vec::new();
    for line in transcript.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(uuid) = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        if FORK_BOOKEND_KINDS.contains(&kind) {
            continue;
        }
        let parent = obj
            .get("parentUuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        out.push(ChainLine {
            uuid: uuid.to_string(),
            parent,
            obj,
        });
    }
    out
}

/// The raw parentUuid chain, root→tip: start at the LAST candidate line in file
/// order (claude appends — the tail is the live tip) and walk parentUuid links
/// to the root. Lines whose parent link dangles (relink/compaction edges) end
/// the walk — the observable chain of the LIVE conversation; orphan branches
/// never enter it.
fn raw_chain(transcript: &str) -> Vec<ChainLine> {
    let candidates = parse_chain_candidates(transcript);
    let Some(mut cur) = candidates.last().map(|l| l.uuid.clone()) else {
        return Vec::new();
    };
    let by_uuid: std::collections::HashMap<&str, &ChainLine> =
        candidates.iter().map(|l| (l.uuid.as_str(), l)).collect();
    let mut reversed = Vec::new();
    let mut seen = std::collections::HashSet::new(); // defensive against a relinked cycle
    while let Some(line) = by_uuid.get(cur.as_str()) {
        if !seen.insert(line.uuid.clone()) {
            break;
        }
        reversed.push((*line).clone());
        match &line.parent {
            Some(p) => cur = p.clone(),
            None => break,
        }
    }
    reversed.reverse();
    reversed
}

/// The last uuid of the raw parentUuid chain (the "chain tip") — the redo
/// contract's recorded anchor (`original_tip_uuid`). `None` when the transcript
/// carries no chain lines at all (e.g. the fresh conversation after a first-turn
/// undo — the r2 empty-tip leg).
pub(crate) fn raw_chain_tip(transcript: &str) -> Option<String> {
    raw_chain(transcript).last().map(|l| l.uuid.clone())
}

/// Chain-entry equality for LCP: `uuid` + `message` content ONLY (never
/// sessionId/entrypoint/gitBranch/promptId — a fork rewrites those metadata
/// fields on the kept prefix lines).
fn chain_entries_match(a: &ChainLine, b: &ChainLine) -> bool {
    a.uuid == b.uuid && a.obj.get("message") == b.obj.get("message")
}

/// The uuid ending the common raw-chain prefix of `current` and `original`
/// (`None` when nothing matches — the vacuous empty-current case). The redo
/// validity contract requires this to equal `raw_chain_tip(current)`: the
/// current chain must still be a strict prefix of the chain-root original.
pub(crate) fn raw_lcp_end(current: &str, original: &str) -> Option<String> {
    let cur = raw_chain(current);
    let orig = raw_chain(original);
    let mut end = None;
    for (c, o) in cur.iter().zip(orig.iter()) {
        if !chain_entries_match(c, o) {
            break;
        }
        end = Some(c.uuid.clone());
    }
    end
}

/// The first raw-chain entry strictly AFTER `uuid` — the source of the
/// `resumeDropsTurn` guard (the uuid of the first message the resume discards).
/// `None` when `uuid` is the tip or absent: the guard is then OMITTED (a
/// vacuous discard — never fabricated).
pub(crate) fn raw_chain_successor(transcript: &str, uuid: &str) -> Option<String> {
    let chain = raw_chain(transcript);
    let pos = chain.iter().position(|l| l.uuid == uuid)?;
    chain.get(pos + 1).map(|l| l.uuid.clone())
}

/// A user-ANCHOR line: a real user prompt (type `user`, not meta/sidechain,
/// text-bearing content). A tool_result carrier is NEVER an anchor — steps
/// split at prompts only.
fn is_user_anchor(obj: &Value) -> bool {
    if obj.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if [
        "isMeta",
        "isSidechain",
        "isCompactSummary",
        "isVisibleInTranscriptOnly",
    ]
    .iter()
    .any(|k| obj.get(*k).and_then(Value::as_bool) == Some(true))
    {
        return false;
    }
    match obj.get("message") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Object(m)) => match m.get("content") {
            Some(Value::String(text)) => !text.trim().is_empty(),
            Some(Value::Array(blocks)) => blocks.iter().any(|b| {
                b.get("type").and_then(Value::as_str) == Some("text")
                    && b.get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|t| !t.trim().is_empty())
            }),
            _ => false,
        },
        _ => false,
    }
}

/// The anchor line's plain prompt text (the composer-refill payload): a plain
/// string message, a `{content: "string"}`, or its text blocks joined.
fn user_prompt_text(obj: &Value) -> String {
    match obj.get("message") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(m)) => match m.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Chain positions of every user-anchor line, in chain order (the step starts).
fn user_anchor_positions(chain: &[ChainLine]) -> Vec<usize> {
    chain
        .iter()
        .enumerate()
        .filter_map(|(i, l)| is_user_anchor(&l.obj).then_some(i))
        .collect()
}

/// The chain position that ENDS the step starting at `anchors[step_idx]` —
/// the last entry before the next step's anchor (or the tip).
fn step_group_end(chain_len: usize, anchors: &[usize], step_idx: usize) -> usize {
    anchors
        .get(step_idx + 1)
        .map(|next| next.saturating_sub(1))
        .unwrap_or(chain_len.saturating_sub(1))
}

/// The rollback target: one turn-step (`Step`) or "undo to here" (`ToTurn`,
/// carrying the addressed turn id).
pub(crate) enum ResumeTarget {
    Step,
    ToTurn(String),
}

/// One resolved rollback: where the fork keeps (`resume_at_uuid`; `None` =
/// "before the first message" — LEGAL per r2: the handler takes the
/// fresh-conversation leg, never a refusal), the removed display-turn slice
/// (the marker bucket + ack payload), and the composer-refill prompt.
/// `guard_uuid` is the `resumeDropsTurn` guard sourced from the RAW chain entry
/// at the first removed position (SDK-exact + cheaper than the display
/// projection — task 4 review nit 4); `None` on the first-turn leg (no fork →
/// no guard is ever armed).
pub(crate) struct ResumePoint {
    pub resume_at_uuid: Option<String>,
    pub removed_turns: Vec<Value>,
    pub prompt_text: String,
    pub guard_uuid: Option<String>,
}

#[derive(Debug)]
pub(crate) enum ResumeResolveError {
    /// No chain lines / no user step — nothing to roll back.
    Empty,
    /// The addressed turn id (or a pre-first-anchor chain member) is not in
    /// this conversation.
    TargetNotFound,
}

/// Resolve the rollback fork point over the RAW parentUuid chain (correction
/// item 3: the display-predecessor variant is VOID — display filtering applies
/// only to the removed-turns projection). A STEP is one user-anchor line plus
/// every raw line until the next user anchor, in raw-chain order; `Step` picks
/// the last step, `ToTurn` the step containing (or starting at) the addressed
/// uuid — an addressed ASSISTANT uuid maps to its owning user step (the last
/// user anchor at-or-before it along the chain).
pub(crate) fn resolve_resume_point(
    transcript: &str,
    thread_id: &str,
    target: ResumeTarget,
) -> Result<ResumePoint, ResumeResolveError> {
    let chain = raw_chain(transcript);
    if chain.is_empty() {
        return Err(ResumeResolveError::Empty);
    }
    let anchors = user_anchor_positions(&chain);
    if anchors.is_empty() {
        return Err(ResumeResolveError::Empty);
    }
    let first_remove_pos = match target {
        ResumeTarget::Step => *anchors.last().expect("anchors non-empty"),
        ResumeTarget::ToTurn(id) => {
            let pos = chain
                .iter()
                .position(|l| l.uuid == id)
                .ok_or(ResumeResolveError::TargetNotFound)?;
            // The owning user step: the last user anchor AT-OR-BEFORE pos.
            anchors
                .iter()
                .rev()
                .find(|&&a| a <= pos)
                .copied()
                .ok_or(ResumeResolveError::TargetNotFound)?
        }
    };
    // The keep point is the step first line's raw-chain predecessor — `None`
    // when the step IS the chain head ("BEFORE THE FIRST MESSAGE", legal per r2).
    // predecessor == the raw parentUuid of the first-to-remove line, by
    // construction of the chain walk.
    let resume_at_uuid = if first_remove_pos == 0 {
        None
    } else {
        Some(chain[first_remove_pos - 1].uuid.clone())
    };
    // The removed slice's DISPLAY projection (display filtering applies HERE).
    let removed_uuids: std::collections::HashSet<&str> = chain[first_remove_pos..]
        .iter()
        .map(|l| l.uuid.as_str())
        .collect();
    let removed_turns: Vec<Value> = parse_transcript_turns(thread_id, transcript)
        .into_iter()
        .filter(|t| {
            t.get("turnId")
                .and_then(Value::as_str)
                .is_some_and(|id| removed_uuids.contains(id))
        })
        .collect();
    let prompt_text = user_prompt_text(&chain[first_remove_pos].obj);
    // The resumeDropsTurn guard = the RAW chain entry at the first removed
    // position (task 4 review nit 4: SDK-exact + cheaper than re-deriving it
    // from the first removed DISPLAY turn — the projection filters carriers).
    // Omitted on the first-turn leg (`resume_at_uuid: None` = the fresh
    // conversation — no fork, so no guard is ever armed).
    let guard_uuid = resume_at_uuid
        .as_ref()
        .map(|_| chain[first_remove_pos].uuid.clone());
    Ok(ResumePoint {
        resume_at_uuid,
        removed_turns,
        prompt_text,
        guard_uuid,
    })
}

/// The restored slice's display turns + the composer-refill prompt: the display
/// projection of the original's chain range strictly-after-the-current-prefix
/// through `resume_at` (inclusive), with the prompt of the first restored step.
pub(crate) struct RestoredSlice {
    pub turns: Vec<Value>,
    pub prompt_text: String,
}

pub(crate) fn restored_slice_turns(
    original: &str,
    current: &str,
    resume_at: &str,
) -> RestoredSlice {
    let orig = raw_chain(original);
    let cur = raw_chain(current);
    let Some(end_pos) = orig.iter().position(|l| l.uuid == resume_at) else {
        return RestoredSlice {
            turns: Vec::new(),
            prompt_text: String::new(),
        };
    };
    // `current` is a validated PREFIX of the original (the tip+LCP contract),
    // so the restored range starts exactly at cur.len().
    let start_pos = cur.len();
    if start_pos > end_pos {
        return RestoredSlice {
            turns: Vec::new(),
            prompt_text: String::new(),
        };
    }
    let slice_uuids: std::collections::HashSet<&str> = orig[start_pos..=end_pos]
        .iter()
        .map(|l| l.uuid.as_str())
        .collect();
    let turns: Vec<Value> = parse_transcript_turns("", original)
        .into_iter()
        .filter(|t| {
            t.get("turnId")
                .and_then(Value::as_str)
                .is_some_and(|id| slice_uuids.contains(id))
        })
        .collect();
    let anchors = user_anchor_positions(&orig);
    let prompt_text = anchors
        .iter()
        .find(|&&a| a >= start_pos && a <= end_pos)
        .map(|&a| user_prompt_text(&orig[a].obj))
        .unwrap_or_default();
    RestoredSlice { turns, prompt_text }
}

/// The redo resume point (r3 boundary rule): the LAST raw-chain uuid of the
/// step being restored — its assistant tail — never the next turn's first uuid
/// (`resumeSessionAt` keeps through-AND-including the named uuid; resuming at
/// the step's OWN first uuid would restore only the bare prompt, breaking
/// undo↔redo invertibility).
///
/// `Ok(Some(uuid))` — resume at this uuid. `Ok(None)` — nothing to redo (the
/// kept prefix already reaches the original's tip). `Err(msg)` — a toTurn
/// target that is unknown to the original or already inside the kept prefix.
pub(crate) fn redo_resume_target(
    original: &str,
    current: &str,
    op: &crate::rollback_record::RollbackRequest,
) -> Result<Option<String>, String> {
    use crate::rollback_record::RollbackModeReq;
    let orig = raw_chain(original);
    let cur = raw_chain(current);
    let anchors = user_anchor_positions(&orig);
    match op.mode {
        RollbackModeReq::Step => match cur.last() {
            // r2 first-turn case: the current chain is EMPTY; restore the first
            // step's whole group (its end = the LAST uuid of that group — a1
            // for u1/a1, NEVER the first user anchor u1).
            None => {
                if anchors.is_empty() {
                    return Ok(None);
                }
                let end = step_group_end(orig.len(), &anchors, 0);
                Ok(Some(orig[end].uuid.clone()))
            }
            Some(tip) => {
                let pos = orig
                    .iter()
                    .position(|l| l.uuid == tip.uuid)
                    .ok_or_else(|| "the current chain diverged from the original".to_string())?;
                if pos + 1 >= orig.len() {
                    return Ok(None); // prefix == original: nothing to redo
                }
                // The step CONTAINING the next chain entry (post-fork, pos+1
                // is exactly the removed step's anchor; the general lookup
                // keeps this honest for LCP-shortened prefixes too).
                let step_idx = anchors
                    .iter()
                    .rposition(|&a| a <= pos + 1)
                    .ok_or_else(|| "no user step lies beyond the kept prefix".to_string())?;
                let end = step_group_end(orig.len(), &anchors, step_idx);
                Ok(Some(orig[end].uuid.clone()))
            }
        },
        RollbackModeReq::ToTurn => {
            let id = op
                .turn_id
                .as_deref()
                .ok_or_else(|| "redo toTurn requires a turnId".to_string())?;
            let pos = orig
                .iter()
                .position(|l| l.uuid == id)
                .ok_or_else(|| format!("turn {id:?} is not in the original conversation"))?;
            let step_idx = anchors
                .iter()
                .rposition(|&a| a <= pos)
                .ok_or_else(|| format!("turn {id:?} is not in any user step"))?;
            let end = step_group_end(orig.len(), &anchors, step_idx);
            if end < cur.len() {
                return Err(format!(
                    "turn {id:?} already lies inside the kept prefix — nothing to restore"
                ));
            }
            Ok(Some(orig[end].uuid.clone()))
        }
    }
}

/// The canRedo chain-root RECHECK (kata 1wxv Task 5): the stored bit is a
/// necessary but NOT sufficient condition — the CURRENT-epoch redo state comes
/// from the chain root, so when `original_session_id` resolves, the original's
/// raw-chain tip is RE-READ at snapshot time and must equal the recorded tip;
/// a moved tip (or a compacted/GC'd/unreadable original, or a mismatching
/// recorded tip) forces `canRedo:false` so no device shows a redo that Task 4
/// would refuse with `REDO_UNAVAILABLE` + `REDO_REMOVED_HISTORY_COPY`. A record
/// without an `original_session_id` keeps the stored bit as-is.
fn claude_can_redo_now(record: &crate::rollback_record::RollbackRecord) -> bool {
    if !record.can_redo() {
        return false;
    }
    let Some(original) = record.original_session_id.as_deref() else {
        return true;
    };
    let tip = locate_transcript(original)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| raw_chain_tip(&text));
    tip == record.original_tip_uuid
}

/// Build the `FreshAgentSnapshotSchema`-exact JSON (`shared/fresh-agent-contract.ts:230-246`,
/// zod `.strict()` -- every key here is either required or schema-known; NOTHING extra —
/// the kata 1wxv keys (`undo`/`redo`/`rolledBackTurns`/`rollback`/`rolledBack`) are
/// the schema's OPTIONAL additions).
pub(crate) fn build_claude_snapshot_json(
    session_type: &str,
    thread_id: &str,
    transcript: &str,
    revision: i64,
    // Kata 1wxv Task 5: the durable rollback record (None when the session never
    // rolled back through this server's ledger).
    rollback: Option<&crate::rollback_record::RollbackRecord>,
) -> Value {
    let turns = parse_transcript_turns(thread_id, transcript);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut snapshot = json!({
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
            // Kata 1wxv Task 5: STATIC stamps (freshclaude AND kilroy — no SDK
            // capability query exists); an old-CLI runtime failure classifies to
            // UNSUPPORTED_CAPABILITY refusal at op time, never at stamp time.
            "undo": true,
            "redo": true,
        },
        "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": [],
        "childThreads": [],
        "turns": turns,
        "extensions": {},
    });
    if let Some(record) = rollback {
        // The marker bucket is LEDGER-SOURCED (r3): the record's entries union —
        // frozen prior epochs first, then the current epoch's recorded slice —
        // durable even if an old original's JSONL is later compacted/GC'd
        // (decision 6's "persist marked"). `canRedo` is provider-adjudicated:
        // the stored bit AND the chain-root tip recheck. The record also doubles
        // as the revision floor: a stale transcript basis never lets the client's
        // monotonic watermark drop the post-rollback snapshot.
        let floored = crate::rollback_record::stamp_rollback_snapshot(
            &mut snapshot,
            revision.max(0),
            record,
            claude_can_redo_now(record),
        );
        snapshot["revision"] = json!(floored);
    }
    snapshot
}

/// Locate + read + build. `revision` = transcript mtime in ms (monotonic as the file
/// grows -- `mergeSnapshotForDisplay` DROPS revision regressions), fallback turn count;
/// kata 1wxv Task 5 floors it at the rollback record's `lastOpAtMs`.
pub(crate) async fn get_claude_snapshot(
    session_type: &str,
    thread_id: &str,
    rollback: Option<&crate::rollback_record::RollbackRecord>,
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
    let mut snapshot = build_claude_snapshot_json(session_type, thread_id, &content, 0, rollback);
    let turn_count = snapshot["turns"]
        .as_array()
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    let basis = mtime_ms.unwrap_or(turn_count).max(0);
    let floored = match rollback {
        Some(record) => basis.max(record.last_op_at_ms),
        None => basis,
    };
    snapshot["revision"] = json!(floored);
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
            None,
        );
        let golden: serde_json::Value =
            serde_json::from_str(GOLDEN_SNAPSHOT).expect("golden parses");
        assert_eq!(built, golden);
    }

    #[test]
    fn claude_turns_tag_every_summary_echo() {
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0, None);
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
        let built = build_claude_snapshot_json("freshclaude", "t", transcript, 0, None);
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
            None,
        );
        let mut overlaid = built.clone();
        apply_pending_overlay(&mut overlaid, Vec::new(), Vec::new());
        assert_eq!(overlaid, built, "an empty overlay is a strict no-op");
    }

    /// Task 3: a non-empty overlay populates `pendingApprovals`/`pendingQuestions` and
    /// flips the presence-of-pending gates; untouched capabilities/fields stay put.
    #[test]
    fn pending_overlay_populates_entries_and_flips_the_presence_gates() {
        let mut built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 7, None);
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
        let mut built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0, None);
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
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0, None);
        let turns = built["turns"].as_array().unwrap();
        let first = &turns[0];
        assert_eq!(first["role"], "user");
        assert_eq!(first["items"][0]["kind"], "text");
        assert_eq!(first["items"][0]["text"], "first question");
    }

    #[test]
    fn turn_ids_are_unique_and_ordering_is_transcript_order() {
        let built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0, None);
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
            get_claude_snapshot("freshclaude", "55555555-5555-4555-8555-555555555555", None).await;
        match result {
            Err(ClaudeSnapshotError::Io(msg)) => {
                assert!(msg.contains("no claude store root resolvable"), "{msg}");
            }
            other => panic!("expected Io (cannot-check must not deny), got {other:?}"),
        }
    }

    // ── kata 1wxv Task 4: resume-point math + real-uuid turn ids ────────────

    fn uuid_transcript() -> String {
        // user/assistant alternation, uuid + parentUuid chained:
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
    }

    /// A transcript WITH non-display chain carriers interleaved (a tool_result
    /// carrier and a sidechain/meta line both stay visible to the raw parentUuid
    /// chain but the display parser filters them out) — the display-predecessor
    /// rule is VOID per correction item 3 (chain position is raw, always).
    fn uuid_transcript_with_carriers() -> String {
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"c1","isSidechain":true,"parentUuid":"u1","timestamp":"t1b","message":{"role":"assistant","content":[{"type":"text","text":"sidechain noise"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"c1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"bash","input":{"command":"ls"}}]}}),
            json!({"type":"user","uuid":"tr1","parentUuid":"a1","timestamp":"t2b","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"files"}],"is_error":false}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"tr1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn turns_carry_real_message_uuids_when_present() {
        let turns = parse_transcript_turns("thread-x", &uuid_transcript());
        let ids: Vec<&str> = turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert!(
            ids.contains(&"u1")
                && ids.contains(&"a1")
                && ids.contains(&"u2")
                && ids.contains(&"a2"),
            "turn ids are the transcript uuids, not synthetic thread:ordinal ids: {ids:?}"
        );
    }

    /// Synthetic `{thread}:{ordinal}` ids remain the fallback for uuid-less lines
    /// (the pre-existing fixture corpus), so the turn-id change is additive.
    #[test]
    fn turns_fall_back_to_synthetic_ids_without_uuids() {
        let turns = parse_transcript_turns("thread-x", SAMPLE_TRANSCRIPT);
        let ids: Vec<&str> = turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert!(
            ids.iter().all(|id| id.starts_with("thread-x:")),
            "uuid-less lines keep the synthetic id shape: {ids:?}"
        );
    }

    #[test]
    fn resolve_resume_point_step_targets_the_last_user_step() {
        let point = resolve_resume_point(&uuid_transcript(), "thread-x", ResumeTarget::Step)
            .expect("resolves");
        assert_eq!(
            point.resume_at_uuid.as_deref(),
            Some("a1"),
            "keep everything before prompt two's group"
        );
        assert_eq!(point.prompt_text, "prompt two");
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(removed_ids, vec!["u2", "a2"]);
    }

    #[test]
    fn resolve_resume_point_at_the_first_message_resolves_before_the_first_message() {
        // r2: RESOLVABLE and legal — resume_at_uuid None means "before the first message";
        // the whole transcript becomes the removed slice and the handler takes the
        // fresh-conversation leg (no refusal exists).
        let point = resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("u1".into()),
        )
        .expect("resolves");
        assert_eq!(point.resume_at_uuid, None, "before the first message");
        assert_eq!(point.prompt_text, "prompt one");
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            removed_ids,
            vec!["u1", "a1", "u2", "a2"],
            "the entire transcript is the removed slice"
        );
    }

    #[test]
    fn resolve_resume_point_step_on_a_single_step_resolves_before_the_first_message() {
        let one_step = uuid_transcript()
            .lines()
            .take(2)
            .collect::<Vec<_>>()
            .join("\n"); // u1/a1 only
        let point =
            resolve_resume_point(&one_step, "thread-x", ResumeTarget::Step).expect("resolves");
        assert_eq!(
            point.resume_at_uuid, None,
            "step on a one-turn history empties the conversation — legal per r2"
        );
        assert_eq!(point.prompt_text, "prompt one");
    }

    #[test]
    fn resolve_resume_point_to_turn_middle_keeps_prefix() {
        let point = resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("u2".into()),
        )
        .expect("resolves");
        assert_eq!(point.resume_at_uuid.as_deref(), Some("a1"));
        assert_eq!(point.removed_turns.len(), 2);
    }

    /// Steps split on USER-ANCHOR lines only: a tool_result carrier must NOT
    /// start a step, and a sidechain line keeps chain position while never
    /// surfacing in the removed-turns projection (raw-chain rule everywhere).
    #[test]
    fn resolve_resume_point_walks_the_raw_chain_through_non_display_carriers() {
        let point = resolve_resume_point(
            &uuid_transcript_with_carriers(),
            "thread-x",
            ResumeTarget::Step,
        )
        .expect("resolves");
        assert_eq!(
            point.resume_at_uuid.as_deref(),
            Some("tr1"),
            "the keep point is the raw parent of u2 — the tool_result carrier, \
             which resumeSessionAt accepts (any chain uuid), even though the display list hides it"
        );
        let removed_ids: Vec<&str> = point
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            removed_ids,
            vec!["u2", "a2"],
            "only the display projection of the removed slice (no carriers/leaked sidechain noise)"
        );
        // toTurn(u2) maps identically; an addressed assistant uuid maps to its
        // owning user step (the first user anchor at-or-before it).
        let to_anchor = resolve_resume_point(
            &uuid_transcript_with_carriers(),
            "thread-x",
            ResumeTarget::ToTurn("a2".into()),
        )
        .expect("assistant target resolves to its owning user step");
        assert_eq!(to_anchor.resume_at_uuid.as_deref(), Some("tr1"));
        assert_eq!(to_anchor.prompt_text, "prompt two");
    }

    #[test]
    fn resolve_resume_point_unknown_target_is_not_found() {
        assert!(resolve_resume_point(
            &uuid_transcript(),
            "thread-x",
            ResumeTarget::ToTurn("nope".into())
        )
        .is_err());
    }

    #[test]
    fn resolve_resume_point_empty_transcript_is_empty() {
        assert!(matches!(
            resolve_resume_point("", "thread-x", ResumeTarget::Step),
            Err(ResumeResolveError::Empty)
        ));
    }

    #[test]
    fn raw_chain_tip_is_the_last_uuid_of_the_parent_chain() {
        assert_eq!(raw_chain_tip(&uuid_transcript()).as_deref(), Some("a2"));
        assert_eq!(
            raw_chain_tip(&uuid_transcript_with_carriers()).as_deref(),
            Some("a2")
        );
        assert_eq!(raw_chain_tip(""), None, "no chain lines => no tip");
    }

    #[test]
    fn raw_lcp_end_matches_on_uuid_and_message_only() {
        // The current session's fork retains the original's prefix uuids/messages
        // but rewrites sessionId/gitBranch/timestamps — those fields are NEVER
        // compared.
        let current = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":"new","gitBranch":"z","timestamp":"T1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"new","timestamp":"T2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(
            raw_lcp_end(&current, &uuid_transcript()).as_deref(),
            Some("a1")
        );
        // A message divergence truncates the LCP at the first differing entry.
        let edited = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"role":"assistant","content":[{"type":"text","text":"REWRITTEN"}]}}),
        ].iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(
            raw_lcp_end(&edited, &uuid_transcript()).as_deref(),
            Some("u1")
        );
        // An empty current has a vacuous common prefix (the whole-empty-prefix rule
        // the first-turn-undo redo leg depends on).
        assert_eq!(
            raw_lcp_end("", &uuid_transcript()),
            None,
            "no matched entries => None (vacuous)"
        );
    }

    // ── redo_resume_target / restored_slice_turns (r3 boundary rule: every
    // resume point is THE LAST UUID OF THE TARGET STEP'S RAW-CHAIN GROUP — its
    // assistant tail — never the next turn's first uuid) ─────────────────────

    fn two_step_original() -> String {
        uuid_transcript()
    }

    fn prefix_after_undo() -> String {
        // The post-undo current session: the u1/a1 prefix only (fork at a1).
        uuid_transcript()
            .lines()
            .take(2)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn step_op() -> crate::rollback_record::RollbackRequest {
        use crate::rollback_record::*;
        RollbackRequest {
            direction: RollbackDirection::Redo,
            mode: RollbackModeReq::Step,
            turn_id: None,
            session_id: "s".into(),
            session_type: freshell_protocol::SessionType::Freshclaude,
            provider: freshell_protocol::AgentProvider::Claude,
            request_id: "r".into(),
            cwd: None,
        }
    }

    #[test]
    fn redo_resume_target_step_from_a_prefix_grows_one_step_to_its_group_end() {
        let op = step_op();
        let uuid = redo_resume_target(&two_step_original(), &prefix_after_undo(), &op)
            .expect("resolves")
            .expect("a step exists beyond the prefix");
        assert_eq!(uuid, "a2", "redo restores through the restored step's OWN last uuid (r3) — not the next turn's first");
    }

    #[test]
    fn redo_resume_target_to_turn_resumes_at_the_addressed_groups_last_uuid() {
        let mut op = step_op();
        op.mode = crate::rollback_record::RollbackModeReq::ToTurn;
        op.turn_id = Some("u2".into());
        let uuid = redo_resume_target(&two_step_original(), &prefix_after_undo(), &op)
            .expect("resolves")
            .expect("target exists");
        assert_eq!(
            uuid, "a2",
            "toTurn(u2) keeps through a2 (the u2/a2 group end)"
        );
    }

    #[test]
    fn redo_resume_target_to_turn_on_an_unknown_uuid_errors() {
        let mut op = step_op();
        op.mode = crate::rollback_record::RollbackModeReq::ToTurn;
        op.turn_id = Some("nope".into());
        assert!(redo_resume_target(&two_step_original(), &prefix_after_undo(), &op).is_err());
    }

    #[test]
    fn redo_resume_target_with_prefix_equal_to_original_has_nothing_to_restore() {
        let op = step_op();
        assert_eq!(
            redo_resume_target(&two_step_original(), &two_step_original(), &op).expect("resolves"),
            None,
            "prefix == original => nothing to redo"
        );
    }

    #[test]
    fn redo_resume_target_on_an_empty_current_resumes_at_the_first_groups_end() {
        // r2 first-turn case: the fresh conversation's chain is EMPTY; redo
        // restores through the uuid ending the ORIGINAL's first step group —
        // its assistant tail (a1 for u1/a1), NEVER the first user-anchor uuid
        // u1 itself (that would restore only the bare prompt and make
        // undo/redo non-invertible).
        let op = step_op();
        let uuid = redo_resume_target(&two_step_original(), "", &op)
            .expect("resolves")
            .expect("a step exists");
        assert_eq!(uuid, "a1");
    }

    #[test]
    fn restored_slice_turns_projects_only_the_restored_range() {
        let slice = restored_slice_turns(&two_step_original(), &prefix_after_undo(), "a2");
        let ids: Vec<&str> = slice
            .turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["u2", "a2"]);
        assert_eq!(slice.prompt_text, "prompt two");
        // From an empty current (first-turn redo): the whole first group.
        let slice = restored_slice_turns(&two_step_original(), "", "a1");
        let ids: Vec<&str> = slice
            .turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["u1", "a1"]);
        assert_eq!(slice.prompt_text, "prompt one");
    }

    #[test]
    fn raw_chain_successor_names_the_first_entry_after_a_keep_point() {
        // The resumeDropsTurn guard uuid source: the first chain entry AFTER the
        // keep point (the first-to-discard prompt), None when the keep point IS
        // the tip (vacuous discard — the guard is omitted, never fabricated).
        assert_eq!(
            raw_chain_successor(&two_step_original(), "a1").as_deref(),
            Some("u2")
        );
        assert_eq!(raw_chain_successor(&two_step_original(), "a2"), None);
        assert_eq!(raw_chain_successor(&two_step_original(), "gone"), None);
    }

    // ── kata 1wxv Task 5: snapshot rollback surfacing (claude/kilroy) ─────────
    //
    // Stamps are STATIC `{undo:true, redo:true}` (runtime failure classifies at
    // op time, never at stamp time). The marker bucket is LEDGER-SOURCED (r3 —
    // the record's entries union, durable even if the original's JSONL is
    // later compacted/GC'd; the read-time LCP projection stays out of the
    // bucket path). `canRedo` is the stored bit AND the chain-root recheck:
    // when `original_session_id` resolves, the ORIGINAL's tip is re-read at
    // snapshot time — a moved tip forces `canRedo:false` so no device shows a
    // redo Task 4 would refuse with REDO_REMOVED_HISTORY_COPY.

    use crate::rollback_record::{RollbackEntry, RollbackRecord};

    /// The display projection of `ids` out of the canonical uuid transcript —
    /// the verbatim turn JSON a Task 4 undo records into the ledger.
    fn removed_slice_for(ids: &[&str]) -> Vec<Value> {
        parse_transcript_turns("x", &uuid_transcript())
            .into_iter()
            .filter(|t| {
                t.get("turnId")
                    .and_then(Value::as_str)
                    .map(|id| ids.contains(&id))
                    .unwrap_or(false)
            })
            .collect()
    }

    /// The canonical two-op record: original `orig-id` (tip `a2`), can_redo
    /// stored true, one entry over [u2, a2] (last op at ms 100).
    fn claude_rollback_record(orig_id: &str, removed_turns: Vec<Value>) -> RollbackRecord {
        let mut record = RollbackRecord::empty(50);
        record.original_session_id = Some(orig_id.to_string());
        record.original_tip_uuid = Some("a2".to_string());
        record.push_entry(
            RollbackEntry {
                removed_turns,
                prompt_text: "prompt two".into(),
                at_ms: 90,
                epoch: 0,
            },
            100,
        );
        record.set_can_redo(true, 100);
        record
    }

    /// Stage `<tmp>/projects/-p/{orig,cur}.jsonl` under CLAUDE_CONFIG_DIR and
    /// return (home guard, original id, current id) — env restored by the caller.
    fn stage_rollback_home(
        original_text: &str,
        current_text: &str,
    ) -> (tempfile::TempDir, String, String) {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p");
        std::fs::create_dir_all(&dir).unwrap();
        let orig = "orig-rb-1";
        let cur = "cur-rb-1";
        std::fs::write(dir.join(format!("{orig}.jsonl")), original_text).unwrap();
        std::fs::write(dir.join(format!("{cur}.jsonl")), current_text).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        (home, orig.to_string(), cur.to_string())
    }

    #[tokio::test]
    async fn claude_snapshot_surfaces_the_ledger_bucket_and_rechecks_the_original_tip() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        let prefix: Vec<&str> = snap["turns"]
            .as_array()
            .expect("turns")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            prefix,
            vec!["u1", "a1"],
            "turns[] is exactly what the model sees next"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["u2", "a2"],
            "the marker bucket is the ledger entries union"
        );
        assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] }),
            "undoneDepth is the USER-role step count of the bucket"
        );
        assert_eq!(
            snap["revision"],
            json!(100),
            "the record's lastOpAtMs is the revision floor (basis 7 loses)"
        );
    }

    #[tokio::test]
    async fn claude_snapshot_a_moved_original_tip_forces_can_redo_false() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        // The original transcript was EXTENDED past the recorded tip (a new turn
        // landed on the chain root after the undo).
        let extended = format!(
            "{}\n{}",
            uuid_transcript(),
            json!({"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt three"}]}})
        );
        let (_home, orig, cur) = stage_rollback_home(&extended, &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "the chain-root tip is re-READ at snapshot time — no device shows a redo Task 4 would refuse"
        );
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
    }

    #[tokio::test]
    async fn claude_snapshot_first_turn_undo_keeps_the_whole_bucket_and_can_redo() {
        // r2 first-turn leg: the current chain is EMPTY (fresh conversation);
        // entries carry ALL of [u1, a1, u2, a2] (recorded when the first-turn
        // undo ran).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), "");
        let record = claude_rollback_record(&orig, removed_slice_for(&["u1", "a1", "u2", "a2"]));
        let snap = build_claude_snapshot_json("freshclaude", &cur, "", 0, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(ids, vec!["u1", "a1", "u2", "a2"]);
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["u1", "u2"] }),
            "live tip none ⇒ the recorded original tip counts as strictly beyond (two user steps in the bucket)"
        );
        assert!(snap["turns"].as_array().expect("turns").is_empty());
    }

    #[tokio::test]
    async fn claude_snapshot_the_bucket_is_the_entries_union_across_epochs() {
        // r3: frozen PRIOR-epoch markers precede the current epoch's, both in
        // conversation order; markers persist marked (the original transcript is
        // NOT needed to keep them).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let prior_epoch = vec![
            json!({ "id": "o1", "turnId": "o1", "ordinal": 0, "source": "durable", "role": "user", "summary": "old prompt", "items": [{ "id": "o1-i0", "kind": "text", "text": "old prompt" }] }),
            json!({ "id": "o2", "turnId": "o2", "ordinal": 1, "source": "durable", "role": "assistant", "summary": "old answer", "items": [{ "id": "o2-i0", "kind": "text", "text": "old answer" }] }),
        ];
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        // F8 layout for a two-epoch record: the current-epoch entry carries the
        // bumped counter; the frozen prefix keeps its older epoch.
        record.current_epoch = 1;
        record.entries[0].epoch = 1;
        record.entries.insert(
            0,
            RollbackEntry {
                removed_turns: prior_epoch,
                prompt_text: "old prompt".into(),
                at_ms: 40,
                epoch: 0,
            },
        );
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        let ids: Vec<&str> = bucket.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["o1", "o2", "u2", "a2"],
            "frozen prior-epoch markers first (conversation order), then the current epoch's"
        );
        assert!(bucket.iter().all(|t| t["rolledBack"] == json!(true)));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["u2"] }),
            "undoneDepth counts USER turns across the whole union (o1, u2); F6: the frozen \
             prior-epoch user marker (o1) is NOT redoable — only the current epoch's tail is"
        );
    }

    #[tokio::test]
    async fn claude_snapshot_destroyed_redo_keeps_the_marked_bucket() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        record.destroy_redo(120); // decision 5: kills redo, NEVER the markers (decision 6)
        let snap =
            build_claude_snapshot_json("freshclaude", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] })
        );
        assert_eq!(
            snap["revision"],
            json!(120),
            "the destroy also lifts the floor"
        );
    }

    #[tokio::test]
    async fn kilroy_snapshot_stamps_identically_to_freshclaude() {
        // One assertion leg re-runs the whole fixture with session_type "kilroy"
        // (identical stamps — the SAME overlay/builder lane serves both).
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        let record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let snap =
            build_claude_snapshot_json("kilroy", &cur, &prefix_after_undo(), 7, Some(&record));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(snap["sessionType"], json!("kilroy"));
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] })
        );
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
    }

    #[test]
    fn claude_snapshot_without_a_record_stamps_static_caps_but_hides_the_rollback_keys() {
        let snap = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 7, None);
        // Stamps are static and presence-independent (rollback refusal is at op
        // time, never at stamp time).
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert!(snap.get("rolledBackTurns").is_none());
        assert!(snap.get("rollback").is_none());
        assert_eq!(snap["revision"], json!(7), "no floor without a record");
    }

    #[tokio::test]
    async fn get_claude_snapshot_floors_the_revision_at_the_record() {
        let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let (_home, orig, cur) = stage_rollback_home(&uuid_transcript(), &prefix_after_undo());
        // Re-key the record to the CURRENT id (the adoption leg's ledger move):
        // ops stamped an hour in the future, so the transcript's fresh mtime
        // ALWAYS loses — the floor is asserted deterministically end-to-end.
        let mut record = claude_rollback_record(&orig, removed_slice_for(&["u2", "a2"]));
        let far_future = crate::rollback_record::now_ms() + 3_600_000;
        record.set_can_redo(true, far_future);
        let snap = get_claude_snapshot("freshclaude", &cur, Some(&record))
            .await
            .expect("snapshot builds");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(snap["revision"], json!(far_future));
        assert_eq!(snap["rolledBackTurns"].as_array().expect("bucket").len(), 2);
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] })
        );
    }
}

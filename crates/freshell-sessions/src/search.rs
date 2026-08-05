//! SESSION-07: full-text / user-message search over provider session
//! transcripts.
//!
//! Ports `server/session-directory/file-search.ts` (`searchSessionFile`,
//! `extractSnippet`, `file-search.ts:1-94`) -- the `userMessages`/`fullText`
//! tiers of `GET /api/session-directory` (`SessionDirectoryQuerySchema.tier`,
//! `shared/read-models.ts:30`). The `title` tier (metadata-only: title,
//! summary, firstUserMessage) is unaffected and lives in
//! `crates/freshell-server/src/session_directory.rs::apply_title_search`.
//!
//! ## Scope (honest, faithful subset -- documented deviations)
//!
//! * **claude + codex + amplifier.** All three are providers whose
//!   [`IndexedSession::source_file`](crate::directory_index::IndexedSession)
//!   names a per-session transcript line-log this module scans. `opencode`
//!   is direct-listed from ONE sqlite db with no per-session file (and the
//!   reference's `opencodeProvider.parseEvent` returns `[]`), so it stays
//!   un-searchable at these tiers -- skipped WITHOUT consuming the caller's
//!   scan budget, exactly like the reference's `if (!sourceFile) continue` /
//!   `if (!provider) continue` (`service.ts:191-197`). Title-tier metadata
//!   search still covers every provider, opencode included.
//! * **Amplifier scan target: `transcript.jsonl`, not `metadata.json`
//!   (SPEC-over-REFERENCE, documented).** The reference points amplifier's
//!   `sourceFile` at `metadata.json` (`session-indexer.ts:1037`) -- a
//!   role-less metadata document its own `parseEvent` can never turn into a
//!   `message.user`/`message.assistant` event, so the original NEVER
//!   produces an amplifier message-body match. The SESSION-07 checklist
//!   ("search ... message bodies across all providers") is the spec and
//!   overrides that reference defect: `amplifier.rs` points `source_file`
//!   at the sibling `transcript.jsonl` (a killed-before-first-prompt
//!   session with no transcript keeps `None` and is skipped, same as the
//!   reference's missing-`sourceFile` skip), and the extraction below is a
//!   verbatim port of `amplifierProvider.parseEvent`'s message branches
//!   (`providers/amplifier.ts:273-322`).
//! * **Claude message-event shape.** The reference's `parseEvent`
//!   (`providers/claude.ts:636-676`) only recognizes `message.content` as an
//!   ARRAY of typed blocks (`event.message.content.filter(isTextContent)`).
//!   This port additionally accepts a plain string `content` (extracting it
//!   verbatim) -- the committed `real-corrupted.jsonl` fixture's `user` turn
//!   is exactly this shape (`{"type":"user","message":{"role":"user",
//!   "content":"Test session 1"}}`), matching the Anthropic SDK's
//!   `MessageParam.content: string | ContentBlockParam[]` union for simple
//!   single-turn text. This is a deliberate, documented widening (never
//!   drops a real match the original would have found), not independently
//!   differential-verified against a live original for this exact shape.
//! * **Codex message extraction.** `extractTextContent` (`providers/codex.ts`
//!   private helper) is reused verbatim
//!   (`crate::parse::codex::extract_text_content`, `pub(crate)`) -- codex
//!   `payload.content` is always the items-array shape, no widening needed.

use std::path::Path;

use serde_json::Value;

/// `SessionDirectoryQuerySchema.tier` (`shared/read-models.ts:30`), the two
/// file-content variants (`title` is handled entirely by
/// `session_directory.rs::apply_title_search`, never reaches this module).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSearchTier {
    /// Only `message.user` events (`searchSessionFile`'s
    /// `if (tier === 'userMessages' && event.type !== 'message.user') continue`,
    /// `file-search.ts:68`).
    UserMessages,
    /// Both `message.user` and `message.assistant` events.
    FullText,
}

/// `SessionFileSearchMatch` (`file-search.ts:6-10`), minus `provider` (the
/// caller already knows it -- this port's caller,
/// `session_directory.rs::apply_file_search`, annotates the owning
/// [`crate::directory_index::IndexedSession`]-derived item directly).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSearchMatch {
    /// `"userMessage"` | `"assistantMessage"` (`SessionDirectoryItem.matchedIn`,
    /// `shared/read-models.ts:48`).
    pub matched_in: &'static str,
    pub snippet: String,
}

/// `extractSnippet(text, query, contextLength = 50)` (`file-search.ts:12-27`).
/// Char-indexed (not byte-indexed) so multi-byte UTF-8 text never panics on
/// a mid-codepoint slice -- a faithful semantic equivalent of the reference's
/// UTF-16-code-unit `String.slice`.
pub fn extract_snippet(text: &str, query: &str, context_length: usize) -> String {
    let lower_text = text.to_lowercase();
    let lower_query = query.to_lowercase();
    let chars: Vec<char> = text.chars().collect();
    let lower_chars: Vec<char> = lower_text.chars().collect();
    let query_chars: Vec<char> = lower_query.chars().collect();

    let Some(index) = find_subslice(&lower_chars, &query_chars) else {
        return chars.iter().take(100).collect();
    };

    let start = index.saturating_sub(context_length);
    let end = (index + query_chars.len() + context_length).min(chars.len());

    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}

/// First index in `haystack` where `needle` occurs, `char`-wise. `needle`
/// empty never matches (mirrors `String.indexOf('')` returning `0` being
/// unreachable here -- callers always pass a non-empty trimmed query).
fn find_subslice(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&start| haystack[start..start + needle.len()] == *needle)
}

/// The two DISTINCT failure classes of a file-tier scan, mirroring the
/// caller-side split in the reference (`service.ts:208-217`): an I/O failure
/// degrades the page (`partialReason: 'io_error'`), while a CANCELLED scan
/// aborts the whole request -- the reference re-throws the abort error
/// (`service.ts:209-210`'s `if (input.signal?.aborted) throw error`) and the
/// route swallows it without writing a response
/// (`sessions-router.ts:128-131`). The distinction MUST survive to the
/// caller: collapsing `Cancelled` into the I/O arm would turn a superseded
/// query into a stale `partial` page.
#[derive(Debug)]
pub enum SearchFileError {
    /// `fs.read` failed (missing/unreadable file) -- the reference's
    /// per-session `catch { ... partialReason = 'io_error' }` path.
    Io(std::io::Error),
    /// The `should_cancel` probe fired -- the reference's
    /// `throw new Error('Session file search aborted')`
    /// (`file-search.ts:43,56`).
    Cancelled,
}

impl std::fmt::Display for SearchFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchFileError::Io(e) => write!(f, "session file search I/O error: {e}"),
            SearchFileError::Cancelled => write!(f, "Session file search aborted"),
        }
    }
}

impl std::error::Error for SearchFileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            SearchFileError::Io(e) => Some(e),
            SearchFileError::Cancelled => None,
        }
    }
}

/// `searchSessionFile(provider, filePath, query, tier, signal)`
/// (`file-search.ts:29-93`). The reference's `AbortSignal` is ported as the
/// `should_cancel` cooperative probe, consulted BEFORE the file is opened
/// (`file-search.ts:43`) and again per line (`file-search.ts:56`) so a
/// superseded query (the client aborted its fetch in favor of a newer one)
/// abandons the scan instead of running stale work to completion. Returns
/// `Ok(None)` for no match, [`SearchFileError::Io`] on a file I/O failure
/// (mirroring the reference's `partialReason: 'io_error'` path,
/// `service.ts:208-217`) -- an unsupported `provider` is `Ok(None)` (the
/// caller is expected to skip unsupported providers before ever calling
/// this, matching `service.ts:194-195`'s `if (!provider) continue`).
pub fn search_session_file(
    path: &Path,
    provider: &str,
    query: &str,
    tier: FileSearchTier,
    should_cancel: Option<&(dyn Fn() -> bool)>,
) -> Result<Option<FileSearchMatch>, SearchFileError> {
    if should_cancel.is_some_and(|probe| probe()) {
        return Err(SearchFileError::Cancelled);
    }
    let bytes = std::fs::read(path).map_err(SearchFileError::Io)?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let needle = query.to_lowercase();

    for raw_line in content.split('\n') {
        if should_cancel.is_some_and(|probe| probe()) {
            return Err(SearchFileError::Cancelled);
        }
        let line = raw_line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some((role, text)) = extract_message(provider, &obj) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        if tier == FileSearchTier::UserMessages && role != "user" {
            continue;
        }
        if text.to_lowercase().contains(&needle) {
            return Ok(Some(FileSearchMatch {
                matched_in: if role == "user" {
                    "userMessage"
                } else {
                    "assistantMessage"
                },
                snippet: extract_snippet(&text, query, 50),
            }));
        }
    }
    Ok(None)
}

/// Per-provider one-line-of-transcript -> `(role, text)` dispatch. `None`
/// means the line isn't a searchable user/assistant message event for this
/// provider (session-lifecycle/tool/system lines, or an unsupported
/// provider) -- never a parse error (those are filtered out by the caller
/// before this is reached).
fn extract_message(provider: &str, obj: &Value) -> Option<(&'static str, String)> {
    match provider {
        "claude" => extract_claude_message(obj),
        "codex" => extract_codex_message(obj),
        "amplifier" => extract_amplifier_message(obj),
        _ => None,
    }
}

/// `isMessageEvent(event)` + the `message.assistant`/`message.user` branch
/// of `parseEvent` (`providers/claude.ts:662-676`): top-level `type` is
/// `"user"` or `"assistant"`; `message.content` is filtered to `text`-typed
/// blocks, joined by `"\n"`, trimmed. Widened (documented above) to also
/// accept a plain string `content`.
fn extract_claude_message(obj: &Value) -> Option<(&'static str, String)> {
    let role: &'static str = match obj.get("type").and_then(Value::as_str)? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let content = obj.get("message")?.get("content")?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    Some((role, text.trim().to_string()))
}

/// The `response_item`/`message` branch of `parseEvent`
/// (`providers/codex.ts:538-548`): `payload.role` selects user/assistant,
/// `payload.content` runs through the SAME `extractTextContent` the meta
/// parser already uses (`crate::parse::codex::extract_text_content`).
fn extract_codex_message(obj: &Value) -> Option<(&'static str, String)> {
    if obj.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = obj.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let role: &'static str = if payload.get("role").and_then(Value::as_str) == Some("user") {
        "user"
    } else {
        "assistant"
    };
    let text = crate::parse::codex::extract_text_content(payload.get("content"));
    Some((role, text.trim().to_string()))
}

/// The `message.user`/`message.assistant` branches of
/// `amplifierProvider.parseEvent` (`providers/amplifier.ts:273-307`):
/// transcript lines are plain `{"role": ..., "content": ...}` objects. The
/// `tool`-role branch (`:309-322`) yields `tool.result` events, which the
/// reference's caller filter (`file-search.ts:67`) skips -- so this port
/// never surfaces them either.
fn extract_amplifier_message(obj: &Value) -> Option<(&'static str, String)> {
    match obj.get("role").and_then(Value::as_str)? {
        // `obj.role === 'user'` (:285-289): string `content` verbatim, else
        // the text parts joined -- BOTH arms end `.trim()`ed in the
        // reference's `message: { role: 'user', content: content.trim() }`.
        "user" => {
            let content = obj.get("content")?;
            let text = match content {
                Value::String(s) => s.clone(),
                other => extract_amplifier_text_parts(other).join("\n"),
            };
            Some(("user", text.trim().to_string()))
        }
        // `obj.role === 'assistant'` (:291-307): the joined visible text,
        // trimmed; an ALL-empty join emits NO `message.assistant` event in
        // the reference (`if (joined) { events.push(...) }`, :300-304).
        "assistant" => {
            let joined = extract_amplifier_text_parts(obj.get("content")?)
                .join("\n")
                .trim()
                .to_string();
            if joined.is_empty() {
                None
            } else {
                Some(("assistant", joined))
            }
        }
        _ => None,
    }
}

/// `extractAssistantParts(content).text` (`providers/amplifier.ts:33-58`),
/// the `reasoning` half discarded: a `thinking`-typed block with a non-empty
/// `thinking` string becomes a `reasoning` event in the reference, which the
/// caller filter (`file-search.ts:67`) never searches -- so thinking content
/// must NOT be searchable here either (a thinking-INCLUSIVE scan would leak
/// chain-of-thought the reference never leaked). The reference's else-if
/// chain makes the three arms mutually exclusive; a block fully matching the
/// thinking arm contributes NOTHING (its `text`, if any, is not pushed).
fn extract_amplifier_text_parts(content: &Value) -> Vec<String> {
    match content {
        // String content: pushed as-is when non-empty-after-trim
        // (`providers/amplifier.ts:41-42`), never itself trimmed.
        Value::String(s) if !s.trim().is_empty() => vec![s.clone()],
        Value::String(_) => Vec::new(),
        Value::Array(blocks) => blocks
            .iter()
            // `if (!block || typeof block !== 'object') continue` (:47).
            .filter(|b| b.is_object())
            // Arm 1 (:48-50): fully-matching thinking blocks exit the chain.
            .filter(|b| {
                !(b.get("type").and_then(Value::as_str) == Some("thinking")
                    && b.get("thinking")
                        .and_then(Value::as_str)
                        .is_some_and(|t| !t.trim().is_empty()))
            })
            // Arms 2+3 (:51-55): any surviving block with a non-empty
            // string `text` contributes it (type `text` or otherwise).
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .filter(|t| !t.trim().is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_snippet ──

    #[test]
    fn extract_snippet_no_match_returns_first_100_chars() {
        let text = "no query anywhere in this text at all, just filler content to pad it out past a hundred characters total length for sure";
        let snippet = extract_snippet(text, "zzz-absent", 50);
        assert_eq!(snippet, text.chars().take(100).collect::<String>());
    }

    #[test]
    fn extract_snippet_matches_case_insensitively_and_adds_ellipses_both_sides() {
        let text = "the quick brown fox jumps over the extremely lazy dog while everyone watches in silence";
        let snippet = extract_snippet(text, "EXTREMELY", 10);
        assert!(snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        assert!(snippet.to_lowercase().contains("extremely"));
    }

    #[test]
    fn extract_snippet_no_leading_ellipsis_when_match_at_start() {
        let text = "hello world, this is a longer sentence than the context window";
        let snippet = extract_snippet(text, "hello", 5);
        assert!(!snippet.starts_with("..."));
    }

    // ── SESSION-19: safe, bounded, isolated snippets ──

    /// Neighbor-secret isolation: text outside the bounded context window
    /// (`context_length` chars on either side of the match) must never leak
    /// into the snippet, even though it is part of the SAME message.
    #[test]
    fn extract_snippet_excludes_distant_neighbor_text_on_both_sides() {
        let text = format!(
            "SECRET-BEFORE-SENTINEL {}needle-match{} SECRET-AFTER-SENTINEL",
            "x".repeat(120),
            "x".repeat(120)
        );
        let snippet = extract_snippet(&text, "needle-match", 50);
        assert!(snippet.contains("needle-match"));
        assert!(snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        assert!(
            !snippet.contains("SECRET-BEFORE-SENTINEL"),
            "text before the context window must never leak into the snippet, got {snippet:?}"
        );
        assert!(
            !snippet.contains("SECRET-AFTER-SENTINEL"),
            "text after the context window must never leak into the snippet, got {snippet:?}"
        );
    }

    /// The snippet is plain DATA, not markup: HTML-special characters pass
    /// through un-escaped and un-stripped. Like the reference's
    /// `extractSnippet` (`file-search.ts:12-27`), this layer never
    /// transforms matched text -- escaping is the transport layer's job
    /// (JSON string encoding) plus the client rendering the snippet as
    /// text, so the server must neither HTML-encode nor strip tags.
    #[test]
    fn extract_snippet_html_markup_is_returned_verbatim_as_data() {
        let text = "intro <script>alert('xss')</script> html-needle <b>bold</b> outro";
        let snippet = extract_snippet(text, "html-needle", 50);
        assert_eq!(
            snippet, text,
            "a match whose context window spans the whole text returns it verbatim"
        );
        assert!(snippet.contains("<script>alert('xss')</script>"));
        assert!(
            !snippet.contains("&lt;") && !snippet.contains("&gt;"),
            "the server must not HTML-encode the snippet, got {snippet:?}"
        );
    }

    /// Control characters (ANSI escapes, U+2028, etc.) are char-indexed data:
    /// extraction never panics or splits mid-codepoint, stays within the
    /// `query + 2*context + two ellipses` bound, and -- once serialized by
    /// serde_json (the role `JSON.stringify` plays in the reference) -- the
    /// wire form carries no raw C0 control bytes and round-trips exactly.
    #[test]
    fn extract_snippet_control_characters_stay_bounded_and_json_escape_on_the_wire() {
        let text = format!(
            "\u{1b}[31m red \u{1b}[0m ctrl-needle\u{2028}{} TAIL-SECRET",
            "y".repeat(120)
        );
        let snippet = extract_snippet(&text, "ctrl-needle", 50);
        assert!(snippet.contains("ctrl-needle"));
        assert!(snippet.contains("\u{1b}[31m"), "control chars survive verbatim in the data");
        assert!(snippet.contains('\u{2028}'));
        assert!(!snippet.contains("TAIL-SECRET"));
        assert!(snippet.ends_with("..."));
        assert!(
            snippet.chars().count() <= "ctrl-needle".chars().count() + 2 * 50 + 2 * 3,
            "snippet must stay within query + 2*context + 2 ellipses, got {} chars",
            snippet.chars().count()
        );

        let wire = serde_json::to_string(&snippet).unwrap();
        assert!(
            !wire.chars().any(|c| (c as u32) < 0x20),
            "serialized wire form must contain no raw control bytes: {wire:?}"
        );
        assert!(wire.contains("\\u001b"), "ESC must be serialized as a \\u escape");
        let round: String = serde_json::from_str(&wire).unwrap();
        assert_eq!(round, snippet, "wire form must round-trip to the exact snippet");
    }

    // ── extract_claude_message ──

    #[test]
    fn claude_user_string_content_is_extracted_verbatim() {
        let obj: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":"Test session 1"}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_claude_message(&obj),
            Some(("user", "Test session 1".to_string()))
        );
    }

    #[test]
    fn claude_assistant_array_content_joins_text_blocks_only() {
        let obj: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[
                {"type":"thinking","thinking":"internal reasoning, not searchable"},
                {"type":"text","text":"visible reply one"},
                {"type":"text","text":"visible reply two"}
            ]}}"#,
        )
        .unwrap();
        let (role, text) = extract_claude_message(&obj).unwrap();
        assert_eq!(role, "assistant");
        assert_eq!(text, "visible reply one\nvisible reply two");
        assert!(!text.contains("internal reasoning"));
    }

    #[test]
    fn claude_non_message_type_is_none() {
        let obj: Value = serde_json::from_str(r#"{"type":"system","subtype":"init"}"#).unwrap();
        assert_eq!(extract_claude_message(&obj), None);
    }

    // ── extract_codex_message ──

    #[test]
    fn codex_response_item_message_extracts_role_and_text() {
        let obj: Value = serde_json::from_str(
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"a codex user turn"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            extract_codex_message(&obj),
            Some(("user", "a codex user turn".to_string()))
        );
    }

    #[test]
    fn codex_non_message_payload_is_none() {
        let obj: Value =
            serde_json::from_str(r#"{"type":"response_item","payload":{"type":"function_call"}}"#)
                .unwrap();
        assert_eq!(extract_codex_message(&obj), None);
    }

    // ── search_session_file ──

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "freshell-search-test-{}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4(),
            name
        ));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn user_messages_tier_ignores_assistant_only_matches() {
        let path = write_temp(
            "claude.jsonl",
            &format!(
                "{}\n{}\n",
                r#"{"type":"user","message":{"role":"user","content":"hello there"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"unique-assistant-only-phrase"}]}}"#,
            ),
        );
        let result = search_session_file(
            &path,
            "claude",
            "unique-assistant-only-phrase",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap();
        assert_eq!(
            result, None,
            "userMessages tier must not match assistant-only text"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn full_text_tier_matches_assistant_messages() {
        let path = write_temp(
            "claude2.jsonl",
            &format!(
                "{}\n{}\n",
                r#"{"type":"user","message":{"role":"user","content":"hello there"}}"#,
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"unique-assistant-only-phrase"}]}}"#,
            ),
        );
        let result = search_session_file(
            &path,
            "claude",
            "unique-assistant-only-phrase",
            FileSearchTier::FullText,
            None,
        )
        .unwrap();
        let m = result.expect("fullText tier must match assistant text");
        assert_eq!(m.matched_in, "assistantMessage");
        assert!(m.snippet.contains("unique-assistant-only-phrase"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn search_is_case_insensitive() {
        let path = write_temp(
            "claude3.jsonl",
            &format!(
                "{}\n",
                r#"{"type":"user","message":{"role":"user","content":"MixedCase Needle Value"}}"#,
            ),
        );
        let result = search_session_file(
            &path,
            "claude",
            "needle value",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap();
        let m = result.expect("case-insensitive match");
        assert_eq!(m.matched_in, "userMessage");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn no_match_returns_none() {
        let path = write_temp(
            "claude4.jsonl",
            &format!(
                "{}\n",
                r#"{"type":"user","message":{"role":"user","content":"nothing relevant here"}}"#,
            ),
        );
        let result = search_session_file(
            &path,
            "claude",
            "zzz-absent-query",
            FileSearchTier::FullText,
            None,
        )
        .unwrap();
        assert_eq!(result, None);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_is_an_io_error_not_a_none() {
        let path = std::env::temp_dir().join(format!(
            "freshell-search-missing-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let result =
            search_session_file(&path, "claude", "anything", FileSearchTier::FullText, None);
        assert!(
            matches!(result, Err(SearchFileError::Io(_))),
            "an unreadable file must surface as Err(Io), not Ok(None) -- the \
             caller degrades it to partialReason: 'io_error' (`service.ts:208-217`), \
             got {result:?}"
        );
    }

    #[test]
    fn codex_provider_full_text_matches_user_and_assistant() {
        let path = write_temp(
            "codex.jsonl",
            &format!(
                "{}\n{}\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex-user-phrase"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"codex-assistant-phrase"}]}}"#,
            ),
        );
        assert!(search_session_file(
            &path,
            "codex",
            "codex-user-phrase",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap()
        .is_some());
        assert!(search_session_file(
            &path,
            "codex",
            "codex-assistant-phrase",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap()
        .is_none());
        assert!(search_session_file(
            &path,
            "codex",
            "codex-assistant-phrase",
            FileSearchTier::FullText,
            None,
        )
        .unwrap()
        .is_some());
        std::fs::remove_file(&path).ok();
    }

    /// SESSION-19 -- "avoid leaking unrelated messages": the snippet is
    /// extracted from the SINGLE matching message's text only. Even at the
    /// `FullText` tier (both lines eligible), a same-message secret placed
    /// beyond the 50-char context window AND a secret in the immediate
    /// neighboring assistant message must both stay out of the snippet.
    #[test]
    fn search_session_file_snippet_is_bounded_to_the_matching_message() {
        let user_line = format!(
            "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"shared-needle {} SAME-MESSAGE-SECRET\"}}}}",
            "p".repeat(200)
        );
        let assistant_line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"NEIGHBOR-SECRET-SENTINEL shared-needle"}]}}"#;
        let path = write_temp(
            "claude-isolation.jsonl",
            &format!("{user_line}\n{assistant_line}\n"),
        );
        let result = search_session_file(
            &path,
            "claude",
            "shared-needle",
            FileSearchTier::FullText,
            None,
        )
        .unwrap();
        let m = result.expect("the user turn must match first");
        assert_eq!(m.matched_in, "userMessage");
        assert!(m.snippet.starts_with("shared-needle"));
        assert!(
            !m.snippet.contains("SAME-MESSAGE-SECRET"),
            "text beyond the context window of the matching message must not leak, got {:?}",
            m.snippet
        );
        assert!(
            !m.snippet.contains("NEIGHBOR-SECRET-SENTINEL"),
            "a neighboring message's text must never appear in the snippet, got {:?}",
            m.snippet
        );
        std::fs::remove_file(&path).ok();
    }

    // ── SESSION-07: stale-query cancellation (the ported AbortSignal) ──

    #[test]
    fn pre_cancelled_probe_aborts_before_the_file_is_even_opened() {
        // A probe that is ALREADY true must abort before the read
        // (`file-search.ts:43`): even a file that WOULD match on its first
        // line yields Err(Cancelled), never a match.
        let path = write_temp(
            "cancel-pre.jsonl",
            &format!(
                "{}\n",
                r#"{"type":"user","message":{"role":"user","content":"cancel-test-needle"}}"#,
            ),
        );
        let result = search_session_file(
            &path,
            "claude",
            "cancel-test-needle",
            FileSearchTier::UserMessages,
            Some(&|| true),
        );
        assert!(
            matches!(result, Err(SearchFileError::Cancelled)),
            "a pre-cancelled probe must abort with Cancelled, got {result:?}"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mid_scan_cancellation_stops_before_reaching_the_match_line() {
        // Probe consult order: pre-read (1), line 1 (2), line 2 (3). A probe
        // true from its 3rd call aborts while scanning line 2 -- the match
        // on line 3 is NEVER examined. Deterministic: one probe call per
        // line plus the pre-read check.
        let content = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","message":{"role":"user","content":"filler one"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"filler two"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"late-match-needle"}}"#,
        );
        let path = write_temp("cancel-mid.jsonl", &content);

        let calls = std::cell::Cell::new(0usize);
        let probe = || {
            let n = calls.get();
            calls.set(n + 1);
            n >= 2
        };
        let result = search_session_file(
            &path,
            "claude",
            "late-match-needle",
            FileSearchTier::UserMessages,
            Some(&probe),
        );
        assert!(
            matches!(result, Err(SearchFileError::Cancelled)),
            "the scan must abandon mid-file once the probe fires, got {result:?}"
        );

        // Control: an un-cancelled scan of the SAME file does reach the
        // line-3 match, proving the cancelled run stopped EARLY (not merely
        // failing to match).
        let control = search_session_file(
            &path,
            "claude",
            "late-match-needle",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap();
        assert!(
            control.is_some(),
            "sanity: the match is present when the probe never fires"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn cancellation_is_distinct_from_io_error_even_with_a_probe_attached() {
        // The two SearchFileError variants feed DIFFERENT caller paths
        // (service.ts:208-217): an I/O failure degrades to
        // partialReason 'io_error'; a cancellation aborts the whole query. A
        // missing file with a never-firing probe must be the I/O arm.
        let path = std::env::temp_dir().join(format!(
            "freshell-search-missing-cancel-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let result = search_session_file(
            &path,
            "claude",
            "anything",
            FileSearchTier::FullText,
            Some(&|| false),
        );
        assert!(
            matches!(result, Err(SearchFileError::Io(_))),
            "a missing file must stay the Io arm, not collapse into Cancelled, got {result:?}"
        );
    }

    // ── SESSION-07: amplifier transcript search ──

    #[test]
    fn amplifier_user_string_content_is_extracted_trimmed() {
        // `providers/amplifier.ts:285-289`: string content verbatim, then
        // the event construction trims it.
        let obj: Value =
            serde_json::from_str(r#"{"role":"user","content":"  amplifier user turn  "}"#).unwrap();
        assert_eq!(
            extract_amplifier_message(&obj),
            Some(("user", "amplifier user turn".to_string()))
        );
    }

    #[test]
    fn amplifier_assistant_parts_join_text_and_exclude_thinking() {
        // `providers/amplifier.ts:291-307`: thinking blocks become
        // `reasoning` events (never searched); text blocks join with "\n".
        let obj: Value = serde_json::from_str(
            r#"{"role":"assistant","content":[
                {"type":"thinking","thinking":"chain-of-thought must stay unsearchable"},
                {"type":"text","text":"visible one"},
                {"type":"text","text":"visible two"}
            ]}"#,
        )
        .unwrap();
        let (role, text) = extract_amplifier_message(&obj).unwrap();
        assert_eq!(role, "assistant");
        assert_eq!(text, "visible one\nvisible two");
        assert!(!text.contains("chain-of-thought"));
    }

    #[test]
    fn amplifier_assistant_with_only_thinking_yields_no_message_event() {
        // `if (joined) { events.push(...) }` (`providers/amplifier.ts:300-304`):
        // an all-reasoning turn emits NO message.assistant event.
        let obj: Value = serde_json::from_str(
            r#"{"role":"assistant","content":[{"type":"thinking","thinking":"only reasoning here"}]}"#,
        )
        .unwrap();
        assert_eq!(extract_amplifier_message(&obj), None);
    }

    #[test]
    fn amplifier_tool_role_is_not_a_searchable_message() {
        // The `tool` branch produces `tool.result` events
        // (`providers/amplifier.ts:309-322`), filtered out by the caller
        // (`file-search.ts:67`) -- never user/assistant-searchable.
        let obj: Value = serde_json::from_str(
            r#"{"role":"tool","content":"tool output text","tool_call_id":"c1","name":"bash"}"#,
        )
        .unwrap();
        assert_eq!(extract_amplifier_message(&obj), None);
    }

    #[test]
    fn amplifier_transcript_tier_scoping_matches_reference() {
        let path = write_temp(
            "amplifier.jsonl",
            &format!(
                "{}\n{}\n",
                r#"{"role":"user","content":"amplifier-user-phrase"}"#,
                r#"{"role":"assistant","content":[{"type":"text","text":"amplifier-assistant-phrase"}]}"#,
            ),
        );
        assert!(search_session_file(
            &path,
            "amplifier",
            "amplifier-user-phrase",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap()
        .is_some());
        assert!(search_session_file(
            &path,
            "amplifier",
            "amplifier-assistant-phrase",
            FileSearchTier::UserMessages,
            None,
        )
        .unwrap()
        .is_none());
        let m = search_session_file(
            &path,
            "amplifier",
            "amplifier-assistant-phrase",
            FileSearchTier::FullText,
            None,
        )
        .unwrap()
        .expect("fullText must match the amplifier assistant turn");
        assert_eq!(m.matched_in, "assistantMessage");
        assert!(m.snippet.contains("amplifier-assistant-phrase"));
        std::fs::remove_file(&path).ok();
    }
}

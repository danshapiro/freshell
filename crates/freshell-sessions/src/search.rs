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
//! * **claude + codex only.** Both are per-session-file providers with a
//!   `source_file` path (`IndexedSession::source_file`,
//!   `directory_index.rs`). `opencode` (single sqlite db, no per-session
//!   file) and `amplifier` (no ported file-search parser) are un-searchable
//!   at these tiers -- title-tier metadata search still covers them.
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

/// `searchSessionFile(provider, filePath, query, tier, signal)`
/// (`file-search.ts:29-93`), minus the `AbortSignal` (this port's caller
/// scans synchronously and applies its own scan budget --
/// `session_directory.rs::apply_file_search` -- rather than a cooperative
/// abort signal). Returns `Ok(None)` for no match, `Err` only on a file I/O
/// failure (mirrors the reference's `partialReason: 'io_error'` path,
/// `service.ts:208-217`) -- an unsupported `provider` is `Ok(None)` (the
/// caller is expected to skip unsupported providers before ever calling
/// this, matching `service.ts:194-195`'s `if (!provider) continue`).
pub fn search_session_file(
    path: &Path,
    provider: &str,
    query: &str,
    tier: FileSearchTier,
) -> std::io::Result<Option<FileSearchMatch>> {
    let bytes = std::fs::read(path)?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let needle = query.to_lowercase();

    for raw_line in content.split('\n') {
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
        let result = search_session_file(&path, "claude", "anything", FileSearchTier::FullText);
        assert!(
            result.is_err(),
            "an unreadable file must surface as Err, not Ok(None)"
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
            FileSearchTier::UserMessages
        )
        .unwrap()
        .is_some());
        assert!(search_session_file(
            &path,
            "codex",
            "codex-assistant-phrase",
            FileSearchTier::UserMessages
        )
        .unwrap()
        .is_none());
        assert!(search_session_file(
            &path,
            "codex",
            "codex-assistant-phrase",
            FileSearchTier::FullText
        )
        .unwrap()
        .is_some());
        std::fs::remove_file(&path).ok();
    }
}

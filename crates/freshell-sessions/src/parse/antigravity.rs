//! Antigravity CLI (`agy`) conversation transcript `.jsonl` parser.
//!
//! // Stage-1 candidate contract: the transcript PATH
//! (`~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl`)
//! and the hook inputs (`conversationId`, `workspacePaths`, `transcriptPath`)
//! are documented+probe-validated facts (Provider Contract Record,
//! `docs/plans/2026-10-29-google-cli-first-class-support.md`). The on-disk
//! RECORD SCHEMA parsed here is NOT documented anywhere official and is
//! validated ONLY against the committed fixtures
//! (`test/fixtures/coding-cli/antigravity/*.sanitized.jsonl`, pinned by
//! `tests/antigravity_fixture_parity.rs`); it remains the A2 named blocker.
//! No capability flag, qualification entry, or recovery claim may be
//! enabled on this candidate evidence.
//!
//! Structure follows the codex parser (`parse/codex.rs`): corruption-tolerant
//! by construction — a malformed line is skipped, never panicking the
//! process; unknown record types are ignored; and `message_count` counts
//! every non-empty line (including unparseable ones).
//!
//! Candidate record types:
//! - `session_start` (the ownership record): `conversationId`,
//!   `workspacePaths` (absolute; may carry several — the FIRST recorded is
//!   the evidenced primary cwd, never the current terminal's cwd), `model`,
//!   `startedAt`.
//! - `user_message`: `text`, `at`.
//! - `assistant_message`: `text`, `at`, optional `usage` envelope
//!   (`inputTokens`/`outputTokens`/`cachedTokens`/`totalTokens`).
//! - `turn_settled`: `at`, `outcome` (`completed`|`errored`), `fullyIdle`.
//!
//! Only those four semantic record types move the created/last-activity
//! clock; `session_start` timestamps come from `startedAt`, the rest from
//! `at`.

use serde_json::Value;

use crate::meta::{ParsedSessionMeta, TokenSummary};
use crate::text::{extract_title_from_message, looks_like_path, normalize_first_user_message};
use crate::time::{parse_timestamp_ms, to_finite_number};

/// The title bound for user-derived titles (codex/claude parity).
const ANTIGRAVITY_TITLE_MAX_CHARS: usize = 200;
/// The assistant-summary bound (first assistant text; codex parity).
const ANTIGRAVITY_SUMMARY_MAX_CHARS: usize = 240;

fn finite_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(to_finite_number).map(|f| f as i64)
}

/// `parseAntigravityTokenEnvelope` — maps the candidate schema's `usage`
/// object into [`TokenSummary`] with codex-style plausibility coercion
/// (model: `parse_codex_token_envelope`'s `parse_usage_payload`,
/// parse/codex.rs:151-180): absent keys default to 0, `totalTokens` falls
/// back to `input+output` when omitted, a non-object envelope is ignored,
/// and an all-zero envelope stays `None` — missing usage stays unknown.
/// The candidate schema carries no context-window fields, so the
/// context-meter trio stays `None`.
fn parse_antigravity_token_envelope(usage: &Value) -> Option<TokenSummary> {
    if !usage.is_object() {
        return None;
    }
    let input = finite_i64(usage.get("inputTokens")).unwrap_or(0);
    let output = finite_i64(usage.get("outputTokens")).unwrap_or(0);
    let cached = finite_i64(usage.get("cachedTokens")).unwrap_or(0);
    let total = finite_i64(usage.get("totalTokens")).unwrap_or(input + output);
    if input == 0 && output == 0 && cached == 0 && total == 0 {
        return None;
    }
    Some(TokenSummary {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: total,
        context_tokens: None,
        model_context_window: None,
        compact_threshold_tokens: None,
        compact_percent: None,
    })
}

/// Fold one semantic-record timestamp into the meta clock:
/// `created_at` = min, `last_activity_at` = max (codex semantic-fold model,
/// parse/codex.rs:303-308).
fn fold_ts(meta: &mut ParsedSessionMeta, value: Option<&Value>) {
    if let Some(at) = value.and_then(parse_timestamp_ms) {
        meta.created_at = Some(meta.created_at.map_or(at, |c| c.min(at)));
        meta.last_activity_at = Some(meta.last_activity_at.map_or(at, |l| l.max(at)));
    }
}

/// Parse one antigravity conversation transcript into
/// [`ParsedSessionMeta`], or `None` when no ownership record yields a
/// `conversationId` — an id-less file is an excluded row (the R10b-style
/// cwd/identity-less exclusion; it never indexes a ghost session).
///
/// Determinism rules (pinned by the fixture-parity test):
/// - The FIRST `session_start` record's `conversationId` wins; later ones
///   never reassign it (a resumed conversation may append another
///   `session_start`, and a two-id file keeps the first id — never a guess).
/// - `cwd` is the first recorded `workspacePaths` entry that looks like a
///   path; later records never override it. The full path set is retained in
///   the transcript itself for consumers that need it (the Task-6 locator
///   re-reads the ownership record); the parse layer surfaces only the
///   evidenced primary.
/// - `first_user_message` is the first `user_message` text that normalizes
///   to a non-empty message; `title` derives from it (200 chars), never
///   provider-generated.
pub fn parse_antigravity_session_content(content: &str) -> Option<ParsedSessionMeta> {
    let mut meta = ParsedSessionMeta::default();
    let mut have_id = false;
    let mut have_cwd = false;
    let mut first_user: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut count = 0i64;

    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        count += 1;
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue; // malformed ⇒ skip (a truncated mid-write tail lands here)
        };
        let conv = obj
            .get("conversationId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        match obj.get("type").and_then(Value::as_str) {
            Some("session_start") => {
                if !have_id {
                    if let Some(id) = conv {
                        meta.session_id = Some(id.to_string());
                        have_id = true;
                    }
                }
                if !have_cwd {
                    if let Some(paths) = obj.get("workspacePaths").and_then(Value::as_array) {
                        if let Some(primary) = paths.iter().find_map(|p| p.as_str()) {
                            if looks_like_path(primary) {
                                meta.cwd = Some(primary.to_string());
                                have_cwd = true;
                            }
                        }
                    }
                }
                fold_ts(&mut meta, obj.get("startedAt"));
            }
            Some("user_message") => {
                if first_user.is_none() {
                    if let Some(text) = obj.get("text").and_then(Value::as_str) {
                        first_user = normalize_first_user_message(text);
                    }
                }
                fold_ts(&mut meta, obj.get("at"));
            }
            Some("assistant_message") => {
                if summary.is_none() {
                    if let Some(text) = obj.get("text").and_then(Value::as_str) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            summary = Some(
                                trimmed
                                    .chars()
                                    .take(ANTIGRAVITY_SUMMARY_MAX_CHARS)
                                    .collect(),
                            );
                        }
                    }
                }
                fold_ts(&mut meta, obj.get("at"));
                if let Some(usage) = obj.get("usage") {
                    // Whole-delta review round 6, Nit 1: this takes the
                    // LAST assistant envelope, not an accumulated total —
                    // whether the candidate schema's per-message `usage`
                    // is per-message or cumulative is a Stage-1 UNKNOWN
                    // (the A2 schema blocker; recorded in the plan's
                    // Provider Contract Record "real-binary follow-up"
                    // row). Under a per-message reading a multi-turn
                    // conversation reports only the final message's
                    // envelope; a real authenticated session must settle
                    // the semantics before this projection may be called
                    // a total.
                    meta.token_usage =
                        parse_antigravity_token_envelope(usage).or(meta.token_usage.take());
                }
            }
            Some("turn_settled") => {
                fold_ts(&mut meta, obj.get("at"));
            }
            _ => {} // unknown record types are ignored
        }
    }

    if !have_id {
        return None; // no ownership evidence ⇒ excluded row (R10b-style)
    }
    meta.message_count = count;
    meta.first_user_message = first_user;
    if let Some(f) = &meta.first_user_message {
        meta.title = Some(extract_title_from_message(f, ANTIGRAVITY_TITLE_MAX_CHARS));
        meta.title_provider_generated = false;
    }
    meta.summary = summary;
    Some(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_without_conversation_id_is_excluded() {
        // Messages without an ownership record carry no identity evidence:
        // the row is excluded (None), never indexed as a ghost session.
        let content = concat!(
            r#"{"type":"user_message","text":"Hi","at":"2026-10-29T20:00:01.000Z"}"#,
            "\n",
            r#"{"type":"assistant_message","text":"Hello","at":"2026-10-29T20:00:02.000Z"}"#,
            "\n",
            r#"{"type":"turn_settled","at":"2026-10-29T20:00:02.500Z","outcome":"completed","fullyIdle":true}"#,
        );
        assert!(
            parse_antigravity_session_content(content).is_none(),
            "R10b-style: no ownership record yields a conversationId ⇒ None"
        );
        // An empty conversationId string is the same as an absent one.
        let empty_id = r#"{"type":"session_start","conversationId":"","workspacePaths":["/w"],"startedAt":"2026-10-29T20:00:00.000Z"}"#;
        assert!(parse_antigravity_session_content(empty_id).is_none());
        // Garbage-only content is excluded too.
        assert!(parse_antigravity_session_content("not json\n{oops").is_none());
    }

    #[test]
    fn malformed_lines_are_skipped_but_counted() {
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c1","workspacePaths":["/w"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            "totally not json garbage",
            "\n",
            r#"{"type":"user_message","conversationId":"c1","text":"Prompt","at":"2026-10-29T20:00:01.000Z"}"#,
            "\n",
            r#"{"type":"turn_settled","conversationId":"c1","at":"2026-10-30T0"#,
            // (truncated mid-write tail, no closing quote or brace)
        );
        let meta = parse_antigravity_session_content(content).expect("ownership record present");
        assert_eq!(meta.session_id.as_deref(), Some("c1"));
        assert_eq!(meta.first_user_message.as_deref(), Some("Prompt"));
        assert_eq!(meta.message_count, 4, "every non-empty line counts");
        assert_eq!(meta.created_at, Some(1_793_304_000_000));
        assert_eq!(meta.last_activity_at, Some(1_793_304_001_000));
    }

    #[test]
    fn unknown_record_types_are_ignored() {
        // The tool_call's `at` (20:00:02) is NEWER than every semantic
        // record's, so it would move the activity clock if unknown records
        // folded — they must not.
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c2","workspacePaths":["/w2"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"tool_call","conversationId":"c2","toolName":"bash","at":"2026-10-29T20:00:02.000Z"}"#,
            "\n",
            r#"{"type":"user_message","conversationId":"c2","text":"Prompt","at":"2026-10-29T20:00:01.000Z"}"#,
        );
        let meta = parse_antigravity_session_content(content).expect("ownership record present");
        assert_eq!(meta.created_at, Some(1_793_304_000_000));
        assert_eq!(meta.last_activity_at, Some(1_793_304_001_000));
        assert_eq!(meta.message_count, 3);
        assert_eq!(meta.summary, None, "unknown records never contribute text");
    }

    #[test]
    fn multi_workspace_paths_keep_first_recorded_as_primary() {
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c3","workspacePaths":["/first/workspace","/second/workspace"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"user_message","conversationId":"c3","text":"Prompt","at":"2026-10-29T20:00:01.000Z"}"#,
            "\n",
            // A later session_start with a different single path never
            // overrides the first recorded primary.
            r#"{"type":"session_start","conversationId":"c3","workspacePaths":["/later/workspace"],"startedAt":"2026-10-29T21:00:00.000Z","source":"resume"}"#,
        );
        let meta = parse_antigravity_session_content(content).expect("ownership record present");
        assert_eq!(meta.cwd.as_deref(), Some("/first/workspace"));
    }

    #[test]
    fn non_path_workspace_entry_is_rejected_for_cwd() {
        // The first workspacePaths entry must look like a path; a URL or
        // plain text never becomes the evidenced cwd.
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c4","workspacePaths":["https://example.com/x"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"user_message","conversationId":"c4","text":"Prompt","at":"2026-10-29T20:00:01.000Z"}"#,
        );
        let meta = parse_antigravity_session_content(content).expect("ownership record present");
        assert_eq!(meta.cwd, None);
        assert_eq!(meta.session_id.as_deref(), Some("c4"));
    }

    #[test]
    fn missing_usage_stays_none_and_last_usage_wins() {
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c5","workspacePaths":["/w"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"assistant_message","conversationId":"c5","text":"No usage here.","at":"2026-10-29T20:00:01.000Z"}"#,
            "\n",
            r#"{"type":"assistant_message","conversationId":"c5","text":"With usage.","at":"2026-10-29T20:00:02.000Z","usage":{"inputTokens":1,"outputTokens":2}}"#,
            "\n",
            // A later all-zero envelope never erases the last real one.
            r#"{"type":"assistant_message","conversationId":"c5","text":"Zeroed.","at":"2026-10-29T20:00:03.000Z","usage":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalTokens":0}}"#,
        );
        let meta = parse_antigravity_session_content(content).expect("ownership record present");
        assert_eq!(
            meta.token_usage,
            Some(TokenSummary {
                input_tokens: 1,
                output_tokens: 2,
                cached_tokens: 0,
                total_tokens: 3, // falls back to input+output when omitted
                context_tokens: None,
                model_context_window: None,
                compact_threshold_tokens: None,
                compact_percent: None,
            })
        );
        // And the first assistant message with NO usage field leaves None.
        let no_usage = concat!(
            r#"{"type":"session_start","conversationId":"c6","workspacePaths":["/w"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"assistant_message","conversationId":"c6","text":"Reply.","at":"2026-10-29T20:00:01.000Z"}"#,
        );
        let meta = parse_antigravity_session_content(no_usage).expect("ownership record present");
        assert_eq!(meta.token_usage, None);
    }

    #[test]
    fn empty_input_yields_none() {
        assert!(parse_antigravity_session_content("").is_none());
        assert!(parse_antigravity_session_content("\n \n").is_none());
    }
}

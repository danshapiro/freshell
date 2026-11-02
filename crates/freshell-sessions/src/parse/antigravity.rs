//! Antigravity CLI (`agy`) conversation transcript `.jsonl` parser.
//!
//! REAL-BINARY record contract (corrected 2026-11-02 against real agy
//! 1.4.12 transcripts; evidence:
//! .worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md): step-indexed records —
//! USER_INPUT / PLANNER_RESPONSE / GENERIC / SYSTEM_MESSAGE /
//! CHECKPOINT — every record carrying `source`, `status`, `step_index`,
//! and a SECOND-granularity RFC3339 `created_at`. Real records carry NO
//! conversation id and NO workspace evidence: the conversation id IS
//! the `brain/<id>` directory name (passed in by the caller), and `cwd`
//! is `None` for real transcripts (rows group under an unknown project).
//! The e2e/rebind fakes additionally append ONE labeled fake-contract
//! extension this parser tolerates: the `session_start` ownership anchor
//! (cwd evidence for the fake contract — real transcripts carry none).
//!
//! Corruption tolerance (unchanged): a malformed line is skipped, never
//! panicking the process; unknown record types are ignored; and
//! `message_count` counts every non-empty line (including unparseable
//! ones). A transcript with NO recognized record is excluded (`None`) —
//! absence is never silent upstream (`antigravity_parse_failed`).

use serde_json::Value;

use crate::meta::{ParsedSessionMeta, TokenSummary};
use crate::text::{extract_title_from_message, looks_like_path, normalize_first_user_message};
use crate::time::{parse_timestamp_ms, to_finite_number};

/// The title bound for user-derived titles (codex/claude parity).
const ANTIGRAVITY_TITLE_MAX_CHARS: usize = 200;
/// The assistant-summary bound (first PLANNER_RESPONSE content; codex parity).
const ANTIGRAVITY_SUMMARY_MAX_CHARS: usize = 240;

fn finite_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(to_finite_number).map(|f| f as i64)
}

/// The real format's FLAT token fields (binary v1.4.12): sparse
/// snake_case counts on a subset of PLANNER_RESPONSE records — null on
/// almost all records, and no `totalTokens` key exists (total falls
/// back to input+output). An all-null/all-zero read stays `None`
/// (missing usage is unknown, never a zeroed summary). The LAST
/// token-bearing record wins — the documented reading per the evidence
/// receipts (Provider Contract Record row 75(b)).
fn parse_antigravity_token_fields(obj: &Value) -> Option<TokenSummary> {
    let input = finite_i64(obj.get("input_tokens")).unwrap_or(0);
    let output = finite_i64(obj.get("output_tokens")).unwrap_or(0);
    let cached = finite_i64(obj.get("cache_read_tokens")).unwrap_or(0);
    let total = input + output;
    if input == 0 && output == 0 && cached == 0 {
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

/// Fold one recognized record's `created_at` into the meta clock:
/// `created_at` = min, `last_activity_at` = max (codex semantic-fold
/// model). The real vocabulary is closed (all five types carry real
/// stamps), so every recognized record folds.
fn fold_ts(meta: &mut ParsedSessionMeta, value: Option<&Value>) {
    if let Some(at) = value.and_then(parse_timestamp_ms) {
        meta.created_at = Some(meta.created_at.map_or(at, |c| c.min(at)));
        meta.last_activity_at = Some(meta.last_activity_at.map_or(at, |l| l.max(at)));
    }
}

/// Parse one antigravity conversation transcript into
/// [`ParsedSessionMeta`], or `None` when no recognized record parses —
/// an empty/garbage-only file is an excluded row (it proves nothing
/// happened; the directory alone carries no message evidence).
///
/// `conversation_id` is the `brain/<id>` directory name (real records
/// carry no id — binary v1.4.12); it is authoritative and never
/// reassigned by record content.
pub fn parse_antigravity_session_content(
    content: &str,
    conversation_id: &str,
) -> Option<ParsedSessionMeta> {
    let mut meta = ParsedSessionMeta {
        session_id: Some(conversation_id.to_string()),
        ..ParsedSessionMeta::default()
    };
    let mut have_cwd = false;
    let mut first_user: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut count = 0i64;
    let mut parsed_semantic = 0i64;

    for line in content.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        count += 1;
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue; // malformed ⇒ skip (a truncated mid-write tail lands here)
        };
        let Some(record_type) = obj.get("type").and_then(Value::as_str) else {
            continue;
        };
        match record_type {
            // Fake-contract extension (the e2e/rebind fakes' ownership
            // anchor): cwd evidence only — its conversationId never
            // reassigns the directory id, and real transcripts carry no
            // such record (binary evidence).
            "session_start" => {
                parsed_semantic += 1;
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
            "USER_INPUT" => {
                parsed_semantic += 1;
                if first_user.is_none()
                    && obj.get("source").and_then(Value::as_str) == Some("USER_EXPLICIT")
                {
                    if let Some(text) = obj.get("content").and_then(Value::as_str) {
                        first_user = normalize_first_user_message(text);
                    }
                }
                fold_ts(&mut meta, obj.get("created_at"));
            }
            "PLANNER_RESPONSE" => {
                parsed_semantic += 1;
                if summary.is_none() {
                    if let Some(text) = obj.get("content").and_then(Value::as_str) {
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
                fold_ts(&mut meta, obj.get("created_at"));
                meta.token_usage = parse_antigravity_token_fields(&obj).or(meta.token_usage.take());
            }
            "GENERIC" | "SYSTEM_MESSAGE" | "CHECKPOINT" => {
                parsed_semantic += 1;
                fold_ts(&mut meta, obj.get("created_at"));
            }
            _ => {} // unknown record types are ignored (forward-compat)
        }
    }

    if parsed_semantic == 0 {
        return None; // nothing recognized ⇒ excluded row
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
    fn content_with_no_parseable_records_is_excluded() {
        // No recognized record at all (garbage-only, empty, or blank) yields
        // no row — the dir name alone proves nothing parseable happened.
        assert!(parse_antigravity_session_content("not json\n{oops", "c1").is_none());
        assert!(parse_antigravity_session_content("", "c1").is_none());
        assert!(parse_antigravity_session_content("\n \n", "c1").is_none());
    }

    #[test]
    fn second_granularity_created_at_folds_to_ms() {
        // Real binary stamps are RFC3339 with NO fractional part
        // (2026-10-29T20:00:01Z) — the shared coercion must read them.
        let content = concat!(
            r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
            "\n",
            r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"Reply."}"#,
        );
        let meta = parse_antigravity_session_content(content, "c2").expect("parses");
        assert_eq!(meta.created_at, Some(1_793_304_001_000));
        assert_eq!(meta.last_activity_at, Some(1_793_304_002_000));
    }

    #[test]
    fn unknown_record_types_are_ignored_but_counted() {
        // A future record type with a NEWER stamp moves nothing.
        let content = concat!(
            r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
            "\n",
            r#"{"type":"FUTURE_RECORD","source":"MODEL","status":"DONE","step_index":9,"created_at":"2026-10-29T20:00:09Z","content":"noise"}"#,
        );
        let meta = parse_antigravity_session_content(content, "c3").expect("parses");
        assert_eq!(meta.last_activity_at, Some(1_793_304_001_000));
        assert_eq!(meta.message_count, 2);
        assert_eq!(meta.summary, None);
    }

    #[test]
    fn system_authored_user_input_folds_the_clock_but_never_a_title() {
        // The title read is source-gated to USER_EXPLICIT (the pane's own
        // prompt); a SYSTEM-authored USER_INPUT is still activity.
        let content = r#"{"type":"USER_INPUT","source":"SYSTEM","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"injected prompt"}"#;
        let meta = parse_antigravity_session_content(content, "c4").expect("parses");
        assert_eq!(meta.first_user_message, None);
        assert_eq!(meta.title, None);
        assert_eq!(meta.created_at, Some(1_793_304_001_000));
    }

    #[test]
    fn non_path_workspace_entry_is_rejected_for_cwd() {
        let content = concat!(
            r#"{"type":"session_start","conversationId":"c5","workspacePaths":["https://example.com/x"],"startedAt":"2026-10-29T20:00:00.000Z"}"#,
            "\n",
            r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
        );
        let meta = parse_antigravity_session_content(content, "c5").expect("parses");
        assert_eq!(meta.cwd, None);
    }

    #[test]
    fn missing_token_fields_stay_none() {
        let content = concat!(
            r#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"Prompt"}"#,
            "\n",
            r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"2026-10-29T20:00:02Z","content":"Reply."}"#,
            "\n",
            // Null token fields (the real format's sparse shape) stay unknown.
            r#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":2,"created_at":"2026-10-29T20:00:03Z","content":"Reply two.","input_tokens":null,"output_tokens":null,"cache_read_tokens":null}"#,
        );
        let meta = parse_antigravity_session_content(content, "c6").expect("parses");
        assert_eq!(meta.token_usage, None);
    }
}

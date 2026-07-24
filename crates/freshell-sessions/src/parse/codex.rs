//! Codex rollout `.jsonl` transcript parser.
//!
//! 1:1 port of `server/coding-cli/providers/codex.ts` `parseCodexSessionContent` (and
//! its private token-envelope helpers). Same corruption tolerance as the claude parser:
//! `message_count` counts every non-empty line and `JSON.parse` failures are skipped.

use serde_json::Value;

use crate::meta::{CodexTaskEventSnapshot, ParsedSessionMeta, TokenSummary};
use crate::text::{
    extract_title_from_message, extract_user_authored_text, looks_like_path,
    normalize_first_user_message,
};
use crate::time::{parse_timestamp_ms, to_finite_number};

const CODEX_MAX_PLAUSIBLE_CONTEXT_TOKENS_WITHOUT_WINDOW: i64 = 5_000_000;
const CODEX_AUTO_COMPACT_DEFAULT_PERCENT: f64 = 90.0;
const CODEX_EFFECTIVE_CONTEXT_WINDOW_DEFAULT_PERCENT: f64 = 95.0;

const SEMANTIC_CODEX_RESPONSE_TYPES: &[&str] =
    &["message", "function_call", "function_call_output"];
const SEMANTIC_CODEX_EVENT_TYPES: &[&str] = &[
    "agent_message",
    "agent_reasoning",
    "task_started",
    "task_complete",
    "turn_aborted",
    "user_message",
];

/// SESSION-07: `pub(crate)` (was private) so
/// `crate::search::extract_codex_message` can reuse the exact same
/// `extractTextContent` port for the file-content search tiers instead of
/// duplicating this logic.
pub(crate) fn extract_text_content(items: Option<&Value>) -> String {
    let Some(Value::Array(items)) = items else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn max_timestamp(current: Option<i64>, candidate: Option<i64>) -> Option<i64> {
    match (current, candidate) {
        (c, None) => c,
        (None, c) => c,
        (Some(a), Some(b)) => Some(a.max(b)),
    }
}

fn is_semantic_codex_record(obj: &Value) -> bool {
    match obj.get("type").and_then(Value::as_str) {
        Some("session_meta") => true,
        Some("response_item") => obj
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .map(|t| SEMANTIC_CODEX_RESPONSE_TYPES.contains(&t))
            .unwrap_or(false),
        Some("event_msg") => obj
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .map(|t| SEMANTIC_CODEX_EVENT_TYPES.contains(&t))
            .unwrap_or(false),
        _ => false,
    }
}

fn normalize_compact_percent(numerator: i64, denominator: Option<i64>) -> Option<i64> {
    let denom = denominator?;
    if denom <= 0 {
        return None;
    }
    let ratio = ((numerator as f64 / denom as f64) * 100.0).round() as i64;
    Some(ratio.clamp(0, 100))
}

fn derive_codex_compact_threshold_tokens(
    model_context_window: Option<i64>,
    explicit_limit: Option<i64>,
) -> Option<i64> {
    if let Some(limit) = explicit_limit {
        if limit > 0 {
            return Some(limit);
        }
    }
    let window = model_context_window?;
    if window <= 0 {
        return None;
    }
    Some(
        (window as f64
            * (CODEX_AUTO_COMPACT_DEFAULT_PERCENT / CODEX_EFFECTIVE_CONTEXT_WINDOW_DEFAULT_PERCENT))
            .round() as i64,
    )
}

fn coerce_likely_context_tokens(
    value: Option<i64>,
    model_context_window: Option<i64>,
    preferred_context_tokens: Option<i64>,
) -> Option<i64> {
    let value = value?;
    if value < 0 {
        return None;
    }
    if let Some(window) = model_context_window {
        if window > 0 && value > window * 2 {
            return None;
        }
    }
    if model_context_window.is_none() && value > CODEX_MAX_PLAUSIBLE_CONTEXT_TOKENS_WITHOUT_WINDOW {
        return None;
    }
    if let Some(preferred) = preferred_context_tokens {
        if preferred > 0 && value > preferred * 8 {
            return None;
        }
    }
    Some(value)
}

struct CodexUsage {
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
    total_tokens: i64,
}

fn finite_i64(v: Option<&Value>) -> Option<i64> {
    v.and_then(to_finite_number).map(|f| f as i64)
}

fn first_finite(v: &Value, keys: &[&str]) -> Option<i64> {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(to_finite_number) {
            return Some(n as i64);
        }
    }
    None
}

fn parse_usage_payload(payload: Option<&Value>) -> Option<CodexUsage> {
    let payload = payload?;
    if !payload.is_object() {
        return None;
    }
    let input = first_finite(payload, &["input_tokens", "inputTokens", "input"]).unwrap_or(0);
    let output = first_finite(payload, &["output_tokens", "outputTokens", "output"]).unwrap_or(0);
    let cached = first_finite(
        payload,
        &[
            "cached_input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "cachedTokens",
            "cached_tokens",
        ],
    )
    .unwrap_or(0);
    let explicit_total = first_finite(payload, &["total_tokens", "totalTokens", "total"]);
    let total = explicit_total.unwrap_or(input + output);
    if input == 0 && output == 0 && cached == 0 && total == 0 {
        return None;
    }
    Some(CodexUsage {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: total,
    })
}

/// `parseCodexTokenEnvelope` — the parser only consumes the `summary`, so that is all we
/// return.
fn parse_codex_token_envelope(payload: &Value) -> Option<TokenSummary> {
    if let Some(info) = payload.get("info").filter(|v| v.is_object()) {
        let last_usage = parse_usage_payload(info.get("last_token_usage"));
        let total_usage = parse_usage_payload(info.get("total_token_usage"));

        let model_context_window = finite_i64(info.get("model_context_window"));
        let explicit_compact_limit = first_finite(
            info,
            &[
                "model_auto_compact_token_limit",
                "auto_compact_limit",
                "auto_compact_token_limit",
                "compact_token_limit",
            ],
        );
        let compact_threshold_tokens =
            derive_codex_compact_threshold_tokens(model_context_window, explicit_compact_limit);

        let preferred_context_tokens = last_usage.as_ref().map(|u| u.total_tokens);
        let last_token_total = info
            .get("last_token_usage")
            .and_then(|u| u.get("total_tokens"))
            .and_then(to_finite_number)
            .map(|f| f as i64);
        let context_candidates: [Option<i64>; 6] = [
            finite_i64(info.get("current_context_tokens")),
            finite_i64(info.get("context_tokens")),
            finite_i64(info.get("context_token_count")),
            last_usage.as_ref().map(|u| u.total_tokens),
            last_token_total,
            finite_i64(info.get("total_usage_tokens")),
        ];
        let context_tokens = context_candidates.into_iter().find_map(|c| {
            coerce_likely_context_tokens(c, model_context_window, preferred_context_tokens)
        });

        let aggregate = last_usage.or(total_usage);
        let raw_compact_percent =
            context_tokens.and_then(|c| normalize_compact_percent(c, compact_threshold_tokens));

        if aggregate.is_some() || context_tokens.is_some() {
            let total_tokens = context_tokens
                .or_else(|| aggregate.as_ref().map(|u| u.total_tokens))
                .unwrap_or(0);
            Some(TokenSummary {
                input_tokens: aggregate.as_ref().map(|u| u.input_tokens).unwrap_or(0),
                output_tokens: aggregate.as_ref().map(|u| u.output_tokens).unwrap_or(0),
                cached_tokens: aggregate.as_ref().map(|u| u.cached_tokens).unwrap_or(0),
                total_tokens,
                context_tokens,
                model_context_window,
                compact_threshold_tokens,
                compact_percent: raw_compact_percent,
            })
        } else {
            None
        }
    } else {
        let legacy = parse_usage_payload(Some(payload))?;
        Some(TokenSummary {
            input_tokens: legacy.input_tokens,
            output_tokens: legacy.output_tokens,
            cached_tokens: legacy.cached_tokens,
            total_tokens: legacy.total_tokens,
            context_tokens: None,
            model_context_window: None,
            compact_threshold_tokens: None,
            compact_percent: None,
        })
    }
}

fn is_codex_subagent_source(source: Option<&Value>) -> bool {
    source
        .and_then(|s| s.get("subagent"))
        .and_then(|sa| sa.get("thread_spawn"))
        .map(|v| !v.is_null() && v != &Value::Bool(false))
        .unwrap_or(false)
}

fn has_codex_forked_from_session(payload: &Value) -> bool {
    payload
        .get("forked_from_id")
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// `parseCodexSessionContent(content)`.
pub fn parse_codex_session_content(content: &str) -> ParsedSessionMeta {
    let lines: Vec<&str> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .collect();

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut created_at: Option<i64> = None;
    let mut last_activity_at: Option<i64> = None;
    let mut title: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut first_user_message: Option<String> = None;
    let mut is_subagent: Option<bool> = None;
    let mut is_non_interactive: Option<bool> = None;
    let mut git_branch: Option<String> = None;
    let mut is_dirty: Option<bool> = None;
    let mut token_usage: Option<TokenSummary> = None;
    let mut latest_task_started_at: Option<i64> = None;
    let mut latest_task_completed_at: Option<i64> = None;
    let mut latest_turn_aborted_at: Option<i64> = None;

    for line in &lines {
        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if is_semantic_codex_record(&obj) {
            if let Some(at) = obj.get("timestamp").and_then(parse_timestamp_ms) {
                created_at = Some(created_at.map_or(at, |c| c.min(at)));
                last_activity_at = Some(last_activity_at.map_or(at, |l| l.max(at)));
            }
        }

        let ty = obj.get("type").and_then(Value::as_str);

        if ty == Some("session_meta") {
            let empty = Value::Object(Default::default());
            let payload = obj.get("payload").unwrap_or(&empty);
            if session_id.is_none() {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    session_id = Some(id.to_string());
                }
            }
            if cwd.is_none() {
                if let Some(p) = payload.get("cwd").and_then(Value::as_str) {
                    if looks_like_path(p) {
                        cwd = Some(p.to_string());
                    }
                }
            }
            if git_branch.is_none() {
                if let Some(b) = payload
                    .get("git")
                    .and_then(|g| g.get("branch"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    git_branch = Some(b.to_string());
                }
            }
            if is_dirty.is_none() {
                if let Some(d) = payload
                    .get("git")
                    .and_then(|g| g.get("dirty"))
                    .and_then(Value::as_bool)
                {
                    is_dirty = Some(d);
                }
            }
            if is_dirty.is_none() {
                if let Some(d) = payload
                    .get("git")
                    .and_then(|g| g.get("isDirty"))
                    .and_then(Value::as_bool)
                {
                    is_dirty = Some(d);
                }
            }
            if is_subagent.is_none()
                && (is_codex_subagent_source(payload.get("source"))
                    || has_codex_forked_from_session(payload))
            {
                is_subagent = Some(true);
            }
            if payload.get("source").and_then(Value::as_str) == Some("exec") {
                is_non_interactive = Some(true);
            }
        }

        if cwd.is_none() {
            let possible = obj
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(Value::as_str)
                .or_else(|| obj.get("cwd").and_then(Value::as_str))
                .or_else(|| {
                    obj.get("context")
                        .and_then(|c| c.get("cwd"))
                        .and_then(Value::as_str)
                });
            if let Some(p) = possible {
                if looks_like_path(p) {
                    cwd = Some(p.to_string());
                }
            }
        }

        let payload_type = obj
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str);
        let payload_role = obj
            .get("payload")
            .and_then(|p| p.get("role"))
            .and_then(Value::as_str);

        if ty == Some("response_item")
            && payload_type == Some("message")
            && payload_role == Some("user")
        {
            let text = extract_text_content(obj.get("payload").and_then(|p| p.get("content")));
            let user_text = extract_user_authored_text(&text);
            if first_user_message.is_none() {
                if let Some(ut) = &user_text {
                    if let Some(normalized) = normalize_first_user_message(ut) {
                        first_user_message = Some(normalized);
                    }
                }
            }
            if title.is_none() {
                if let Some(ut) = &user_text {
                    title = Some(extract_title_from_message(ut, 200));
                }
            }
        }

        if summary.is_none()
            && ty == Some("response_item")
            && payload_type == Some("message")
            && payload_role == Some("assistant")
        {
            let text = extract_text_content(obj.get("payload").and_then(|p| p.get("content")));
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                summary = Some(trimmed.chars().take(240).collect());
            }
        }

        if ty == Some("event_msg") && payload_type == Some("token_count") {
            if let Some(payload) = obj.get("payload") {
                if let Some(s) = parse_codex_token_envelope(payload) {
                    token_usage = Some(s);
                }
            }
        }

        if ty == Some("event_msg") {
            let timestamp_ms = obj.get("timestamp").and_then(parse_timestamp_ms);
            match payload_type {
                Some("task_started") => {
                    latest_task_started_at = max_timestamp(latest_task_started_at, timestamp_ms)
                }
                Some("task_complete") => {
                    latest_task_completed_at = max_timestamp(latest_task_completed_at, timestamp_ms)
                }
                Some("turn_aborted") => {
                    latest_turn_aborted_at = max_timestamp(latest_turn_aborted_at, timestamp_ms)
                }
                _ => {}
            }
        }

        if cwd.is_none() && ty == Some("turn_context") {
            if let Some(ctx_cwd) = obj
                .get("payload")
                .and_then(|p| p.get("cwd"))
                .and_then(Value::as_str)
            {
                if looks_like_path(ctx_cwd) {
                    cwd = Some(ctx_cwd.to_string());
                }
            }
        }
    }

    let codex_task_events = if latest_task_started_at.is_some()
        || latest_task_completed_at.is_some()
        || latest_turn_aborted_at.is_some()
    {
        Some(CodexTaskEventSnapshot {
            latest_task_started_at,
            latest_task_completed_at,
            latest_turn_aborted_at,
        })
    } else {
        None
    };

    ParsedSessionMeta {
        session_id,
        cwd,
        created_at,
        last_activity_at,
        title,
        summary,
        first_user_message,
        message_count: lines.len() as i64,
        is_subagent,
        is_non_interactive,
        git_branch,
        is_dirty,
        token_usage,
        codex_task_events,
    }
}

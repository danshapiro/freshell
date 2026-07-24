//! Claude `.jsonl` transcript parser.
//!
//! 1:1 port of `server/coding-cli/providers/claude.ts` `parseSessionContent` (and its
//! private helpers). Corruption tolerance is inherited verbatim: lines are split on
//! `/\r?\n/` and empty lines dropped (so `message_count` counts every non-empty line,
//! including unparseable ones), and each line is `JSON.parse`d inside a try/catch that
//! `continue`s on failure — a malformed line can never panic the parse.

use serde_json::Value;
use std::collections::HashSet;

use crate::meta::{ParsedSessionMeta, TokenSummary};
use crate::text::{
    extract_title_from_message, extract_user_authored_text, is_canonical_claude_session_id,
    looks_like_path, normalize_first_user_message,
};
use crate::time::{parse_timestamp_ms, to_finite_number};

const CLAUDE_DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
const CLAUDE_DEFAULT_COMPACT_PERCENT: i64 = 95;

/// `CLAUDE_MODEL_CONTEXT_WINDOWS` — all 200k today, but ported as a table so the
/// lookup path is identical.
fn claude_model_context_window(model: Option<&str>) -> i64 {
    let Some(model) = model else {
        return CLAUDE_DEFAULT_CONTEXT_WINDOW;
    };
    let normalized = model.to_lowercase();
    let normalized = normalized.trim();
    match normalized {
        "claude-opus-4-20250514"
        | "claude-sonnet-4-20250514"
        | "claude-3-7-sonnet-latest"
        | "claude-3-7-sonnet-20250219"
        | "claude-3-5-sonnet-latest"
        | "claude-3-5-sonnet-20241022"
        | "claude-3-5-sonnet-20240620"
        | "claude-3-5-haiku-latest"
        | "claude-3-5-haiku-20241022"
        | "claude-3-opus-20240229"
        | "claude-3-sonnet-20240229"
        | "claude-3-haiku-20240307" => 200_000,
        _ => CLAUDE_DEFAULT_CONTEXT_WINDOW,
    }
}

/// `resolveClaudeCompactPercentThreshold` — reads `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
fn resolve_claude_compact_percent_threshold() -> i64 {
    let override_val = std::env::var("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")
        .ok()
        .and_then(|v| to_finite_number(&Value::String(v)));
    match override_val {
        Some(o) if o >= 1.0 => (o.round() as i64).min(CLAUDE_DEFAULT_COMPACT_PERCENT),
        _ => CLAUDE_DEFAULT_COMPACT_PERCENT,
    }
}

fn normalize_compact_percent(numerator: i64, denominator: i64) -> i64 {
    if denominator <= 0 {
        return 0;
    }
    let ratio = ((numerator as f64 / denominator as f64) * 100.0).round() as i64;
    ratio.clamp(0, 100)
}

/// Options mirroring `ParseSessionOptions` in the reference. Defaults = all `None`.
#[derive(Debug, Clone, Default)]
pub struct ParseSessionOptions {
    pub fallback_session_id: Option<String>,
    pub compact_threshold_tokens: Option<i64>,
    pub context_tokens: Option<i64>,
}

fn as_trimmed_nonempty(v: &Value) -> Option<&str> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// `assistantHasVisibleContent`.
fn assistant_has_visible_content(message: &Value) -> bool {
    if let Some(s) = message.as_str() {
        return !s.trim().is_empty();
    }
    if !message.is_object() {
        return false;
    }
    let content = message.get("content");
    match content {
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(blocks)) => blocks.iter().any(|block| {
            if let Some(s) = block.as_str() {
                return !s.trim().is_empty();
            }
            if !block.is_object() {
                return false;
            }
            let ty = block.get("type").and_then(Value::as_str);
            if ty == Some("tool_use") || ty == Some("tool_result") {
                return true;
            }
            if ty == Some("text") {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    return !t.trim().is_empty();
                }
            }
            if ty == Some("thinking") {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    return !t.trim().is_empty();
                }
            }
            if ty == Some("reasoning") {
                if let Some(t) = block.get("reasoning").and_then(Value::as_str) {
                    return !t.trim().is_empty();
                }
            }
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                return !t.trim().is_empty();
            }
            false
        }),
        _ => false,
    }
}

/// `isClaudeSemanticRecord`.
fn is_claude_semantic_record(obj: &Value) -> bool {
    let ty = obj.get("type").and_then(Value::as_str);
    if ty == Some("system") {
        return obj.get("subtype").and_then(Value::as_str) == Some("init");
    }
    if ty == Some("result") {
        return true;
    }
    let role = obj.get("role").and_then(Value::as_str);
    let msg_role = obj
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str);
    if ty == Some("user") || role == Some("user") || msg_role == Some("user") {
        return true;
    }
    if ty == Some("assistant") || role == Some("assistant") || msg_role == Some("assistant") {
        let message = obj.get("message").unwrap_or(obj);
        return assistant_has_visible_content(message);
    }
    false
}

/// `resolveClaudeSemanticTimestampMs`.
fn resolve_claude_semantic_timestamp_ms(
    obj: &Value,
    created_at: Option<i64>,
    last_activity_at: Option<i64>,
) -> Option<i64> {
    if let Some(ts) = obj.get("timestamp") {
        if let Some(explicit) = parse_timestamp_ms(ts) {
            return Some(explicit);
        }
    }
    if obj.get("type").and_then(Value::as_str) == Some("result") {
        let base_at = last_activity_at.or(created_at)?;
        let duration_ms = obj
            .get("duration_ms")
            .and_then(to_finite_number)
            .unwrap_or(1.0);
        return Some(base_at + (duration_ms.round() as i64).max(1));
    }
    None
}

fn extract_user_content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let mut text_parts: Vec<String> = Vec::new();
            for part in parts {
                if let Some(s) = part.as_str() {
                    text_parts.push(s.to_string());
                } else if let Some(t) = part.get("text").and_then(Value::as_str) {
                    text_parts.push(t.to_string());
                }
            }
            if text_parts.is_empty() {
                None
            } else {
                Some(text_parts.join("\n"))
            }
        }
        Value::Object(_) => content
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    }
}

fn extract_user_message_text(obj: &Value) -> Option<String> {
    if obj.get("role").and_then(Value::as_str) == Some("user") {
        if let Some(direct) = obj.get("content").and_then(extract_user_content_text) {
            if !direct.is_empty() {
                return Some(direct);
            }
        }
    }
    if obj
        .get("message")
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        == Some("user")
    {
        return obj
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(extract_user_content_text);
    }
    None
}

fn assistant_usage_dedup_key(obj: &Value, line: &str) -> String {
    if let Some(uuid) = obj.get("uuid").and_then(Value::as_str) {
        let uuid = uuid.trim();
        if !uuid.is_empty() {
            return format!("uuid:{uuid}");
        }
    }
    if let Some(id) = obj
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str)
    {
        let id = id.trim();
        if !id.is_empty() {
            return format!("message:{id}");
        }
    }
    // Reference uses `line:${sha1(line)}`. The hash value never surfaces; it only needs
    // to dedupe identical lines within a single parse, so the raw line is an exact
    // behavioral equivalent (identical lines collide, distinct lines do not).
    format!("line:{line}")
}

struct LatestUsage {
    input_tokens: i64,
    output_tokens: i64,
    cached_tokens: i64,
}

/// `parseSessionContent(content, options)`.
pub fn parse_session_content(content: &str, options: &ParseSessionOptions) -> ParsedSessionMeta {
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
    let mut custom_title: Option<String> = None;
    let mut agent_name: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut first_user_message: Option<String> = None;
    let mut git_branch: Option<String> = None;
    let mut is_dirty: Option<bool> = None;
    let mut model: Option<String> = None;
    let mut user_message_count: i64 = 0;
    let mut usage_seen: HashSet<String> = HashSet::new();
    let mut latest_usage: Option<LatestUsage> = None;

    for line in &lines {
        let obj: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if is_claude_semantic_record(&obj) {
            if let Some(at) =
                resolve_claude_semantic_timestamp_ms(&obj, created_at, last_activity_at)
            {
                created_at = Some(created_at.map_or(at, |c| c.min(at)));
                last_activity_at = Some(last_activity_at.map_or(at, |l| l.max(at)));
            }
        }

        if session_id.is_none() {
            let candidates = [
                obj.get("sessionId"),
                obj.get("session_id"),
                obj.get("message").and_then(|m| m.get("sessionId")),
                obj.get("message").and_then(|m| m.get("session_id")),
                obj.get("data").and_then(|m| m.get("sessionId")),
                obj.get("data").and_then(|m| m.get("session_id")),
            ];
            for cand in candidates.into_iter().flatten() {
                if let Some(s) = cand.as_str() {
                    if is_canonical_claude_session_id(s) {
                        session_id = Some(s.to_string());
                        break;
                    }
                }
            }
        }

        if model.is_none() {
            for cand in [
                obj.get("model"),
                obj.get("message").and_then(|m| m.get("model")),
            ]
            .into_iter()
            .flatten()
            {
                if let Some(s) = as_trimmed_nonempty(cand) {
                    model = Some(s.to_string());
                    break;
                }
            }
        }

        let user_message_text = extract_user_message_text(&obj);
        let user_authored_text = user_message_text
            .as_deref()
            .and_then(extract_user_authored_text);
        if user_authored_text.is_some() {
            user_message_count += 1;
        }

        if cwd.is_none() {
            let candidates = [
                obj.get("cwd"),
                obj.get("context").and_then(|m| m.get("cwd")),
                obj.get("payload").and_then(|m| m.get("cwd")),
                obj.get("data").and_then(|m| m.get("cwd")),
                obj.get("message").and_then(|m| m.get("cwd")),
            ];
            for cand in candidates.into_iter().flatten() {
                if let Some(s) = cand.as_str() {
                    if looks_like_path(s) {
                        cwd = Some(s.to_string());
                        break;
                    }
                }
            }
        }

        if title.is_none() {
            let explicit = obj
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| obj.get("sessionTitle").and_then(Value::as_str));
            if let Some(explicit) = explicit.filter(|s| !s.trim().is_empty()) {
                title = Some(extract_title_from_message(explicit, 200));
            } else if let Some(txt) = &user_authored_text {
                title = Some(extract_title_from_message(txt, 200));
            }
        }

        if obj.get("type").and_then(Value::as_str) == Some("custom-title") {
            if let Some(ct) = obj.get("customTitle").and_then(as_trimmed_nonempty) {
                custom_title = Some(slice_chars(ct, 200));
            }
        }
        if obj.get("type").and_then(Value::as_str) == Some("agent-name") {
            if let Some(an) = obj.get("agentName").and_then(as_trimmed_nonempty) {
                agent_name = Some(slice_chars(an, 200));
            }
        }

        if first_user_message.is_none() {
            if let Some(txt) = &user_authored_text {
                if let Some(normalized) = normalize_first_user_message(txt) {
                    first_user_message = Some(normalized);
                }
            }
        }

        if summary.is_none() {
            let s = obj
                .get("summary")
                .and_then(as_trimmed_nonempty)
                .or_else(|| obj.get("sessionSummary").and_then(as_trimmed_nonempty));
            if let Some(s) = s {
                summary = Some(slice_chars(s, 240));
            }
        }

        if git_branch.is_none() {
            let candidates = [
                obj.get("git").and_then(|g| g.get("branch")),
                obj.get("payload")
                    .and_then(|p| p.get("git"))
                    .and_then(|g| g.get("branch")),
                obj.get("message")
                    .and_then(|m| m.get("git"))
                    .and_then(|g| g.get("branch")),
            ];
            for cand in candidates.into_iter().flatten() {
                if let Some(s) = as_trimmed_nonempty(cand) {
                    git_branch = Some(s.to_string());
                    break;
                }
            }
        }

        if is_dirty.is_none() {
            let candidates = [
                obj.get("git").and_then(|g| g.get("dirty")),
                obj.get("git").and_then(|g| g.get("isDirty")),
                obj.get("payload")
                    .and_then(|p| p.get("git"))
                    .and_then(|g| g.get("dirty")),
                obj.get("payload")
                    .and_then(|p| p.get("git"))
                    .and_then(|g| g.get("isDirty")),
                obj.get("message")
                    .and_then(|m| m.get("git"))
                    .and_then(|g| g.get("dirty")),
                obj.get("message")
                    .and_then(|m| m.get("git"))
                    .and_then(|g| g.get("isDirty")),
            ];
            for cand in candidates.into_iter().flatten() {
                if let Some(b) = cand.as_bool() {
                    is_dirty = Some(b);
                    break;
                }
            }
        }

        let is_assistant_entry = obj.get("type").and_then(Value::as_str) == Some("assistant")
            || obj.get("role").and_then(Value::as_str) == Some("assistant")
            || obj
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(Value::as_str)
                == Some("assistant");

        let usage = obj.get("message").and_then(|m| m.get("usage"));
        if is_assistant_entry {
            if let Some(usage) = usage.filter(|u| u.is_object()) {
                let dedup_key = assistant_usage_dedup_key(&obj, line);
                if usage_seen.insert(dedup_key) {
                    let input = usage
                        .get("input_tokens")
                        .and_then(to_finite_number)
                        .unwrap_or(0.0);
                    let output = usage
                        .get("output_tokens")
                        .and_then(to_finite_number)
                        .unwrap_or(0.0);
                    let cache_read = usage
                        .get("cache_read_input_tokens")
                        .and_then(to_finite_number)
                        .unwrap_or(0.0);
                    let cache_creation = usage
                        .get("cache_creation_input_tokens")
                        .and_then(to_finite_number)
                        .unwrap_or(0.0);
                    latest_usage = Some(LatestUsage {
                        input_tokens: input as i64,
                        output_tokens: output as i64,
                        cached_tokens: (cache_read + cache_creation) as i64,
                    });
                }
            }
        }
    }

    let is_non_interactive = if user_message_count <= 1 {
        Some(true)
    } else {
        None
    };

    if session_id.is_none() {
        if let Some(fallback) = &options.fallback_session_id {
            if is_canonical_claude_session_id(fallback) {
                session_id = Some(fallback.clone());
            }
        }
    }

    let token_usage = latest_usage.map(|u| {
        let context_tokens_from_usage = u.input_tokens + u.output_tokens + u.cached_tokens;
        let context_tokens = options.context_tokens.unwrap_or(context_tokens_from_usage);
        let model_context_window = claude_model_context_window(model.as_deref());
        let compact_threshold_tokens = options.compact_threshold_tokens.unwrap_or_else(|| {
            ((model_context_window * resolve_claude_compact_percent_threshold()) as f64 / 100.0)
                .round() as i64
        });
        TokenSummary {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cached_tokens: u.cached_tokens,
            total_tokens: context_tokens,
            context_tokens: Some(context_tokens),
            model_context_window: Some(model_context_window),
            compact_threshold_tokens: Some(compact_threshold_tokens),
            compact_percent: Some(normalize_compact_percent(
                context_tokens,
                compact_threshold_tokens,
            )),
        }
    });

    ParsedSessionMeta {
        session_id,
        cwd,
        created_at,
        last_activity_at,
        title: custom_title.or(agent_name).or(title),
        summary,
        first_user_message,
        message_count: lines.len() as i64,
        is_subagent: None,
        is_non_interactive,
        git_branch,
        is_dirty,
        token_usage,
        codex_task_events: None,
    }
}

/// `slice(0, n)` on a JS string (code-point truncation for the BMP text here).
fn slice_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

//! The claude sidecar's non-terminal provider events (transcript-live plan
//! §4.2, principle P4): an API request the CLI retries (`sdk.retry`) and a
//! notice (`sdk.notice`: a rate limit, an informational banner, a failed
//! compaction). Both are broadcast to every client unchanged (as
//! `freshAgent.retry` / `freshAgent.notice`), and neither ends the turn or
//! touches the session's status.
//!
//! [`log_provider_event`] logs them under the id the pane knows the session
//! by. The sidecar logs the same events under its own id (its stderr records
//! are re-emitted as `freshagent.claude.sidecar_log`, G14); these records tie
//! them to the pane. Like the sidecar's records they carry ids, numbers and
//! codes only: a notice's text is logged by its size, because an
//! informational banner can carry user content.

use serde_json::Value;

const PROVIDER: &str = "claude";

/// Log one sidecar line if it is a retry or a notice; other lines are ignored.
/// `session_id` is the envelope stamp the broadcast carries.
pub(crate) fn log_provider_event(line: &Value, session_id: &str, session_type: &str) {
    match line.get("type").and_then(Value::as_str) {
        Some("sdk.retry") => log_retry(line, session_id, session_type),
        Some("sdk.notice") => log_notice(line, session_id, session_type),
        _ => {}
    }
}

fn log_retry(line: &Value, session_id: &str, session_type: &str) {
    let attempt = line.get("attempt").and_then(Value::as_u64);
    let max_retries = line.get("maxRetries").and_then(Value::as_u64);
    let delay_ms = line.get("delayMs").and_then(Value::as_u64);
    let error_status = line.get("errorStatus").and_then(Value::as_u64);
    let error = line.get("error").and_then(Value::as_str).unwrap_or("");
    // Info, not warn: the sidecar's own record of the retry is the warning.
    tracing::info!(
        target: "freshell_freshagent::claude",
        event = "freshagent.claude.api_retry",
        provider = PROVIDER,
        session_id,
        session_type,
        attempt,
        max_retries,
        delay_ms,
        error_status,
        error,
        "the claude CLI is retrying a failed API request"
    );
}

fn log_notice(line: &Value, session_id: &str, session_type: &str) {
    let level = line.get("level").and_then(Value::as_str).unwrap_or("info");
    let code = line.get("code").and_then(Value::as_str).unwrap_or("");
    let message_bytes = line
        .get("message")
        .and_then(Value::as_str)
        .map_or(0, str::len);
    let rate_limit = line.get("rateLimit");
    let rate_limit_field = |key: &str| {
        rate_limit
            .and_then(|limit| limit.get(key))
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
    };
    let rate_limit_status = rate_limit_field("status");
    let rate_limit_type = rate_limit_field("rateLimitType");
    let resets_at = rate_limit_field("resetsAt");
    // A provider notice is never a server fault: an error-level notice (a
    // reached usage limit, a failed compaction) is a warning here.
    macro_rules! notice {
        ($macro:ident) => {
            tracing::$macro!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.notice",
                provider = PROVIDER,
                session_id,
                session_type,
                level,
                code,
                message_bytes,
                rate_limit_status = rate_limit_status.as_deref(),
                rate_limit_type = rate_limit_type.as_deref(),
                resets_at = resets_at.as_deref(),
                "the claude CLI reported a notice"
            )
        };
    }
    match level {
        "error" | "warning" => notice!(warn),
        _ => notice!(info),
    }
}

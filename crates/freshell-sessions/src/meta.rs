//! Parsed session metadata types.
//!
//! 1:1 port of the relevant shapes from `server/coding-cli/types.ts`
//! (`ParsedSessionMeta`, `TokenSummary`, `CodexTaskEventSnapshot`). Every field is
//! optional and mirrors the TS `undefined`-vs-present semantics so the parity tests
//! can compare field-for-field against the reference `parseSessionContent` output.

/// Session-level token aggregate (`TokenSummary` in `types.ts`).
///
/// `context_tokens` / `model_context_window` / `compact_threshold_tokens` /
/// `compact_percent` are `Option` because the codex envelope can omit them while the
/// claude path always fills them.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenSummary {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub total_tokens: i64,
    pub context_tokens: Option<i64>,
    pub model_context_window: Option<i64>,
    pub compact_threshold_tokens: Option<i64>,
    pub compact_percent: Option<i64>,
}

/// Codex task-event recency snapshot (`CodexTaskEventSnapshot` in `types.ts`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CodexTaskEventSnapshot {
    pub latest_task_started_at: Option<i64>,
    pub latest_task_completed_at: Option<i64>,
    pub latest_turn_aborted_at: Option<i64>,
}

impl CodexTaskEventSnapshot {
    pub fn is_empty(&self) -> bool {
        self.latest_task_started_at.is_none()
            && self.latest_task_completed_at.is_none()
            && self.latest_turn_aborted_at.is_none()
    }
}

/// The read-only parse result for a single transcript (`ParsedSessionMeta` in `types.ts`).
///
/// `message_count` is the count of non-empty lines (the reference `lines.length` after
/// `.split(/\r?\n/).filter(Boolean)`) — it counts corrupt/unparseable lines too, which
/// is exactly the reference's corruption-tolerant behavior.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedSessionMeta {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub first_user_message: Option<String>,
    pub message_count: i64,
    pub is_subagent: Option<bool>,
    pub is_non_interactive: Option<bool>,
    pub git_branch: Option<String>,
    pub is_dirty: Option<bool>,
    pub token_usage: Option<TokenSummary>,
    pub codex_task_events: Option<CodexTaskEventSnapshot>,
}

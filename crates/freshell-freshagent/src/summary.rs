//! Shared fresh-agent turn-summary dialect policy. Every provider adapter's
//! snapshot builder produces a per-turn `summary` plus a `summaryKind`
//! provenance tag:
//!
//! - [`SUMMARY_KIND_ECHO`] — the summary is a mechanical projection of the
//!   turn's own items (a tool name, a command line, a text excerpt, a
//!   tool-result label). It carries no content beyond what the items render,
//!   so the client may treat it as a foldable caption.
//! - [`SUMMARY_KIND_AUTHORED`] — provider-written summary prose with no item
//!   counterpart (today: ONLY codex `reasoning` items with a non-empty
//!   provider `summary` array). The client treats it as a permanent
//!   transcript boundary and never folds it.
//!
//! One truncation policy (140 chars) and one tool-result label set apply to
//! every producer. 140 matches the reference TS codex normalizer's
//! `.slice(0, 140)`; char-based (not UTF-16 code-unit) is the documented,
//! acceptable divergence for non-BMP text.

/// Character cap for every fresh-agent turn summary, all providers.
pub(crate) const SUMMARY_MAX_CHARS: usize = 140;

/// Char-safe truncation to [`SUMMARY_MAX_CHARS`].
pub(crate) fn truncate_summary(text: &str) -> String {
    text.chars().take(SUMMARY_MAX_CHARS).collect()
}

/// The single tool-result summary label (unifies codex's `"Tool result"` and
/// claude's `"[tool result]"` dialects).
pub(crate) const TOOL_RESULT_LABEL: &str = "Tool result";

/// Error variant of [`TOOL_RESULT_LABEL`].
pub(crate) const TOOL_ERROR_LABEL: &str = "Tool error";

/// `summaryKind` value for mechanical projections of the turn's own items.
pub(crate) const SUMMARY_KIND_ECHO: &str = "echo";

/// `summaryKind` value for provider-written summary prose.
pub(crate) const SUMMARY_KIND_AUTHORED: &str = "authored";

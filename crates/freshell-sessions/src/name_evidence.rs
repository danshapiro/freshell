//! The shared default/derived name classifier: one definition of "this text
//! is a default or derived label, not a name a session earned".
//!
//! Twin of `shared/name-evidence.ts`. Both implementations are pinned by the
//! same table, `test/fixtures/name-evidence/cases.json` (consumed by
//! `tests/name_evidence.rs` here and `test/unit/shared/name-evidence.test.ts`
//! on the client), so they cannot drift. Change the rules in both places and
//! add the fixture rows that pin the change.
//!
//! A name is default/derived when, after trimming, it is empty or:
//! - a generated tab label: `Tab <digits>` (exact case, one space);
//! - the basename of the known working directory (only when a cwd is given,
//!   so a caller without a folder recognizes only folder-free patterns);
//! - a provider or mode label (`Claude`, `Claude CLI`, `Codex`, `Codex CLI`,
//!   `OpenCode`, `Shell`, `Freshclaude`, `Freshcodex`, `Freshopencode`,
//!   `Kilroy`, `Gemini`, `Kimi`, `Amplifier`), optionally prefixed with
//!   `Recovered ` and/or suffixed with ` agent`, ASCII case-insensitive;
//! - one of the bare words `Recovered`, `Untitled`, `Tab` (case-insensitive);
//! - a provider placeholder title ([`is_provider_placeholder_title`]) for the
//!   context's provider (else its mode); with neither known, any provider's;
//! - text that opens with a tool wrapper tag
//!   ([`crate::text::starts_with_context_tag`]). Only that leading-tag check
//!   is used: the rest of `is_system_context` would also flag real names such
//!   as `$ ls -la` or `1, 2, 3`.
//!
//! Pure functions, no IO; callers log their own decisions.

use crate::parse::is_opencode_placeholder_title;
use crate::text::starts_with_context_tag;

/// What the caller knows about the target of a name. Every field is
/// optional; an unknown field only narrows what can be recognized (no cwd →
/// no folder-name rule), it never makes a real name look like a default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NameEvidenceContext<'a> {
    /// The target's working directory; its basename is a derived label.
    pub cwd: Option<&'a str>,
    /// The session provider wire string (`claude`, `codex`, `opencode`).
    pub provider: Option<&'a str>,
    /// The pane/terminal mode; stands in for `provider` when that is unknown.
    pub mode: Option<&'a str>,
}

/// Provider and mode labels, lowercase. Matched after removing an optional
/// `recovered ` prefix and ` agent` suffix.
const PROVIDER_OR_MODE_LABELS: &[&str] = &[
    "claude",
    "claude cli",
    "codex",
    "codex cli",
    "opencode",
    "shell",
    "freshclaude",
    "freshcodex",
    "freshopencode",
    "kilroy",
    "gemini",
    "kimi",
    "amplifier",
];

/// Bare default words, lowercase.
const BARE_DEFAULT_WORDS: &[&str] = &["recovered", "untitled", "tab"];

/// Providers that mint placeholder titles of their own.
const PLACEHOLDER_PROVIDERS: &[&str] = &["opencode"];

/// Whether `name` is a default or derived label rather than a real name.
/// See the module docs for the exact rules.
pub fn is_default_or_derived_name(name: &str, ctx: &NameEvidenceContext<'_>) -> bool {
    let name = name.trim();
    name.is_empty()
        || is_tab_number_label(name)
        || is_cwd_basename(name, ctx.cwd)
        || is_provider_or_mode_label(name)
        || is_placeholder_for_context(name, ctx)
        || starts_with_context_tag(name)
}

/// Whether `title` is a placeholder the given provider writes for a session
/// it has not named yet. Only OpenCode has them (`New session - <ISO>`,
/// `Child session - <ISO>`, legacy `New Session - <ISO>`); the answer for
/// OpenCode is exactly the directory index's own predicate. Not trimmed, so
/// it agrees with that predicate byte for byte.
pub fn is_provider_placeholder_title(provider: &str, title: &str) -> bool {
    match provider {
        "opencode" => is_opencode_placeholder_title(title),
        _ => false,
    }
}

/// The client's generated tab label, `Tab <digits>`: exact case, one space,
/// ASCII digits, nothing else (the `^Tab \d+$` rule).
fn is_tab_number_label(text: &str) -> bool {
    text.strip_prefix("Tab ")
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn is_cwd_basename(name: &str, cwd: Option<&str>) -> bool {
    cwd.and_then(basename_segment)
        .is_some_and(|segment| segment == name)
}

fn is_provider_or_mode_label(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if BARE_DEFAULT_WORDS.contains(&lower.as_str()) {
        return true;
    }
    let core = lower.strip_prefix("recovered ").unwrap_or(&lower);
    let core = core.strip_suffix(" agent").unwrap_or(core);
    PROVIDER_OR_MODE_LABELS.contains(&core)
}

fn is_placeholder_for_context(name: &str, ctx: &NameEvidenceContext<'_>) -> bool {
    fn non_empty(value: Option<&str>) -> Option<&str> {
        value.filter(|v| !v.is_empty())
    }
    match non_empty(ctx.provider).or_else(|| non_empty(ctx.mode)) {
        Some(provider) => is_provider_placeholder_title(provider, name),
        None => PLACEHOLDER_PROVIDERS
            .iter()
            .any(|provider| is_provider_placeholder_title(provider, name)),
    }
}

/// `shared/path-basename.ts` `basenameSegment`: the last path segment,
/// either separator, trailing separators ignored, `/` for the Unix root and
/// `C:\` for a bare drive.
fn basename_segment(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return path.starts_with('/').then(|| "/".to_string());
    }
    let b = trimmed.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Some(format!("{trimmed}\\"));
    }
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|last| !last.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_number_label_is_exact() {
        assert!(is_tab_number_label("Tab 1"));
        assert!(is_tab_number_label("Tab 2048"));
        assert!(!is_tab_number_label("Tab"));
        assert!(!is_tab_number_label("Tab "));
        assert!(!is_tab_number_label(" Tab 1"));
        assert!(!is_tab_number_label("Tab 1 "));
        assert!(!is_tab_number_label("tab 1"));
        assert!(!is_tab_number_label("Tab  1"));
        assert!(!is_tab_number_label("Tab ١"));
    }

    #[test]
    fn basename_matches_the_shared_helper() {
        assert_eq!(
            basename_segment("/home/dan/code/freshell").as_deref(),
            Some("freshell")
        );
        assert_eq!(
            basename_segment("/home/dan/code/freshell//").as_deref(),
            Some("freshell")
        );
        assert_eq!(basename_segment("/").as_deref(), Some("/"));
        assert_eq!(
            basename_segment("C:\\Users\\dan\\proj").as_deref(),
            Some("proj")
        );
        assert_eq!(basename_segment("C:").as_deref(), Some("C:\\"));
        assert_eq!(basename_segment(""), None);
    }
}

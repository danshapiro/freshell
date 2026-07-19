//! `freshell-sessions` — Layer C of the freshell Rust port.
//!
//! Read-only coding-CLI transcript **indexer** + **parsers**. This crate is a faithful,
//! additive port of `server/coding-cli/{providers/{claude,codex,opencode},session-indexer}.ts`.
//! It never mutates provider data (transcripts, databases) — it only reads and indexes.
//!
//! Two responsibilities (ADR Decision 1.1, `port/machine/architecture-spec.md`):
//!
//! 1. [`parse`] — the three transcript parsers (claude `.jsonl`, codex rollout `.jsonl`,
//!    opencode `opencode.db`). Corruption-tolerant: a malformed line/row can never panic
//!    the parse. Graded by T2 `transcript.parseable` and pinned to the committed fixtures.
//! 2. [`indexer`] — the `notify` file-watcher that discovers provider transcript roots and
//!    emits change events, carrying the **DEV-0002** process-liveness fix (late-root
//!    watcher must log + degrade + rescan, never abort). Pinned by the mandatory liveness
//!    test in `tests/late_root_watcher_liveness.rs`.

pub mod amplifier;
pub mod amplifier_locator;
pub mod directory_index;
pub mod indexer;
pub mod meta;
pub mod opencode_locator;
pub mod parse;
pub mod search;
pub mod text;
pub mod time;

pub use meta::{CodexTaskEventSnapshot, ParsedSessionMeta, TokenSummary};
pub use parse::{parse_codex_session_content, parse_session_content, ParseSessionOptions};
pub use search::{extract_snippet, search_session_file, FileSearchMatch, FileSearchTier};

#[cfg(test)]
mod tests {
    //! Fast in-crate unit tests for the string/time helpers. Fixture-parity and the
    //! DEV-0002 liveness pin live in `tests/` (integration tests, so they can read the
    //! committed fixture files).
    use super::text::*;
    use super::time::*;
    use serde_json::json;

    #[test]
    fn canonical_claude_session_id_matches_reference_regex() {
        // Real UUID from the real-corrupted fixture.
        assert!(is_canonical_claude_session_id(
            "b7936c10-4935-441c-837c-c1f33cafec2d"
        ));
        assert!(is_canonical_claude_session_id(
            "550e8400-e29b-41d4-a716-446655440000"
        ));
        // Fixture "session ids" that are NOT canonical (why healthy.jsonl has no sessionId).
        assert!(!is_canonical_claude_session_id("healthy-session-id"));
        assert!(!is_canonical_claude_session_id("malformed-id"));
        assert!(!is_canonical_claude_session_id("not-a-uuid"));
        // Wrong version / variant nibble.
        assert!(!is_canonical_claude_session_id(
            "550e8400-e29b-61d4-a716-446655440000"
        ));
        assert!(!is_canonical_claude_session_id(
            "550e8400-e29b-41d4-c716-446655440000"
        ));
    }

    #[test]
    fn looks_like_path_rejects_urls_accepts_paths() {
        assert!(looks_like_path("/home/user/project"));
        assert!(looks_like_path("D:\\Users\\Dan\\code"));
        assert!(looks_like_path("~"));
        assert!(!looks_like_path("https://example.com/x"));
        assert!(!looks_like_path("s3://bucket/key"));
        assert!(!looks_like_path("plain-text"));
    }

    #[test]
    fn title_extraction_collapses_and_truncates() {
        assert_eq!(
            extract_title_from_message("  Multiple   spaces   here  ", 200),
            "Multiple spaces here"
        );
        assert_eq!(
            extract_title_from_message(&"A".repeat(250), 200),
            "A".repeat(200)
        );
        // Multi-line uses the first non-empty line.
        assert_eq!(
            extract_title_from_message("\n\nFirst line\nSecond", 200),
            "First line"
        );
    }

    #[test]
    fn system_context_is_skipped_for_authored_text() {
        // Matches the reference claude-provider tests.
        assert_eq!(
            extract_user_authored_text("Fix the login bug").as_deref(),
            Some("Fix the login bug")
        );
        assert_eq!(
            extract_user_authored_text("[SUGGESTION MODE: suggest...] FIRST: look").as_deref(),
            None
        );
        assert_eq!(
            extract_user_authored_text("<environment_context>\nctx\n</environment_context>")
                .as_deref(),
            None
        );
        assert_eq!(
            extract_user_authored_text("# AGENTS.md instructions\n\nrules").as_deref(),
            None
        );
    }

    #[test]
    fn ide_context_request_is_extracted() {
        let ide = "# Context from my IDE setup:\n## My codebase\nReact\n## My request for Codex:\nFix the authentication bug in the login form";
        assert_eq!(
            extract_user_authored_text(ide).as_deref(),
            Some("Fix the authentication bug in the login form")
        );
    }

    #[test]
    fn timestamps_match_date_parse_for_fixture_values() {
        // Cross-checks against the reference ground truth captured from parseSessionContent.
        assert_eq!(
            parse_timestamp_ms(&json!("2025-01-30T10:00:00.000Z")),
            Some(1_738_231_200_000)
        );
        assert_eq!(
            parse_timestamp_ms(&json!("2026-01-30T06:15:56.713Z")),
            Some(1_769_753_756_713)
        );
        assert_eq!(
            parse_timestamp_ms(&json!("2026-03-01T00:00:06.000Z")),
            Some(1_772_323_206_000)
        );
        // Numeric passthrough + non-finite rejection.
        assert_eq!(
            parse_timestamp_ms(&json!(1_738_231_200_000i64)),
            Some(1_738_231_200_000)
        );
        assert_eq!(parse_timestamp_ms(&json!("not a date")), None);
    }
}

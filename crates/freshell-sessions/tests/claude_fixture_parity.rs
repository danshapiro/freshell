//! Fixture-parity for the claude `.jsonl` parser.
//!
//! Every expected value below was captured by running the REFERENCE parser
//! (`dist/server/coding-cli/providers/claude.js` `parseSessionContent`) over each
//! committed fixture in `test/fixtures/sessions/`. The Rust `parse_session_content` must
//! reproduce the reference output exactly — including the corruption tolerance the
//! fixtures encode:
//!
//! - healthy            -> full parse; `message_count == 6`
//! - corrupted-shallow  -> orphaned `progress` record tolerated; `message_count == 8`
//! - corrupted-deep     -> deep orphan chain tolerated; `message_count == 21`
//! - corrupted-multiple -> multiple orphaned progress records tolerated; `count == 12`
//! - malformed          -> 2 unparseable lines skipped, 4 valid parsed; `count == 6`
//! - no-uuid            -> no session id (no canonical UUID present); `count == 2`
//! - empty              -> empty meta; `message_count == 0`
//! - real-corrupted     -> real Windows transcript: full metadata + token usage
//!
//! Note the reference only sets `session_id` when a *canonical UUID* is present, which is
//! why the human-readable "…-corrupted-id" / "healthy-session-id" values yield `None`.

use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::{parse_session_content, ParseSessionOptions, TokenSummary};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/sessions")
}

fn parse_fixture(name: &str) -> ParsedSessionMeta {
    let path = fixtures_dir().join(name);
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()));
    parse_session_content(&content, &ParseSessionOptions::default())
}

/// A transcript with only `created_at`/`last_activity_at`/`message_count` set and marked
/// non-interactive (the common "corrupted but tolerated" fixture shape).
fn clock_only(created: i64, last: i64, message_count: i64) -> ParsedSessionMeta {
    ParsedSessionMeta {
        created_at: Some(created),
        last_activity_at: Some(last),
        message_count,
        is_non_interactive: Some(true),
        ..Default::default()
    }
}

#[test]
fn healthy_parses_all_six_lines_no_uuid_session_id() {
    // "healthy-session-id" is not a canonical UUID -> session_id stays None.
    assert_eq!(parse_fixture("healthy.jsonl"), clock_only(1_738_231_200_000, 1_738_231_205_000, 6));
}

#[test]
fn corrupted_shallow_tolerates_orphaned_progress_record() {
    assert_eq!(parse_fixture("corrupted-shallow.jsonl"), clock_only(1_738_231_200_000, 1_738_231_206_000, 8));
}

#[test]
fn corrupted_deep_tolerates_deep_orphan_chain() {
    assert_eq!(parse_fixture("corrupted-deep.jsonl"), clock_only(1_738_231_200_000, 1_738_231_220_000, 21));
}

#[test]
fn corrupted_multiple_tolerates_multiple_orphans() {
    assert_eq!(parse_fixture("corrupted-multiple.jsonl"), clock_only(1_738_231_200_000, 1_738_231_211_000, 12));
}

#[test]
fn malformed_skips_two_bad_lines_but_counts_all_six() {
    // Lines "this is not valid json" and "{\"incomplete json" are skipped by JSON.parse,
    // but still counted (non-empty). Session id from the valid init line is "malformed-id"
    // — not a UUID — so session_id is None.
    assert_eq!(parse_fixture("malformed.jsonl"), clock_only(1_738_231_200_000, 1_738_231_203_000, 6));
}

#[test]
fn no_uuid_yields_no_session_id() {
    assert_eq!(
        parse_fixture("no-uuid.jsonl"),
        ParsedSessionMeta { message_count: 2, is_non_interactive: Some(true), ..Default::default() }
    );
}

#[test]
fn empty_yields_empty_meta() {
    assert_eq!(
        parse_fixture("empty.jsonl"),
        ParsedSessionMeta { message_count: 0, is_non_interactive: Some(true), ..Default::default() }
    );
}

#[test]
fn inline_and_sibling_stop_hook_progress_parse_identically() {
    let expected = clock_only(1_769_767_200_000, 1_769_767_201_000, 5);
    assert_eq!(parse_fixture("inline-stop-hook-progress.jsonl"), expected);
    assert_eq!(parse_fixture("sibling-stop-hook-progress.jsonl"), expected);
}

#[test]
fn real_corrupted_extracts_full_metadata_and_token_usage() {
    let meta = parse_fixture("real-corrupted.jsonl");
    let expected = ParsedSessionMeta {
        session_id: Some("b7936c10-4935-441c-837c-c1f33cafec2d".to_string()),
        cwd: Some("D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell".to_string()),
        created_at: Some(1_769_753_756_713),
        last_activity_at: Some(1_769_753_759_234),
        title: Some("Test session 1".to_string()),
        summary: Some("Test Session 1".to_string()),
        first_user_message: Some("Test session 1".to_string()),
        message_count: 6,
        is_non_interactive: Some(true),
        token_usage: Some(TokenSummary {
            input_tokens: 10,
            output_tokens: 4,
            // cache_read_input_tokens (16197) + cache_creation_input_tokens (5361) = 21558
            cached_tokens: 21_558,
            total_tokens: 21_572,
            context_tokens: Some(21_572),
            model_context_window: Some(200_000),
            compact_threshold_tokens: Some(190_000),
            compact_percent: Some(11),
        }),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn malformed_line_never_panics_across_all_committed_fixtures() {
    // The corruption-tolerance guarantee: parsing any committed fixture returns Ok-shaped
    // metadata (no panic/abort), whatever garbage the file contains.
    for name in [
        "healthy.jsonl",
        "corrupted-shallow.jsonl",
        "corrupted-deep.jsonl",
        "corrupted-multiple.jsonl",
        "malformed.jsonl",
        "no-uuid.jsonl",
        "empty.jsonl",
        "real-corrupted.jsonl",
        "inline-stop-hook-progress.jsonl",
        "sibling-stop-hook-progress.jsonl",
    ] {
        let meta = parse_fixture(name);
        assert!(meta.message_count >= 0, "{name} produced a meta");
    }
}

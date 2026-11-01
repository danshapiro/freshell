//! Fixture-parity for the antigravity (Antigravity CLI, `agy`) transcript
//! `.jsonl` parser.
//!
//! Every fixture in `test/fixtures/coding-cli/antigravity/` exercises the
//! candidate transcript RECORD SCHEMA (Stage-1 candidate contract — see the
//! `// Stage-1 candidate contract:` header in `src/parse/antigravity.rs`).
//! The transcript PATH and the hook inputs (`conversationId`,
//! `workspacePaths`, `transcriptPath`) are documented+probe-validated
//! (Provider Contract Record, plan
//! `docs/plans/2026-10-29-google-cli-first-class-support.md`); the on-disk
//! record schema itself is fixture-validated ONLY and remains the A2 named
//! blocker — these tests pin the parser to the committed fixtures, never to
//! a real-binary claim.
//!
//! Fixtures: `fresh` (canonical single turn), `resumed` (second
//! `session_start` with `source:"resume"` — first id kept, no double-count),
//! `tool-use` (unknown record types ignored, still counted), `errored`
//! (`turn_settled` outcome `errored`, missing usage ⇒ `None`), `zero-turn`
//! (ownership record only), `two-same-dir` (two conversation ids, same
//! `workspacePaths`), `malformed-tail` (garbage line + truncated final line
//! skipped, valid prefix parsed).

use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::{parse_antigravity_session_content, TokenSummary};
use std::path::PathBuf;

fn antigravity_fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/antigravity")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The `TokenSummary` the candidate schema's usage envelope maps to (no
/// context-meter trio: the schema carries no window fields).
fn usage(input: i64, output: i64, cached: i64, total: i64) -> TokenSummary {
    TokenSummary {
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        total_tokens: total,
        context_tokens: None,
        model_context_window: None,
        compact_threshold_tokens: None,
        compact_percent: None,
    }
}

#[test]
fn fresh_fixture_matches_candidate_contract() {
    let meta = parse_antigravity_session_content(&antigravity_fixture("fresh.sanitized.jsonl"))
        .expect("ownership record yields a conversationId");
    let expected = ParsedSessionMeta {
        session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        cwd: Some("/home/u/proj".to_string()),
        created_at: Some(1_793_304_000_000),
        last_activity_at: Some(1_793_304_005_500),
        title: Some("Fix the flaky test".to_string()),
        title_provider_generated: false,
        summary: Some("Fixed the test.".to_string()),
        first_user_message: Some("Fix the flaky test".to_string()),
        message_count: 4,
        token_usage: Some(usage(10, 20, 0, 30)),
        ..Default::default()
    };
    // Titles are user-derived, never provider-generated; no native title
    // records exist in the candidate schema (explicit beyond struct equality).
    assert_eq!(meta.title_source, None);
    assert_eq!(meta, expected);
}

#[test]
fn resumed_fixture_keeps_first_id_without_double_counting() {
    let meta = parse_antigravity_session_content(&antigravity_fixture("resumed.sanitized.jsonl"))
        .expect("ownership record yields a conversationId");
    let expected = ParsedSessionMeta {
        session_id: Some("22222222-3333-4444-5555-666666666666".to_string()),
        cwd: Some("/home/u/resumed".to_string()),
        // created_at stays the FIRST session_start (min fold); the resume
        // segment's later `startedAt` folds into the max side only.
        created_at: Some(1_793_307_600_000),
        last_activity_at: Some(1_793_309_402_500),
        title: Some("First prompt before exit".to_string()),
        title_provider_generated: false,
        summary: Some("First reply.".to_string()),
        first_user_message: Some("First prompt before exit".to_string()),
        // 8 non-empty lines: the second session_start is a record, not a
        // second session — the id is kept (first wins), nothing double-counts.
        message_count: 8,
        // Last parsed usage envelope wins (the resume segment's).
        token_usage: Some(usage(15, 25, 0, 40)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn tool_use_fixture_ignores_unknown_records_but_counts_lines() {
    let meta = parse_antigravity_session_content(&antigravity_fixture("tool-use.sanitized.jsonl"))
        .expect("ownership record yields a conversationId");
    let expected = ParsedSessionMeta {
        session_id: Some("33333333-4444-5555-6666-777777777777".to_string()),
        cwd: Some("/home/u/tools".to_string()),
        created_at: Some(1_793_311_200_000),
        last_activity_at: Some(1_793_311_204_500),
        title: Some("Run the test suite".to_string()),
        title_provider_generated: false,
        summary: Some("Tests pass.".to_string()),
        first_user_message: Some("Run the test suite".to_string()),
        // Unknown record types (`tool_call`, `tool_result`) never surface as
        // messages, but every non-empty line still counts.
        message_count: 6,
        token_usage: Some(usage(100, 50, 25, 175)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn errored_fixture_parses_and_missing_usage_stays_none() {
    let meta = parse_antigravity_session_content(&antigravity_fixture("errored.sanitized.jsonl"))
        .expect("an errored turn still parses");
    let expected = ParsedSessionMeta {
        session_id: Some("44444444-5555-6666-7777-888888888888".to_string()),
        cwd: Some("/home/u/errored".to_string()),
        created_at: Some(1_793_314_800_000),
        last_activity_at: Some(1_793_314_802_500),
        title: Some("Do the failing thing".to_string()),
        title_provider_generated: false,
        summary: Some("It failed with an error.".to_string()),
        first_user_message: Some("Do the failing thing".to_string()),
        message_count: 4,
        // The assistant_message carries no `usage` object: missing usage
        // stays unknown (`None`), never a zeroed summary.
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn zero_turn_fixture_has_identity_but_no_messages() {
    let meta = parse_antigravity_session_content(&antigravity_fixture("zero-turn.sanitized.jsonl"))
        .expect("the ownership record alone is a session");
    let expected = ParsedSessionMeta {
        session_id: Some("55555555-6666-7777-8888-999999999999".to_string()),
        cwd: Some("/home/u/idle".to_string()),
        created_at: Some(1_793_318_400_000),
        last_activity_at: Some(1_793_318_400_000),
        title: None,
        title_provider_generated: false,
        summary: None,
        first_user_message: None,
        message_count: 1,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn two_same_dir_fixture_keeps_first_conversation_id() {
    let meta =
        parse_antigravity_session_content(&antigravity_fixture("two-same-dir.sanitized.jsonl"))
            .expect("ownership record yields a conversationId");
    let expected = ParsedSessionMeta {
        // Two conversation ids in one file: the FIRST recorded id wins —
        // the parser never guesses between them. (Each real transcript is
        // one conversation; this fixture pins first-id determinism.)
        session_id: Some("66666666-7777-4888-8999-000000000001".to_string()),
        cwd: Some("/home/u/shared".to_string()),
        created_at: Some(1_793_322_000_000),
        last_activity_at: Some(1_793_322_062_500),
        title: Some("Prompt in conversation one".to_string()),
        title_provider_generated: false,
        summary: Some("Reply one.".to_string()),
        first_user_message: Some("Prompt in conversation one".to_string()),
        message_count: 8,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn malformed_tail_fixture_parses_the_valid_prefix() {
    let meta =
        parse_antigravity_session_content(&antigravity_fixture("malformed-tail.sanitized.jsonl"))
            .expect("the intact prefix still owns the row");
    let expected = ParsedSessionMeta {
        session_id: Some("77777777-8888-4999-aaaa-111111111111".to_string()),
        cwd: Some("/home/u/tail".to_string()),
        created_at: Some(1_793_325_600_000),
        // The garbage line and the truncated final line move nothing; the
        // last PARSED semantic record (assistant_message 02:00:02) is the max.
        last_activity_at: Some(1_793_325_602_000),
        title: Some("Survives the corrupt tail".to_string()),
        title_provider_generated: false,
        summary: Some("Valid reply before corruption.".to_string()),
        first_user_message: Some("Survives the corrupt tail".to_string()),
        // 5 non-empty lines: the garbage and truncated lines COUNT toward
        // message_count (corruption tolerance — they are real bytes on disk).
        message_count: 5,
        token_usage: Some(usage(3, 4, 0, 7)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn title_derives_from_first_user_message_at_200_chars() {
    // Title derivation runs through `extract_title_from_message(first_user,
    // 200)`: a 250-char prompt keeps all 250 chars in `first_user_message`
    // (normalize bound is 4000) but truncates the title at 200.
    let long_prompt = "A".repeat(250);
    let content = format!(
        concat!(
            r#"{{"type":"session_start","conversationId":"t1","workspacePaths":["/w"],"startedAt":"2026-10-29T20:00:00.000Z"}}"#,
            "\n",
            r#"{{"type":"user_message","conversationId":"t1","text":"{}","at":"2026-10-29T20:00:01.000Z"}}"#,
        ),
        long_prompt
    );
    let meta = parse_antigravity_session_content(&content).expect("ownership record present");
    assert_eq!(
        meta.first_user_message.as_deref(),
        Some(long_prompt.as_str())
    );
    assert_eq!(meta.title.as_deref(), Some("A".repeat(200).as_str()));
    assert!(!meta.title_provider_generated);
}

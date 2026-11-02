//! Fixture-parity for the antigravity (Antigravity CLI, `agy`) transcript
//! `.jsonl` parser — the REAL-BINARY record contract (agy 1.2.11 + 1.4.12,
//! store-log-attributed, schemas identical, plus fresh 1.4.12 receipts;
//! corrected 2026-11-02 against real transcripts; evidence:
//! .worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md). Every fixture is a SYNTHETIC
//! real-shaped transcript: step-indexed records with second-granularity
//! `created_at`, no ownership record, id = the brain/<id> directory
//! (passed explicitly). `fake-contract.sanitized.jsonl` additionally
//! pins the labeled fake-contract ownership anchor the e2e/rebind fakes
//! append (real transcripts carry no such record).

use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::{parse_antigravity_session_content, TokenSummary};
use std::path::PathBuf;

fn antigravity_fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/antigravity")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The `TokenSummary` the real format's FLAT token fields map to
/// (input_tokens/output_tokens/cache_read_tokens; total = input+output —
/// the real format has no totalTokens key; no context-meter trio).
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
fn fresh_fixture_matches_the_real_binary_contract() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("fresh.sanitized.jsonl"),
        "11111111-2222-3333-4444-555555555555",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        cwd: None,                           // real records carry no workspace evidence
        created_at: Some(1_793_304_001_000), // 2026-10-29T20:00:01Z, seconds
        last_activity_at: Some(1_793_304_005_000),
        title: Some("Fix the flaky test".to_string()),
        title_provider_generated: false,
        summary: Some("Fixed the test.".to_string()),
        first_user_message: Some("Fix the flaky test".to_string()),
        message_count: 2,
        token_usage: Some(usage(10, 20, 0, 30)),
        ..Default::default()
    };
    assert_eq!(meta.title_source, None);
    assert_eq!(meta, expected);
}

#[test]
fn resumed_fixture_parses_both_turns_and_last_token_record_wins() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("resumed.sanitized.jsonl"),
        "22222222-3333-4444-5555-666666666666",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("22222222-3333-4444-5555-666666666666".to_string()),
        cwd: None,
        created_at: Some(1_793_307_601_000), // turn 1's USER_INPUT (min fold)
        last_activity_at: Some(1_793_469_604_000), // turn 2's reply (max fold)
        title: Some("First prompt before exit".to_string()),
        title_provider_generated: false,
        summary: Some("First reply.".to_string()),
        first_user_message: Some("First prompt before exit".to_string()),
        message_count: 5,
        // The LAST token-bearing record wins (turn 2's; turn 1's 15/25
        // never survives) — the documented reading per the evidence
        // receipts (Provider Contract Record row 75(b)).
        token_usage: Some(usage(40, 5, 2, 45)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn errored_fixture_parses_the_real_error_shape() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("errored.sanitized.jsonl"),
        "44444444-5555-6666-7777-888888888888",
    )
    .expect("an errored turn still parses");
    let expected = ParsedSessionMeta {
        session_id: Some("44444444-5555-6666-7777-888888888888".to_string()),
        cwd: None,
        created_at: Some(1_793_314_801_000),
        last_activity_at: Some(1_793_314_802_000),
        title: Some("Do the failing thing".to_string()),
        title_provider_generated: false,
        summary: None, // no PLANNER_RESPONSE: a GENERIC ERROR record is not a reply
        first_user_message: Some("Do the failing thing".to_string()),
        message_count: 2,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn steps_and_seconds_fixture_pins_out_of_order_steps_and_same_second_stamps() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("steps-and-seconds.sanitized.jsonl"),
        "33333333-4444-5555-6666-777777777777",
    )
    .expect("real-shaped records parse");
    let expected = ParsedSessionMeta {
        session_id: Some("33333333-4444-5555-6666-777777777777".to_string()),
        cwd: None,
        created_at: Some(1_793_347_766_000), // 2026-10-30T08:09:26Z (min)
        last_activity_at: Some(1_793_347_768_000), // 08:09:28Z (max)
        title: Some("Run the suite and report".to_string()),
        title_provider_generated: false,
        summary: Some("Tests pass.".to_string()),
        first_user_message: Some("Run the suite and report".to_string()),
        message_count: 5,
        token_usage: None,
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn zero_turn_fixture_has_identity_but_no_messages() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("zero-turn.sanitized.jsonl"),
        "55555555-6666-7777-8888-999999999999",
    )
    .expect("a system-only transcript is still a conversation");
    let expected = ParsedSessionMeta {
        session_id: Some("55555555-6666-7777-8888-999999999999".to_string()),
        cwd: None,
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
fn fake_contract_fixture_takes_cwd_from_the_ownership_record_and_the_dir_id_wins() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("fake-contract.sanitized.jsonl"),
        "11111111-2222-3333-4444-555555555555",
    )
    .expect("the fake-contract extension records still parse");
    let expected = ParsedSessionMeta {
        // The DIRECTORY id (the caller's parameter) is the authority —
        // the fake's ownership record carries a DIFFERENT id and never
        // reassigns it (real binary: the id IS the dir name).
        session_id: Some("11111111-2222-3333-4444-555555555555".to_string()),
        cwd: Some("/home/u/fake".to_string()), // from the session_start anchor
        created_at: Some(1_793_322_000_000),   // the ownership anchor's startedAt folds (min)
        last_activity_at: Some(1_793_322_003_000),
        title: Some("Prompt in the fake contract".to_string()),
        title_provider_generated: false,
        summary: Some("Reply from the fake.".to_string()),
        first_user_message: Some("Prompt in the fake contract".to_string()),
        message_count: 3,
        token_usage: Some(usage(100, 50, 25, 150)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn malformed_tail_fixture_parses_the_valid_prefix() {
    let meta = parse_antigravity_session_content(
        &antigravity_fixture("malformed-tail.sanitized.jsonl"),
        "77777777-8888-4999-aaaa-111111111111",
    )
    .expect("the intact prefix still owns the row");
    let expected = ParsedSessionMeta {
        session_id: Some("77777777-8888-4999-aaaa-111111111111".to_string()),
        cwd: None,
        created_at: Some(1_793_325_601_000),
        last_activity_at: Some(1_793_325_602_000),
        title: Some("Survives the corrupt tail".to_string()),
        title_provider_generated: false,
        summary: Some("Valid reply before corruption.".to_string()),
        first_user_message: Some("Survives the corrupt tail".to_string()),
        // 4 non-empty lines: the garbage and truncated lines COUNT
        // (they are real bytes on disk).
        message_count: 4,
        token_usage: Some(usage(3, 4, 0, 7)),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn title_derives_from_first_user_input_content_at_200_chars() {
    let long_prompt = "A".repeat(250);
    let content = format!(
        r#"{{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":0,"created_at":"2026-10-29T20:00:01Z","content":"{long_prompt}"}}"#,
    );
    let meta = parse_antigravity_session_content(&content, "t1").expect("parses");
    assert_eq!(
        meta.first_user_message.as_deref(),
        Some(long_prompt.as_str())
    );
    assert_eq!(meta.title.as_deref(), Some("A".repeat(200).as_str()));
    assert!(!meta.title_provider_generated);
}

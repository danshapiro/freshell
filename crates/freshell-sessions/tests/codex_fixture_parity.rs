//! Fixture-parity for the codex rollout `.jsonl` parser.
//!
//! Expected values captured from the REFERENCE
//! (`dist/server/coding-cli/providers/codex.js` `parseCodexSessionContent`) over the real
//! sanitized codex event stream `test/fixtures/coding-cli/codex/task-events.sanitized.jsonl`.
//! Exercises: `session_meta` identity + cwd, the task-event recency snapshot
//! (`task_started`/`task_complete`/`turn_aborted`), and the `token_count` envelope
//! (last/total usage, context-window, derived compact threshold `round(258400*90/95)`).

use freshell_sessions::meta::{CodexTaskEventSnapshot, ParsedSessionMeta};
use freshell_sessions::{parse_codex_session_content, TokenSummary};
use std::path::PathBuf;

fn codex_fixture() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn task_events_stream_matches_reference() {
    let meta = parse_codex_session_content(&codex_fixture());
    let expected = ParsedSessionMeta {
        session_id: Some("session-activity".to_string()),
        cwd: Some("/project/codex".to_string()),
        created_at: Some(1_772_323_200_000),
        last_activity_at: Some(1_772_323_206_000),
        message_count: 7,
        token_usage: Some(TokenSummary {
            input_tokens: 100,
            output_tokens: 10,
            cached_tokens: 20,
            total_tokens: 110,
            context_tokens: Some(110),
            model_context_window: Some(258_400),
            compact_threshold_tokens: Some(244_800),
            compact_percent: Some(0),
        }),
        codex_task_events: Some(CodexTaskEventSnapshot {
            latest_task_started_at: Some(1_772_323_205_000),
            latest_task_completed_at: Some(1_772_323_204_000),
            latest_turn_aborted_at: Some(1_772_323_206_000),
        }),
        ..Default::default()
    };
    assert_eq!(meta, expected);
}

#[test]
fn corrupt_and_empty_codex_streams_never_panic() {
    // Corruption tolerance: garbage lines are skipped, empty input yields empty meta.
    let corrupt = "not json\n{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\",\"cwd\":\"/x\"}}\n{oops";
    let meta = parse_codex_session_content(corrupt);
    assert_eq!(meta.session_id.as_deref(), Some("s"));
    assert_eq!(meta.cwd.as_deref(), Some("/x"));
    assert_eq!(meta.message_count, 3); // all three non-empty lines counted

    let empty = parse_codex_session_content("");
    assert_eq!(empty.message_count, 0);
    assert_eq!(empty.session_id, None);
}

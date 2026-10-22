//! Layer-2 projection over REAL pinned-CLI transcripts
//! (`test/fixtures/fresh-agent/claude/real-cli-2.1.237/`). Lines are found by
//! content, never by hard-coded uuids.

use super::*;
use crate::claude_snapshot::real_cli_tests::{
    all_items, fixture_lines, message_text, real_cli_fixture, turn_by_id, uuid_of,
};
use serde_json::json;

fn project(transcript: &str) -> Vec<Value> {
    ClaudeTranscriptProjector::project("s", transcript).turns
}

/// The transcript up to (not including) the first line matching `pred` — a
/// real mid-turn state, since the CLI appends lines as they happen (F7).
fn prefix_before(transcript: &str, pred: impl Fn(&Value) -> bool) -> String {
    let mut out = String::new();
    for line in transcript.lines() {
        if serde_json::from_str::<Value>(line).is_ok_and(|v| pred(&v)) {
            return out;
        }
        out.push_str(line);
        out.push('\n');
    }
    panic!("no line matched");
}

fn tool_result_for(line: &Value, tool_use_id: &str) -> bool {
    line["message"]["content"].as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|b| b["tool_use_id"] == json!(tool_use_id))
    })
}

fn delegation(turns: &[Value]) -> Value {
    let delegations: Vec<&Value> = all_items(turns)
        .into_iter()
        .filter(|item| item["kind"] == "task_delegation")
        .collect();
    assert_eq!(delegations.len(), 1, "{delegations:?}");
    delegations[0].clone()
}

fn agent_line_uuid(transcript: &str) -> String {
    uuid_of(transcript, |line| {
        line["type"] == "assistant" && line["message"]["content"][0]["name"] == json!("Agent")
    })
}

#[test]
fn a_synchronous_agent_projects_one_completed_delegation_with_its_result() {
    let transcript = real_cli_fixture!("tools-sync");
    let turns = project(transcript);
    let agent_turn_id = agent_line_uuid(transcript);
    let result_line = fixture_lines(transcript)
        .into_iter()
        .find(|line| tool_result_for(line, "toolu_agent1"))
        .unwrap();
    let duration = result_line["toolUseResult"]["totalDurationMs"].clone();
    assert!(duration.is_u64(), "fixture carries totalDurationMs");

    let turn = turn_by_id(&turns, &agent_turn_id);
    assert_eq!(
        turn["items"],
        json!([{
            "id": format!("{agent_turn_id}-i0"),
            "kind": "task_delegation",
            "status": "completed",
            "title": "General-purpose Task — check file",
            "description": "check file",
            "subagent": "general-purpose",
            "background": false,
            "durationMs": duration,
            "result": "SUBAGENT-DONE: file has two",
        }])
    );
    assert_eq!(turn["summary"], json!("General-purpose Task — check file"));
    // The result line is absorbed: no orphan tool_result (the client would
    // render a stray "Result" row) and no empty turn left behind.
    assert!(all_items(&turns)
        .iter()
        .all(|item| item["toolUseId"] != json!("toolu_agent1")));
    let result_uuid = result_line["uuid"].as_str().unwrap();
    assert!(turns.iter().all(|t| t["turnId"] != json!(result_uuid)));
    // Ordinary tool results keep projecting.
    assert!(all_items(&turns)
        .iter()
        .any(|item| item["kind"] == "tool_result" && item["toolUseId"] == json!("toolu_edit1")));
}

#[test]
fn a_delegation_whose_result_has_not_landed_is_running() {
    let transcript = real_cli_fixture!("tools-sync");
    let partial = prefix_before(transcript, |line| tool_result_for(line, "toolu_agent1"));
    let item = delegation(&project(&partial));
    assert_eq!(item["status"], json!("running"));
    assert_eq!(item["background"], json!(false));
    assert!(item.get("result").is_none());
    assert!(item.get("durationMs").is_none());
}

#[test]
fn a_background_agent_runs_until_its_task_notification_completes_it() {
    let transcript = real_cli_fixture!("agent-async");
    let notification = fixture_lines(transcript)
        .into_iter()
        .find(|line| line["origin"]["kind"] == "task-notification")
        .unwrap();
    let notification_text = message_text(&notification);

    // Launched, notification not yet written: background + running.
    let launched = prefix_before(transcript, |line| {
        line["origin"]["kind"] == "task-notification"
    });
    let item = delegation(&project(&launched));
    assert_eq!(item["status"], json!("running"));
    assert_eq!(item["background"], json!(true));
    assert_eq!(
        item["title"],
        json!("General-purpose Task (background) — check file")
    );
    assert!(
        item.get("result").is_none(),
        "the launch receipt is not a result"
    );

    // The notification completes it with the agent's result and duration.
    let turns = project(transcript);
    let item = delegation(&turns);
    let duration: u64 = notification_text
        .split("<duration_ms>")
        .nth(1)
        .and_then(|rest| rest.split("</duration_ms>").next())
        .and_then(|ms| ms.parse().ok())
        .expect("fixture notification carries duration_ms");
    assert_eq!(item["status"], json!("completed"));
    assert_eq!(item["background"], json!(true));
    assert_eq!(item["result"], json!("SUBAGENT-DONE: file has two"));
    assert_eq!(item["durationMs"], json!(duration));
    // The unsolicited follow-up answer still renders.
    assert!(all_items(&turns)
        .iter()
        .any(|item| item["text"] == json!("The background check finished.")));
}

#[test]
fn a_failed_agent_projects_a_failed_delegation_with_the_error() {
    let transcript = real_cli_fixture!("agent-failed");
    let turns = project(transcript);
    let item = delegation(&turns);
    assert_eq!(item["status"], json!("failed"));
    assert_eq!(
        item["result"],
        json!("Agent type 'no-such-agent-type' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup")
    );
    assert_eq!(item["subagent"], json!("no-such-agent-type"));
    assert!(all_items(&turns)
        .iter()
        .all(|item| item["kind"] != "tool_result"));
}

#[test]
fn a_line_the_cli_re_appended_after_a_compaction_projects_once() {
    let transcript = real_cli_fixture!("compact-preserved-duplicate");
    let turns = project(transcript);
    let mut ids: Vec<&str> = turns
        .iter()
        .map(|t| t["turnId"].as_str().unwrap())
        .collect();
    let total = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(
        ids.len(),
        total,
        "turn ids are unique (React keys, rollback addressing)"
    );
    let replies = all_items(&turns)
        .into_iter()
        .filter(|item| item["text"] == json!("reply 3"))
        .count();
    assert_eq!(replies, 1);
}

#[test]
fn a_compact_summary_without_a_boundary_line_still_marks_the_compaction() {
    // A transcript whose compaction left only the isCompactSummary recap
    // (no system/compact_boundary line): the recap's position gets the marker.
    let transcript: String = real_cli_fixture!("compact-ok")
        .lines()
        .filter(|line| !line.contains("\"subtype\":\"compact_boundary\""))
        .map(|line| format!("{line}\n"))
        .collect();
    let summary = uuid_of(&transcript, |line| line["isCompactSummary"] == json!(true));
    let turns = project(&transcript);
    let turn = turn_by_id(&turns, &summary);
    assert_eq!(turn["role"], json!("system"));
    assert_eq!(
        turn["items"],
        json!([{ "id": format!("{summary}-i0"), "kind": "context_compaction" }])
    );
    let markers = all_items(&turns)
        .into_iter()
        .filter(|item| item["kind"] == "context_compaction")
        .count();
    assert_eq!(markers, 1);
}

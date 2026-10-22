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

// ── A4: subagent activity rows ─────────────────────────────────────────────

fn fixture_path(relative: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/fresh-agent/claude/real-cli-2.1.237")
        .join(relative)
}

/// The single subagent transcript captured next to a scenario's session.
fn subagent_transcript(scenario: &str) -> String {
    let dir = fixture_path(&format!("{scenario}/session/subagents"));
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("the scenario captured a subagent transcript");
    std::fs::read_to_string(file).unwrap()
}

struct MapSubagents(std::collections::HashMap<String, String>);

impl SubagentSource for MapSubagents {
    fn transcript_for(&self, tool_use_id: &str) -> Option<String> {
        self.0.get(tool_use_id).cloned()
    }
}

fn project_with(transcript: &str, subagents: &dyn SubagentSource) -> Vec<Value> {
    ClaudeTranscriptProjector::project_with("s", transcript, subagents).turns
}

#[test]
fn a_delegation_lists_its_subagent_tool_calls_from_the_subagent_transcript() {
    let transcript = real_cli_fixture!("tools-sync");
    let subagents = FsSubagents::for_transcript(&fixture_path("tools-sync/session.jsonl"));
    let item = delegation(&project_with(transcript, &subagents));
    assert_eq!(
        item["activity"],
        json!([{ "tool": "Read", "status": "completed", "preview": "/fixture/ws/a.txt" }])
    );
}

#[test]
fn a_running_delegation_shows_the_subagent_call_in_flight() {
    // Mid-run read (F7: both files grow progressively): the subagent has
    // called Read but its result has not been written yet.
    let transcript = real_cli_fixture!("tools-sync");
    let parent = prefix_before(transcript, |line| tool_result_for(line, "toolu_agent1"));
    let child = subagent_transcript("tools-sync");
    let child_tool_use = fixture_lines(&child)
        .into_iter()
        .find_map(|line| {
            line["message"]["content"]
                .as_array()?
                .iter()
                .find(|b| b["type"] == "tool_use")
                .and_then(|b| b["id"].as_str().map(str::to_string))
        })
        .unwrap();
    let child_partial = prefix_before(&child, |line| tool_result_for(line, &child_tool_use));
    let subagents = MapSubagents([("toolu_agent1".to_string(), child_partial)].into());
    let item = delegation(&project_with(&parent, &subagents));
    assert_eq!(item["status"], json!("running"));
    assert_eq!(
        item["activity"],
        json!([{ "tool": "Read", "status": "running", "preview": "/fixture/ws/a.txt" }])
    );
}

#[test]
fn a_background_delegation_lists_its_subagent_activity() {
    let transcript = real_cli_fixture!("agent-async");
    let subagents = FsSubagents::for_transcript(&fixture_path("agent-async/session.jsonl"));
    let item = delegation(&project_with(transcript, &subagents));
    assert_eq!(
        item["activity"],
        json!([{ "tool": "Read", "status": "completed", "preview": "/fixture/ws/a.txt" }])
    );
}

#[test]
fn a_delegation_without_a_subagent_transcript_carries_no_activity() {
    let transcript = real_cli_fixture!("agent-failed");
    let subagents = FsSubagents::for_transcript(&fixture_path("agent-failed/session.jsonl"));
    let item = delegation(&project_with(transcript, &subagents));
    assert!(item.get("activity").is_none());
}

#[test]
fn subagent_activity_is_capped() {
    // Real subagent tool_use line shape, repeated past the cap.
    let child = subagent_transcript("tools-sync");
    let tool_line = fixture_lines(&child)
        .into_iter()
        .find(|line| line["message"]["content"][0]["type"] == "tool_use")
        .unwrap();
    let many: String = (0..250)
        .map(|i| {
            let mut line = tool_line.clone();
            line["uuid"] = json!(format!("u{i}"));
            line["message"]["content"][0]["id"] = json!(format!("toolu_many{i}"));
            format!("{line}\n")
        })
        .collect();
    let subagents = MapSubagents([("toolu_agent1".to_string(), many)].into());
    let item = delegation(&project_with(real_cli_fixture!("tools-sync"), &subagents));
    assert_eq!(
        item["activity"].as_array().unwrap().len(),
        crate::delegation::DELEGATION_ACTIVITY_ROW_CAP
    );
}

#[test]
fn delegation_activity_previews_read_claude_tool_inputs() {
    use crate::delegation::delegation_activity_preview as preview;
    assert_eq!(
        preview("Read", &json!({ "file_path": "/w/a.txt" })),
        "/w/a.txt"
    );
    assert_eq!(
        preview("Edit", &json!({ "file_path": "/w/b.rs" })),
        "/w/b.rs"
    );
    assert_eq!(
        preview("Write", &json!({ "file_path": "/w/c.md" })),
        "/w/c.md"
    );
    assert_eq!(preview("Bash", &json!({ "command": "ls -la" })), "ls -la");
    assert_eq!(preview("Grep", &json!({ "pattern": "fn main" })), "fn main");
    assert_eq!(preview("Glob", &json!({ "pattern": "**/*.ts" })), "**/*.ts");
    assert_eq!(
        preview("Agent", &json!({ "description": "inner" })),
        "inner"
    );
    assert_eq!(
        preview("WebFetch", &json!({ "url": "https://x.test" })),
        "https://x.test"
    );
    assert_eq!(
        preview("NotebookEdit", &json!({ "notebook_path": "/w/n.ipynb" })),
        "/w/n.ipynb"
    );
    assert_eq!(preview("Mystery", &json!({ "a": 1 })), r#"{"a":1}"#);
}

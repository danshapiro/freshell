//! Transcript projection over REAL transcripts written by the pinned Claude
//! CLI 2.1.237 (`test/fixtures/fresh-agent/claude/real-cli-2.1.237/`, captured
//! by `test/integration/providers/claude-capture-fixtures.mjs` against a local
//! fake endpoint). Lines are located by their content, never by hard-coded
//! uuids, so a re-capture keeps these tests meaningful.

use super::*;

macro_rules! real_cli_fixture {
    ($scenario:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/fresh-agent/claude/real-cli-2.1.237/",
            $scenario,
            "/session.jsonl"
        ))
    };
}
#[allow(unused_imports)]
pub(crate) use real_cli_fixture;

pub(crate) fn fixture_lines(transcript: &str) -> Vec<Value> {
    transcript
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

/// The uuid of the ONE fixture line matching `pred` (panics on zero or many,
/// so a re-capture that changes the shape fails loudly).
pub(crate) fn uuid_of(transcript: &str, pred: impl Fn(&Value) -> bool) -> String {
    let matches: Vec<String> = fixture_lines(transcript)
        .into_iter()
        .filter(|line| pred(line))
        .filter_map(|line| line["uuid"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "expected exactly one matching line: {matches:?}"
    );
    matches.into_iter().next().unwrap()
}

/// The raw text of a line's message content (string content or joined text blocks).
pub(crate) fn message_text(line: &Value) -> String {
    match &line["message"]["content"] {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => line["content"].as_str().unwrap_or("").to_string(),
    }
}

pub(crate) fn turn_by_id<'a>(turns: &'a [Value], id: &str) -> &'a Value {
    turns
        .iter()
        .find(|turn| turn["turnId"] == json!(id))
        .unwrap_or_else(|| panic!("no projected turn {id}"))
}

pub(crate) fn all_items(turns: &[Value]) -> Vec<&Value> {
    turns
        .iter()
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .collect()
}

#[test]
fn compact_boundary_projects_one_context_compaction_system_turn() {
    let transcript = real_cli_fixture!("compact-ok");
    let turns = parse_transcript_turns("s", transcript);
    let boundary = uuid_of(transcript, |line| {
        line["type"] == "system" && line["subtype"] == "compact_boundary"
    });
    let turn = turn_by_id(&turns, &boundary);
    assert_eq!(turn["role"], json!("system"));
    assert_eq!(
        turn["items"],
        json!([{ "id": format!("{boundary}-i0"), "kind": "context_compaction" }])
    );
    assert_eq!(turn["summary"], json!("Context compacted"));
    // The isCompactSummary line that follows the boundary adds no second marker
    // and its summary prose never renders as a user turn.
    let markers = all_items(&turns)
        .into_iter()
        .filter(|item| item["kind"] == "context_compaction")
        .count();
    assert_eq!(markers, 1);
    assert!(turns.iter().all(|turn| !turn["summary"]
        .as_str()
        .unwrap_or("")
        .contains("This session is being continued")));
}

#[test]
fn local_command_stdout_projects_a_system_text_row_without_the_wrapper() {
    let transcript = real_cli_fixture!("compact-ok");
    let turns = parse_transcript_turns("s", transcript);
    let usage = uuid_of(transcript, |line| {
        line["subtype"] == "local_command" && message_text(line).contains("Total cost:")
    });
    let turn = turn_by_id(&turns, &usage);
    assert_eq!(turn["role"], json!("system"));
    let items = turn["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], json!("text"));
    let text = items[0]["text"].as_str().unwrap();
    assert!(text.starts_with("Total cost:"), "{text}");
    assert!(!text.contains("local-command-stdout"), "{text}");

    let context = uuid_of(transcript, |line| {
        line["subtype"] == "local_command" && message_text(line).contains("## Context Usage")
    });
    let text = turn_by_id(&turns, &context)["items"][0]["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(text.starts_with("## Context Usage"), "{text}");
    assert!(
        text.contains("| Category | Tokens | Percentage |"),
        "{text}"
    );
}

#[test]
fn user_line_carrying_only_command_stdout_projects_as_system_text() {
    let transcript = real_cli_fixture!("compact-ok");
    let turns = parse_transcript_turns("s", transcript);
    let compacted = uuid_of(transcript, |line| {
        line["type"] == "user" && message_text(line).starts_with("<local-command-stdout>Compacted")
    });
    let turn = turn_by_id(&turns, &compacted);
    assert_eq!(turn["role"], json!("system"));
    assert_eq!(
        turn["items"],
        json!([{ "id": format!("{compacted}-i0"), "kind": "text", "text": "Compacted" }])
    );
}

#[test]
fn command_name_lines_project_the_slash_command_the_user_typed() {
    let transcript = real_cli_fixture!("compact-ok");
    let turns = parse_transcript_turns("s", transcript);
    let user_texts: Vec<&str> = turns
        .iter()
        .filter(|turn| turn["role"] == "user")
        .filter_map(|turn| turn["items"][0]["text"].as_str())
        .collect();
    assert_eq!(
        user_texts,
        vec![
            "hi there",
            "second msg",
            "third msg",
            "/compact keep it short",
            "after compact",
            "/usage",
            "/context",
        ]
    );
    // The local-command caveat (isMeta) never renders.
    assert!(all_items(&turns).iter().all(|item| !item["text"]
        .as_str()
        .unwrap_or("")
        .contains("local-command-caveat")));
}

#[test]
fn local_command_stderr_projects_a_command_error_turn() {
    let transcript = real_cli_fixture!("compact-fail");
    let turns = parse_transcript_turns("s", transcript);
    let failure = uuid_of(transcript, |line| {
        line["subtype"] == "local_command" && message_text(line).contains("local-command-stderr")
    });
    let turn = turn_by_id(&turns, &failure);
    assert_eq!(turn["role"], json!("system"));
    assert_eq!(turn["items"], json!([]));
    assert_eq!(
        turn["error"],
        json!({
            "name": "CommandError",
            "message": "Error during compaction: API Error: 400 compaction refused by fake",
        })
    );
    // LB-4: a zero-item turn never carries a non-blank summary (the client
    // renders a summary-only article, which would duplicate the error module).
    assert_eq!(turn["summary"], json!(""));
    // A failed compaction leaves no compaction marker.
    assert!(all_items(&turns)
        .iter()
        .all(|item| item["kind"] != "context_compaction"));
}

#[test]
fn api_error_assistant_line_projects_an_error_only_turn() {
    let transcript = real_cli_fixture!("api-error");
    let turns = parse_transcript_turns("s", transcript);
    let error_line = uuid_of(transcript, |line| line["isApiErrorMessage"] == json!(true));
    let turn = turn_by_id(&turns, &error_line);
    assert_eq!(turn["role"], json!("assistant"));
    assert_eq!(turn["items"], json!([]));
    assert_eq!(
        turn["error"],
        json!({ "name": "ApiError", "message": "API Error: 400 fixture bad request" })
    );
    assert_eq!(turn["summary"], json!(""));
}

#[test]
fn image_blocks_project_as_image_placeholders() {
    let transcript = real_cli_fixture!("image");
    let turns = parse_transcript_turns("s", transcript);
    let prompt = uuid_of(transcript, |line| {
        line["type"] == "user" && message_text(line) == "what is this"
    });
    let turn = turn_by_id(&turns, &prompt);
    assert_eq!(
        turn["items"],
        json!([
            { "id": format!("{prompt}-i0"), "kind": "text", "text": "what is this" },
            { "id": format!("{prompt}-i1"), "kind": "text", "text": "[image]" },
        ])
    );
    let result = all_items(&turns)
        .into_iter()
        .find(|item| item["kind"] == "tool_result")
        .expect("the Read result projects");
    assert_eq!(result["content"], json!("[image]"));
    // No base64 payload reaches the snapshot.
    let serialized = serde_json::to_string(&turns).unwrap();
    assert!(!serialized.contains("iVBORw0KGgo"), "image bytes leaked");
}

#[test]
fn task_notification_lines_never_render_as_user_turns() {
    let transcript = real_cli_fixture!("agent-async");
    let turns = parse_transcript_turns("s", transcript);
    let notification = uuid_of(transcript, |line| {
        line["origin"]["kind"] == "task-notification"
    });
    assert!(turns
        .iter()
        .all(|turn| turn["turnId"] != json!(notification)));
    assert!(all_items(&turns).iter().all(|item| !item["text"]
        .as_str()
        .unwrap_or("")
        .contains("<task-notification>")));
}

#[test]
fn the_snapshot_and_rollback_slices_carry_the_delegation_projection() {
    let transcript = real_cli_fixture!("tools-sync");
    for session_type in ["freshclaude", "kilroy"] {
        let snapshot = build_claude_snapshot_json(session_type, "s", transcript, 0, None);
        let turns = snapshot["turns"].as_array().unwrap();
        let kinds: Vec<&str> = all_items(turns)
            .iter()
            .filter_map(|item| item["kind"].as_str())
            .collect();
        assert!(
            kinds.contains(&"task_delegation"),
            "{session_type}: {kinds:?}"
        );
        assert!(all_items(turns)
            .iter()
            .all(|item| item["toolUseId"] != json!("toolu_agent1")));
    }
    // The rollback marker slice is the same projection (one display truth).
    let point = resolve_resume_point(transcript, "s", ResumeTarget::Step).expect("resolves");
    assert!(all_items(&point.removed_turns)
        .iter()
        .any(|item| item["kind"] == "task_delegation"));
}

/// Copy a real-CLI scenario into a temp store as `<id>.jsonl` plus its
/// `<id>/subagents/` directory (the CLI's own layout).
pub(crate) fn stage_real_cli_store(scenario: &str, id: &str) -> tempfile::TempDir {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/fresh-agent/claude/real-cli-2.1.237")
        .join(scenario);
    let home = tempfile::tempdir().expect("tempdir");
    let project = home.path().join("projects").join("-fixture-ws");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::copy(
        fixture.join("session.jsonl"),
        project.join(format!("{id}.jsonl")),
    )
    .unwrap();
    let subagents = fixture.join("session").join("subagents");
    if subagents.is_dir() {
        let target = project.join(id).join("subagents");
        std::fs::create_dir_all(&target).unwrap();
        for entry in std::fs::read_dir(&subagents).unwrap().flatten() {
            std::fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
    home
}

#[tokio::test]
async fn the_served_snapshot_reads_delegation_activity_from_the_subagents_directory() {
    let _guard = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
    let id = "61616161-6161-4161-8161-616161616161";
    let home = stage_real_cli_store("tools-sync", id);
    let previous = std::env::var("CLAUDE_CONFIG_DIR").ok();
    std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
    let snapshot = get_claude_snapshot("freshclaude", id, None).await;
    match previous {
        Some(value) => std::env::set_var("CLAUDE_CONFIG_DIR", value),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    let snapshot = snapshot.expect("snapshot builds");
    let turns = snapshot["turns"].as_array().unwrap();
    let delegation = all_items(turns)
        .into_iter()
        .find(|item| item["kind"] == "task_delegation")
        .expect("delegation projected");
    assert_eq!(
        delegation["activity"],
        json!([{ "tool": "Read", "status": "completed", "preview": "/fixture/ws/a.txt" }])
    );
}

#[test]
fn the_snapshot_lists_changed_files_and_advertises_the_diff_panel() {
    let edited =
        build_claude_snapshot_json("freshclaude", "s", real_cli_fixture!("tools-sync"), 0, None);
    assert_eq!(edited["capabilities"]["diffs"], json!(true));
    let paths: Vec<&str> = edited["diffs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["path"].as_str())
        .collect();
    assert_eq!(paths, vec!["/fixture/ws/a.txt", "/fixture/ws/b.txt"]);

    let untouched =
        build_claude_snapshot_json("kilroy", "s", real_cli_fixture!("compact-ok"), 0, None);
    assert_eq!(untouched["capabilities"]["diffs"], json!(false));
    assert_eq!(untouched["diffs"], json!([]));
}

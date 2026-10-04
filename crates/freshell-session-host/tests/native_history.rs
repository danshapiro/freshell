use rusqlite::Connection;
use serde_json::{json, Value};
use std::{path::Path, process::Command};

fn history(home: &Path, provider: &str, session: &str) -> std::process::Output {
    use std::os::unix::fs::PermissionsExt;
    let probe = home.join("provider-start-probe");
    let counter = home.join("provider-started");
    std::fs::write(
        &probe,
        format!("#!/bin/sh\ntouch '{}'\nexit 1\n", counter.display()),
    )
    .unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_freshell-session-host"))
        .args([
            "native-history-only",
            "--provider",
            provider,
            "--session-id",
            session,
            "--provider-home",
        ])
        .arg(home)
        .env("CLAUDE_CMD", &probe)
        .env("CODEX_CMD", &probe)
        .env("OPENCODE_CMD", &probe)
        .output()
        .unwrap();
    assert!(!counter.exists(), "history read attempted a provider start");
    output
}

fn rollout(home: &Path, id: &str, text: &str) {
    let root = home.join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&root).unwrap();
    let rows = [
        json!({"type":"session_meta","payload":{"id":id,"cwd":"/workspace","history_mode":"paginated"}}),
        json!({"type":"turn_context","payload":{"turn_id":"native-turn","model":"saved-model"}}),
        json!({"type":"response_item","payload":{"type":"message","id":"native-user","role":"user","content":[{"type":"input_text","text":"Saved user prompt"}]}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Saved user prompt"}}),
        json!({"type":"response_item","payload":{"type":"message","id":"native-assistant","role":"assistant","content":[{"type":"output_text","text":text}]}}),
    ];
    std::fs::write(
        root.join(format!("rollout-2026-10-03-{id}.jsonl")),
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
}

fn write_codex_rows(home: &Path, id: &str, rows: &[Value]) {
    let root = home.join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join(format!("rollout-2026-10-03-{id}.jsonl")),
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
}

fn codex_response_message(role: &str, index: usize, text: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":role,"id":format!("{role}-{index}"),
        "content":[{"type":if role == "user" { "input_text" } else { "output_text" },"text":text}]}})
}

#[test]
fn history_binary_reads_exact_saved_codex_rollout_without_a_runtime() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "selected-thread", "Saved Codex answer");
    rollout(
        home.path(),
        "other-thread",
        "Other conversation must not appear",
    );
    let result = history(home.path(), "codex", "selected-thread");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(body["threadId"], "selected-thread");
    assert_eq!(body["turns"].as_array().unwrap().len(), 2);
    assert_eq!(body["turns"][0]["items"][0]["text"], "Saved user prompt");
    assert_eq!(body["turns"][1]["items"][0]["text"], "Saved Codex answer");
    assert_eq!(body["capabilities"]["send"], false);
    assert!(!home.path().join("fresh-agent-state.json").exists());
    assert!(!history(home.path(), "codex", "missing-thread")
        .status
        .success());
}

#[test]
fn history_binary_preserves_normal_text_that_quotes_the_retention_marker() {
    let home = tempfile::tempdir().unwrap();
    let text = "Source code defines OMITTED_BODY as FRESHELL_NATIVE_HISTORY_OMITTED_SHA256:; this is saved text.";
    rollout(home.path(), "quoted-marker", text);
    let result = history(home.path(), "codex", "quoted-marker");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(body["turns"][1]["items"][0]["text"], text);
    assert_ne!(
        body["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
        true
    );
}

#[test]
fn history_binary_reads_supported_codex_task_event_transcript() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("rollout-2026-10-03-session-activity.jsonl"),
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl"),
    )
    .unwrap();
    let result = history(home.path(), "codex", "session-activity");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(body["threadId"], "session-activity");
    assert_eq!(body["turns"].as_array().unwrap().len(), 2);
    assert_eq!(body["turns"][0]["role"], "user");
    assert_eq!(body["turns"][0]["items"][0]["text"], "Sanitized prompt");
    assert_eq!(body["turns"][1]["role"], "assistant");
    assert_eq!(body["turns"][1]["items"][0]["text"], "Sanitized completion");
    assert_eq!(body["capabilities"]["send"], false);
}

#[test]
fn history_binary_reads_interrupted_codex_agent_message_events() {
    let home = tempfile::tempdir().unwrap();
    let mut rows = vec![json!({"type":"session_meta","payload":{"id":"interrupted-events"}})];
    for turn in 0..2 {
        rows.extend([
            json!({"type":"turn_context","payload":{"turn_id":format!("interrupted-turn-{turn}")}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated interrupted prompt"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":format!("interrupted-turn-{turn}")}}),
            // AgentMessageEvent has a message and optional phase; it need not have a turn id.
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Saved answer before interruption","phase":"commentary"}}),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":format!("interrupted-turn-{turn}"),"reason":"interrupted"}}),
        ]);
    }
    write_codex_rows(home.path(), "interrupted-events", &rows);
    let result = history(home.path(), "codex", "interrupted-events");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 4);
    for (index, turn) in turns.iter().enumerate() {
        assert_eq!(
            turn["role"],
            if index % 2 == 0 { "user" } else { "assistant" }
        );
        assert_eq!(turn["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            turn["items"][0]["text"],
            if index % 2 == 0 {
                "Repeated interrupted prompt"
            } else {
                "Saved answer before interruption"
            }
        );
    }
    assert_eq!(body["capabilities"]["send"], false);
}

#[test]
fn history_binary_deduplicates_codex_response_agent_and_completion_mirrors() {
    for order in [
        &[0, 1, 2][..],
        &[0, 2, 1][..],
        &[1, 0, 2][..],
        &[1, 2, 0][..],
        &[2, 0, 1][..],
        &[2, 1, 0][..],
        &[1, 2][..],
        &[2, 1][..],
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut rows =
            vec![json!({"type":"session_meta","payload":{"id":"three-message-formats"}})];
        for turn in 0..2 {
            rows.extend([
                json!({"type":"turn_context","payload":{"turn_id":format!("triple-turn-{turn}")}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}}),
            ]);
            let messages = [
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","id":format!("assistant-{turn}"),
                    "content":[{"type":"output_text","text":"Repeated saved answer"}]}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"Repeated saved answer","phase":"final"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":format!("triple-turn-{turn}"),"last_agent_message":"Repeated saved answer"}}),
            ];
            for &index in order {
                rows.push(messages[index].clone());
            }
        }
        write_codex_rows(home.path(), "three-message-formats", &rows);
        let result = history(home.path(), "codex", "three-message-formats");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        let turns = body["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 4, "order {order:?}");
        for turn in 0..2 {
            let assistant = &turns[turn * 2 + 1];
            assert_eq!(assistant["role"], "assistant");
            assert_eq!(
                assistant["items"].as_array().unwrap().len(),
                1,
                "order {order:?}"
            );
            assert_eq!(assistant["items"][0]["text"], "Repeated saved answer");
            if order.contains(&0) {
                assert_eq!(assistant["items"][0]["id"], format!("assistant-{turn}"));
            }
        }
    }
}

#[test]
fn history_binary_associates_codex_message_mirrors_across_turn_context() {
    for modern_first in [false, true] {
        for context_first in [false, true] {
            for context_has_id in [true, false] {
                for (start_position, start_has_id) in [
                    ("none", false),
                    ("before", false),
                    ("before", true),
                    ("after", false),
                    ("after", true),
                ] {
                    for order in [
                        &[0, 1, 2][..],
                        &[0, 2, 1][..],
                        &[1, 0, 2][..],
                        &[1, 2, 0][..],
                        &[2, 0, 1][..],
                        &[2, 1, 0][..],
                        &[1, 2][..],
                        &[2, 1][..],
                    ] {
                        let home = tempfile::tempdir().unwrap();
                        let mut rows = vec![
                            json!({"type":"session_meta","payload":{"id":"context-mirrors","history_mode":"legacy"}}),
                        ];
                        for index in 0..2 {
                            let id = format!("saved-turn-{index}");
                            let mut context =
                                json!({"type":"turn_context","payload":{"model":"saved-model"}});
                            if context_has_id {
                                context["payload"]["turn_id"] = json!(id);
                            }
                            let mut started =
                                json!({"type":"event_msg","payload":{"type":"task_started"}});
                            if start_has_id {
                                started["payload"]["turn_id"] = json!(id);
                            }
                            let legacy = json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}});
                            let response =
                                codex_response_message("user", index, "Repeated saved prompt");
                            if context_first {
                                rows.push(context.clone());
                            }
                            if start_position == "before" {
                                rows.push(started.clone());
                            }
                            rows.push(if modern_first {
                                response.clone()
                            } else {
                                legacy.clone()
                            });
                            if start_position == "after" {
                                rows.push(started);
                            }
                            if !context_first {
                                rows.push(context);
                            }
                            rows.push(if modern_first { legacy } else { response });
                            let mut completed = json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Repeated saved answer"}});
                            if context_has_id {
                                completed["payload"]["turn_id"] = json!(id);
                            }
                            let messages = [
                                codex_response_message("assistant", index, "Repeated saved answer"),
                                json!({"type":"event_msg","payload":{"type":"agent_message","message":"Repeated saved answer","phase":"final"}}),
                                completed,
                            ];
                            for &source in order {
                                rows.push(messages[source].clone());
                            }
                        }
                        write_codex_rows(home.path(), "context-mirrors", &rows);
                        let result = history(home.path(), "codex", "context-mirrors");
                        assert!(
                            result.status.success(),
                            "{}",
                            String::from_utf8_lossy(&result.stderr)
                        );
                        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
                        let turns = body["turns"].as_array().unwrap();
                        let case = format!("modern_first={modern_first}, context_first={context_first}, context_has_id={context_has_id}, start={start_position}/{start_has_id}, sources={order:?}");
                        assert_eq!(turns.len(), 4, "{case}: {body}");
                        assert_ne!(
                            turns[0]["turnId"], turns[2]["turnId"],
                            "distinct completed turns: {case}"
                        );
                        for (index, turn) in turns.iter().enumerate() {
                            assert_eq!(
                                turn["role"],
                                if index % 2 == 0 { "user" } else { "assistant" },
                                "{case}"
                            );
                            assert_eq!(turn["items"].as_array().unwrap().len(), 1, "{case}");
                            assert_eq!(
                                turn["items"][0]["text"],
                                if index % 2 == 0 {
                                    "Repeated saved prompt"
                                } else {
                                    "Repeated saved answer"
                                },
                                "{case}"
                            );
                            if index % 2 == 0 || order.contains(&0) {
                                assert_eq!(
                                    turn["items"][0]["id"],
                                    if index % 2 == 0 {
                                        format!("user-{}:part:0", index / 2)
                                    } else {
                                        format!("assistant-{}", index / 2)
                                    },
                                    "{case}"
                                );
                            }
                            let saved_id =
                                if context_has_id || (start_position != "none" && start_has_id) {
                                    format!("saved-turn-{}", index / 2)
                                } else {
                                    format!("native-history-{}", index / 2)
                                };
                            assert_eq!(
                                turn["turnId"]
                                    .as_str()
                                    .unwrap()
                                    .split(":row-")
                                    .next()
                                    .unwrap(),
                                saved_id,
                                "{case}"
                            );
                        }
                        assert_eq!(body["capabilities"]["send"], false);
                    }
                }
            }
        }
    }
}

#[test]
fn history_binary_associates_resumed_input_after_an_abrupt_codex_turn() {
    let fixture: Vec<Value> =
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    let task_started = |id: Option<&str>| {
        let mut row = fixture[2].clone();
        let payload = row["payload"].as_object_mut().unwrap();
        payload.remove("turn_id");
        if let Some(id) = id {
            payload.insert("turn_id".into(), json!(id));
        }
        row
    };
    for progress in ["assistant", "tool", "both", "input_only"] {
        for prior_has_id in [true, false] {
            for same_prompt in [false, true] {
                for modern_first in [false, true] {
                    for context_first in [false, true] {
                        for start_has_id in [true, false] {
                            for context_has_id in [true, false] {
                                let home = tempfile::tempdir().unwrap();
                                // Keep the supported fixture's user-before-task-start order,
                                // then simulate an exit before any completion or abort record.
                                let mut rows = fixture[..3].to_vec();
                                rows[2] = task_started(prior_has_id.then_some("turn-1"));
                                rows.extend([
                                if prior_has_id {
                                    json!({"type":"turn_context","payload":{"turn_id":"turn-1"}})
                                } else {
                                    json!({"type":"turn_context","payload":{"model":"saved-model"}})
                                },
                                codex_response_message("user", 0, "Sanitized prompt"),
                            ]);
                                if progress == "tool" || progress == "both" {
                                    rows.push(json!({"type":"response_item","payload":{"type":"custom_tool_call",
                                    "call_id":"interrupted-tool","name":"apply_patch","input":"Saved unfinished patch"}}));
                                }
                                if progress == "assistant" || progress == "both" {
                                    rows.extend([
                                    codex_response_message("assistant", 0, "Saved partial answer"),
                                    json!({"type":"event_msg","payload":{"type":"agent_message","message":"Saved partial answer","phase":"commentary"}}),
                                ]);
                                }
                                let prompt = if same_prompt {
                                    "Sanitized prompt"
                                } else {
                                    "Resumed prompt"
                                };
                                let mut user = fixture[1].clone();
                                user["payload"]["message"] = json!(prompt);
                                let response = codex_response_message("user", 1, prompt);
                                rows.push(if modern_first {
                                    response.clone()
                                } else {
                                    user.clone()
                                });
                                let started = task_started(start_has_id.then_some("turn-2"));
                                let context = if context_has_id {
                                    json!({"type":"turn_context","payload":{"turn_id":"turn-2"}})
                                } else {
                                    json!({"type":"turn_context","payload":{"model":"saved-model"}})
                                };
                                rows.extend(if context_first {
                                    [context, started]
                                } else {
                                    [started, context]
                                });
                                rows.push(if modern_first { user } else { response });
                                rows.push(codex_response_message(
                                    "assistant",
                                    1,
                                    "Saved resumed answer",
                                ));
                                write_codex_rows(home.path(), "session-activity", &rows);
                                let result = history(home.path(), "codex", "session-activity");
                                assert!(
                                    result.status.success(),
                                    "{}",
                                    String::from_utf8_lossy(&result.stderr)
                                );
                                let body: Value = serde_json::from_slice(&result.stdout).unwrap();
                                let turns = body["turns"].as_array().unwrap();
                                let case = format!("progress={progress}, prior_id={prior_has_id}, same_prompt={same_prompt}, modern_first={modern_first}, context_first={context_first}, start_id={start_has_id}, context_id={context_has_id}");
                                let prior_id = if prior_has_id {
                                    "turn-1"
                                } else {
                                    "native-history-0"
                                };
                                let mut expected =
                                    vec![("user", prior_id, "user-0:part:0", "Sanitized prompt")];
                                if progress == "tool" || progress == "both" {
                                    expected.push(("tool", prior_id, "interrupted-tool", ""));
                                }
                                if progress == "assistant" || progress == "both" {
                                    expected.push((
                                        "assistant",
                                        prior_id,
                                        "assistant-0",
                                        "Saved partial answer",
                                    ));
                                }
                                let resumed_id = if start_has_id || context_has_id {
                                    "turn-2"
                                } else {
                                    "native-history-1"
                                };
                                expected.extend([
                                    ("user", resumed_id, "user-1:part:0", prompt),
                                    (
                                        "assistant",
                                        resumed_id,
                                        "assistant-1",
                                        "Saved resumed answer",
                                    ),
                                ]);
                                assert_eq!(turns.len(), expected.len(), "{case}: {body}");
                                for (turn, (role, id, item_id, text)) in turns.iter().zip(expected)
                                {
                                    assert_eq!(turn["role"], role, "{case}");
                                    assert_eq!(
                                        turn["items"].as_array().unwrap().len(),
                                        1,
                                        "{case}"
                                    );
                                    assert_eq!(turn["items"][0]["id"], item_id, "{case}");
                                    assert_eq!(
                                        turn["turnId"]
                                            .as_str()
                                            .unwrap()
                                            .split(":row-")
                                            .next()
                                            .unwrap(),
                                        id,
                                        "native task association: {case}: {body}"
                                    );
                                    if role == "tool" {
                                        assert_eq!(turn["items"][0]["status"], "running", "{case}");
                                        assert_eq!(
                                            turn["items"][0]["arguments"], "Saved unfinished patch",
                                            "{case}"
                                        );
                                    } else {
                                        assert_eq!(turn["items"][0]["text"], text, "{case}");
                                    }
                                }
                                assert_eq!(body["capabilities"]["send"], false);
                            }
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn history_binary_binds_legacy_resumed_prompt_after_an_unfinished_codex_task() {
    let fixture: Vec<Value> =
        include_str!("../../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    for same_prompt in [false, true] {
        for prior_has_id in [false, true] {
            for next_has_id in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let mut rows = fixture[..3].to_vec();
                if !prior_has_id {
                    rows[2]["payload"]
                        .as_object_mut()
                        .unwrap()
                        .remove("turn_id");
                }
                rows.push(json!({"type":"event_msg","payload":{"type":"agent_message","message":"Unfinished legacy answer","phase":"commentary"}}));
                let prompt = if same_prompt {
                    "Sanitized prompt"
                } else {
                    "Resumed legacy prompt"
                };
                let mut resumed = fixture[1].clone();
                resumed["payload"]["message"] = json!(prompt);
                let mut started = fixture[2].clone();
                let mut completed = fixture[4].clone();
                for row in [&mut started, &mut completed] {
                    if next_has_id {
                        row["payload"]["turn_id"] = json!("turn-2");
                    } else {
                        row["payload"].as_object_mut().unwrap().remove("turn_id");
                    }
                }
                rows.extend([resumed, started, completed]);
                write_codex_rows(home.path(), "session-activity", &rows);
                let result = history(home.path(), "codex", "session-activity");
                assert!(
                    result.status.success(),
                    "{}",
                    String::from_utf8_lossy(&result.stderr)
                );
                let body: Value = serde_json::from_slice(&result.stdout).unwrap();
                let turns = body["turns"].as_array().unwrap();
                let case = format!(
                    "same_prompt={same_prompt}, prior_id={prior_has_id}, next_id={next_has_id}"
                );
                assert_eq!(turns.len(), 4, "{case}: {body}");
                let prior_id = if prior_has_id {
                    "turn-1"
                } else {
                    "native-history-0"
                };
                let next_id = if next_has_id {
                    "turn-2"
                } else {
                    "native-history-1"
                };
                for (turn, (role, id, item_id, text)) in turns.iter().zip([
                    ("user", prior_id, "native-line-1:part:0", "Sanitized prompt"),
                    (
                        "assistant",
                        prior_id,
                        "native-line-3",
                        "Unfinished legacy answer",
                    ),
                    ("user", next_id, "native-line-4:part:0", prompt),
                    (
                        "assistant",
                        next_id,
                        "native-line-6",
                        "Sanitized completion",
                    ),
                ]) {
                    assert_eq!(turn["role"], role, "{case}");
                    assert_eq!(
                        turn["turnId"]
                            .as_str()
                            .unwrap()
                            .split(":row-")
                            .next()
                            .unwrap(),
                        id,
                        "{case}"
                    );
                    assert_eq!(turn["items"].as_array().unwrap().len(), 1, "{case}");
                    assert_eq!(turn["items"][0]["id"], item_id, "{case}");
                    assert_eq!(turn["items"][0]["text"], text, "{case}");
                }
                assert_eq!(body["capabilities"]["send"], false);
            }
        }
    }
}

#[test]
fn history_binary_preserves_codex_task_boundaries_without_context_or_completion_text() {
    for end in ["task_complete", "turn_aborted", "next_task_started"] {
        for has_id in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let mut rows = vec![
                json!({"type":"session_meta","payload":{"id":"task-boundaries","history_mode":"legacy"}}),
            ];
            for index in 0..2 {
                let id = format!("task-{index}");
                let mut started = json!({"type":"event_msg","payload":{"type":"task_started"}});
                if has_id {
                    started["payload"]["turn_id"] = json!(id);
                }
                rows.extend([
                    started,
                    json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}}),
                    codex_response_message("user", index, "Repeated saved prompt"),
                    codex_response_message("assistant", index, "Repeated saved answer"),
                    json!({"type":"event_msg","payload":{"type":"agent_message","message":"Repeated saved answer"}}),
                ]);
                if end != "next_task_started" {
                    let mut completed = json!({"type":"event_msg","payload":{"type":end,"last_agent_message":null}});
                    if has_id {
                        completed["payload"]["turn_id"] = json!(id);
                    }
                    rows.push(completed);
                }
            }
            write_codex_rows(home.path(), "task-boundaries", &rows);
            let result = history(home.path(), "codex", "task-boundaries");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let body: Value = serde_json::from_slice(&result.stdout).unwrap();
            let turns = body["turns"].as_array().unwrap();
            assert_eq!(turns.len(), 4, "end={end}, id={has_id}: {body}");
            assert_ne!(
                turns[0]["turnId"], turns[2]["turnId"],
                "distinct tasks: end={end}, id={has_id}"
            );
            for (index, turn) in turns.iter().enumerate() {
                assert_eq!(turn["items"].as_array().unwrap().len(), 1);
                assert_eq!(
                    turn["items"][0]["id"],
                    if index % 2 == 0 {
                        format!("user-{}:part:0", index / 2)
                    } else {
                        format!("assistant-{}", index / 2)
                    }
                );
                let saved_id = if has_id {
                    format!("task-{}", index / 2)
                } else {
                    format!("native-history-{}", index / 2)
                };
                assert_eq!(
                    turn["turnId"]
                        .as_str()
                        .unwrap()
                        .split(":row-")
                        .next()
                        .unwrap(),
                    saved_id,
                    "end={end}, id={has_id}"
                );
            }
        }
    }
}

#[test]
fn history_binary_keeps_delayed_codex_messages_and_tools_in_their_named_turn() {
    for next_has_id in [false, true] {
        for completion_has_text in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let mut next = json!({"type":"event_msg","payload":{"type":"task_started"}});
            if next_has_id {
                next["payload"]["turn_id"] = json!("named-1");
            }
            let rows = [
                json!({"type":"session_meta","payload":{"id":"delayed-turn","history_mode":"legacy"}}),
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"named-0"}}),
                json!({"type":"turn_context","payload":{"turn_id":"named-0"}}),
                codex_response_message("user", 0, "Repeated saved prompt"),
                json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"custom-0","name":"apply_patch","input":"saved patch"}}),
                codex_response_message("assistant", 0, "Repeated saved answer"),
                next,
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}}),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"named-0",
                    "last_agent_message": if completion_has_text { json!("Repeated saved answer") } else { Value::Null }}}),
                json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"named-0",
                    "item":{"type":"DynamicToolCall","id":"custom-0","tool":"apply_patch","arguments":"saved patch","status":"completed",
                        "content_items":[{"type":"inputText","text":"Delayed saved tool result"}],"success":true}}}),
                json!({"type":"turn_context","payload":{"turn_id":"named-1"}}),
                codex_response_message("user", 1, "Repeated saved prompt"),
                codex_response_message("assistant", 1, "Repeated saved answer"),
                json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"named-1","last_agent_message":"Repeated saved answer"}}),
            ];
            write_codex_rows(home.path(), "delayed-turn", &rows);
            let result = history(home.path(), "codex", "delayed-turn");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let body: Value = serde_json::from_slice(&result.stdout).unwrap();
            let turns = body["turns"].as_array().unwrap();
            assert_eq!(
                turns.len(),
                5,
                "next_id={next_has_id}, completion_text={completion_has_text}: {body}"
            );
            for (turn, (role, source)) in turns.iter().zip([
                ("user", 0),
                ("tool", 0),
                ("assistant", 0),
                ("user", 1),
                ("assistant", 1),
            ]) {
                assert_eq!(turn["role"], role);
                let items = turn["items"].as_array().unwrap();
                assert_eq!(items.len(), 1);
                assert_eq!(
                    items[0]["id"],
                    if role == "tool" {
                        "custom-0".to_owned()
                    } else if role == "user" {
                        format!("user-{source}:part:0")
                    } else {
                        format!("assistant-{source}")
                    }
                );
                assert_eq!(
                    turn["turnId"]
                        .as_str()
                        .unwrap()
                        .split(":row-")
                        .next()
                        .unwrap(),
                    format!("named-{source}")
                );
            }
            let tool = turns[1]["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["kind"] == "dynamic_tool")
                .unwrap();
            assert_eq!(tool["id"], "custom-0");
            assert_eq!(tool["status"], "completed");
            assert_eq!(tool["contentItems"][0]["text"], "Delayed saved tool result");
        }
    }
}

#[test]
fn history_binary_deduplicates_codex_message_mirrors_in_either_record_order() {
    for modern_first in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions/2026/10/03");
        std::fs::create_dir_all(&root).unwrap();
        let mut rows = vec![json!({"type":"session_meta","payload":{"id":"mixed-messages"}})];
        for turn in 0..4 {
            rows.push(
                json!({"type":"turn_context","payload":{"turn_id":format!("mixed-turn-{turn}")}}),
            );
            for (role, event_type, text_key, text) in [
                ("user", "user_message", "message", "Repeated saved prompt"),
                (
                    "assistant",
                    "task_complete",
                    "last_agent_message",
                    "Repeated saved answer",
                ),
            ] {
                let modern = json!({"type":"response_item","payload":{"type":"message","role":role,
                    "id":format!("{role}-{turn}"),"content":[{"type":if role == "user" {"input_text"} else {"output_text"},"text":text}]}});
                let legacy = json!({"type":"event_msg","payload":{"type":event_type,
                    "turn_id":format!("mixed-turn-{turn}"),text_key:text}});
                if turn == 2 {
                    rows.push(legacy);
                } else if turn == 3 {
                    rows.push(modern);
                } else if modern_first {
                    rows.extend([modern, legacy]);
                } else {
                    rows.extend([legacy, modern]);
                }
            }
        }
        std::fs::write(
            root.join("rollout-2026-10-03-mixed-messages.jsonl"),
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let result = history(home.path(), "codex", "mixed-messages");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        let turns = body["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 8);
        for (index, turn) in turns.iter().enumerate() {
            assert_eq!(
                turn["role"],
                if index % 2 == 0 { "user" } else { "assistant" }
            );
            assert_eq!(turn["items"].as_array().unwrap().len(), 1);
            assert_eq!(
                turn["items"][0]["text"],
                if index % 2 == 0 {
                    "Repeated saved prompt"
                } else {
                    "Repeated saved answer"
                }
            );
        }
    }
}

#[test]
fn history_binary_reads_large_sources_with_small_retained_conversations() {
    use std::io::Write;
    for provider in ["codex", "claude"] {
        let home = tempfile::tempdir().unwrap();
        let path = if provider == "codex" {
            rollout(home.path(), "large-thread", "Early saved answer");
            home.path()
                .join(".codex/sessions/2026/10/03/rollout-2026-10-03-large-thread.jsonl")
        } else {
            let directory = home.path().join(".claude/projects/workspace");
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join("large-thread.jsonl");
            std::fs::write(&path, format!("{}\n", json!({"type":"assistant","uuid":"early-answer","message":{"content":"Early saved answer"}}))).unwrap();
            path
        };
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file).unwrap();
        let progress =
            json!({"type":"progress","data":"ignored progress".repeat(2048)}).to_string();
        for _ in 0..600 {
            writeln!(file, "{progress}").unwrap();
        }
        if provider == "codex" {
            writeln!(file,"{}",json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"native-turn","last_agent_message":"Early saved answer"}})).unwrap();
            for row in [
                json!({"type":"turn_context","payload":{"turn_id":"latest-turn"}}),
                codex_response_message("user", 2, "Latest saved prompt"),
                codex_response_message("assistant", 2, "Latest saved answer"),
            ] {
                writeln!(file, "{row}").unwrap();
            }
        } else {
            writeln!(file,"{}",json!({"type":"user","uuid":"latest-prompt","message":{"content":"Latest saved prompt"}})).unwrap();
            writeln!(file,"{}",json!({"type":"assistant","uuid":"latest-answer","message":{"content":"Latest saved answer"}})).unwrap();
        }
        drop(file);
        let original = std::fs::read(&path).unwrap();
        assert!(original.len() as u64 > freshell_freshagent::native_history::MAX_HISTORY_BYTES);
        let result = history(home.path(), provider, "large-thread");
        assert!(
            result.status.success(),
            "{provider}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        let text = body["turns"].to_string();
        assert!(text.contains("Early saved answer"));
        assert!(text.contains("Latest saved prompt"));
        assert!(text.contains("Latest saved answer"));
        assert_ne!(
            body["extensions"][provider]["nativeHistoryRetention"]["partial"],
            true
        );
        assert_eq!(body["capabilities"]["send"], false);
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}

#[test]
fn history_binary_bounds_large_codex_display_without_losing_recent_turns_or_tools() {
    let home = tempfile::tempdir().unwrap();
    let mut rows = vec![json!({"type":"session_meta","payload":{"id":"large-display"}})];
    let answer = "Large saved answer \n".repeat(8000);
    for index in 0..160 {
        rows.extend([json!({"type":"event_msg","payload":{"type":"task_started","turn_id":format!("turn-{index}")}}),
            codex_response_message("user", index, "Repeated saved prompt"),
            codex_response_message("assistant", index, &answer),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":format!("turn-{index}"),"last_agent_message":answer}})]);
    }
    rows.extend([json!({"type":"turn_context","payload":{"turn_id":"latest-tool-turn"}}),
        codex_response_message("user", 160, "Latest saved prompt"),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"latest-tool","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"latest-tool","output":"/workspace"}}),
        codex_response_message("assistant", 160, "Latest saved answer")]);
    rows.push(json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-0","last_agent_message":"Older delayed answer"}}));
    write_codex_rows(home.path(), "large-display", &rows);
    let result = history(home.path(), "codex", "large-display");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!((result.stdout.len() as u64) < freshell_freshagent::native_history::MAX_HISTORY_BYTES);
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let retention = &body["extensions"]["codex"]["nativeHistoryRetention"];
    assert_eq!(retention["partial"], true);
    assert!(retention["omittedNativeTurns"].as_u64().unwrap() > 0);
    let turns = body["turns"].as_array().unwrap();
    assert!(turns.len() > 4);
    assert!(turns
        .to_vec()
        .iter()
        .any(|turn| turn["items"][0]["id"] == "latest-tool"
            && turn["items"][0]["kind"] == "dynamic_tool"));
    assert!(body["turns"].to_string().contains("/workspace"));
    assert_eq!(
        turns.last().unwrap()["items"][0]["text"],
        "Latest saved answer"
    );
    assert!(turns
        .iter()
        .any(|turn| turn["items"][0]["id"] == "user-159:part:0"));
    assert!(turns
        .iter()
        .any(|turn| turn["items"][0]["id"] == "assistant-159"));
}

#[test]
fn history_binary_preserves_oversized_codex_task_mirrors_and_subsequent_identical_input() {
    let home = tempfile::tempdir().unwrap();
    let huge = "Repeated saved answer é 🚀\n".repeat(650_000);
    let rows = vec![
        json!({"type":"session_meta","payload":{"id":"oversized-task"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"huge-turn"}}),
        codex_response_message("user", 0, "Repeated saved prompt"),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"huge-tool","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"huge-tool","output":huge}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":huge}}),
        codex_response_message("assistant", 0, &huge),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"huge-turn","last_agent_message":huge}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated saved prompt"}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"next-turn"}}),
        codex_response_message("user", 1, "Repeated saved prompt"),
        codex_response_message("assistant", 1, "Latest saved answer"),
    ];
    let directory = home.path().join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&directory).unwrap();
    let mut file = std::fs::File::create(directory.join("rollout-oversized-task.jsonl")).unwrap();
    use std::io::Write;
    for row in &rows {
        let text = if row["type"] == "response_item" && row["payload"]["role"] == "assistant" {
            row.to_string()
                .replace('é', "\\u00e9")
                .replace('🚀', "\\ud83d\\ude80")
        } else {
            row.to_string()
        };
        writeln!(file, "{text}").unwrap();
    }
    drop(file);
    let result = history(home.path(), "codex", "oversized-task");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(
        turns.iter().filter(|turn| turn["role"] == "user").count(),
        2
    );
    assert_eq!(
        turns
            .iter()
            .filter(|turn| turn["items"][0]["id"] == "assistant-0")
            .count(),
        1
    );
    assert_eq!(
        turns
            .iter()
            .filter(|turn| turn["role"] == "assistant")
            .count(),
        2
    );
    assert!(body["turns"].to_string().contains("huge-tool"));
    assert_eq!(
        turns.last().unwrap()["items"][0]["text"],
        "Latest saved answer"
    );
    assert_eq!(
        body["extensions"]["codex"]["nativeHistoryRetention"]["partial"],
        true
    );
    assert!(
        body["extensions"]["codex"]["nativeHistoryRetention"]["omittedBodies"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!((result.stdout.len() as u64) < freshell_freshagent::native_history::MAX_HISTORY_BYTES);
}

#[test]
fn history_binary_retains_large_claude_and_kilroy_tools_with_original_ordinals() {
    use std::io::Write;
    for provider in ["claude", "kilroy"] {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".claude/projects/workspace");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("large-claude.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        for _ in 0..100 {
            writeln!(
                file,
                "{}",
                json!({"type":"assistant","message":{"content":"Saved answer ".repeat(16_000)}})
            )
            .unwrap();
        }
        for row in [
            json!({"type":"user","uuid":"latest-prompt","message":{"content":"Latest saved prompt"}}),
            json!({"type":"assistant","uuid":"latest-invocation","message":{"content":[{"type":"tool_use","id":"huge-tool","name":"Read","input":{"file_path":"/workspace/saved.txt"}}]}}),
            json!({"type":"user","uuid":"latest-result","message":{"content":[{"type":"tool_result","tool_use_id":"huge-tool","content":"Saved output ".repeat(1_500_000)}]}}),
            json!({"type":"assistant","uuid":"latest-answer","message":{"content":"Latest saved answer"}}),
        ] {
            writeln!(file, "{row}").unwrap();
        }
        drop(file);
        let before = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let result = history(home.path(), provider, "large-claude");
        assert!(
            result.status.success(),
            "{provider}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        let turns = body["turns"].as_array().unwrap();
        assert!(turns[0]["ordinal"].as_u64().unwrap() > 0);
        assert_eq!(
            turns[0]["id"],
            format!("large-claude:{}", turns[0]["ordinal"])
        );
        let items: Vec<_> = turns
            .iter()
            .flat_map(|turn| turn["items"].as_array().unwrap())
            .collect();
        assert!(items
            .iter()
            .any(|item| item["kind"] == "tool_use" && item["toolUseId"] == "huge-tool"));
        assert!(items.iter().any(|item| item["kind"] == "tool_result"
            && item["toolUseId"] == "huge-tool"
            && item["content"] == "[Content omitted from retained history]"));
        assert_eq!(body["latestTurnId"], "latest-answer");
        assert_eq!(turns.last().unwrap()["ordinal"], 103);
        assert_eq!(
            body["extensions"]["claude"]["nativeHistoryRetention"]["partial"],
            true
        );
        assert_eq!(body["capabilities"]["send"], false);
        assert!(
            (result.stdout.len() as u64) < freshell_freshagent::native_history::MAX_HISTORY_BYTES
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
    }
}

#[test]
fn history_binary_bounds_large_opencode_active_and_reverted_history_including_wal() {
    for (journal, keep_open) in [("DELETE", false), ("WAL", false), ("WAL", true)] {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".local/share/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("opencode.db");
        let db = Connection::open(&path).unwrap();
        db.pragma_update(None, "journal_mode", journal).unwrap();
        db.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER,revert TEXT);
          CREATE TABLE message (id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
          CREATE TABLE part (id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);
          INSERT INTO session VALUES ('large-opencode','Saved title',2,'{\"messageID\":\"message-100\"}');
          INSERT INTO session VALUES ('foreign','Foreign',2,NULL);").unwrap();
        for ordinal in 0..200 {
            let id = format!("message-{ordinal}");
            db.execute(
                "INSERT INTO message VALUES (?1,'large-opencode',?2,?3)",
                rusqlite::params![
                    id,
                    ordinal,
                    json!({"role":if ordinal % 2 == 0 {"user"} else {"assistant"}}).to_string()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO part VALUES (?1,'large-opencode',?2,0,?3)",
                rusqlite::params![
                    format!("part-{ordinal}"),
                    id,
                    json!({"type":"text","text":"Saved conversation ".repeat(10_000)}).to_string()
                ],
            )
            .unwrap();
        }
        db.execute("INSERT INTO part VALUES ('huge-tool-part','large-opencode','message-199',1,?1)", [json!({"type":"tool","callID":"huge-call","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"Saved output ".repeat(1_500_000)}}).to_string()]).unwrap();
        db.execute(
            "INSERT INTO message VALUES ('foreign-message','foreign',0,'{\"role\":\"assistant\"}')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO part VALUES ('foreign-part','foreign','foreign-message',0,'{\"type\":\"text\",\"text\":\"Foreign history\"}')", []).unwrap();
        let writer = if keep_open {
            Some(db)
        } else {
            drop(db);
            None
        };
        let before = std::fs::read(&path).unwrap();
        let wal_before = keep_open.then(|| std::fs::read(path.with_extension("db-wal")).unwrap());
        let result = history(home.path(), "opencode", "large-opencode");
        assert!(
            result.status.success(),
            "{journal} open {keep_open}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        let active = body["turns"].as_array().unwrap();
        let reverted = body["rolledBackTurns"].as_array().unwrap();
        assert_eq!(body["latestTurnId"], "message-99");
        assert_eq!(active.last().unwrap()["ordinal"], 99);
        assert!(active[0]["ordinal"].as_u64().unwrap() > 0);
        assert!(
            reverted[0]["ordinal"].as_u64().unwrap() > 100,
            "eviction must not forget the revert pointer"
        );
        assert!(reverted
            .iter()
            .all(|turn| turn["rolledBack"] == true && turn["restorable"] == false));
        let tool_items = reverted.last().unwrap()["items"].as_array().unwrap();
        let tool = tool_items
            .iter()
            .find(|item| item["id"] == "huge-tool-part")
            .unwrap();
        assert_eq!(tool["kind"], "dynamic_tool");
        assert_eq!(tool["tool"], "bash");
        assert_eq!(tool["status"], "completed");
        assert_eq!(tool["arguments"]["command"], "pwd");
        assert_eq!(
            tool["contentItems"][0],
            "[Content omitted from retained history]"
        );
        assert_eq!(tool["success"], true);
        assert!(!body.to_string().contains("Foreign history"));
        assert_eq!(
            body["extensions"]["opencode"]["nativeHistoryRetention"]["partial"],
            true
        );
        assert_eq!(body["capabilities"]["send"], false);
        assert!(
            (result.stdout.len() as u64) < freshell_freshagent::native_history::MAX_HISTORY_BYTES
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(path.with_extension("db-wal").exists(), keep_open);
        assert_eq!(path.with_extension("db-shm").exists(), keep_open);
        if let Some(wal) = wal_before {
            assert_eq!(std::fs::read(path.with_extension("db-wal")).unwrap(), wal);
        }
        drop(writer);
    }
}

#[test]
fn history_binary_keeps_codex_tool_output_with_its_invocation() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "tool-thread", "Saved answer");
    let path = home
        .path()
        .join(".codex/sessions/2026/10/03/rollout-2026-10-03-tool-thread.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file,"\n{}",json!({"type":"response_item","payload":{"type":"function_call","call_id":"tool-1","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}})).unwrap();
    writeln!(file,"{}",json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"tool-1","output":"/workspace"}})).unwrap();
    let result = history(home.path(), "codex", "tool-thread");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let items: Vec<_> = body["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().unwrap())
        .collect();
    let tool = items
        .iter()
        .find(|item| item["kind"] == "dynamic_tool")
        .unwrap();
    assert_eq!(tool["tool"], "exec_command");
    assert_eq!(tool["contentItems"][0]["text"], "/workspace");
    assert!(items
        .iter()
        .all(|item| item["kind"] != "text" || item["text"] != "/workspace"));
}

#[test]
fn history_binary_reads_exact_saved_opencode_rows_without_a_daemon() {
    for (has_revert, journal_mode, keep_open) in [
        (false, "DELETE", false),
        (false, "WAL", false),
        (false, "WAL", true),
        (true, "DELETE", false),
        (true, "WAL", false),
        (true, "WAL", true),
    ] {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join(".local/share/opencode");
        std::fs::create_dir_all(&directory).unwrap();
        let db = Connection::open(directory.join("opencode.db")).unwrap();
        db.pragma_update(None, "journal_mode", journal_mode)
            .unwrap();
        db.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);").unwrap();
        if has_revert {
            db.execute_batch("ALTER TABLE session ADD COLUMN revert TEXT")
                .unwrap();
        }
        for (id, text) in [
            ("ses_selected", "Saved OpenCode answer"),
            ("ses_other", "Other conversation must not appear"),
        ] {
            db.execute(
                "INSERT INTO session (id,title,directory,time_created,time_updated) VALUES (?1,'Saved name','/workspace',1,2)",
                [id],
            )
            .unwrap();
            for (message, role, text) in [
                (format!("{id}-user"), "user", "Saved user prompt"),
                (format!("{id}-assistant"), "assistant", text),
            ] {
                db.execute(
                    "INSERT INTO message VALUES (?1,?2,?3,?4)",
                    rusqlite::params![
                        message,
                        id,
                        if role == "user" { 1 } else { 2 },
                        json!({"role":role,"time":{"created":1,"completed":2}}).to_string()
                    ],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO part VALUES (?1,?2,?3,1,?4)",
                    rusqlite::params![
                        format!("{message}-text"),
                        id,
                        message,
                        json!({"type":"text","text":text}).to_string()
                    ],
                )
                .unwrap();
            }
        }
        let writer = if keep_open {
            Some(db)
        } else {
            drop(db);
            None
        };
        let before = std::fs::read(directory.join("opencode.db")).unwrap();
        if journal_mode == "WAL" {
            assert_eq!(&before[18..20], &[2, 2]);
        }
        assert_eq!(directory.join("opencode.db-wal").exists(), keep_open);
        assert_eq!(directory.join("opencode.db-shm").exists(), keep_open);
        let wal_before =
            keep_open.then(|| std::fs::read(directory.join("opencode.db-wal")).unwrap());
        let result = history(home.path(), "opencode", "ses_selected");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(body["threadId"], "ses_selected");
        assert_eq!(body["turns"].as_array().unwrap().len(), 2);
        assert_eq!(body["turns"][0]["items"][0]["text"], "Saved user prompt");
        assert_eq!(
            body["turns"][1]["items"][0]["text"],
            "Saved OpenCode answer"
        );
        assert_eq!(body["capabilities"]["send"], false);
        assert_eq!(
            std::fs::read(directory.join("opencode.db")).unwrap(),
            before
        );
        assert_eq!(directory.join("opencode.db-wal").exists(), keep_open);
        assert_eq!(directory.join("opencode.db-shm").exists(), keep_open);
        if let Some(wal_before) = wal_before {
            assert_eq!(
                std::fs::read(directory.join("opencode.db-wal")).unwrap(),
                wal_before
            );
        }
        assert!(!history(home.path(), "opencode", "missing-session")
            .status
            .success());
        drop(writer);
        if has_revert {
            let db = Connection::open(directory.join("opencode.db")).unwrap();
            db.execute(
                "UPDATE session SET revert = ?1 WHERE id = 'ses_selected'",
                [json!({"messageID":"ses_selected-assistant"}).to_string()],
            )
            .unwrap();
            drop(db);
            let before = std::fs::read(directory.join("opencode.db")).unwrap();
            let result = history(home.path(), "opencode", "ses_selected");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let body: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(body["turns"].as_array().unwrap().len(), 1);
            assert_eq!(body["turns"][0]["items"][0]["text"], "Saved user prompt");
            let tail = body["rolledBackTurns"].as_array().unwrap();
            assert_eq!(tail.len(), 1);
            assert_eq!(tail[0]["items"][0]["text"], "Saved OpenCode answer");
            assert_eq!(tail[0]["rolledBack"], true);
            assert_eq!(tail[0]["restorable"], false);
            assert_eq!(
                std::fs::read(directory.join("opencode.db")).unwrap(),
                before
            );
            assert!(!directory.join("opencode.db-wal").exists());
            assert!(!directory.join("opencode.db-shm").exists());
        }
    }
}

#[test]
fn history_binary_reads_managed_claude_transcript_and_tools_from_exact_provider_home() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".claude/projects/-workspace");
    std::fs::create_dir_all(&directory).unwrap();
    let id = "44444444-4444-4444-8444-444444444444";
    let native = include_str!("../../../test/fixtures/managed-native-history/claude.jsonl");
    std::fs::write(directory.join(format!("{id}.jsonl")), native).unwrap();
    std::fs::write(
        directory.join("foreign.jsonl"),
        native.replace("Saved native Claude answer", "Foreign history"),
    )
    .unwrap();
    for provider in ["claude", "kilroy"] {
        let result = history(home.path(), provider, id);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let body: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(body["threadId"], id);
        assert_eq!(body["provider"], "claude");
        let captured: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/managed-native-history/claude.json"
        ))
        .unwrap();
        assert_eq!(body["turns"], captured["turns"]);
        assert!(result
            .stdout
            .windows(b"Saved native Claude answer".len())
            .any(|part| part == b"Saved native Claude answer"));
        assert!(body["turns"].to_string().contains("toolu_native"));
        assert!(body["turns"].to_string().contains("/workspace"));
        assert!(!body.to_string().contains("Foreign history"));
        assert_eq!(body["capabilities"]["send"], false);
        assert_eq!(
            std::fs::read_to_string(directory.join(format!("{id}.jsonl"))).unwrap(),
            native
        );
    }
    assert!(!history(home.path(), "claude", "missing").status.success());
}

#[test]
fn history_binary_preserves_custom_tools_and_persisted_completed_actions() {
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".codex/sessions/2026/10/03");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("rollout-rich-tools.jsonl"),
        include_str!("../../../test/fixtures/managed-native-history/codex-tools.jsonl"),
    )
    .unwrap();
    let result = history(home.path(), "codex", "rich-tools");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let captured: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/managed-native-history/codex-tools.json"
    ))
    .unwrap();
    assert_eq!(body["turns"], captured["turns"]);
    let items: Vec<_> = body["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().unwrap())
        .collect();
    let custom: Vec<_> = items
        .iter()
        .filter(|item| item["kind"] == "dynamic_tool" && item["tool"] == "apply_patch")
        .collect();
    assert_eq!(
        custom.len(),
        1,
        "call and completed event must not duplicate"
    );
    assert_eq!(custom[0]["status"], "completed");
    assert_eq!(custom[0]["contentItems"][0]["text"], "Patch saved");
    assert!(items.iter().any(|item| item["kind"] == "command"
        && item["output"] == "/workspace"
        && item["exitCode"] == 0));
    assert!(items
        .iter()
        .any(|item| item["kind"] == "web_search" && item["query"] == "SQLite WAL"));
    assert!(items
        .iter()
        .any(|item| item["kind"] == "image_generation" && item["result"] == "saved-image"));
    assert!(items.iter().any(|item| item["kind"] == "mcp_tool"
        && item["result"]["content"][0]["text"] == "MCP saved result"));
}

#[test]
fn history_binary_preserves_legacy_persisted_tool_events() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "legacy-tools", "Saved answer");
    let path = home
        .path()
        .join(".codex/sessions/2026/10/03/rollout-2026-10-03-legacy-tools.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for payload in [
        json!({"type":"patch_apply_end","call_id":"patch-1","success":true,"status":"completed","stdout":"Saved patch","stderr":"","changes":{"/workspace/saved.rs":{"type":"update","unified_diff":"+saved change","move_path":null}}}),
        json!({"type":"mcp_tool_call_end","call_id":"mcp-legacy","invocation":{"server":"fixture","tool":"lookup","arguments":{"saved":true}},"result":{"Ok":{"content":[{"type":"text","text":"Legacy MCP result"}]}}}),
        json!({"type":"web_search_end","call_id":"search-legacy","query":"saved search","action":{"type":"search","query":"saved search"}}),
    ] {
        writeln!(file, "\n{}", json!({"type":"event_msg","payload":payload})).unwrap();
    }
    let result = history(home.path(), "codex", "legacy-tools");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let items: Vec<_> = body["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().unwrap())
        .collect();
    assert!(items
        .iter()
        .any(|item| item["kind"] == "file_change"
            && item["changes"][0]["path"] == "/workspace/saved.rs"));
    assert!(items.iter().any(|item| item["kind"] == "mcp_tool"
        && item["result"]["content"][0]["text"] == "Legacy MCP result"));
    assert!(items
        .iter()
        .any(|item| item["kind"] == "web_search" && item["query"] == "saved search"));
}

#[test]
fn history_binary_keeps_native_shell_and_tool_search_outputs() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "other-tools", "Saved answer");
    let path = home
        .path()
        .join(".codex/sessions/2026/10/03/rollout-2026-10-03-other-tools.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for payload in [
        json!({"type":"local_shell_call","call_id":"shell-1","status":"completed","action":{"type":"exec","command":["pwd"],"working_directory":"/workspace"}}),
        json!({"type":"function_call_output","call_id":"shell-1","output":"Saved shell output"}),
        json!({"type":"tool_search_call","call_id":"search-tools","execution":"client","arguments":{"query":"saved"}}),
        json!({"type":"tool_search_output","call_id":"search-tools","status":"completed","execution":"client","tools":[{"name":"native-search-tool"}]}),
    ] {
        writeln!(
            file,
            "\n{}",
            json!({"type":"response_item","payload":payload})
        )
        .unwrap();
    }
    let result = history(home.path(), "codex", "other-tools");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let body: Value = serde_json::from_slice(&result.stdout).unwrap();
    let items: Vec<_> = body["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|turn| turn["items"].as_array().unwrap())
        .collect();
    assert!(items.iter().any(|item| item["kind"] == "command"
        && item["command"] == "pwd"
        && item["output"] == "Saved shell output"));
    assert!(items.iter().any(|item| item["kind"] == "dynamic_tool"
        && item["tool"] == "tool_search"
        && item["contentItems"][0]["name"] == "native-search-tool"));
}

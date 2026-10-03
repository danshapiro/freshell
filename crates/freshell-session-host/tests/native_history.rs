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
fn history_binary_reports_oversize_instead_of_truncating_the_transcript() {
    let home = tempfile::tempdir().unwrap();
    rollout(home.path(), "large-thread", "Saved answer");
    let path = home
        .path()
        .join(".codex/sessions/2026/10/03/rollout-2026-10-03-large-thread.jsonl");
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_len(freshell_freshagent::native_history::MAX_HISTORY_BYTES + 1)
        .unwrap();
    let result = history(home.path(), "codex", "large-thread");
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("native transcript exceeds history read limit"));
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

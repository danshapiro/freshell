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
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".local/share/opencode");
    std::fs::create_dir_all(&directory).unwrap();
    let db = Connection::open(directory.join("opencode.db")).unwrap();
    db.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, revert TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);").unwrap();
    for (id, text) in [
        ("ses_selected", "Saved OpenCode answer"),
        ("ses_other", "Other conversation must not appear"),
    ] {
        db.execute(
            "INSERT INTO session VALUES (?1,'Saved name','/workspace',1,2,NULL)",
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
    drop(db);
    let before = std::fs::read(directory.join("opencode.db")).unwrap();
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
    assert!(!history(home.path(), "opencode", "missing-session")
        .status
        .success());
}

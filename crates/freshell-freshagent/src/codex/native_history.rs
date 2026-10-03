use serde_json::{json, Value};
use std::{
    io::{BufRead, Read},
    path::Path,
};

pub(crate) fn read(home: &Path, id: &str) -> Result<Value, String> {
    let path = super::locate_thread_rollout(&home.join(".codex/sessions"), id)
        .ok_or("saved native session not found")?;
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > crate::native_history::MAX_HISTORY_BYTES
    {
        return Err("native transcript exceeds history read limit".into());
    }
    let mut turns = Vec::new();
    let mut turn = json!({"id":"native-history-0","items":[]});
    for (line, row) in std::io::BufReader::new(file)
        .take(crate::native_history::MAX_HISTORY_BYTES + 1)
        .lines()
        .enumerate()
    {
        let row = row.map_err(|e| e.to_string())?;
        // A crash can leave an incomplete final JSONL record; earlier durable records remain readable.
        let Ok(row) = serde_json::from_str::<Value>(&row) else {
            continue;
        };
        let payload = &row["payload"];
        match row["type"].as_str() {
            Some("turn_context") => {
                if let Some(next) = payload["turn_id"].as_str() {
                    if turn["id"] != next {
                        if !turn["items"].as_array().unwrap().is_empty() {
                            turns.push(turn);
                        }
                        turn = json!({"id":next,"items":[]});
                    }
                }
            }
            Some("response_item") => {
                if payload["type"] == "function_call_output" {
                    let call_id = payload["call_id"].as_str();
                    if let Some(call) =
                        turn["items"]
                            .as_array_mut()
                            .unwrap()
                            .iter_mut()
                            .rev()
                            .find(|item| {
                                item["type"] == "dynamicToolCall" && item["id"].as_str() == call_id
                            })
                    {
                        call["contentItems"] =
                            json!([{"type":"inputText","text":payload["output"]}]);
                        call["status"] = json!("completed");
                    }
                    continue;
                }
                if let Some(mut item) = normalize_item(payload) {
                    item["id"] = payload
                        .get("id")
                        .or_else(|| payload.get("call_id"))
                        .cloned()
                        .unwrap_or_else(|| json!(format!("native-line-{line}")));
                    turn["items"].as_array_mut().unwrap().push(item);
                }
            }
            _ => {}
        }
    }
    if !turn["items"].as_array().unwrap().is_empty() {
        turns.push(turn);
    }
    super::build_codex_snapshot_json(
        id,
        &json!({"thread":{"id":id,"status":"idle","turns":turns}}),
        false,
        None,
        None,
        false,
    )
}

fn normalize_item(item: &Value) -> Option<Value> {
    match item["type"].as_str()? {
        "message" => match item["role"].as_str()? {
            "user" => Some(json!({"type":"userMessage","content":item["content"]})),
            "assistant" => Some(json!({"type":"agentMessage","text":text_parts(&item["content"])})),
            _ => None,
        },
        "reasoning" => {
            Some(json!({"type":"reasoning","summary":[text_parts(&item["summary"])],"content":[]}))
        }
        "function_call" => Some(
            json!({"type":"dynamicToolCall","tool":item["name"],"arguments":item["arguments"],"status":"inProgress"}),
        ),
        _ => None,
    }
}

fn text_parts(parts: &Value) -> String {
    parts
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

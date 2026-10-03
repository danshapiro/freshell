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
                let item_type = payload["type"].as_str().unwrap_or("");
                if matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output" | "tool_search_output"
                ) {
                    let call_id = payload["call_id"].as_str();
                    let items = turn["items"].as_array_mut().unwrap();
                    if let Some(call) = items
                        .iter_mut()
                        .rev()
                        .find(|item| item["id"].as_str() == call_id)
                    {
                        let output = if item_type == "tool_search_output" {
                            &payload["tools"]
                        } else {
                            &payload["output"]
                        };
                        if call["type"] == "commandExecution" {
                            call["aggregatedOutput"] = json!(output
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| output.to_string()));
                        } else {
                            call["contentItems"] = output_content(output);
                        }
                        call["status"] = json!("completed");
                    } else {
                        // A persisted output can outlive its invocation after compaction.
                        let item = json!({"id":call_id.map(str::to_owned).unwrap_or_else(|| format!("native-line-{line}")),"type":"dynamicToolCall",
                            "tool":payload["name"].as_str().unwrap_or("tool output"),"status":"completed",
                            "contentItems":output_content(if item_type == "tool_search_output" { &payload["tools"] } else { &payload["output"] })});
                        upsert_item(&mut turn, item);
                    }
                    continue;
                }
                if let Some(mut item) = normalize_item(payload) {
                    item["id"] = payload
                        .get("call_id")
                        .filter(|id| id.is_string())
                        .or_else(|| payload.get("id").filter(|id| id.is_string()))
                        .cloned()
                        .unwrap_or_else(|| json!(format!("native-line-{line}")));
                    upsert_item(&mut turn, item);
                }
            }
            Some("event_msg") => {
                let item = if payload["type"] == "item_completed" {
                    normalize_completed(&payload["item"])
                } else {
                    normalize_legacy_event(payload)
                };
                if let Some(item) = item {
                    // Completed actions enrich their earlier response item by call identity.
                    // A delayed completion still belongs to its recorded turn.
                    let target = payload["turn_id"]
                        .as_str()
                        .and_then(|id| turns.iter_mut().find(|turn: &&mut Value| turn["id"] == id));
                    upsert_item(target.unwrap_or(&mut turn), item);
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
        "agent_message" => Some(json!({"type":"agentMessage","text":text_parts(&item["content"])})),
        "reasoning" => Some(
            json!({"type":"reasoning","summary":[text_parts(&item["summary"])],"content":[text_parts(&item["content"])]}),
        ),
        "function_call" | "custom_tool_call" => Some(
            json!({"type":"dynamicToolCall","tool":item["name"],"namespace":item["namespace"],
                "arguments":if item["type"] == "custom_tool_call" { &item["input"] } else { &item["arguments"] },"status":"inProgress"}),
        ),
        "tool_search_call" => Some(
            json!({"type":"dynamicToolCall","tool":"tool_search","arguments":item["arguments"],"status":"inProgress"}),
        ),
        "local_shell_call" => Some(
            json!({"type":"commandExecution","command":command_text(&item["action"]["command"]),
            "cwd":item["action"]["working_directory"],"status":item["status"]}),
        ),
        "web_search_call" => Some(
            json!({"type":"webSearch","query":item["action"]["query"],"action":item["action"]}),
        ),
        "image_generation_call" => Some(
            json!({"type":"imageGeneration","status":item["status"],"result":item["result"],"revisedPrompt":item["revised_prompt"]}),
        ),
        "compaction" | "context_compaction" => Some(json!({"type":"contextCompaction"})),
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

fn upsert_item(turn: &mut Value, item: Value) {
    let items = turn["items"].as_array_mut().unwrap();
    if let Some(existing) = items.iter_mut().find(|old| old["id"] == item["id"]) {
        if existing["type"] == item["type"] {
            existing
                .as_object_mut()
                .unwrap()
                .extend(item.as_object().unwrap().clone());
        } else {
            *existing = item;
        }
    } else {
        items.push(item);
    }
}

fn output_content(output: &Value) -> Value {
    if let Some(parts) = output.as_array() {
        json!(parts
            .iter()
            .map(|part| match part["type"].as_str() {
                Some("input_text" | "text") => json!({"type":"inputText","text":part["text"]}),
                Some("input_image") => json!({"type":"inputImage","imageUrl":part["image_url"]}),
                _ => part.clone(),
            })
            .collect::<Vec<_>>())
    } else {
        json!([{"type":"inputText","text":output.as_str().map(str::to_owned).unwrap_or_else(|| output.to_string())}])
    }
}

fn command_text(command: &Value) -> String {
    command.as_str().map(str::to_owned).unwrap_or_else(|| {
        command
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    })
}

fn normalize_completed(raw: &Value) -> Option<Value> {
    let native_type = raw["type"].as_str()?;
    if native_type == "FunctionCallOutput" {
        return Some(
            json!({"id":raw["id"],"type":"dynamicToolCall","tool":raw["name"],
            "namespace":raw["namespace"],"status":"completed","contentItems":output_content(&raw["output"])}),
        );
    }
    // Message/reasoning response records already carry the same durable content;
    // their event ids can differ. Action events are the authoritative rich display form.
    let wire_type = match native_type {
        "CommandExecution" => "commandExecution",
        "DynamicToolCall" => "dynamicToolCall",
        "McpToolCall" => "mcpToolCall",
        "FileChange" => "fileChange",
        "WebSearch" => "webSearch",
        "ImageGeneration" => "imageGeneration",
        "ImageView" => "imageView",
        "CollabAgentToolCall" => "collabAgentToolCall",
        "Plan" => "plan",
        "ContextCompaction" => "contextCompaction",
        "EnteredReviewMode" => "enteredReviewMode",
        "ExitedReviewMode" => "exitedReviewMode",
        _ => return None,
    };
    let mut item = raw.clone();
    item["type"] = json!(wire_type);
    for (native, wire) in [
        ("aggregated_output", "aggregatedOutput"),
        ("exit_code", "exitCode"),
        ("content_items", "contentItems"),
        ("revised_prompt", "revisedPrompt"),
        ("saved_path", "savedPath"),
        ("sender_thread_id", "senderThreadId"),
        ("receiver_thread_ids", "receiverThreadIds"),
        ("agents_states", "agentsStates"),
        ("reasoning_effort", "reasoningEffort"),
    ] {
        if let Some(value) = item.as_object_mut()?.remove(native) {
            item[wire] = value;
        }
    }
    if item["status"] == "in_progress" {
        item["status"] = json!("inProgress");
    }
    if wire_type == "commandExecution" {
        item["command"] = json!(command_text(&raw["command"]));
    }
    if wire_type == "fileChange" {
        if let Some(changes) = raw["changes"].as_object() {
            item["changes"] = json!(changes
                .iter()
                .map(|(path, change)| {
                    let mut change = change.clone();
                    change["path"] = json!(path);
                    change
                })
                .collect::<Vec<_>>());
        }
    }
    Some(item)
}

fn normalize_legacy_event(raw: &Value) -> Option<Value> {
    let kind = raw["type"].as_str()?;
    let mut item = match kind {
        "patch_apply_end" => {
            let mut native = raw.clone();
            native["type"] = json!("FileChange");
            normalize_completed(&native)?
        }
        "mcp_tool_call_end" => json!({"type":"mcpToolCall","server":raw["invocation"]["server"],
            "tool":raw["invocation"]["tool"],"arguments":raw["invocation"]["arguments"],
            "status":if raw["result"].get("Err").is_some() {"failed"} else {"completed"},
            "result":raw["result"]["Ok"],"error":raw["result"]["Err"]}),
        "web_search_end" => json!({"type":"webSearch","query":raw["query"],"action":raw["action"]}),
        "image_generation_end" => {
            let mut native = raw.clone();
            native["type"] = json!("ImageGeneration");
            normalize_completed(&native)?
        }
        _ => return None,
    };
    item["id"] = raw["call_id"].clone();
    Some(item)
}

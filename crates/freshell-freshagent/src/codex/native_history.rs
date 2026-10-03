use serde_json::{json, Value};
use std::{
    io::{BufRead, Read},
    path::Path,
};

pub(crate) fn read(home: &Path, id: &str) -> Result<Value, String> {
    let path = super::locate_thread_rollout(&home.join(".codex/sessions"), id)
        .ok_or("saved native session not found")?;
    read_rollout(&path, id)
}

pub(super) fn read_rollout(path: &Path, id: &str) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > crate::native_history::MAX_HISTORY_BYTES
    {
        return Err("native transcript exceeds history read limit".into());
    }
    let mut turns = Vec::new();
    let mut turn = NativeTurn::new(0);
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
                    activate_turn(&mut turns, &mut turn, Some(next), false);
                }
            }
            Some("response_item") => {
                let item_type = payload["type"].as_str().unwrap_or("");
                if matches!(
                    item_type,
                    "function_call_output" | "custom_tool_call_output" | "tool_search_output"
                ) {
                    let call_id = payload["call_id"].as_str();
                    let items = turn.value["items"].as_array_mut().unwrap();
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
                        upsert_item(&mut turn.value, item);
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
                    if item["type"] == "userMessage" && turn.finished {
                        activate_turn(&mut turns, &mut turn, None, false);
                    }
                    upsert_transcript_item(&mut turn, item, MessageSource::Response);
                }
            }
            Some("event_msg") => {
                if payload["type"] == "task_started" {
                    activate_turn(&mut turns, &mut turn, payload["turn_id"].as_str(), true);
                    continue;
                }
                let item = if payload["type"] == "item_completed" {
                    normalize_completed(&payload["item"])
                } else {
                    normalize_message_event(payload, line)
                        .or_else(|| normalize_legacy_event(payload))
                };
                let finished = matches!(
                    payload["type"].as_str(),
                    Some("task_complete" | "turn_aborted")
                );
                if item.is_none() && !finished {
                    continue;
                }
                // A delayed completion still belongs to its recorded turn.
                let previous = payload["turn_id"]
                    .as_str()
                    .and_then(|id| turns.iter().position(|turn| turn.has_id(id)));
                let target = if let Some(previous) = previous {
                    &mut turns[previous]
                } else {
                    if let Some(id) = payload["turn_id"].as_str() {
                        activate_turn(&mut turns, &mut turn, Some(id), false);
                    } else if item
                        .as_ref()
                        .is_some_and(|item| item["type"] == "userMessage")
                        && turn.finished
                    {
                        activate_turn(&mut turns, &mut turn, None, false);
                    }
                    &mut turn
                };
                if let Some(item) = item {
                    upsert_transcript_item(
                        target,
                        item,
                        if payload["type"] == "task_complete" {
                            MessageSource::Completion
                        } else {
                            MessageSource::Event
                        },
                    );
                }
                target.finished |= finished;
            }
            _ => {}
        }
    }
    if turn.has_items() {
        turns.push(turn);
    }
    let turns: Vec<_> = turns.into_iter().map(|turn| turn.value).collect();
    super::build_codex_snapshot_json(
        id,
        &json!({"thread":{"id":id,"status":"idle","turns":turns}}),
        false,
        None,
        None,
        false,
    )
}

struct NativeTurn {
    value: Value,
    mirror: Option<MessageMirror>,
    named: bool,
    started: bool,
    finished: bool,
}

impl NativeTurn {
    fn new(index: usize) -> Self {
        Self {
            value: json!({"id":format!("native-history-{index}"),"items":[]}),
            mirror: None,
            named: false,
            started: false,
            finished: false,
        }
    }

    fn has_id(&self, id: &str) -> bool {
        self.value["id"] == id
    }

    fn has_items(&self) -> bool {
        !self.value["items"].as_array().unwrap().is_empty()
    }
}

fn activate_turn(
    turns: &mut Vec<NativeTurn>,
    turn: &mut NativeTurn,
    id: Option<&str>,
    starts_task: bool,
) {
    if id.is_some_and(|id| turn.has_id(id)) {
        turn.named = true;
        turn.started |= starts_task;
        return;
    }
    // A pre-context message belongs to the still-unnamed task. Bind its identity
    // without losing its mirror; completed or newly started tasks never share it.
    let can_bind = !(turn.named || turn.finished || starts_task && turn.started);
    let can_start_current = id.is_none() && !turn.started && !turn.finished;
    if !can_bind && !can_start_current {
        let has_items = turn.has_items();
        let previous =
            std::mem::replace(turn, NativeTurn::new(turns.len() + usize::from(has_items)));
        if has_items {
            turns.push(previous);
        }
    }
    if let Some(id) = id {
        turn.value["id"] = json!(id);
        turn.named = true;
    }
    turn.started |= starts_task;
}

struct MessageMirror {
    item: Value,
    sources: Vec<MessageSource>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MessageSource {
    Response,
    Event,
    Completion,
}

fn normalize_message_event(payload: &Value, line: usize) -> Option<Value> {
    let (kind, field) = match payload["type"].as_str()? {
        "user_message" => ("userMessage", "message"),
        "agent_message" => ("agentMessage", "message"),
        "task_complete" => ("agentMessage", "last_agent_message"),
        _ => return None,
    };
    let text = payload[field].as_str().filter(|text| !text.is_empty())?;
    let mut item = json!({"id":format!("native-line-{line}"),"type":kind});
    if kind == "userMessage" {
        item["content"] = json!([{"type":"input_text","text":text}]);
    } else {
        item["text"] = json!(text);
    }
    Some(item)
}

fn message_text(item: &Value) -> Option<String> {
    match item["type"].as_str()? {
        "userMessage" => Some(text_parts(&item["content"])),
        "agentMessage" => Some(item["text"].as_str().unwrap_or("").to_owned()),
        _ => None,
    }
}

fn upsert_transcript_item(turn: &mut NativeTurn, item: Value, source: MessageSource) {
    let Some(text) = message_text(&item) else {
        upsert_item(&mut turn.value, item);
        return;
    };
    if let Some(previous) = turn.mirror.as_mut() {
        if !previous.sources.contains(&source)
            && previous.item["type"] == item["type"]
            && message_text(&previous.item).as_deref() == Some(text.as_str())
        {
            // A message may be recorded as a response, an agent event, and a task
            // completion. Each source mirrors this occurrence once; repeated
            // messages from the same source start a new occurrence.
            previous.sources.push(source);
            if source == MessageSource::Response {
                if let Some(existing) = turn.value["items"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|old| old["id"] == previous.item["id"])
                {
                    *existing = item.clone();
                }
                previous.item = item;
            }
            return;
        }
    }
    turn.mirror = Some(MessageMirror {
        item: item.clone(),
        sources: vec![source],
    });
    upsert_item(&mut turn.value, item);
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

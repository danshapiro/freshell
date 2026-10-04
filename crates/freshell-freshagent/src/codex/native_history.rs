use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    io::Read,
    path::Path,
};

pub(crate) fn read(home: &Path, id: &str) -> Result<Value, String> {
    let path = super::locate_thread_rollout(&home.join(".codex/sessions"), id)
        .ok_or("saved native session not found")?;
    read_rollout(&path, id)
}

pub(super) fn read_rollout(path: &Path, id: &str) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let extent = file.metadata().map_err(|e| e.to_string())?.len();
    let source = crate::native_history::Records::new(std::io::BufReader::new(file.take(extent)));
    let mut omitted_turns = 0;
    let mut omitted_items = 0;
    let mut omitted_rows = 0;
    let mut retired = RetiredTurns::default();
    let mut turns = Vec::new();
    let mut turn = NativeTurn::new(0);
    for (line, row) in source.enumerate() {
        retain_native_turns(
            &mut turns,
            &mut turn,
            &mut omitted_turns,
            &mut omitted_items,
            &mut omitted_rows,
            &mut retired,
        );
        let Some((row, omitted)) = row.map_err(|e| e.to_string())? else {
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
                    omitted_items += omitted;
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
                    omitted_items += omitted;
                    item["id"] = payload
                        .get("call_id")
                        .filter(|id| id.is_string())
                        .or_else(|| payload.get("id").filter(|id| id.is_string()))
                        .cloned()
                        .unwrap_or_else(|| json!(format!("native-line-{line}")));
                    if item["type"] == "userMessage"
                        && turn.starts_new_input(&item, MessageSource::Response)
                    {
                        advance_turn(&mut turns, &mut turn);
                    }
                    upsert_transcript_item(&mut turn, item, MessageSource::Response);
                }
            }
            Some("event_msg") => {
                if payload["type"] != "task_started"
                    && payload["turn_id"]
                        .as_str()
                        .is_some_and(|id| !turn.has_id(id) && retired.ids.contains(id))
                {
                    // A delayed mirror/completion of an omitted task must not
                    // hijack the current native task or become its latest answer.
                    continue;
                }
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
                    } else if item.as_ref().is_some_and(|item| {
                        item["type"] == "userMessage"
                            && turn.starts_new_input(item, MessageSource::Event)
                    }) {
                        advance_turn(&mut turns, &mut turn);
                    }
                    &mut turn
                };
                if let Some(item) = item {
                    omitted_items += omitted;
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
                target.bytes = 0;
                target.finished |= finished;
            }
            _ => {}
        }
    }
    retain_native_turns(
        &mut turns,
        &mut turn,
        &mut omitted_turns,
        &mut omitted_items,
        &mut omitted_rows,
        &mut retired,
    );
    if turn.has_items() {
        turns.push(turn);
    }
    let mut ordinal = omitted_rows;
    let offsets: Vec<_> = turns
        .iter()
        .map(|turn| {
            let rows = super::build_codex_turn_json(&turn.value, 0)
                .expect("native turn projects")
                .len();
            let offset = (
                turn.value["id"].as_str().unwrap().to_owned(),
                ordinal,
                turn.skipped_rows,
            );
            ordinal += rows + turn.skipped_rows;
            offset
        })
        .collect();
    let turns: Vec<_> = turns.into_iter().map(|turn| turn.value).collect();
    let mut snapshot = super::build_codex_snapshot_json(
        id,
        &json!({"thread":{"id":id,"status":"idle","turns":turns}}),
        false,
        None,
        None,
        false,
    )?;
    for turn in snapshot["turns"].as_array_mut().unwrap() {
        let id = turn["turnId"].as_str().unwrap();
        if let Some((native, ordinal, skipped)) = offsets.iter().find(|(native, _, _)| {
            id == native
                || id
                    .strip_prefix(native)
                    .is_some_and(|suffix| suffix.starts_with(":row-"))
        }) {
            let row = id
                .strip_prefix(native)
                .and_then(|suffix| suffix.strip_prefix(":row-"))
                .and_then(|row| row.parse::<usize>().ok())
                .unwrap_or(0);
            turn["ordinal"] = json!(ordinal + skipped + row);
            if *skipped > 0 {
                turn["id"] = json!(format!("{native}:row-{}", skipped + row));
                turn["turnId"] = turn["id"].clone();
            }
        }
    }
    crate::native_history::finish_retention("codex", &mut snapshot, omitted_turns, omitted_items)?;
    Ok(snapshot)
}

fn retain_native_turns(
    turns: &mut Vec<NativeTurn>,
    current: &mut NativeTurn,
    omitted_turns: &mut usize,
    omitted_items: &mut usize,
    omitted_rows: &mut usize,
    retired: &mut RetiredTurns,
) {
    let items = current.value["items"].as_array_mut().unwrap();
    let mut bytes: usize = items
        .iter()
        .map(|item| serde_json::to_vec(item).unwrap().len())
        .sum();
    if bytes > crate::native_history::RETAINED_TURN_BYTES {
        for item in items.iter_mut() {
            crate::native_history::omit_large_bodies(item);
        }
        bytes = items
            .iter()
            .map(|item| serde_json::to_vec(item).unwrap().len())
            .sum();
    }
    while bytes > crate::native_history::RETAINED_TURN_BYTES && items.len() > 1 {
        let role = super::classify_codex_item_role(items[0]["type"].as_str().unwrap_or(""));
        let next_role = super::classify_codex_item_role(items[1]["type"].as_str().unwrap_or(""));
        current.skipped_rows += usize::from(role != next_role);
        bytes -= serde_json::to_vec(&items.remove(0)).unwrap().len();
        *omitted_items += 1;
    }
    let mut bytes: usize = turns
        .iter_mut()
        .map(|turn| {
            if turn.bytes == 0 {
                turn.bytes = serde_json::to_vec(&turn.value).unwrap().len();
            }
            turn.bytes
        })
        .sum();
    while bytes > crate::native_history::RETAINED_TURN_BYTES && !turns.is_empty() {
        let removed = turns.remove(0);
        if removed.named {
            retired.insert(removed.value["id"].as_str().unwrap());
        }
        bytes -= removed.bytes;
        *omitted_rows += super::build_codex_turn_json(&removed.value, 0)
            .expect("retained native turn projects")
            .len()
            + removed.skipped_rows;
        *omitted_turns += 1;
    }
}

/// Keep exact recent task identities after their bodies leave the display
/// window. The identity window is bounded by the same retained byte budget.
#[derive(Default)]
struct RetiredTurns {
    ids: HashSet<String>,
    order: VecDeque<String>,
    bytes: usize,
}
impl RetiredTurns {
    fn insert(&mut self, id: &str) {
        if !self.ids.insert(id.to_owned()) {
            return;
        }
        self.bytes += id.len();
        self.order.push_back(id.to_owned());
        while self.bytes > crate::native_history::RETAINED_TURN_BYTES {
            let id = self.order.pop_front().unwrap();
            self.bytes -= id.len();
            self.ids.remove(&id);
        }
    }
}

struct NativeTurn {
    index: usize,
    skipped_rows: usize,
    bytes: usize,
    value: Value,
    mirror: Option<MessageMirror>,
    named: bool,
    started: bool,
    finished: bool,
}

impl NativeTurn {
    fn new(index: usize) -> Self {
        Self {
            index,
            skipped_rows: 0,
            bytes: 0,
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

    fn starts_new_input(&self, item: &Value, source: MessageSource) -> bool {
        if self.finished {
            return true;
        }
        let items = self.value["items"].as_array().unwrap();
        if items.is_empty() {
            return false;
        }
        // Only the still-pending input prefix can contain a mirrored user record.
        // A new input after provider output starts a task even if an exit omitted
        // its completion; its later task/context records bind the pending identity.
        !(items.iter().all(|item| item["type"] == "userMessage")
            && self
                .mirror
                .as_ref()
                .is_some_and(|previous| previous.matches(item, source)))
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
        advance_turn(turns, turn);
    }
    if let Some(id) = id {
        turn.value["id"] = json!(id);
        turn.named = true;
    }
    turn.started |= starts_task;
}

fn advance_turn(turns: &mut Vec<NativeTurn>, turn: &mut NativeTurn) {
    let has_items = turn.has_items();
    let previous = std::mem::replace(turn, NativeTurn::new(turn.index + usize::from(has_items)));
    if has_items {
        turns.push(previous);
    }
}

struct MessageMirror {
    item: Value,
    sources: Vec<MessageSource>,
}

impl MessageMirror {
    fn matches(&self, item: &Value, source: MessageSource) -> bool {
        !self.sources.contains(&source)
            && self.item["type"] == item["type"]
            && message_text(&self.item) == message_text(item)
    }
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
    if message_text(&item).is_none() {
        upsert_item(&mut turn.value, item);
        return;
    }
    if let Some(previous) = turn.mirror.as_mut() {
        if previous.matches(&item, source) {
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

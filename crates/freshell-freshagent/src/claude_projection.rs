//! Layer 2 of the claude transcript projection (transcript-live plan §4.3).
//!
//! [`crate::claude_snapshot::parse_transcript_turn_indexed`] projects one JSONL
//! line at a time. Some durable content spans lines, and this projector folds
//! it, using only item kinds the client already renders:
//! - a subagent delegation (`Agent` on the wire, `Task` in older CLIs) becomes
//!   one `task_delegation` item that absorbs its tool result (so the client
//!   never shows an orphan "Result" row) and, for a background agent, the
//!   later `<task-notification>` line (CLI 2.1.237 F6);
//! - a line the CLI re-appends under an already-projected uuid (the preserved
//!   tail after a compaction) projects once;
//! - a compaction recap (`isCompactSummary`) with no preceding
//!   `system/compact_boundary` line still gets a `context_compaction` marker.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use crate::claude_snapshot::{
    compaction_marker_turn, is_task_notification_line, parse_transcript_turn, summarize,
};
use crate::delegation::task_delegation_title;

/// The subagent tool's names: `Agent` on the wire and in the JSONL, `Task` in
/// `system/init.tools` and in older CLIs (F5).
const DELEGATION_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

/// The claude CLI's default subagent type when the model names none.
const DEFAULT_SUBAGENT: &str = "general-purpose";

/// The projection of a whole transcript.
pub(crate) struct ClaudeProjection {
    pub turns: Vec<Value>,
}

/// Where a projected item lives: `turns[turn].items[item]`. Turns are only
/// ever appended, so a location stays valid for the projector's lifetime.
#[derive(Clone, Copy)]
struct ItemLocation {
    turn: usize,
    item: usize,
}

/// Stateful, line-at-a-time transcript projector. `Clone` so an incremental
/// reader can snapshot a projector at a file offset.
#[derive(Clone)]
pub(crate) struct ClaudeTranscriptProjector {
    thread_id: String,
    turns: Vec<Value>,
    /// Delegation items by the tool_use id that started them.
    delegations: HashMap<String, ItemLocation>,
    /// Every uuid that already produced (or was folded into) a turn.
    projected_uuids: HashSet<String>,
    /// `system/compact_boundary` uuids, to tell whether a compaction recap
    /// already has its marker.
    compact_boundaries: HashSet<String>,
}

impl ClaudeTranscriptProjector {
    pub(crate) fn new(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            turns: Vec::new(),
            delegations: HashMap::new(),
            projected_uuids: HashSet::new(),
            compact_boundaries: HashSet::new(),
        }
    }

    /// Project every line of `transcript`.
    pub(crate) fn project(thread_id: &str, transcript: &str) -> ClaudeProjection {
        let mut projector = Self::new(thread_id);
        for line in transcript.lines() {
            projector.push_line(line);
        }
        projector.finish()
    }

    /// Project one raw JSONL line; malformed and blank lines are skipped.
    pub(crate) fn push_line(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            return;
        };
        self.push_value(&obj);
    }

    /// Project one parsed transcript line.
    pub(crate) fn push_value(&mut self, obj: &Value) {
        let uuid = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|uuid| !uuid.is_empty());
        if let Some(uuid) = uuid {
            if self.projected_uuids.contains(uuid) {
                return;
            }
        }
        if obj.get("type").and_then(Value::as_str) == Some("system")
            && obj.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
        {
            if let Some(uuid) = uuid {
                self.compact_boundaries.insert(uuid.to_string());
            }
        }
        if is_task_notification_line(obj) {
            self.fold_task_notification(obj);
            self.remember(uuid);
            return;
        }
        if let Some(turn) = self.orphan_compaction_marker(obj, uuid) {
            self.turns.push(turn);
            self.remember(uuid);
            return;
        }
        let Some(mut turn) = parse_transcript_turn(obj, &self.thread_id, self.turns.len()) else {
            return;
        };
        let turn_index = self.turns.len();
        let changed = match turn.get("role").and_then(Value::as_str) {
            Some("assistant") => self.open_delegations(&mut turn, turn_index),
            Some("user") => self.absorb_delegation_results(&mut turn, obj),
            _ => false,
        };
        self.remember(uuid);
        if turn["items"].as_array().is_some_and(Vec::is_empty) && turn.get("error").is_none() {
            return;
        }
        if changed {
            refresh_summary(&mut turn);
        }
        self.turns.push(turn);
    }

    pub(crate) fn finish(self) -> ClaudeProjection {
        ClaudeProjection { turns: self.turns }
    }

    fn remember(&mut self, uuid: Option<&str>) {
        if let Some(uuid) = uuid {
            self.projected_uuids.insert(uuid.to_string());
        }
    }

    /// A compaction recap whose parent is not a boundary line we projected:
    /// mark the compaction at the recap's position.
    fn orphan_compaction_marker(&self, obj: &Value, uuid: Option<&str>) -> Option<Value> {
        if obj.get("isCompactSummary").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let parent = obj.get("parentUuid").and_then(Value::as_str);
        if parent.is_some_and(|parent| self.compact_boundaries.contains(parent)) {
            return None;
        }
        let ordinal = self.turns.len();
        let turn_id = uuid
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}:{ordinal}", self.thread_id));
        Some(compaction_marker_turn(&turn_id, ordinal, obj))
    }

    /// Replace `Agent`/`Task` tool calls with `task_delegation` items.
    fn open_delegations(&mut self, turn: &mut Value, turn_index: usize) -> bool {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            return false;
        };
        let mut changed = false;
        for (item_index, item) in items.iter_mut().enumerate() {
            if item.get("kind").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or("");
            if !DELEGATION_TOOL_NAMES.contains(&name) {
                continue;
            }
            let Some(tool_use_id) = item.get("toolUseId").and_then(Value::as_str) else {
                continue;
            };
            let tool_use_id = tool_use_id.to_string();
            *item = delegation_item(item);
            self.delegations.insert(
                tool_use_id,
                ItemLocation {
                    turn: turn_index,
                    item: item_index,
                },
            );
            changed = true;
        }
        changed
    }

    /// Fold each delegation's tool result into its item and drop the result
    /// item. `line` carries the CLI's structured `toolUseResult`.
    fn absorb_delegation_results(&mut self, turn: &mut Value, line: &Value) -> bool {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            return false;
        };
        let results = items
            .iter()
            .filter(|item| item.get("kind").and_then(Value::as_str) == Some("tool_result"))
            .count();
        // `toolUseResult` describes the line's tool result when there is one.
        let structured = (results == 1)
            .then(|| line.get("toolUseResult"))
            .flatten()
            .filter(|value| value.is_object());
        let before = items.len();
        let mut absorbed: Vec<(ItemLocation, Value)> = Vec::new();
        items.retain(|item| {
            if item.get("kind").and_then(Value::as_str) != Some("tool_result") {
                return true;
            }
            let Some(location) = item
                .get("toolUseId")
                .and_then(Value::as_str)
                .and_then(|id| self.delegations.get(id))
            else {
                return true;
            };
            absorbed.push((*location, item.clone()));
            false
        });
        let changed = items.len() != before;
        for (location, result) in absorbed {
            if let Some(delegation) = self.item_mut(location) {
                apply_delegation_result(delegation, &result, structured);
            }
            self.refresh_turn_summary(location.turn);
        }
        changed
    }

    /// `<task-notification>` (background agent finished): settle the delegation.
    fn fold_task_notification(&mut self, line: &Value) {
        let text = notification_text(line);
        let Some(tool_use_id) = xml_tag(&text, "tool-use-id") else {
            return;
        };
        let Some(location) = self.delegations.get(tool_use_id).copied() else {
            return;
        };
        let Some(delegation) = self.item_mut(location) else {
            return;
        };
        let status = match xml_tag(&text, "status") {
            Some("completed") | None => "completed",
            Some(_) => "failed",
        };
        delegation["status"] = json!(status);
        if let Some(result) = xml_tag(&text, "result").filter(|r| !r.is_empty()) {
            delegation["result"] = json!(result);
        }
        if let Some(ms) = xml_tag(&text, "duration_ms").and_then(|ms| ms.parse::<u64>().ok()) {
            delegation["durationMs"] = json!(ms);
        }
        self.refresh_turn_summary(location.turn);
    }

    fn item_mut(&mut self, location: ItemLocation) -> Option<&mut Value> {
        self.turns
            .get_mut(location.turn)?
            .get_mut("items")?
            .as_array_mut()?
            .get_mut(location.item)
    }

    fn refresh_turn_summary(&mut self, turn_index: usize) {
        if let Some(turn) = self.turns.get_mut(turn_index) {
            refresh_summary(turn);
        }
    }
}

fn refresh_summary(turn: &mut Value) {
    let summary = turn
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .map(|items| summarize(items))
        .unwrap_or_default();
    turn["summary"] = json!(summary);
}

/// A running `task_delegation` item for an `Agent`/`Task` tool_use item. The
/// background flag starts from the model's explicit `run_in_background`; the
/// tool result reveals the CLI's actual choice (async is its default, F6).
fn delegation_item(tool_use: &Value) -> Value {
    let input = tool_use.get("input").cloned().unwrap_or_else(|| json!({}));
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let subagent = input
        .get("subagent_type")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SUBAGENT)
        .to_string();
    let background = input.get("run_in_background").and_then(Value::as_bool) == Some(true);
    let mut item = json!({
        "id": tool_use.get("id").cloned().unwrap_or(Value::Null),
        "kind": "task_delegation",
        "status": "running",
        "title": task_delegation_title(&subagent, background, &description),
    });
    if !description.is_empty() {
        item["description"] = json!(description);
    }
    item["subagent"] = json!(subagent);
    item["background"] = json!(background);
    item
}

/// Settle a delegation from its tool result.
fn apply_delegation_result(delegation: &mut Value, result: &Value, structured: Option<&Value>) {
    let content = result.get("content").and_then(Value::as_str).unwrap_or("");
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        delegation["status"] = json!("failed");
        if !content.is_empty() {
            delegation["result"] = json!(content);
        }
        return;
    }
    let status = structured
        .and_then(|s| s.get("status"))
        .and_then(Value::as_str);
    let launched_async = status == Some("async_launched")
        || structured
            .and_then(|s| s.get("isAsync"))
            .and_then(Value::as_bool)
            == Some(true);
    if launched_async {
        set_background(delegation);
        delegation["status"] = json!("running");
        return;
    }
    let failed = matches!(status, Some("failed" | "error" | "killed" | "stopped"));
    delegation["status"] = json!(if failed { "failed" } else { "completed" });
    let text = structured
        .and_then(|s| s.get("content"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| content.to_string());
    if !text.is_empty() {
        delegation["result"] = json!(text);
    }
    if let Some(ms) = structured
        .and_then(|s| s.get("totalDurationMs"))
        .and_then(Value::as_u64)
    {
        delegation["durationMs"] = json!(ms);
    }
}

/// Mark a delegation as a background run (title gains "(background)").
fn set_background(delegation: &mut Value) {
    if delegation.get("background").and_then(Value::as_bool) == Some(true) {
        return;
    }
    delegation["background"] = json!(true);
    let subagent = delegation["subagent"]
        .as_str()
        .unwrap_or(DEFAULT_SUBAGENT)
        .to_string();
    let description = delegation["description"].as_str().unwrap_or("").to_string();
    delegation["title"] = json!(task_delegation_title(&subagent, true, &description));
}

/// The notification XML (string content or joined text blocks).
fn notification_text(line: &Value) -> String {
    match line.pointer("/message/content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The trimmed text of the first `<tag>…</tag>` (the closing tag is matched
/// last-first so a result that itself mentions the tag stays whole).
fn xml_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text.rfind(&close)?;
    (end >= start).then(|| text[start..end].trim())
}

#[cfg(test)]
#[path = "claude_projection_tests.rs"]
mod tests;

//! Layer 2 of the claude transcript projection (transcript-live plan §4.3).
//!
//! [`crate::claude_snapshot::parse_transcript_turn_indexed`] projects one JSONL
//! line at a time. Some durable content spans lines, and this projector folds
//! it, using only item kinds the client already renders:
//! - a subagent delegation (`Agent` on the wire, `Task` in older CLIs) becomes
//!   one `task_delegation` item that absorbs its tool result (so the client
//!   never shows an orphan "Result" row) and, for a background agent, the
//!   later `<task-notification>` line (CLI 2.1.237 F6), matched by its
//!   `<tool-use-id>` or else by its `<task-id>` (the subagent's `agentId`);
//! - a line the CLI re-appends under an already-projected uuid (during a
//!   compaction it writes the last message again, just before the
//!   `system/compact_boundary` line) projects once;
//! - a compaction recap (`isCompactSummary`) with no preceding
//!   `system/compact_boundary` line still gets a `context_compaction` marker;
//! - the diff panel's changed files, from the main thread's edit tools and
//!   each delegation's subagent transcript.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use freshell_sessions::{ClaudeUsageAccumulator, ParseSessionOptions};
use serde_json::{json, Value};

use crate::claude_snapshot::{
    compaction_marker_turn, is_task_notification_line, parse_transcript_turn, summarize,
};
use crate::delegation::{
    delegation_activity_preview, task_delegation_title, DELEGATION_ACTIVITY_ROW_CAP,
};

/// The subagent tool's names: `Agent` on the wire and in the JSONL, `Task` in
/// `system/init.tools` and in older CLIs (F5).
const DELEGATION_TOOL_NAMES: [&str; 2] = ["Agent", "Task"];

/// Tools whose successful result changes a file (the diff panel's rows).
const FILE_EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// How many recent uuid-bearing lines the snapshot lists. The live tail
/// (transcript-live plan §4.4) checks an announced message uuid against the
/// turn ids PLUS these, because absorbed and hidden lines produce no turn.
pub(crate) const TRANSCRIPT_LINE_UUID_WINDOW: usize = 64;

/// The claude CLI's default subagent type when the model names none.
const DEFAULT_SUBAGENT: &str = "general-purpose";

/// Where the projector finds a delegation's subagent transcript.
pub(crate) trait SubagentSource {
    /// The JSONL of the subagent the `tool_use_id` delegation started.
    fn transcript_for(&self, tool_use_id: &str) -> Option<String>;

    /// What that transcript contributes to the projection.
    fn summary_for(&self, tool_use_id: &str) -> Option<SubagentSummary> {
        self.transcript_for(tool_use_id)
            .map(|transcript| SubagentSummary::from_transcript(&transcript))
    }
}

/// What one subagent transcript contributes to the projection.
#[derive(Clone, Default)]
pub(crate) struct SubagentSummary {
    /// `{tool, status, preview}` for each tool call, in order: completed or
    /// failed once its result line exists, running before (the delegation's
    /// `↳ Tool preview` rows), capped at [`DELEGATION_ACTIVITY_ROW_CAP`].
    activity: Vec<Value>,
    /// Files the subagent's own edit-tool calls changed.
    changed_files: BTreeMap<String, ChangedFile>,
}

impl SubagentSummary {
    pub(crate) fn from_transcript(transcript: &str) -> Self {
        let mut activity: Vec<Value> = Vec::new();
        let mut row_by_tool_use: HashMap<String, usize> = HashMap::new();
        let mut changed_files = ChangedFiles::default();
        for line in transcript.lines() {
            let Ok(obj) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            changed_files.observe(&obj);
            for block in message_blocks(&obj) {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        if activity.len() >= DELEGATION_ACTIVITY_ROW_CAP {
                            continue;
                        }
                        let tool = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                        if let Some(id) = block.get("id").and_then(Value::as_str) {
                            row_by_tool_use.insert(id.to_string(), activity.len());
                        }
                        activity.push(json!({
                            "tool": tool,
                            "status": "running",
                            "preview": delegation_activity_preview(tool, &input),
                        }));
                    }
                    Some("tool_result") => {
                        let Some(index) = block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .and_then(|id| row_by_tool_use.get(id))
                        else {
                            continue;
                        };
                        let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                        activity[*index]["status"] =
                            json!(if failed { "failed" } else { "completed" });
                    }
                    _ => {}
                }
            }
        }
        Self {
            activity,
            changed_files: changed_files.files,
        }
    }
}

/// No subagent transcripts (pure projections: rollback slices, goldens).
pub(crate) struct NoSubagents;

impl SubagentSource for NoSubagents {
    fn transcript_for(&self, _tool_use_id: &str) -> Option<String> {
        None
    }
}

/// The CLI's on-disk subagent layout (F5):
/// `<transcript without .jsonl>/subagents/agent-<id>.jsonl`, plus
/// `agent-<id>.meta.json {toolUseId, …}` written at spawn — so a delegation
/// that is still running already maps to its transcript.
pub(crate) struct FsSubagents {
    by_tool_use: HashMap<String, PathBuf>,
}

impl FsSubagents {
    pub(crate) fn for_transcript(transcript: &Path) -> Self {
        let dir = transcript.with_extension("").join("subagents");
        let mut by_tool_use = HashMap::new();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Self { by_tool_use };
        };
        for path in entries.flatten().map(|entry| entry.path()) {
            let Some(stem) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".meta.json"))
            else {
                continue;
            };
            let tool_use_id = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|meta| meta.get("toolUseId")?.as_str().map(str::to_string));
            match tool_use_id {
                Some(id) => {
                    by_tool_use.insert(id, dir.join(format!("{stem}.jsonl")));
                }
                None => tracing::debug!(
                    target: "freshell_freshagent::claude",
                    event = "claude_subagent_meta_unreadable",
                    path = %path.display(),
                    "claude subagent meta.json has no toolUseId; its activity and file changes are not shown"
                ),
            }
        }
        Self { by_tool_use }
    }
}

impl SubagentSource for FsSubagents {
    fn transcript_for(&self, tool_use_id: &str) -> Option<String> {
        std::fs::read_to_string(self.by_tool_use.get(tool_use_id)?).ok()
    }
}

/// The projection of a whole transcript.
pub(crate) struct ClaudeProjection {
    pub turns: Vec<Value>,
    pub diffs: Vec<Value>,
    pub token_usage: Value,
    pub transcript_line_uuids: Vec<String>,
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
    /// Delegation items by the subagent's `agentId` (from its tool result).
    /// A completion notice's `<task-id>` names it: CLIs after 2.1.237 often
    /// omit `<tool-use-id>`, or name the SendMessage call that resumed the
    /// agent instead of the Agent call that started it.
    delegations_by_agent: HashMap<String, ItemLocation>,
    /// Every uuid that already produced (or was folded into) a turn.
    projected_uuids: HashSet<String>,
    /// `system/compact_boundary` uuids, to tell whether a compaction recap
    /// already has its marker.
    compact_boundaries: HashSet<String>,
    /// Files the main thread's edit tools changed (the diff panel's rows;
    /// each delegation's subagent edits join them at finish).
    changed_files: ChangedFiles,
    /// The session indexer's own token-usage definition (one context meter).
    usage: ClaudeUsageAccumulator,
    /// The newest uuid-bearing lines in file order, whether or not they
    /// produced a turn.
    recent_line_uuids: VecDeque<String>,
}

/// What the session did to one file.
#[derive(Clone, Default)]
struct ChangedFile {
    created: bool,
    added: usize,
    removed: usize,
    /// Whether any result carried a line-level patch.
    patched: bool,
}

/// The files one transcript's edit-tool calls changed, fed every line in
/// order: a `tool_use` names the file, its result line says whether (and
/// how) it changed.
#[derive(Clone, Default)]
struct ChangedFiles {
    /// File-editing tool calls seen so far: tool_use id -> the path their
    /// input names (the result line names only the tool_use id).
    edit_calls: HashMap<String, Option<String>>,
    /// Files changed by successful edit tools, by path (one row per path).
    files: BTreeMap<String, ChangedFile>,
}

impl ChangedFiles {
    fn observe(&mut self, obj: &Value) {
        self.record_edit_calls(obj);
        self.record_results(obj);
    }

    /// Remember each file-editing tool call and the path its input names.
    fn record_edit_calls(&mut self, obj: &Value) {
        if obj.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        for block in message_blocks(obj) {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let (Some(id), Some(name)) = (
                block.get("id").and_then(Value::as_str),
                block.get("name").and_then(Value::as_str),
            ) else {
                continue;
            };
            if !FILE_EDIT_TOOLS.contains(&name) {
                continue;
            }
            let path = block.get("input").and_then(edited_path).map(str::to_string);
            self.edit_calls.insert(id.to_string(), path);
        }
    }

    /// A successful Edit/Write/MultiEdit/NotebookEdit result changes its file;
    /// the CLI's structured `toolUseResult` carries the patch (F4).
    fn record_results(&mut self, obj: &Value) {
        if obj.get("type").and_then(Value::as_str) != Some("user") {
            return;
        }
        let results: Vec<&Value> = message_blocks(obj)
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
            .collect();
        // One structured result per line; a multi-result line is ambiguous.
        let [result] = results.as_slice() else {
            return;
        };
        if result.get("is_error").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let Some(structured) = obj.get("toolUseResult").filter(|value| value.is_object()) else {
            return;
        };
        let Some(input_path) = result
            .get("tool_use_id")
            .and_then(Value::as_str)
            .and_then(|id| self.edit_calls.get(id))
        else {
            return;
        };
        let Some(path) = edited_path(structured).or(input_path.as_deref()) else {
            return;
        };
        let file = self.files.entry(path.to_string()).or_default();
        if structured.get("type").and_then(Value::as_str) == Some("create") {
            file.created = true;
        }
        if let Some(hunks) = structured.get("structuredPatch").and_then(Value::as_array) {
            for line in hunks
                .iter()
                .filter_map(|hunk| hunk.get("lines").and_then(Value::as_array))
                .flatten()
                .filter_map(Value::as_str)
            {
                if line.starts_with('+') {
                    file.added += 1;
                    file.patched = true;
                } else if line.starts_with('-') {
                    file.removed += 1;
                    file.patched = true;
                }
            }
        }
    }

    /// Add another thread's changes (a subagent's) to these.
    fn absorb(&mut self, files: &BTreeMap<String, ChangedFile>) {
        for (path, file) in files {
            self.files.entry(path.clone()).or_default().absorb(file);
        }
    }

    /// The diff panel's rows, one per path.
    fn rows(&self) -> Vec<Value> {
        self.files
            .iter()
            .map(|(path, file)| json!({ "id": path, "path": path, "status": file.status() }))
            .collect()
    }
}

impl ChangedFile {
    fn absorb(&mut self, other: &ChangedFile) {
        self.created |= other.created;
        self.added += other.added;
        self.removed += other.removed;
        self.patched |= other.patched;
    }

    /// `created` for a file this session created; else `+A −D` summed over
    /// every successful edit's patch lines.
    fn status(&self) -> String {
        if self.created {
            "created".to_string()
        } else if self.patched {
            format!("+{} \u{2212}{}", self.added, self.removed)
        } else {
            "modified".to_string()
        }
    }
}

impl ClaudeTranscriptProjector {
    pub(crate) fn new(thread_id: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            turns: Vec::new(),
            delegations: HashMap::new(),
            delegations_by_agent: HashMap::new(),
            projected_uuids: HashSet::new(),
            compact_boundaries: HashSet::new(),
            changed_files: ChangedFiles::default(),
            usage: ClaudeUsageAccumulator::new(),
            recent_line_uuids: VecDeque::with_capacity(TRANSCRIPT_LINE_UUID_WINDOW),
        }
    }

    /// Project every line of `transcript` (no subagent activity).
    pub(crate) fn project(thread_id: &str, transcript: &str) -> ClaudeProjection {
        Self::project_with(thread_id, transcript, &NoSubagents)
    }

    /// Project every line of `transcript`, attaching subagent activity.
    pub(crate) fn project_with(
        thread_id: &str,
        transcript: &str,
        subagents: &dyn SubagentSource,
    ) -> ClaudeProjection {
        let mut projector = Self::new(thread_id);
        for line in transcript.lines() {
            projector.push_line(line);
        }
        projector.finish_with(subagents)
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
        // Every line, before any display filtering: the indexer's definition
        // sees (and dedupes) them all.
        self.usage.push(&obj, line);
        self.note_line_uuid(&obj);
        self.push_value(&obj);
    }

    /// Project one parsed transcript line (display content only; token usage
    /// is fed by [`Self::push_line`]).
    fn push_value(&mut self, obj: &Value) {
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
        self.changed_files.observe(obj);
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

    /// The projection, with each delegation's subagent tool calls attached as
    /// `activity` rows (`↳ Tool preview` in the client) and the files its
    /// subagent changed joining the session's changed files. Only the
    /// delegations this transcript started count (a nested subagent's own
    /// delegations are not followed).
    pub(crate) fn finish_with(mut self, subagents: &dyn SubagentSource) -> ClaudeProjection {
        let delegations: Vec<(String, ItemLocation)> = self
            .delegations
            .iter()
            .map(|(id, location)| (id.clone(), *location))
            .collect();
        for (tool_use_id, location) in delegations {
            let Some(summary) = subagents.summary_for(&tool_use_id) else {
                continue;
            };
            self.changed_files.absorb(&summary.changed_files);
            if summary.activity.is_empty() {
                continue;
            }
            if let Some(item) = self.item_mut(location) {
                item["activity"] = Value::Array(summary.activity);
            }
        }
        ClaudeProjection {
            turns: self.turns,
            diffs: self.changed_files.rows(),
            token_usage: token_usage_json(&self.usage),
            transcript_line_uuids: self.recent_line_uuids.into(),
        }
    }

    fn note_line_uuid(&mut self, obj: &Value) {
        let Some(uuid) = obj
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|uuid| !uuid.is_empty())
        else {
            return;
        };
        if self.recent_line_uuids.iter().any(|seen| seen == uuid) {
            return;
        }
        if self.recent_line_uuids.len() == TRANSCRIPT_LINE_UUID_WINDOW {
            self.recent_line_uuids.pop_front();
        }
        self.recent_line_uuids.push_back(uuid.to_string());
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
        let agent_id = structured
            .and_then(|s| s.get("agentId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        for (location, result) in absorbed {
            if let Some(delegation) = self.item_mut(location) {
                apply_delegation_result(delegation, &result, structured);
            }
            if let Some(agent_id) = agent_id {
                self.delegations_by_agent
                    .insert(agent_id.to_string(), location);
            }
            self.refresh_turn_summary(location.turn);
        }
        changed
    }

    /// `<task-notification>` (background agent finished): settle the delegation.
    fn fold_task_notification(&mut self, line: &Value) {
        let text = notification_text(line);
        let notice = TaskNotification::parse(&text);
        let location = notice
            .tool_use_id()
            .and_then(|id| self.delegations.get(id))
            .or_else(|| {
                notice
                    .task_id()
                    .and_then(|id| self.delegations_by_agent.get(id))
            })
            .copied();
        let Some(location) = location else {
            return;
        };
        let Some(delegation) = self.item_mut(location) else {
            return;
        };
        let status = match notice.status() {
            Some("completed") | None => "completed",
            Some(_) => "failed",
        };
        delegation["status"] = json!(status);
        if let Some(result) = notice.result.filter(|r| !r.is_empty()) {
            delegation["result"] = json!(result);
        }
        if let Some(ms) = notice.duration_ms() {
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

/// The snapshot's `tokenUsage`: the indexer's summary in the contract's
/// shape (no `costUsd`: the transcript does not persist it), zeros before
/// the first assistant usage.
fn token_usage_json(usage: &ClaudeUsageAccumulator) -> Value {
    match usage.summary(&ParseSessionOptions::default()) {
        Some(summary) => {
            let mut value = json!({
                "inputTokens": summary.input_tokens.max(0),
                "outputTokens": summary.output_tokens.max(0),
                "cachedTokens": summary.cached_tokens.max(0),
                "totalTokens": summary.total_tokens.max(0),
            });
            if let Some(context) = summary.context_tokens {
                value["contextTokens"] = json!(context.max(0));
            }
            if let Some(percent) = summary.compact_percent {
                value["compactPercent"] = json!(percent.max(0));
            }
            value
        }
        None => json!({ "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 }),
    }
}

/// The file an edit tool's input or structured result names.
fn edited_path(value: &Value) -> Option<&str> {
    ["filePath", "file_path", "notebook_path"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|path| !path.is_empty())
}

/// A line's message content blocks (empty for string content).
fn message_blocks(obj: &Value) -> &[Value] {
    obj.pointer("/message/content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
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

/// A `<task-notification>`, split into its three regions: the header tags
/// (`task-id`, `tool-use-id`, `status`, …), the agent's free-text `<result>`,
/// and the `<usage>` trailer. The result may quote any tag (an agent reading
/// logs or XML), so header tags are read only before `<result>` and trailer
/// tags only after the last `</result>`.
struct TaskNotification<'a> {
    header: &'a str,
    result: Option<&'a str>,
    trailer: &'a str,
}

impl<'a> TaskNotification<'a> {
    fn parse(text: &'a str) -> Self {
        const OPEN: &str = "<result>";
        const CLOSE: &str = "</result>";
        if let (Some(open), Some(close)) = (text.find(OPEN), text.rfind(CLOSE)) {
            let start = open + OPEN.len();
            if close >= start {
                return Self {
                    header: &text[..open],
                    result: Some(text[start..close].trim()),
                    trailer: &text[close + CLOSE.len()..],
                };
            }
        }
        Self {
            header: text,
            result: None,
            trailer: text,
        }
    }

    fn tool_use_id(&self) -> Option<&'a str> {
        first_tag(self.header, "tool-use-id")
    }

    fn task_id(&self) -> Option<&'a str> {
        first_tag(self.header, "task-id")
    }

    fn status(&self) -> Option<&'a str> {
        first_tag(self.header, "status")
    }

    fn duration_ms(&self) -> Option<u64> {
        first_tag(self.trailer, "duration_ms")?.parse().ok()
    }
}

/// The trimmed text of the first `<tag>…</tag>` in `text`.
fn first_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&close)?;
    Some(text[start..end].trim())
}

#[cfg(test)]
#[path = "claude_projection_tests.rs"]
mod tests;

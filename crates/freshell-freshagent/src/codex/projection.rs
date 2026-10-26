//! The event-owned part of a Codex transcript. Reads and notifications have
//! independent clocks; reading a body never makes it a delta baseline.
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const MAX_FROZEN_BYTES: usize = 8 * 1024 * 1024;
const MAX_FROZEN_TURNS: usize = 32;
const MAX_SAVE_READS: u8 = 3;

#[derive(Debug)]
pub(super) struct ProjectionError {
    pub method: String,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub reason: &'static str,
}

#[derive(Debug)]
pub(super) struct SnapshotStale;

#[derive(Clone)]
struct EventTurn {
    raw: Value,
    row_by_item: HashMap<String, String>,
    completed_items: HashSet<String>,
    // Recovery reads can supply display context, never an append baseline.
    read_only_items: HashSet<String>,
    emitted: bool,
    terminal: bool,
    save_reads: u8,
    allow_missing_membership: bool,
}

impl EventTurn {
    fn nonappendable_ids(&self) -> Vec<String> {
        self.raw["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| {
                item["id"]
                    .as_str()
                    .is_some_and(|id| self.read_only_items.contains(id))
            })
            .flat_map(|item| {
                super::map_codex_item(
                    item["id"].as_str().unwrap_or(""),
                    item,
                    item["type"].as_str().unwrap_or(""),
                )
                .unwrap_or_default()
            })
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect()
    }

    fn refresh_read_only(&mut self, native: &Value) {
        for item in self.raw["items"].as_array_mut().into_iter().flatten() {
            if item["id"]
                .as_str()
                .is_some_and(|id| self.read_only_items.contains(id))
            {
                if let Some(saved) = native["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|saved| saved["id"] == item["id"] && saved["type"] == item["type"])
                {
                    *item = saved.clone();
                }
            }
        }
    }

    fn native_can_finish_unobserved_items(&self, native: &Value, legacy: bool) -> bool {
        let mut candidate = self.raw.clone();
        let mut saved = native.clone();
        let mut finalizable = HashSet::new();
        for item in self.raw["items"].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str() else {
                continue;
            };
            if self.completed_items.contains(id) || self.read_only_items.contains(id) {
                continue;
            }
            if native["items"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|saved| saved["id"] == id && saved["type"] == item["type"])
            {
                finalizable.insert(id.to_owned());
            }
        }
        for raw in [&mut candidate, &mut saved] {
            if let Some(items) = raw["items"].as_array_mut() {
                items.retain(|item| {
                    !item["id"]
                        .as_str()
                        .is_some_and(|id| finalizable.contains(id))
                });
            }
        }
        // Exact canonical identity permits finalizing a missed item boundary.
        // A PTY can finish after its turn and be saved at that later position.
        // Every completed role, ordered item and outcome must still agree;
        // an unfinished item absent from persistence is retained, not erased.
        !finalizable.is_empty() && equivalent_turns(&candidate, &saved, legacy)
    }
}

#[derive(Clone)]
pub(super) struct SnapshotReadFence {
    projection_id: String,
    owner_epoch: u64,
    owner_generation: u64,
    history_generation: u64,
    event_revision: u64,
    turns: Vec<EventTurn>,
    turn_order: Vec<String>,
}

pub(super) struct ProjectionSnapshot {
    pub raw: Value,
    pub metadata: Value,
}

pub(super) struct CodexProjection {
    pub id: String,
    thread_id: String,
    owner_epoch: u64,
    owner_generation: u64,
    pub history_generation: u64,
    revision: u64,
    active_turn: Option<String>,
    turns: Vec<EventTurn>,
    // Membership fences outlive payload retention. They are never the eight-turn
    // attention cache: old native identities cannot reopen a historical operation.
    known_turns: HashSet<String>,
    turn_order: Vec<String>,
    terminal_turns: HashSet<String>,
    removed_turns: HashSet<String>,
    unknown_methods: HashSet<String>,
    last_native: Option<Value>,
    pub usage: Option<Value>,
    pub plan: Option<Value>,
    pub diff: Option<Value>,
    pending_ops: Vec<Value>,
}

impl CodexProjection {
    pub(super) fn new(projection_id: String, thread_id: String) -> Self {
        Self {
            id: projection_id,
            thread_id,
            owner_epoch: 0,
            owner_generation: 0,
            history_generation: 0,
            revision: 0,
            active_turn: None,
            turns: vec![],
            known_turns: HashSet::new(),
            turn_order: vec![],
            removed_turns: HashSet::new(),
            terminal_turns: HashSet::new(),
            unknown_methods: HashSet::new(),
            last_native: None,
            usage: None,
            plan: None,
            diff: None,
            pending_ops: vec![],
        }
    }

    pub(super) fn bind_owner(&mut self, epoch: u64, generation: u64) {
        self.owner_epoch = epoch;
        self.owner_generation = generation;
    }

    pub(super) fn begin_history_read(&self) -> SnapshotReadFence {
        SnapshotReadFence {
            projection_id: self.id.clone(),
            owner_epoch: self.owner_epoch,
            owner_generation: self.owner_generation,
            history_generation: self.history_generation,
            event_revision: self.revision,
            turns: self.turns.clone(),
            turn_order: self.turn_order.clone(),
        }
    }

    pub(super) fn owns_thread(&self, id: &str) -> bool {
        self.thread_id == id
    }

    /// Exact native spawn membership, without starting or resuming a child writer.
    pub(super) fn knows_child_thread(&self, id: &str) -> bool {
        self.turns
            .iter()
            .map(|turn| &turn.raw)
            .chain(
                self.last_native
                    .iter()
                    .flat_map(|native| native["thread"]["turns"].as_array().into_iter().flatten()),
            )
            .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
            .any(|item| {
                item["type"] == "collabAgentToolCall"
                    && item["tool"] == "spawnAgent"
                    && item["senderThreadId"] == self.thread_id
                    && item["receiverThreadIds"]
                        .as_array()
                        .is_some_and(|children| {
                            children.iter().any(|child| child.as_str() == Some(id))
                        })
            })
    }

    pub(super) fn matches_fence(&self, fence: &SnapshotReadFence) -> bool {
        fence.projection_id == self.id
            && fence.owner_epoch == self.owner_epoch
            && fence.owner_generation == self.owner_generation
            && fence.history_generation == self.history_generation
    }

    pub(super) fn has_usable_history(&self) -> bool {
        self.last_native.is_some() || !self.turns.is_empty()
    }

    pub(super) fn patch(&self, ops: Vec<Value>) -> Value {
        json!({"type":"freshAgent.transcript.patch", "sessionId":self.thread_id,
            "projectionId":self.id, "historyGeneration":self.history_generation, "ops":ops})
    }

    pub(super) fn metadata_event(&self) -> Value {
        json!({"type":"freshAgent.session.metadata","sessionId":self.thread_id,"codex":{"projectionId":self.id,"historyGeneration":self.history_generation,"usage":self.usage,"plan":self.plan,"diff":self.diff}})
    }

    pub(super) fn enqueue(&mut self, ops: Vec<Value>) {
        for op in ops {
            if let Some(last) = self.pending_ops.last_mut() {
                if last["op"] == "appendItem"
                    && op["op"] == "appendItem"
                    && ["nativeTurnId", "rowId", "itemId", "field", "index"]
                        .iter()
                        .all(|key| last[key] == op[key])
                {
                    append_string(last, "text", op["text"].as_str().unwrap_or(""));
                    last["revision"] = op["revision"].clone();
                    continue;
                }
            }
            self.pending_ops.push(op);
        }
    }

    pub(super) fn take_patch(&mut self) -> Option<Value> {
        if self.pending_ops.is_empty() {
            None
        } else {
            let ops = std::mem::take(&mut self.pending_ops);
            Some(self.patch(ops))
        }
    }

    fn op(&mut self, mut value: Value) -> Value {
        // Revisions are consumed-notification clocks, never native-read watermarks.
        self.revision = self.revision.saturating_add(1).min(9_007_199_254_740_991);
        value["revision"] = json!(self.revision);
        value
    }

    fn open_turn(&mut self, id: &str) -> bool {
        if self.removed_turns.contains(id) || self.terminal_turns.contains(id) {
            return false;
        }
        if self.active_turn.as_deref() == Some(id) {
            return true;
        }
        if self.known_turns.contains(id) && !self.recoverable_native_turn(id) {
            return false;
        }
        // A new native turn is an operation boundary, including when the old
        // completion was lost. Its unfinished body becomes a finite retained view.
        self.freeze_active("interrupted");
        self.active_turn = Some(id.to_owned());
        if self.known_turns.insert(id.to_owned()) {
            self.turn_order.push(id.to_owned());
        }
        let preview = self.last_native.as_ref().and_then(|raw| {
            raw["thread"]["turns"]
                .as_array()?
                .iter()
                .find(|turn| turn["id"] == id && turn["status"] == "inProgress")
                .map(|turn| (turn, raw["thread"]["historyMode"] == "legacy"))
        });
        let items: Vec<Value> = preview
            .into_iter()
            .flat_map(|(turn, legacy)| {
                turn["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(move |item| {
                        // Legacy message ids are reconstructed, so only the immutable
                        // user prefix is safe to associate with new canonical items.
                        !legacy || item["type"] == "userMessage"
                    })
                    .cloned()
            })
            .collect();
        let read_only_items = items
            .iter()
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect();
        self.turns.push(EventTurn {
            raw: json!({"id":id,"status":"inProgress","items":items}),
            row_by_item: HashMap::new(),
            completed_items: HashSet::new(),
            read_only_items,
            emitted: false,
            terminal: false,
            save_reads: 0,
            allow_missing_membership: true,
        });
        true
    }

    fn recoverable_native_turn(&self, id: &str) -> bool {
        self.active_turn.is_none()
            && self.last_native.as_ref().is_some_and(|raw| {
                raw["thread"]["turns"].as_array().is_some_and(|turns| {
                    turns
                        .iter()
                        .any(|turn| turn["id"] == id && turn["status"] == "inProgress")
                })
            })
    }

    pub(super) fn freeze_active(&mut self, status: &str) {
        if let Some(id) = self.active_turn.take() {
            self.terminal_turns.insert(id.clone());
            if let Some(turn) = self.turns.iter_mut().find(|t| t.raw["id"] == id) {
                turn.terminal = true;
                turn.raw["status"] = json!(status);
            }
        }
        self.trim_frozen();
    }

    fn trim_frozen(&mut self) {
        let mut bytes: usize = self
            .turns
            .iter()
            .filter(|t| t.terminal)
            .map(|t| t.raw.to_string().len())
            .sum();
        let mut count = self.turns.iter().filter(|t| t.terminal).count();
        self.turns.retain(|t| {
            if t.terminal && (bytes > MAX_FROZEN_BYTES || count > MAX_FROZEN_TURNS) {
                bytes = bytes.saturating_sub(t.raw.to_string().len());
                count -= 1;
                false
            } else {
                true
            }
        });
    }

    pub(super) fn invalidate_history(&mut self, removed: &[String]) -> Vec<Value> {
        self.history_generation += 1;
        self.pending_ops.clear();
        if !removed.is_empty() {
            self.freeze_active("interrupted");
        }
        for turn in &mut self.turns {
            if turn.terminal {
                turn.allow_missing_membership = false;
            }
        }
        self.removed_turns.extend(removed.iter().cloned());
        if self
            .plan
            .as_ref()
            .is_some_and(|plan| removed.iter().any(|id| plan["turnId"] == *id))
        {
            self.plan = None;
        }
        if self.diff.as_ref().is_some_and(|diff| {
            removed
                .iter()
                .any(|id| diff["id"] == format!("codex-turn:{id}"))
        }) {
            self.diff = None;
        }
        self.turns
            .retain(|t| !removed.iter().any(|id| t.raw["id"] == *id));
        if let Some(raw) = &mut self.last_native {
            if let Some(turns) = raw["thread"]["turns"].as_array_mut() {
                turns.retain(|t| !removed.iter().any(|id| t["id"] == *id));
            }
        }
        let mut resets: Vec<Value> = self.turns.iter().map(|turn| json!({"op":"resetTurn","nativeTurnId":turn.raw["id"],"turns":super::build_codex_turn_json(&turn.raw,0).unwrap_or_default(),"completedItemIds":turn.completed_items,"nonAppendableItemIds":turn.nonappendable_ids()})).collect();
        resets.extend(
            removed
                .iter()
                .map(|id| json!({"op":"resetTurn","nativeTurnId":id,"turns":[]})),
        );
        resets.into_iter().map(|op| self.op(op)).collect()
    }

    pub(super) fn apply(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<Vec<Value>, ProjectionError> {
        if params.get("threadId").and_then(Value::as_str) != Some(&self.thread_id) {
            return Ok(vec![]);
        }
        if method == "thread/tokenUsage/updated" {
            if let Some(usage) = params
                .get("tokenUsage")
                .filter(|u| u["total"].is_object() && u["last"].is_object())
            {
                self.usage = Some(usage.clone());
            }
            return Ok(vec![]);
        }
        let turn_id = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.get("turn").and_then(|t| t["id"].as_str()));
        let error = |reason| ProjectionError {
            method: method.to_owned(),
            turn_id: turn_id.map(str::to_owned),
            item_id: params
                .get("itemId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            reason,
        };
        if method == "turn/started" {
            let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
            self.open_turn(id);
            return Ok(vec![]);
        }
        if method == "turn/completed" {
            let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
            if self.active_turn.as_deref() != Some(id) {
                return Ok(vec![]);
            }
            // Summary/NotLoaded is status-only. Even a Full notification is
            // not persistence evidence; complete items already supplied bodies.
            let turn = self
                .turns
                .iter_mut()
                .find(|t| t.raw["id"] == id)
                .expect("active event turn");
            let status = params["turn"]["status"]
                .as_str()
                .or_else(|| params["status"].as_str())
                .unwrap_or("completed");
            turn.raw["status"] = json!(status);
            if let Some(err) = params["turn"].get("error") {
                turn.raw["error"] = err.clone();
            }
            self.freeze_active(status);
            return Ok(vec![
                self.op(json!({"op":"settleTurn","nativeTurnId":id,"status":status}))
            ]);
        }
        if matches!(method, "turn/plan/updated" | "turn/diff/updated") {
            let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
            if self.active_turn.as_deref() != Some(id) {
                return Ok(vec![]);
            }
            if method == "turn/plan/updated" {
                self.plan = Some(
                    json!({"turnId":id,"explanation":params.get("explanation"),"plan":params.get("plan").cloned().unwrap_or_else(|| json!([]))}),
                );
            } else if let Some(diff) = params["diff"].as_str() {
                self.diff = Some(
                    json!({"id":format!("codex-turn:{id}"),"title":"Turn changes","diff":diff}),
                );
            }
            return Ok(vec![]);
        }
        let item_boundary = matches!(method, "item/started" | "item/completed");
        let delta_field = match method {
            "item/agentMessage/delta" | "item/plan/delta" => Some(("text", "text", None)),
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                Some(("aggregatedOutput", "output", None))
            }
            "item/reasoning/summaryTextDelta" => Some(("summary", "summary", Some("summaryIndex"))),
            "item/reasoning/textDelta" => Some(("content", "content", Some("contentIndex"))),
            _ => None,
        };
        if !item_boundary
            && delta_field.is_none()
            && !matches!(
                method,
                "item/fileChange/patchUpdated"
                    | "item/mcpToolCall/progress"
                    | "item/reasoning/summaryPartAdded"
            )
        {
            if self.unknown_methods.insert(method.to_owned()) {
                tracing::debug!(provider="codex", session_id=%self.thread_id, projection_id=%self.id, method, "freshagent.codex.unprojected_notification");
            }
            return Ok(vec![]);
        }
        let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
        // Only the first observed item may recover a missed turn/started. Later
        // turns must be opened by their native lifecycle event.
        if self.active_turn.is_none()
            && item_boundary
            && (self.known_turns.is_empty() || self.recoverable_native_turn(id))
        {
            self.open_turn(id);
        }
        if self.active_turn.as_deref() != Some(id) {
            return Ok(vec![]);
        }
        let turn_index = self
            .turns
            .iter()
            .position(|t| t.raw["id"] == id)
            .expect("active event turn");
        let item_id = if item_boundary {
            params["item"]["id"].as_str()
        } else {
            params["itemId"].as_str()
        }
        .filter(|id| !id.is_empty())
        .ok_or_else(|| error("missing native item id"))?;
        if self.turns[turn_index].completed_items.contains(item_id) {
            return Ok(vec![]);
        }
        if item_boundary {
            let item = params
                .get("item")
                .filter(|i| i["type"].is_string())
                .ok_or_else(|| error("missing native item type"))?;
            let old_rows = super::build_codex_turn_json(&self.turns[turn_index].raw, 0)
                .map_err(|_| error("unmappable native turn"))?;
            let items = self.turns[turn_index].raw["items"]
                .as_array_mut()
                .expect("owned items array");
            match items.iter_mut().find(|i| i["id"] == item_id) {
                Some(existing) => *existing = item.clone(),
                None => items.push(item.clone()),
            }
            let complete = method == "item/completed";
            self.turns[turn_index].read_only_items.remove(item_id);
            if complete {
                self.turns[turn_index]
                    .completed_items
                    .insert(item_id.to_owned());
            }
            let rows = super::build_codex_turn_json(&self.turns[turn_index].raw, 0)
                .map_err(|_| error("unmappable native item"))?;
            self.turns[turn_index].row_by_item = rows
                .iter()
                .flat_map(|row| {
                    row["items"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|item| {
                            Some((
                                item["id"].as_str()?.to_owned(),
                                row["id"].as_str()?.to_owned(),
                            ))
                        })
                })
                .collect();
            let old_shape: Vec<_> = old_rows.iter().map(|r| (&r["id"], &r["role"])).collect();
            let new_shape: Vec<_> = rows.iter().map(|r| (&r["id"], &r["role"])).collect();
            let first = !self.turns[turn_index].emitted;
            self.turns[turn_index].emitted = true;
            if first || old_shape != new_shape {
                return Ok(vec![self.op(json!({"op":"resetTurn","nativeTurnId":id,"turns":rows,"completedItemIds":self.turns[turn_index].completed_items,"nonAppendableItemIds":self.turns[turn_index].nonappendable_ids()}))]);
            }
            let mut ops = vec![];
            for row in rows {
                for mapped in row["items"].as_array().into_iter().flatten().filter(|i| {
                    i["id"] == item_id
                        || i["id"]
                            .as_str()
                            .is_some_and(|v| v.starts_with(&format!("{item_id}:part:")))
                }) {
                    let mut header = row.clone();
                    header["items"] = json!([]);
                    ops.push(self.op(json!({"op":"upsertItem","nativeTurnId":id,"row":header,"item":mapped,"complete":complete})));
                }
            }
            return Ok(ops);
        }
        let turn = &mut self.turns[turn_index];
        if turn.read_only_items.contains(item_id) {
            return Ok(vec![]);
        }
        let Some(item) = turn.raw["items"]
            .as_array_mut()
            .expect("owned items array")
            .iter_mut()
            .find(|i| i["id"] == item_id)
        else {
            return Ok(vec![]);
        };
        if let Some((native_field, field, index_field)) = delta_field {
            let delta = params["delta"]
                .as_str()
                .ok_or_else(|| error("missing string delta"))?;
            let expected_type = match field {
                "text" => matches!(item["type"].as_str(), Some("agentMessage" | "plan")),
                "output" => matches!(
                    item["type"].as_str(),
                    Some("commandExecution" | "fileChange")
                ),
                _ => item["type"] == "reasoning",
            };
            if !expected_type {
                return Err(error("delta does not match native item type"));
            }
            let index = index_field
                .map(|key| {
                    params[key]
                        .as_u64()
                        .filter(|i| *i < 1024)
                        .ok_or_else(|| error("invalid native reasoning index"))
                })
                .transpose()?;
            if let Some(index) = index {
                if !item[native_field].is_array() {
                    item[native_field] = json!([]);
                }
                let parts = item[native_field].as_array_mut().expect("indexed array");
                while parts.len() <= index as usize {
                    parts.push(json!(""));
                }
                // Each native indexed part is an owned String, as for ordinary text.
                if let Value::String(target) = &mut parts[index as usize] {
                    target.push_str(delta);
                } else {
                    parts[index as usize] = json!(delta);
                }
            } else {
                append_string(item, native_field, delta);
            }
            let row_id = turn.row_by_item.get(item_id).cloned();
            // Do not emit accumulated bodies on token arrival.
            return Ok(row_id.into_iter().map(|row_id| self.op(json!({"op":"appendItem","nativeTurnId":id,"rowId":row_id,"itemId":item_id,"field":field,"index":index,"text":delta}))).collect());
        }
        if method == "item/fileChange/patchUpdated" {
            if let Some(changes) = params.get("changes").filter(|v| v.is_array()) {
                item["changes"] = changes.clone();
            }
        } else if method == "item/mcpToolCall/progress" {
            item["progress"] = params.get("message").cloned().unwrap_or(Value::Null);
        } else {
            return Ok(vec![]);
        }
        let rows = super::build_codex_turn_json(&turn.raw, 0)
            .map_err(|_| error("unmappable native progress"))?;
        let mut ops = vec![];
        for row in rows {
            for mapped in row["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|i| i["id"] == item_id)
            {
                let mut header = row.clone();
                header["items"] = json!([]);
                ops.push(
                    self.op(
                        json!({"op":"upsertItem","nativeTurnId":id,"row":header,"item":mapped}),
                    ),
                );
            }
        }
        Ok(ops)
    }

    pub(super) fn accept_native_history(
        &mut self,
        raw: &Value,
        fence: &SnapshotReadFence,
    ) -> Result<ProjectionSnapshot, SnapshotStale> {
        if !self.matches_fence(fence) {
            return Err(SnapshotStale);
        }
        if raw["thread"]["id"]
            .as_str()
            .is_some_and(|id| id != self.thread_id)
        {
            return Err(SnapshotStale);
        }
        self.last_native = Some(raw.clone());
        self.build_snapshot(raw, fence, false)
    }

    pub(super) fn unavailable_history(
        &mut self,
        fence: &SnapshotReadFence,
    ) -> Result<ProjectionSnapshot, SnapshotStale> {
        let raw = self.last_native.clone().unwrap_or_else(
            || json!({"thread":{"id":self.thread_id,"status":{"type":"idle"},"turns":[]}}),
        );
        self.build_snapshot(&raw, fence, true)
    }

    fn build_snapshot(
        &mut self,
        raw: &Value,
        fence: &SnapshotReadFence,
        unavailable: bool,
    ) -> Result<ProjectionSnapshot, SnapshotStale> {
        if !self.matches_fence(fence) {
            return Err(SnapshotStale);
        }
        let mut chosen = vec![];
        let mut event_owned = vec![];
        let mut previews = vec![];
        let mut finals = vec![];
        let mut states = Map::new();
        let mut turn_rows = Map::new();
        let mut nonappendable = Map::new();
        let mut native_ids = HashSet::new();
        let owned: HashMap<_, _> = fence
            .turns
            .iter()
            .filter_map(|t| t.raw["id"].as_str().map(|id| (id, t)))
            .collect();
        let legacy = raw["thread"]["historyMode"] == "legacy";
        for native in raw["thread"]["turns"].as_array().into_iter().flatten() {
            let Some(id) = native["id"].as_str() else {
                continue;
            };
            if self.removed_turns.contains(id) {
                continue;
            }
            native_ids.insert(id.to_owned());
            if self.known_turns.insert(id.to_owned()) {
                self.turn_order.push(id.to_owned());
            }
            let full = native["itemsView"]
                .as_str()
                .is_none_or(|view| view == "full");
            let terminal = matches!(
                native["status"].as_str(),
                Some("completed" | "failed" | "interrupted")
            );
            if terminal {
                self.terminal_turns.insert(id.to_owned());
            }
            if let Some(event) = owned.get(id) {
                let mut event = (*event).clone();
                event.refresh_read_only(native);
                if let Some(current) = self.turns.iter_mut().find(|turn| turn.raw["id"] == id) {
                    // An item boundary during the RPC may already have claimed
                    // a field. Refresh only fields that remain read-only now.
                    current.refresh_read_only(native);
                }
                nonappendable.insert(id.to_owned(), json!(event.nonappendable_ids()));
                if terminal && full {
                    let equal = equivalent_turns(&event.raw, native, legacy);
                    let interrupted = native["status"] == "interrupted";
                    let truncated = provider_truncated(native);
                    // A native full read can finish an item whose completion
                    // this incarnation never observed (a PTY may outlive its
                    // originating turn). Only a completed event body demands
                    // semantic agreement; an unfinished body is not final.
                    let finalized_unobserved =
                        event.native_can_finish_unobserved_items(native, legacy);
                    if equal || interrupted || truncated || finalized_unobserved {
                        chosen.push(native.clone());
                        finals.push(id.to_owned());
                        let mut state = json!({"provenance":"saved","refreshPending":false});
                        if interrupted {
                            state["diagnostic"] = json!("interrupted");
                        }
                        if truncated {
                            state["diagnostic"] = json!("provider-truncated");
                        }
                        if !equal && (interrupted || truncated) {
                            state["provenance"] = json!("saved-and-retained");
                            state["retainedTurns"] = json!(super::build_codex_turn_json(
                                &event.raw, 0
                            )
                            .unwrap_or_default());
                        }
                        states.insert(id.to_owned(), state);
                        // Only release the captured prefix, never newer event work.
                        if (equal || (finalized_unobserved && !interrupted && !truncated))
                            && self.revision == fence.event_revision
                        {
                            if self.active_turn.as_deref() == Some(id) {
                                self.active_turn = None;
                            }
                            self.turns.retain(|t| t.raw["id"] != id);
                        }
                        continue;
                    }
                }
                event_owned.push(id.to_owned());
                chosen.push(event.raw.clone());
                let terminal_event = event.terminal || terminal;
                let reads = self
                    .turns
                    .iter_mut()
                    .find(|t| t.raw["id"] == id)
                    .map(|t| {
                        if terminal_event {
                            t.save_reads = t.save_reads.saturating_add(1);
                        }
                        t.save_reads
                    })
                    .unwrap_or(MAX_SAVE_READS);
                let pending = terminal_event && reads < MAX_SAVE_READS && !unavailable;
                let mut state = json!({"provenance":"retained","refreshPending":pending});
                if terminal_event && !pending {
                    state["diagnostic"] = json!(if event.raw["status"] == "interrupted" {
                        "interrupted"
                    } else {
                        "unsaved"
                    });
                }
                if terminal && full {
                    state["savedTurns"] =
                        json!(super::build_codex_turn_json(native, 0).unwrap_or_default());
                }
                states.insert(id.to_owned(), state);
            } else {
                chosen.push(native.clone());
                if terminal && full {
                    finals.push(id.to_owned());
                    let mut state = json!({"provenance":"saved","refreshPending":false});
                    if native["status"] == "interrupted" {
                        state["diagnostic"] = json!("interrupted");
                    }
                    if provider_truncated(native) {
                        state["diagnostic"] = json!("provider-truncated");
                    }
                    states.insert(id.to_owned(), state);
                } else {
                    previews.push(id.to_owned());
                    states.insert(
                        id.to_owned(),
                        json!({"provenance":"preview","refreshPending":false}),
                    );
                }
            }
        }
        for event in &fence.turns {
            let Some(id) = event.raw["id"].as_str() else {
                continue;
            };
            if native_ids.contains(id)
                || self.removed_turns.contains(id)
                || !event.allow_missing_membership
            {
                continue;
            }
            let after = fence
                .turn_order
                .iter()
                .position(|known| known == id)
                .map(|index| &fence.turn_order[index + 1..])
                .unwrap_or(&[]);
            let insertion = after
                .iter()
                .find_map(|next| chosen.iter().position(|turn| turn["id"] == *next))
                .unwrap_or(chosen.len());
            chosen.insert(insertion, event.raw.clone());
            event_owned.push(id.to_owned());
            nonappendable.insert(id.to_owned(), json!(event.nonappendable_ids()));
            let reads = self
                .turns
                .iter_mut()
                .find(|t| t.raw["id"] == id)
                .map(|t| {
                    if event.terminal {
                        t.save_reads = t.save_reads.saturating_add(1);
                    }
                    t.save_reads
                })
                .unwrap_or(MAX_SAVE_READS);
            let pending = event.terminal && reads < MAX_SAVE_READS && !unavailable;
            let mut state = json!({"provenance":"retained","refreshPending":pending});
            if event.terminal && !pending {
                state["diagnostic"] = json!(if event.raw["status"] == "interrupted" {
                    "interrupted"
                } else {
                    "unsaved"
                });
            }
            states.insert(id.to_owned(), state);
        }
        for turn in &chosen {
            let id = turn["id"].as_str().unwrap_or("");
            turn_rows.insert(
                id.to_owned(),
                json!(super::build_codex_turn_json(turn, 0)
                    .unwrap_or_default()
                    .iter()
                    .map(|r| r["id"].clone())
                    .collect::<Vec<_>>()),
            );
        }
        let mut order: Vec<String> = chosen
            .iter()
            .filter_map(|turn| turn["id"].as_str().map(str::to_owned))
            .collect();
        let mut ordered: HashSet<String> = order.iter().cloned().collect();
        for id in &self.turn_order {
            if !self.removed_turns.contains(id) && ordered.insert(id.clone()) {
                order.push(id.clone());
            }
        }
        self.turn_order = order;
        let mut output = raw.clone();
        output["thread"]["turns"] = json!(chosen);
        let completed_items: Map<String, Value> = fence
            .turns
            .iter()
            .filter_map(|turn| {
                Some((
                    turn.raw["id"].as_str()?.to_owned(),
                    json!(turn.completed_items),
                ))
            })
            .collect();
        let settled: Vec<_> = fence
            .turns
            .iter()
            .filter(|turn| turn.terminal)
            .map(|turn| turn.raw["id"].clone())
            .collect();
        let mut metadata = json!({"id":self.id,"eventRevision":fence.event_revision,"historyGeneration":fence.history_generation,"completedItems":completed_items,"nonAppendableItemIds":nonappendable,"settledTurnIds":settled,
            "eventOwnedTurnIds":event_owned,"nativePreviewTurnIds":previews,"nativeFinalTurnIds":finals,"turnOutputStates":states,"turnRows":turn_rows});
        if unavailable {
            metadata["availability"] =
                json!({"status":"unavailable","retryable":true,"code":"CODEX_HISTORY_UNAVAILABLE"});
        }
        Ok(ProjectionSnapshot {
            raw: output,
            metadata,
        })
    }

    pub(super) fn overlay(&self, snapshot: &mut Value, metadata: Value) {
        snapshot["extensions"]["codex"]["projection"] = metadata;
        snapshot["tokenUsage"]["observed"] = json!(self.usage.is_some());
        if let Some(usage) = &self.usage {
            snapshot["extensions"]["codex"]["usage"] = usage.clone();
            let total = &usage["total"];
            snapshot["tokenUsage"] = json!({"observed":true,"inputTokens":total["inputTokens"].as_u64().unwrap_or(0),"outputTokens":total["outputTokens"].as_u64().unwrap_or(0),"cachedTokens":total["cachedInputTokens"].as_u64().unwrap_or(0),"totalTokens":total["totalTokens"].as_u64().unwrap_or(0)});
            if let Some(window) = usage["modelContextWindow"].as_u64() {
                snapshot["tokenUsage"]["modelContextWindow"] = json!(window);
            }
        }
        if let Some(plan) = &self.plan {
            snapshot["extensions"]["codex"]["plan"] = plan.clone();
        }
        if let Some(diff) = &self.diff {
            if let Some(diffs) = snapshot["diffs"].as_array_mut() {
                diffs.push(diff.clone());
            }
            snapshot["capabilities"]["diffs"] = json!(true);
        }
    }

    #[cfg(test)]
    fn snapshot_rows(&self, turn_id: &str) -> Option<Vec<Value>> {
        super::build_codex_turn_json(&self.turns.iter().find(|t| t.raw["id"] == turn_id)?.raw, 0)
            .ok()
    }
}

fn append_string(target: &mut Value, field: &str, delta: &str) {
    match target.get_mut(field) {
        Some(Value::String(text)) => text.push_str(delta),
        _ => target[field] = Value::String(delta.to_owned()),
    }
}

pub(super) fn stamp_saved_output_state(raw: &Value, rows: &mut [Value]) {
    let diagnostic = if raw["status"] == "interrupted" {
        Some("interrupted")
    } else if provider_truncated(raw) {
        Some("provider-truncated")
    } else {
        None
    };
    if let (Some(diagnostic), Some(row)) = (diagnostic, rows.first_mut()) {
        row["outputState"] =
            json!({"provenance":"saved","diagnostic":diagnostic,"refreshPending":false});
    }
}

// Compare the complete ordered display representation, preserving roles,
// duplicate bodies, tool outcomes and errors. Legacy reconstructs item-N ids;
// only that evidenced presentation difference is normalized.
fn equivalent_turns(event: &Value, native: &Value, legacy: bool) -> bool {
    let (Ok(mut event_rows), Ok(mut native_rows)) = (
        super::build_codex_turn_json(event, 0),
        super::build_codex_turn_json(native, 0),
    ) else {
        return false;
    };
    if event_rows.len() != native_rows.len() {
        return false;
    }
    for (event, native) in event_rows.iter_mut().zip(native_rows.iter_mut()) {
        if event["role"] != native["role"] {
            return false;
        }
        let left = event["items"].as_array_mut().expect("mapped items");
        let right = native["items"].as_array_mut().expect("mapped items");
        if left.len() != right.len() {
            return false;
        }
        for (event, native) in left.iter_mut().zip(right.iter_mut()) {
            let reconstructed = legacy
                && native["id"].as_str().is_some_and(|id| {
                    let base = id.split(":part:").next().unwrap_or(id);
                    base.strip_prefix("item-")
                        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                });
            if reconstructed {
                strip_presentation_id(event);
                strip_presentation_id(native);
            }
            if event != native {
                return false;
            }
        }
    }
    true
}

fn strip_presentation_id(item: &mut Value) {
    if let Some(object) = item.as_object_mut() {
        object.remove("id");
    }
    if let Some(raw) = item
        .get_mut("extensions")
        .and_then(|v| v.get_mut("codex"))
        .and_then(Value::as_object_mut)
    {
        raw.remove("id");
    }
}

fn provider_truncated(turn: &Value) -> bool {
    turn["items"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|item| match item["type"].as_str() {
            Some("commandExecution") => item["aggregatedOutput"]
                .as_str()
                .is_some_and(|s| s.contains("... command output truncated for persistence ...")),
            Some("mcpToolCall") => item["result"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|content| content["type"] == "text")
                .filter_map(|content| content["text"].as_str())
                .any(has_native_mcp_truncation_marker),
            _ => false,
        })
}

fn has_native_mcp_truncation_marker(text: &str) -> bool {
    // Codex 0.164 inserts an inline …N chars truncated… marker into saved MCP
    // text. A mention in prose or non-text result metadata is not that marker.
    text.split_inclusive('…').skip(1).any(|segment| {
        segment
            .strip_suffix(" chars truncated…")
            .is_some_and(|count| {
                !count.is_empty() && count.bytes().all(|byte| byte.is_ascii_digit())
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::tests as rig;
    use freshell_codex::CodexAppServerClient;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn started(p: &mut CodexProjection, id: &str) {
        p.apply(
            "turn/started",
            &json!({"threadId":"thread-1","turn":{"id":id,"status":"inProgress"}}),
        )
        .unwrap();
    }
    fn item(p: &mut CodexProjection, turn: &str, body: Value, completed: bool) -> Vec<Value> {
        p.apply(
            if completed {
                "item/completed"
            } else {
                "item/started"
            },
            &json!({"threadId":"thread-1","turnId":turn,"item":body}),
        )
        .unwrap()
    }
    fn delta(p: &mut CodexProjection, turn: &str, text: &str) -> Vec<Value> {
        p.apply(
            "item/agentMessage/delta",
            &json!({"threadId":"thread-1","turnId":turn,"itemId":"answer","delta":text}),
        )
        .unwrap()
    }
    fn ended(p: &mut CodexProjection, turn: &str, status: &str) {
        p.apply("turn/completed", &json!({"threadId":"thread-1","turn":{"id":turn,"status":status,"itemsView":"summary","items":[]}})).unwrap();
    }
    fn history(turns: Value) -> Value {
        json!({"thread":{"id":"thread-1","historyMode":"paginated","status":{"type":"idle"},"turns":turns}})
    }
    fn snapshot(p: &mut CodexProjection, turns: Value) -> ProjectionSnapshot {
        p.accept_native_history(&history(turns), &p.begin_history_read())
            .unwrap()
    }

    #[test]
    fn independent_read_never_becomes_the_event_delta_baseline() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":""}),
            false,
        );
        delta(&mut p, "t", "Hel");
        let ahead = snapshot(
            &mut p,
            json!([{"id":"t","status":"inProgress","itemsView":"full","items":[{"type":"agentMessage","id":"answer","text":"Hello"}]}]),
        );
        assert_eq!(ahead.metadata["eventOwnedTurnIds"], json!(["t"]));
        delta(&mut p, "t", "lo");
        assert_eq!(
            p.snapshot_rows("t").unwrap()[0]["items"][0]["text"],
            "Hello"
        );
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":"Hello"}),
            true,
        );
        assert!(delta(&mut p, "t", "lo").is_empty());
        ended(&mut p, "t", "completed");
        let saved = snapshot(
            &mut p,
            json!([{"id":"t","status":"completed","itemsView":"full","items":[{"type":"agentMessage","id":"answer","text":"Hello"}]}]),
        );
        assert_eq!(saved.metadata["nativeFinalTurnIds"], json!(["t"]));
        assert_eq!(
            saved.raw["thread"]["turns"][0]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn summary_interruption_retains_fragments_and_cold_recovery_is_saved_only() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":""}),
            false,
        );
        delta(&mut p, "t", "unfinished 🙂");
        ended(&mut p, "t", "interrupted");
        let raw = json!([{"id":"t","status":"interrupted","itemsView":"full","items":[{"type":"userMessage","id":"user","content":[{"type":"text","text":"go"}]}]}]);
        let warm = snapshot(&mut p, raw.clone());
        assert_eq!(
            warm.metadata["turnOutputStates"]["t"]["provenance"],
            "saved-and-retained"
        );
        assert_eq!(
            warm.metadata["turnOutputStates"]["t"]["diagnostic"],
            "interrupted"
        );
        assert_eq!(
            warm.metadata["turnOutputStates"]["t"]["refreshPending"],
            false
        );
        assert_eq!(
            warm.metadata["turnOutputStates"]["t"]["retainedTurns"][0]["items"][0]["text"],
            "unfinished 🙂"
        );
        assert!(delta(&mut p, "t", "late").is_empty());
        let mut cold = CodexProjection::new("cold".into(), "thread-1".into());
        let saved = snapshot(&mut cold, raw);
        assert_eq!(
            saved.metadata["turnOutputStates"]["t"],
            json!({"provenance":"saved","diagnostic":"interrupted","refreshPending":false})
        );
    }

    #[test]
    fn missing_or_different_assistant_persistence_reaches_finite_unsaved_state() {
        for turns in [
            json!([]),
            json!([{"id":"t","status":"completed","itemsView":"full","items":[{"type":"agentMessage","id":"answer","text":"short"}]}]),
        ] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            item(
                &mut p,
                "t",
                json!({"type":"agentMessage","id":"answer","text":"retained complete answer"}),
                true,
            );
            ended(&mut p, "t", "completed");
            for attempt in 1..=4 {
                let view = snapshot(&mut p, turns.clone());
                assert_eq!(
                    view.raw["thread"]["turns"][0]["items"][0]["text"],
                    "retained complete answer"
                );
                assert_eq!(
                    view.metadata["turnOutputStates"]["t"]["refreshPending"],
                    attempt < 3
                );
                if attempt >= 3 {
                    assert_eq!(
                        view.metadata["turnOutputStates"]["t"]["diagnostic"],
                        "unsaved"
                    );
                }
            }
        }
    }

    #[test]
    fn legacy_comparison_preserves_duplicate_bodies_roles_and_outcomes() {
        let event = json!({"id":"t","status":"completed","items":[{"type":"userMessage","id":"uuid-user","content":[{"type":"text","text":"same"}]},{"type":"agentMessage","id":"msg-1","text":"same"},{"type":"agentMessage","id":"msg-2","text":"same"},{"type":"commandExecution","id":"call-1","command":"pwd","status":"failed","exitCode":1}]});
        let mut native = event.clone();
        for (index, i) in native["items"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            i["id"] = json!(format!("item-{}", index + 1));
        }
        assert!(equivalent_turns(&event, &native, true));
        assert!(!equivalent_turns(&event, &native, false));
        // Legacy reconstructs message ids while preserving actual tool call
        // ids in the same turn (also observed in the large-result capture).
        native["items"][3]["id"] = json!("call-1");
        assert!(equivalent_turns(&event, &native, true));
        native["items"].as_array_mut().unwrap().remove(2);
        assert!(!equivalent_turns(&event, &native, true));
        assert!(!provider_truncated(
            &json!({"items":[{"type":"agentMessage","text":"short"}]})
        ));
    }

    #[test]
    fn native_tool_truncation_preserves_saved_markers_and_richer_retained_output() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        let item_body = json!({"type":"commandExecution","id":"cmd","command":"large","status":"completed","aggregatedOutput":"x".repeat(100_000)});
        item(&mut p, "t", item_body.clone(), true);
        ended(&mut p, "t", "completed");
        let mut saved_item = item_body;
        saved_item["aggregatedOutput"] = json!(format!(
            "{}\n... command output truncated for persistence ...\n{}",
            "x".repeat(32000),
            "x".repeat(32000)
        ));
        let view = snapshot(
            &mut p,
            json!([{"id":"t","status":"completed","itemsView":"full","items":[saved_item.clone()]}]),
        );
        assert_eq!(view.raw["thread"]["turns"][0]["items"][0], saved_item);
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["diagnostic"],
            "provider-truncated"
        );
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["refreshPending"],
            false
        );
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["retainedTurns"][0]["items"][0]["output"]
                .as_str()
                .unwrap()
                .len(),
            100_000
        );
    }

    #[test]
    fn mcp_truncation_mentions_do_not_end_persistence_refresh_or_mislabel_saved_output() {
        for result in [
            json!({"content":[{"type":"text","text":"The report says 12 chars truncated by the old formatter."}]}),
            json!({"content":[{"type":"text","text":"before… chars truncated…after"}]}),
            json!({"content":[{"type":"text","text":"before…12 chars truncated after"}]}),
            json!({"content":[{"type":"text","text":"before…12x chars truncated…after"}]}),
            json!({"content":[{"type":"text","text":"before12 chars truncated…after"}]}),
            json!({"content":[{"type":"text","text":"ordinary output"}],"structuredContent":{"note":"…12 chars truncated…"}}),
            json!({"content":[{"type":"text","text":"ordinary output"}],"_meta":{"note":"…12 chars truncated…"}}),
            json!({"content":[{"type":"resource","resource":{"text":"…12 chars truncated…"}}]}),
        ] {
            let saved_item = json!({"type":"mcpToolCall","id":"mcp","server":"fixture","tool":"report","status":"completed","arguments":{},"result":result});
            let saved_turn = json!({"id":"t","status":"completed","itemsView":"full","items":[saved_item.clone()]});
            for retained_differs in [false, true] {
                let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
                started(&mut p, "t");
                let mut retained_item = saved_item.clone();
                if retained_differs {
                    retained_item["result"] =
                        json!({"content":[{"type":"text","text":"retained complete result"}]});
                }
                item(&mut p, "t", retained_item.clone(), true);
                ended(&mut p, "t", "completed");
                for attempt in 1..=3 {
                    let view = snapshot(&mut p, json!([saved_turn.clone()]));
                    let state = &view.metadata["turnOutputStates"]["t"];
                    assert_eq!(view.raw["thread"]["turns"][0]["items"][0], retained_item);
                    assert_eq!(
                        state["refreshPending"],
                        retained_differs && attempt < 3,
                        "ordinary MCP result must not end persistence refresh: {result}"
                    );
                    if retained_differs {
                        assert_eq!(state["provenance"], "retained");
                        assert_eq!(state["savedTurns"][0]["items"][0]["result"], result);
                        assert_eq!(
                            state["diagnostic"],
                            if attempt < 3 {
                                Value::Null
                            } else {
                                json!("unsaved")
                            }
                        );
                    } else {
                        assert_eq!(state["provenance"], "saved");
                        assert!(
                            state["diagnostic"].is_null(),
                            "ordinary MCP result was labeled truncated: {result}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn captured_0164_mcp_truncation_preserves_exact_saved_and_richer_retained_results() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/fresh-agent/codex/native-projection-0.164.json"
        ))
        .unwrap();
        let case = corpus["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| {
                case["parameters"]["largeOutput"] == true
                    && case["parameters"]["historyMode"] == "paginated"
            })
            .unwrap();
        let mut native = case["read"].clone();
        // Isolate MCP so a command's separate persistence marker cannot make
        // this test pass without recognizing the captured MCP representation.
        native["thread"]["turns"][0]["items"]
            .as_array_mut()
            .unwrap()
            .retain(|item| item["type"] == "mcpToolCall");
        let thread = native["thread"]["id"].as_str().unwrap();
        let turn = native["thread"]["turns"][0]["id"].as_str().unwrap();
        let mut p = CodexProjection::new("actual-mcp-capture".into(), thread.into());
        let mut retained_result = Value::Null;
        for notification in case["notifications"].as_array().unwrap() {
            let method = notification["method"].as_str().unwrap();
            let params = &notification["params"];
            if matches!(method, "turn/started" | "turn/completed")
                || params["item"]["type"] == "mcpToolCall"
            {
                p.apply(method, params).unwrap();
            }
            if method == "item/completed" && params["item"]["type"] == "mcpToolCall" {
                retained_result = params["item"]["result"].clone();
            }
        }
        let saved_result = &native["thread"]["turns"][0]["items"][0]["result"];
        assert!(saved_result["content"][0]["text"].as_str().unwrap().len() > 64_000);
        assert!(
            retained_result["content"][0]["text"]
                .as_str()
                .unwrap()
                .len()
                > 128_000
        );
        let view = p
            .accept_native_history(&native, &p.begin_history_read())
            .unwrap();
        assert_eq!(view.raw["thread"]["turns"], native["thread"]["turns"]);
        let state = &view.metadata["turnOutputStates"][turn];
        assert_eq!(state["provenance"], "saved-and-retained");
        assert_eq!(state["diagnostic"], "provider-truncated");
        assert_eq!(state["refreshPending"], false);
        assert_eq!(
            state["retainedTurns"][0]["items"][0]["result"],
            retained_result
        );
        let mut cold = CodexProjection::new("cold-mcp-capture".into(), thread.into());
        let saved = cold
            .accept_native_history(&native, &cold.begin_history_read())
            .unwrap();
        assert_eq!(saved.raw["thread"]["turns"], native["thread"]["turns"]);
        assert_eq!(
            saved.metadata["turnOutputStates"][turn],
            json!({"provenance":"saved","diagnostic":"provider-truncated","refreshPending":false})
        );
    }

    #[test]
    fn reads_crossing_history_or_owner_mutation_are_rejected_and_removed_turns_never_reopen() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":"before undo"}),
            true,
        );
        ended(&mut p, "t", "completed");
        let fence = p.begin_history_read();
        p.invalidate_history(&["t".into()]);
        assert!(p
            .accept_native_history(&history(json!([])), &fence)
            .is_err());
        for index in 0..12 {
            let id = format!("later-{index}");
            started(&mut p, &id);
            ended(&mut p, &id, "completed");
        }
        assert!(item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"late","text":"removed"}),
            false
        )
        .is_empty());
        assert!(delta(&mut p, "t", "removed").is_empty());
        assert_eq!(
            snapshot(&mut p, json!([])).metadata["nativeFinalTurnIds"],
            json!([])
        );
        let owner_fence = p.begin_history_read();
        p.bind_owner(1, 2);
        assert!(p
            .accept_native_history(&history(json!([])), &owner_fence)
            .is_err());
    }

    #[test]
    fn cold_native_preview_can_receive_a_normal_complete_item_without_appending_from_the_read() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        snapshot(
            &mut p,
            json!([{"id":"t","status":"inProgress","itemsView":"full","items":[{"type":"agentMessage","id":"answer","text":"preview"}]}]),
        );
        assert!(delta(&mut p, "t", "not-a-baseline").is_empty());
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":"complete"}),
            true,
        );
        assert_eq!(
            p.snapshot_rows("t").unwrap()[0]["items"][0]["text"],
            "complete"
        );
    }

    #[test]
    fn cold_recovery_preserves_native_prefix_roles_and_finishes_as_one_saved_group() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        let mut native = json!({"id":"t","status":"inProgress","itemsView":"full","items":[
            {"id":"u","type":"userMessage","content":[{"type":"text","text":"go"}]},
            {"id":"prior","type":"agentMessage","text":"Prior commentary"},
            {"id":"cmd","type":"commandExecution","command":"pwd","status":"completed","aggregatedOutput":"/work"},
            {"id":"answer","type":"agentMessage","text":"partial"}
        ]});
        snapshot(&mut p, json!([native.clone()]));
        item(
            &mut p,
            "t",
            json!({"id":"answer","type":"agentMessage","text":"complete"}),
            true,
        );
        let rows = p.snapshot_rows("t").unwrap();
        assert_eq!(
            rows.len(),
            4,
            "recovering the complete item cannot erase the independently read prefix"
        );
        assert_eq!(rows[0]["role"], "user");
        assert_eq!(rows[1]["items"][0]["text"], "Prior commentary");
        assert!(p.apply("item/agentMessage/delta",&json!({"threadId":"thread-1","turnId":"t","itemId":"prior","delta":"must not append"})).unwrap().is_empty());
        ended(&mut p, "t", "completed");
        native["status"] = json!("completed");
        native["items"][3]["text"] = json!("complete");
        let view = snapshot(&mut p, json!([native]));
        assert_eq!(view.metadata["nativeFinalTurnIds"], json!(["t"]));
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["provenance"],
            "saved"
        );
    }

    #[test]
    fn read_only_prefix_refresh_never_overwrites_live_fields_or_hides_a_completed_mismatch() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        let mut native = json!({"id":"t","status":"inProgress","itemsView":"full","items":[
            {"id":"prior","type":"agentMessage","text":"older preview"},
            {"id":"answer","type":"agentMessage","text":"read-only answer"}
        ]});
        snapshot(&mut p, json!([native.clone()]));
        let ops = item(
            &mut p,
            "t",
            json!({"id":"answer","type":"agentMessage","text":""}),
            false,
        );
        assert_eq!(ops[0]["nonAppendableItemIds"], json!(["prior"]));
        let fence = p.begin_history_read();
        delta(&mut p, "t", "Hel");
        native["items"][0]["text"] = json!("newer preview");
        native["items"][1]["text"] = json!("Hello");
        let view = p
            .accept_native_history(&history(json!([native.clone()])), &fence)
            .unwrap();
        assert_eq!(
            view.raw["thread"]["turns"][0]["items"][0]["text"],
            "newer preview"
        );
        assert_eq!(view.raw["thread"]["turns"][0]["items"][1]["text"], "");
        assert_eq!(p.snapshot_rows("t").unwrap()[0]["items"][1]["text"], "Hel");
        item(
            &mut p,
            "t",
            json!({"id":"answer","type":"agentMessage","text":"actual completed mismatch"}),
            true,
        );
        ended(&mut p, "t", "completed");
        native["status"] = json!("completed");
        let mut view = snapshot(&mut p, json!([native.clone()]));
        for _ in 1..MAX_SAVE_READS {
            view = snapshot(&mut p, json!([native.clone()]));
        }
        assert_eq!(view.metadata["nativeFinalTurnIds"], json!([]));
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["diagnostic"],
            "unsaved"
        );
        assert_eq!(
            view.raw["thread"]["turns"][0]["items"][1]["text"],
            "actual completed mismatch"
        );
    }

    #[test]
    fn an_unfinished_sibling_cannot_excuse_a_completed_item_mismatch() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"id":"cmd","type":"commandExecution","command":"pwd","status":"inProgress","aggregatedOutput":""}),
            false,
        );
        item(
            &mut p,
            "t",
            json!({"id":"answer","type":"agentMessage","text":"actual completed output"}),
            true,
        );
        ended(&mut p, "t", "completed");
        let native = json!([{"id":"t","status":"completed","itemsView":"full","items":[
            {"id":"cmd","type":"commandExecution","command":"pwd","status":"completed","aggregatedOutput":"/work"},
            {"id":"answer","type":"agentMessage","text":"different unexplained output"}
        ]}]);
        let mut view = snapshot(&mut p, native.clone());
        for _ in 1..MAX_SAVE_READS {
            view = snapshot(&mut p, native.clone());
        }
        assert_eq!(view.metadata["nativeFinalTurnIds"], json!([]));
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["diagnostic"],
            "unsaved"
        );
        assert_eq!(
            view.raw["thread"]["turns"][0]["items"][1]["text"],
            "actual completed output"
        );
    }

    #[test]
    fn indexed_reasoning_command_progress_and_file_patch_updates_keep_native_item_identity() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"id":"r","type":"reasoning","summary":[],"content":[]}),
            false,
        );
        for (index, text) in [(1, "思"), (0, "🙂"), (1, "考")] {
            p.apply("item/reasoning/summaryTextDelta",&json!({"threadId":"thread-1","turnId":"t","itemId":"r","summaryIndex":index,"delta":text})).unwrap();
        }
        assert_eq!(
            p.snapshot_rows("t").unwrap()[0]["items"][0]["summary"],
            json!(["🙂", "思考"])
        );
        item(
            &mut p,
            "t",
            json!({"id":"cmd","type":"commandExecution","command":"echo hi","status":"inProgress"}),
            false,
        );
        let ops = p
            .apply(
                "item/commandExecution/outputDelta",
                &json!({"threadId":"thread-1","turnId":"t","itemId":"cmd","delta":"live output"}),
            )
            .unwrap();
        assert_eq!(ops[0]["text"], "live output");
        assert_eq!(
            p.snapshot_rows("t").unwrap()[1]["items"][0]["output"],
            "live output"
        );
        item(
            &mut p,
            "t",
            json!({"id":"files","type":"fileChange","status":"inProgress","changes":[]}),
            false,
        );
        for diff in ["+first", "+replacement"] {
            p.apply("item/fileChange/patchUpdated",&json!({"threadId":"thread-1","turnId":"t","itemId":"files","changes":[{"path":"a","diff":diff}]})).unwrap();
        }
        assert_eq!(
            p.snapshot_rows("t").unwrap()[1]["items"][1]["changes"][0]["diff"],
            "+replacement"
        );
        p.apply(
            "item/fileChange/outputDelta",
            &json!({"threadId":"thread-1","turnId":"t","itemId":"files","delta":"Applying patch"}),
        )
        .unwrap();
        assert_eq!(
            p.snapshot_rows("t").unwrap()[1]["items"][1]["output"],
            "Applying patch"
        );
    }

    #[test]
    fn usage_plan_diff_are_latest_aggregates_and_have_no_invented_context_or_cost() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        p.apply("thread/tokenUsage/updated",&json!({"threadId":"thread-1","turnId":"t","tokenUsage":{"last":{"totalTokens":20,"inputTokens":15,"outputTokens":5,"reasoningOutputTokens":3},"total":{"totalTokens":200,"inputTokens":150,"cachedInputTokens":80,"outputTokens":50},"modelContextWindow":258400}})).unwrap();
        for text in ["old", "latest"] {
            p.apply("turn/plan/updated",&json!({"threadId":"thread-1","turnId":"t","explanation":text,"plan":[{"step":text,"status":"inProgress"}]})).unwrap();
            p.apply(
                "turn/diff/updated",
                &json!({"threadId":"thread-1","turnId":"t","diff":text}),
            )
            .unwrap();
        }
        let mut view =
            json!({"extensions":{"codex":{}},"tokenUsage":{},"diffs":[],"capabilities":{}});
        p.overlay(&mut view, json!({}));
        assert_eq!(view["tokenUsage"]["totalTokens"], 200);
        assert_eq!(
            view["extensions"]["codex"]["usage"]["last"]["totalTokens"],
            20
        );
        assert!(view["tokenUsage"].get("contextTokens").is_none());
        assert!(view["tokenUsage"].get("costUsd").is_none());
        assert_eq!(view["extensions"]["codex"]["plan"]["explanation"], "latest");
        assert_eq!(
            view["diffs"],
            json!([{"id":"codex-turn:t","title":"Turn changes","diff":"latest"}])
        );
    }

    #[test]
    fn emitted_delta_bytes_grow_linearly_and_batch_adjacent_fields() {
        fn run(count: usize) -> (usize, String) {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            item(
                &mut p,
                "t",
                json!({"id":"answer","type":"agentMessage","text":""}),
                false,
            );
            let mut bytes = 0;
            for _ in 0..count {
                let ops = delta(&mut p, "t", "🙂");
                bytes += serde_json::to_vec(&ops).unwrap().len();
                p.enqueue(ops);
            }
            let batch = p.take_patch().unwrap();
            assert_eq!(batch["ops"].as_array().unwrap().len(), 1);
            assert_eq!(batch["ops"][0]["text"], "🙂".repeat(count));
            (
                bytes,
                p.snapshot_rows("t").unwrap()[0]["items"][0]["text"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            )
        }
        let (a, text) = run(1000);
        let (b, other) = run(2000);
        assert_eq!(text.len() * 2, other.len());
        assert!(b > a * 19 / 10 && b < a * 21 / 10);
    }

    #[tokio::test]
    async fn native_frames_reach_real_consumer_before_completion_with_thread_isolation_and_mcp_progress(
    ) {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let (state, _) = rig::state_with_bus();
        let mut rx = rig::insert_fake_session_with_real_consumer(
            &state,
            "thread-1",
            Arc::new(client),
            Arc::new(Mutex::new(None)),
            notifs,
            rig::spawn_sleeper(),
            "codex-projection-consumer",
        )
        .await;
        peer.emit_notification(
            "turn/started",
            json!({"threadId":"thread-1","turn":{"id":"t","status":"inProgress"}}),
        );
        peer.emit_notification("item/started",json!({"threadId":"thread-1","turnId":"t","item":{"type":"agentMessage","id":"answer","text":""}}));
        peer.emit_notification(
            "item/agentMessage/delta",
            json!({"threadId":"thread-1","turnId":"t","itemId":"answer","delta":"Hel"}),
        );
        peer.emit_notification("item/agentMessage/delta",json!({"threadId":"foreign","turnId":"t","itemId":"answer","delta":"SECRET_OTHER_THREAD"}));
        peer.emit_notification("item/started",json!({"threadId":"thread-1","turnId":"t","item":{"type":"commandExecution","id":"cmd","command":"echo progress","status":"inProgress"}}));
        peer.emit_notification(
            "item/commandExecution/outputDelta",
            json!({"threadId":"thread-1","turnId":"t","itemId":"cmd","delta":"tool progress"}),
        );
        peer.emit_notification("item/started",json!({"threadId":"thread-1","turnId":"t","item":{"type":"mcpToolCall","id":"mcp","server":"fixture","tool":"probe","status":"inProgress","arguments":{}}}));
        peer.emit_notification(
            "item/mcpToolCall/progress",
            json!({"threadId":"thread-1","turnId":"t","itemId":"mcp","message":"halfway"}),
        );
        peer.emit_notification("error",json!({"threadId":"thread-1","turnId":"t","error":{"message":"temporary failure"},"willRetry":true}));
        peer.emit_notification("error",json!({"threadId":"thread-1","turnId":"t","error":{"message":"provider notice"},"willRetry":false}));
        let mut frames = vec![];
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                let end = frame["event"]["type"] == "freshAgent.notice";
                frames.push(frame);
                if end {
                    break;
                }
            }
        })
        .await
        .expect("consumer flushes before notice without a turn completion");
        let ops: Vec<_> = frames
            .iter()
            .flat_map(|f| f["event"]["ops"].as_array().into_iter().flatten())
            .collect();
        assert!(ops.iter().any(|op| op["text"] == "Hel"));
        assert!(ops.iter().any(|op| op["text"] == "tool progress"));
        assert!(ops.iter().any(|op| op["item"]["progress"] == "halfway"));
        assert!(frames
            .iter()
            .any(|f| f["event"]["type"] == "freshAgent.retry"));
        assert!(!serde_json::to_string(&frames)
            .unwrap()
            .contains("SECRET_OTHER_THREAD"));
        assert!(!frames
            .iter()
            .any(|f| f["event"]["type"] == "freshAgent.turn.complete"));
        // The in-memory transport's recv owns its mutex while awaiting a
        // frame. End the scripted peer before close so cleanup can acquire it.
        drop(peer);
        state.shutdown().await;
    }

    #[tokio::test]
    async fn snapshot_rpc_held_across_history_mutation_is_reread_without_resuming_a_provider() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let (state, _) = rig::state_with_bus();
        let _rx = rig::insert_fake_session_with_real_consumer(
            &state,
            "thread-1",
            Arc::new(client),
            Arc::new(Mutex::new(None)),
            notifs,
            rig::spawn_sleeper(),
            "codex-projection-read-fence",
        )
        .await;
        let reader = state.clone();
        let snapshot = tokio::spawn(async move { reader.get_snapshot("thread-1", None).await });
        let init = peer.expect_request().await;
        assert_eq!(init.1, "initialize");
        peer.respond(&init.0,json!({"userAgent":"fixture","codexHome":"/fixture","platformFamily":"unix","platformOs":"linux"}));
        assert_eq!(peer.expect_notification().await.0, "initialized");
        let request = peer.expect_request().await;
        assert_eq!(request.1, "thread/read");
        assert_eq!(request.2["includeTurns"], true);
        state
            .sessions
            .lock()
            .await
            .get("thread-1")
            .unwrap()
            .projection
            .lock()
            .unwrap()
            .invalidate_history(&["removed".into()]);
        peer.respond(&request.0,history(json!([{"id":"removed","status":"completed","itemsView":"full","items":[{"id":"a","type":"agentMessage","text":"must disappear"}]}])));
        let reread = peer.expect_request().await;
        assert_eq!(reread.1, "thread/read");
        peer.respond(&reread.0, history(json!([])));
        let result = snapshot.await.unwrap().unwrap();
        assert_eq!(result["turns"], json!([]));
        assert_eq!(
            result["extensions"]["codex"]["projection"]["historyGeneration"],
            1
        );
        drop(peer);
        state.shutdown().await;
    }

    #[test]
    fn a_native_preview_cannot_reopen_an_already_ended_operation() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        snapshot(&mut p, json!([{"id":"t","status":"inProgress","items":[]}]));
        item(
            &mut p,
            "t",
            json!({"id":"answer","type":"agentMessage","text":"final"}),
            true,
        );
        ended(&mut p, "t", "completed");
        started(&mut p, "t");
        assert!(item(
            &mut p,
            "t",
            json!({"id":"late","type":"agentMessage","text":"old"}),
            false
        )
        .is_empty());
    }

    #[test]
    fn cold_saved_rollout_explains_interrupted_output_without_a_provider_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("rollout.jsonl");
        let rows = [
            json!({"type":"session_meta","payload":{"id":"thread-1"}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}}),
            json!({"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t","reason":"interrupted"}}),
        ];
        std::fs::write(
            &file,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        let saved = super::super::native_history::read_rollout(&file, "thread-1").unwrap();
        assert_eq!(
            saved["turns"][0]["outputState"],
            json!({"provenance":"saved","diagnostic":"interrupted","refreshPending":false})
        );
        assert_eq!(saved["tokenUsage"]["observed"], false);
    }

    #[test]
    fn read_unavailability_preserves_retained_output_and_reports_typed_status() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        item(
            &mut p,
            "t",
            json!({"type":"agentMessage","id":"answer","text":""}),
            false,
        );
        delta(&mut p, "t", "retained");
        p.freeze_active("interrupted");
        let view = p.unavailable_history(&p.begin_history_read()).unwrap();
        assert_eq!(
            view.raw["thread"]["turns"][0]["items"][0]["text"],
            "retained"
        );
        assert_eq!(
            view.metadata["availability"],
            json!({"status":"unavailable","retryable":true,"code":"CODEX_HISTORY_UNAVAILABLE"})
        );
        assert_eq!(
            view.metadata["turnOutputStates"]["t"]["refreshPending"],
            false
        );
    }

    #[tokio::test]
    async fn snapshot_cuts_pending_batch_before_capturing_its_event_prefix() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let (state, _) = rig::state_with_bus();
        let mut rx = rig::insert_fake_session_with_real_consumer(
            &state,
            "thread-1",
            Arc::new(client),
            Arc::new(Mutex::new(None)),
            notifs,
            rig::spawn_sleeper(),
            "codex-projection-batch-fence",
        )
        .await;
        let projection = {
            let sessions = state.sessions.lock().await;
            let session = sessions.get("thread-1").unwrap();
            session.consumer.abort();
            session.projection.clone()
        };
        // The consumer's owned batching state is seeded directly so a timer
        // cannot accidentally flush the regression before the read captures it.
        {
            let mut p = projection.lock().unwrap();
            started(&mut p, "t");
            item(
                &mut p,
                "t",
                json!({"type":"agentMessage","id":"answer","text":""}),
                false,
            );
            let ops = delta(&mut p, "t", "Hel");
            p.enqueue(ops);
        }
        let reader = state.clone();
        let snapshot = tokio::spawn(async move { reader.get_snapshot("thread-1", None).await });
        let init = peer.expect_request().await;
        assert_eq!(init.1, "initialize");
        peer.respond(&init.0,json!({"userAgent":"fixture","codexHome":"/fixture","platformFamily":"unix","platformOs":"linux"}));
        peer.expect_notification().await;
        let request = peer.expect_request().await;
        assert_eq!(request.1, "thread/read");
        {
            let mut p = projection.lock().unwrap();
            let ops = delta(&mut p, "t", "lo");
            p.enqueue(ops);
        }
        peer.respond(
            &request.0,
            history(json!([{"id":"t","status":"inProgress","itemsView":"full","items":[]}])),
        );
        let view = snapshot.await.unwrap().unwrap();
        assert_eq!(view["turns"][0]["items"][0]["text"], "Hel");
        let pending = projection.lock().unwrap().take_patch().unwrap();
        assert_eq!(
            pending["ops"][0]["text"], "lo",
            "the captured Hel must not be appended again by a coalesced Hello"
        );
        let published: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(published["event"]["ops"][0]["text"], "Hel");
        drop(peer);
        state.shutdown().await;
    }

    #[test]
    fn missing_older_output_stays_before_a_later_native_turn_after_its_payload_is_released() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "older");
        item(
            &mut p,
            "older",
            json!({"id":"a","type":"agentMessage","text":"older unsaved"}),
            true,
        );
        ended(&mut p, "older", "completed");
        started(&mut p, "later");
        item(
            &mut p,
            "later",
            json!({"id":"b","type":"agentMessage","text":"later saved"}),
            true,
        );
        ended(&mut p, "later", "completed");
        let native = json!([{"id":"later","status":"completed","itemsView":"full","items":[{"id":"b","type":"agentMessage","text":"later saved"}]}]);
        for _ in 0..4 {
            let view = snapshot(&mut p, native.clone());
            let ids: Vec<_> = view.raw["thread"]["turns"]
                .as_array()
                .unwrap()
                .iter()
                .map(|turn| turn["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, vec!["older", "later"]);
        }
    }

    #[test]
    fn native_text_delta_then_full_item_is_one_exact_item() {
        let mut p = CodexProjection::new("runtime-1".into(), "thread-1".into());
        p.apply("item/started", &json!({"threadId":"thread-1","turnId":"turn-1", "item":{"type":"agentMessage","id":"answer-1","text":""}})).unwrap();
        let ops = p
            .apply(
                "item/agentMessage/delta",
                &json!({"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"Hel"}),
            )
            .unwrap();
        assert!(ops.iter().any(|op| op["text"] == "Hel"));
        p.apply(
            "item/agentMessage/delta",
            &json!({"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"lo"}),
        )
        .unwrap();
        p.apply("item/completed", &json!({"threadId":"thread-1","turnId":"turn-1", "item":{"type":"agentMessage","id":"answer-1","text":"Hello"}})).unwrap();
        let rows = p.snapshot_rows("turn-1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["items"],
            json!([{"id":"answer-1","kind":"text","text":"Hello"}])
        );
        assert!(p
            .apply(
                "item/agentMessage/delta",
                &json!({"threadId":"other","turnId":"turn-1","itemId":"answer-1","delta":"leak"})
            )
            .unwrap()
            .is_empty());
    }

    #[test]
    fn actual_0164_captures_converge_legacy_duplicates_tool_outcomes_and_bounded_native_results() {
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/fresh-agent/codex/native-projection-0.164.json"
        ))
        .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let native = &case["read"];
            let thread = native["thread"]["id"].as_str().unwrap();
            let mut p = CodexProjection::new("actual-capture".into(), thread.into());
            for notification in case["notifications"].as_array().unwrap() {
                p.apply(
                    notification["method"].as_str().unwrap(),
                    &notification["params"],
                )
                .unwrap();
            }
            let saved = p
                .accept_native_history(native, &p.begin_history_read())
                .unwrap();
            if case["scenario"] == "approval-policy-restricted-exec" {
                // The first PTY finishes after its turn and is persisted after
                // the answer. A later running PTY is absent from full native
                // persistence. Keep that omitted body as finite retained data.
                p.accept_native_history(native, &p.begin_history_read())
                    .unwrap();
                let finite = p
                    .accept_native_history(native, &p.begin_history_read())
                    .unwrap();
                let turns = native["thread"]["turns"].as_array().unwrap();
                for index in [0, 1, 3] {
                    assert_eq!(finite.raw["thread"]["turns"][index], turns[index]);
                }
                let omitted = &turns[2];
                let state = &finite.metadata["turnOutputStates"][omitted["id"].as_str().unwrap()];
                assert_eq!(state["diagnostic"], "unsaved");
                assert_eq!(state["refreshPending"], false);
                assert_eq!(
                    state["savedTurns"],
                    json!(super::super::build_codex_turn_json(omitted, 0).unwrap())
                );
                assert!(finite.raw["thread"]["turns"][2]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["type"] == "commandExecution"));
                assert_eq!(
                    finite.metadata["nativeFinalTurnIds"]
                        .as_array()
                        .unwrap()
                        .len(),
                    3
                );
                continue;
            }
            if case["scenario"] == "mcp-form-url" && case["parameters"]["historyMode"] == "legacy" {
                // This actual Legacy read omits the command altogether while
                // preserving the full MCP result. It cannot agree with the
                // richer event turn. Retain it with its exact saved view and
                // settle finitely, rather than inventing truncation/equality.
                p.accept_native_history(native, &p.begin_history_read())
                    .unwrap();
                let finite = p
                    .accept_native_history(native, &p.begin_history_read())
                    .unwrap();
                let turn = &native["thread"]["turns"][0];
                let state = &finite.metadata["turnOutputStates"][turn["id"].as_str().unwrap()];
                assert_eq!(state["diagnostic"], "unsaved");
                assert_eq!(state["refreshPending"], false);
                assert!(
                    state["savedTurns"]
                        == json!(super::super::build_codex_turn_json(turn, 0).unwrap()),
                    "the native saved representation is preserved exactly"
                );
                assert!(
                    finite.raw["thread"]["turns"][0]["items"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["type"] == "commandExecution"),
                    "richer retained command output remains available"
                );
                continue;
            }
            assert!(
                saved.raw["thread"]["turns"] == native["thread"]["turns"],
                "actual saved representation: {}",
                case["scenario"]
            );
            assert_eq!(
                saved.metadata["nativeFinalTurnIds"]
                    .as_array()
                    .unwrap()
                    .len(),
                native["thread"]["turns"].as_array().unwrap().len(),
                "all captured terminal native groups are final: {}",
                case["scenario"]
            );
            if case["parameters"]["largeOutput"] == true {
                let states = saved.metadata["turnOutputStates"].as_object().unwrap();
                assert!(states
                    .values()
                    .any(|state| state["diagnostic"] == "provider-truncated"
                        && state["refreshPending"] == false
                        && state["retainedTurns"].is_array()));
            }
        }
    }
}

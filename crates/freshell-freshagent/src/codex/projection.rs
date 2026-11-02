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
    // A non-retry diagnostic is provisional until the same turn fails.
    pending_provider_error: Option<Value>,
    // A lifecycle-lost turn may receive a more precise final completion.
    lifecycle_pending_completion: bool,
    row_by_item: HashMap<String, String>,
    completed_items: HashSet<String>,
    // Recovery reads can supply display context, never an append baseline.
    read_only_items: HashSet<String>,
    // A completed native read can overtake admission; its items must not be
    // replaced by an older item/started boundary.
    terminal_read_only_items: HashSet<String>,
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
        // Lifecycle notifications establish status, not an empty body. When
        // no item was observed, the caller's full terminal native read owns
        // the body; there is no event content whose equality it must prove.
        if self.raw["items"].as_array().is_some_and(Vec::is_empty) {
            return true;
        }
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

#[derive(Clone)]
struct PendingAdmission {
    history_generation: u64,
    owner_epoch: u64,
    owner_generation: u64,
    terminal_from_native: HashSet<String>,
}

#[derive(Clone)]
struct AmbiguousAdmission {
    fence: PendingAdmission,
    previous_error: Option<String>,
    next_sequence: u64,
    turns: HashMap<String, AmbiguousTurnEvidence>,
}

impl AmbiguousAdmission {
    fn latest_error(&self) -> Option<String> {
        self.turns
            .values()
            .filter(|turn| !turn.succeeded && turn.reported_error.is_some())
            .max_by_key(|turn| turn.reported_sequence)
            .and_then(|turn| turn.reported_error.clone())
            .or_else(|| self.previous_error.clone())
    }
}

#[derive(Clone, Default)]
struct AmbiguousTurnEvidence {
    succeeded: bool,
    reported_error: Option<String>,
    reported_sequence: u64,
    completion_had_error: bool,
}

pub(super) enum AmbiguousEventResult {
    Ignore,
    Refresh,
    Warn(String),
}

#[derive(Clone)]
pub(super) struct CodexProjection {
    pub id: String,
    thread_id: String,
    owner_epoch: u64,
    owner_generation: u64,
    pub history_generation: u64,
    revision: u64,
    active_turn: Option<String>,
    pending_admission: Option<PendingAdmission>,
    ambiguous_admission: Option<AmbiguousAdmission>,
    unattributed_provider_error: Option<String>,
    observed_unattributed_provider_error: bool,
    retired: bool,
    live_status: Option<String>,
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
    hosted_naming_facts: Vec<Value>,
    pending_ops: Vec<Value>,
    pending_after_revision: Option<u64>,
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
            pending_admission: None,
            ambiguous_admission: None,
            unattributed_provider_error: None,
            observed_unattributed_provider_error: false,
            retired: false,
            live_status: None,
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
            hosted_naming_facts: vec![],
            pending_ops: vec![],
            pending_after_revision: None,
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
        self.last_native.is_some()
            || !self.turns.is_empty()
            || self.observed_unattributed_provider_error
    }

    pub(super) fn unattributed_provider_error(&self) -> Option<String> {
        self.unattributed_provider_error.clone()
    }

    pub(super) fn pending_provider_error(&self) -> Option<(String, String)> {
        let id = self.active_turn.as_ref()?;
        let turn = self.turns.iter().find(|turn| turn.raw["id"] == *id)?;
        let error = turn.pending_provider_error.as_ref()?;
        let message = super::read_codex_turn_error(&json!({"error":error}))?;
        Some((id.clone(), message))
    }

    pub(super) fn turn_failed(&self, id: &str) -> bool {
        self.turns
            .iter()
            .any(|turn| turn.raw["id"] == id && turn.raw["status"] == "failed")
    }

    /// Only return a diagnostic belonging to this exact failed native turn.
    /// Event-owned output wins; saved history can supply an omitted diagnostic.
    pub(super) fn turn_provider_error(&self, id: &str) -> Option<String> {
        self.turns
            .iter()
            .map(|turn| &turn.raw)
            .chain(
                self.last_native
                    .iter()
                    .flat_map(|native| native["thread"]["turns"].as_array().into_iter().flatten()),
            )
            .filter(|turn| turn["id"] == id && turn["status"] == "failed")
            .filter(|turn| has_provider_error(turn))
            .find_map(super::read_codex_turn_error)
    }

    pub(super) fn restore_unattributed_provider_error(&mut self, message: String) {
        if self.unattributed_provider_error.is_none() {
            self.unattributed_provider_error = Some(message);
            self.observed_unattributed_provider_error = true;
        }
    }

    pub(super) fn patch(&self, ops: Vec<Value>) -> Value {
        let after_revision = ops
            .first()
            .and_then(|op| op["revision"].as_u64())
            .unwrap_or(self.revision)
            .saturating_sub(1);
        json!({"type":"freshAgent.transcript.patch", "sessionId":self.thread_id,
            "projectionId":self.id, "historyGeneration":self.history_generation, "afterRevision":after_revision, "ops":ops})
    }

    pub(super) fn metadata_event(&self) -> Value {
        json!({"type":"freshAgent.session.metadata","sessionId":self.thread_id,"codex":{"projectionId":self.id,"historyGeneration":self.history_generation,"usage":self.usage,"plan":self.plan,"diff":self.diff}})
    }

    pub(super) fn enqueue(&mut self, ops: Vec<Value>) {
        if self.pending_ops.is_empty() {
            self.pending_after_revision = ops
                .first()
                .and_then(|op| op["revision"].as_u64())
                .map(|revision| revision.saturating_sub(1));
        }
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
            let after_revision = self
                .pending_after_revision
                .take()
                .expect("pending patch prefix");
            let mut patch = self.patch(ops);
            patch["afterRevision"] = json!(after_revision);
            Some(patch)
        }
    }

    fn op(&mut self, mut value: Value) -> Value {
        // Revisions are consumed-notification clocks, never native-read watermarks.
        self.revision = self.revision.saturating_add(1).min(9_007_199_254_740_991);
        value["revision"] = json!(self.revision);
        value
    }

    fn open_turn(&mut self, id: &str) -> bool {
        self.open_turn_inner(id, false)
    }

    fn open_turn_inner(&mut self, id: &str, accepted_after_native_read: bool) -> bool {
        if self.removed_turns.contains(id) || self.terminal_turns.contains(id) {
            return false;
        }
        if self.active_turn.as_deref() == Some(id) {
            return true;
        }
        if self.known_turns.contains(id)
            && !self.recoverable_native_turn(id)
            && !accepted_after_native_read
        {
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
                .find(|turn| {
                    turn["id"] == id
                        && (turn["status"] == "inProgress" || accepted_after_native_read)
                })
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
        let read_only_items: HashSet<String> = items
            .iter()
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect();
        let terminal_read_only_items = if accepted_after_native_read {
            read_only_items.clone()
        } else {
            HashSet::new()
        };
        self.turns.push(EventTurn {
            raw: json!({"id":id,"status":"inProgress","items":items}),
            pending_provider_error: None,
            lifecycle_pending_completion: false,
            row_by_item: HashMap::new(),
            completed_items: HashSet::new(),
            read_only_items,
            terminal_read_only_items,
            emitted: false,
            terminal: false,
            save_reads: 0,
            allow_missing_membership: true,
        });
        true
    }

    /// Capture native terminal IDs first observed while this send is in
    /// flight, without copying the complete historical membership set.
    pub(super) fn begin_accepted_send(&mut self) {
        self.ambiguous_admission = None;
        self.pending_admission = Some(PendingAdmission {
            history_generation: self.history_generation,
            owner_epoch: self.owner_epoch,
            owner_generation: self.owner_generation,
            terminal_from_native: HashSet::new(),
        });
    }

    pub(super) fn cancel_accepted_send(&mut self) {
        self.pending_admission = None;
    }

    pub(super) fn retain_ambiguous_send(&mut self) {
        let previous_error = self.unattributed_provider_error.clone();
        self.ambiguous_admission = self
            .pending_admission
            .take()
            .map(|fence| AmbiguousAdmission {
                fence,
                previous_error,
                next_sequence: 0,
                turns: HashMap::new(),
            });
    }

    fn eligible_ambiguous_turn(&self, id: &str) -> bool {
        let Some(admission) = &self.ambiguous_admission else {
            return false;
        };
        let fence = &admission.fence;
        fence.history_generation == self.history_generation
            && (fence.owner_epoch == 0
                || (fence.owner_epoch == self.owner_epoch
                    && fence.owner_generation == self.owner_generation))
            && !self.removed_turns.contains(id)
            && (!self.known_turns.contains(id) || fence.terminal_from_native.contains(id))
            && (admission.turns.contains_key(id) || admission.turns.len() < 32)
    }

    /// A failed completion without an accepted turn ID is evidence of a
    /// provider diagnostic, not evidence that the uncertain input was
    /// delivered. Keep it session-scoped and never settle the dispatch.
    pub(super) fn ambiguous_completion(&mut self, params: &Value) -> Option<AmbiguousEventResult> {
        self.ambiguous_admission.as_ref()?;
        if self.retired || params["threadId"].as_str() != Some(self.thread_id.as_str()) {
            return Some(AmbiguousEventResult::Ignore);
        }
        let id = params["turn"]["id"]
            .as_str()
            .or_else(|| params["turnId"].as_str());
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return Some(AmbiguousEventResult::Ignore);
        };
        if self.active_turn.as_deref() == Some(id) {
            return None;
        }
        if !self.eligible_ambiguous_turn(id) {
            return Some(AmbiguousEventResult::Ignore);
        }
        let explicit = has_provider_error(&params["turn"]);
        let explicit_message = explicit
            .then(|| super::read_codex_turn_error(&params["turn"]))
            .flatten();
        let admission = self
            .ambiguous_admission
            .as_mut()
            .expect("ambiguous admission");
        let turn = admission.turns.entry(id.to_owned()).or_default();
        if params["turn"]["status"] == "completed" {
            turn.succeeded = true;
            let latest = admission.latest_error();
            if latest != self.unattributed_provider_error {
                self.unattributed_provider_error = latest;
                return Some(AmbiguousEventResult::Refresh);
            }
            return Some(AmbiguousEventResult::Ignore);
        }
        if params["turn"]["status"] != "failed" || turn.succeeded {
            return Some(AmbiguousEventResult::Ignore);
        }
        if explicit {
            turn.completion_had_error = true;
        }
        if let Some(message) =
            explicit_message.filter(|message| turn.reported_error.as_ref() != Some(message))
        {
            turn.reported_error = Some(message.clone());
            admission.next_sequence += 1;
            turn.reported_sequence = admission.next_sequence;
            self.unattributed_provider_error = Some(message.clone());
            self.observed_unattributed_provider_error = true;
            return Some(AmbiguousEventResult::Warn(message));
        }
        Some(AmbiguousEventResult::Ignore)
    }

    /// A non-retry provider diagnostic can arrive without a completion.
    /// Retain it as a session warning without treating the unidentified
    /// operation as the accepted input.
    pub(super) fn ambiguous_error(&mut self, params: &Value) -> Option<AmbiguousEventResult> {
        self.ambiguous_admission.as_ref()?;
        if params["willRetry"] == true {
            return None;
        }
        if self.retired || params["threadId"].as_str() != Some(self.thread_id.as_str()) {
            return Some(AmbiguousEventResult::Ignore);
        }
        let Some(id) = params["turnId"].as_str().filter(|id| !id.is_empty()) else {
            // An untagged provider error cannot be correlated, but its
            // ordinary session notice is still useful.
            return None;
        };
        if self.active_turn.as_deref() == Some(id) {
            return None;
        }
        if !self.eligible_ambiguous_turn(id) {
            return Some(AmbiguousEventResult::Ignore);
        }
        if !has_provider_error(&json!({"error":params["error"]})) {
            return None;
        }
        let message = super::read_codex_turn_error(&json!({"error":params["error"]}))?;
        let admission = self
            .ambiguous_admission
            .as_mut()
            .expect("ambiguous admission");
        let turn = admission.turns.entry(id.to_owned()).or_default();
        if turn.succeeded || turn.completion_had_error {
            return Some(AmbiguousEventResult::Ignore);
        }
        if turn.reported_error.as_ref() == Some(&message) {
            return Some(AmbiguousEventResult::Ignore);
        }
        turn.reported_error = Some(message.clone());
        admission.next_sequence += 1;
        turn.reported_sequence = admission.next_sequence;
        self.unattributed_provider_error = Some(message.clone());
        self.observed_unattributed_provider_error = true;
        Some(AmbiguousEventResult::Warn(message))
    }

    /// The provider's accepted turn/start response is native evidence for
    /// this exact turn, even if its turn/started notification was missed.
    /// Existing terminal, removed, and source-retirement fences still apply.
    pub(super) fn observe_accepted_turn(&mut self, id: &str) -> bool {
        let Some(admission) = self.pending_admission.take() else {
            return false;
        };
        if self.retired
            || id.is_empty()
            || self.removed_turns.contains(id)
            || admission.history_generation != self.history_generation
            || (admission.owner_epoch != 0
                && (admission.owner_epoch != self.owner_epoch
                    || admission.owner_generation != self.owner_generation))
        {
            return false;
        }
        let read_ahead = admission.terminal_from_native.contains(id);
        if read_ahead {
            self.terminal_turns.remove(id);
        }
        if self.open_turn_inner(id, read_ahead) {
            self.unattributed_provider_error = None;
            return true;
        }
        false
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

    pub(super) fn observe_status(&mut self, status: &str) {
        if !self.retired {
            self.live_status = Some(status.to_owned());
        }
    }

    pub(super) fn live_status(&self) -> Option<&str> {
        self.live_status.as_deref()
    }

    /// A new source can disclose the prior source's finite evidence. It never
    /// inherits pending operations, revision baselines, or append authority.
    pub(super) fn inherit_finite_history(&mut self, prior: &Self) {
        if self.thread_id != prior.thread_id {
            return;
        }
        let mut finite = prior.clone();
        finite.freeze_active("interrupted");
        for turn in &mut finite.turns {
            // A new source cannot interpret buffered notifications from the
            // previous source as authority to correct its frozen history.
            turn.lifecycle_pending_completion = false;
            if !turn.terminal {
                turn.raw["status"] = json!("interrupted");
            }
            turn.terminal = true;
            turn.save_reads = MAX_SAVE_READS;
            if let Some(id) = turn.raw["id"].as_str() {
                finite.terminal_turns.insert(id.to_owned());
            }
        }
        finite.trim_frozen();
        self.turns = finite.turns;
        self.known_turns = finite.known_turns;
        self.turn_order = finite.turn_order;
        self.terminal_turns = finite.terminal_turns;
        self.unattributed_provider_error = finite.unattributed_provider_error;
        self.observed_unattributed_provider_error = finite.observed_unattributed_provider_error;
        self.removed_turns = finite.removed_turns;
        self.last_native = finite.last_native;
        self.history_generation = finite.history_generation;
        self.usage = finite.usage;
        self.plan = finite.plan;
        self.diff = finite.diff;
        self.live_status = Some("idle".into());
    }

    pub(super) fn source_retired(&self) -> bool {
        self.retired
    }

    pub(super) fn retire_source(&mut self) {
        self.lifecycle_loss();
        self.ambiguous_admission = None;
        self.retired = true;
        self.live_status = Some("exited".into());
    }

    /// A native runtime died or closed its thread. A prior non-retry provider
    /// diagnostic belongs to the active turn's failure, even when Codex never
    /// sends that turn's completion notification. Other exits keep the usual
    /// interrupted projection.
    pub(super) fn lifecycle_loss(&mut self) -> bool {
        let Some(id) = self.active_turn.clone() else {
            self.freeze_active("interrupted");
            return false;
        };
        let has_diagnostic = self
            .turns
            .iter()
            .any(|turn| turn.raw["id"] == id && turn.pending_provider_error.is_some());
        if has_diagnostic {
            let completion =
                json!({"threadId":&self.thread_id,"turn":{"id":&id,"status":"failed"}});
            match self.apply("turn/completed", &completion) {
                Ok(ops) if !ops.is_empty() => {
                    if let Some(turn) = self.turns.iter_mut().find(|turn| turn.raw["id"] == id) {
                        turn.lifecycle_pending_completion = true;
                    }
                    self.enqueue(ops);
                    return true;
                }
                Ok(_) => {}
                Err(error) => tracing::warn!(provider="codex", session_id=%self.thread_id,
                    projection_id=%self.id, method=%error.method, native_turn_id=?error.turn_id,
                    reason=error.reason, "freshagent.codex.lifecycle_projection_refused"),
            }
        }
        if let Some(turn) = self.turns.iter_mut().find(|turn| turn.raw["id"] == id) {
            turn.lifecycle_pending_completion = true;
        }
        self.freeze_active("interrupted");
        false
    }

    fn correct_lifecycle_error(
        &mut self,
        id: &str,
        provider_error: &Value,
        final_completion: bool,
    ) -> Result<Vec<Value>, ProjectionError> {
        let useful_error = has_provider_error(&json!({"error":provider_error}));
        if self.removed_turns.contains(id) || (!final_completion && !useful_error) {
            return Ok(vec![]);
        }
        let Some(turn) = self.turns.iter_mut().find(|turn| {
            turn.raw["id"] == id && turn.terminal && turn.lifecycle_pending_completion
        }) else {
            return Ok(vec![]);
        };
        // Blank completion details must not replace a useful diagnostic.
        // Keep the turn eligible for later detail when none was supplied.
        if !useful_error && has_provider_error(&turn.raw) {
            return Ok(vec![]);
        }
        let next_error = json!({"status":"failed","error":provider_error});
        if super::read_codex_turn_error(&turn.raw) == super::read_codex_turn_error(&next_error) {
            if final_completion && useful_error {
                turn.lifecycle_pending_completion = false;
            }
            return Ok(vec![]);
        }
        turn.raw["status"] = json!("failed");
        turn.raw["error"] = provider_error.clone();
        let rows = super::build_codex_turn_json(&turn.raw, 0).map_err(|_| ProjectionError {
            method: "lifecycle/correction".into(),
            turn_id: Some(id.to_owned()),
            item_id: None,
            reason: "unmappable lifecycle failure correction",
        })?;
        if final_completion && useful_error {
            turn.lifecycle_pending_completion = false;
        }
        let completed_items = turn.completed_items.clone();
        let nonappendable = turn.nonappendable_ids();
        Ok(vec![self.op(
            json!({"op":"resetTurn","nativeTurnId":id,"turns":rows,
            "completedItemIds":completed_items,"nonAppendableItemIds":nonappendable,
            "correctSettled":true}),
        )])
    }

    pub(super) fn freeze_active(&mut self, status: &str) {
        if let Some(id) = self.active_turn.take() {
            self.terminal_turns.insert(id.clone());
            if let Some(admission) = &mut self.pending_admission {
                admission.terminal_from_native.remove(&id);
            }
            if let Some(turn) = self.turns.iter_mut().find(|t| t.raw["id"] == id) {
                turn.terminal = true;
                turn.raw["status"] = json!(status);
                turn.pending_provider_error = None;
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
            turn.lifecycle_pending_completion = false;
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
        let mut resets: Vec<Value> = self
            .turns
            .iter()
            .filter_map(|turn| {
                let rows = super::build_codex_turn_json(&turn.raw, 0).unwrap_or_default();
                (!rows.is_empty()).then(|| {
                    json!({"op":"resetTurn","nativeTurnId":turn.raw["id"],
                    "turns":rows,"completedItemIds":turn.completed_items,
                    "nonAppendableItemIds":turn.nonappendable_ids()})
                })
            })
            .collect();
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
        if self.retired {
            return Ok(vec![]);
        }
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
        if method == "error" {
            if params["willRetry"] == true {
                return Ok(vec![]);
            }
            let (Some(id), Some(provider_error)) = (turn_id, params.get("error")) else {
                return Ok(vec![]);
            };
            let useful_error = has_provider_error(&json!({"error":provider_error}));
            if useful_error
                && self.active_turn.is_none()
                && self.ambiguous_admission.is_none()
                && (self.known_turns.is_empty() || self.recoverable_native_turn(id))
            {
                self.open_turn(id);
            }
            if useful_error && self.active_turn.as_deref() == Some(id) {
                if let Some(turn) = self.turns.iter_mut().find(|turn| turn.raw["id"] == id) {
                    turn.pending_provider_error = Some(provider_error.clone());
                }
            } else if useful_error {
                return self.correct_lifecycle_error(id, provider_error, false);
            }
            return Ok(vec![]);
        }
        if method == "turn/started" {
            let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
            self.open_turn(id);
            return Ok(vec![]);
        }
        if method == "turn/completed" {
            let id = turn_id.ok_or_else(|| error("missing native turn id"))?;
            if self.active_turn.is_none()
                && self.ambiguous_admission.is_none()
                && (self.known_turns.is_empty() || self.recoverable_native_turn(id))
            {
                self.open_turn(id);
            }
            if self.active_turn.as_deref() != Some(id) {
                let status = params["turn"]["status"]
                    .as_str()
                    .or_else(|| params["status"].as_str());
                if status == Some("failed") {
                    let provider_error = params["turn"].get("error").unwrap_or(&Value::Null);
                    return self.correct_lifecycle_error(id, provider_error, true);
                }
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
            if status == "failed" && !has_provider_error(&turn.raw) {
                if let Some(provider_error) = turn.pending_provider_error.take() {
                    turn.raw["error"] = provider_error;
                }
            }
            // A completion can be the only event carrying the provider's
            // error. Publish its complete display rows before the terminal
            // fence so connected clients show the failure immediately,
            // including turns that never emitted an item.
            let reset = if status == "failed"
                || turn.raw.get("error").is_some_and(|error| !error.is_null())
            {
                Some((
                    super::build_codex_turn_json(&turn.raw, 0)
                        .map_err(|_| error("unmappable native turn failure"))?,
                    turn.completed_items.clone(),
                    turn.nonappendable_ids(),
                ))
            } else {
                None
            };
            self.freeze_active(status);
            let mut ops = Vec::with_capacity(2);
            if let Some((rows, completed_items, nonappendable)) = reset {
                ops.push(
                    self.op(json!({"op":"resetTurn","nativeTurnId":id,"turns":rows,
                    "completedItemIds":completed_items,"nonAppendableItemIds":nonappendable,
                    "correctSettled":true})),
                );
            }
            ops.push(self.op(json!({"op":"settleTurn","nativeTurnId":id,"status":status})));
            return Ok(ops);
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
            && self.ambiguous_admission.is_none()
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
        if method == "item/started"
            && self.turns[turn_index]
                .terminal_read_only_items
                .contains(item_id)
        {
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
            self.turns[turn_index]
                .terminal_read_only_items
                .remove(item_id);
            if complete {
                self.turns[turn_index]
                    .completed_items
                    .insert(item_id.to_owned());
            }
            let rows = super::build_codex_turn_json(&self.turns[turn_index].raw, 0)
                .map_err(|_| error("unmappable native item"))?;
            // An unknown native item can leave a live turn without display
            // rows. Empty resets are reserved for explicit history removals,
            // so wait until a visible item or failure arrives instead.
            if rows.is_empty() {
                return Ok(vec![]);
            }
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
        // A native read can overtake the first event for a turn previously
        // seen in progress. Preserve that exact preview before replacing it
        // with terminal history so its later notification still has an owner.
        if self.active_turn.is_none() && self.revision == fence.event_revision {
            let read_ahead = raw["thread"]["turns"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|turn| {
                    matches!(
                        turn["status"].as_str(),
                        Some("completed" | "failed" | "interrupted")
                    ) && turn["id"]
                        .as_str()
                        .is_some_and(|id| self.recoverable_native_turn(id))
                })
                .and_then(|turn| turn["id"].as_str().map(str::to_owned));
            if let Some(id) = read_ahead {
                self.open_turn(&id);
            }
        }
        self.last_native = Some(raw.clone());
        self.build_snapshot(raw, fence, false)
    }

    /// Clone the current projection so recovery never advances native-read
    /// settlement counters or changes the append baseline.
    pub(super) fn retained_snapshot(
        &self,
        unavailable: bool,
    ) -> Result<ProjectionSnapshot, SnapshotStale> {
        let mut retained = self.clone();
        let raw = self.last_native.clone().unwrap_or_else(
            || json!({"thread":{"id":self.thread_id,"status":{"type":"idle"},"turns":[]}}),
        );
        retained.build_snapshot(
            &raw,
            &self.begin_history_read(),
            unavailable || self.retired,
        )
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
            if terminal && self.terminal_turns.insert(id.to_owned()) {
                if let Some(admission) = &mut self.pending_admission {
                    admission.terminal_from_native.insert(id.to_owned());
                }
            }
            if let Some(event) = owned.get(id) {
                let mut event = (*event).clone();
                event.refresh_read_only(native);
                // A full native read can acquire the provider's diagnostic
                // before its completion notification arrives. Keep the live
                // item bodies and make that diagnostic visible on the same
                // lifecycle-frozen turn, even if their saved bodies differ.
                let recovered_error = event.lifecycle_pending_completion
                    && terminal
                    && full
                    && !has_provider_error(&event.raw)
                    && has_provider_error(native);
                if recovered_error {
                    event.raw["status"] = json!("failed");
                    event.raw["error"] = native["error"].clone();
                }
                if let Some(current) = self.turns.iter_mut().find(|turn| turn.raw["id"] == id) {
                    // An item boundary during the RPC may already have claimed
                    // a field. Refresh only fields that remain read-only now.
                    current.refresh_read_only(native);
                    if recovered_error
                        && self.revision == fence.event_revision
                        && current.lifecycle_pending_completion
                        && !has_provider_error(&current.raw)
                    {
                        current.raw["status"] = json!("failed");
                        current.raw["error"] = native["error"].clone();
                    }
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
                    // A native read may lag the completion event even after it
                    // reports a terminal state. Never let that older outcome
                    // erase the failure we have already observed.
                    if preserves_observed_outcome(&event.raw, native)
                        && (equal || interrupted || truncated || finalized_unobserved)
                    {
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
                            && !event.lifecycle_pending_completion
                            && self.active_turn.as_deref() != Some(id)
                            && self.revision == fence.event_revision
                        {
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
        if let Some(message) = &self.unattributed_provider_error {
            snapshot["extensions"]["codex"]["unattributedProviderError"] = json!(message);
        }
        if let Some((turn_id, message)) = self.pending_provider_error() {
            snapshot["extensions"]["codex"]["pendingProviderError"] =
                json!({"turnId":turn_id,"message":message});
        }
        if !self.hosted_naming_facts.is_empty() {
            snapshot["extensions"]["codex"]["hostedNamingFacts"] = json!(self.hosted_naming_facts);
        }
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

    /// Retain the first accepted naming input and latest verified transition
    /// with this source, so a dropped final event can reconcile without a token.
    pub(super) fn retain_hosted_naming_fact(&mut self, fact: Value) -> bool {
        if self.retired {
            return false;
        }
        if let Some(existing) = self
            .hosted_naming_facts
            .iter_mut()
            .find(|old| old["kind"] == fact["kind"])
        {
            if fact["kind"] != "activity" {
                *existing = fact;
            }
        } else {
            self.hosted_naming_facts.push(fact);
        }
        true
    }

    pub(super) fn has_hosted_naming_proof(&self) -> bool {
        self.hosted_naming_facts
            .iter()
            .any(|fact| matches!(fact["kind"].as_str(), Some("transition" | "acquisition")))
    }

    pub(super) fn hosted_naming_activity(&self) -> Option<Value> {
        self.hosted_naming_facts
            .iter()
            .find(|fact| fact["kind"] == "activity")
            .cloned()
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

// Failed completions without provider details get a generic display error.
// Once a nonblank provider message has arrived, however, it must survive
// stale reads. Recognize the same string and object shapes as the shared
// Codex normalizer while allowing a blank error to be upgraded later.
fn has_provider_error(turn: &Value) -> bool {
    let Some(error) = turn.get("error").filter(|error| !error.is_null()) else {
        return false;
    };
    if error.as_object().is_some_and(|object| object.is_empty()) {
        return false;
    }
    let message = error.as_str().or_else(|| {
        error
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| error.get("error").and_then(Value::as_str))
    });
    message.is_none_or(|message| !message.trim().is_empty())
}

fn preserves_observed_outcome(event: &Value, native: &Value) -> bool {
    if event["status"] == "failed" && native["status"] != "failed" {
        return false;
    }
    !has_provider_error(event)
        || super::read_codex_turn_error(event) == super::read_codex_turn_error(native)
}

// Compare the complete ordered display representation, preserving roles,
// duplicate bodies, tool outcomes and errors. Legacy reconstructs item-N ids;
// only that evidenced presentation difference is normalized.
fn equivalent_turns(event: &Value, native: &Value, legacy: bool) -> bool {
    let allow_error_upgrade = event["status"] == "failed"
        && native["status"] == "failed"
        && !has_provider_error(event)
        && has_provider_error(native);
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
        if event["role"] != native["role"]
            || (event["error"] != native["error"] && !allow_error_upgrade)
        {
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

    fn failed(p: &mut CodexProjection, id: &str, message: &str) -> Vec<Value> {
        p.apply(
            "turn/completed",
            &json!({"threadId":"thread-1","turn":{
                "id":id,"status":"failed","itemsView":"summary","items":[],
                "error":{"message":message,"codexErrorInfo":"serverOverloaded"}
            }}),
        )
        .unwrap()
    }

    #[test]
    fn failure_completion_publishes_error_immediately_before_settlement() {
        let message = "Selected model is at capacity. Please try a different model.";
        for with_item in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            if with_item {
                item(
                    &mut p,
                    "t",
                    json!({"type":"agentMessage","id":"answer","text":"Partial answer"}),
                    true,
                );
            }

            let ops = failed(&mut p, "t", message);
            assert_eq!(
                ops.len(),
                2,
                "failure must publish its rows and settle: {ops:?}"
            );
            assert_eq!(ops[0]["op"], "resetTurn");
            assert_eq!(ops[0]["correctSettled"], true);
            assert_eq!(ops[1]["op"], "settleTurn");
            assert_eq!(ops[1]["status"], "failed");
            assert!(ops[0]["revision"].as_u64() < ops[1]["revision"].as_u64());
            let rows = ops[0]["turns"].as_array().unwrap();
            assert_eq!(rows.last().unwrap()["error"]["message"], message);
            if with_item {
                assert_eq!(rows[0]["items"][0]["text"], "Partial answer");
            }
            assert!(delta(&mut p, "t", "late output").is_empty());
        }

        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "missing-error");
        let ops = p.apply("turn/completed", &json!({"threadId":"thread-1","turn":{"id":"missing-error","status":"failed","error":null}})).unwrap();
        assert_eq!(ops[0]["op"], "resetTurn");
        assert_eq!(ops[0]["correctSettled"], true);
        assert!(ops[0]["turns"][0]["error"]["message"]
            .as_str()
            .is_some_and(|message| !message.trim().is_empty()));
        assert_eq!(ops[1]["op"], "settleTurn");

        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "error-with-completed-status");
        let ops = p.apply("turn/completed", &json!({"threadId":"thread-1","turn":{
            "id":"error-with-completed-status","status":"completed","error":{"message":message}
        }})).unwrap();
        assert_eq!(ops[0]["op"], "resetTurn");
        assert_eq!(ops[0]["correctSettled"], true);
        assert_eq!(ops[0]["turns"][0]["error"]["message"], message);
        assert_eq!(ops[1]["op"], "settleTurn");
    }

    #[test]
    fn failure_unsupported_first_item_never_deletes_its_live_turn() {
        for with_known_item in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            let unknown = json!({"type":"futureNativeItem","id":"unknown"});
            assert!(item(&mut p, "t", unknown.clone(), false).is_empty());
            assert!(item(&mut p, "t", unknown, true).is_empty());
            if with_known_item {
                let ops = item(
                    &mut p,
                    "t",
                    json!({"type":"agentMessage","id":"answer","text":"partial output"}),
                    true,
                );
                assert_eq!(ops[0]["op"], "resetTurn");
                assert_eq!(ops[0]["turns"][0]["items"][0]["text"], "partial output");
            }
            let ops = failed(&mut p, "t", "provider failure");
            assert_eq!(ops[0]["correctSettled"], true);
            assert_eq!(
                ops[0]["turns"].as_array().unwrap().last().unwrap()["error"]["message"],
                "provider failure"
            );
        }
    }

    #[test]
    fn failure_empty_retained_turn_is_not_mistaken_for_history_removal() {
        let mut retained = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut retained, "t");
        item(
            &mut retained,
            "t",
            json!({"type":"futureNativeItem","id":"unknown"}),
            true,
        );
        assert!(retained.invalidate_history(&[]).is_empty());
        let ops = failed(&mut retained, "t", "provider failure");
        assert_eq!(ops[0]["turns"][0]["error"]["message"], "provider failure");

        let mut removed = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut removed, "t");
        item(
            &mut removed,
            "t",
            json!({"type":"futureNativeItem","id":"unknown"}),
            true,
        );
        let ops = removed.invalidate_history(&["t".into()]);
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["op"], "resetTurn");
        assert_eq!(ops[0]["nativeTurnId"], "t");
        assert_eq!(ops[0]["turns"], json!([]));
        assert!(failed(&mut removed, "t", "stale failure").is_empty());
    }

    #[test]
    fn failure_retains_event_error_until_the_native_history_agrees() {
        let message = "Selected model is at capacity. Please try a different model.";
        for with_item in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            let items = if with_item {
                let input = json!({"type":"userMessage","id":"user","content":[{"type":"text","text":"go"}]});
                item(&mut p, "t", input.clone(), true);
                vec![input]
            } else {
                vec![]
            };
            failed(&mut p, "t", message);

            for saved_error in [Value::Null, json!({"message":"an older failure"})] {
                let stale = snapshot(
                    &mut p,
                    json!([{"id":"t","status":"failed","itemsView":"full","items":items,"error":saved_error}]),
                );
                assert_eq!(stale.metadata["eventOwnedTurnIds"], json!(["t"]));
                assert_eq!(stale.raw["thread"]["turns"][0]["error"]["message"], message);
            }

            let saved_error = if with_item {
                json!(message)
            } else {
                json!({"message":message})
            };
            let matching = snapshot(
                &mut p,
                json!([{"id":"t","status":"failed","itemsView":"full","items":items,"error":saved_error}]),
            );
            assert_eq!(matching.metadata["nativeFinalTurnIds"], json!(["t"]));
            assert_eq!(
                super::super::read_codex_turn_error(&matching.raw["thread"]["turns"][0]).as_deref(),
                Some(message)
            );
        }
    }

    #[test]
    fn failure_is_not_hidden_by_stale_interrupted_or_truncated_history() {
        let message = "Selected model is at capacity. Please try a different model.";
        for interrupted in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            let command = json!({"type":"commandExecution","id":"cmd","command":"pwd","status":"completed","aggregatedOutput":"original output"});
            item(&mut p, "t", command.clone(), true);
            failed(&mut p, "t", message);
            let mut saved_command = command;
            if !interrupted {
                saved_command["aggregatedOutput"] =
                    json!("... command output truncated for persistence ...");
            }
            let status = if interrupted { "interrupted" } else { "failed" };
            let stale = snapshot(
                &mut p,
                json!([{"id":"t","status":status,"itemsView":"full","items":[saved_command]}]),
            );
            assert_eq!(stale.metadata["eventOwnedTurnIds"], json!(["t"]));
            assert_eq!(stale.raw["thread"]["turns"][0]["error"]["message"], message);
        }
    }

    #[test]
    fn failure_without_detail_survives_a_stale_success_and_accepts_saved_detail() {
        for with_item in [false, true] {
            for error in [Value::Null, json!(""), json!({"message":"   "}), json!({})] {
                let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
                started(&mut p, "t");
                let items = if with_item {
                    let answer =
                        json!({"type":"agentMessage","id":"answer","text":"partial output"});
                    item(&mut p, "t", answer.clone(), true);
                    vec![answer]
                } else {
                    vec![]
                };
                p.apply("turn/completed", &json!({"threadId":"thread-1","turn":{"id":"t","status":"failed","error":error}})).unwrap();

                for status in ["completed", "interrupted"] {
                    let stale = snapshot(
                        &mut p,
                        json!([{"id":"t","status":status,"itemsView":"full","items":items}]),
                    );
                    assert_eq!(stale.metadata["eventOwnedTurnIds"], json!(["t"]));
                    assert_eq!(stale.raw["thread"]["turns"][0]["status"], "failed");
                }

                let saved = snapshot(
                    &mut p,
                    json!([{"id":"t","status":"failed","itemsView":"full","items":items,"error":{"message":"provider details"}}]),
                );
                assert_eq!(saved.metadata["nativeFinalTurnIds"], json!(["t"]));
                assert_eq!(
                    saved.raw["thread"]["turns"][0]["error"]["message"],
                    "provider details"
                );
            }
        }
    }

    #[test]
    fn failure_does_not_change_successful_or_retrying_turns() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        assert!(p.apply("error", &json!({"threadId":"thread-1","turnId":"t","willRetry":true,"error":{"message":"temporary"}})).unwrap().is_empty());
        assert_eq!(p.active_turn.as_deref(), Some("t"));
        let ops = p
            .apply(
                "turn/completed",
                &json!({"threadId":"thread-1","turn":{"id":"t","status":"completed","error":null}}),
            )
            .unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["op"], "settleTurn");
        let saved = snapshot(
            &mut p,
            json!([{"id":"t","status":"completed","itemsView":"full","items":[{"type":"agentMessage","id":"answer","text":"Saved answer"}]}]),
        );
        assert_eq!(saved.metadata["nativeFinalTurnIds"], json!(["t"]));
        assert_eq!(
            saved.raw["thread"]["turns"][0]["items"][0]["text"],
            "Saved answer"
        );

        let mut interrupted = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut interrupted, "t");
        interrupted
            .apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
            "error":{"message":"transient diagnostic"}}),
            )
            .unwrap();
        let ops = interrupted
            .apply(
                "turn/completed",
                &json!({"threadId":"thread-1","turn":{
                    "id":"t","status":"interrupted","error":null
                }}),
            )
            .unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["op"], "settleTurn");
        assert!(interrupted.snapshot_rows("t").unwrap().is_empty());
        assert!(failed(&mut interrupted, "t", "late failure").is_empty());
    }

    #[test]
    fn failure_notice_supplies_missing_completion_detail_without_becoming_a_live_error() {
        let message = "Selected model is at capacity. Please try a different model.";
        for error in [Value::Null, json!(""), json!({"message":" "}), json!({})] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            let ops = p
                .apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"t",
                "willRetry":false,"error":{"message":message,"codexErrorInfo":"serverOverloaded"}}),
                )
                .unwrap();
            assert!(ops.is_empty());
            assert!(p.snapshot_rows("t").unwrap().is_empty());
            for notification in [
                json!({"threadId":"thread-1","turnId":"t","willRetry":true,"error":{"message":"retry only"}}),
                json!({"threadId":"thread-1","turnId":"t","willRetry":false,"error":{"message":" "}}),
            ] {
                assert!(p.apply("error", &notification).unwrap().is_empty());
            }

            let ops = p
                .apply(
                    "turn/completed",
                    &json!({"threadId":"thread-1","turn":{
                        "id":"t","status":"failed","error":error
                    }}),
                )
                .unwrap();
            assert_eq!(ops[0]["op"], "resetTurn");
            assert_eq!(ops[0]["turns"][0]["error"]["message"], message);
            assert_eq!(ops[1]["op"], "settleTurn");

            let stale = snapshot(
                &mut p,
                json!([{"id":"t","status":"failed","itemsView":"full","items":[],"error":null}]),
            );
            assert_eq!(stale.metadata["eventOwnedTurnIds"], json!(["t"]));
            assert_eq!(stale.raw["thread"]["turns"][0]["error"]["message"], message);
        }
    }

    #[test]
    fn failure_notice_never_replaces_explicit_completion_detail() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "t");
        p.apply(
            "error",
            &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
            "error":{"message":"earlier diagnostic"}}),
        )
        .unwrap();
        let ops = failed(&mut p, "t", "final provider detail");
        assert_eq!(
            ops[0]["turns"][0]["error"]["message"],
            "final provider detail"
        );
    }

    #[test]
    fn failure_notice_is_scoped_to_a_failed_matching_turn_and_excludes_retries() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "successful");
        p.apply(
            "error",
            &json!({"threadId":"thread-1","turnId":"successful","willRetry":false,
            "error":{"message":"transient diagnostic"}}),
        )
        .unwrap();
        let success = p
            .apply(
                "turn/completed",
                &json!({"threadId":"thread-1","turn":{
                    "id":"successful","status":"completed","error":null
                }}),
            )
            .unwrap();
        assert_eq!(success.len(), 1);
        assert_eq!(success[0]["op"], "settleTurn");
        assert!(p.snapshot_rows("successful").unwrap().is_empty());

        started(&mut p, "failed");
        for notification in [
            json!({"threadId":"thread-1","turnId":"failed","willRetry":true,"error":{"message":"retry message"}}),
            json!({"threadId":"thread-1","turnId":"successful","willRetry":false,"error":{"message":"previous turn"}}),
            json!({"threadId":"other-thread","turnId":"failed","willRetry":false,"error":{"message":"other thread"}}),
            json!({"threadId":"thread-1","willRetry":false,"error":{"message":"unbound turn"}}),
        ] {
            assert!(p.apply("error", &notification).unwrap().is_empty());
        }
        let ops = p
            .apply(
                "turn/completed",
                &json!({"threadId":"thread-1","turn":{
                    "id":"failed","status":"failed","error":null
                }}),
            )
            .unwrap();
        let message = ops[0]["turns"][0]["error"]["message"].as_str().unwrap();
        assert!(!message.is_empty());
        for unrelated in [
            "transient diagnostic",
            "retry message",
            "previous turn",
            "other thread",
            "unbound turn",
        ] {
            assert_ne!(message, unrelated);
        }
    }

    #[test]
    fn failure_lifecycle_notifications_publish_the_active_diagnostic_once() {
        use freshell_codex::CodexNotification;
        let message = "Selected model is at capacity. Please try a different model.";
        for notification in [
            CodexNotification::ThreadStatusChanged {
                thread_id: "thread-1".into(),
                status: json!({"type":"systemError"}),
            },
            CodexNotification::ThreadClosed {
                thread_id: "thread-1".into(),
            },
        ] {
            let projection = Arc::new(Mutex::new(CodexProjection::new(
                "runtime".into(),
                "thread-1".into(),
            )));
            {
                let mut p = projection.lock().unwrap();
                started(&mut p, "old");
                item(
                    &mut p,
                    "old",
                    json!({"type":"agentMessage","id":"partial","text":"Partial output"}),
                    true,
                );
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                    "error":{"message":message}}),
                )
                .unwrap();
            }
            assert!(!super::super::project_codex_notification(
                &projection,
                &CodexNotification::ThreadClosed {
                    thread_id: "foreign".into()
                }
            ));
            assert!(super::super::project_codex_notification(
                &projection,
                &notification
            ));
            let mut p = projection.lock().unwrap();
            let patch = p
                .take_patch()
                .expect("lifecycle failure sends a transcript patch");
            assert_eq!(patch["ops"][0]["op"], "resetTurn");
            assert_eq!(
                patch["ops"][0]["turns"][0]["items"][0]["text"],
                "Partial output"
            );
            assert_eq!(patch["ops"][0]["turns"][1]["error"]["message"], message);
            assert_eq!(patch["ops"][1]["op"], "settleTurn");
            assert_eq!(patch["ops"][1]["status"], "failed");
            assert!(failed(&mut p, "old", message).is_empty());
            started(&mut p, "new");
            assert!(failed(&mut p, "old", message).is_empty());
            assert_eq!(p.active_turn.as_deref(), Some("new"));
            assert!(p.snapshot_rows("new").unwrap().is_empty());
            drop(p);
            // A duplicate lifecycle event sees no pending diagnostic on the
            // new turn and cannot publish the old error a second time.
            assert!(!super::super::project_codex_notification(
                &projection,
                &notification
            ));
            assert!(projection.lock().unwrap().take_patch().is_none());
        }
    }

    #[test]
    fn failure_lifecycle_retry_and_success_do_not_become_failures() {
        use freshell_codex::CodexNotification;
        for successful in [false, true] {
            let projection = Arc::new(Mutex::new(CodexProjection::new(
                "runtime".into(),
                "thread-1".into(),
            )));
            {
                let mut p = projection.lock().unwrap();
                started(&mut p, "t");
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"t","willRetry":!successful,
                    "error":{"message":"diagnostic"}}),
                )
                .unwrap();
                if successful {
                    ended(&mut p, "t", "completed");
                }
            }
            assert!(!super::super::project_codex_notification(
                &projection,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".into(),
                    status: json!({"type":"systemError"}),
                }
            ));
            let mut p = projection.lock().unwrap();
            assert!(p.take_patch().is_none());
            assert!(p.snapshot_rows("t").unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn failure_lifecycle_unrequested_exit_broadcasts_the_owned_diagnostic() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let (state, _) = rig::state_with_bus();
        let mut events = rig::insert_fake_session_with_real_consumer(
            &state,
            "thread-1",
            Arc::new(client),
            Arc::new(Mutex::new(None)),
            notifs,
            rig::spawn_sleeper(),
            "owned-runtime",
        )
        .await;
        let projection = state
            .sessions
            .lock()
            .await
            .get("thread-1")
            .unwrap()
            .projection
            .clone();
        {
            let mut p = projection.lock().unwrap();
            started(&mut p, "t");
            p.apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
                "error":{"message":"provider unavailable"}}),
            )
            .unwrap();
        }
        state
            .retain_native_exit("thread-1", "foreign-runtime")
            .await;
        assert!(!projection.lock().unwrap().source_retired());
        state.retain_native_exit("thread-1", "owned-runtime").await;
        let mut patch = None;
        let mut clear = None;
        let mut order = Vec::new();
        while let Ok(frame) = events.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            if frame["event"]["type"] == "freshAgent.transcript.patch" {
                order.push("patch");
                assert!(patch.replace(frame["event"].clone()).is_none());
            } else if frame["event"]["code"] == "CODEX_PENDING_PROVIDER_ERROR_CLEARED" {
                order.push("clear");
                assert!(clear.replace(frame["event"].clone()).is_none());
            }
        }
        let patch = patch.expect("unrequested exit broadcasts its retained error patch");
        assert_eq!(
            patch["ops"][0]["turns"][0]["error"]["message"],
            "provider unavailable"
        );
        assert_eq!(patch["ops"][1]["status"], "failed");
        let clear = clear.expect("the provisional warning must be cleared after exit");
        assert_eq!(clear["turnId"], "t");
        assert_eq!(clear["outcome"], "failed");
        assert_eq!(order, ["patch", "clear"]);
        assert!(projection.lock().unwrap().source_retired());
        peer.disconnect();
        state.shutdown().await;
    }

    #[test]
    fn failure_lifecycle_old_exit_cannot_broadcast_after_source_replacement() {
        use std::future::Future;
        use std::task::{Context, Poll};

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let (state, mut events, peer) = runtime.block_on(async {
            let (transport, peer) = freshell_codex::new_channel_transport();
            let (client, notifs) = CodexAppServerClient::connect(transport);
            let (state, _) = rig::state_with_bus();
            let events = rig::insert_fake_session_with_real_consumer(
                &state,
                "thread-1",
                Arc::new(client),
                Arc::new(Mutex::new(None)),
                notifs,
                rig::spawn_sleeper(),
                "owned-runtime",
            )
            .await;
            (state, events, peer)
        });
        let sessions = runtime.block_on(state.sessions.lock());
        let old_projection = sessions.get("thread-1").unwrap().projection.clone();
        let mut old_guard = old_projection.lock().unwrap();
        started(&mut old_guard, "t");
        old_guard
            .apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
            "error":{"message":"old source failure"}}),
            )
            .unwrap();

        // Queue the old exit first, then a replacement, while the source lock
        // holds retirement exactly between identity lookup and publication.
        let exiting_state = state.clone();
        let mut exit = Box::pin(async move {
            exiting_state
                .retain_native_exit("thread-1", "owned-runtime")
                .await
        });
        let mut context = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(matches!(exit.as_mut().poll(&mut context), Poll::Pending));
        let replacing_state = state.clone();
        let (replaced_tx, replaced_rx) = std::sync::mpsc::channel();
        let mut replace = Box::pin(async move {
            let mut sessions = replacing_state.sessions.lock().await;
            let session = sessions.get_mut("thread-1").unwrap();
            session.projection = Arc::new(Mutex::new(CodexProjection::new(
                "new-source".into(),
                "thread-1".into(),
            )));
            session.sidecar_ownership_id = "new-runtime".into();
            let _ = replacing_state
                .broadcast_tx
                .send(json!({"event":{"type":"test.source.replaced"}}).to_string());
            replaced_tx.send(()).unwrap();
        });
        assert!(matches!(replace.as_mut().poll(&mut context), Poll::Pending));
        drop(sessions);
        let exit_runtime = runtime.handle().clone();
        let exit = std::thread::spawn(move || exit_runtime.block_on(exit));
        let replace_runtime = runtime.handle().clone();
        let replace = std::thread::spawn(move || replace_runtime.block_on(replace));
        let _ = replaced_rx.recv_timeout(Duration::from_millis(500));
        drop(old_guard);
        exit.join().unwrap();
        replace.join().unwrap();

        let mut frames = Vec::new();
        while let Ok(frame) = events.try_recv() {
            frames.push(serde_json::from_str::<Value>(&frame).unwrap());
        }
        let replacement = frames
            .iter()
            .position(|frame| frame["event"]["type"] == "test.source.replaced")
            .unwrap();
        let patch = frames
            .iter()
            .position(|frame| frame["event"]["type"] == "freshAgent.transcript.patch")
            .unwrap();
        let clear = frames
            .iter()
            .position(|frame| frame["event"]["code"] == "CODEX_PENDING_PROVIDER_ERROR_CLEARED")
            .unwrap();
        // The fixture owns the original child and watcher; restore its row so
        // normal shutdown cleans them up using the original ownership id.
        runtime.block_on(async {
            let mut sessions = state.sessions.lock().await;
            let session = sessions.get_mut("thread-1").unwrap();
            session.projection = old_projection;
            session.sidecar_ownership_id = "owned-runtime".into();
        });
        peer.disconnect();
        runtime.block_on(state.shutdown());
        assert!(
            patch < replacement,
            "an old source must never publish its failure after replacement: {frames:?}"
        );
        assert!(
            patch < clear && clear < replacement,
            "an old source must clear only after its patch and before replacement: {frames:?}"
        );
    }

    #[tokio::test]
    async fn pending_error_clears_when_a_new_turn_starts() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let (state, _) = rig::state_with_bus();
        let mut events = rig::insert_fake_session_with_real_consumer(
            &state,
            "thread-1",
            Arc::new(client),
            Arc::new(Mutex::new(None)),
            notifs,
            rig::spawn_sleeper(),
            "owned-runtime-start",
        )
        .await;
        let projection = state.sessions.lock().await["thread-1"].projection.clone();
        {
            let mut p = projection.lock().unwrap();
            started(&mut p, "old");
            p.apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                "error":{"message":"pending warning"}}),
            )
            .unwrap();
        }
        peer.emit_notification(
            "turn/started",
            json!({"threadId":"thread-1",
            "turn":{"id":"new","status":"inProgress"}}),
        );
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let raw = events.recv().await.unwrap();
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["event"]["code"] == "CODEX_PENDING_PROVIDER_ERROR_CLEARED" {
                    break frame;
                }
            }
        })
        .await;
        let pending = projection.lock().unwrap().pending_provider_error();
        peer.disconnect();
        state.shutdown().await;
        let frame = frame.expect("starting a new turn clears the old warning");
        assert_eq!(frame["event"]["turnId"], "old");
        assert_eq!(frame["event"]["outcome"], "other");
        assert!(pending.is_none());
    }

    #[test]
    fn failure_reconnect_recovers_only_the_exact_in_progress_native_turn() {
        for with_notice in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            snapshot(
                &mut p,
                json!([{"id":"t","status":"inProgress","itemsView":"full","items":[]}]),
            );
            p.apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"foreign","willRetry":false,
                "error":{"message":"foreign"}}),
            )
            .unwrap();
            assert!(failed(&mut p, "foreign", "foreign completion").is_empty());
            assert!(p.active_turn.is_none());

            if with_notice {
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
                    "error":{"message":"provider unavailable"}}),
                )
                .unwrap();
                let ops = p
                    .apply(
                        "turn/completed",
                        &json!({"threadId":"thread-1","turn":{
                            "id":"t","status":"failed","error":null
                        }}),
                    )
                    .unwrap();
                assert_eq!(
                    ops[0]["turns"][0]["error"]["message"],
                    "provider unavailable"
                );
            } else {
                let ops = failed(&mut p, "t", "provider unavailable");
                assert_eq!(
                    ops[0]["turns"][0]["error"]["message"],
                    "provider unavailable"
                );
            }
            started(&mut p, "new");
            assert!(failed(&mut p, "t", "late stale completion").is_empty());
            assert_eq!(p.active_turn.as_deref(), Some("new"));
        }

        let mut stale = CodexProjection::new("runtime".into(), "thread-1".into());
        snapshot(
            &mut stale,
            json!([{"id":"t","status":"completed","itemsView":"full","items":[]}]),
        );
        assert!(failed(&mut stale, "t", "stale completion").is_empty());
        assert!(stale.active_turn.is_none());
    }

    #[test]
    fn failure_lifecycle_late_provider_errors_correct_only_their_original_turn() {
        use freshell_codex::CodexNotification;
        for late_notice in [false, true] {
            let projection = Arc::new(Mutex::new(CodexProjection::new(
                "runtime".into(),
                "thread-1".into(),
            )));
            started(&mut projection.lock().unwrap(), "old");
            assert!(!super::super::project_codex_notification(
                &projection,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".into(),
                    status: json!({"type":"systemError"}),
                }
            ));
            let mut p = projection.lock().unwrap();
            started(&mut p, "new");
            let ops = if late_notice {
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                    "error":{"message":"late provider failure"}}),
                )
                .unwrap()
            } else {
                failed(&mut p, "old", "late provider failure")
            };
            assert_eq!(ops.len(), 1);
            assert_eq!(ops[0]["op"], "resetTurn");
            assert_eq!(ops[0]["correctSettled"], true);
            assert_eq!(ops[0]["nativeTurnId"], "old");
            assert_eq!(
                ops[0]["turns"][0]["error"]["message"],
                "late provider failure"
            );
            assert_eq!(p.active_turn.as_deref(), Some("new"));
            assert!(p.snapshot_rows("new").unwrap().is_empty());
            assert!(failed(&mut p, "old", "late provider failure").is_empty());
            assert!(p
                .apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                "error":{"message":"duplicate failure"}})
                )
                .unwrap()
                .is_empty());
        }
    }

    #[test]
    fn failure_lifecycle_late_completion_replaces_only_less_specific_diagnostics() {
        for notice_before_loss in [false, true] {
            for final_message in ["initial diagnostic", "more specific provider failure"] {
                let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
                started(&mut p, "old");
                if notice_before_loss {
                    p.apply(
                        "error",
                        &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                        "error":{"message":"initial diagnostic"}}),
                    )
                    .unwrap();
                }
                let published = p.lifecycle_loss();
                assert_eq!(published, notice_before_loss);
                p.take_patch();
                if !notice_before_loss {
                    let ops = p
                        .apply(
                            "error",
                            &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                        "error":{"message":"initial diagnostic"}}),
                        )
                        .unwrap();
                    assert_eq!(ops[0]["correctSettled"], true);
                }
                let saved = snapshot(
                    &mut p,
                    json!([{"id":"old","status":"failed","itemsView":"full","items":[],
                    "error":{"message":"initial diagnostic"}}]),
                );
                assert_eq!(
                    saved.raw["thread"]["turns"][0]["error"]["message"],
                    "initial diagnostic"
                );
                started(&mut p, "new");
                let ops = failed(&mut p, "old", final_message);
                if final_message == "initial diagnostic" {
                    assert!(
                        ops.is_empty(),
                        "identical completion must not duplicate the error"
                    );
                } else {
                    assert_eq!(ops.len(), 1);
                    assert_eq!(ops[0]["correctSettled"], true);
                    assert_eq!(ops[0]["nativeTurnId"], "old");
                    assert_eq!(ops[0]["turns"][0]["error"]["message"], final_message);
                }
                assert_eq!(p.active_turn.as_deref(), Some("new"));
                assert!(failed(&mut p, "old", final_message).is_empty());
            }
        }
    }

    #[test]
    fn failure_lifecycle_late_completion_survives_an_interim_saved_read() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "old");
        assert!(!p.lifecycle_loss());
        snapshot(
            &mut p,
            json!([{"id":"old","status":"interrupted","itemsView":"full","items":[]}]),
        );
        let ops = failed(&mut p, "old", "late provider failure");
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["correctSettled"], true);
        assert_eq!(
            ops[0]["turns"][0]["error"]["message"],
            "late provider failure"
        );
    }

    #[test]
    fn failure_lifecycle_blank_late_completion_preserves_or_supplies_error() {
        for prior_diagnostic in [false, true] {
            for error in [
                None,
                Some(Value::Null),
                Some(json!("")),
                Some(json!({"message":" "})),
                Some(json!({})),
            ] {
                let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
                started(&mut p, "old");
                if prior_diagnostic {
                    p.apply(
                        "error",
                        &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                        "error":{"message":"useful provider diagnostic"}}),
                    )
                    .unwrap();
                }
                p.lifecycle_loss();
                p.take_patch();
                let mut completion =
                    json!({"threadId":"thread-1","turn":{"id":"old","status":"failed"}});
                if let Some(error) = error {
                    completion["turn"]["error"] = error;
                }
                let ops = p.apply("turn/completed", &completion).unwrap();
                if prior_diagnostic {
                    assert!(ops.is_empty());
                    assert_eq!(
                        p.snapshot_rows("old").unwrap()[0]["error"]["message"],
                        "useful provider diagnostic"
                    );
                } else {
                    assert_eq!(ops.len(), 1);
                    assert_eq!(ops[0]["correctSettled"], true);
                    assert!(ops[0]["turns"][0]["error"]["message"]
                        .as_str()
                        .is_some_and(|message| !message.trim().is_empty()));
                    assert!(p.apply("turn/completed", &completion).unwrap().is_empty());
                    let later = p
                        .apply(
                            "error",
                            &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
                        "error":{"message":"later provider detail"}}),
                        )
                        .unwrap();
                    assert_eq!(
                        later[0]["turns"][0]["error"]["message"],
                        "later provider detail"
                    );
                }
            }
        }
    }

    #[test]
    fn failure_lifecycle_saved_error_remains_visible_with_retained_partial_output() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "old");
        item(
            &mut p,
            "old",
            json!({"type":"agentMessage","id":"answer","text":"observed partial"}),
            true,
        );
        assert!(!p.lifecycle_loss());
        let saved = snapshot(
            &mut p,
            json!([{"id":"old","status":"failed","itemsView":"full",
            "items":[{"type":"agentMessage","id":"answer","text":"different saved output"}],
            "error":{"message":"provider failure from saved history"}}]),
        );
        let turn = &saved.raw["thread"]["turns"][0];
        assert_eq!(
            turn["error"]["message"],
            "provider failure from saved history"
        );
        assert_eq!(turn["items"][0]["text"], "observed partial");
        assert!(failed(&mut p, "old", "provider failure from saved history").is_empty());
    }

    #[test]
    fn failure_lifecycle_stale_saved_read_cannot_replace_a_newer_error() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "old");
        assert!(!p.lifecycle_loss());
        let fence = p.begin_history_read();
        let ops = p
            .apply(
                "error",
                &json!({"threadId":"thread-1","turnId":"old","willRetry":false,
            "error":{"message":"newer provider failure"}}),
            )
            .unwrap();
        assert_eq!(ops[0]["correctSettled"], true);
        p.accept_native_history(
            &history(
                json!([{"id":"old","status":"failed","itemsView":"full","items":[],
            "error":{"message":"older saved failure"}}]),
            ),
            &fence,
        )
        .unwrap();
        assert_eq!(
            p.snapshot_rows("old").unwrap()[0]["error"]["message"],
            "newer provider failure"
        );
    }

    #[test]
    fn failure_lifecycle_late_provider_errors_respect_removed_and_ordinary_turn_fences() {
        use freshell_codex::CodexNotification;
        let projection = Arc::new(Mutex::new(CodexProjection::new(
            "runtime".into(),
            "thread-1".into(),
        )));
        started(&mut projection.lock().unwrap(), "removed");
        assert!(!super::super::project_codex_notification(
            &projection,
            &CodexNotification::ThreadClosed {
                thread_id: "thread-1".into(),
            }
        ));
        let mut p = projection.lock().unwrap();
        p.invalidate_history(&["removed".to_owned()]);
        assert!(failed(&mut p, "removed", "removed turn failure").is_empty());
        started(&mut p, "interrupted");
        ended(&mut p, "interrupted", "interrupted");
        assert!(failed(&mut p, "interrupted", "ordinary interruption").is_empty());
        started(&mut p, "completed");
        ended(&mut p, "completed", "completed");
        assert!(failed(&mut p, "completed", "ordinary completion").is_empty());
        assert!(failed(&mut p, "foreign", "foreign turn failure").is_empty());

        let mut prior = CodexProjection::new("prior".into(), "thread-1".into());
        started(&mut prior, "prior-turn");
        assert!(!prior.lifecycle_loss());
        let mut replacement = CodexProjection::new("replacement".into(), "thread-1".into());
        replacement.inherit_finite_history(&prior);
        assert!(failed(&mut replacement, "prior-turn", "replaced source").is_empty());
        prior.invalidate_history(&["another-turn".to_owned()]);
        assert!(failed(&mut prior, "prior-turn", "old generation").is_empty());
    }

    #[test]
    fn failure_first_turn_recovers_when_the_start_notification_was_missed() {
        for with_notice in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            if with_notice {
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"first","willRetry":false,
                    "error":{"message":"provider unavailable"}}),
                )
                .unwrap();
                let ops = p
                    .apply(
                        "turn/completed",
                        &json!({"threadId":"thread-1","turn":{
                            "id":"first","status":"failed","error":null
                        }}),
                    )
                    .unwrap();
                assert_eq!(
                    ops[0]["turns"][0]["error"]["message"],
                    "provider unavailable"
                );
            } else {
                let ops = failed(&mut p, "first", "provider unavailable");
                assert_eq!(
                    ops[0]["turns"][0]["error"]["message"],
                    "provider unavailable"
                );
            }
        }
    }

    #[test]
    fn accepted_turn_recovery_keeps_terminal_removed_and_retired_fences() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        started(&mut p, "old");
        ended(&mut p, "old", "completed");
        p.invalidate_history(&["removed".into()]);
        for id in ["old", "removed"] {
            p.begin_accepted_send();
            p.observe_accepted_turn(id);
            assert!(failed(&mut p, id, "must stay hidden").is_empty());
        }
        p.begin_accepted_send();
        p.observe_accepted_turn("accepted");
        assert!(failed(&mut p, "foreign", "foreign failure").is_empty());
        assert_eq!(p.active_turn.as_deref(), Some("accepted"));
        assert!(!failed(&mut p, "accepted", "accepted failure").is_empty());
        p.retire_source();
        p.begin_accepted_send();
        p.observe_accepted_turn("after-retirement");
        assert!(failed(&mut p, "after-retirement", "must stay hidden").is_empty());

        let mut changed = CodexProjection::new("runtime".into(), "thread-1".into());
        changed.begin_accepted_send();
        snapshot(
            &mut changed,
            json!([{"id":"later","status":"completed",
            "itemsView":"full","items":[]}]),
        );
        changed.invalidate_history(&[]);
        changed.observe_accepted_turn("later");
        assert!(failed(&mut changed, "later", "stale generation").is_empty());
    }

    #[test]
    fn unattributed_diagnostic_survives_recovery_until_a_new_send_is_accepted() {
        let mut prior = CodexProjection::new("prior".into(), "thread-1".into());
        prior.begin_accepted_send();
        prior.retain_ambiguous_send();
        assert!(
            matches!(prior.ambiguous_completion(&json!({"threadId":"thread-1",
            "turn":{"id":"unknown","status":"failed","error":{"message":"capacity"}}})),
            Some(AmbiguousEventResult::Warn(message)) if message == "capacity")
        );
        prior.retire_source();
        let mut recovered = CodexProjection::new("recovered".into(), "thread-1".into());
        recovered.inherit_finite_history(&prior);
        let retained = recovered.retained_snapshot(false).unwrap();
        let mut snapshot =
            json!({"extensions":{"codex":{}},"tokenUsage":{},"diffs":[],"capabilities":{}});
        recovered.overlay(&mut snapshot, retained.metadata);
        assert_eq!(
            snapshot["extensions"]["codex"]["unattributedProviderError"],
            "capacity"
        );
        recovered.begin_accepted_send();
        recovered.observe_accepted_turn("new");
        let retained = recovered.retained_snapshot(false).unwrap();
        let mut snapshot =
            json!({"extensions":{"codex":{}},"tokenUsage":{},"diffs":[],"capabilities":{}});
        recovered.overlay(&mut snapshot, retained.metadata);
        assert!(snapshot["extensions"]["codex"]
            .get("unattributedProviderError")
            .is_none());
    }

    #[test]
    fn ambiguous_split_errors_keep_final_detail_and_ignore_retries_and_success() {
        let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
        p.begin_accepted_send();
        p.retain_ambiguous_send();
        let error = |id, message, will_retry| {
            json!({"threadId":"thread-1","turnId":id,
            "willRetry":will_retry,"error":{"message":message}})
        };
        let completion = |id, status, detail| {
            json!({"threadId":"thread-1","turn":{
            "id":id,"status":status,"error":detail}})
        };
        assert!(p
            .ambiguous_error(&error("retry", "temporary", true))
            .is_none());
        assert!(matches!(
            p.ambiguous_completion(&completion("retry", "failed", Value::Null)),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert!(matches!(
            p.ambiguous_error(&error("success", "pending", false)),
            Some(AmbiguousEventResult::Warn(message)) if message == "pending"
        ));
        assert!(matches!(
            p.ambiguous_completion(&completion("success", "completed", Value::Null)),
            Some(AmbiguousEventResult::Refresh)
        ));
        assert!(matches!(
            p.ambiguous_error(&error("success", "late", false)),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert!(p.unattributed_provider_error().is_none());
        assert!(
            p.has_usable_history(),
            "a clear must still allow a disconnected snapshot"
        );

        assert!(matches!(
            p.ambiguous_completion(&completion("failed", "failed", Value::Null)),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert!(
            matches!(p.ambiguous_error(&error("failed", "provisional", false)),
            Some(AmbiguousEventResult::Warn(message)) if message == "provisional")
        );
        assert!(
            matches!(p.ambiguous_completion(&completion("failed", "failed", json!({"message":"final detail"}))),
            Some(AmbiguousEventResult::Warn(message)) if message == "final detail")
        );
        assert!(matches!(
            p.ambiguous_error(&error("failed", "older", false)),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert!(matches!(
            p.ambiguous_completion(&completion(
                "failed",
                "failed",
                json!({"message":"final detail"})
            )),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert_eq!(
            p.unattributed_provider_error().as_deref(),
            Some("final detail")
        );

        p.begin_accepted_send();
        p.retain_ambiguous_send();
        assert!(matches!(
            p.ambiguous_error(&error("first", "first warning", false)),
            Some(AmbiguousEventResult::Warn(_))
        ));
        assert!(matches!(
            p.ambiguous_error(&error("second", "second warning", false)),
            Some(AmbiguousEventResult::Warn(_))
        ));
        assert!(matches!(
            p.ambiguous_completion(&completion("first", "completed", Value::Null)),
            Some(AmbiguousEventResult::Ignore)
        ));
        assert!(matches!(
            p.ambiguous_completion(&completion("second", "completed", Value::Null)),
            Some(AmbiguousEventResult::Refresh)
        ));
        assert_eq!(p.unattributed_provider_error().as_deref(), Some("final detail"),
            "clearing provisional warnings restores the prior diagnostic, not an already cleared one");
    }

    #[test]
    fn failure_active_turn_survives_a_read_ahead_terminal_snapshot() {
        for with_item in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            started(&mut p, "t");
            let items = if with_item {
                let input = json!({"type":"agentMessage","id":"answer","text":"partial"});
                item(&mut p, "t", input.clone(), true);
                vec![input]
            } else {
                vec![]
            };
            snapshot(
                &mut p,
                json!([{"id":"t","status":"completed","itemsView":"full","items":items}]),
            );
            assert_eq!(p.active_turn.as_deref(), Some("t"));
            let ops = failed(&mut p, "t", "provider failure after read-ahead");
            assert_eq!(ops[0]["correctSettled"], true);
            assert_eq!(
                ops[0]["turns"].as_array().unwrap().last().unwrap()["error"]["message"],
                "provider failure after read-ahead"
            );
            assert_eq!(ops[1]["op"], "settleTurn");
        }
    }

    #[test]
    fn failure_unstarted_native_preview_survives_a_read_ahead_terminal_snapshot() {
        for with_notice in [false, true] {
            let mut p = CodexProjection::new("runtime".into(), "thread-1".into());
            snapshot(
                &mut p,
                json!([{"id":"t","status":"inProgress","itemsView":"full","items":[]}]),
            );
            snapshot(
                &mut p,
                json!([{"id":"t","status":"completed","itemsView":"full","items":[]}]),
            );
            let ops = if with_notice {
                p.apply(
                    "error",
                    &json!({"threadId":"thread-1","turnId":"t","willRetry":false,
                    "error":{"message":"provider failure after read-ahead"}}),
                )
                .unwrap();
                p.apply("turn/completed", &json!({"threadId":"thread-1","turn":{"id":"t","status":"failed","error":null}})).unwrap()
            } else {
                failed(&mut p, "t", "provider failure after read-ahead")
            };
            assert_eq!(ops[0]["correctSettled"], true);
            assert_eq!(
                ops[0]["turns"][0]["error"]["message"],
                "provider failure after read-ahead"
            );
        }
        let mut stale = CodexProjection::new("runtime".into(), "thread-1".into());
        snapshot(
            &mut stale,
            json!([{"id":"old","status":"completed","itemsView":"full","items":[]}]),
        );
        assert!(failed(&mut stale, "old", "stale failure").is_empty());
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
        assert_eq!(request.2["includeTurns"], false);
        peer.respond(&request.0, history(json!([])));
        let request = peer.expect_request().await;
        assert_eq!(request.1, "thread/turns/list");
        assert_eq!(request.2["threadId"], "thread-1");
        assert_eq!(request.2["limit"], 1);
        assert_eq!(request.2["itemsView"], "full");
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
        peer.respond(&request.0,json!({"data":[{"id":"removed","status":"completed","itemsView":"full","items":[{"id":"a","type":"agentMessage","text":"must disappear"}]}],"nextCursor":null,"backwardsCursor":null}));
        let reread = peer.expect_request().await;
        assert_eq!(reread.1, "thread/read");
        assert_eq!(reread.2["includeTurns"], false);
        peer.respond(&reread.0, history(json!([])));
        let reread = peer.expect_request().await;
        assert_eq!(reread.1, "thread/turns/list");
        assert_eq!(reread.2["threadId"], "thread-1");
        peer.respond(
            &reread.0,
            json!({"data":[],"nextCursor":null,"backwardsCursor":null}),
        );
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
        assert_eq!(request.2["includeTurns"], false);
        peer.respond(&request.0, history(json!([])));
        let request = peer.expect_request().await;
        assert_eq!(request.1, "thread/turns/list");
        assert_eq!(request.2["threadId"], "thread-1");
        assert_eq!(request.2["limit"], 1);
        assert_eq!(request.2["itemsView"], "full");
        {
            let mut p = projection.lock().unwrap();
            let ops = delta(&mut p, "t", "lo");
            p.enqueue(ops);
        }
        peer.respond(
            &request.0,
            json!({"data":[{"id":"t","status":"inProgress","itemsView":"full","items":[]}],"nextCursor":null,"backwardsCursor":null}),
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

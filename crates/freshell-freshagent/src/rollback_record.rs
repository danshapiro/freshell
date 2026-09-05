//! Kata 1wxv Task 1: the durable rollback record (`RollbackRecord`), rollback
//! request normalization (`RollbackRequest`), pinned refusal/notice copy, and
//! the three rollback frame builders (requesting-sink error, requesting-sink
//! ack, broadcast). The pane ledger stores these rows payload-OPAQUE; the
//! schema lives here (see `docs/plans/2026-08-22-freshagent-undo-redo.md` —
//! "Durable rollback record").

use freshell_protocol::{
    AgentProvider, FreshAgentEvent, FreshAgentRedo, FreshAgentUndo, RollbackMode, ServerMessage,
    SessionType,
};
use serde_json::{json, Value};

/// Schema version gate for stored rollback rows: a row written with any other
/// version answers `None` from `PaneIdentitySink::load_rollback` (never
/// silently reinterpreted — the pane-ledger LEDGER_VERSION precedent).
pub const ROLLBACK_RECORD_VERSION: u32 = 1;

/// Server `BUSY_TURN` copy, shared by all providers.
pub const ROLLBACK_BUSY_MESSAGE: &str = "Rollback is not supported while a turn is running — queue a steer message or wait for the turn to finish.";
/// Client-visible `REDO_UNAVAILABLE` copy: a submission after the undo
/// permanently retired redo (decision 5).
pub const REDO_DESTROYED_MESSAGE: &str =
    "Redo is no longer available — a message submitted after the undo permanently retired it.";
pub const REDO_EMPTY_MESSAGE: &str = "Nothing to redo.";
pub const UNDO_EMPTY_MESSAGE: &str = "Nothing to roll back.";
/// Server `INTERNAL_ERROR` copy for a rollback-record PRE-WRITE failure — the
/// provider history is NEVER mutated on this path (durable-BEFORE-mutation).
pub const LEDGER_WRITE_REFUSAL_COPY: &str =
    "Undo is unavailable right now — the rollback record could not be saved. Try again.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the codex app-server pre-dates
/// `thread/revert` (unknown-method/`-32601` or a missing method shape).
pub const CODEX_OLD_CLI_COPY: &str = "Rollback requires a newer Codex CLI (codex ≥0.149). Check the freshcodex sidecar logs for the exact error.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the opencode serve pre-dates the
/// revert/unrevert routes (404/unknown route).
pub const OPENCODE_OLD_CLI_COPY: &str = "Rollback requires a newer OpenCode CLI (opencode ≥1.18). Check the serve logs for the exact error.";
/// Server `UNSUPPORTED_CAPABILITY` copy when the codex thread predates this
/// feature (LBC-1): `thread/revert` refuses legacy threads
/// (`-32600 "only supports paginated threads"`).
pub const CODEX_LEGACY_THREAD_COPY: &str =
    "Undo is unavailable for this session — it was started before conversation rollback support (codex threads created earlier use the legacy history format). Start a new session to undo.";
/// Server `REDO_UNAVAILABLE` copy when the claude chain-root original's
/// transcript moved since the undo (tip/LCP validity contract).
pub const REDO_REMOVED_HISTORY_COPY: &str =
    "Redo is no longer available — the original conversation's history changed since the undo.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackDirection {
    Undo,
    Redo,
}

/// The REQUEST-level mode (server-resolved): a frame with `mode` absent
/// means `Step` (the zod/serde schema carries the raw `Option`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackModeReq {
    Step,
    ToTurn,
}

/// Wall-clock ms — every op (rollback, redo, destroy) stamps
/// `last_op_at_ms`/`at_ms` with it (the record doubles as the snapshot
/// revision floor).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The normalized rollback operation the provider handlers consume —
/// direction resolved, mode defaulted, request id carried through to the
/// requesting-sink frames.
#[derive(Debug, Clone, PartialEq)]
pub struct RollbackRequest {
    pub direction: RollbackDirection,
    pub mode: RollbackModeReq,
    pub turn_id: Option<String>,
    pub session_id: String,
    pub session_type: SessionType,
    pub provider: AgentProvider,
    pub request_id: String,
    pub cwd: Option<String>,
}

fn request_mode(mode: Option<RollbackMode>) -> RollbackModeReq {
    match mode {
        Some(RollbackMode::ToTurn) => RollbackModeReq::ToTurn,
        Some(RollbackMode::Step) | None => RollbackModeReq::Step,
    }
}

impl RollbackRequest {
    pub fn from_undo(m: FreshAgentUndo) -> Self {
        Self {
            direction: RollbackDirection::Undo,
            mode: request_mode(m.mode),
            turn_id: m.turn_id,
            session_id: m.session_id,
            session_type: m.session_type,
            provider: m.provider,
            request_id: m.request_id,
            cwd: m.cwd,
        }
    }

    pub fn from_redo(m: FreshAgentRedo) -> Self {
        Self {
            direction: RollbackDirection::Redo,
            mode: request_mode(m.mode),
            turn_id: m.turn_id,
            session_id: m.session_id,
            session_type: m.session_type,
            provider: m.provider,
            request_id: m.request_id,
            cwd: m.cwd,
        }
    }
}

/// One rollback op's marker payload: the removed display turns (verbatim
/// `FreshAgentTurn` JSON — `rolledBack` is stamped at READ time, not stored)
/// plus the composer-refill prompt.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackEntry {
    pub removed_turns: Vec<Value>,
    /// Plain text of the first removed USER turn — the composer-refill payload.
    pub prompt_text: String,
    pub at_ms: i64,
    /// Delta-r1 F8: the epoch this op ran in (its [`RollbackRecord`]'s
    /// `current_epoch` at write time). Entries with `epoch ==
    /// record.current_epoch` are the REDOABLE tail; anything older is a frozen
    /// prior-epoch marker. `#[serde(default)]` maps pre-F8 disk rows to epoch 0
    /// (the record's `current_epoch` also defaults to 0, so a pre-F8 bucket
    /// reads as one epoch — the delay-compat rule).
    #[serde(default)]
    pub epoch: u32,
}

/// The durable record (decision 10's record), keyed `(provider, sessionId)`.
/// `entries` is the UNION of every epoch's rolled-back turns (frozen
/// prior-epoch markers first, in original conversation order); it is NEVER
/// dropped by an epoch reset, a send, or `destroy_redo`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRecord {
    pub version: u32,
    /// Revision floor (wall-clock ms of the last rollback op).
    pub last_op_at_ms: i64,
    /// Any new submission (send/steer/queue firing) sets this: redo
    /// permanently dies (decision 5), the marker bucket survives (decision 6).
    pub redo_destroyed: bool,
    /// Redo availability STAMPED AT WRITE TIME by the provider handler —
    /// never derived at read (stored at write time; never entries-derived).
    pub can_redo: bool,
    /// Claude fork-chain root (the session retaining full history). None for
    /// codex/opencode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_session_id: Option<String>,
    /// Claude redo-validity anchor: the raw-chain tip uuid of the ORIGINAL
    /// transcript recorded at undo time. None for codex/opencode and for a
    /// fresh record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_tip_uuid: Option<String>,
    /// Delta-r1 F8: the CURRENT epoch counter. A new undo landing on a record
    /// whose `redo_destroyed` bit was set at load (or, claude-lane, whose chain
    /// root re-rooted) bumps this FIRST — every existing entry freezes with its
    /// own epoch — then the new entry is spliced under the bumped value. The
    /// redoable tail (F6) is exactly `entries[*].epoch == current_epoch`.
    /// `#[serde(default)]`: pre-F8 disk rows parse to 0 (version stays 1).
    #[serde(default)]
    pub current_epoch: u32,
    /// Removed display turns as verbatim FreshAgentTurn JSON.
    pub entries: Vec<RollbackEntry>,
}

impl RollbackRecord {
    pub fn empty(now_ms: i64) -> Self {
        Self {
            version: ROLLBACK_RECORD_VERSION,
            last_op_at_ms: now_ms,
            redo_destroyed: false,
            can_redo: false,
            original_session_id: None,
            original_tip_uuid: None,
            current_epoch: 0,
            entries: Vec::new(),
        }
    }

    /// The ONE reader of a STORED rollback payload (focused-review ep1-r1 F3):
    /// parse the ledger's opaque JSON → version-gate (a mismatched version
    /// reads as `None`, never silently reinterpreted — the pane-ledger
    /// LEDGER_VERSION discipline) → apply the pre-F8 LEGACY migration IN
    /// MEMORY. Every load path (`PaneIdentitySink::load_rollback`
    /// implementations over stored bytes) routes through here so handlers see
    /// a uniform already-migrated record.
    ///
    /// The migration: a row written BEFORE the epoch fields existed has NO
    /// `epoch` on any entry and NO `currentEpoch` on the record — the detect
    /// keys on the ABSENCE of ALL epoch keys (focused ep1-r2 F1), INDIFFERENT
    /// to `redoDestroyed`: the pre-repair handlers cleared that bit when the
    /// first undo of a new epoch was recorded, so the real persisted
    /// undo → send → undo shape reads `redoDestroyed:false` over a MULTI-epoch
    /// union, and the bit cannot key anything. Serde-defaulting every entry to
    /// epoch 0 aliases the frozen prefix onto `currentEpoch` (also defaulting
    /// to 0): frozen markers would regain "Redo to here" and a subsequent
    /// same-epoch undo would splice BEFORE the frozen prefix. So the load
    /// freezes EVERY existing entry (epochs stay 0 — the frozen boundary IS
    /// `entries.len()`) and bumps `current_epoch` beyond; the destroyed bit is
    /// honored LITERALLY (clear ⇒ the next undo appends under the current
    /// epoch; set ⇒ the destroyed-at-load leg opens a fresh epoch on top).
    /// Freezing an actually-single-epoch legacy record too is the accepted
    /// conservatism (an epochless row cannot prove it is single-epoch; a
    /// wrongly-redoable frozen marker is the failure under repair). The disk
    /// row is NEVER lazily rewritten — the migration persists with the next
    /// op's write. Post-F8 rows (every entry carries `epoch` EXPLICITLY and the
    /// record carries `currentEpoch`) load UNMIGRATED — an explicit `epoch: 0`
    /// therefore never misfires as legacy.
    ///
    /// Focused-review ep1-r4 F2: an epochless row ALSO cannot prove which of
    /// its frozen steps remain redoable at the provider — an
    /// undo → partial redo → stop history reads IDENTICALLY to
    /// all-steps-outstanding, so the stored `canRedo:true` is
    /// stale-unknowable. Admitting a pointer-lane (opencode) redo on that bit
    /// restores ONE step, then the redo path's current-epoch-only restamp
    /// (`set_can_redo` over `epoch == current_epoch` entries) permanently
    /// truncates the rest of a still-valid durable pre-repair rollback state.
    /// The migration therefore FORCES the stored bit OFF for anchor-less rows
    /// (opencode/codex — the rows whose admission trusts the stored bit): the
    /// handler refuses /redo typed-cleanly with ZERO provider traffic, the
    /// frozen markers are preserved verbatim (decision 6), and a NEW undo
    /// records into the bumped epoch and re-establishes redo truthfully.
    /// Claude rows carry `originalSessionId` and KEEP the stored bit: the
    /// claude lane never admits a redo on it (admission is chain-anchored —
    /// original transcript + LCP — and each op re-derives its own can_redo),
    /// so forcing it off there would only darken a redo the chain could still
    /// truthfully validate.
    pub fn from_stored_payload(payload: Value) -> Option<Self> {
        let legacy_epochless_union = payload
            .get("entries")
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                !entries.is_empty() && entries.iter().all(|e| e.get("epoch").is_none())
            })
            && payload.get("currentEpoch").is_none();
        let record: Self = serde_json::from_value(payload).ok()?;
        if record.version != ROLLBACK_RECORD_VERSION {
            return None;
        }
        let mut record = record;
        if legacy_epochless_union {
            record.current_epoch = record
                .current_epoch
                .max(record.entries.iter().map(|e| e.epoch).max().unwrap_or(0) + 1);
            // F2: anchor-less rows (opencode/codex) lose the stale-unprovable
            // stored bit — see the method doc. Claude-anchored rows keep it
            // (their admission never consults it).
            if record.original_session_id.is_none() {
                record.can_redo = false;
            }
        }
        Some(record)
    }

    /// The STORED bit only — never entries-derived (written at op time by the
    /// provider handler; claude entries carry the union marker slices, so only
    /// the stored bit is consulted).
    pub fn can_redo(&self) -> bool {
        self.can_redo
    }

    /// Stamps the stored bit + lifts last_op_at_ms. Provider handlers compute
    /// the value per the record semantics and write it at op time.
    pub fn set_can_redo(&mut self, value: bool, now_ms: i64) {
        self.can_redo = value;
        self.last_op_at_ms = now_ms;
    }

    /// Decision 5: sets redo_destroyed AND clears the stored can_redo bit;
    /// markers survive.
    pub fn destroy_redo(&mut self, now_ms: i64) {
        self.redo_destroyed = true;
        self.can_redo = false;
        self.last_op_at_ms = now_ms;
    }

    /// Appends this op's removed-turn slice (the marker-union rule — frozen
    /// prior-epoch markers precede the current epoch's, both in conversation
    /// order) + lifts last_op_at_ms.
    pub fn push_entry(&mut self, entry: RollbackEntry, now_ms: i64) {
        self.entries.push(entry);
        self.last_op_at_ms = now_ms;
    }

    /// Delta-r1 F8 — open a NEW epoch: bump `current_epoch`. Every existing
    /// entry freezes with its own epoch value (untouched — the frozen prefix is
    /// exactly `epoch < current_epoch`). The caller clears `redo_destroyed`
    /// itself (the redo fields then describe the new chain). Position never
    /// reads timestamps.
    pub fn begin_new_epoch(&mut self) {
        self.current_epoch = self.current_epoch.saturating_add(1);
    }

    /// Delta-r1 F8 — splice a new UNDO entry under literal epoch bookkeeping:
    /// AFTER every frozen (older-epoch) entry, BEFORE the existing same-epoch
    /// entries (sequential undos within one epoch each remove an
    /// earlier-in-conversation step, so the current-epoch block reads
    /// conversation-order ascending). Entry positions never consult `at_ms`.
    /// (CLAUDE lane per the plan's claude bullet — "each undo APPENDS that op's
    /// removed display-turn slice"; OPENCODE uses [`Self::rebuild_current_epoch_tail`].)
    pub fn splice_undo_entry(&mut self, entry: RollbackEntry, now_ms: i64) {
        let insert_at = self
            .entries
            .iter()
            .take_while(|e| e.epoch < self.current_epoch)
            .count();
        self.entries.insert(insert_at, entry);
        self.last_op_at_ms = now_ms;
    }

    /// Opencode plan rule (the plan's wire-design opencode bullet): after every
    /// op the CURRENT-epoch portion of `entries` is REBUILT to exactly the
    /// current serve-revert tail — ONE entry when non-empty, in the tail's
    /// ORIGINAL CONVERSATION ORDER — while FROZEN prior-epoch markers PRECEDE
    /// it. The merge dedupes by turn identity (marker `turnId`, falling back to
    /// `id`): plan triad (c) deliberately keeps the speculative post-op record
    /// after an unverifiable mutation, so a RETRY over an unmoved provider
    /// re-derives the SAME slice — the rebuild absorbs it in place and can
    /// NEVER duplicate the marker bucket (focused-review ep2-r3: the per-op
    /// splice inserted the same removed turns twice, and the snapshot then
    /// flattened BOTH — duplicated `rolledBackTurns`, inflated `undoneDepth` and
    /// `redoableTurnIds`). Same-epoch undos each remove an EARLIER step, so the
    /// new slice precedes the existing current-epoch content in conversation
    /// order.
    pub fn rebuild_current_epoch_tail(
        &mut self,
        removed_turns: Vec<Value>,
        prompt_text: String,
        now_ms: i64,
    ) {
        let frozen = self
            .entries
            .iter()
            .take_while(|e| e.epoch < self.current_epoch)
            .count();
        // Everything past the frozen prefix is the outgoing current-epoch
        // portion; the new slice PRECEDES it in conversation order.
        let existing: Vec<Value> = self
            .entries
            .drain(frozen..)
            .flat_map(|e| e.removed_turns)
            .collect();
        let mut merged: Vec<Value> = Vec::with_capacity(removed_turns.len() + existing.len());
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for turn in removed_turns.into_iter().chain(existing) {
            let id = turn
                .get("turnId")
                .or_else(|| turn.get("id"))
                .and_then(Value::as_str);
            if let Some(id) = id {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            merged.push(turn);
        }
        if !merged.is_empty() {
            self.entries.insert(
                frozen,
                RollbackEntry {
                    removed_turns: merged,
                    prompt_text,
                    at_ms: now_ms,
                    epoch: self.current_epoch,
                },
            );
        }
        self.last_op_at_ms = now_ms;
    }
}

// The envelope stamp helpers — `agent_provider_wire`/`session_type_wire` in
// the ws crate are not visible here; the enums' lowercase serde names are the
// wire strings, restated once (they are frozen-contract strings).
fn agent_provider_wire(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Claude => "claude",
        AgentProvider::Codex => "codex",
        AgentProvider::Opencode => "opencode",
        AgentProvider::Amplifier => "amplifier",
    }
}

fn session_type_wire(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Freshclaude => "freshclaude",
        SessionType::Freshcodex => "freshcodex",
        SessionType::Kilroy => "kilroy",
        SessionType::Freshopencode => "freshopencode",
    }
}

/// The shared `freshAgent.event` envelope: `event` rides opaquely inside;
/// top-level provider/sessionType/sessionId are the locator the client
/// requires (the codex `emit_fresh_agent_error` precedent).
fn rollback_envelope(op: &RollbackRequest, live_session_id: &str, event: Value) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event,
        provider: agent_provider_wire(op.provider).to_string(),
        session_id: live_session_id.to_string(),
        session_type: session_type_wire(op.session_type).to_string(),
    })
}

/// `freshAgent.event{freshAgent.error{code,message,requestId,rollback:true}}`
/// stamped from `op`. The `rollback:true` stamp routes the client to the
/// notice channel, not the pane error surface.
pub fn rollback_error_frame(op: &RollbackRequest, code: &str, message: &str) -> ServerMessage {
    rollback_envelope(
        op,
        &op.session_id,
        json!({
            "type": "freshAgent.error",
            "sessionId": op.session_id,
            "code": code,
            "message": message,
            "requestId": op.request_id,
            "rollback": true,
        }),
    )
}

/// Requesting-sink ack (only the initiating pane's connection):
/// `freshAgent.rolledBack` (undo) / `freshAgent.redone` (redo), carrying the
/// removed prompt for the composer refill (broadcasts never carry it, so
/// other devices' composers are untouched).
pub fn rollback_ack_frame(
    op: &RollbackRequest,
    live_session_id: &str,
    removed_prompt_text: Option<&str>,
    removed_turn_ids: &[String],
    can_redo: bool,
    new_session_id: Option<&str>,
) -> ServerMessage {
    let mut event = match op.direction {
        RollbackDirection::Undo => json!({
            "type": "freshAgent.rolledBack",
            "requestId": op.request_id,
            "sessionId": live_session_id,
            "direction": "undo",
            "mode": match op.mode {
                RollbackModeReq::Step => "step",
                RollbackModeReq::ToTurn => "toTurn",
            },
            "removedTurnIds": removed_turn_ids,
            "canRedo": can_redo,
        }),
        RollbackDirection::Redo => {
            let mut event = json!({
                "type": "freshAgent.redone",
                "requestId": op.request_id,
                "sessionId": live_session_id,
                "direction": "redo",
                "canRedo": can_redo,
            });
            if let Some(last) = removed_turn_ids.last() {
                event["restoredThroughTurnId"] = json!(last);
            }
            event
        }
    };
    if let RollbackDirection::Undo = op.direction {
        if let Some(prompt) = removed_prompt_text {
            event["removedPromptText"] = json!(prompt);
        }
    }
    if let Some(new_session_id) = new_session_id {
        event["newSessionId"] = json!(new_session_id);
    }
    rollback_envelope(op, live_session_id, event)
}

/// Broadcast (every connection incl. the requester; converges sibling clients
/// per decision 10; carries no prompt text so other devices' composers are
/// untouched). Undo additionally carries `revokeAttention:true` (attention
/// revoke for undone turns only, never chimes).
pub fn rollback_broadcast_frame(
    op: &RollbackRequest,
    live_session_id: &str,
    removed_turn_ids: &[String],
    can_redo: bool,
) -> ServerMessage {
    let event = match op.direction {
        RollbackDirection::Undo => json!({
            "type": "freshAgent.session.rolledBack",
            "sessionId": live_session_id,
            "removedTurnIds": removed_turn_ids,
            "canRedo": can_redo,
            "revokeAttention": true,
        }),
        RollbackDirection::Redo => {
            let mut event = json!({
                "type": "freshAgent.session.redone",
                "sessionId": live_session_id,
                "canRedo": can_redo,
            });
            if let Some(last) = removed_turn_ids.last() {
                event["restoredThroughTurnId"] = json!(last);
            }
            event
        }
    };
    rollback_envelope(op, live_session_id, event)
}

/// Kata 1wxv Task 5 snapshot surfacing — the shared half every provider's
/// snapshot builder stamps identically:
///
/// - the marker bucket (the r3 `entries` UNION — frozen prior-epoch markers
///   first, then the current epoch's recorded slice — each turn stamped
///   `rolledBack:true` at READ time, never stored; durable even after native
///   provider deletion, satisfying decision 6's "persist marked"),
/// - the `rollback{canRedo, undoneDepth}` block — `undoneDepth` is the
///   USER-role step count of the bucket (r3 finding 5: the same step count the
///   client's `Rolled back (N)` label shows), NEVER `entries.len()`,
/// - the revision floor: the returned value is
///   `max(existing_basis, record.last_op_at_ms)` so the client's monotonic
///   watermark can never drop the post-rollback snapshot.
///
/// `can_redo` arrives provider-ADJUDICATED: codex/opencode pass
/// [`RollbackRecord::can_redo`] verbatim (the stored bit is the only source);
/// claude rechecks the chain root's tip first (`claude_snapshot`). The
/// strict-contract keys stay OPTIONAL: an EMPTY bucket inserts nothing (and
/// yields no phantom rollback block).
pub(crate) fn stamp_rollback_snapshot(
    snapshot: &mut Value,
    revision_basis: i64,
    record: &RollbackRecord,
    can_redo: bool,
) -> i64 {
    let bucket: Vec<Value> = record
        .entries
        .iter()
        .flat_map(|e| e.removed_turns.iter())
        .map(|t| {
            let mut t = t.clone();
            t["rolledBack"] = json!(true);
            t
        })
        .collect();
    if !bucket.is_empty() {
        let undone_depth = bucket
            .iter()
            .filter(|t| t.get("role").and_then(Value::as_str) == Some("user"))
            .count();
        // Delta-r1 F6: the per-marker "Redo to here" gate set — server-AUTHORED
        // (the single source): the exact USER-role turn ids at the ends of the
        // redoable steps of the CURRENT epoch (`epoch == current_epoch` — F8).
        // Frozen prior-epoch markers are never redoable (providers only restore
        // the current epoch's tail), and codex (undo-only) + any can_redo:false
        // record get the empty set.
        snapshot["rolledBackTurns"] = json!(bucket);
        snapshot["rollback"] = json!({
            "canRedo": can_redo,
            "undoneDepth": undone_depth,
            "redoableTurnIds": redoable_turn_ids(record, can_redo),
        });
    }
    revision_basis.max(record.last_op_at_ms)
}

/// Delta-r1 F6: the USER-role turn ids of the current epoch's entries — the
/// per-marker redo gate set. Empty whenever redo is unavailable (`can_redo`
/// false, e.g. codex's permanent undo-only bit or a destroy-survived bucket).
pub(crate) fn redoable_turn_ids(record: &RollbackRecord, can_redo: bool) -> Vec<String> {
    if !can_redo {
        return Vec::new();
    }
    record
        .entries
        .iter()
        .filter(|e| e.epoch == record.current_epoch)
        .flat_map(|e| e.removed_turns.iter())
        .filter(|t| t.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|t| {
            t.get("turnId")
                .or_else(|| t.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// Decision 5: any new submission (send/steer/queue firing) permanently
/// destroys redo — the redo-capable CHAIN STATE only; `entries` (the r3 marker
/// union) is NEVER touched and survives with the "rolled back" marker per
/// decision 6. AWAITED before the prompt goes out. A write failure is
/// returned — callers `tracing::warn!` it but never block the send and never
/// emit a user-facing event (providers degrade gracefully: opencode natively
/// deletes the reverted tail on send; claude's redo path re-validates the
/// recorded tip). No-op returns when there is no record, nothing redo-capable
/// to destroy, or redo is already destroyed.
pub async fn destroy_redo_on_submit(
    sink: &Option<crate::identity_sink::SharedPaneIdentitySink>,
    provider: &str,
    live_id: &str,
    now_ms: i64,
) -> Option<std::io::Error> {
    let sink = sink.as_ref()?;
    let mut record = sink.load_rollback(provider, live_id)?;
    if record.redo_destroyed || (record.entries.is_empty() && record.original_session_id.is_none())
    {
        return None;
    }
    record.destroy_redo(now_ms); // sets redo_destroyed + clears can_redo; entries untouched (r3)
    sink.record_rollback(provider, live_id, record).await.err()
}

/// Focused-review ep1-r2 F4: the opencode compact's PRE-DRIVE redo destroy.
/// Runs synchronously (the caller holds the session lock) AFTER the compact
/// preflight succeeds and BEFORE the summarize drive/task exists —
/// durable-BEFORE-mutation: from this point `canRedo` is already false in
/// memory + persisted, so an ABORTED drive (interrupt/kill mid-summarize, a
/// cancelled response observation) can never leave the record advertising redo
/// over a provider tail the cancelled summarize may still have deleted.
///
/// `Ok(Some(pre_record))` means THIS call genuinely retired redo and returns
/// the pre-destroy row: the drive's provably-UNDELIVERED leg restores it via
/// [`restore_redo_on_undelivered_compact`] (ep1-r3 F2: ONLY a connect-phase
/// refusal before a byte left proves the reverted tail survived — every
/// post-send failure, an answered non-2xx included, keeps the destroy: OpenCode
/// ≥1.18.21's summarize runs revertSvc.cleanup FIRST, so an error answer is a
/// possibly-destroyed tail, never a proven-survived one). `Ok(None)` is a
/// no-op destroy (no sink/record,
/// already destroyed, or nothing redo-capable); `Err` is a ledger write
/// failure — focused ep2-r1 F2: the caller REFUSES the compact on it (zero
/// provider traffic, pane settles idle, loud typed error) — durable-BEFORE-
/// mutation runs both ways, because continuing would let OpenCode delete the
/// reverted tail while the durable row still advertises redo over it. (This
/// deliberate refusal DIVERGES from [`destroy_redo_on_submit`]'s warn-only
/// degrade: a send carries user intent and opencode deletes the tail natively
/// on send regardless; a compact exists precisely to delete the tail, so the
/// pre-drive moment is the last honest stop.)
pub async fn destroy_redo_before_compact_drive(
    sink: &Option<crate::identity_sink::SharedPaneIdentitySink>,
    provider: &str,
    live_id: &str,
    now_ms: i64,
) -> Result<Option<RollbackRecord>, std::io::Error> {
    let Some(sink) = sink.as_ref() else {
        return Ok(None);
    };
    let Some(record) = sink.load_rollback(provider, live_id) else {
        return Ok(None);
    };
    if record.redo_destroyed || (record.entries.is_empty() && record.original_session_id.is_none())
    {
        return Ok(None);
    }
    let pre = record.clone();
    let mut destroyed = record;
    destroyed.destroy_redo(now_ms);
    sink.record_rollback(provider, live_id, destroyed).await?;
    Ok(Some(pre))
}

/// Focused-review ep1-r2 F4's compensation, re-keyed by ep1-r3 F2: a
/// PROVABLY-UNDELIVERED summarize dispatch — the transport's connect phase
/// refused BEFORE a byte left the client (`ServeError::Undelivered`), so the
/// serve never saw the POST and provably never deleted the reverted tail —
/// undoes the pre-drive destroy by restoring its pre-record. Everything timed
/// at/after the send NEVER calls this: OpenCode ≥1.18.21's summarize handler
/// runs `revertSvc.cleanup` FIRST and answers later-stage failures AFTER it,
/// so an answered non-2xx, a timeout, a mid-flight transport error, or a task
/// abort is a possibly-destroyed tail — the destroy stands forever.
///
/// Restored only when the ledger still holds EXACTLY the row the destroy
/// wrote (`pre_record` + the destroy stamp): any post-destroy write (a later
/// op — unreachable under today's busy gates, guarded regardless) or a deleted
/// row leaves the newer truth standing. The restored row's revision floor
/// never regresses below the destroy's stamp. Best-effort: a restore failure
/// is returned for warn-logging, degrading to "redo stays destroyed" (the
/// conservative side of the ambiguity).
pub async fn restore_redo_on_undelivered_compact(
    sink: &Option<crate::identity_sink::SharedPaneIdentitySink>,
    provider: &str,
    live_id: &str,
    mut pre_record: RollbackRecord,
    destroyed_at_ms: i64,
    restore_now_ms: i64,
) -> Option<std::io::Error> {
    let sink = sink.as_ref()?;
    let current = sink.load_rollback(provider, live_id)?;
    let mut expected = pre_record.clone();
    expected.destroy_redo(destroyed_at_ms);
    if current != expected {
        return None;
    }
    pre_record.last_op_at_ms = pre_record
        .last_op_at_ms
        .max(destroyed_at_ms)
        .max(restore_now_ms);
    sink.record_rollback(provider, live_id, pre_record)
        .await
        .err()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_sink::PaneIdentitySink;

    fn entry(id_suffix: &str) -> RollbackEntry {
        RollbackEntry {
            removed_turns: vec![
                serde_json::json!({ "id": format!("t{id_suffix}"), "turnId": format!("t{id_suffix}"), "summary": "s", "items": [] }),
            ],
            prompt_text: format!("prompt{id_suffix}"),
            at_ms: 100,
            epoch: 0,
        }
    }

    /// F8 (delta-r1): literal epoch bookkeeping replaces the timestamp-heuristic
    /// split — `splice_undo_entry` inserts AFTER every frozen (older-epoch) entry
    /// and BEFORE the existing same-epoch entries, so sequential undos within one
    /// epoch read in conversation order ascending.
    #[test]
    fn splice_undo_entry_orders_same_epoch_undos_conversation_ascending() {
        let mut record = RollbackRecord::empty(50);
        // undo #1 removed the LAST turn-step (t4); undo #2 removed the EARLIER
        // t3 step — the bucket must read t3 then t4.
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t4", "user")],
                prompt_text: "p4".into(),
                at_ms: 60,
                epoch: record.current_epoch,
            },
            60,
        );
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t3", "user")],
                prompt_text: "p3".into(),
                at_ms: 70,
                epoch: record.current_epoch,
            },
            70,
        );
        assert_eq!(
            record
                .entries
                .iter()
                .map(|e| e.prompt_text.as_str())
                .collect::<Vec<_>>(),
            vec!["p3", "p4"],
            "the second undo's entry splices BEFORE the first's within one epoch"
        );
        assert!(record.entries.iter().all(|e| e.epoch == 0));
    }

    /// F8 (delta-r1) case (a): a record whose destroy bit was set at load starts
    /// a NEW epoch — bump `current_epoch`, entries KEEP their own epochs (all
    /// freeze), and the next undo pushes behind them; a further same-epoch undo
    /// splices ahead of that new-epoch block.
    #[test]
    fn splice_undo_entry_after_destroy_freezes_the_prior_epoch_then_orders_the_new_epoch() {
        let mut record = RollbackRecord::empty(50);
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t4", "user")],
                prompt_text: "p4".into(),
                at_ms: 60,
                epoch: record.current_epoch,
            },
            60,
        );
        // A submission destroyed redo; the NEXT undo sees the bit at load.
        record.destroy_redo(61);
        // …the undo handler's epoch-opening leg:
        assert!(record.redo_destroyed, "destroyed bit set at load");
        record.redo_destroyed = false; // the new epoch clears only the redo chain state
        record.begin_new_epoch();
        assert_eq!(record.current_epoch, 1);
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("n2", "user")],
                prompt_text: "pn2".into(),
                at_ms: 70,
                epoch: record.current_epoch,
            },
            70,
        );
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("n1", "user")],
                prompt_text: "pn1".into(),
                at_ms: 80,
                epoch: record.current_epoch,
            },
            80,
        );
        assert_eq!(
            record
                .entries
                .iter()
                .map(|e| (e.epoch, e.prompt_text.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "p4"), (1, "pn1"), (1, "pn2")],
            "frozen prior-epoch prefix first (untouched epochs), then the new epoch ascending"
        );
    }

    /// Focused-review ep1-r1 F3: the persisted pre-F8 multi-op shape — every
    /// entry epoch-free and the destroy bit set (the durable record left by a
    /// legacy undo → … → send history) — provably holds a MULTI-epoch union:
    /// serde-defaulting every entry to epoch 0 would alias the frozen prefix
    /// onto `current_epoch` (also 0), reviving "Redo to here" on frozen
    /// markers and splicing a subsequent same-epoch undo BEFORE the frozen
    /// prefix. The load-time reader migrates IN MEMORY: every existing entry
    /// freezes (its epoch stays 0; the frozen boundary IS `entries.len()`),
    /// `current_epoch` bumps beyond, and the destroyed bit is honored as-is.
    #[test]
    fn legacy_destroyed_epochless_record_loads_as_an_all_frozen_prefix() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 70,
            "redoDestroyed": true,
            "canRedo": false,
            "entries": [
                { "removedTurns": [marker_turn("t1", "user")], "promptText": "p1", "atMs": 40 },
                { "removedTurns": [marker_turn("t2", "user")], "promptText": "p2", "atMs": 50 },
            ],
        });
        let record = RollbackRecord::from_stored_payload(legacy).expect("legacy payload parses");
        assert!(record.redo_destroyed, "the destroyed bit is honored as-is");
        assert!(
            !record.entries.is_empty()
                && record
                    .entries
                    .iter()
                    .all(|e| e.epoch < record.current_epoch),
            "every legacy entry FROZEN (the frozen boundary is entries.len()): {record:?}"
        );
        assert_eq!(
            record.current_epoch, 1,
            "the counter bumped beyond every existing entry's epoch"
        );
        assert!(
            redoable_turn_ids(&record, true).is_empty(),
            "no 'Redo to here' affordances — even a hypothetical can_redo:true \
             adjudication sees a frozen-only bucket"
        );

        // A subsequent undo (the handler's destroy-at-load epoch-opening leg)
        // begins a fresh epoch APPENDED AFTER the frozen legacy prefix — the
        // bucket stays in conversation order.
        let mut record = record;
        record.redo_destroyed = false; // the undo handler clears only the redo chain state
        record.begin_new_epoch();
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t3", "user")],
                prompt_text: "p3".into(),
                at_ms: 80,
                epoch: record.current_epoch,
            },
            80,
        );
        assert_eq!(
            record
                .entries
                .iter()
                .map(|e| (e.epoch, e.prompt_text.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "p1"), (0, "p2"), (2, "p3")],
            "the new epoch is appended AFTER the frozen legacy prefix, never spliced before it"
        );
        assert_eq!(
            redoable_turn_ids(&record, true),
            vec!["t3".to_string()],
            "only the fresh epoch's markers are redoable"
        );
    }

    /// F3 companion: a post-F8 record whose entries carry the `epoch` field
    /// EXPLICITLY (every op stamps it since delta-r1) is never mistaken for a
    /// legacy row — a destroy mid-history bumps nothing at load, and the
    /// handler's own destroyed-at-load leg opens the next epoch exactly once.
    #[test]
    fn explicit_epoch_fields_never_trigger_the_legacy_migration() {
        let modern = json!({
            "version": 1,
            "lastOpAtMs": 70,
            "redoDestroyed": true,
            "canRedo": false,
            "currentEpoch": 3,
            "entries": [
                { "removedTurns": [marker_turn("t1", "user")], "promptText": "p1", "atMs": 40, "epoch": 0 },
                { "removedTurns": [marker_turn("t2", "user")], "promptText": "p2", "atMs": 50, "epoch": 3 },
            ],
        });
        let record = RollbackRecord::from_stored_payload(modern).expect("modern payload parses");
        assert_eq!(record.current_epoch, 3, "untouched by the migrator");
        assert_eq!(
            record.entries.iter().map(|e| e.epoch).collect::<Vec<_>>(),
            vec![0, 3],
            "entry epochs verbatim — no freeze beyond their own stamps"
        );
    }

    /// Focused-review ep1-r2 F1: the migration detect is INDIFFERENT to the
    /// destroyed bit — pre-repair handlers cleared `redoDestroyed` when the
    /// second undo opened its (untracked) new epoch, so the bit provably cannot
    /// key anything. A legacy epochless record whose bit reads FALSE still
    /// loads all-frozen: `currentEpoch` becomes 1, every entry keeps its
    /// absent-epoch serde default (0 — the frozen prefix), and NO marker is
    /// redoable (conservatism: affording "Redo to here" on a possibly-frozen
    /// marker is the failure under repair).
    #[test]
    fn legacy_epochless_record_with_a_clear_destroyed_bit_still_loads_all_frozen() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 50,
            "redoDestroyed": false,
            "canRedo": true,
            "entries": [{
                "removedTurns": [marker_turn("t1", "user")],
                "promptText": "p1",
                "atMs": 40,
            }],
        });
        let record = RollbackRecord::from_stored_payload(legacy).expect("legacy payload parses");
        assert!(!record.redo_destroyed, "the bit is honored literally");
        assert_eq!(
            record.current_epoch, 1,
            "F1: the detect ignores the destroyed bit — the epochless union freezes"
        );
        assert!(record.entries.iter().all(|e| e.epoch == 0));
        assert!(
            redoable_turn_ids(&record, record.can_redo()).is_empty(),
            "no per-marker redo affordance survives the freeze, even with canRedo stored true"
        );
    }

    /// Focused-review ep1-r2 F1 — the review's REAL pre-repair persisted shape:
    /// undo → send → undo. The send destroyed redo; the SECOND undo (opening its
    /// untracked new epoch) cleared `redoDestroyed` again at write time, so the
    /// durable row reads `redoDestroyed:false` with FROZEN (epoch 0) + "current"
    /// entries all epoch-free. Loaded naively (serde defaults), that is ONE
    /// epoch: frozen markers regain "Redo to here" and the NEXT undo splices
    /// AHEAD of the frozen prefix. The migration (keyed on the absence of ALL
    /// epoch keys, indifferent to the destroyed bit) freezes the whole prefix,
    /// sets `current_epoch` to 1, and the next undo appends AFTER the frozen
    /// prefix — and its write persists EXPLICIT epochs so a reload never
    /// re-migrates.
    #[test]
    fn legacy_undo_send_undo_shape_loads_frozen_appends_after_the_prefix_and_persists_epochs() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 70,
            // The pre-repair second undo cleared the destroy bit: the bit was
            // true mid-history (the send destroyed) yet reads false here.
            "redoDestroyed": false,
            "canRedo": true,
            "entries": [
                // epoch 0's frozen marker …
                { "removedTurns": [marker_turn("t1", "user")], "promptText": "p1", "atMs": 40 },
                // … then the send destroyed (bit cycled) …
                // … then the epoch-1 undo's entries — all epoch-free on disk.
                { "removedTurns": [marker_turn("t2", "user")], "promptText": "p2", "atMs": 50 },
                { "removedTurns": [marker_turn("t3", "user")], "promptText": "p3", "atMs": 60 },
            ],
        });
        let record = RollbackRecord::from_stored_payload(legacy).expect("legacy payload parses");
        assert!(
            !record.redo_destroyed,
            "the destroyed bit is honored literally (clear, as the row says)"
        );
        assert!(
            !record.entries.is_empty()
                && record
                    .entries
                    .iter()
                    .all(|e| e.epoch < record.current_epoch),
            "the ALL-FROZEN prefix: every entry older than the current epoch: {record:?}"
        );
        assert_eq!(
            record.current_epoch, 1,
            "the counter sits just past the frozen prefix"
        );
        assert!(
            redoable_turn_ids(&record, true).is_empty(),
            "rollback.redoableTurnIds = [] — frozen markers never regain 'Redo to here'"
        );

        // The NEXT undo lands with the destroyed bit clear at load ⇒ NO epoch
        // opening: it splices under the CURRENT epoch (1), appended AFTER the
        // frozen prefix (never ahead of it).
        let mut record = record;
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("n1", "user")],
                prompt_text: "pn1".into(),
                at_ms: 80,
                epoch: record.current_epoch,
            },
            80,
        );
        assert_eq!(
            record
                .entries
                .iter()
                .map(|e| (e.epoch, e.prompt_text.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "p1"), (0, "p2"), (0, "p3"), (1, "pn1")],
            "the new undo appends AFTER the all-frozen legacy prefix under epoch 1"
        );
        assert_eq!(
            redoable_turn_ids(&record, true),
            vec!["n1".to_string()],
            "only the fresh epoch-1 marker is redoable"
        );

        // The periodic/op write PERSISTS explicit epochs (serde defaulting only
        // fills ABSENT keys; the written row stamps `epoch` per entry AND
        // `currentEpoch`), so the reloaded row never matches the
        // absence-keyed detect — an explicit epoch:0 can never misfire.
        let persisted = serde_json::to_value(&record).expect("serialize");
        assert!(
            persisted["entries"]
                .as_array()
                .expect("entries array")
                .iter()
                .all(|e| e.get("epoch").is_some()),
            "every persisted entry carries an explicit epoch key: {persisted}"
        );
        assert!(
            persisted.get("currentEpoch").is_some(),
            "the persisted record carries currentEpoch explicitly"
        );
        let reloaded =
            RollbackRecord::from_stored_payload(persisted).expect("the written row reparses");
        assert_eq!(
            reloaded, record,
            "a post-migration write round-trips byte-identical — no re-migration"
        );
    }

    /// Focused-review ep1-r4 F2 (opencode_ws.rs redo admission): a legacy
    /// epochless union's stored `canRedo:true` is STALE-UNKNOWABLE — the row
    /// cannot prove which of its frozen steps remain redoable at the provider
    /// (an undo → partial redo → stop history reads identically to
    /// all-steps-outstanding). Admitting a pointer-lane redo on that bit
    /// restores ONE step, then the current-epoch-only restamp permanently
    /// truncates the rest of a valid durable pre-repair rollback state. The
    /// migration therefore FORCES the stored bit OFF for anchor-less
    /// (opencode/codex) rows: the handler refuses /redo typed-cleanly with
    /// ZERO provider traffic, the frozen markers are preserved (decision 6),
    /// and a NEW undo writes into the bumped epoch and re-establishes redo
    /// truthfully.
    #[test]
    fn legacy_anchorless_epochless_record_loads_with_redo_forced_off() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 70,
            "redoDestroyed": false,
            "canRedo": true,
            "entries": [
                { "removedTurns": [marker_turn("t1", "user"), marker_turn("a1", "assistant")], "promptText": "p1", "atMs": 40 },
                { "removedTurns": [marker_turn("t2", "user"), marker_turn("a2", "assistant")], "promptText": "p2", "atMs": 50 },
            ],
        });
        let record = RollbackRecord::from_stored_payload(legacy).expect("legacy payload parses");
        assert!(
            !record.redo_destroyed,
            "the destroy bit is honored literally"
        );
        assert_eq!(
            record.current_epoch, 1,
            "the union froze below the bumped epoch"
        );
        assert!(
            !record.entries.is_empty() && record.entries.iter().all(|e| e.epoch == 0),
            "the all-frozen prefix is preserved verbatim (decision 6): {record:?}"
        );
        assert_eq!(record.entries.len(), 2);
        assert!(
            !record.can_redo(),
            "F2: the stale-unprovable stored bit is forced OFF — /redo refuses typed-cleanly"
        );
    }

    /// F2 scoping: the force-off applies to ANCHOR-LESS rows (opencode/codex).
    /// A claude legacy row carries `originalSessionId`; its lane NEVER admits a
    /// redo on the stored bit (admission is chain-anchored — the original
    /// transcript + LCP — and the per-op `can_redo` is re-derived), so the bit
    /// is kept verbatim: forcing it off there would only darken a redo the
    /// chain could still truthfully validate.
    #[test]
    fn legacy_claude_anchored_epochless_record_keeps_the_stored_bit() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 70,
            "redoDestroyed": false,
            "canRedo": true,
            "originalSessionId": "durable-orig",
            "originalTipUuid": "uuid-tip",
            "entries": [
                { "removedTurns": [marker_turn("t1", "user")], "promptText": "p1", "atMs": 40 },
            ],
        });
        let record = RollbackRecord::from_stored_payload(legacy).expect("legacy payload parses");
        assert_eq!(record.current_epoch, 1, "the union still freezes");
        assert!(record.entries.iter().all(|e| e.epoch == 0));
        assert!(
            record.can_redo(),
            "claude's stored bit survives — its admission never consults it: {record:?}"
        );
    }

    /// F8 delay-compat (delta-r1): a record written BEFORE the epoch fields
    /// existed parses with `epoch: 0` / `currentEpoch: 0` (serde defaults — the
    /// schema version stays 1).
    #[test]
    fn pre_epoch_records_parse_to_epoch_zero() {
        let legacy = json!({
            "version": 1,
            "lastOpAtMs": 50,
            "redoDestroyed": false,
            "canRedo": true,
            "entries": [{
                "removedTurns": [{ "id": "t1", "turnId": "t1", "role": "user" }],
                "promptText": "p1",
                "atMs": 40,
            }],
        });
        let record: RollbackRecord = serde_json::from_value(legacy).expect("pre-epoch JSON parses");
        assert_eq!(record.current_epoch, 0);
        assert_eq!(record.entries.len(), 1);
        assert_eq!(record.entries[0].epoch, 0);
    }

    /// F6 (delta-r1): the snapshot's rollback block lists the redoable per-marker
    /// gate — the EXACT user-role turn ids of the CURRENT epoch's entries (the
    /// tail of the marker bucket), never frozen prior-epoch ids.
    #[test]
    fn stamp_rollback_snapshot_lists_only_current_epoch_user_ids_as_redoable() {
        let mut record = RollbackRecord::empty(50);
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t4", "user"), marker_turn("a4", "assistant")],
                prompt_text: "p4".into(),
                at_ms: 60,
                epoch: 0,
            },
            60,
        );
        record.destroy_redo(61);
        record.redo_destroyed = false;
        record.begin_new_epoch();
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("n1", "user"), marker_turn("b1", "assistant")],
                prompt_text: "pn1".into(),
                at_ms: 70,
                epoch: 1,
            },
            70,
        );
        record.set_can_redo(true, 71);
        let mut snapshot = json!({ "revision": 7 });
        stamp_rollback_snapshot(&mut snapshot, 7, &record, true);
        assert_eq!(
            snapshot["rollback"]["redoableTurnIds"],
            json!(["n1"]),
            "only the CURRENT epoch's user-row ids gate the per-marker redo affordance \
             (the assistant row of a step is never a click target; the frozen epoch is not)"
        );
    }

    /// F6 (delta-r1): when redo is unavailable the redoable set is EMPTY (a
    /// frozen-only bucket — or codex's undo-only false bit — renders no per-marker
    /// redo affordance).
    #[test]
    fn stamp_rollback_snapshot_redoable_ids_are_empty_when_redo_is_unavailable() {
        let mut record = RollbackRecord::empty(50);
        record.splice_undo_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("t4", "user")],
                prompt_text: "p4".into(),
                at_ms: 60,
                epoch: 0,
            },
            60,
        );
        record.set_can_redo(false, 61);
        let mut snapshot = json!({ "revision": 7 });
        stamp_rollback_snapshot(&mut snapshot, 7, &record, false);
        assert_eq!(
            snapshot["rollback"]["redoableTurnIds"],
            json!([]),
            "canRedo:false ⇒ no marker is redoable, even in the current epoch"
        );
    }

    #[test]
    fn can_redo_is_a_stored_bit_and_destroy_aware() {
        let mut record = RollbackRecord::empty(50);
        assert!(!record.can_redo(), "a fresh record has nothing to redo");
        record.set_can_redo(true, 60);
        assert!(
            record.can_redo(),
            "the provider-stamped bit is the only source (stored at write time; never entries-derived)"
        );
        record.destroy_redo(70);
        assert!(!record.can_redo(), "destroyed redo never revives");
        assert!(!record.can_redo, "destroy also clears the stored bit");
        assert_eq!(
            record.last_op_at_ms, 70,
            "every op lifts the revision floor"
        );
    }

    #[test]
    fn record_round_trips_through_json() {
        let mut record = RollbackRecord::empty(50);
        record.original_session_id = Some("orig-uuid".into());
        record.original_tip_uuid = Some("tip-uuid".into());
        record.push_entry(entry("1"), 60);
        record.set_can_redo(true, 61);
        let v = serde_json::to_value(&record).expect("serialize");
        let back: RollbackRecord = serde_json::from_value(v).expect("deserialize");
        assert_eq!(record, back);
    }

    // ── destroy_redo_on_submit (kata 1wxv decision 5) ───────────────────────

    fn fake_sink_with(
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> std::sync::Arc<crate::identity_sink::FakeIdentitySink> {
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink.rollbacks
            .lock()
            .unwrap()
            .insert((provider.to_string(), session_id.to_string()), record);
        sink
    }

    // ── stamp_rollback_snapshot (kata 1wxv Task 5) ──────────────────────────

    fn marker_turn(id: &str, role: &str) -> Value {
        json!({
            "id": id,
            "turnId": id,
            "ordinal": 0,
            "source": "durable",
            "role": role,
            "summary": format!("{id} summary"),
            "items": [{ "id": format!("{id}-i0"), "kind": "text", "text": id }],
        })
    }

    #[test]
    fn stamp_rollback_snapshot_stamps_markers_at_read_time_and_counts_user_steps() {
        let mut record = RollbackRecord::empty(50);
        record.push_entry(
            RollbackEntry {
                removed_turns: vec![marker_turn("u2", "user"), marker_turn("a2", "assistant")],
                prompt_text: "prompt two".into(),
                at_ms: 90,
                epoch: 0,
            },
            100,
        );
        let mut snapshot = json!({ "revision": 7 });
        let floored = stamp_rollback_snapshot(&mut snapshot, 7, &record, true);
        assert_eq!(
            floored, 100,
            "the record's lastOpAtMs is the revision floor"
        );
        let bucket = snapshot["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 2);
        assert!(
            bucket.iter().all(|t| t["rolledBack"] == json!(true)),
            "`rolledBack:true` is stamped AT READ — the stored verbatim turn JSON is untouched"
        );
        // The STORED entry JSON must not have been mutated by the read stamp.
        assert!(record.entries[0].removed_turns[0]
            .get("rolledBack")
            .is_none());
        assert_eq!(
            snapshot["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["u2"] }),
            "undoneDepth is the USER-role step count of the bucket (u2), never rows.len(); \
             F6: the redoable set lists the current epoch's user-row ids"
        );
    }

    #[test]
    fn stamp_rollback_snapshot_omits_the_keys_for_an_empty_union_but_still_floors() {
        let record = RollbackRecord::empty(50);
        let mut snapshot = json!({ "revision": 7 });
        let floored = stamp_rollback_snapshot(&mut snapshot, 7, &record, false);
        assert_eq!(floored, 50, "the floor applies with or without markers");
        assert!(
            snapshot.get("rolledBackTurns").is_none(),
            "the strict-contract key stays OPTIONAL — an empty union inserts nothing"
        );
        assert!(snapshot.get("rollback").is_none());
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_marks_redo_destroyed_and_keeps_the_markers() {
        let sink = fake_sink_with("codex", "s1", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s1", 100).await;
        assert!(
            outcome.is_none(),
            "a live write answers no error: {outcome:?}"
        );
        let record = sink.load_rollback("codex", "s1").expect("record survives");
        assert!(
            record.redo_destroyed,
            "decision 5: the submission killed redo"
        );
        assert!(
            !record.can_redo(),
            "destroy also clears the stored can_redo bit"
        );
        assert_eq!(
            record.last_op_at_ms, 100,
            "the destroy lifts the revision floor"
        );
        assert_eq!(
            record.entries.len(),
            1,
            "decision 6: the r3 marker union is NEVER touched by a destroy"
        );
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_is_a_no_op_without_a_record_or_with_nothing_to_destroy() {
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s-absent", 100).await;
        assert!(outcome.is_none());
        assert!(
            sink.rollbacks.lock().unwrap().is_empty(),
            "no phantom rollback row is written for a session that never rolled back"
        );

        // An empty FRESH record (e.g. claude pre-first-undo shape) is also a no-op.
        let sink = fake_sink_with("codex", "s-empty", RollbackRecord::empty(50));
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s-empty", 100).await;
        assert!(outcome.is_none());
        let record = sink.load_rollback("codex", "s-empty").expect("record");
        assert!(!record.redo_destroyed, "nothing to destroy — untouched");
        assert_eq!(record.last_op_at_ms, 50, "a no-op lifts nothing");
    }

    #[tokio::test]
    async fn destroy_redo_on_submit_is_idempotent_once_destroyed() {
        let sink = fake_sink_with("codex", "s2", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.destroy_redo(70);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_on_submit(&Some(shared), "codex", "s2", 100).await;
        assert!(outcome.is_none());
        let record = sink.load_rollback("codex", "s2").expect("record");
        assert!(
            record.redo_destroyed && record.last_op_at_ms == 70,
            "a second destroy is a true no-op (no rewrite, no restamp)"
        );
    }

    // ── destroy_redo_before_compact_drive + restore_redo_on_undelivered_compact (F4, ep1-r3 F2) ──

    #[tokio::test]
    async fn destroy_redo_before_compact_drive_retires_redo_and_hands_back_the_pre_record() {
        let sink = fake_sink_with("opencode", "s1", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let pre = destroy_redo_before_compact_drive(&Some(shared), "opencode", "s1", 100)
            .await
            .expect("a live write answers Ok")
            .expect("a redo-capable row yields its pre-record");
        assert!(
            !pre.redo_destroyed && pre.can_redo(),
            "the pre-record was live"
        );
        assert_eq!(pre.last_op_at_ms, 61);
        let record = sink.load_rollback("opencode", "s1").expect("record");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "the drive now exists with canRedo already false in memory + persisted: {record:?}"
        );
        assert_eq!(record.entries.len(), 1, "decision 6: markers untouched");

        // Idempotence/no-op legs: already-destroyed, absent, unsinked, empty.
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        assert!(
            destroy_redo_before_compact_drive(&Some(shared), "opencode", "s1", 101)
                .await
                .expect("ok")
                .is_none(),
            "an already-destroyed row is a no-op (no pre-record to restore)"
        );
        assert!(destroy_redo_before_compact_drive(
            &Some(sink.clone()),
            "opencode",
            "s-absent",
            101
        )
        .await
        .expect("ok")
        .is_none());
        assert!(
            destroy_redo_before_compact_drive(&None, "opencode", "s1", 101)
                .await
                .expect("ok")
                .is_none()
        );
    }

    #[tokio::test]
    async fn destroy_redo_before_compact_drive_surfaces_a_ledger_failure_and_writes_nothing() {
        let sink = fake_sink_with("opencode", "s1", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        sink.set_fail_writes(true);
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = destroy_redo_before_compact_drive(&Some(shared), "opencode", "s1", 100).await;
        assert!(
            outcome.is_err(),
            "the write failure surfaces to the caller (ep2-r1 F2: the compact is then REFUSED — zero provider traffic)"
        );
        let record = sink.load_rollback("opencode", "s1").expect("record");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "a failed destroy never touches the row — redo stays live (the caller's refusal keeps the row true)"
        );
    }

    #[tokio::test]
    async fn restore_redo_on_undelivered_compact_restores_only_the_row_this_destroy_wrote() {
        let sink = fake_sink_with("opencode", "s1", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let pre = destroy_redo_before_compact_drive(&Some(shared), "opencode", "s1", 100)
            .await
            .expect("ok")
            .expect("pre-record");

        // The row stands EXACTLY as our destroy left it: the ep1-r3 F2
        // provably-undelivered leg restores the pre-record (redo lives again)
        // without letting the revision floor regress below the destroy stamp.
        let shared: crate::identity_sink::SharedPaneIdentitySink = sink.clone();
        let outcome = restore_redo_on_undelivered_compact(
            &Some(shared),
            "opencode",
            "s1",
            pre.clone(),
            100,
            110,
        )
        .await;
        assert!(outcome.is_none(), "a live restore answers no error");
        let record = sink.load_rollback("opencode", "s1").expect("record");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "the restored row revives redo — the POST provably never reached the serve: {record:?}"
        );
        assert_eq!(
            record.last_op_at_ms, 110,
            "the floor never regresses below the restore's stamp"
        );

        // A row touched SINCE our destroy (here: a later op re-destroyed at a
        // newer stamp — equality is exact, so ANY rewrite counts) survives
        // untouched: the newer truth stands, redo is never revived over it.
        let sink2 = fake_sink_with("opencode", "s2", {
            let mut r = RollbackRecord::empty(50);
            r.push_entry(entry("1"), 60);
            r.set_can_redo(true, 61);
            r
        });
        let shared2: crate::identity_sink::SharedPaneIdentitySink = sink2.clone();
        let pre2 = destroy_redo_before_compact_drive(&Some(shared2), "opencode", "s2", 100)
            .await
            .expect("ok")
            .expect("pre-record");
        {
            // The post-destroy op writes its own row (the exact-equality guard's target).
            let mut later = sink2.load_rollback("opencode", "s2").expect("row");
            later.destroy_redo(105);
            crate::identity_sink::PaneIdentitySink::record_rollback(
                sink2.as_ref(),
                "opencode",
                "s2",
                later,
            )
            .await
            .expect("write ok");
        }
        let shared2c: crate::identity_sink::SharedPaneIdentitySink = sink2.clone();
        let outcome = restore_redo_on_undelivered_compact(
            &Some(shared2c),
            "opencode",
            "s2",
            pre2.clone(),
            100,
            110,
        )
        .await;
        assert!(
            outcome.is_none(),
            "a skipped restore is silent, never an error"
        );
        let record = sink2.load_rollback("opencode", "s2").expect("record");
        assert!(
            record.redo_destroyed && record.last_op_at_ms == 105,
            "the later op's row is never rewound — the restore skipped: {record:?}"
        );

        // A DELETED row is also "changed" (never re-created by a restore).
        crate::identity_sink::PaneIdentitySink::delete_rollback(sink2.as_ref(), "opencode", "s2")
            .await
            .expect("delete ok");
        let shared2d: crate::identity_sink::SharedPaneIdentitySink = sink2.clone();
        let outcome =
            restore_redo_on_undelivered_compact(&Some(shared2d), "opencode", "s2", pre2, 100, 110)
                .await;
        assert!(outcome.is_none());
        assert!(
            sink2.load_rollback("opencode", "s2").is_none(),
            "a deleted row is never resurrected by a restore"
        );
    }
}

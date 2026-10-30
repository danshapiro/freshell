//! Pure OpenCode ownership tracker — Rust port of the Node reducer
//! (`server/coding-cli/opencode-ownership-reducer.ts`, plus decisions D1–D6
//! of `docs/plans/2026-08-03-opencode-attention-bell.md`).
//!
//! Policy: OpenCode terminal panes ring the attention bell exactly like
//! codex — bells on real turn ends only. Failed turns ring like completed
//! turns; human aborts clear busy silently (D1); ambiguous ownership stays
//! conservatively silent; child sessions never gate the root's turn edges
//! (D5); `retry` status is busy (D6). Protocol facts derive from opencode
//! 1.18.11 (live spike /tmp/opencode-spike/).
//!
//! The tracker is a pure, timer-free, RESOLVER-FREE state machine (no IO,
//! no tokio): the hub owns time and transport, and recovery of session ids
//! never seen on-stream is the LANE's job — the HTTP root-resolver fallback
//! (Task 9) emits synthetic [`OpencodeActivityTracker::note_session_created`]
//! calls before the triggering event, so by the time an event reaches this
//! tracker the child→root mapping either exists or the conservative
//! ambiguity rules apply.
//!
//! `OpencodePhase::Busy` is the ONLY phase on the wire: not-busy == record
//! absence. Record dedupe compares phase + session only (like codex
//! `has_public_change`) — a deliberate, documented divergence from Node's
//! timestamp-sensitive dedupe, so repeated busy events don't spam frames.

use std::collections::{HashMap, HashSet};

use freshell_protocol::TerminalTurnOutcome;
use freshell_protocol::{OpencodeActivityRecord, OpencodePhase};

use crate::ledger::TurnCompletionLedger;
use crate::TrackerEffect;

/// Mirrors Node `OPENCODE_BUSY_DEADMAN_MS` (`opencode-activity-tracker.ts`).
pub const OPENCODE_BUSY_DEADMAN_MS: i64 = 120_000;

pub type OpencodeEffect = TrackerEffect<OpencodeActivityRecord>;

/// Session status vocabulary from `/session/status` and the SSE
/// `session.status` events. `Retry` is busy everywhere (D6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpencodeStatus {
    Busy,
    Retry,
    Idle,
}

/// Per-terminal ownership machine (port of `OpencodeOwnershipState`).
#[derive(Debug, Clone, PartialEq)]
enum Ownership {
    /// No turn in flight; `known_session_id` is the confirmed identity.
    Quiet { known_session_id: Option<String> },
    /// An unconfirmed session is busy (no binding yet). Its completion is
    /// DEFERRED to `bind_session` (`AwaitingAssociation`).
    Candidate {
        session_id: String,
        previous_known: Option<String>,
        cycle: u64,
        stream: u64,
        turn_aborted: bool,
    },
    /// The confirmed session is busy. `turn_aborted` is the per-turn abort
    /// gate (D1): a consumed abort clears busy silently.
    KnownBusy {
        session_id: String,
        cycle: u64,
        stream: u64,
        turn_aborted: bool,
    },
    /// A candidate turn ended; the completion waits for identity proof.
    AwaitingAssociation {
        session_id: String,
        previous_known: Option<String>,
        completed_at: i64,
        aborted: bool,
    },
    /// Multiple busy root sessions: conservative silence (residual D8(a)).
    Ambiguous {
        known_session_id: Option<String>,
        blocked: Vec<String>,
    },
}

/// Per-terminal state.
#[derive(Debug)]
struct TerminalOpencode {
    terminal_id: String,
    ownership: Ownership,
    /// session id -> root session id (built from session.created parentID;
    /// self-mapped roots). Retained for the session's lifetime (D5).
    session_roots: HashMap<String, String>,
    /// Pending permission ids (Task 7).
    pending_permissions: HashSet<String>,
    /// A structured provider error observed for the currently owned turn.
    turn_failed: bool,
    /// Present == busy on the wire (`OpencodePhase::Busy` is the only phase).
    record: Option<OpencodeActivityRecord>,
    last_observed_at: i64,
}

/// Upsert the busy record. Emits a `Changed` frame only when the public
/// shape changed — phase + session only, like codex `has_public_change`
/// (deliberate divergence from Node's timestamp-sensitive dedupe).
fn set_busy_record(
    state: &mut TerminalOpencode,
    session_id: Option<String>,
    at: i64,
) -> Vec<OpencodeEffect> {
    let next = OpencodeActivityRecord {
        terminal_id: state.terminal_id.clone(),
        phase: OpencodePhase::Busy,
        updated_at: at,
        session_id,
    };
    let changed = match &state.record {
        Some(prev) => prev.session_id != next.session_id,
        None => true,
    };
    state.record = Some(next.clone());
    if changed {
        vec![TrackerEffect::Changed {
            upsert: vec![next],
            remove: vec![],
        }]
    } else {
        Vec::new()
    }
}

/// Drop the busy record; `force` emits the remove frame even when no record
/// was present (Task 7's mid-pause abort path).
fn clear_record(state: &mut TerminalOpencode, force: bool) -> Vec<OpencodeEffect> {
    if state.record.take().is_none() && !force {
        return Vec::new();
    }
    vec![TrackerEffect::Changed {
        upsert: vec![],
        remove: vec![state.terminal_id.clone()],
    }]
}

/// Walk `session_roots` to the root with a seen-set cycle guard; an unknown
/// id resolves to itself (mirror of Node `resolveKnownRoot` + the callers'
/// `?? sessionId` fallback).
fn resolve_root<'a>(state: &'a TerminalOpencode, session_id: &'a str) -> &'a str {
    let mut current = session_id;
    let mut seen: HashSet<&str> = HashSet::new();
    while seen.insert(current) {
        match state.session_roots.get(current) {
            Some(next) if next.as_str() != current => current = next,
            _ => return current,
        }
    }
    // Cycle: conservative fallback to the raw id.
    session_id
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn terminal_outcome(failed: bool) -> TerminalTurnOutcome {
    if failed {
        TerminalTurnOutcome::Failed
    } else {
        TerminalTurnOutcome::Completed
    }
}

/// Ownership + turn-edge tracker for OpenCode terminal panes.
#[derive(Debug)]
pub struct OpencodeActivityTracker {
    states: HashMap<String, TerminalOpencode>,
    ledger: TurnCompletionLedger,
    /// Busy-deadman window; [`OPENCODE_BUSY_DEADMAN_MS`] in production.
    /// Test-scale hook, same shape as the codex tracker's.
    busy_deadman_ms: i64,
}

impl Default for OpencodeActivityTracker {
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            ledger: TurnCompletionLedger::default(),
            busy_deadman_ms: OPENCODE_BUSY_DEADMAN_MS,
        }
    }
}

impl OpencodeActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-scale hook: override the busy-deadman window.
    pub fn set_busy_deadman_ms(&mut self, ms: i64) {
        self.busy_deadman_ms = ms;
    }

    /// Busy records only — record absence IS the idle representation.
    pub fn list(&self) -> Vec<OpencodeActivityRecord> {
        self.states
            .values()
            .filter_map(|state| state.record.clone())
            .collect()
    }

    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot> {
        self.ledger.list_latest_completions()
    }

    /// Restore a historical observation snapshot without importing its old
    /// completion ledger or emitting attention for already-finished turns.
    pub fn seed_terminal_from_history(
        &mut self,
        terminal_id: &str,
        mut history: Self,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Some(mut state) = history.states.remove(terminal_id) else {
            return Vec::new();
        };
        if let Ownership::AwaitingAssociation { previous_known, .. } = &state.ownership {
            // Retire the ended episode's pause with its deferred completion:
            // neither may affect a later live turn or spontaneous exit.
            state.pending_permissions.clear();
            state.ownership = Ownership::Quiet {
                known_session_id: previous_known.clone(),
            };
        }
        state.last_observed_at = at;
        let upsert: Vec<_> = state.record.clone().into_iter().collect();
        let remove = if upsert.is_empty() {
            vec![terminal_id.to_owned()]
        } else {
            Vec::new()
        };
        self.states.insert(terminal_id.to_owned(), state);
        vec![TrackerEffect::Changed { upsert, remove }]
    }

    /// Create-or-reset the terminal's state (tracking starts at create).
    pub fn track_terminal(
        &mut self,
        terminal_id: &str,
        session_id: Option<&str>,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        if let Some(state) = self.states.get_mut(terminal_id) {
            state.ownership = Ownership::Quiet {
                known_session_id: session_id.map(str::to_string),
            };
            state.session_roots.clear();
            state.pending_permissions.clear();
            state.turn_failed = false;
            state.last_observed_at = at;
            // A stale record from the previous incarnation is removed.
            return clear_record(state, false);
        }
        self.states.insert(
            terminal_id.to_string(),
            TerminalOpencode {
                terminal_id: terminal_id.to_string(),
                ownership: Ownership::Quiet {
                    known_session_id: session_id.map(str::to_string),
                },
                session_roots: HashMap::new(),
                pending_permissions: HashSet::new(),
                turn_failed: false,
                record: None,
                last_observed_at: at,
            },
        );
        Vec::new()
    }

    /// Association/rebind identity from the SQLite locator or the TUI rebind
    /// plugin (Task 10 wires the producers).
    pub fn bind_session(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Self { states, ledger, .. } = self;
        let Some(state) = states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state
            .session_roots
            .insert(session_id.to_string(), session_id.to_string());
        match state.ownership.clone() {
            Ownership::AwaitingAssociation {
                session_id: own,
                completed_at,
                aborted,
                ..
            } if own == session_id => {
                state.ownership = Ownership::Quiet {
                    known_session_id: Some(own.clone()),
                };
                if aborted {
                    return Vec::new();
                }
                if !state.pending_permissions.is_empty() {
                    // Mid-pause turn end: the pause was the episode's bell —
                    // the deferred completion is swallowed (D3).
                    state.pending_permissions.clear();
                    return Vec::new();
                }
                // DEFERRED completion (Node confirmOpencodeAssociation):
                // stamped at the STORED turn-end instant, not the bind's.
                let seq = ledger.record_turn_completion(&state.terminal_id, completed_at);
                let outcome = terminal_outcome(state.turn_failed);
                state.turn_failed = false;
                vec![TrackerEffect::TurnComplete {
                    terminal_id: state.terminal_id.clone(),
                    session_id: Some(own),
                    at: completed_at,
                    completion_seq: seq,
                    outcome: Some(outcome),
                    outcome_update: false,
                }]
            }
            Ownership::AwaitingAssociation { previous_known, .. } => {
                // Reject analog: the ended turn belonged to someone else.
                // A surviving candidate pause claim (D3) is STALE here —
                // without its confirm-swallow it would swallow the next
                // turn's completion and leak into the death-bell window
                // (Quiet never blocks). Retire it.
                state.pending_permissions.clear();
                state.ownership = Ownership::Quiet {
                    known_session_id: previous_known,
                };
                Vec::new()
            }
            Ownership::Ambiguous { blocked, .. } => {
                // Adoption assist: the next snapshot resolves it.
                state.ownership = Ownership::Ambiguous {
                    known_session_id: Some(session_id.to_string()),
                    blocked,
                };
                Vec::new()
            }
            Ownership::Quiet { .. } => {
                state.ownership = Ownership::Quiet {
                    known_session_id: Some(session_id.to_string()),
                };
                Vec::new()
            }
            Ownership::Candidate {
                session_id: own,
                cycle,
                stream,
                turn_aborted,
                ..
            } if own == session_id => {
                // Identity proof arrived mid-turn: promote in place.
                state.ownership = Ownership::KnownBusy {
                    session_id: own.clone(),
                    cycle,
                    stream,
                    turn_aborted,
                };
                set_busy_record(state, Some(own), at)
            }
            Ownership::Candidate {
                session_id: own,
                cycle,
                stream,
                turn_aborted,
                ..
            } => {
                state.ownership = Ownership::Candidate {
                    session_id: own,
                    previous_known: Some(session_id.to_string()),
                    cycle,
                    stream,
                    turn_aborted,
                };
                Vec::new()
            }
            // Identity already flowing.
            Ownership::KnownBusy { .. } => Vec::new(),
        }
    }

    /// `session.created`: fold the parentID chain into `session_roots`.
    pub fn note_session_created(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        parent_id: Option<&str>,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        match parent_id {
            Some(parent) => {
                let root = resolve_root(state, parent).to_string();
                state.session_roots.insert(parent.to_string(), root.clone());
                state
                    .session_roots
                    .insert(session_id.to_string(), root.clone());
                // Adoption assist (Node session.created analog): an unowned
                // ambiguity adopts the root; the next snapshot resolves.
                if let Ownership::Ambiguous {
                    known_session_id: known @ None,
                    ..
                } = &mut state.ownership
                {
                    *known = Some(root);
                }
            }
            None => {
                state
                    .session_roots
                    .insert(session_id.to_string(), session_id.to_string());
            }
        }
        Vec::new()
    }

    /// `session.status` SSE edge (busy | retry | idle).
    pub fn note_status(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        status: OpencodeStatus,
        cycle: u64,
        stream: u64,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Self { states, ledger, .. } = self;
        let Some(state) = states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        let root = resolve_root(state, session_id).to_string();
        match status {
            OpencodeStatus::Idle => {
                if root != session_id {
                    // Child idle is SUPPRESSED (D5): only the root's own
                    // idle ends the root's turn.
                    return Vec::new();
                }
                reduce_idle_edge(state, ledger, &root, cycle, stream, at)
            }
            // Child busy remaps to the root; retry is busy (D6).
            OpencodeStatus::Busy | OpencodeStatus::Retry => {
                reduce_busy_edge(state, &root, cycle, stream, at)
            }
        }
    }

    /// `session.idle` SSE edge (the deprecated twin of `session.status{idle}`).
    pub fn note_session_idle(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        cycle: u64,
        stream: u64,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        // Same routing as a status idle edge; dedupe is structural (D2):
        // the first edge lands the machine in Quiet, the twin no-ops.
        self.note_status(
            terminal_id,
            session_id,
            OpencodeStatus::Idle,
            cycle,
            stream,
            at,
        )
    }

    /// `/session/status` snapshot (absence == idle; a literal idle entry is
    /// treated as absent).
    pub fn note_snapshot(
        &mut self,
        terminal_id: &str,
        statuses: &[(String, OpencodeStatus)],
        cycle: u64,
        stream: u64,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Self { states, ledger, .. } = self;
        let Some(state) = states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        let busy_roots = collapse_busy_roots(state, statuses);
        reduce_snapshot(state, ledger, busy_roots, cycle, stream, at)
    }

    /// `session.error` — and Task 9's abort-marked `message.updated`, which
    /// the lane translates into this SAME SessionError-shaped call (abort
    /// window W2, derives from opencode 1.18.11). Only `MessageAbortedError`
    /// on the owned root's OWN turn (matching id+cycle+stream) arms the
    /// per-turn abort gate (D1); other structured errors mark the owned turn
    /// failed. Trailing errors on quiet states change nothing. Child
    /// `session.error` is ignored: the raw sessionID must equal the owned
    /// root, no root-remapping for aborts (D5). No effects, ever.
    pub fn note_error(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        error_name: &str,
        cycle: u64,
        stream: u64,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        if resolve_root(state, session_id) != session_id {
            return Vec::new();
        }
        match &mut state.ownership {
            Ownership::KnownBusy {
                session_id: own,
                cycle: c,
                stream: st,
                turn_aborted,
            }
            | Ownership::Candidate {
                session_id: own,
                cycle: c,
                stream: st,
                turn_aborted,
                ..
            } if own.as_str() == session_id && *c == cycle && *st == stream => {
                if error_name == "MessageAbortedError" {
                    *turn_aborted = true;
                } else {
                    state.turn_failed = true;
                }
            }
            _ => {}
        }
        Vec::new()
    }

    /// `permission.asked`: the turn pauses on a human. Children CAN ask —
    /// the event is stamped with the CHILD session id while the parent turn
    /// blocks on it (opencode 1.18.11, validation pass 2026-08-03) — so the
    /// asker is root-resolved first. Arms when the resolved root is the
    /// owned session under `KnownBusy` OR `Candidate` (candidate arming,
    /// D3: the single busy unbound session on the pane's own per-pane
    /// endpoint — first-turn asks must ring). Foreign/unresolvable ids and
    /// Quiet/Ambiguous/AwaitingAssociation states are no-ops. Only a NEWLY
    /// inserted permission id arms — a duplicate asked never re-arms.
    /// Effect ORDER is load-bearing (D7): record removal FIRST (demote),
    /// attention boundary SECOND.
    pub fn note_permission_asked(
        &mut self,
        terminal_id: &str,
        session_id: &str,
        permission_id: &str,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        let root = resolve_root(state, session_id).to_string();
        let owned = match &state.ownership {
            Ownership::KnownBusy {
                session_id: own, ..
            }
            | Ownership::Candidate {
                session_id: own, ..
            } => *own == root,
            _ => false,
        };
        if !owned {
            return Vec::new();
        }
        let newly_inserted = state.pending_permissions.insert(permission_id.to_string());
        if !newly_inserted {
            return Vec::new();
        }
        let mut effects = clear_record(state, false);
        effects.push(TrackerEffect::AttentionBoundary {
            terminal_id: state.terminal_id.clone(),
            at,
        });
        effects
    }

    /// `permission.replied`: the pause ends. Unknown ids are no-ops. When
    /// the LAST pending id clears and the turn is still owned
    /// (`KnownBusy`/`Candidate`), the busy record is restored immediately —
    /// busy cancels the armed gate window via `note_phase(Busy)` in the
    /// frame mapper.
    pub fn note_permission_replied(
        &mut self,
        terminal_id: &str,
        permission_id: &str,
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.last_observed_at = at;
        if !state.pending_permissions.remove(permission_id) {
            return Vec::new();
        }
        if !state.pending_permissions.is_empty() {
            return Vec::new();
        }
        match state.ownership.clone() {
            Ownership::KnownBusy { session_id, .. } | Ownership::Candidate { session_id, .. } => {
                set_busy_record(state, Some(session_id), at)
            }
            _ => Vec::new(),
        }
    }

    /// #608 reconciliation: the fetched pending sets (GET /permission +
    /// GET /question) are authoritative — a locally-pending ask id
    /// absent from them was drained WITHOUT events (instance dispose,
    /// opencode permission/index.ts:54-61 / question/index.ts:74-81).
    /// Treat each stale id as replied at `at` (the same drain path), so
    /// a pause can never wedge. Deterministic: a pure set difference
    /// against the fetched listing; no timers, no guesses.
    pub fn note_permissions_synced(
        &mut self,
        terminal_id: &str,
        pending_ids: &[String],
        at: i64,
    ) -> Vec<OpencodeEffect> {
        let stale: Vec<String> = {
            let Some(state) = self.states.get(terminal_id) else {
                return Vec::new();
            };
            state
                .pending_permissions
                .iter()
                .filter(|id| !pending_ids.contains(*id))
                .cloned()
                .collect()
        };
        let mut effects = Vec::new();
        for id in stale {
            effects.extend(self.note_permission_replied(terminal_id, &id, at));
        }
        effects
    }

    /// Death-bell engagement extension (D4): a pane blocked on a permission
    /// whose process dies spontaneously must ring. Read by the hub's Exit
    /// arm BEFORE `note_exit` (audit-A17 ordering, same as codex).
    pub fn has_pending_permissions(&self, terminal_id: &str) -> bool {
        self.states
            .get(terminal_id)
            .map(|s| !s.pending_permissions.is_empty())
            .unwrap_or(false)
    }

    /// Candidate/ambiguous ownership never death-rings (D4): unconfirmed
    /// identity stays conservatively silent even with a candidate-armed
    /// pause pending. `AwaitingAssociation` is the candidate pause's
    /// continuation (the claim survives into it, D3), so it blocks too.
    pub fn blocks_death_bell(&self, terminal_id: &str) -> bool {
        self.states
            .get(terminal_id)
            .map(|s| {
                matches!(
                    s.ownership,
                    Ownership::Candidate { .. }
                        | Ownership::Ambiguous { .. }
                        | Ownership::AwaitingAssociation { .. }
                )
            })
            .unwrap_or(false)
    }

    /// PTY exit: drop the whole state (`pending_permissions` goes with it —
    /// the hub reads [`Self::has_pending_permissions`] BEFORE calling this).
    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<OpencodeEffect> {
        match self.states.remove(terminal_id) {
            Some(state) if state.record.is_some() => vec![TrackerEffect::Changed {
                upsert: vec![],
                remove: vec![terminal_id.to_string()],
            }],
            _ => Vec::new(),
        }
    }

    /// The deadman verify probe itself failed (serve unreachable, snapshot
    /// endpoint broken). Owner ruling (2026-08-05): treat as
    /// crash/needs-attention — clear busy AND fire the attention/death
    /// engagement signal. Deterministic; never a silent clear, never an
    /// "unknown" state. Ownership resets to Quiet (keeping the confirmed
    /// identity when there is one) so a later reconnect re-establishes
    /// cleanly; the pending-permission set is retired with the episode.
    pub fn note_verify_failed(&mut self, terminal_id: &str, at: i64) -> Vec<OpencodeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let had_record = state.record.is_some();
        let had_pause = !state.pending_permissions.is_empty();
        if !had_record && !had_pause {
            return Vec::new(); // nothing to correct
        }
        tracing::error!(
            component = "opencode-activity-tracker",
            event = "opencode_verify_failed",
            terminal_id = %state.terminal_id,
            "opencode verify probe failed; clearing busy and ringing attention (owner ruling: probe failure = crash)"
        );
        state.pending_permissions.clear();
        let known = match &state.ownership {
            Ownership::Quiet { known_session_id } => known_session_id.clone(),
            Ownership::KnownBusy { session_id, .. } => Some(session_id.clone()),
            Ownership::Candidate { previous_known, .. }
            | Ownership::AwaitingAssociation { previous_known, .. } => previous_known.clone(),
            Ownership::Ambiguous {
                known_session_id, ..
            } => known_session_id.clone(),
        };
        state.ownership = Ownership::Quiet {
            known_session_id: known,
        };
        // Force the remove even when the record is already absent (a
        // mid-pause crash must cancel the armed pause window on the gate),
        // then arm the attention boundary — D7 order: remove FIRST.
        let mut effects = clear_record(state, true);
        effects.push(TrackerEffect::AttentionBoundary {
            terminal_id: state.terminal_id.clone(),
            at,
        });
        effects
    }

    /// Busy-deadman sweep — verify-then-decide (#603). Silence past the
    /// window no longer drops the record: it emits a verify request
    /// (`ForceRead`) and STAYS busy; the hub answers by re-fetching
    /// `/session/status` through the lane, and the snapshot reducer
    /// decides (busy → refreshed, empty → cleared WITH completion gating,
    /// probe failure → [`Self::note_verify_failed`]). `last_observed_at`
    /// re-arms here so a wedged verify cannot hot-loop (the codex
    /// anchor-disarm lesson, codex.rs:49-53).
    ///
    /// Turn-start gap note (source-verified opencode v1.18.14): the serve
    /// registers busy only at runLoop start (prompt.ts:1089), a beat
    /// after prompt accept — but a LIT pane cannot false-green from that
    /// gap: lighting this record required a busy publish, which implies
    /// status-map membership, and removal from the map implies an idle
    /// publish (the turn truly ended). Empty snapshot ⇒
    /// clear-with-completion is therefore sound for lit panes.
    pub fn expire(&mut self, at: i64) -> Vec<OpencodeEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            if state.record.is_some() && at - state.last_observed_at > self.busy_deadman_ms {
                state.last_observed_at = at;
                effects.push(TrackerEffect::ForceRead {
                    terminal_id: state.terminal_id.clone(),
                    at,
                });
            }
        }
        effects
    }

    /// Earliest future instant at which [`Self::expire`] could change state.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter(|state| state.record.is_some())
            .map(|state| state.last_observed_at + self.busy_deadman_ms)
            .min()
    }
}

/// Idle-edge reducer (`session.idle` or `session.status{idle}`), with
/// cycle/stream guards exactly like Node `sameSessionStream`. `session_id`
/// is already root-resolved.
fn reduce_idle_edge(
    state: &mut TerminalOpencode,
    ledger: &mut TurnCompletionLedger,
    session_id: &str,
    cycle: u64,
    stream: u64,
    at: i64,
) -> Vec<OpencodeEffect> {
    match state.ownership.clone() {
        Ownership::KnownBusy {
            session_id: own,
            cycle: c,
            stream: st,
            turn_aborted,
        } if own == session_id && c == cycle && st == stream => {
            state.ownership = Ownership::Quiet {
                known_session_id: Some(own.clone()),
            };
            // Mid-pause turn end: the pause was the episode's bell — NEVER
            // a second completion (D3). The record is already absent while
            // paused, so the only frame question is the abort cancel.
            if !state.pending_permissions.is_empty() {
                state.pending_permissions.clear();
                if turn_aborted {
                    // Force-emit the remove: at the gate it cancels the
                    // armed window (note_exit) — total silence.
                    return clear_record(state, true);
                }
                // Leave the armed window to fire once, or stay silent if
                // it already rang.
                return Vec::new();
            }
            // D7 ordering: remove BEFORE TurnComplete.
            let mut effects = clear_record(state, false);
            if !turn_aborted {
                let seq = ledger.record_turn_completion(&state.terminal_id, at);
                let outcome = terminal_outcome(state.turn_failed);
                state.turn_failed = false;
                effects.push(TrackerEffect::TurnComplete {
                    terminal_id: state.terminal_id.clone(),
                    session_id: Some(own),
                    at,
                    completion_seq: seq,
                    outcome: Some(outcome),
                    outcome_update: false,
                });
            }
            effects
        }
        Ownership::Candidate {
            session_id: own,
            previous_known,
            cycle: c,
            stream: st,
            turn_aborted,
        } if own == session_id && c == cycle && st == stream => {
            // Completion deferred to `bind_session`.
            state.ownership = Ownership::AwaitingAssociation {
                session_id: own,
                previous_known,
                completed_at: at,
                aborted: turn_aborted,
            };
            if turn_aborted && !state.pending_permissions.is_empty() {
                // Aborted mid-pause: same total-silence contract as the
                // KnownBusy arm — force-emit the cancel.
                state.pending_permissions.clear();
                return clear_record(state, true);
            }
            // A non-aborted pause claim SURVIVES into AwaitingAssociation
            // so the DEFERRED completion is swallowed at bind_session (D3).
            clear_record(state, false)
        }
        Ownership::Ambiguous {
            known_session_id,
            blocked,
        } if blocked.iter().any(|b| b == session_id) => {
            let blocked: Vec<String> = blocked.into_iter().filter(|b| b != session_id).collect();
            if blocked.is_empty() {
                // Draining into Quiet retires any pause claim that survived
                // the KnownBusy/Candidate → Ambiguous demotion — stale in
                // Quiet (would swallow the next turn's bell / spurious
                // death-bell).
                state.pending_permissions.clear();
                state.ownership = Ownership::Quiet { known_session_id };
                clear_record(state, false)
            } else {
                state.ownership = Ownership::Ambiguous {
                    known_session_id,
                    blocked,
                };
                set_busy_record(state, None, at)
            }
        }
        // Quiet / AwaitingAssociation / guard misses: unchanged. Quiet's
        // no-op IS the double-idle dedupe (D2).
        _ => Vec::new(),
    }
}

/// Busy-edge reducer (busy or retry — D6). `session_id` is already
/// root-resolved.
fn reduce_busy_edge(
    state: &mut TerminalOpencode,
    session_id: &str,
    cycle: u64,
    stream: u64,
    at: i64,
) -> Vec<OpencodeEffect> {
    match state.ownership.clone() {
        Ownership::Quiet { .. } => {
            // #609: busy edges reach this tracker ONLY from the pane's own
            // per-pane lane (generation/cycle/stream-guarded, root-
            // resolved), so the busy root IS the pane's session — identity
            // confirms by construction. Direct KnownBusy: first-turn asks
            // ring (KnownBusy arming), first-turn deaths are eligible, and
            // the indefinite-candidate tail cannot form. Candidate/
            // AwaitingAssociation remain for the locator/plugin bind
            // producers and defense in depth.
            state.ownership = Ownership::KnownBusy {
                session_id: session_id.to_string(),
                cycle,
                stream,
                turn_aborted: false,
            };
            state.turn_failed = false;
            set_busy_record(state, Some(session_id.to_string()), at)
        }
        Ownership::Candidate {
            session_id: own,
            previous_known,
            ..
        } => {
            if own == session_id {
                // Refresh: a new busy begins a new turn — abort gate
                // re-arms; a pause resumes out-of-band (D3).
                state.pending_permissions.clear();
                state.ownership = Ownership::Candidate {
                    session_id: own.clone(),
                    previous_known,
                    cycle,
                    stream,
                    turn_aborted: false,
                };
                state.turn_failed = false;
                set_busy_record(state, Some(own), at)
            } else {
                state.ownership = Ownership::Ambiguous {
                    known_session_id: previous_known,
                    blocked: unique_sorted(vec![own, session_id.to_string()]),
                };
                set_busy_record(state, None, at)
            }
        }
        Ownership::KnownBusy {
            session_id: own, ..
        } => {
            if own == session_id {
                // Refresh: abort gate re-arms; a pause resumes out-of-band.
                state.pending_permissions.clear();
                state.ownership = Ownership::KnownBusy {
                    session_id: own.clone(),
                    cycle,
                    stream,
                    turn_aborted: false,
                };
                state.turn_failed = false;
                set_busy_record(state, Some(own), at)
            } else {
                state.ownership = Ownership::Ambiguous {
                    known_session_id: Some(own.clone()),
                    blocked: unique_sorted(vec![own, session_id.to_string()]),
                };
                set_busy_record(state, None, at)
            }
        }
        Ownership::Ambiguous {
            known_session_id,
            mut blocked,
        } => {
            if !blocked.iter().any(|b| b == session_id) {
                blocked.push(session_id.to_string());
                blocked = unique_sorted(blocked);
            }
            state.ownership = Ownership::Ambiguous {
                known_session_id,
                blocked,
            };
            set_busy_record(state, None, at)
        }
        // Node drops busy while awaiting association.
        Ownership::AwaitingAssociation { .. } => Vec::new(),
    }
}

/// Collapse a snapshot's status list onto roots — busy child wins over idle
/// root (mirror of Node `classifyKnownSnapshotStatuses`) — then keep the
/// sorted unique busy|retry roots. A literal idle entry is treated as
/// absent (absence == idle, derives from opencode 1.18.11).
fn collapse_busy_roots(
    state: &TerminalOpencode,
    statuses: &[(String, OpencodeStatus)],
) -> Vec<String> {
    let mut collapsed: HashMap<String, OpencodeStatus> = HashMap::new();
    for (session_id, status) in statuses {
        let root = resolve_root(state, session_id).to_string();
        match collapsed.get(&root) {
            // Only a busy entry may overwrite a busy entry.
            Some(existing)
                if *existing != OpencodeStatus::Idle && *status == OpencodeStatus::Idle => {}
            _ => {
                collapsed.insert(root, *status);
            }
        }
    }
    let mut busy_roots: Vec<String> = collapsed
        .into_iter()
        .filter(|(_, status)| *status != OpencodeStatus::Idle)
        .map(|(root, _)| root)
        .collect();
    busy_roots.sort();
    busy_roots
}

/// Snapshot reducer (Node `reduceSnapshot` branch table). `busy_roots` is
/// sorted unique.
fn reduce_snapshot(
    state: &mut TerminalOpencode,
    ledger: &mut TurnCompletionLedger,
    busy_roots: Vec<String>,
    cycle: u64,
    stream: u64,
    at: i64,
) -> Vec<OpencodeEffect> {
    match state.ownership.clone() {
        Ownership::Ambiguous {
            known_session_id,
            blocked,
        } => {
            if busy_roots.is_empty() {
                // Same staleness as the idle-edge drain: a pause claim that
                // survived the demotion into Ambiguous must not land in
                // Quiet.
                state.pending_permissions.clear();
                state.ownership = Ownership::Quiet { known_session_id };
                clear_record(state, false)
            } else if busy_roots.len() == 1 {
                // #610: the snapshot's root collapse resolved the
                // ambiguity — one busy root on the pane's own endpoint
                // is the pane's session (same determinism as #609).
                // Re-promote; the pause claim (if any) stays with the
                // episode and drains via the normal D3 rules.
                let root = busy_roots[0].clone();
                state.ownership = Ownership::KnownBusy {
                    session_id: root.clone(),
                    cycle,
                    stream,
                    turn_aborted: false,
                };
                set_busy_record(state, Some(root), at)
            } else {
                // Genuinely plural busy roots: no deterministic single
                // owner (adjudicated residual — structurally
                // near-impossible on per-pane endpoints after #609).
                tracing::warn!(
                    component = "opencode-activity-tracker",
                    terminal_id = %state.terminal_id,
                    roots = busy_roots.len(),
                    "opencode pane observes multiple busy ROOT sessions; staying conservatively silent (D8(a))"
                );
                state.ownership = Ownership::Ambiguous {
                    known_session_id,
                    blocked: unique_sorted(busy_roots),
                };
                let _ = blocked;
                set_busy_record(state, None, at)
            }
        }
        Ownership::KnownBusy {
            session_id: own,
            turn_aborted,
            ..
        } => {
            if busy_roots.is_empty() {
                state.ownership = Ownership::Quiet {
                    known_session_id: Some(own.clone()),
                };
                // Mid-pause turn end: mirror of the idle-edge hardening —
                // the pause was the episode's bell, NEVER a second
                // completion (D3).
                if !state.pending_permissions.is_empty() {
                    state.pending_permissions.clear();
                    if turn_aborted {
                        return clear_record(state, true);
                    }
                    return Vec::new();
                }
                let mut effects = clear_record(state, false);
                if !turn_aborted {
                    let seq = ledger.record_turn_completion(&state.terminal_id, at);
                    let outcome = terminal_outcome(state.turn_failed);
                    state.turn_failed = false;
                    effects.push(TrackerEffect::TurnComplete {
                        terminal_id: state.terminal_id.clone(),
                        session_id: Some(own),
                        at,
                        completion_seq: seq,
                        outcome: Some(outcome),
                        outcome_update: false,
                    });
                }
                effects
            } else if busy_roots.len() == 1 && busy_roots[0] == own {
                // Busy refresh for the owned root. #608: while a pause is
                // outstanding the record stays absent and the claim stays —
                // only permission.replied (or a STREAM busy edge = genuine
                // resume) ends a pause; a snapshot is an observation, not a
                // resume. Stamps still refresh so stream guards keep
                // accepting this turn's edges.
                if state.pending_permissions.is_empty() {
                    state.ownership = Ownership::KnownBusy {
                        session_id: own.clone(),
                        cycle,
                        stream,
                        turn_aborted: false,
                    };
                    set_busy_record(state, Some(own), at)
                } else {
                    state.ownership = Ownership::KnownBusy {
                        session_id: own.clone(),
                        cycle,
                        stream,
                        turn_aborted: false,
                    };
                    Vec::new()
                }
            } else {
                let mut blocked = busy_roots;
                blocked.push(own.clone());
                state.ownership = Ownership::Ambiguous {
                    known_session_id: Some(own),
                    blocked: unique_sorted(blocked),
                };
                set_busy_record(state, None, at)
            }
        }
        Ownership::Candidate {
            session_id: own,
            previous_known,
            turn_aborted,
            ..
        } => {
            if busy_roots.is_empty() {
                state.ownership = Ownership::AwaitingAssociation {
                    session_id: own,
                    previous_known,
                    completed_at: at,
                    aborted: turn_aborted,
                };
                if turn_aborted && !state.pending_permissions.is_empty() {
                    // Aborted mid-pause: force-emit the cancel (mirror of
                    // the idle-edge hardening).
                    state.pending_permissions.clear();
                    return clear_record(state, true);
                }
                // A non-aborted pause claim survives into
                // AwaitingAssociation (swallowed at bind_session, D3).
                clear_record(state, false)
            } else if busy_roots.len() == 1 && busy_roots[0] == own {
                // Refresh: abort gate re-arms; a pause resumes out-of-band.
                state.pending_permissions.clear();
                state.ownership = Ownership::Candidate {
                    session_id: own.clone(),
                    previous_known,
                    cycle,
                    stream,
                    turn_aborted: false,
                };
                set_busy_record(state, Some(own), at)
            } else {
                let mut blocked = busy_roots;
                blocked.push(own);
                state.ownership = Ownership::Ambiguous {
                    known_session_id: previous_known,
                    blocked: unique_sorted(blocked),
                };
                set_busy_record(state, None, at)
            }
        }
        Ownership::AwaitingAssociation { .. } => Vec::new(),
        Ownership::Quiet { known_session_id } => {
            if busy_roots.is_empty() {
                return clear_record(state, false);
            }
            if let Some(known) = known_session_id {
                if busy_roots.len() == 1 {
                    if busy_roots[0] == known {
                        state.ownership = Ownership::KnownBusy {
                            session_id: known.clone(),
                            cycle,
                            stream,
                            turn_aborted: false,
                        };
                        return set_busy_record(state, Some(known), at);
                    }
                    // Session switched during an SSE reconnect gap, visible
                    // only in the snapshot (Node reduceSnapshot:406-417).
                    // #609: the switch happened on the pane's OWN per-pane
                    // endpoint, so the foreign root IS the pane's new
                    // session — rebind directly, no Candidate detour.
                    let root = busy_roots[0].clone();
                    state.ownership = Ownership::KnownBusy {
                        session_id: root.clone(),
                        cycle,
                        stream,
                        turn_aborted: false,
                    };
                    return set_busy_record(state, Some(root), at);
                }
                state.ownership = Ownership::Ambiguous {
                    known_session_id: Some(known),
                    blocked: busy_roots,
                };
                set_busy_record(state, None, at)
            } else if busy_roots.len() == 1 {
                let candidate = busy_roots[0].clone();
                state.ownership = Ownership::Candidate {
                    session_id: candidate.clone(),
                    previous_known: None,
                    cycle,
                    stream,
                    turn_aborted: false,
                };
                set_busy_record(state, Some(candidate), at)
            } else {
                state.ownership = Ownership::Ambiguous {
                    known_session_id: None,
                    blocked: busy_roots,
                };
                set_busy_record(state, None, at)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(session_id: Option<&str>, at: i64) -> OpencodeActivityRecord {
        OpencodeActivityRecord {
            terminal_id: "t1".to_string(),
            phase: OpencodePhase::Busy,
            updated_at: at,
            session_id: session_id.map(str::to_string),
        }
    }

    fn upsert(record: OpencodeActivityRecord) -> OpencodeEffect {
        TrackerEffect::Changed {
            upsert: vec![record],
            remove: vec![],
        }
    }

    fn remove() -> OpencodeEffect {
        TrackerEffect::Changed {
            upsert: vec![],
            remove: vec!["t1".to_string()],
        }
    }

    fn turn_complete(session_id: &str, at: i64, seq: i64) -> OpencodeEffect {
        TrackerEffect::TurnComplete {
            terminal_id: "t1".to_string(),
            session_id: Some(session_id.to_string()),
            at,
            completion_seq: seq,
            outcome: Some(TerminalTurnOutcome::Completed),
            outcome_update: false,
        }
    }

    fn failed_turn_complete(session_id: &str, at: i64, seq: i64) -> OpencodeEffect {
        TrackerEffect::TurnComplete {
            terminal_id: "t1".to_string(),
            session_id: Some(session_id.to_string()),
            at,
            completion_seq: seq,
            outcome: Some(TerminalTurnOutcome::Failed),
            outcome_update: false,
        }
    }

    fn boundary(at: i64) -> OpencodeEffect {
        TrackerEffect::AttentionBoundary {
            terminal_id: "t1".to_string(),
            at,
        }
    }

    fn completions(effects: &[OpencodeEffect]) -> Vec<i64> {
        effects
            .iter()
            .filter_map(|effect| match effect {
                TrackerEffect::TurnComplete { completion_seq, .. } => Some(*completion_seq),
                _ => None,
            })
            .collect()
    }

    fn unbound_busy_history() -> OpencodeActivityTracker {
        let mut history = OpencodeActivityTracker::new();
        history.track_terminal("t1", None, 0);
        history.note_snapshot("t1", &[("ses-r".into(), OpencodeStatus::Busy)], 1, 1, 100);
        history
    }

    #[test]
    fn historical_unbound_permission_end_does_not_swallow_the_next_completion() {
        let mut history = unbound_busy_history();
        history.note_permission_asked("t1", "ses-r", "perm-old", 150);
        history.note_session_idle("t1", "ses-r", 1, 1, 200);

        let mut tracker = OpencodeActivityTracker::new();
        assert_eq!(
            tracker.seed_terminal_from_history("t1", history, 300),
            vec![remove()]
        );
        assert!(tracker.list_latest_completions().is_empty());
        assert!(tracker.bind_session("t1", "ses-r", 310).is_empty());
        assert_eq!(
            tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 2, 1, 400),
            vec![upsert(rec(Some("ses-r"), 400))]
        );
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 2, 1, 500),
            vec![remove(), turn_complete("ses-r", 500, 1)]
        );
        assert!(!tracker.has_pending_permissions("t1"));
        assert!(tracker
            .note_session_idle("t1", "ses-r", 2, 1, 510)
            .is_empty());
    }

    #[test]
    fn historical_unbound_busy_and_pending_permission_remain_actionable() {
        for paused in [false, true] {
            let mut history = unbound_busy_history();
            if paused {
                history.note_permission_asked("t1", "ses-r", "perm-current", 150);
            }
            let mut tracker = OpencodeActivityTracker::new();
            assert_eq!(
                tracker.seed_terminal_from_history("t1", history, 300),
                if paused {
                    vec![remove()]
                } else {
                    vec![upsert(rec(Some("ses-r"), 100))]
                }
            );
            assert_eq!(tracker.has_pending_permissions("t1"), paused);
            assert!(tracker.list_latest_completions().is_empty());
            if paused {
                assert_eq!(
                    tracker.note_permission_replied("t1", "perm-current", 350),
                    vec![upsert(rec(Some("ses-r"), 350))]
                );
            }
            tracker.bind_session("t1", "ses-r", 400);
            assert_eq!(
                tracker.note_session_idle("t1", "ses-r", 1, 1, 500),
                vec![remove(), turn_complete("ses-r", 500, 1)]
            );
        }
    }

    #[test]
    fn completed_turn_emits_remove_then_turn_complete() {
        let mut tracker = OpencodeActivityTracker::new();
        assert!(tracker.track_terminal("t1", Some("ses-r"), 0).is_empty());
        assert_eq!(
            tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100),
            vec![upsert(rec(Some("ses-r"), 100))]
        );
        // D7 ordering: the remove frame precedes the completion.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove(), turn_complete("ses-r", 200, 1)]
        );
    }

    #[test]
    fn double_session_idle_is_deduped() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert_eq!(
            completions(&tracker.note_session_idle("t1", "ses-r", 1, 1, 200)),
            vec![1]
        );
        // Structural dedupe (D2): the state is already Quiet — no effects.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 207)
            .is_empty());
    }

    #[test]
    fn session_status_idle_then_session_idle_yields_one_completion() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        let first = tracker.note_status("t1", "ses-r", OpencodeStatus::Idle, 1, 1, 200);
        assert_eq!(
            first,
            vec![remove(), turn_complete("ses-r", 200, 1)],
            "session.status{{idle}} completes the turn"
        );
        // The spike's 7ms twin: session.idle trails session.status{idle}.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 207)
            .is_empty());
        assert_eq!(tracker.list_latest_completions().len(), 1);
    }

    #[test]
    fn retry_status_counts_as_busy() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        // D6: retry from quiet(known) enters KnownBusy and upserts the record.
        assert_eq!(
            tracker.note_status("t1", "ses-r", OpencodeStatus::Retry, 1, 1, 100),
            vec![upsert(rec(Some("ses-r"), 100))]
        );
        // A real turn was armed: the matching idle completes it.
        assert_eq!(
            completions(&tracker.note_session_idle("t1", "ses-r", 1, 1, 200)),
            vec![1]
        );
    }

    #[test]
    fn child_idle_is_suppressed_and_child_busy_remaps_to_root() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert!(tracker
            .note_session_created("t1", "ses-c", Some("ses-r"), 110)
            .is_empty());
        // Child busy remaps to the root: session stays ses-r, so the public
        // shape is unchanged (dedupe) but the stored record refreshes.
        assert!(tracker
            .note_status("t1", "ses-c", OpencodeStatus::Busy, 1, 1, 120)
            .is_empty());
        assert_eq!(tracker.list(), vec![rec(Some("ses-r"), 120)]);
        // Child idle is SUPPRESSED (D5): no effects, the record survives.
        assert!(tracker
            .note_session_idle("t1", "ses-c", 1, 1, 130)
            .is_empty());
        assert_eq!(tracker.list(), vec![rec(Some("ses-r"), 120)]);
        // The parent's own idle ends the turn: exactly one completion.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove(), turn_complete("ses-r", 200, 1)]
        );
    }

    #[test]
    fn first_turn_busy_root_binds_directly_and_is_death_eligible() {
        // #609: on the pane's own per-pane endpoint the busy root IS the
        // pane's session — no Candidate detour, first-turn deaths ring.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        assert_eq!(
            tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 1, 1, 100),
            vec![upsert(rec(Some("ses-x"), 100))]
        );
        assert!(
            !tracker.blocks_death_bell("t1"),
            "first-turn ownership is confirmed by construction (#609)"
        );
        // The first turn's idle edge completes IMMEDIATELY — no deferral.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-x", 1, 1, 200),
            vec![remove(), turn_complete("ses-x", 200, 1)]
        );
    }

    #[test]
    fn superseded_session_rebinds_directly() {
        // A NEW root going busy on the pane's endpoint (e.g. /new in the
        // TUI) is the pane's new session — rebind, don't candidate.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-old"), 0);
        assert_eq!(
            tracker.note_status("t1", "ses-new", OpencodeStatus::Busy, 1, 1, 100),
            vec![upsert(rec(Some("ses-new"), 100))]
        );
        assert!(!tracker.blocks_death_bell("t1"));
        assert_eq!(
            tracker.note_session_idle("t1", "ses-new", 1, 1, 200),
            vec![remove(), turn_complete("ses-new", 200, 1)]
        );
    }

    #[test]
    fn ambiguous_is_conservative_no_completions() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-a", OpencodeStatus::Busy, 1, 1, 100);
        // A second busy session: ambiguous, the record demotes to session-less.
        assert_eq!(
            tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 110),
            vec![upsert(rec(None, 110))]
        );
        // First idle drops ses-a from the blocked set; record stays (no
        // public change: session already None).
        assert!(tracker
            .note_session_idle("t1", "ses-a", 1, 1, 120)
            .is_empty());
        assert_eq!(tracker.list(), vec![rec(None, 120)]);
        // Last idle empties the blocked set: record removed, still silent.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-b", 1, 1, 130),
            vec![remove()]
        );
        assert!(tracker.list_latest_completions().is_empty());
    }

    #[test]
    fn snapshot_empty_completes_a_known_busy_turn() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // Snapshot path B: an empty snapshot ends the known-busy turn.
        assert_eq!(
            tracker.note_snapshot("t1", &[], 1, 1, 200),
            vec![remove(), turn_complete("ses-r", 200, 1)]
        );
    }

    #[test]
    fn snapshot_single_foreign_busy_from_quiet_known_rebinds() {
        // #609 inversion (deliberate, not a regression): a session switch
        // visible only in the snapshot (SSE reconnect gap) happened on the
        // pane's OWN per-pane endpoint, so the foreign root IS the pane's
        // new session — direct KnownBusy, no Candidate detour.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        let statuses = vec![("ses-x".to_string(), OpencodeStatus::Busy)];
        assert_eq!(
            tracker.note_snapshot("t1", &statuses, 1, 1, 100),
            vec![upsert(rec(Some("ses-x"), 100))]
        );
        assert!(!tracker.blocks_death_bell("t1"));
        // The subsequent idle edge mints the completion immediately.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-x", 1, 1, 200),
            vec![remove(), turn_complete("ses-x", 200, 1)]
        );
    }

    #[test]
    fn stale_cycle_idle_is_ignored() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // Wrong cycle, then wrong stream: both leave KnownBusy intact.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 2, 1, 150)
            .is_empty());
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 2, 160)
            .is_empty());
        assert_eq!(tracker.list(), vec![rec(Some("ses-r"), 100)]);
        // The matching idle still completes the turn.
        assert_eq!(
            completions(&tracker.note_session_idle("t1", "ses-r", 1, 1, 200)),
            vec![1]
        );
    }

    #[test]
    fn deadman_expiry_requests_verify_and_stays_busy() {
        // #603: the deadman is verify-then-decide, mirroring the codex
        // self-heal (codex.rs:44-56). No silent record drop, ever.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.set_busy_deadman_ms(1000);
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 0);
        assert_eq!(tracker.next_deadline(), Some(1000));
        assert!(
            tracker.expire(1000).is_empty(),
            "not yet silent PAST the window"
        );
        // Past the window: a verify request, record RETAINED, deadline
        // re-armed (a wedged verify cannot hot-loop — anchor-disarm lesson).
        assert_eq!(
            tracker.expire(2000),
            vec![TrackerEffect::ForceRead {
                terminal_id: "t1".to_string(),
                at: 2000,
            }]
        );
        assert_eq!(tracker.list(), vec![rec(Some("ses-r"), 0)]);
        assert_eq!(tracker.next_deadline(), Some(3000));
        assert!(tracker.list_latest_completions().is_empty());
    }

    #[test]
    fn verify_snapshot_busy_keeps_the_record_and_empty_clears_with_completion() {
        // The verify answer flows through the EXISTING note_snapshot path.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.set_busy_deadman_ms(1000);
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 0);
        tracker.expire(2000); // verify requested, still busy
                              // Verify answer: still busy — record retained, deadman re-armed.
        assert!(tracker
            .note_snapshot(
                "t1",
                &[("ses-r".to_string(), OpencodeStatus::Busy)],
                1,
                1,
                2100
            )
            .is_empty()); // same-session busy refresh is not a public change
        assert_eq!(tracker.list(), vec![rec(Some("ses-r"), 2100)]);
        assert_eq!(tracker.next_deadline(), Some(3100));
        // Next window: verify again; answer: idle — clear WITH completion.
        assert_eq!(
            tracker.expire(3200),
            vec![TrackerEffect::ForceRead {
                terminal_id: "t1".to_string(),
                at: 3200,
            }]
        );
        assert_eq!(
            tracker.note_snapshot("t1", &[], 1, 1, 3300),
            vec![remove(), turn_complete("ses-r", 3300, 1)]
        );
    }

    #[test]
    fn verify_failed_clears_busy_and_rings_attention() {
        // Owner ruling: verify-probe failure = crash/needs-attention —
        // clear busy AND fire the engagement signal. Never silent.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        assert_eq!(
            tracker.note_verify_failed("t1", 200),
            // Record was already removed by the pause; the forced remove
            // still emits (mid-pause crash must cancel the client's state)
            // followed by the attention boundary.
            vec![remove(), boundary(200)]
        );
        assert!(!tracker.has_pending_permissions("t1"));
        assert!(!tracker.blocks_death_bell("t1"));
        assert_eq!(tracker.next_deadline(), None);
        // No record, no pause: probe failure is a no-op.
        assert!(tracker.note_verify_failed("t1", 300).is_empty());
    }

    #[test]
    fn abort_then_idle_clears_silently() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // D1: the abort observation only arms the per-turn flag — no effects.
        assert!(tracker
            .note_error("t1", "ses-r", "MessageAbortedError", 1, 1, 150)
            .is_empty());
        // The idle clears busy silently: remove only, no TurnComplete.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove()]
        );
        assert!(tracker.list_latest_completions().is_empty());
        // Second idle: structural dedupe (D2) — nothing.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 207)
            .is_empty());
    }

    #[test]
    fn w2_abort_marker_gates_like_session_error() {
        // The message.updated abort marker (abort window W2, opencode
        // 1.18.11) reaches the tracker through the SAME note_error entry:
        // Task 9's translate maps the marker to a SessionError-shaped call.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // The marker-sourced abort observation: no effects.
        assert!(tracker
            .note_error("t1", "ses-r", "MessageAbortedError", 1, 1, 160)
            .is_empty());
        // Idle: remove only, no TurnComplete.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove()]
        );
        assert!(tracker.list_latest_completions().is_empty());
        // Second idle: nothing.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 207)
            .is_empty());
    }

    #[test]
    fn structured_error_marks_only_the_owned_turn_failed() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // Structured provider failure is body-free metadata on the eventual
        // completion; it does not alter the activity stream.
        assert!(tracker
            .note_error("t1", "ses-r", "UnknownError", 1, 1, 150)
            .is_empty());
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove(), failed_turn_complete("ses-r", 200, 1)]
        );
        // Trailing error on the now-quiet state: no effects, no state change.
        assert!(tracker
            .note_error("t1", "ses-r", "MessageAbortedError", 1, 1, 210)
            .is_empty());
        assert!(tracker.list().is_empty());
        // Ownership stayed Quiet{known}: the next turn completes normally
        // (the trailing abort did not poison it).
        assert_eq!(
            tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 300),
            vec![upsert(rec(Some("ses-r"), 300))]
        );
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 400),
            vec![remove(), turn_complete("ses-r", 400, 2)]
        );
    }

    #[test]
    fn child_abort_does_not_gate_the_root() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_session_created("t1", "ses-c", Some("ses-r"), 110);
        // Child session.error is ignored: the raw sessionID must equal the
        // owned root (D5), and ses-c root-resolves to ses-r ≠ ses-c.
        assert!(tracker
            .note_error("t1", "ses-c", "MessageAbortedError", 1, 1, 150)
            .is_empty());
        // The parent's own idle still completes the turn.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove(), turn_complete("ses-r", 200, 1)]
        );
    }

    #[test]
    fn permission_asked_demotes_then_arms_once() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        // D3/D7 ordering (load-bearing): record removal FIRST, attention
        // boundary SECOND.
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-r", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        // A duplicate asked never re-arms: one boundary per pause.
        assert!(tracker
            .note_permission_asked("t1", "ses-r", "perm-1", 160)
            .is_empty());
    }

    #[test]
    fn child_permission_asked_resolves_to_root_and_arms() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_session_created("t1", "ses-c", Some("ses-r"), 110);
        // Children CAN ask (the event is stamped with the CHILD session id
        // and the parent turn blocks on it): root-resolve, then arm (D3).
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-c", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        // A foreign, unregistered id resolves to itself and never matches.
        assert!(tracker
            .note_permission_asked("t1", "ses-z", "perm-2", 160)
            .is_empty());
    }

    #[test]
    fn first_turn_pause_arms_and_completion_is_swallowed() {
        // #609 inversion (deliberate, not a regression): the first busy
        // edge on the pane's own lane binds directly (KnownBusy) — the ask
        // still arms, and the mid-pause turn end is swallowed WITHOUT any
        // bind_session step.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        // Busy with no prior binding: KnownBusy by construction (#609).
        assert_eq!(
            tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 1, 1, 100),
            vec![upsert(rec(Some("ses-x"), 100))]
        );
        // First-turn asks ring (D3/D7 ordering unchanged).
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-x", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        // Mid-pause turn end (KnownBusy arm): the pause was the episode's
        // bell — no effects (D3), and the pending claim clears HERE (no
        // AwaitingAssociation continuation, no bind needed).
        assert!(tracker
            .note_session_idle("t1", "ses-x", 1, 1, 200)
            .is_empty());
        assert!(!tracker.has_pending_permissions("t1"));
        assert!(tracker.list_latest_completions().is_empty());
        // State is Quiet{known: Some(ses-x)}: the follow-up busy+idle turn
        // completes normally (first ledger completion, seq 1).
        tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 2, 1, 400);
        assert_eq!(
            tracker.note_session_idle("t1", "ses-x", 2, 1, 500),
            vec![remove(), turn_complete("ses-x", 500, 1)]
        );
    }

    #[test]
    fn permission_replied_resumes_busy() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        // The reply empties the set: the busy record is restored
        // immediately with the OWNED session (KnownBusy ownership).
        assert_eq!(
            tracker.note_permission_replied("t1", "perm-1", 180),
            vec![upsert(rec(Some("ses-r"), 180))]
        );
        // An unknown id is a no-op.
        assert!(tracker
            .note_permission_replied("t1", "perm-9", 185)
            .is_empty());

        // Repeat from an unbound re-track (busy binds directly under #609;
        // the re-track drops the restored record).
        assert_eq!(tracker.track_terminal("t1", None, 300), vec![remove()]);
        tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 2, 1, 310);
        tracker.note_permission_asked("t1", "ses-x", "perm-2", 320);
        assert_eq!(
            tracker.note_permission_replied("t1", "perm-2", 330),
            vec![upsert(rec(Some("ses-x"), 330))]
        );
    }

    #[test]
    fn abort_mid_pause_force_emits_the_cancel() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        assert!(tracker
            .note_error("t1", "ses-r", "MessageAbortedError", 1, 1, 160)
            .is_empty());
        // The remove frame is FORCE-emitted despite the absent record: the
        // gate's note_exit cancels the armed window — total silence. No
        // TurnComplete, no boundary.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 1, 200),
            vec![remove()]
        );
        assert!(tracker.list_latest_completions().is_empty());
        assert!(!tracker.has_pending_permissions("t1"));

        // Repeat from an unbound re-track: the busy edge binds directly
        // (#609), and the aborted mid-pause turn end force-emits the same
        // cancel from the KnownBusy arm.
        assert!(tracker.track_terminal("t1", None, 300).is_empty());
        tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 2, 1, 310);
        tracker.note_permission_asked("t1", "ses-x", "perm-2", 320);
        assert!(tracker
            .note_error("t1", "ses-x", "MessageAbortedError", 2, 1, 330)
            .is_empty());
        assert_eq!(
            tracker.note_session_idle("t1", "ses-x", 2, 1, 400),
            vec![remove()]
        );
        assert!(!tracker.has_pending_permissions("t1"));
        // The bind of the aborted awaiting turn mints nothing.
        assert!(tracker.bind_session("t1", "ses-x", 500).is_empty());
        assert!(tracker.list_latest_completions().is_empty());
    }

    #[test]
    fn completion_mid_pause_mints_nothing() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        // Mid-pause turn end (no error): the pause was the episode's bell —
        // NO effects at all (no second completion, no frames; the armed
        // window is left to fire once or stay silent if it already rang).
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 200)
            .is_empty());
        assert!(tracker.list_latest_completions().is_empty());
        assert!(!tracker.has_pending_permissions("t1"));
    }

    #[test]
    fn death_predicates() {
        // Quiet and KnownBusy never block (the hub's own criteria — owned
        // busy, armed grace, pending permissions — decide engagement).
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        assert!(!tracker.blocks_death_bell("t1"));
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert!(!tracker.blocks_death_bell("t1"));
        // has_pending_permissions over the pause lifecycle: true during the
        // pause, false after replied.
        assert!(!tracker.has_pending_permissions("t1"));
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        assert!(tracker.has_pending_permissions("t1"));
        tracker.note_permission_replied("t1", "perm-1", 180);
        assert!(!tracker.has_pending_permissions("t1"));

        // #609 inversion (deliberate, not a regression): an unbound pane's
        // busy edge arrives on its OWN per-pane lane, so identity confirms
        // by construction — KnownBusy is death-eligible, even mid-pause.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-x", OpencodeStatus::Busy, 1, 1, 100);
        assert!(!tracker.blocks_death_bell("t1"));
        tracker.note_permission_asked("t1", "ses-x", "perm-1", 150);
        assert!(tracker.has_pending_permissions("t1"));
        assert!(!tracker.blocks_death_bell("t1"));
        // A second busy root demotes to Ambiguous — the pause claim
        // survives the demotion and the state blocks again (D4).
        tracker.note_status("t1", "ses-y", OpencodeStatus::Busy, 1, 1, 160);
        assert!(tracker.has_pending_permissions("t1"));
        assert!(tracker.blocks_death_bell("t1"));
        // Exit drops the pending set with the state (the hub reads
        // has_pending_permissions BEFORE note_exit — audit-A17 ordering).
        tracker.note_exit("t1");
        assert!(!tracker.has_pending_permissions("t1"));
        assert!(!tracker.blocks_death_bell("t1"));

        // Ambiguous blocks (D4).
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-a", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 110);
        assert!(tracker.blocks_death_bell("t1"));
    }

    #[test]
    fn busy_snapshot_refresh_rearms_the_abort_gate() {
        // Node parity pin (Task 6 review note): busy re-entry/refresh
        // re-arms `turn_aborted: false`, so a stale abort flag never
        // swallows the NEXT turn's completion.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert!(tracker
            .note_error("t1", "ses-r", "MessageAbortedError", 1, 1, 150)
            .is_empty());
        // Same-session busy snapshot refresh: same public shape (dedupe, no
        // frame) but a NEW turn — the abort flag is cleared.
        let statuses = vec![("ses-r".to_string(), OpencodeStatus::Busy)];
        assert!(tracker.note_snapshot("t1", &statuses, 1, 2, 160).is_empty());
        // The refreshed turn's idle completes normally.
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 1, 2, 200),
            vec![remove(), turn_complete("ses-r", 200, 1)]
        );
    }

    #[test]
    fn busy_snapshot_does_not_clear_an_outstanding_pause() {
        // #608: a blocked-on-permission session still reports BUSY in
        // /session/status — the reconnect snapshot must not resurrect the
        // busy record or forget the pause (that is exactly how the pending
        // bell got lost, residual D8(b)).
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-r", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        // Reconnect snapshot (new cycle): session busy — pause SURVIVES.
        assert!(tracker
            .note_snapshot(
                "t1",
                &[("ses-r".to_string(), OpencodeStatus::Busy)],
                2,
                1,
                200
            )
            .is_empty());
        assert!(tracker.has_pending_permissions("t1"));
        assert!(tracker.list().is_empty(), "mid-pause: record stays absent");
        // The reply still resumes busy normally.
        assert_eq!(
            tracker.note_permission_replied("t1", "perm-1", 300),
            vec![upsert(rec(Some("ses-r"), 300))]
        );
    }

    #[test]
    fn permissions_sync_drains_stale_pauses() {
        // #608 reconciliation: opencode instance-dispose drains pending
        // asks WITHOUT publishing any replied/rejected event
        // (permission/index.ts:54-61, question/index.ts:74-81) — the
        // fetched pending sets are authoritative, so a locally-pending
        // id absent from them is deterministically stale: treat it as
        // replied so the pause cannot wedge.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_permission_asked("t1", "ses-r", "perm-1", 150);
        assert!(tracker.has_pending_permissions("t1"));
        // Sync says: nothing pending server-side — drain exactly like a
        // reply (busy resumes, same effects as note_permission_replied).
        assert_eq!(
            tracker.note_permissions_synced("t1", &[], 300),
            vec![upsert(rec(Some("ses-r"), 300))]
        );
        assert!(!tracker.has_pending_permissions("t1"));
        // A still-listed id keeps its pause untouched.
        tracker.note_permission_asked("t1", "ses-r", "perm-2", 400);
        assert!(tracker
            .note_permissions_synced("t1", &["perm-2".to_string()], 500)
            .is_empty());
        assert!(tracker.has_pending_permissions("t1"));
    }

    #[test]
    fn ambiguous_drain_via_idle_clears_stale_pause_claim() {
        // A pause claim survives the KnownBusy → Ambiguous demotion; the
        // idle-edge drain into Quiet must retire it.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-r", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        // Foreign busy mid-pause: Ambiguous{known: ses-r, blocked: [b, r]}.
        assert_eq!(
            tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 160),
            vec![upsert(rec(None, 160))]
        );
        assert!(tracker.has_pending_permissions("t1"));
        // Drain the blocked set one idle at a time.
        assert!(tracker
            .note_session_idle("t1", "ses-r", 1, 1, 170)
            .is_empty());
        assert_eq!(
            tracker.note_session_idle("t1", "ses-b", 1, 1, 180),
            vec![remove()]
        );
        // Quiet: the stale claim is gone.
        assert!(!tracker.has_pending_permissions("t1"));
        // The next turn's busy→idle cycle mints a completion normally.
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 2, 1, 300);
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 2, 1, 400),
            vec![remove(), turn_complete("ses-r", 400, 1)]
        );
    }

    #[test]
    fn ambiguous_drain_via_snapshot_clears_stale_pause_claim() {
        // Same staleness, drained through the snapshot reducer's
        // empty-busy-roots arm instead of the idle edge.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", Some("ses-r"), 0);
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 1, 1, 100);
        assert_eq!(
            tracker.note_permission_asked("t1", "ses-r", "perm-1", 150),
            vec![remove(), boundary(150)]
        );
        assert_eq!(
            tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 160),
            vec![upsert(rec(None, 160))]
        );
        assert!(tracker.has_pending_permissions("t1"));
        // Empty snapshot drains Ambiguous → Quiet.
        assert_eq!(tracker.note_snapshot("t1", &[], 2, 1, 200), vec![remove()]);
        assert!(!tracker.has_pending_permissions("t1"));
        // The next turn's busy→idle cycle mints a completion normally.
        tracker.note_status("t1", "ses-r", OpencodeStatus::Busy, 3, 1, 300);
        assert_eq!(
            tracker.note_session_idle("t1", "ses-r", 3, 1, 400),
            vec![remove(), turn_complete("ses-r", 400, 1)]
        );
    }

    #[test]
    fn ambiguous_repromotes_on_single_root_snapshot_and_then_bells() {
        // #610: resolve the ambiguity deterministically instead of
        // waiting it out — the verify snapshot's root collapse picks the
        // one true root; the next idle edge mints the completion that the
        // old quiet drain silently skipped.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-a", OpencodeStatus::Busy, 1, 1, 100);
        // ses-c was mis-seen as a root during an SSE gap (D8(c)) → Ambiguous.
        tracker.note_status("t1", "ses-c", OpencodeStatus::Busy, 1, 1, 110);
        assert!(tracker.blocks_death_bell("t1"));
        // The lane's root resolution catches up: ses-c is a CHILD of ses-a.
        tracker.note_session_created("t1", "ses-c", Some("ses-a"), 120);
        // Verify snapshot: only ses-c busy — collapses to root ses-a.
        assert_eq!(
            tracker.note_snapshot(
                "t1",
                &[("ses-c".to_string(), OpencodeStatus::Busy)],
                1,
                1,
                130
            ),
            vec![upsert(rec(Some("ses-a"), 130))],
            "re-promotion restores the session on the record"
        );
        assert!(!tracker.blocks_death_bell("t1"));
        // The turn's idle edge now MINTS the completion (the whole point).
        assert_eq!(
            tracker.note_session_idle("t1", "ses-a", 1, 1, 200),
            vec![remove(), turn_complete("ses-a", 200, 1)]
        );
    }

    #[test]
    fn ambiguous_with_two_true_roots_stays_conservative() {
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-a", OpencodeStatus::Busy, 1, 1, 100);
        tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 110);
        // Two independent busy ROOTS in the snapshot: no deterministic
        // single owner — stay Ambiguous (adjudicated residual), honest
        // blue, quiet drain.
        assert!(tracker
            .note_snapshot(
                "t1",
                &[
                    ("ses-a".to_string(), OpencodeStatus::Busy),
                    ("ses-b".to_string(), OpencodeStatus::Busy)
                ],
                1,
                1,
                130
            )
            .is_empty());
        assert!(tracker.blocks_death_bell("t1"));
    }

    #[test]
    fn ambiguous_repromotes_when_single_root_differs_from_known() {
        // The DISCRIMINATING case for the #609/#610 always-re-promote
        // semantics: the old code only re-promoted when the snapshot's
        // single busy root EQUALLED known_session_id (and stayed Ambiguous
        // otherwise). One busy root on the pane's own per-pane endpoint is
        // the pane's session even when it is NOT the previously-known one.
        let mut tracker = OpencodeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_status("t1", "ses-a", OpencodeStatus::Busy, 1, 1, 100);
        // A second busy root: Ambiguous(known = Some("ses-a")).
        tracker.note_status("t1", "ses-b", OpencodeStatus::Busy, 1, 1, 110);
        assert!(tracker.blocks_death_bell("t1"));
        // Verify snapshot: only ses-b busy — a single root that DIFFERS
        // from the known session. Re-promote to THAT root.
        assert_eq!(
            tracker.note_snapshot(
                "t1",
                &[("ses-b".to_string(), OpencodeStatus::Busy)],
                1,
                1,
                130
            ),
            vec![upsert(rec(Some("ses-b"), 130))],
            "re-promotion binds the record to the snapshot's single root"
        );
        assert!(!tracker.blocks_death_bell("t1"));
        // The turn's idle edge mints the completion (old code drained the
        // Ambiguous blocked set silently — no bell).
        assert_eq!(
            tracker.note_session_idle("t1", "ses-b", 1, 1, 200),
            vec![remove(), turn_complete("ses-b", 200, 1)]
        );
    }
}

/// The native OpenCode activity lane's event vocabulary. Its transport
/// produces these from the per-pane sidecar's `/event` stream +
/// `/session/status` snapshots; the hub routes them into the pure
/// `OpencodeActivityTracker`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OpencodeLaneEvent {
    /// `/session/status` snapshot (absence == idle).
    Snapshot {
        statuses: Vec<(String, OpencodeStatus)>,
    },
    /// `session.created` — folds the parentID chain into the root map.
    SessionCreated {
        session_id: String,
        parent_id: Option<String>,
    },
    /// `session.status` edge (busy | retry | idle).
    Status {
        session_id: String,
        status: OpencodeStatus,
    },
    /// `session.idle` — the deprecated twin of `session.status{idle}`.
    SessionIdle { session_id: String },
    /// `session.error` (and Task 9's abort-marked `message.updated`,
    /// translated into this same shape).
    SessionError {
        session_id: String,
        error_name: String,
    },
    /// `permission.asked` — the turn pauses on a human.
    PermissionAsked {
        session_id: String,
        permission_id: String,
    },
    /// `permission.replied` — the pause ends.
    PermissionReplied { permission_id: String },
    /// The verify/connect `/session/status` probe failed in a way that
    /// must NOT read as idle (#603/#604). The hub applies crash semantics
    /// via [`OpencodeActivityTracker::note_verify_failed`].
    SnapshotFailed { error: String },
    /// #608: the authoritative pending-ask listing fetched from GET
    /// /permission + GET /question (noted only when BOTH succeeded). The
    /// hub drains any locally-pending id not listed — see
    /// OpencodeActivityTracker::note_permissions_synced.
    PermissionsSynced { pending_ids: Vec<String> },
}

/// Ordered, body-free observations retained by one native provider launch.
/// The enclosing output batch owns the terminal and source epoch identity.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeActivityBatch {
    pub retained_from_seq: u64,
    pub head_seq: u64,
    pub events: Vec<OpencodeActivityEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeActivityEvent {
    pub seq: u64,
    /// Host observation time, retained unchanged across output reads.
    #[serde(default)]
    pub at: i64,
    pub cycle: u64,
    pub stream: u64,
    pub event: OpencodeLaneEvent,
}

impl OpencodeActivityBatch {
    /// Missing retained history is represented by the bounds, never by an
    /// invented idle edge. A native observation sequence is always contiguous.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.retained_from_seq == 0
            || self.retained_from_seq > self.head_seq.saturating_add(1)
            || self.head_seq.checked_sub(self.retained_from_seq - 1)
                != Some(self.events.len() as u64)
            || self.events.iter().enumerate().any(|(offset, entry)| {
                entry.seq != self.retained_from_seq + offset as u64
                    || entry.cycle == 0
                    || entry.stream == 0
            })
        {
            return Err("invalid native OpenCode activity sequence");
        }
        Ok(())
    }
}

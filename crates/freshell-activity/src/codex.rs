//! Port of `server/coding-cli/codex-activity-tracker.ts` — the **PTY lane**
//! (frozen parity reference).
//!
//! Codex terminal activity on the Rust server is driven by the two signals
//! the PTY itself carries:
//!
//! * a submit (whole-payload CR/LF run) enters `pending` — rendered blue by
//!   the frozen client just like `busy` ("instant onset feedback", decision
//!   5A in `src/lib/pane-activity.ts`);
//! * the codex TUI's turn-complete BEL (`tui.notification_method=bel` +
//!   `tui.notifications=['agent-turn-complete']`, already installed by
//!   `freshell-platform::cli_launch`) clears the turn and emits exactly one
//!   `terminal.turn.complete`, deduped per turn via `lastEmittedTurnKey`.
//!
//! While pending, PTY output liveness (`hasPendingOutputLiveness`) keeps the
//! phase alive through a long streaming turn exactly like the reference; a
//! quiet no-op submit decays to idle after the pending gate + freshness grace.
//!
//! DOCUMENTED DEVIATIONS from the reference (adjudicated, see PR):
//!
//! 1. **Tracking starts at terminal create, not session bind.** The reference
//!    only tracks terminals the legacy codex session INDEXER has bound
//!    (`terminal.session.bound`); that JSONL-reconcile lane
//!    (`reconcileProjects` / `onTurnStarted` / `onTurnCompleted`, the `busy`
//!    and `unknown` phases, and resume-busy seeding) is not yet ported. On
//!    the Rust server a codex pane would otherwise NEVER have an activity
//!    record at all — the exact TERM-15 bug this crate fixes. The PTY-lane
//!    state machine itself is ported faithfully.
//! 2. **Zero-polling**: `next_deadline()` + one-shot hub timer instead of the
//!    5s sweep (`ACTIVITY_SWEEP_MS`), same as [`crate::claude`].

use std::collections::HashMap;

use freshell_protocol::{CodexActivityRecord, CodexPhase};

use crate::ledger::TurnCompletionLedger;
use crate::signal::{
    count_tracker_turn_complete_signals, extract_turn_complete_signals, is_submit_input,
    ParserState,
};
use crate::TrackerEffect;

pub const PENDING_SUBMIT_GATE_MS: i64 = 6_000;
pub const PENDING_SNAPSHOT_GRACE_MS: i64 = 15_000;
pub const BUSY_DEADMAN_MS: i64 = 120_000;

pub type CodexEffect = TrackerEffect<CodexActivityRecord>;

#[derive(Debug)]
struct TerminalActivity {
    terminal_id: String,
    session_id: Option<String>,
    phase: CodexPhase,
    updated_at: i64,
    last_submit_at: Option<i64>,
    pending_submit_at: Option<i64>,
    pending_freshness_at: Option<i64>,
    pending_until: Option<i64>,
    queued_submit_at: Option<i64>,
    accepted_start_at: Option<i64>,
    last_observed_at: i64,
    last_emitted_turn_key: Option<i64>,
    parser_state: ParserState,
}

impl TerminalActivity {
    fn to_record(&self) -> CodexActivityRecord {
        CodexActivityRecord {
            terminal_id: self.terminal_id.clone(),
            phase: self.phase,
            updated_at: self.updated_at,
            session_id: self.session_id.clone(),
        }
    }
}

fn has_public_change(previous: Option<&CodexActivityRecord>, next: &CodexActivityRecord) -> bool {
    match previous {
        None => true,
        Some(previous) => previous.phase != next.phase || previous.session_id != next.session_id,
    }
}

fn changed(previous: Option<&CodexActivityRecord>, next: CodexActivityRecord) -> Vec<CodexEffect> {
    if !has_public_change(previous, &next) {
        return Vec::new();
    }
    vec![TrackerEffect::Changed {
        upsert: vec![next],
        remove: Vec::new(),
    }]
}

#[derive(Debug, Default)]
pub struct CodexActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
}

impl CodexActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<CodexActivityRecord> {
        self.states.values().map(|s| s.to_record()).collect()
    }

    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot> {
        self.ledger.list_latest_completions()
    }

    /// Track a codex terminal from create time (deviation 1 above —
    /// `bindTerminal` with the session identity the create carried, if any).
    pub fn track_terminal(
        &mut self,
        terminal_id: &str,
        session_id: Option<&str>,
        at: i64,
    ) -> Vec<CodexEffect> {
        if let Some(existing) = self.states.get_mut(terminal_id) {
            if let Some(session_id) = session_id {
                if existing.session_id.as_deref() != Some(session_id) {
                    let previous = existing.to_record();
                    existing.session_id = Some(session_id.to_string());
                    let next = existing.to_record();
                    return changed(Some(&previous), next);
                }
            }
            return Vec::new();
        }
        let state = TerminalActivity {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.map(str::to_string),
            phase: CodexPhase::Idle,
            updated_at: at,
            last_submit_at: None,
            pending_submit_at: None,
            pending_freshness_at: None,
            pending_until: None,
            queued_submit_at: None,
            accepted_start_at: None,
            last_observed_at: at,
            last_emitted_turn_key: None,
            parser_state: ParserState::new(),
        };
        let next = state.to_record();
        self.states.insert(terminal_id.to_string(), state);
        changed(None, next)
    }

    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() == Some(session_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.session_id = Some(session_id.to_string());
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<CodexEffect> {
        if self.states.remove(terminal_id).is_none() {
            return Vec::new();
        }
        vec![TrackerEffect::Changed {
            upsert: Vec::new(),
            remove: vec![terminal_id.to_string()],
        }]
    }

    /// `noteInput` (`codex-activity-tracker.ts:174-205`), PTY lane: an Enter
    /// enters `pending` (or queues a submit during an active turn).
    pub fn note_input(&mut self, terminal_id: &str, data: &str, at: i64) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if !is_submit_input(data) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.last_submit_at = Some(at);
        state.pending_until = Some(at + PENDING_SUBMIT_GATE_MS);
        state.pending_freshness_at = Some(at);
        state.last_observed_at = at;
        if state.phase == CodexPhase::Busy {
            if state.queued_submit_at.is_none() {
                state.queued_submit_at = Some(at);
            }
            state.pending_freshness_at = None;
            let next = state.to_record();
            return changed(Some(&previous), next);
        }

        if state.pending_submit_at.is_none() {
            state.pending_submit_at = Some(at);
        } else if state.queued_submit_at.is_none() {
            state.queued_submit_at = Some(at);
        }
        state.phase = CodexPhase::Pending;
        state.updated_at = at;
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// `noteOutput` (`codex-activity-tracker.ts:207-236`): consume
    /// turn-complete BELs; otherwise output refreshes pending/busy liveness.
    pub fn note_output(&mut self, terminal_id: &str, data: &str, at: i64) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };

        let parser_state_at_start = state.parser_state;
        let (_, count) = extract_turn_complete_signals(data, "codex", &mut state.parser_state);
        if count == 0 {
            if state.phase == CodexPhase::Busy || state.phase == CodexPhase::Pending {
                state.last_observed_at = at;
            }
            return Vec::new();
        }
        let tracker_count = count_tracker_turn_complete_signals(data, &parser_state_at_start);
        let clear_count = count.min(tracker_count);
        if clear_count == 0 {
            if state.phase == CodexPhase::Busy || state.phase == CodexPhase::Pending {
                state.last_observed_at = at;
            }
            return Vec::new();
        }

        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();
        for _ in 0..clear_count {
            if !consume_turn_complete_signal(state, at, &mut self.ledger, &mut completions) {
                break;
            }
        }
        let next = state.to_record();
        let mut effects = changed(Some(&previous), next);
        for (session_id, at, seq) in completions {
            effects.push(TrackerEffect::TurnComplete {
                terminal_id: terminal_id.to_string(),
                session_id,
                at,
                completion_seq: seq,
            });
        }
        effects
    }

    /// `expire` / `expireState` (`codex-activity-tracker.ts:350-573`), the
    /// pending-decay + busy-deadman transitions, deadline-driven.
    pub fn expire(&mut self, at: i64) -> Vec<CodexEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            let previous = state.to_record();

            if let Some(pending_until) = state.pending_until {
                if at > pending_until {
                    state.pending_until = None;
                }
            }

            if state.phase == CodexPhase::Pending && state.pending_until.is_none() {
                if !awaiting_fresh_snapshot(state, at) && !has_pending_output_liveness(state, at) {
                    state.phase = CodexPhase::Idle;
                    state.updated_at = at;
                    state.last_observed_at = at;
                    state.pending_submit_at = None;
                    state.pending_freshness_at = None;
                }
            } else if state.phase == CodexPhase::Busy
                && at - state.last_observed_at > BUSY_DEADMAN_MS
            {
                state.phase = CodexPhase::Unknown;
                state.updated_at = at;
                state.last_observed_at = at;
            }

            let next = state.to_record();
            effects.extend(changed(Some(&previous), next));
        }
        effects
    }

    /// Earliest instant [`Self::expire`] could change state. `None` when no
    /// terminal is pending/busy — zero timers, zero wakes.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter_map(|state| match state.phase {
                CodexPhase::Pending => {
                    // The pending decay can only fire once the gate, the
                    // freshness grace, AND the output-liveness window have all
                    // lapsed; the earliest such instant is the max of the
                    // three (each re-check recomputes from fresh state).
                    let gate = state.pending_until.unwrap_or(i64::MIN) + 1;
                    let freshness = state
                        .pending_freshness_at
                        .map(|f| f + PENDING_SNAPSHOT_GRACE_MS + 1)
                        .unwrap_or(i64::MIN);
                    let liveness = if state
                        .pending_submit_at
                        .map(|p| state.last_observed_at > p)
                        .unwrap_or(false)
                    {
                        state.last_observed_at + BUSY_DEADMAN_MS + 1
                    } else {
                        i64::MIN
                    };
                    Some(gate.max(freshness).max(liveness))
                }
                CodexPhase::Busy => Some(state.last_observed_at + BUSY_DEADMAN_MS + 1),
                _ => None,
            })
            .min()
    }
}

fn awaiting_fresh_snapshot(state: &TerminalActivity, at: i64) -> bool {
    let Some(freshness_boundary_at) = state.pending_freshness_at else {
        return false;
    };
    state.pending_submit_at.is_some() && at <= freshness_boundary_at + PENDING_SNAPSHOT_GRACE_MS
}

fn has_pending_output_liveness(state: &TerminalActivity, at: i64) -> bool {
    match state.pending_submit_at {
        Some(pending_submit_at) => {
            state.last_observed_at > pending_submit_at
                && at - state.last_observed_at <= BUSY_DEADMAN_MS
        }
        None => false,
    }
}

fn has_queued_submit(state: &TerminalActivity) -> bool {
    match state.queued_submit_at {
        Some(queued) => state
            .accepted_start_at
            .map(|accepted| queued > accepted)
            .unwrap_or(true),
        None => false,
    }
}

/// `consumeTurnCompleteSignal` (PTY lane): a BEL clears a pending turn.
/// Returns false when there is no turn to clear (idle BEL — ignored).
fn consume_turn_complete_signal(
    state: &mut TerminalActivity,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
) -> bool {
    if state.phase == CodexPhase::Pending {
        if state.pending_submit_at.is_some() {
            transition_pending_after_turn_clear(state, at, ledger, completions);
            return true;
        }
        return false;
    }
    if state.accepted_start_at.is_some() {
        transition_after_turn_clear(state, at, ledger, completions);
        return true;
    }
    false
}

fn transition_pending_after_turn_clear(
    state: &mut TerminalActivity,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
) {
    let turn_key = state.pending_submit_at;
    state.updated_at = at;
    state.last_observed_at = at;
    if has_queued_submit(state) {
        state.phase = CodexPhase::Pending;
        state.pending_submit_at = state.queued_submit_at;
        state.pending_freshness_at = Some(at);
        state.pending_until = Some(at + PENDING_SUBMIT_GATE_MS);
        state.queued_submit_at = None;
    } else {
        state.phase = CodexPhase::Idle;
        state.pending_submit_at = None;
        state.pending_freshness_at = None;
        state.pending_until = None;
        state.queued_submit_at = None;
    }
    record_completion_if_idle(state, turn_key, at, ledger, completions);
}

fn transition_after_turn_clear(
    state: &mut TerminalActivity,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
) {
    let turn_key = state.accepted_start_at;
    let queued = has_queued_submit(state);
    state.accepted_start_at = None;
    state.updated_at = at;
    state.last_observed_at = at;
    if queued {
        state.phase = CodexPhase::Pending;
        state.pending_submit_at = state.queued_submit_at;
        state.pending_freshness_at = Some(at);
        state.pending_until = Some(at + PENDING_SUBMIT_GATE_MS);
        state.queued_submit_at = None;
    } else {
        state.phase = CodexPhase::Idle;
        state.pending_submit_at = None;
        state.pending_freshness_at = None;
        state.queued_submit_at = None;
        state.pending_until = None;
    }
    record_completion_if_idle(state, turn_key, at, ledger, completions);
}

/// `recordCompletionIfIdle`: record only when a real turn-end transition
/// lands the terminal in `idle`; re-arms to `pending` (a queued submit) are
/// NOT turn ends. Dedupe per turn via `last_emitted_turn_key`.
fn record_completion_if_idle(
    state: &mut TerminalActivity,
    turn_key: Option<i64>,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
) {
    let Some(turn_key) = turn_key else { return };
    if state.phase != CodexPhase::Idle {
        return;
    }
    if state.last_emitted_turn_key == Some(turn_key) {
        return;
    }
    state.last_emitted_turn_key = Some(turn_key);
    let seq = ledger.record_turn_completion(&state.terminal_id, at);
    completions.push((state.session_id.clone(), at, seq));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phases(effects: &[CodexEffect]) -> Vec<CodexPhase> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::Changed { upsert, .. } => {
                    Some(upsert.iter().map(|r| r.phase).collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn completions(effects: &[CodexEffect]) -> Vec<i64> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::TurnComplete { completion_seq, .. } => Some(*completion_seq),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn submit_enters_pending_and_bel_completes_once() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);

        let effects = tracker.note_input("t1", "\r", 10);
        assert_eq!(phases(&effects), vec![CodexPhase::Pending]);

        // Streaming output keeps the turn alive; no state change.
        assert!(tracker
            .note_output("t1", "streamed tokens", 5_000)
            .is_empty());

        // The agent-turn-complete BEL clears the turn: idle + one completion.
        let effects = tracker.note_output("t1", "\u{07}", 9_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);

        // A BEL at idle is ignored (no turn to clear).
        assert!(completions(&tracker.note_output("t1", "\u{07}", 9_100)).is_empty());
    }

    #[test]
    fn long_streaming_turn_survives_the_pending_gate_via_output_liveness() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        // Output after the submit keeps liveness fresh long past the 6s gate
        // and the 15s freshness grace.
        tracker.note_output("t1", "chunk", 20_000);
        assert!(tracker.expire(25_000).is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Pending);
    }

    #[test]
    fn quiet_noop_submit_decays_to_idle_without_completion() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        // No output ever follows. Past the gate AND the freshness grace:
        let at = 10 + PENDING_SNAPSHOT_GRACE_MS + PENDING_SUBMIT_GATE_MS + 1;
        let effects = tracker.expire(at);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn queued_submit_rearms_pending_after_the_bel_and_completes_each_turn() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10); // turn 1
        tracker.note_input("t1", "\r", 20); // queued turn 2

        let effects = tracker.note_output("t1", "\u{07}", 30);
        // The queued submit re-arms pending (still blue; pending→pending is
        // not a public change) and a re-arm is NOT a turn end — the
        // reference's recordCompletionIfIdle only records when the terminal
        // lands idle, so no completion yet.
        assert!(phases(&effects).is_empty());
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Pending);

        let effects = tracker.note_output("t1", "\u{07}", 40);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn duplicate_bel_for_the_same_turn_is_deduped_by_turn_key() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        // Two BELs in one chunk, one in-flight turn: only one completion.
        let effects = tracker.note_output("t1", "\u{07}\u{07}", 30);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn exit_removes_the_record() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.note_exit("t1");
        assert_eq!(
            effects,
            vec![TrackerEffect::Changed {
                upsert: vec![],
                remove: vec!["t1".to_string()]
            }]
        );
        assert!(tracker.list().is_empty());
    }

    #[test]
    fn next_deadline_exists_only_while_pending_or_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        assert_eq!(tracker.next_deadline(), None);
        tracker.note_input("t1", "\r", 10);
        assert!(tracker.next_deadline().is_some());
        tracker.note_output("t1", "\u{07}", 30);
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn deadline_driven_expiry_converges_for_a_quiet_submit() {
        // Prove the hub's arm-at-deadline loop reaches idle: repeatedly call
        // expire at exactly next_deadline() until it reports None.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let mut guard = 0;
        while let Some(deadline) = tracker.next_deadline() {
            tracker.expire(deadline);
            guard += 1;
            assert!(guard < 10, "deadline loop must converge");
        }
        assert_eq!(tracker.list()[0].phase, CodexPhase::Idle);
    }

    #[test]
    fn session_identity_from_create_flows_into_records_and_completions() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-1"));
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.note_output("t1", "\u{07}", 20);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("thread-1".to_string())));
    }
}

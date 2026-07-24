//! Port of `server/coding-cli/claude-activity-tracker.ts` (frozen parity
//! reference).
//!
//! Server-authoritative Claude turn lifecycle, keyed by terminalId:
//!
//! * A submit (whole-payload CR/LF run) increments in-flight turns and marks
//!   busy.
//! * A Stop-hook BEL (validated by [`crate::signal::count_tracker_turn_complete_signals`])
//!   decrements in-flight turns and, while a turn was actually in flight,
//!   emits one turn.complete. A BEL while idle is ignored (false-positive
//!   guard).
//! * A busy terminal silent past the deadman self-heals to idle (no
//!   completion event — it is a stuck recovery, not a real turn end).
//!
//! Zero-polling deviation from the reference: instead of a 5s sweep interval,
//! [`ClaudeActivityTracker::next_deadline`] reports the earliest instant
//! `expire(at)` could change state (busy deadman only); the hub arms ONE
//! one-shot timer for it. All idle ⇒ `None` ⇒ zero timers.

use std::collections::HashMap;

use freshell_protocol::{ClaudeActivityRecord, ClaudePhase};

use crate::ledger::TurnCompletionLedger;
use crate::signal::{
    count_tracker_turn_complete_signals, extract_turn_complete_signals, is_submit_input,
    ParserState,
};
use crate::TrackerEffect;

pub const CLAUDE_BUSY_DEADMAN_MS: i64 = 120_000;

pub type ClaudeEffect = TrackerEffect<ClaudeActivityRecord>;

#[derive(Debug)]
struct TerminalActivity {
    terminal_id: String,
    session_id: Option<String>,
    phase: ClaudePhase,
    updated_at: i64,
    in_flight: u32,
    last_observed_at: i64,
    parser_state: ParserState,
}

impl TerminalActivity {
    fn to_record(&self) -> ClaudeActivityRecord {
        ClaudeActivityRecord {
            terminal_id: self.terminal_id.clone(),
            phase: self.phase,
            updated_at: self.updated_at,
            session_id: self.session_id.clone(),
        }
    }
}

fn has_public_change(previous: Option<&ClaudeActivityRecord>, next: &ClaudeActivityRecord) -> bool {
    match previous {
        None => true,
        Some(previous) => previous.phase != next.phase || previous.session_id != next.session_id,
    }
}

#[derive(Debug, Default)]
pub struct ClaudeActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
}

impl ClaudeActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<ClaudeActivityRecord> {
        self.states.values().map(|s| s.to_record()).collect()
    }

    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot> {
        self.ledger.list_latest_completions()
    }

    pub fn track_terminal(
        &mut self,
        terminal_id: &str,
        session_id: Option<&str>,
        at: i64,
    ) -> Vec<ClaudeEffect> {
        if let Some(existing) = self.states.get_mut(terminal_id) {
            if let Some(session_id) = session_id {
                if existing.session_id.as_deref() != Some(session_id) {
                    let previous = existing.to_record();
                    existing.session_id = Some(session_id.to_string());
                    let next = existing.to_record();
                    return commit_change(Some(&previous), next);
                }
            }
            return Vec::new();
        }
        let state = TerminalActivity {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.map(str::to_string),
            phase: ClaudePhase::Idle,
            updated_at: at,
            in_flight: 0,
            last_observed_at: at,
            parser_state: ParserState::new(),
        };
        let next = state.to_record();
        self.states.insert(terminal_id.to_string(), state);
        commit_change(None, next)
    }

    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() == Some(session_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.session_id = Some(session_id.to_string());
        let next = state.to_record();
        commit_change(Some(&previous), next)
    }

    pub fn note_input(&mut self, terminal_id: &str, data: &str, at: i64) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if !is_submit_input(data) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.in_flight += 1;
        state.last_observed_at = at;
        if state.phase != ClaudePhase::Busy {
            state.phase = ClaudePhase::Busy;
            state.updated_at = at;
        }
        let next = state.to_record();
        commit_change(Some(&previous), next)
    }

    pub fn note_output(&mut self, terminal_id: &str, data: &str, at: i64) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };

        let parser_state_at_start = state.parser_state;
        let (_, count) = extract_turn_complete_signals(data, "claude", &mut state.parser_state);
        if count == 0 {
            if state.phase == ClaudePhase::Busy {
                state.last_observed_at = at;
            }
            return Vec::new();
        }
        let tracker_count = count_tracker_turn_complete_signals(data, &parser_state_at_start);
        let clear_count = count.min(tracker_count);
        if clear_count == 0 {
            if state.phase == ClaudePhase::Busy {
                state.last_observed_at = at;
            }
            return Vec::new();
        }

        let previous = state.to_record();
        let mut completions = Vec::new();
        for _ in 0..clear_count {
            if state.in_flight == 0 {
                break;
            }
            state.in_flight -= 1;
            let seq = self.ledger.record_turn_completion(terminal_id, at);
            completions.push(TrackerEffect::TurnComplete {
                terminal_id: terminal_id.to_string(),
                session_id: state.session_id.clone(),
                at,
                completion_seq: seq,
            });
        }
        state.last_observed_at = at;
        if !completions.is_empty() {
            state.phase = if state.in_flight > 0 {
                ClaudePhase::Busy
            } else {
                ClaudePhase::Idle
            };
            state.updated_at = at;
        }
        let next = state.to_record();
        let mut effects = commit_change(Some(&previous), next);
        effects.extend(completions);
        effects
    }

    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<ClaudeEffect> {
        if self.states.remove(terminal_id).is_none() {
            return Vec::new();
        }
        vec![TrackerEffect::Changed {
            upsert: Vec::new(),
            remove: vec![terminal_id.to_string()],
        }]
    }

    /// Busy-deadman self-heal. Deadline-driven: the hub calls this when the
    /// one-shot timer armed from [`Self::next_deadline`] fires.
    pub fn expire(&mut self, at: i64) -> Vec<ClaudeEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            if state.phase != ClaudePhase::Busy {
                continue;
            }
            let idle_age_ms = at - state.last_observed_at;
            if idle_age_ms <= CLAUDE_BUSY_DEADMAN_MS {
                continue;
            }
            let previous = state.to_record();
            state.phase = ClaudePhase::Idle;
            state.in_flight = 0;
            state.updated_at = at;
            state.last_observed_at = at;
            tracing::warn!(
                component = "claude-activity-tracker",
                event = "claude_activity_deadman",
                terminal_id = %state.terminal_id,
                age_ms = idle_age_ms,
                "Claude terminal stuck busy past deadman; clearing to idle."
            );
            let next = state.to_record();
            effects.extend(commit_change(Some(&previous), next));
        }
        effects
    }

    /// Earliest instant at which [`Self::expire`] could change any state:
    /// the soonest busy deadman. `None` when nothing is busy — zero timers.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter(|s| s.phase == ClaudePhase::Busy)
            .map(|s| s.last_observed_at + CLAUDE_BUSY_DEADMAN_MS + 1)
            .min()
    }
}

fn commit_change(
    previous: Option<&ClaudeActivityRecord>,
    next: ClaudeActivityRecord,
) -> Vec<ClaudeEffect> {
    if !has_public_change(previous, &next) {
        return Vec::new();
    }
    vec![TrackerEffect::Changed {
        upsert: vec![next],
        remove: Vec::new(),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy_upserts(effects: &[ClaudeEffect]) -> Vec<(String, ClaudePhase)> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::Changed { upsert, .. } => Some(
                    upsert
                        .iter()
                        .map(|r| (r.terminal_id.clone(), r.phase))
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn completions(effects: &[ClaudeEffect]) -> Vec<i64> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::TurnComplete { completion_seq, .. } => Some(*completion_seq),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn submit_marks_busy_and_stop_bel_completes_exactly_once() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);

        let effects = tracker.note_input("t1", "\r", 10);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Busy)]
        );

        // Ordinary output while busy: no change, no completion.
        assert!(tracker.note_output("t1", "thinking...", 20).is_empty());

        // The Stop-hook BEL ends the turn: idle + exactly one completion.
        let effects = tracker.note_output("t1", "\u{07}", 30);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert_eq!(completions(&effects), vec![1]);

        // A second BEL while idle is a false positive: ignored.
        let effects = tracker.note_output("t1", "\u{07}", 40);
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn bel_inside_osc_never_completes() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.note_output("t1", "\u{1b}]0;title\u{07}", 20);
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
    }

    #[test]
    fn sandwiched_bell_from_a_subtool_never_completes() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.note_output("t1", "out\u{07}more", 20);
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
    }

    #[test]
    fn stacked_submits_need_matching_bels() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        tracker.note_input("t1", "\r", 20); // queued second turn

        let effects = tracker.note_output("t1", "\u{07}", 30);
        // One down, still busy: busy→busy is not a PUBLIC change (the
        // reference's hasPublicChange), so no upsert — just the completion.
        assert!(busy_upserts(&effects).is_empty());
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);

        let effects = tracker.note_output("t1", "\u{07}", 40);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert_eq!(completions(&effects), vec![2]);
    }

    #[test]
    fn deadman_clears_stuck_busy_without_completion() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);

        // Before the deadman: nothing.
        assert!(tracker.expire(10 + CLAUDE_BUSY_DEADMAN_MS).is_empty());
        // Past it: idle, but NO completion (stuck recovery, not a turn end).
        let effects = tracker.expire(11 + CLAUDE_BUSY_DEADMAN_MS);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn output_feeds_the_deadman() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        tracker.note_output("t1", "streamed output", 100_000);
        // Silence measured from the LAST output, not the submit.
        assert!(tracker.expire(10 + CLAUDE_BUSY_DEADMAN_MS + 1).is_empty());
        let effects = tracker.expire(100_001 + CLAUDE_BUSY_DEADMAN_MS);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
    }

    #[test]
    fn exit_removes_state_and_emits_remove() {
        let mut tracker = ClaudeActivityTracker::new();
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
        // Unknown terminal: no-op.
        assert!(tracker.note_exit("t1").is_empty());
    }

    #[test]
    fn next_deadline_exists_only_while_busy() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        assert_eq!(tracker.next_deadline(), None);
        tracker.note_input("t1", "\r", 10);
        assert_eq!(
            tracker.next_deadline(),
            Some(10 + CLAUDE_BUSY_DEADMAN_MS + 1)
        );
        tracker.note_output("t1", "\u{07}", 20);
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn session_binding_is_a_public_change_and_flows_into_completions() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        let effects = tracker.bind_session("t1", "sess-9");
        assert_eq!(effects.len(), 1);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.note_output("t1", "\u{07}", 20);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("sess-9".to_string())));
    }
}

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
//! * A busy terminal silent past the deadman requests a verify (`ForceRead`)
//!   and STAYS busy (#606); the hub answers from the session-JSONL truth
//!   source via [`ClaudeActivityTracker::note_verified_busy`] /
//!   [`ClaudeActivityTracker::note_verified_ended`] /
//!   [`ClaudeActivityTracker::note_verify_failed`].
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
/// #611: window between a confirmable submit and its JSONL confirm probe
/// (matches amplifier's submit-grace).
pub const CLAUDE_SUBMIT_GRACE_MS: i64 = 2_000;

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
    /// #611: false while a submit is PROVISIONAL (awaiting JSONL confirm).
    busy_confirmed: bool,
    /// #611: armed at a confirmable submit; cleared by every probe
    /// resolution (Confirmed / NoTurnStarted / Unavailable).
    submit_grace_deadline: Option<i64>,
    /// #611: the first grace lapse probed and extended once already.
    submit_grace_retried: bool,
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

#[derive(Debug)]
pub struct ClaudeActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
    /// Busy-deadman window; [`CLAUDE_BUSY_DEADMAN_MS`] in production.
    /// Test-scale hook, same shape as the codex/opencode trackers'.
    busy_deadman_ms: i64,
}

impl Default for ClaudeActivityTracker {
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            ledger: TurnCompletionLedger::default(),
            busy_deadman_ms: CLAUDE_BUSY_DEADMAN_MS,
        }
    }
}

impl ClaudeActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_busy_deadman_ms(&mut self, ms: i64) {
        self.busy_deadman_ms = ms;
    }

    pub fn session_id_of(&self, terminal_id: &str) -> Option<String> {
        self.states
            .get(terminal_id)
            .and_then(|s| s.session_id.clone())
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
            busy_confirmed: false,
            submit_grace_deadline: None,
            submit_grace_retried: false,
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

    pub fn note_input(
        &mut self,
        terminal_id: &str,
        data: &str,
        at: i64,
        confirmable: bool,
    ) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if !is_submit_input(data) {
            return Vec::new();
        }
        state.last_observed_at = at;
        if !confirmable {
            // Legacy flavor (no truth source): today's contract — the
            // #606 deadman verify is the backstop for phantoms.
            let previous = state.to_record();
            state.in_flight += 1;
            state.busy_confirmed = true;
            if state.phase != ClaudePhase::Busy {
                state.phase = ClaudePhase::Busy;
                state.updated_at = at;
            }
            let next = state.to_record();
            return commit_change(Some(&previous), next);
        }
        if state.phase == ClaudePhase::Busy {
            if state.busy_confirmed {
                // Queued turn while a confirmed turn runs — today's rule.
                state.in_flight += 1;
            } else {
                // Repeated Enter while provisional: re-arm the grace.
                state.submit_grace_deadline = Some(at + CLAUDE_SUBMIT_GRACE_MS);
                state.submit_grace_retried = false;
            }
            return Vec::new();
        }
        // #611: provisional busy — no in_flight until the JSONL confirms
        // a turn actually started (kills the phantom-BEL skew).
        let previous = state.to_record();
        state.phase = ClaudePhase::Busy;
        state.updated_at = at;
        state.busy_confirmed = false;
        state.submit_grace_deadline = Some(at + CLAUDE_SUBMIT_GRACE_MS);
        state.submit_grace_retried = false;
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

        // #611: a Stop-BEL during a PROVISIONAL turn is the strongest
        // confirmation there is — confirm and complete in one step so a
        // real fast turn (<grace) never loses its bell.
        if clear_count > 0 && state.phase == ClaudePhase::Busy && !state.busy_confirmed {
            state.busy_confirmed = true;
            state.submit_grace_deadline = None;
            state.in_flight = 1;
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
                outcome: Some(freshell_protocol::TerminalTurnOutcome::Completed),
                outcome_update: false,
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

    /// Busy-deadman — verify-then-decide (#606). Emits a verify request
    /// (`ForceRead`) and STAYS busy; the hub answers from the session
    /// JSONL truth source: verified-busy → refreshed, verified-ended →
    /// [`Self::note_verified_ended`] (idle WITH the completion the old
    /// deadman swallowed), probe failure → [`Self::note_verify_failed`]
    /// (crash semantics). Re-arms via `last_observed_at` so a wedged
    /// probe cannot hot-loop.
    pub fn expire(&mut self, at: i64) -> Vec<ClaudeEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            // #611 submit-grace: first lapse probes once and extends; the
            // second silently reverts (no completion, no bell).
            if let Some(deadline) = state.submit_grace_deadline {
                if at >= deadline && state.phase == ClaudePhase::Busy && !state.busy_confirmed {
                    if !state.submit_grace_retried {
                        state.submit_grace_retried = true;
                        state.submit_grace_deadline = Some(at + CLAUDE_SUBMIT_GRACE_MS);
                        effects.push(TrackerEffect::ForceRead {
                            terminal_id: state.terminal_id.clone(),
                            at,
                        });
                    } else {
                        state.submit_grace_deadline = None;
                        let previous = state.to_record();
                        state.phase = ClaudePhase::Idle;
                        state.updated_at = at;
                        state.last_observed_at = at;
                        let next = state.to_record();
                        effects.extend(commit_change(Some(&previous), next));
                    }
                    continue;
                }
                if at >= deadline {
                    state.submit_grace_deadline = None;
                }
            }
            if state.phase != ClaudePhase::Busy {
                continue;
            }
            let idle_age_ms = at - state.last_observed_at;
            if idle_age_ms <= self.busy_deadman_ms {
                continue;
            }
            state.last_observed_at = at;
            tracing::warn!(
                component = "claude-activity-tracker",
                event = "claude_activity_deadman_verify",
                terminal_id = %state.terminal_id,
                age_ms = idle_age_ms,
                "Claude terminal silent past deadman; requesting JSONL verify (staying busy)."
            );
            effects.push(TrackerEffect::ForceRead {
                terminal_id: state.terminal_id.clone(),
                at,
            });
        }
        effects
    }

    /// Truth source says the turn is still in flight: refresh liveness.
    pub fn note_verified_busy(&mut self, terminal_id: &str, at: i64) -> Vec<ClaudeEffect> {
        if let Some(state) = self.states.get_mut(terminal_id) {
            if state.phase == ClaudePhase::Busy {
                state.last_observed_at = at;
            }
        }
        Vec::new()
    }

    /// Truth source says the turn ENDED (turn_duration / interrupt): clear
    /// busy WITH the completion the old silent deadman swallowed.
    pub fn note_verified_ended(&mut self, terminal_id: &str, at: i64) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.phase != ClaudePhase::Busy {
            return Vec::new();
        }
        let previous = state.to_record();
        state.phase = ClaudePhase::Idle;
        state.in_flight = 0;
        state.busy_confirmed = false;
        state.submit_grace_deadline = None;
        state.updated_at = at;
        state.last_observed_at = at;
        let next = state.to_record();
        let mut effects = commit_change(Some(&previous), next);
        let seq = self.ledger.record_turn_completion(terminal_id, at);
        effects.push(TrackerEffect::TurnComplete {
            terminal_id: terminal_id.to_string(),
            session_id: self
                .states
                .get(terminal_id)
                .and_then(|s| s.session_id.clone()),
            at,
            completion_seq: seq,
            outcome: Some(freshell_protocol::TerminalTurnOutcome::Completed),
            outcome_update: false,
        });
        effects
    }

    /// The verify probe failed (no JSONL / unreadable / no bound session /
    /// no truth source installed). Owner ruling: crash semantics — clear
    /// busy AND fire the attention/death engagement signal.
    pub fn note_verify_failed(&mut self, terminal_id: &str, at: i64) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.phase != ClaudePhase::Busy {
            return Vec::new();
        }
        tracing::error!(
            component = "claude-activity-tracker",
            event = "claude_verify_failed",
            terminal_id = %state.terminal_id,
            "claude verify probe failed; clearing busy and ringing attention (owner ruling: probe failure = crash)"
        );
        let previous = state.to_record();
        state.phase = ClaudePhase::Idle;
        state.in_flight = 0;
        state.busy_confirmed = false;
        state.submit_grace_deadline = None;
        state.updated_at = at;
        state.last_observed_at = at;
        let next = state.to_record();
        let mut effects = commit_change(Some(&previous), next);
        effects.push(TrackerEffect::AttentionBoundary {
            terminal_id: terminal_id.to_string(),
            at,
        });
        effects
    }

    /// Truth source (probe_submit) confirmed the provisional turn: it is
    /// real — `in_flight = 1` and the BEL machinery proceeds as today.
    pub fn note_submit_confirmed(&mut self, terminal_id: &str, at: i64) -> Vec<ClaudeEffect> {
        if let Some(state) = self.states.get_mut(terminal_id) {
            if state.phase == ClaudePhase::Busy && !state.busy_confirmed {
                state.busy_confirmed = true;
                state.in_flight = 1;
                state.submit_grace_deadline = None;
                state.last_observed_at = at;
            }
        }
        Vec::new()
    }

    /// Truth source says nothing was appended: the Enter was a no-op.
    /// SILENT revert — idle, no completion, no bell (#611; amplifier
    /// precedent — a no-op Enter is not attention-worthy).
    pub fn note_submit_unconfirmed(&mut self, terminal_id: &str, at: i64) -> Vec<ClaudeEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.phase != ClaudePhase::Busy || state.busy_confirmed {
            return Vec::new();
        }
        state.submit_grace_deadline = None;
        let previous = state.to_record();
        state.phase = ClaudePhase::Idle;
        state.updated_at = at;
        state.last_observed_at = at;
        let next = state.to_record();
        commit_change(Some(&previous), next)
    }

    /// The confirm probe could not reach the truth source: keep the
    /// provisional busy and stop probing.
    pub fn note_submit_probe_unavailable(&mut self, terminal_id: &str) {
        if let Some(state) = self.states.get_mut(terminal_id) {
            // Clearing the deadline also exits the awaiting-confirm state
            // (see is_awaiting_submit_confirm) — the pane's next ForceRead
            // routes to the #606 deadman-verify flavor.
            state.submit_grace_deadline = None; // deadman backstop takes over
        }
    }

    /// Hub routing: distinguishes the confirm-probe flavor from the
    /// deadman-verify flavor of `ForceRead`.
    pub fn is_awaiting_submit_confirm(&self, terminal_id: &str) -> bool {
        // The deadline term is LOAD-BEARING: it is Some for exactly the
        // window between a confirmable submit and the probe's resolution
        // (Confirmed / NoTurnStarted / Unavailable all clear it). After
        // resolution, a deadman ForceRead must fall through to the
        // turn-state verify flavor — without this term, one Unavailable
        // probe would wedge the pane busy forever (every later ForceRead
        // re-entering the confirm flavor and no-oping).
        self.states
            .get(terminal_id)
            .map(|s| {
                s.phase == ClaudePhase::Busy
                    && !s.busy_confirmed
                    && s.submit_grace_deadline.is_some()
            })
            .unwrap_or(false)
    }

    /// Earliest instant at which [`Self::expire`] could change any state:
    /// per busy state the soonest of the submit-grace deadline (#611,
    /// unconfirmed only) and the busy deadman (ANY confirmation state —
    /// the deadman is the backstop for an unverifiable provisional pane).
    /// `None` when nothing is busy — zero timers.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter(|s| s.phase == ClaudePhase::Busy)
            .filter_map(|s| {
                let deadman = s.last_observed_at + self.busy_deadman_ms + 1;
                let grace = if s.busy_confirmed {
                    None
                } else {
                    s.submit_grace_deadline
                };
                [Some(deadman), grace].into_iter().flatten().min()
            })
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

        let effects = tracker.note_input("t1", "\r", 10, false);
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
    fn terminal_stop_boundary_reports_explicit_success_outcome() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", Some("session-1"), 0);
        tracker.note_input("t1", "\r", 10, false);

        let effects = tracker.note_output("t1", "\u{07}", 20);
        assert!(effects.iter().any(|effect| matches!(
            effect,
            TrackerEffect::TurnComplete {
                outcome: Some(freshell_protocol::TerminalTurnOutcome::Completed),
                ..
            }
        )));
    }

    #[test]
    fn bel_inside_osc_never_completes() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        let effects = tracker.note_output("t1", "\u{1b}]0;title\u{07}", 20);
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
    }

    #[test]
    fn sandwiched_bell_from_a_subtool_never_completes() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        let effects = tracker.note_output("t1", "out\u{07}more", 20);
        assert!(completions(&effects).is_empty());
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
    }

    #[test]
    fn stacked_submits_need_matching_bels() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        tracker.note_input("t1", "\r", 20, false); // queued second turn

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
    fn deadman_requests_verify_and_stays_busy() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.set_busy_deadman_ms(1000);
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        assert!(tracker.expire(1010).is_empty(), "not past the window yet");
        let effects = tracker.expire(1011 + 1);
        assert_eq!(
            effects,
            vec![TrackerEffect::ForceRead {
                terminal_id: "t1".to_string(),
                at: 1012,
            }]
        );
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
        assert!(tracker.next_deadline().is_some(), "re-armed, no hot loop");
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn verified_ended_clears_with_a_completion_bell() {
        // The old deadman swallowed the bell; the verified end mints it.
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        let effects = tracker.note_verified_ended("t1", 500);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert_eq!(completions(&effects), vec![1]);
        // A stray later BEL is a false positive: ignored (in_flight == 0).
        assert!(completions(&tracker.note_output("t1", "\u{07}", 600)).is_empty());
    }

    #[test]
    fn verified_busy_refreshes_and_verify_failed_rings_attention() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.set_busy_deadman_ms(1000);
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        tracker.expire(2000); // verify requested
        assert!(tracker.note_verified_busy("t1", 2100).is_empty());
        assert_eq!(tracker.next_deadline(), Some(2100 + 1000 + 1));
        // Probe failure: crash semantics — idle + attention boundary.
        let effects = tracker.note_verify_failed("t1", 3000);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert!(matches!(
            effects.last(),
            Some(TrackerEffect::AttentionBoundary { at: 3000, .. })
        ));
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn output_feeds_the_deadman() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        tracker.note_output("t1", "streamed output", 100_000);
        // Silence measured from the LAST output, not the submit.
        assert!(tracker.expire(10 + CLAUDE_BUSY_DEADMAN_MS + 1).is_empty());
        let effects = tracker.expire(100_001 + CLAUDE_BUSY_DEADMAN_MS);
        assert!(
            matches!(effects.as_slice(), [TrackerEffect::ForceRead { .. }]),
            "past the window: verify, don't demote (#606); got {effects:?}"
        );
    }

    #[test]
    fn exit_removes_state_and_emits_remove() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
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
        tracker.note_input("t1", "\r", 10, false);
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
        tracker.note_input("t1", "\r", 10, false);
        let effects = tracker.note_output("t1", "\u{07}", 20);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("sess-9".to_string())));
    }

    #[test]
    fn confirmable_enter_is_provisional_and_silently_reverts() {
        // #611: a bare Enter must not claim "working" for 120s. Amplifier
        // contract: one confirm probe, one extension, then silent revert.
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", Some("S"), 0);
        let effects = tracker.note_input("t1", "\r", 10, true);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Busy)]
        );
        assert_eq!(tracker.next_deadline(), Some(10 + 2000));
        // First grace lapse: ONE confirm probe, still busy, extended.
        let effects = tracker.expire(2010);
        assert!(matches!(
            effects.as_slice(),
            [TrackerEffect::ForceRead { .. }]
        ));
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
        // Second lapse: SILENT revert — idle, no completion, no boundary.
        let effects = tracker.expire(4020);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert!(completions(&effects).is_empty());
        assert!(!effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })));
        // The phantom left NO in_flight skew: a real turn now completes
        // with its own single BEL.
        tracker.note_input("t1", "\r", 5000, true);
        tracker.note_submit_confirmed("t1", 5100);
        let effects = tracker.note_output("t1", "\u{07}", 6000);
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Idle);
    }

    #[test]
    fn confirmed_submit_behaves_like_todays_turn() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", Some("S"), 0);
        tracker.note_input("t1", "\r", 10, true);
        assert!(tracker.note_submit_confirmed("t1", 200).is_empty());
        // Grace is disarmed: nothing at the old deadline.
        assert!(tracker.expire(2010).is_empty());
        let effects = tracker.note_output("t1", "\u{07}", 3000);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn probe_says_no_turn_reverts_immediately_and_unavailable_keeps_busy() {
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", Some("S"), 0);
        tracker.note_input("t1", "\r", 10, true);
        let effects = tracker.note_submit_unconfirmed("t1", 100);
        assert_eq!(
            busy_upserts(&effects),
            vec![("t1".into(), ClaudePhase::Idle)]
        );
        assert!(completions(&effects).is_empty());
        // Unavailable: keep provisional busy, stop the grace probing —
        // the #606 deadman verify is the deterministic backstop.
        tracker.note_input("t1", "\r", 200, true);
        tracker.note_submit_probe_unavailable("t1");
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Busy);
        assert!(
            !tracker.is_awaiting_submit_confirm("t1"),
            "Unavailable exits the confirm flavor — the next ForceRead \
             must route to the #606 deadman verify, not back here"
        );
        assert_eq!(
            tracker.next_deadline(),
            Some(200 + CLAUDE_BUSY_DEADMAN_MS + 1),
            "grace disarmed; deadman remains"
        );
    }

    #[test]
    fn bel_during_provisional_confirms_and_completes() {
        // A real fast turn (<2s) must not lose its bell.
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", Some("S"), 0);
        tracker.note_input("t1", "\r", 10, true);
        let effects = tracker.note_output("t1", "\u{07}", 1500);
        assert_eq!(completions(&effects), vec![1]);
        assert_eq!(tracker.list()[0].phase, ClaudePhase::Idle);
    }

    #[test]
    fn unconfirmable_enter_keeps_legacy_semantics() {
        // No truth source: today's contract exactly (in_flight, BEL).
        let mut tracker = ClaudeActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10, false);
        assert!(tracker.expire(2011).is_empty(), "no grace machinery");
        let effects = tracker.note_output("t1", "\u{07}", 3000);
        assert_eq!(completions(&effects), vec![1]);
    }
}

//! Port of `server/coding-cli/amplifier-activity-tracker.ts` (frozen parity
//! reference).
//!
//! Server-authoritative Amplifier turn lifecycle, keyed by terminalId — the
//! single events-driven state machine:
//!
//! * PTY Enter (`note_input` + submit-shaped) is only a PROVISIONAL busy with
//!   a submit-grace reversion (one force-read retry, then a silent revert —
//!   no turn.complete). A `prompt:submit` record (reducer `TurnBegan` effect
//!   via [`AmplifierActivityTracker::apply_lifecycle`]) confirms busy;
//!   `prompt:complete`/`session:end` (`TurnCompleted`) is the single turn
//!   boundary and emits exactly one turn.complete via the ledger.
//! * PTY output only refreshes liveness (feeds the deadman). The deadman
//!   never fabricates a completion: it requests a force-read of the events
//!   tail and STAYS busy.
//! * Signal loss (tailer degraded/detached) reverts busy to idle silently.
//!
//! Zero-polling deviations from the reference (adjudicated, see PR):
//! * grace timers are deadlines processed by `expire(at)` + `next_deadline()`
//!   one-shot scheduling, not `setTimeout`s;
//! * the stuck-busy deadman force-read repeats every [`AMPLIFIER_BUSY_DEADMAN_MS`]
//!   (the reference re-emits every 5s sweep tick while stuck; a 5s repeat is
//!   polling by another name and the force-read is idempotent).

use std::collections::HashMap;

use freshell_protocol::{AmplifierActivityRecord, AmplifierPhase};

use super::reducer::ReducerEffect;
use crate::ledger::TurnCompletionLedger;
use crate::signal::is_submit_input;
use crate::TrackerEffect;

pub const AMPLIFIER_BUSY_DEADMAN_MS: i64 = 120_000;
pub const AMPLIFIER_SUBMIT_GRACE_MS: i64 = 2_000;
pub const AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD: u32 = 3;

pub type AmplifierEffect = TrackerEffect<AmplifierActivityRecord>;

#[derive(Debug)]
struct TerminalActivity {
    terminal_id: String,
    session_id: Option<String>,
    phase: AmplifierPhase,
    updated_at: i64,
    last_observed_at: i64,
    busy_confirmed: bool,
    submit_grace_deadline: Option<i64>,
    submit_grace_retried: bool,
    grace_reversion_count: u32,
    force_read_logged: bool,
    next_force_read_at: Option<i64>,
}

impl TerminalActivity {
    fn to_record(&self) -> AmplifierActivityRecord {
        AmplifierActivityRecord {
            terminal_id: self.terminal_id.clone(),
            phase: self.phase,
            updated_at: self.updated_at,
            session_id: self.session_id.clone(),
        }
    }
}

fn has_public_change(
    previous: Option<&AmplifierActivityRecord>,
    next: &AmplifierActivityRecord,
) -> bool {
    match previous {
        None => true,
        Some(previous) => previous.phase != next.phase || previous.session_id != next.session_id,
    }
}

fn changed(
    previous: Option<&AmplifierActivityRecord>,
    next: AmplifierActivityRecord,
) -> Vec<AmplifierEffect> {
    if !has_public_change(previous, &next) {
        return Vec::new();
    }
    vec![TrackerEffect::Changed {
        upsert: vec![next],
        remove: Vec::new(),
    }]
}

#[derive(Debug, Default)]
pub struct AmplifierActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
}

impl AmplifierActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<AmplifierActivityRecord> {
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
    ) -> Vec<AmplifierEffect> {
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
            phase: AmplifierPhase::Idle,
            updated_at: at,
            last_observed_at: at,
            busy_confirmed: false,
            submit_grace_deadline: None,
            submit_grace_retried: false,
            grace_reversion_count: 0,
            force_read_logged: false,
            next_force_read_at: None,
        };
        let next = state.to_record();
        self.states.insert(terminal_id.to_string(), state);
        changed(None, next)
    }

    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<AmplifierEffect> {
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

    /// The events signal for this terminal is gone (tailer degraded or
    /// detached). Busy reverts to idle silently — never a turn.complete.
    pub fn note_events_signal_lost(&mut self, terminal_id: &str, at: i64) -> Vec<AmplifierEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        state.submit_grace_deadline = None;
        state.busy_confirmed = false;
        state.force_read_logged = false;
        state.next_force_read_at = None;
        if state.phase != AmplifierPhase::Busy {
            return Vec::new();
        }
        let previous = state.to_record();
        state.phase = AmplifierPhase::Idle;
        state.updated_at = at;
        state.last_observed_at = at;
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// Consume a reducer effect (the events-lane transition table).
    pub fn apply_lifecycle(
        &mut self,
        terminal_id: &str,
        effect: &ReducerEffect,
        now: i64,
    ) -> Vec<AmplifierEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        match effect {
            ReducerEffect::LaneDegrade { .. } => self.note_events_signal_lost(terminal_id, now),
            ReducerEffect::TurnBegan { at } => {
                let at = parse_effect_at(at.as_deref(), now);
                state.submit_grace_deadline = None;
                state.busy_confirmed = true;
                state.force_read_logged = false;
                state.next_force_read_at = None;
                state.grace_reversion_count = 0;
                state.last_observed_at = at;
                if state.phase != AmplifierPhase::Busy {
                    let previous = state.to_record();
                    state.phase = AmplifierPhase::Busy;
                    state.updated_at = at;
                    let next = state.to_record();
                    return changed(Some(&previous), next);
                }
                Vec::new()
            }
            ReducerEffect::TurnCompleted { at } => {
                let at = parse_effect_at(at.as_deref(), now);
                if state.phase != AmplifierPhase::Busy {
                    return Vec::new();
                }
                let previous = state.to_record();
                state.submit_grace_deadline = None;
                state.phase = AmplifierPhase::Idle;
                state.busy_confirmed = false;
                state.force_read_logged = false;
                state.next_force_read_at = None;
                state.updated_at = at;
                state.last_observed_at = at;
                let seq = self.ledger.record_turn_completion(terminal_id, at);
                let session_id = self
                    .states
                    .get(terminal_id)
                    .and_then(|s| s.session_id.clone());
                let next = self.states.get(terminal_id).unwrap().to_record();
                let mut effects = changed(Some(&previous), next);
                effects.push(TrackerEffect::TurnComplete {
                    terminal_id: terminal_id.to_string(),
                    session_id,
                    at,
                    completion_seq: seq,
                });
                effects
            }
            ReducerEffect::SessionIdentified { session_id, .. } => match session_id {
                Some(session_id) => self.bind_session(terminal_id, session_id),
                None => Vec::new(),
            },
        }
    }

    /// PTY Enter: provisional busy with a grace deadline (empty-Enter writes
    /// zero events). Submit during busy re-arms NOTHING — mid-turn typing is
    /// queued steering within the same turn.
    pub fn note_input(&mut self, terminal_id: &str, data: &str, at: i64) -> Vec<AmplifierEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if !is_submit_input(data) {
            return Vec::new();
        }
        state.last_observed_at = at;
        if state.phase == AmplifierPhase::Busy {
            return Vec::new();
        }
        let previous = state.to_record();
        state.phase = AmplifierPhase::Busy;
        state.busy_confirmed = false;
        state.submit_grace_retried = false;
        state.updated_at = at;
        state.submit_grace_deadline = Some(at + AMPLIFIER_SUBMIT_GRACE_MS);
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// PTY output only refreshes liveness. It never ends a turn.
    pub fn note_output(&mut self, terminal_id: &str, at: i64) {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return;
        };
        if state.phase != AmplifierPhase::Busy {
            return;
        }
        state.last_observed_at = at;
        state.force_read_logged = false;
    }

    /// PTY exit is the authoritative end — unconditional.
    pub fn note_exit(&mut self, terminal_id: &str) -> Vec<AmplifierEffect> {
        if self.states.remove(terminal_id).is_none() {
            return Vec::new();
        }
        vec![TrackerEffect::Changed {
            upsert: Vec::new(),
            remove: vec![terminal_id.to_string()],
        }]
    }

    /// Process due grace deadlines and the stuck-busy deadman.
    pub fn expire(&mut self, at: i64) -> Vec<AmplifierEffect> {
        let mut effects = Vec::new();
        for state in self.states.values_mut() {
            // Submit-grace: first expiry force-reads and extends once; the
            // second silently reverts (no completion).
            if let Some(deadline) = state.submit_grace_deadline {
                if at >= deadline && state.phase == AmplifierPhase::Busy && !state.busy_confirmed {
                    if !state.submit_grace_retried {
                        state.submit_grace_retried = true;
                        state.submit_grace_deadline = Some(at + AMPLIFIER_SUBMIT_GRACE_MS);
                        effects.push(TrackerEffect::ForceRead {
                            terminal_id: state.terminal_id.clone(),
                            at,
                        });
                    } else {
                        state.submit_grace_deadline = None;
                        let previous = state.to_record();
                        state.phase = AmplifierPhase::Idle;
                        state.updated_at = at;
                        state.last_observed_at = at;
                        state.grace_reversion_count += 1;
                        if state.grace_reversion_count
                            == AMPLIFIER_GRACE_REVERSION_SUSPECT_THRESHOLD
                        {
                            tracing::warn!(
                                component = "amplifier-activity-tracker",
                                event = "amplifier_events_lane_suspect",
                                terminal_id = %state.terminal_id,
                                reversions = state.grace_reversion_count,
                                "Amplifier tracker saw repeated submit-grace reversions; the events watcher may be dead."
                            );
                        }
                        let next = state.to_record();
                        effects.extend(changed(Some(&previous), next));
                    }
                    continue;
                }
                if at >= deadline {
                    // Confirmed (or no longer busy) before the deadline hit.
                    state.submit_grace_deadline = None;
                }
            }

            // Deadman: a busy terminal silent past the window requests a
            // force-read and STAYS busy — never fabricate a completion.
            if state.phase == AmplifierPhase::Busy && state.busy_confirmed {
                let idle_age_ms = at - state.last_observed_at;
                let due = state
                    .next_force_read_at
                    .map(|next| at >= next)
                    .unwrap_or(idle_age_ms > AMPLIFIER_BUSY_DEADMAN_MS);
                if idle_age_ms > AMPLIFIER_BUSY_DEADMAN_MS && due {
                    if !state.force_read_logged {
                        state.force_read_logged = true;
                        tracing::warn!(
                            component = "amplifier-activity-tracker",
                            event = "amplifier_activity_deadman_force_read",
                            terminal_id = %state.terminal_id,
                            age_ms = idle_age_ms,
                            "Amplifier terminal silent past deadman; requesting force-read (staying busy)."
                        );
                    }
                    state.next_force_read_at = Some(at + AMPLIFIER_BUSY_DEADMAN_MS);
                    effects.push(TrackerEffect::ForceRead {
                        terminal_id: state.terminal_id.clone(),
                        at,
                    });
                }
            }
        }
        effects
    }

    /// Earliest instant [`Self::expire`] could act. `None` when nothing is
    /// busy — zero timers, zero wakes.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states
            .values()
            .filter_map(|state| {
                let grace = state
                    .submit_grace_deadline
                    .filter(|_| state.phase == AmplifierPhase::Busy && !state.busy_confirmed);
                let deadman = if state.phase == AmplifierPhase::Busy && state.busy_confirmed {
                    Some(
                        state
                            .next_force_read_at
                            .unwrap_or(state.last_observed_at + AMPLIFIER_BUSY_DEADMAN_MS + 1),
                    )
                } else {
                    None
                };
                match (grace, deadman) {
                    (Some(g), Some(d)) => Some(g.min(d)),
                    (Some(g), None) => Some(g),
                    (None, Some(d)) => Some(d),
                    (None, None) => None,
                }
            })
            .min()
    }
}

/// Effect timestamps are ISO strings carried through from the log — never
/// used to gate transitions, only for `updatedAt`/`at` fields.
fn parse_effect_at(at: Option<&str>, now: i64) -> i64 {
    at.and_then(chrono_free_parse_iso_ms).unwrap_or(now)
}

/// Minimal ISO-8601 → epoch-ms parse without a chrono dependency. Returns
/// `None` for anything it can't parse (falls back to `now`).
fn chrono_free_parse_iso_ms(s: &str) -> Option<i64> {
    // Format: YYYY-MM-DDTHH:MM:SS(.fff...)(Z|±HH:MM)
    let bytes = s.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    let rest = s.get(19..)?;
    let (millis, tz_rest) = if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let after = &stripped[digits.len()..];
        let ms: i64 = format!("{:0<3}", digits.chars().take(3).collect::<String>())
            .parse()
            .ok()?;
        (ms, after)
    } else {
        (0, rest)
    };
    let offset_minutes: i64 = match tz_rest {
        "Z" | "z" | "" => 0,
        _ => {
            let sign = match tz_rest.as_bytes().first() {
                Some(b'+') => 1,
                Some(b'-') => -1,
                _ => return None,
            };
            let h: i64 = tz_rest.get(1..3)?.parse().ok()?;
            let m: i64 = tz_rest.get(4..6).and_then(|m| m.parse().ok()).unwrap_or(0);
            sign * (h * 60 + m)
        }
    };
    // Days since epoch (civil-from-days algorithm, Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(secs * 1_000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phases(effects: &[AmplifierEffect]) -> Vec<AmplifierPhase> {
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

    fn completions(effects: &[AmplifierEffect]) -> Vec<i64> {
        effects
            .iter()
            .filter_map(|e| match e {
                TrackerEffect::TurnComplete { completion_seq, .. } => Some(*completion_seq),
                _ => None,
            })
            .collect()
    }

    fn force_reads(effects: &[AmplifierEffect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, TrackerEffect::ForceRead { .. }))
            .count()
    }

    #[test]
    fn iso_parse_matches_known_values() {
        assert_eq!(
            chrono_free_parse_iso_ms("1970-01-01T00:00:00.000Z"),
            Some(0)
        );
        // date -d '2026-07-23T10:00:00.500Z' +%s%3N == 1784800800500
        assert_eq!(
            chrono_free_parse_iso_ms("2026-07-23T10:00:00.500Z"),
            Some(1_784_800_800_500)
        );
        assert_eq!(chrono_free_parse_iso_ms("garbage"), None);
    }

    #[test]
    fn pty_enter_is_provisional_and_prompt_submit_confirms() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);

        let effects = tracker.note_input("t1", "\r", 10);
        assert_eq!(phases(&effects), vec![AmplifierPhase::Busy]);

        // The prompt:submit record confirms — no public flap.
        let effects = tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 500);
        assert!(effects.is_empty());

        // Confirmed busy no longer reverts at the grace deadline.
        assert!(tracker
            .expire(10 + AMPLIFIER_SUBMIT_GRACE_MS + 1)
            .is_empty());
        assert_eq!(tracker.list()[0].phase, AmplifierPhase::Busy);
    }

    #[test]
    fn empty_enter_force_reads_once_then_silently_reverts() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);

        // First grace expiry: a force-read retry, still busy (no flap).
        let first = tracker.expire(10 + AMPLIFIER_SUBMIT_GRACE_MS);
        assert_eq!(force_reads(&first), 1);
        assert!(phases(&first).is_empty());
        assert_eq!(tracker.list()[0].phase, AmplifierPhase::Busy);

        // Second expiry: silent reversion, NO completion.
        let second = tracker.expire(10 + 2 * AMPLIFIER_SUBMIT_GRACE_MS);
        assert_eq!(phases(&second), vec![AmplifierPhase::Idle]);
        assert!(completions(&second).is_empty());
    }

    #[test]
    fn prompt_complete_is_the_single_boundary_and_emits_one_completion() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", Some("sess-1"), 0);
        tracker.note_input("t1", "\r", 10);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 20);

        let effects =
            tracker.apply_lifecycle("t1", &ReducerEffect::TurnCompleted { at: None }, 900);
        assert_eq!(phases(&effects), vec![AmplifierPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);

        // A duplicate completed at idle is ignored.
        let effects =
            tracker.apply_lifecycle("t1", &ReducerEffect::TurnCompleted { at: None }, 950);
        assert!(effects.is_empty());
    }

    #[test]
    fn subagent_style_repeat_submits_never_double_begin() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);
        // A second TurnBegan while busy (reducer suppresses these, but the
        // tracker must also be idempotent).
        let effects = tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 20);
        assert!(effects.is_empty());
    }

    #[test]
    fn deadman_force_reads_but_stays_busy() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);

        let effects = tracker.expire(10 + AMPLIFIER_BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1);
        assert_eq!(tracker.list()[0].phase, AmplifierPhase::Busy);

        // Not due again until the repeat interval.
        assert!(tracker
            .expire(10 + AMPLIFIER_BUSY_DEADMAN_MS + 2)
            .is_empty());
    }

    #[test]
    fn signal_loss_reverts_busy_silently() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);
        let effects = tracker.note_events_signal_lost("t1", 20);
        assert_eq!(phases(&effects), vec![AmplifierPhase::Idle]);
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn output_feeds_the_deadman_only() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);
        tracker.note_output("t1", 100_000);
        assert!(tracker
            .expire(10 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
            .is_empty());
        let effects = tracker.expire(100_000 + AMPLIFIER_BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&effects), 1);
    }

    #[test]
    fn exit_removes_unconditionally() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);
        let effects = tracker.note_exit("t1");
        assert_eq!(
            effects,
            vec![TrackerEffect::Changed {
                upsert: vec![],
                remove: vec!["t1".to_string()]
            }]
        );
    }

    #[test]
    fn next_deadline_tracks_grace_then_deadman_then_none() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        assert_eq!(tracker.next_deadline(), None);

        tracker.note_input("t1", "\r", 10);
        assert_eq!(
            tracker.next_deadline(),
            Some(10 + AMPLIFIER_SUBMIT_GRACE_MS)
        );

        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 20);
        assert_eq!(
            tracker.next_deadline(),
            Some(20 + AMPLIFIER_BUSY_DEADMAN_MS + 1)
        );

        tracker.apply_lifecycle("t1", &ReducerEffect::TurnCompleted { at: None }, 30);
        assert_eq!(tracker.next_deadline(), None);
    }

    #[test]
    fn session_identified_binds_and_flows_into_completions() {
        let mut tracker = AmplifierActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        let effects = tracker.apply_lifecycle(
            "t1",
            &ReducerEffect::SessionIdentified {
                session_id: Some("sess-7".into()),
                cwd: "/x".into(),
            },
            5,
        );
        assert_eq!(effects.len(), 1);
        tracker.apply_lifecycle("t1", &ReducerEffect::TurnBegan { at: None }, 10);
        let effects = tracker.apply_lifecycle("t1", &ReducerEffect::TurnCompleted { at: None }, 20);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("sess-7".to_string())));
    }
}

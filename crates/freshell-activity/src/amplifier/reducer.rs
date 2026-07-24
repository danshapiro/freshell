//! Port of `server/coding-cli/amplifier-events-reducer.ts` (frozen parity
//! reference).
//!
//! Pure reducer for Amplifier's `events.jsonl` lifecycle records — no I/O, no
//! timers: `(state, record) -> (state, effects)`.
//!
//! Contract facts encoded (plan §2 of the legacy durability plan):
//! * `prompt:submit` is the ONLY input that (re)enters busy (E2/E5).
//! * `prompt:complete` is the single turn boundary (E2/E3).
//! * `session:end` while busy ends the turn (E7); while idle it is ignored.
//! * `session:resume` never implies a phase change (E7).
//! * Transitions key on event TYPE only; timestamps are carried through for
//!   `at` fields but never used to order or gate transitions (E3).
//! * Schema gate: `amplifier.log`, major version 1 (E10); anything else
//!   degrades the lane once and the reducer goes inert.

use serde_json::Value;

pub const AMPLIFIER_LOG_SCHEMA_NAME: &str = "amplifier.log";
pub const AMPLIFIER_LOG_SCHEMA_MAJOR: i64 = 1;

/// A parsed events.jsonl record — only the small envelope fields the reducer
/// keys on. Lines are parsed as opaque JSON and the envelope extracted; the
/// (potentially 100k+ token) `data` payload is never cloned beyond the two
/// fields the transition table reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRecord {
    pub event: String,
    pub ts: Option<String>,
    pub session_id: Option<String>,
    pub schema_name: Option<String>,
    pub schema_ver: Option<String>,
    /// `data.parent_id` — subagent indicator on `session:start`.
    pub parent_id: Option<String>,
    /// `data.raw.working_dir` / `data.raw.project_dir` — `session:config` cwd.
    pub config_cwd: Option<String>,
}

impl ParsedRecord {
    /// Extract the envelope from a parsed JSON line. Returns `None` when the
    /// line has no string `event` field (not a lifecycle record).
    pub fn from_json(value: &Value) -> Option<Self> {
        let event = value.get("event")?.as_str()?.to_string();
        let schema = value.get("schema");
        let data = value.get("data");
        let raw = data.and_then(|d| d.get("raw"));
        let config_cwd = raw
            .and_then(|r| r.get("working_dir"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                raw.and_then(|r| r.get("project_dir"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_string);
        Some(Self {
            event,
            ts: value.get("ts").and_then(Value::as_str).map(str::to_string),
            session_id: value
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            schema_name: schema
                .and_then(|s| s.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            schema_ver: schema
                .and_then(|s| s.get("ver"))
                .and_then(Value::as_str)
                .map(str::to_string),
            parent_id: data
                .and_then(|d| d.get("parent_id"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            config_cwd,
        })
    }

    /// True when the record has a `schema` object at all (the gate
    /// distinguishes a missing object from a mismatched one).
    fn has_schema(&self) -> bool {
        self.schema_name.is_some() || self.schema_ver.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Idle,
    Busy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReducerState {
    pub phase: LifecyclePhase,
    /// Sticky: set by a schema-gate failure; all further records are ignored.
    pub degraded: bool,
    /// True once a subagent indicator was seen (`session:fork`, or
    /// `session:start` with a `parent_id`).
    pub subagent: bool,
    /// First `session_id` observed on any record.
    pub session_id: Option<String>,
}

pub fn create_reducer_state() -> ReducerState {
    ReducerState {
        phase: LifecyclePhase::Idle,
        degraded: false,
        subagent: false,
        session_id: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaGateFailure {
    SchemaMissing,
    SchemaNameMismatch,
    SchemaVersionUnsupported,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReducerEffect {
    TurnBegan {
        at: Option<String>,
    },
    TurnCompleted {
        at: Option<String>,
    },
    SessionIdentified {
        session_id: Option<String>,
        cwd: String,
    },
    LaneDegrade {
        reason: SchemaGateFailure,
    },
}

/// Schema gate (E10): accept `amplifier.log` major version 1.
pub fn check_amplifier_record_schema(record: &ParsedRecord) -> Option<SchemaGateFailure> {
    if !record.has_schema() {
        return Some(SchemaGateFailure::SchemaMissing);
    }
    if record.schema_name.as_deref() != Some(AMPLIFIER_LOG_SCHEMA_NAME) {
        return Some(SchemaGateFailure::SchemaNameMismatch);
    }
    let major = record
        .schema_ver
        .as_deref()
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("")
        .parse::<i64>();
    match major {
        Ok(major) if major == AMPLIFIER_LOG_SCHEMA_MAJOR => None,
        _ => Some(SchemaGateFailure::SchemaVersionUnsupported),
    }
}

fn is_subagent_indicator(record: &ParsedRecord) -> bool {
    if record.event == "session:fork" {
        return true;
    }
    record.event == "session:start" && record.parent_id.is_some()
}

pub fn reduce_amplifier_event(
    state: &ReducerState,
    record: &ParsedRecord,
) -> (ReducerState, Vec<ReducerEffect>) {
    if state.degraded {
        return (state.clone(), Vec::new());
    }

    if let Some(failure) = check_amplifier_record_schema(record) {
        let mut next = state.clone();
        next.degraded = true;
        return (next, vec![ReducerEffect::LaneDegrade { reason: failure }]);
    }

    let mut next = state.clone();
    if next.session_id.is_none() {
        if let Some(session_id) = &record.session_id {
            next.session_id = Some(session_id.clone());
        }
    }
    if is_subagent_indicator(record) && !next.subagent {
        next.subagent = true;
    }

    match record.event.as_str() {
        "prompt:submit" => {
            // busy -> busy is a confirm, not a new turn: no duplicate began.
            if next.phase == LifecyclePhase::Busy {
                return (next, Vec::new());
            }
            next.phase = LifecyclePhase::Busy;
            let at = record.ts.clone();
            (next, vec![ReducerEffect::TurnBegan { at }])
        }
        "prompt:complete" | "session:end" => {
            if next.phase != LifecyclePhase::Busy {
                return (next, Vec::new());
            }
            next.phase = LifecyclePhase::Idle;
            let at = record.ts.clone();
            (next, vec![ReducerEffect::TurnCompleted { at }])
        }
        "session:config" => {
            let Some(cwd) = record.config_cwd.clone() else {
                return (next, Vec::new());
            };
            let session_id = record.session_id.clone();
            (
                next,
                vec![ReducerEffect::SessionIdentified { session_id, cwd }],
            )
        }
        // session:resume never implies busy; everything else (session:start,
        // execution:*, llm:*, tool:*, orchestrator:*, ...) never changes phase
        // — post-complete background naming events are covered here (E2).
        _ => (next, Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(event: &str) -> ParsedRecord {
        ParsedRecord::from_json(&json!({
            "ts": "2026-07-23T10:00:00.000Z",
            "schema": { "name": "amplifier.log", "ver": "1.0.0" },
            "event": event,
            "session_id": "sess-1",
            "data": {}
        }))
        .unwrap()
    }

    #[test]
    fn prompt_submit_begins_a_turn_and_confirms_without_duplicating() {
        let state = create_reducer_state();
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:submit"));
        assert_eq!(state.phase, LifecyclePhase::Busy);
        assert!(matches!(effects[0], ReducerEffect::TurnBegan { .. }));

        // busy -> busy: a confirm, no duplicate turn.began.
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:submit"));
        assert_eq!(state.phase, LifecyclePhase::Busy);
        assert!(effects.is_empty());
    }

    #[test]
    fn prompt_complete_is_the_single_turn_boundary() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:complete"));
        assert_eq!(state.phase, LifecyclePhase::Idle);
        assert!(matches!(effects[0], ReducerEffect::TurnCompleted { .. }));

        // At idle it's just another record: ignored.
        let (_, effects) = reduce_amplifier_event(&state, &record("prompt:complete"));
        assert!(effects.is_empty());
    }

    #[test]
    fn session_end_ends_a_busy_turn_and_is_legal_at_idle() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("prompt:submit"));
        let (state, effects) = reduce_amplifier_event(&state, &record("session:end"));
        assert!(matches!(effects[0], ReducerEffect::TurnCompleted { .. }));
        let (_, effects) = reduce_amplifier_event(&state, &record("session:end"));
        assert!(effects.is_empty());
    }

    #[test]
    fn session_resume_and_noise_events_never_change_phase() {
        let state = create_reducer_state();
        for event in ["session:resume", "session:start", "execution:start"] {
            let (next, effects) = reduce_amplifier_event(&state, &record(event));
            assert_eq!(next.phase, LifecyclePhase::Idle, "{event}");
            assert!(effects.is_empty(), "{event}");
        }
    }

    #[test]
    fn schema_gate_degrades_once_and_goes_inert() {
        let bad = ParsedRecord::from_json(&json!({
            "schema": { "name": "other.log", "ver": "1.0.0" },
            "event": "prompt:submit"
        }))
        .unwrap();
        let state = create_reducer_state();
        let (state, effects) = reduce_amplifier_event(&state, &bad);
        assert!(state.degraded);
        assert_eq!(
            effects,
            vec![ReducerEffect::LaneDegrade {
                reason: SchemaGateFailure::SchemaNameMismatch
            }]
        );
        // Inert afterwards — even a valid prompt:submit is ignored.
        let (state, effects) = reduce_amplifier_event(&state, &record("prompt:submit"));
        assert!(effects.is_empty());
        assert_eq!(state.phase, LifecyclePhase::Idle);
    }

    #[test]
    fn schema_gate_failure_kinds() {
        let missing = ParsedRecord::from_json(&json!({ "event": "prompt:submit" })).unwrap();
        assert_eq!(
            check_amplifier_record_schema(&missing),
            Some(SchemaGateFailure::SchemaMissing)
        );
        let v2 = ParsedRecord::from_json(&json!({
            "schema": { "name": "amplifier.log", "ver": "2.1.0" },
            "event": "prompt:submit"
        }))
        .unwrap();
        assert_eq!(
            check_amplifier_record_schema(&v2),
            Some(SchemaGateFailure::SchemaVersionUnsupported)
        );
        assert_eq!(check_amplifier_record_schema(&record("x")), None);
    }

    #[test]
    fn subagent_indicators_are_observed_never_effects() {
        let state = create_reducer_state();
        let (state, effects) = reduce_amplifier_event(&state, &record("session:fork"));
        assert!(state.subagent);
        assert!(effects.is_empty());

        let start_with_parent = ParsedRecord::from_json(&json!({
            "schema": { "name": "amplifier.log", "ver": "1.0.0" },
            "event": "session:start",
            "data": { "parent_id": "parent-1" }
        }))
        .unwrap();
        let (state2, effects) = reduce_amplifier_event(&create_reducer_state(), &start_with_parent);
        assert!(state2.subagent);
        assert!(effects.is_empty());
        let _ = state;
    }

    #[test]
    fn session_config_identifies_cwd() {
        let config = ParsedRecord::from_json(&json!({
            "schema": { "name": "amplifier.log", "ver": "1.4.2" },
            "event": "session:config",
            "session_id": "sess-9",
            "data": { "raw": { "working_dir": "/home/u/proj" } }
        }))
        .unwrap();
        let (_, effects) = reduce_amplifier_event(&create_reducer_state(), &config);
        assert_eq!(
            effects,
            vec![ReducerEffect::SessionIdentified {
                session_id: Some("sess-9".into()),
                cwd: "/home/u/proj".into()
            }]
        );
    }

    #[test]
    fn first_session_id_sticks() {
        let state = create_reducer_state();
        let (state, _) = reduce_amplifier_event(&state, &record("session:start"));
        assert_eq!(state.session_id.as_deref(), Some("sess-1"));
        let other = ParsedRecord::from_json(&json!({
            "schema": { "name": "amplifier.log", "ver": "1.0.0" },
            "event": "prompt:submit",
            "session_id": "sess-2"
        }))
        .unwrap();
        let (state, _) = reduce_amplifier_event(&state, &other);
        assert_eq!(state.session_id.as_deref(), Some("sess-1"));
    }
}

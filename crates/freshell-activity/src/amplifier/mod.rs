//! Amplifier terminal-mode activity: the events.jsonl lane.
//!
//! Faithful ports of the frozen legacy trio:
//!
//! * [`reducer`] — `server/coding-cli/amplifier-events-reducer.ts` (pure
//!   `(state, record) -> { state, effects }` lifecycle transition table).
//! * [`tailer`] — `server/coding-cli/amplifier-events-tailer.ts`
//!   (offset-based incremental reader; owns NO watchers — reads are driven
//!   by the caller's inotify events or force-read failsafes).
//! * [`tracker`] — `server/coding-cli/amplifier-activity-tracker.ts` (the
//!   terminal-keyed state machine: PTY Enter is only PROVISIONALLY busy;
//!   `prompt:submit` confirms; `prompt:complete`/`session:end` is the single
//!   turn boundary).

pub mod reducer;
pub mod tailer;
pub mod tracker;

pub use reducer::{
    check_amplifier_record_schema, create_reducer_state, reduce_amplifier_event, ParsedRecord,
    ReducerEffect, ReducerState, SchemaGateFailure,
};
pub use tailer::{AmplifierEventsTailer, TailerDegradeReason, TailerReadOutcome};
pub use tracker::{
    AmplifierActivityTracker, AmplifierEffect, AMPLIFIER_BUSY_DEADMAN_MS, AMPLIFIER_SUBMIT_GRACE_MS,
};

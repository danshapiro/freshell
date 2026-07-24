//! # freshell-activity
//!
//! Terminal-mode coding-CLI activity engine for the freshell Rust port
//! (TERM-15 activity list/updates, TERM-16 server-authoritative
//! `terminal.turn.complete`, plus the NEW `terminal.idle` truly-idle edge).
//!
//! Faithful ports of the frozen legacy modules:
//!
//! | module            | legacy source                                        |
//! |-------------------|------------------------------------------------------|
//! | [`signal`]        | `shared/turn-complete-signal.ts`                     |
//! | [`ledger`]        | `server/coding-cli/turn-completion-ledger.ts`        |
//! | [`claude`]        | `server/coding-cli/claude-activity-tracker.ts`       |
//! | [`codex`]         | `server/coding-cli/codex-activity-tracker.ts` (PTY lane) |
//! | [`amplifier`]     | `server/coding-cli/amplifier-{events-reducer,events-tailer,activity-tracker}.ts` |
//! | [`idle`]          | NEW capability (no legacy counterpart)               |
//!
//! ## Zero-polling design
//!
//! The legacy trackers each run a 5s `setInterval` sweep. This crate does NOT:
//! every tracker is a pure, timer-free state machine that exposes
//! `next_deadline()` — the earliest future instant at which `expire(at)`
//! could change any state. The async hub (`freshell-ws`) arms exactly ONE
//! one-shot timer per provider for that instant and re-arms it only after
//! events or expiries. A provider with no busy/pending terminals reports
//! `None` and carries **zero armed timers and zero wakes**.
pub mod amplifier;
pub mod claude;
pub mod codex;
pub mod idle;
pub mod ledger;
pub mod signal;

/// Effects a tracker interaction can produce, drained by the caller (the
/// async hub) and mapped 1:1 onto wire frames. Mirrors the legacy trackers'
/// `'changed'` / `'turn.complete'` / `'events.force-read'` EventEmitter
/// events, but as return values so the state machines stay synchronous and
/// exhaustively testable.
#[derive(Debug, Clone, PartialEq)]
pub enum TrackerEffect<R> {
    /// `*.activity.updated` — `{ upsert, remove }`.
    Changed { upsert: Vec<R>, remove: Vec<String> },
    /// `terminal.turn.complete` — one per real positive turn end.
    TurnComplete {
        terminal_id: String,
        session_id: Option<String>,
        at: i64,
        completion_seq: i64,
    },
    /// Amplifier only: force-read the events tail (missed-signal failsafe).
    ForceRead { terminal_id: String, at: i64 },
}

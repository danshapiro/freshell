//! codex **completion gating** — the STATUS-GUARDED turn-completion edge, a faithful port
//! of the codex adapter's subscription reducer (`adapters/codex/adapter.ts:876-946`), plus
//! the thread-status normalization (`adapter.ts:246-264`) and the strictly-monotonic
//! turn-complete clock (`server/fresh-agent/turn-complete-clock.ts`).
//!
//! ## The status guard (the crown jewel — `adapter.ts:911-928`)
//!
//! `turn/completed` fires for interrupts and failures too
//! (`CodexTurnStatusSchema = completed|interrupted|failed|inProgress`, `protocol.ts:104`),
//! so the adapter emits the positive `sdk.turn.complete` edge ONLY when
//! `params.turn?.status ?? params.status === 'completed'` (`adapter.ts:922-924`). On EVERY
//! `turn/completed` for the subscribed thread it FIRST emits an idle snapshot so the client
//! re-fetches the committed transcript (`adapter.ts:906-914`); the chime is additional and
//! gated. A crash/disconnect (`onExit`) or `thread_closed` clears the pane to `exited`
//! WITHOUT a chime (`adapter.ts:887-896,935-946`).
//!
//! The completion `at` is per-session strictly-monotonic
//! ([`next_monotonic_turn_complete_at`]) so two turns in the same millisecond — or a
//! backwards NTP step — never collide or regress within the process
//! (`turn-complete-clock.ts:19-21`).

use serde_json::Value;

use crate::protocol::{turn_status, CodexTurnEvent};

/// The normalized thread status a snapshot carries (`normalizeCodexThreadStatus`,
/// `adapter.ts:246-254`): `active→running`, `notLoaded→starting`, `systemError→exited`,
/// `idle→idle`, and any non-object / unknown → `idle`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexStatus {
    Running,
    Starting,
    Idle,
    Exited,
}

impl CodexStatus {
    /// The wire string the reference emits (`sdk.session.snapshot.status` /
    /// `sdk.status.status`).
    pub fn as_str(self) -> &'static str {
        match self {
            CodexStatus::Running => "running",
            CodexStatus::Starting => "starting",
            CodexStatus::Idle => "idle",
            CodexStatus::Exited => "exited",
        }
    }
}

/// `normalizeCodexThreadStatus(status)` (`adapter.ts:246-254`). Accepts the codex thread
/// status object `{ type: 'active'|'idle'|'notLoaded'|'systemError'|… }`; a non-object (incl.
/// the bare string `'idle'` the reference passes at `adapter.ts:914`) or an unknown `type`
/// normalizes to `idle`.
pub fn normalize_codex_thread_status(status: &Value) -> CodexStatus {
    let Some(obj) = status.as_object() else {
        return CodexStatus::Idle;
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("active") => CodexStatus::Running,
        Some("notLoaded") => CodexStatus::Starting,
        Some("systemError") => CodexStatus::Exited,
        Some("idle") => CodexStatus::Idle,
        _ => CodexStatus::Idle,
    }
}

/// `nextMonotonicTurnCompleteAt(lastAt, now)` (`turn-complete-clock.ts:19-21`): clamp `at`
/// to be strictly greater than the session's previous completion, so distinct turns never
/// collide or regress within a process.
pub fn next_monotonic_turn_complete_at(last_at: Option<i64>, now: i64) -> i64 {
    match last_at {
        Some(last) if now <= last => last + 1,
        _ => now,
    }
}

/// The adapter-level events a codex subscription emits downstream (the `sdk.*` provider
/// events, `adapter.ts:876-946`), normalized to the fields the runtime/oracle care about.
#[derive(Clone, Debug, PartialEq)]
pub enum CodexAdapterEvent {
    /// `makeCodexStatusEvent` → `sdk.session.snapshot { status, revision? }`
    /// (`adapter.ts:256-264`). Emitted on lifecycle changes and after every completed turn.
    StatusSnapshot {
        session_id: String,
        status: CodexStatus,
        revision: Option<f64>,
    },
    /// `sdk.turn.complete { at }` — the POSITIVE completion chime, emitted only on a
    /// `completed` status (`adapter.ts:927`). This is the T2 `provider.emits-completion-signal`
    /// edge.
    TurnComplete { session_id: String, at: i64 },
    /// `sdk.status { status: 'exited' }` — a terminal clear with NO chime, emitted on
    /// `thread_closed` (`adapter.ts:891-896`) and `onExit` crash/disconnect
    /// (`adapter.ts:935-946`).
    Status { session_id: String, status: CodexStatus },
}

/// One codex thread subscription's completion/status reducer. Holds the per-thread
/// monotonic clock and active-turn tracking that the reference keeps in
/// `lastTurnCompleteAtByThread` / `activeTurnByThread` (`adapter.ts:794-800`).
#[derive(Clone, Debug)]
pub struct CodexSubscription {
    session_id: String,
    last_turn_complete_at: Option<i64>,
    active_turn_id: Option<String>,
}

impl CodexSubscription {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), last_turn_complete_at: None, active_turn_id: None }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The last positive-completion `at` this session emitted (for assertions / persistence).
    pub fn last_turn_complete_at(&self) -> Option<i64> {
        self.last_turn_complete_at
    }

    /// Record the active provider turn id from a `send`/`turn/started`
    /// (`activeTurnByThread.set`, `adapter.ts:980`).
    pub fn set_active_turn(&mut self, turn_id: impl Into<String>) {
        self.active_turn_id = Some(turn_id.into());
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    /// `onTurnCompleted` handler (`adapter.ts:911-928`) — the STATUS GUARD.
    ///
    /// For a `turn/completed` on THIS thread: clear the active turn, emit an idle snapshot
    /// (always, so the client re-fetches the committed transcript), then emit the positive
    /// `sdk.turn.complete` chime ONLY if `params.turn?.status ?? params.status === 'completed'`.
    /// `interrupted` / `failed` / `inProgress` / absent statuses yield the snapshot but NO
    /// chime. A `turn/completed` for a DIFFERENT thread yields nothing.
    pub fn on_turn_completed(&mut self, event: &CodexTurnEvent, now: i64) -> Vec<CodexAdapterEvent> {
        // adapter.ts:912 — ignore completions for other threads.
        if event.thread_id != self.session_id {
            return Vec::new();
        }
        // adapter.ts:913 — the turn is over.
        self.active_turn_id = None;

        let mut out = Vec::new();
        // adapter.ts:914 — always emit an idle snapshot (parity with freshopencode's post-idle
        // emit) so the client re-fetches the committed transcript.
        out.push(CodexAdapterEvent::StatusSnapshot {
            session_id: self.session_id.clone(),
            status: CodexStatus::Idle,
            revision: None,
        });

        // adapter.ts:922-924 — the status guard. turn.status ?? status; chime only on 'completed'.
        if turn_status(&event.params).as_deref() != Some("completed") {
            return out;
        }

        // adapter.ts:925-927 — monotonic `at`, then the positive chime.
        let at = next_monotonic_turn_complete_at(self.last_turn_complete_at, now);
        self.last_turn_complete_at = Some(at);
        out.push(CodexAdapterEvent::TurnComplete { session_id: self.session_id.clone(), at });
        out
    }

    /// `thread_status_changed` handler (`adapter.ts:898-903`): clear the active turn once the
    /// thread leaves `running`/`starting`, then emit the normalized status snapshot. Other
    /// threads are ignored.
    pub fn on_thread_status_changed(&mut self, thread_id: &str, status: &Value) -> Option<CodexAdapterEvent> {
        if thread_id != self.session_id {
            return None;
        }
        let normalized = normalize_codex_thread_status(status);
        if normalized != CodexStatus::Running && normalized != CodexStatus::Starting {
            self.active_turn_id = None;
        }
        Some(CodexAdapterEvent::StatusSnapshot {
            session_id: self.session_id.clone(),
            status: normalized,
            revision: None,
        })
    }

    /// `thread_started` evidence (`adapter.ts:882-885`): a status snapshot stamped with the
    /// thread's `updatedAt` revision. Other threads are ignored.
    pub fn on_thread_started(&self, thread_id: &str, status: &Value, updated_at: Option<f64>) -> Option<CodexAdapterEvent> {
        if thread_id != self.session_id {
            return None;
        }
        Some(CodexAdapterEvent::StatusSnapshot {
            session_id: self.session_id.clone(),
            status: normalize_codex_thread_status(status),
            revision: updated_at,
        })
    }

    /// `thread_closed` handler (`adapter.ts:887-896`): terminal `exited` status, NO chime.
    /// Other threads are ignored. Callers also release the runtime + clear thread state.
    pub fn on_thread_closed(&mut self, thread_id: &str) -> Option<CodexAdapterEvent> {
        if thread_id != self.session_id {
            return None;
        }
        self.active_turn_id = None;
        Some(CodexAdapterEvent::Status { session_id: self.session_id.clone(), status: CodexStatus::Exited })
    }

    /// `onExit` handler (`adapter.ts:935-946`): a crash/disconnect clears the pane to `exited`
    /// with NO chime (a crash is not a positive completion). The runtime is intentionally left
    /// mapped for lazy restart (`adapter.ts:936-944`).
    pub fn on_exit(&self) -> CodexAdapterEvent {
        CodexAdapterEvent::Status { session_id: self.session_id.clone(), status: CodexStatus::Exited }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn_event(thread_id: &str, params: Value) -> CodexTurnEvent {
        CodexTurnEvent {
            thread_id: thread_id.to_string(),
            turn_id: params.get("turnId").and_then(Value::as_str).map(str::to_string),
            params: params.as_object().cloned().unwrap_or_default(),
        }
    }

    // ── the status guard, one test per CodexTurnStatus ─────────────────────────────────

    #[test]
    fn completed_status_chimes_exactly_once_after_the_idle_snapshot() {
        let mut sub = CodexSubscription::new("thread-1");
        // Inline turn.status = 'completed' (the codex-cli 0.142.x shape, adapter.ts:1123).
        let out = sub.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "completed" } })),
            1000,
        );
        assert_eq!(out.len(), 2, "idle snapshot + one chime: {out:?}");
        assert_eq!(
            out[0],
            CodexAdapterEvent::StatusSnapshot { session_id: "thread-1".into(), status: CodexStatus::Idle, revision: None }
        );
        assert_eq!(out[1], CodexAdapterEvent::TurnComplete { session_id: "thread-1".into(), at: 1000 });
    }

    #[test]
    fn completed_flat_status_also_chimes() {
        // Flat params.status = 'completed' (the app-server client test shape, adapter.ts:1221).
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "turnId": "t", "status": "completed" })),
            5,
        );
        assert!(matches!(out.as_slice(), [CodexAdapterEvent::StatusSnapshot { .. }, CodexAdapterEvent::TurnComplete { .. }]));
    }

    #[test]
    fn interrupted_status_emits_snapshot_but_never_chimes() {
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "interrupted" } })),
            1000,
        );
        assert_eq!(out.len(), 1, "idle snapshot only, no chime");
        assert!(matches!(out[0], CodexAdapterEvent::StatusSnapshot { status: CodexStatus::Idle, .. }));
        assert!(!out.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })));
        assert_eq!(sub.last_turn_complete_at(), None, "no completion recorded");
    }

    #[test]
    fn failed_status_never_chimes() {
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "status": "failed" })),
            1000,
        );
        assert!(!out.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })));
    }

    #[test]
    fn in_progress_status_never_chimes() {
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "status": "inProgress" })),
            1000,
        );
        assert!(!out.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })));
    }

    #[test]
    fn absent_status_never_chimes_but_still_snapshots() {
        // codex-adapter.test.ts:1180 — params:{} still emits the idle snapshot, no chime.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(&turn_event("thread-1", json!({})), 1000);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], CodexAdapterEvent::StatusSnapshot { .. }));
    }

    #[test]
    fn inline_turn_status_wins_over_flat_status() {
        // `turn.status ?? status`: an inline 'interrupted' must suppress a flat 'completed'.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "status": "interrupted" }, "status": "completed" }),
            ),
            1000,
        );
        assert!(!out.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })), "inline interrupted wins");
    }

    #[test]
    fn other_thread_completion_is_ignored() {
        // adapter.ts:912 / codex-adapter.test.ts:1107-1111 — a completed turn on a different
        // thread produces nothing at all.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event("other-thread", json!({ "threadId": "other-thread", "turn": { "status": "completed" } })),
            1000,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn successive_completions_get_strictly_increasing_at_even_in_same_millisecond() {
        // codex-adapter.test.ts:1227 — the monotonic clamp.
        let mut sub = CodexSubscription::new("thread-1");
        let completed = json!({ "threadId": "thread-1", "status": "completed" });
        let a = sub.on_turn_completed(&turn_event("thread-1", completed.clone()), 1000);
        let b = sub.on_turn_completed(&turn_event("thread-1", completed.clone()), 1000); // same ms
        let c = sub.on_turn_completed(&turn_event("thread-1", completed), 999); // clock stepped back
        let at = |v: &[CodexAdapterEvent]| match v.iter().find(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })) {
            Some(CodexAdapterEvent::TurnComplete { at, .. }) => *at,
            _ => panic!("expected a chime"),
        };
        assert_eq!(at(&a), 1000);
        assert_eq!(at(&b), 1001, "same-ms completion is bumped +1");
        assert_eq!(at(&c), 1002, "backwards clock step still strictly increases");
    }

    // ── thread-status normalization ────────────────────────────────────────────────────

    #[test]
    fn thread_status_normalization_matches_reference() {
        assert_eq!(normalize_codex_thread_status(&json!({ "type": "active", "activeFlags": [] })), CodexStatus::Running);
        assert_eq!(normalize_codex_thread_status(&json!({ "type": "notLoaded" })), CodexStatus::Starting);
        assert_eq!(normalize_codex_thread_status(&json!({ "type": "systemError" })), CodexStatus::Exited);
        assert_eq!(normalize_codex_thread_status(&json!({ "type": "idle" })), CodexStatus::Idle);
        // Unknown type / non-object → idle.
        assert_eq!(normalize_codex_thread_status(&json!({ "type": "weird" })), CodexStatus::Idle);
        assert_eq!(normalize_codex_thread_status(&json!("idle")), CodexStatus::Idle);
        assert_eq!(normalize_codex_thread_status(&Value::Null), CodexStatus::Idle);
    }

    #[test]
    fn thread_status_changed_clears_active_turn_when_not_running() {
        let mut sub = CodexSubscription::new("thread-1");
        sub.set_active_turn("turn-1");
        // active → running keeps the active turn.
        sub.on_thread_status_changed("thread-1", &json!({ "type": "active", "activeFlags": [] }));
        assert_eq!(sub.active_turn_id(), Some("turn-1"));
        // idle clears it.
        let ev = sub.on_thread_status_changed("thread-1", &json!({ "type": "idle" })).unwrap();
        assert_eq!(ev, CodexAdapterEvent::StatusSnapshot { session_id: "thread-1".into(), status: CodexStatus::Idle, revision: None });
        assert_eq!(sub.active_turn_id(), None);
        // Other thread ignored.
        assert!(sub.on_thread_status_changed("other", &json!({ "type": "idle" })).is_none());
    }

    #[test]
    fn thread_closed_and_exit_emit_exited_with_no_chime() {
        let mut sub = CodexSubscription::new("thread-1");
        assert_eq!(
            sub.on_thread_closed("thread-1"),
            Some(CodexAdapterEvent::Status { session_id: "thread-1".into(), status: CodexStatus::Exited })
        );
        assert!(sub.on_thread_closed("other").is_none());
        assert_eq!(
            sub.on_exit(),
            CodexAdapterEvent::Status { session_id: "thread-1".into(), status: CodexStatus::Exited }
        );
    }

    #[test]
    fn thread_started_carries_updated_at_revision() {
        let sub = CodexSubscription::new("thread-1");
        let ev = sub.on_thread_started("thread-1", &json!({ "type": "idle" }), Some(7.0)).unwrap();
        assert_eq!(
            ev,
            CodexAdapterEvent::StatusSnapshot { session_id: "thread-1".into(), status: CodexStatus::Idle, revision: Some(7.0) }
        );
    }
}

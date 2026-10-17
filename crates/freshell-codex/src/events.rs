//! codex **completion gating** — the STATUS-GUARDED turn-completion edge, a faithful port
//! of the codex adapter's subscription reducer (`adapters/codex/adapter.ts:876-946`), plus
//! the thread-status normalization (`adapter.ts:246-264`) and the strictly-monotonic
//! turn-complete clock (`server/fresh-agent/turn-complete-clock.ts`).
//!
//! ## The unified status guard (the crown jewel — `adapter.ts:911-928`)
//!
//! `turn/completed` fires for every terminal status
//! (`CodexTurnStatusSchema = completed|interrupted|failed|inProgress`, `protocol.ts:104`).
//! The UNIFIED "needs attention" edge rings for every turn END the user may not have
//! witnessed: `completed`, `failed`, an absent status (the turn ended, outcome
//! unknown), and a NON-user `interrupted` (automation- or rollback-forced — opencode's
//! `turn_aborted` precedent). Only a USER-initiated interrupt — the interrupt control
//! lane arms the per-session `user_interrupt_pending` marker before issuing
//! `turn/interrupt`, and the guard's `interrupted` branch consumes it — and the
//! non-terminal `inProgress` status stay silent. The marker is bounded to the
//! CURRENT turn: the consumer clears it at every new turn's `turn/started`
//! (the full opencode discipline — opencode clears `turn_aborted` at every turn
//! dispatch), so an armed marker whose `interrupted` completion never arrived
//! cannot cross a turn boundary and silence a later non-user `interrupted`; and
//! a SUPERSEDED stale completion the consumer discards never consumes it
//! ([`CodexSubscription::on_superseded_turn_completed`]). On EVERY
//! `turn/completed` for the subscribed thread the guard FIRST emits an idle
//! snapshot so the client re-fetches the committed transcript
//! (`adapter.ts:906-914`); the attention edge is additional and routed. A
//! crash/disconnect (`onExit`) or `thread_closed` clears the pane to `exited`
//! WITHOUT an edge (`adapter.ts:887-896,935-946`).
//!
//! The completion `at` is per-session strictly-monotonic
//! ([`next_monotonic_turn_complete_at`]) so two turns in the same millisecond — or a
//! backwards NTP step — never collide or regress within the process
//! (`turn-complete-clock.ts:19-21`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::protocol::{turn_status, CodexTurnEvent};

/// The normalized thread status a snapshot carries (`normalizeCodexThreadStatus`,
/// `adapter.ts:246-254`): `active→running`, `notLoaded→starting`, `systemError→exited`,
/// `idle→idle`, and any non-object / unknown → `idle`. `Stuck` is never produced by the
/// normalization: it is THIS server's wedged-sidecar quiet-deadman flag (a live sidecar
/// that went silent with a turn in flight), surfaced server-side only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexStatus {
    Running,
    Starting,
    Idle,
    Exited,
    Stuck,
}

impl CodexStatus {
    /// The wire string the reference emits (`sdk.session.snapshot.status` /
    /// `sdk.status.status`). `Stuck` → `"stuck"`, matching the Node lane's
    /// `freshAgent.status {status:'stuck'}` wire shape byte-for-byte.
    pub fn as_str(self) -> &'static str {
        match self {
            CodexStatus::Running => "running",
            CodexStatus::Starting => "starting",
            CodexStatus::Idle => "idle",
            CodexStatus::Exited => "exited",
            CodexStatus::Stuck => "stuck",
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

/// Normalized provider result carried beside the turn-ended attention edge.
/// The edge fires for failed and unknown turns too, so consumers that need to
/// prove a successful response must inspect this value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexTurnOutcome {
    Completed,
    Failed,
    Interrupted,
    Unknown,
}

impl CodexTurnOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Unknown => "unknown",
        }
    }

    fn from_status(status: Option<&str>) -> Self {
        match status {
            Some("completed") => Self::Completed,
            Some("failed") => Self::Failed,
            Some("interrupted") => Self::Interrupted,
            _ => Self::Unknown,
        }
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
    /// `sdk.turn.complete { at, outcome }` — the UNIFIED "needs attention" edge, emitted for
    /// every turn END except a USER-initiated interrupt (the marker-armed
    /// `interrupted` the interrupt lane owns) and the non-terminal `inProgress`.
    /// The outcome is kept separate because this attention edge also fires for
    /// failed and unknown turn results.
    TurnComplete {
        session_id: String,
        at: i64,
        outcome: CodexTurnOutcome,
    },
    /// `sdk.status { status: 'exited' }` — a terminal clear with NO chime, emitted on
    /// `thread_closed` (`adapter.ts:891-896`) and `onExit` crash/disconnect
    /// (`adapter.ts:935-946`).
    Status {
        session_id: String,
        status: CodexStatus,
    },
}

/// One codex thread subscription's completion/status reducer. Holds the per-thread
/// monotonic clock and active-turn tracking that the reference keeps in
/// `lastTurnCompleteAtByThread` / `activeTurnByThread` (`adapter.ts:794-800`), plus
/// the per-session user-interrupt marker the interrupt control lane arms.
///
/// The monotonic clock lives behind ONE shared `Arc<Mutex<Option<i64>>>` per
/// session: the freshagent lane threads the session's clock into this
/// subscription (ordinary consumer edges) AND into the synthesized-edge
/// minters outside the consumer (the crash self-heal, the wedged-sidecar quiet
/// deadman), so ordinary and synthesized `at`s share a single
/// strictly-monotonic timeline and can never collide or regress.
#[derive(Clone, Debug)]
pub struct CodexSubscription {
    session_id: String,
    last_turn_complete_at: Arc<Mutex<Option<i64>>>,
    active_turn_id: Option<String>,
    /// The per-session USER-interrupt marker (opencode's `turn_aborted`
    /// precedent): the interrupt control lane arms it BEFORE issuing
    /// `turn/interrupt`, and [`Self::on_turn_completed`]'s `interrupted` branch
    /// consumes it (load + clear). Only a USER-initiated interrupt is silent —
    /// a non-user `interrupted` (automation/rollback-forced) is a turn end the
    /// user didn't witness and rings. Shared by `Arc` so the session record the
    /// interrupt lane reads and the reducer the consumer drives stay one flag.
    /// Bounded to the current turn: the consumer clears it at every new
    /// turn's `turn/started` ([`Self::clear_user_interrupt`]), and a
    /// superseded stale completion never consumes it
    /// ([`Self::on_superseded_turn_completed`]).
    user_interrupt_pending: Arc<AtomicBool>,
}

impl CodexSubscription {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            last_turn_complete_at: Arc::new(Mutex::new(None)),
            active_turn_id: None,
            user_interrupt_pending: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Adopt the session's shared monotonic turn-complete clock. The freshagent
    /// lane threads ONE clock per session into both the consumer's subscription
    /// (ordinary completion edges) and the crash/deadman synthesized-edge
    /// minters; constructing the subscription with this builder keeps them on
    /// the same strictly-monotonic `at` timeline instead of fresh defaults.
    pub fn with_last_turn_complete_at(mut self, clock: Arc<Mutex<Option<i64>>>) -> Self {
        self.last_turn_complete_at = clock;
        self
    }

    /// Adopt the session's shared user-interrupt marker. The freshagent lane
    /// threads ONE flag per session into both the interrupt control lane (which
    /// arms it) and the notification consumer's subscription (which consumes
    /// it); constructing the subscription with this builder keeps them the same
    /// flag instead of the fresh default.
    pub fn with_user_interrupt_pending(mut self, pending: Arc<AtomicBool>) -> Self {
        self.user_interrupt_pending = pending;
        self
    }

    /// Arm the user-interrupt marker: the next `interrupted` completion is
    /// USER-initiated and stays silent (the guard consumes the marker on it).
    /// The subscription-level arm handle the interrupt control lane (and the
    /// low-level RPC-seam tests) use.
    pub fn arm_user_interrupt(&self) {
        self.user_interrupt_pending.store(true, Ordering::SeqCst);
    }

    /// Clear the user-interrupt marker WITHOUT consuming it: a NEW turn
    /// started on this thread, so a marker armed for a PREVIOUS turn's
    /// interrupt is stale. The full opencode `turn_aborted` discipline
    /// (opencode clears its marker at every turn dispatch) bounds the
    /// marker to the current turn: an interrupt whose completion never
    /// arrived as `interrupted` (e.g. the app-server completed the turn
    /// as `completed`) can never cross the turn boundary and silence a
    /// later NON-user `interrupted` (a missed bell). The consumer calls
    /// this from its `turn/started` handling.
    pub fn clear_user_interrupt(&self) {
        self.user_interrupt_pending.store(false, Ordering::SeqCst);
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The last turn-complete `at` this session emitted (for assertions / persistence).
    pub fn last_turn_complete_at(&self) -> Option<i64> {
        *self
            .last_turn_complete_at
            .lock()
            .expect("last_turn_complete_at mutex")
    }

    /// Record the active provider turn id from a `send`/`turn/started`
    /// (`activeTurnByThread.set`, `adapter.ts:980`).
    pub fn set_active_turn(&mut self, turn_id: impl Into<String>) {
        self.active_turn_id = Some(turn_id.into());
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn_id.as_deref()
    }

    /// `onTurnCompleted` handler (`adapter.ts:911-928`) — the UNIFIED STATUS GUARD.
    ///
    /// For a `turn/completed` on THIS thread: clear the active turn, emit an idle snapshot
    /// (always, so the client re-fetches the committed transcript), then emit the unified
    /// `sdk.turn.complete` attention edge for every turn END the user may not have
    /// witnessed: `completed`, `failed`, an absent status, and a NON-user `interrupted`
    /// (automation/rollback-forced). Only a USER-initiated interrupt — the interrupt
    /// control lane armed the `user_interrupt_pending` marker, CONSUMED here — and the
    /// non-terminal `inProgress` stay snapshot-only. A `turn/completed` for a DIFFERENT
    /// thread yields nothing.
    pub fn on_turn_completed(
        &mut self,
        event: &CodexTurnEvent,
        now: i64,
    ) -> Vec<CodexAdapterEvent> {
        self.turn_completed(event, now, true)
    }

    /// The bookkeeping-only variant for SUPERSEDED stale completions: the
    /// consumer's superseded branch (freshell-freshagent's
    /// `reduce_notification`) keeps this subscription's per-session
    /// bookkeeping (active-turn clear, snapshot, monotonic clock) but
    /// DISCARDS the output, replacing it with a busy `running` snapshot.
    /// Because the output is discarded, a stale `interrupted` here must NOT
    /// consume the user-interrupt marker: it can only be racing a marker
    /// armed for a NEWER turn's user interrupt, and consuming it would make
    /// that interrupt's own completion ring (a false-positive bell for a
    /// USER-initiated interrupt). Identical guard decisions — the marker is
    /// PEEKED, never taken.
    pub fn on_superseded_turn_completed(
        &mut self,
        event: &CodexTurnEvent,
        now: i64,
    ) -> Vec<CodexAdapterEvent> {
        self.turn_completed(event, now, false)
    }

    /// Read the user-interrupt marker for the `interrupted` guard: SWAP it
    /// (load + clear) on the live consuming path, PEEK on the
    /// bookkeeping-only superseded path — a stale `interrupted` for an
    /// already-superseded turn must leave a marker armed for a NEWER turn's
    /// interrupt intact.
    fn user_interrupt_armed(&self, consume: bool) -> bool {
        if consume {
            self.user_interrupt_pending.swap(false, Ordering::SeqCst)
        } else {
            self.user_interrupt_pending.load(Ordering::SeqCst)
        }
    }

    /// The shared guard core; see the two public variants' docs.
    fn turn_completed(
        &mut self,
        event: &CodexTurnEvent,
        now: i64,
        consume_interrupt_marker: bool,
    ) -> Vec<CodexAdapterEvent> {
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

        // Unified "needs attention": every turn/completed that ENDED the turn rings
        // except a USER-initiated interrupt (the interrupt lane arms the
        // user_interrupt_pending marker; consume it here) and the non-terminal
        // `inProgress` status. `completed`, `failed`, an absent status (the turn
        // ended, outcome unknown), and a NON-user `interrupted` (automation- or
        // rollback-forced) all ring identically — the user didn't witness any of
        // them.
        let status = turn_status(&event.params);
        match status.as_deref() {
            Some("inProgress") => return out,
            // Consume the marker (load + clear) on the live path: only a
            // USER-initiated interrupt is silent — a non-user `interrupted`
            // falls through and rings below. The bookkeeping-only
            // (superseded) path PEEKS instead: its stale `interrupted` can
            // only be racing a marker armed for a NEWER turn's interrupt.
            Some("interrupted") if self.user_interrupt_armed(consume_interrupt_marker) => {
                return out;
            }
            _ => {}
        }

        // adapter.ts:925-927 — monotonic `at`, then the unified attention edge. The clock
        // is the session's SHARED mutex-guarded clock (see the struct doc): a
        // synthesized edge minted outside this consumer (crash self-heal, quiet
        // deadman) takes the same lock and can never collide with or regress
        // below this `at`.
        let at = {
            let mut guard = self
                .last_turn_complete_at
                .lock()
                .expect("last_turn_complete_at mutex");
            let at = next_monotonic_turn_complete_at(*guard, now);
            *guard = Some(at);
            at
        };
        out.push(CodexAdapterEvent::TurnComplete {
            session_id: self.session_id.clone(),
            at,
            outcome: CodexTurnOutcome::from_status(status.as_deref()),
        });
        out
    }

    /// `thread_status_changed` handler (`adapter.ts:898-903`): clear the active turn once the
    /// thread leaves `running`/`starting`, then emit the normalized status snapshot. Other
    /// threads are ignored.
    pub fn on_thread_status_changed(
        &mut self,
        thread_id: &str,
        status: &Value,
    ) -> Option<CodexAdapterEvent> {
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
    pub fn on_thread_started(
        &self,
        thread_id: &str,
        status: &Value,
        updated_at: Option<f64>,
    ) -> Option<CodexAdapterEvent> {
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
        Some(CodexAdapterEvent::Status {
            session_id: self.session_id.clone(),
            status: CodexStatus::Exited,
        })
    }

    /// `onExit` handler (`adapter.ts:935-946`): a crash/disconnect clears the pane to `exited`
    /// with NO edge of its own (the freshell-freshagent exit watcher rings the unified
    /// crash-while-busy attention edge when a turn was in flight). The runtime is intentionally
    /// left mapped for lazy restart (`adapter.ts:936-944`).
    pub fn on_exit(&self) -> CodexAdapterEvent {
        CodexAdapterEvent::Status {
            session_id: self.session_id.clone(),
            status: CodexStatus::Exited,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn_event(thread_id: &str, params: Value) -> CodexTurnEvent {
        CodexTurnEvent {
            thread_id: thread_id.to_string(),
            turn_id: params
                .get("turnId")
                .and_then(Value::as_str)
                .map(str::to_string),
            params: params.as_object().cloned().unwrap_or_default(),
        }
    }

    // ── the status guard, one test per CodexTurnStatus ─────────────────────────────────

    #[test]
    fn completed_status_chimes_exactly_once_after_the_idle_snapshot() {
        let mut sub = CodexSubscription::new("thread-1");
        // Inline turn.status = 'completed' (the codex-cli 0.142.x shape, adapter.ts:1123).
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "completed" } }),
            ),
            1000,
        );
        assert_eq!(out.len(), 2, "idle snapshot + one chime: {out:?}");
        assert_eq!(
            out[0],
            CodexAdapterEvent::StatusSnapshot {
                session_id: "thread-1".into(),
                status: CodexStatus::Idle,
                revision: None
            }
        );
        assert_eq!(
            out[1],
            CodexAdapterEvent::TurnComplete {
                session_id: "thread-1".into(),
                at: 1000,
                outcome: CodexTurnOutcome::Completed,
            }
        );
    }

    #[test]
    fn completed_flat_status_also_chimes() {
        // Flat params.status = 'completed' (the app-server client test shape, adapter.ts:1221).
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turnId": "t", "status": "completed" }),
            ),
            5,
        );
        assert!(matches!(
            out.as_slice(),
            [
                CodexAdapterEvent::StatusSnapshot { .. },
                CodexAdapterEvent::TurnComplete { .. }
            ]
        ));
    }

    #[test]
    fn interrupted_status_with_a_user_interrupt_marker_emits_snapshot_only() {
        // The interrupt control lane arms the user-interrupt marker BEFORE
        // issuing `turn/interrupt`; the guard consumes it here.
        let mut sub = CodexSubscription::new("thread-1");
        sub.arm_user_interrupt();
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "interrupted" } }),
            ),
            1000,
        );
        assert_eq!(out.len(), 1, "idle snapshot only, no unified edge");
        assert!(matches!(
            out[0],
            CodexAdapterEvent::StatusSnapshot {
                status: CodexStatus::Idle,
                ..
            }
        ));
        assert!(!out
            .iter()
            .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })));
        assert_eq!(sub.last_turn_complete_at(), None, "no completion recorded");
        // The marker is CONSUMED by the matching interrupted completion: a
        // second `interrupted` without a fresh user interrupt rings.
        let second = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t2", "status": "interrupted" } }),
            ),
            1001,
        );
        assert!(
            second
                .iter()
                .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })),
            "the user-interrupt marker is one-shot: a later non-user interrupted rings"
        );
    }

    #[test]
    fn interrupted_status_without_a_marker_emits_the_unified_edge() {
        // A NON-user `interrupted` (automation/rollback-forced) is a turn end
        // the user didn't witness — it rings identically to a completion.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t", "status": "interrupted" } }),
            ),
            1000,
        );
        assert_eq!(out.len(), 2, "idle snapshot + the unified edge: {out:?}");
        assert!(matches!(
            out[0],
            CodexAdapterEvent::StatusSnapshot {
                status: CodexStatus::Idle,
                ..
            }
        ));
        assert!(matches!(
            out[1],
            CodexAdapterEvent::TurnComplete { at: 1000, .. }
        ));
        assert_eq!(
            sub.last_turn_complete_at(),
            Some(1000),
            "a non-user interrupted records the completion"
        );
    }

    #[test]
    fn clear_user_interrupt_bounds_the_marker_to_the_current_turn() {
        // The full opencode `turn_aborted` discipline: a NEW turn's start
        // clears any stale armed marker, so an interrupt whose completion
        // never arrived as `interrupted` can never cross the turn boundary
        // and silence a later NON-user `interrupted` (a missed bell).
        let mut sub = CodexSubscription::new("thread-1");
        sub.arm_user_interrupt();
        sub.clear_user_interrupt();
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t2", "status": "interrupted" } }),
            ),
            1000,
        );
        assert_eq!(
            out.len(),
            2,
            "the stale marker must not survive the new turn's start: {out:?}"
        );
        assert!(matches!(
            out[1],
            CodexAdapterEvent::TurnComplete { at: 1000, .. }
        ));
    }

    #[test]
    fn a_superseded_interrupted_completion_leaves_the_armed_marker_for_a_newer_turn() {
        // The bookkeeping-only variant the consumer's superseded branch
        // calls: the guard PEEKS the marker instead of consuming it — a
        // stale `interrupted` for a superseded turn must not take the marker
        // armed for a NEWER turn's user interrupt.
        let mut sub = CodexSubscription::new("thread-1");
        sub.arm_user_interrupt();
        let out = sub.on_superseded_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t1", "status": "interrupted" } }),
            ),
            1000,
        );
        assert_eq!(
            out.len(),
            1,
            "the armed marker still suppresses the discarded output's edge: {out:?}"
        );
        assert!(
            sub.user_interrupt_pending.load(Ordering::SeqCst),
            "the marker stays armed for the newer turn's interrupt"
        );
        // The surviving marker then silences the turn it was armed for: the
        // newer turn's own user-interrupt completion consumes it.
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t2", "status": "interrupted" } }),
            ),
            1001,
        );
        assert_eq!(
            out.len(),
            1,
            "the newer turn's user interrupt stays silent on the surviving marker: {out:?}"
        );
        assert!(
            !sub.user_interrupt_pending.load(Ordering::SeqCst),
            "the live consuming path still consumes the marker one-shot"
        );
        // Without a marker, the superseded bookkeeping call makes the same
        // decision the live guard would: a NON-user `interrupted` rings (the
        // consumer discards this output; only the marker treatment differs).
        let out = sub.on_superseded_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t3", "status": "interrupted" } }),
            ),
            1002,
        );
        assert_eq!(
            out.len(),
            2,
            "the bookkeeping-only variant is not an all-silent path: {out:?}"
        );
    }

    #[test]
    fn failed_status_emits_the_unified_edge() {
        // A failed turn ENDED — the user didn't witness it — one identical edge.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "status": "failed" }),
            ),
            1000,
        );
        assert!(matches!(
            out.as_slice(),
            [
                CodexAdapterEvent::StatusSnapshot { .. },
                CodexAdapterEvent::TurnComplete { at: 1000, .. }
            ]
        ));
        assert!(matches!(
            out[1],
            CodexAdapterEvent::TurnComplete {
                outcome: CodexTurnOutcome::Failed,
                ..
            }
        ));
    }

    #[test]
    fn in_progress_status_never_chimes() {
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "status": "inProgress" }),
            ),
            1000,
        );
        assert!(!out
            .iter()
            .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })));
    }

    #[test]
    fn absent_status_emits_the_unified_edge_and_still_snapshots() {
        // codex-adapter.test.ts:1180 — params:{} still emits the idle snapshot;
        // an absent status means the turn ENDED with the outcome unknown → the
        // unified edge rings too.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(&turn_event("thread-1", json!({})), 1000);
        assert_eq!(out.len(), 2);
        assert!(matches!(out[0], CodexAdapterEvent::StatusSnapshot { .. }));
        assert!(matches!(out[1], CodexAdapterEvent::TurnComplete { .. }));
        assert!(matches!(
            out[1],
            CodexAdapterEvent::TurnComplete {
                outcome: CodexTurnOutcome::Unknown,
                ..
            }
        ));
    }

    #[test]
    fn inline_turn_status_wins_over_flat_status() {
        // `turn.status ?? status`: an inline 'interrupted' must suppress a flat 'completed'.
        // The user-interrupt marker is armed so the inline 'interrupted' is the
        // USER-initiated kind (silent under the unified guard); if the FLAT
        // 'completed' won instead, the edge would ring even with the marker armed.
        let mut sub = CodexSubscription::new("thread-1");
        sub.arm_user_interrupt();
        let out = sub.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "status": "interrupted" }, "status": "completed" }),
            ),
            1000,
        );
        assert!(
            !out.iter()
                .any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })),
            "inline interrupted wins"
        );
    }

    #[test]
    fn other_thread_completion_is_ignored() {
        // adapter.ts:912 / codex-adapter.test.ts:1107-1111 — a completed turn on a different
        // thread produces nothing at all.
        let mut sub = CodexSubscription::new("thread-1");
        let out = sub.on_turn_completed(
            &turn_event(
                "other-thread",
                json!({ "threadId": "other-thread", "turn": { "status": "completed" } }),
            ),
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
        let at = |v: &[CodexAdapterEvent]| match v
            .iter()
            .find(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. }))
        {
            Some(CodexAdapterEvent::TurnComplete { at, .. }) => *at,
            _ => panic!("expected a chime"),
        };
        assert_eq!(at(&a), 1000);
        assert_eq!(at(&b), 1001, "same-ms completion is bumped +1");
        assert_eq!(
            at(&c),
            1002,
            "backwards clock step still strictly increases"
        );
    }

    // ── thread-status normalization ────────────────────────────────────────────────────

    #[test]
    fn thread_status_normalization_matches_reference() {
        assert_eq!(
            normalize_codex_thread_status(&json!({ "type": "active", "activeFlags": [] })),
            CodexStatus::Running
        );
        assert_eq!(
            normalize_codex_thread_status(&json!({ "type": "notLoaded" })),
            CodexStatus::Starting
        );
        assert_eq!(
            normalize_codex_thread_status(&json!({ "type": "systemError" })),
            CodexStatus::Exited
        );
        assert_eq!(
            normalize_codex_thread_status(&json!({ "type": "idle" })),
            CodexStatus::Idle
        );
        // Unknown type / non-object → idle.
        assert_eq!(
            normalize_codex_thread_status(&json!({ "type": "weird" })),
            CodexStatus::Idle
        );
        assert_eq!(
            normalize_codex_thread_status(&json!("idle")),
            CodexStatus::Idle
        );
        assert_eq!(
            normalize_codex_thread_status(&Value::Null),
            CodexStatus::Idle
        );
    }

    #[test]
    fn thread_status_changed_clears_active_turn_when_not_running() {
        let mut sub = CodexSubscription::new("thread-1");
        sub.set_active_turn("turn-1");
        // active → running keeps the active turn.
        sub.on_thread_status_changed("thread-1", &json!({ "type": "active", "activeFlags": [] }));
        assert_eq!(sub.active_turn_id(), Some("turn-1"));
        // idle clears it.
        let ev = sub
            .on_thread_status_changed("thread-1", &json!({ "type": "idle" }))
            .unwrap();
        assert_eq!(
            ev,
            CodexAdapterEvent::StatusSnapshot {
                session_id: "thread-1".into(),
                status: CodexStatus::Idle,
                revision: None
            }
        );
        assert_eq!(sub.active_turn_id(), None);
        // Other thread ignored.
        assert!(sub
            .on_thread_status_changed("other", &json!({ "type": "idle" }))
            .is_none());
    }

    #[test]
    fn thread_closed_and_exit_emit_exited_with_no_chime() {
        let mut sub = CodexSubscription::new("thread-1");
        assert_eq!(
            sub.on_thread_closed("thread-1"),
            Some(CodexAdapterEvent::Status {
                session_id: "thread-1".into(),
                status: CodexStatus::Exited
            })
        );
        assert!(sub.on_thread_closed("other").is_none());
        assert_eq!(
            sub.on_exit(),
            CodexAdapterEvent::Status {
                session_id: "thread-1".into(),
                status: CodexStatus::Exited
            }
        );
    }

    #[test]
    fn thread_started_carries_updated_at_revision() {
        let sub = CodexSubscription::new("thread-1");
        let ev = sub
            .on_thread_started("thread-1", &json!({ "type": "idle" }), Some(7.0))
            .unwrap();
        assert_eq!(
            ev,
            CodexAdapterEvent::StatusSnapshot {
                session_id: "thread-1".into(),
                status: CodexStatus::Idle,
                revision: Some(7.0)
            }
        );
    }
}

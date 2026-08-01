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
//! 1. **Tracking starts at terminal create, not session bind**, and the
//!    JSONL-reconcile lane is ported NARROWED (G9): per-bound-terminal
//!    rollout tailing (`freshell-ws/src/codex_reconcile.rs` + the hub's
//!    codex lanes) instead of the legacy whole-library `reconcileProjects`
//!    scan; tail-trusting bounded reads (256KB initial) instead of the
//!    head+tail snippet sanitizer; and NO latent/association distrust
//!    (`latentAcceptedStartAt` unported) because every Rust binding is
//!    proof-carrying -- resume argv or disk-truth candidate adoption
//!    (`verify_rollout_path`). `bind_session` is the lane's binder;
//!    `reconcile_rollout` is its state machine; `busy`/`unknown`, the
//!    busy-deadman, and `accepted_start_at` are live. A THIRD lane (S5.a,
//!    managed-launch proxy) feeds `note_proxy_turn_started` /
//!    `note_proxy_turn_completed` from the codex app-server event stream
//!    on server-clock receipt time. Cross-lane completion dedupe
//!    generalizes the original one-shot BEL-echo swallow (CE1) into
//!    directed one-shot swallow flags between the three clock domains
//!    (`swallow_next_bel`, `swallow_next_proxy_complete`,
//!    `swallow_next_reconcile_clear`): whichever lane ends the physical
//!    turn first arms the swallows for the other lanes' late echoes (the
//!    key spaces are disjoint clock domains, so the turn-key alone cannot
//!    dedupe them); a fresh pending submit disarms all three.
//! 2. **Zero-polling**: `next_deadline()` + one-shot hub timer instead of the
//!    5s sweep (`ACTIVITY_SWEEP_MS`), same as [`crate::claude`].
//! 3. **The busy-deadman self-heals instead of demoting** (kata namg): a
//!    busy terminal silent past [`BUSY_DEADMAN_MS`] emits
//!    `TrackerEffect::ForceRead` (the hub drains it via `drain_codex_lane`)
//!    and STAYS busy, repeating every window -- it no longer flips
//!    Busy->Unknown on a timer. This is the amplifier lane's G4
//!    missed-signal floor (see `amplifier/tracker.rs`) -- with one
//!    divergence: resumed output DISARMS a fired force-read anchor (the
//!    `note_output` liveness reset), because an armed stale anchor pins
//!    `next_deadline()` at a past instant and hot-loops the hub (latent in
//!    the template; see the plan's D2 residual note). Ported because the
//!    rollout lane is a single unbroken inotify->mpsc->drain chain with zero
//!    redundant delivery: one missed fs event used to silence
//!    terminal.turn.complete forever. The retired demotion's ONE behavioral
//!    consumer -- a user submit into a wedged pane -- is preserved by the
//!    submit-time staleness escape in `note_input` (silence past the window
//!    at submit time takes the fresh-pending path, same threshold as the
//!    old demotion). The tailer's fail-quiet IO errors are
//!    retried on the same cadence; a LaneRetry-equivalent loud-degrade path
//!    (TailerReadOutcome parity) is deliberately DEFERRED -- see
//!    docs/plans/2026-07-29-codex-lane-self-healing.md (D2).

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

/// Latest codex rollout task-event timestamps (epoch ms), folded from
/// `event_msg` records: `task_started` / `task_complete` / `turn_aborted`.
/// Mirror of `freshell_sessions::CodexTaskEventSnapshot`, duplicated here so
/// this crate stays dependency-free (kernel-thin tracker).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexTaskEvents {
    pub latest_task_started_at: Option<i64>,
    pub latest_task_completed_at: Option<i64>,
    pub latest_turn_aborted_at: Option<i64>,
    /// Reason string paired with `latest_turn_aborted_at` (e.g. "interrupted").
    /// None on legacy rollout lines that carry no reason.
    pub latest_turn_aborted_reason: Option<String>,
}

impl CodexTaskEvents {
    pub fn is_empty(&self) -> bool {
        self.latest_task_started_at.is_none()
            && self.latest_task_completed_at.is_none()
            && self.latest_turn_aborted_at.is_none()
    }
}

fn max_ts(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, None) => a,
        (None, b) => b,
    }
}

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
    /// Rollout-reconcile lane: newest `task_started` timestamp ever seen for
    /// this terminal's session (promotion is edge-triggered on a NEWER start).
    last_seen_task_started_at: Option<i64>,
    /// Rollout-reconcile lane: newest clear (`task_complete`/`turn_aborted`)
    /// ever seen; a start is only unresolved if newer than this.
    last_cleared_at: Option<i64>,
    /// One-shot: a reconcile-initiated turn clear arms this so the PTY BEL
    /// echo of the SAME physical turn end is swallowed instead of completing
    /// a re-armed queued turn prematurely (validation counterexample CE1 --
    /// the PTY and reconcile key spaces are disjoint clock domains, so
    /// `last_emitted_turn_key` alone cannot dedupe across lanes).
    swallow_next_bel: bool,
    /// S5.a third lane (proxy): one-shot -- another lane already ended this
    /// physical turn; swallow its late proxy echo. Armed by BOTH
    /// reconcile-initiated AND BEL-initiated clears (ledger A11).
    swallow_next_proxy_complete: bool,
    /// S5.a third lane: one-shot -- a proxy-initiated clear already ended this
    /// physical turn; swallow the rollout reconcile echo of the same turn.
    swallow_next_reconcile_clear: bool,
    /// S5.a third lane: server-clock receipt time of the newest proxy
    /// TurnStarted -- the proxy lane's turn key for Busy/Unknown clears.
    last_proxy_started_at: Option<i64>,
    /// Proxy lane (kata codex-turn-thread-scope): the turn id of the bound
    /// thread's in-flight proxy turn, set on TurnStarted, cleared on rebind
    /// AND at every accepted terminal-status completion. A TurnCompleted
    /// carrying a DIFFERENT turn id is a stale echo of an already-closed
    /// turn and is a no-op by construction. `None` falls back to phase
    /// semantics (older protocols omit turnId).
    current_proxy_turn_id: Option<String>,
    /// Outstanding server→client approval request ids (managed proxy lane).
    pending_approvals: std::collections::HashSet<String>,
    /// True when the approval pause demoted a working phase; the resolve
    /// restores Busy. False when the approval arrived while already idle.
    resume_busy_after_approval: bool,
    last_observed_at: i64,
    last_emitted_turn_key: Option<i64>,
    parser_state: ParserState,
    /// Deadman self-heal (kata namg; mirror of amplifier/tracker.rs:51-52):
    /// warn-once latch for the stuck-busy force-read log line.
    force_read_logged: bool,
    /// Deadman re-arm anchor: the busy force-read repeats every
    /// `busy_deadman_ms` while the silence persists.
    next_force_read_at: Option<i64>,
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

#[derive(Debug)]
pub struct CodexActivityTracker {
    states: HashMap<String, TerminalActivity>,
    ledger: TurnCompletionLedger,
    /// Busy-deadman window; [`BUSY_DEADMAN_MS`] in production. Overridable
    /// (test-scale hook) because there is no clock abstraction -- `expire`
    /// takes wall-clock ms and the hub uses `now_ms()`. Drives ONLY the
    /// busy-deadman + its `next_deadline` arm; the pending-liveness window
    /// stays on the constant.
    busy_deadman_ms: i64,
}

impl Default for CodexActivityTracker {
    fn default() -> Self {
        Self {
            states: HashMap::new(),
            ledger: TurnCompletionLedger::default(),
            busy_deadman_ms: BUSY_DEADMAN_MS,
        }
    }
}

impl CodexActivityTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-scale hook: override the busy-deadman window (production
    /// default [`BUSY_DEADMAN_MS`]). Hub-level tests shrink it so the
    /// missed-event self-heal (kata namg) runs in test time.
    pub fn set_busy_deadman_ms(&mut self, ms: i64) {
        self.busy_deadman_ms = ms;
    }

    pub fn list(&self) -> Vec<CodexActivityRecord> {
        self.states.values().map(|s| s.to_record()).collect()
    }

    pub fn list_latest_completions(&self) -> Vec<freshell_protocol::TurnCompletionSnapshot> {
        self.ledger.list_latest_completions()
    }

    #[cfg(test)]
    fn current_proxy_turn_id_for(&self, terminal_id: &str) -> Option<String> {
        self.states
            .get(terminal_id)
            .and_then(|s| s.current_proxy_turn_id.clone())
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
                    // Design decision #7 (kata codex-turn-thread-scope): a
                    // rebind moves the pane to a DIFFERENT thread -- the old
                    // thread's in-flight turn id and start anchor must not
                    // survive (see bind_session).
                    existing.current_proxy_turn_id = None;
                    existing.last_proxy_started_at = None;
                    // Task 7: nor may the old thread's approval pause state.
                    existing.pending_approvals.clear();
                    existing.resume_busy_after_approval = false;
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
            last_seen_task_started_at: None,
            last_cleared_at: None,
            swallow_next_bel: false,
            swallow_next_proxy_complete: false,
            swallow_next_reconcile_clear: false,
            last_proxy_started_at: None,
            current_proxy_turn_id: None,
            pending_approvals: std::collections::HashSet::new(),
            resume_busy_after_approval: false,
            last_observed_at: at,
            last_emitted_turn_key: None,
            parser_state: ParserState::new(),
            force_read_logged: false,
            next_force_read_at: None,
        };
        let next = state.to_record();
        self.states.insert(terminal_id.to_string(), state);
        changed(None, next)
    }

    /// Bind (or re-bind) the session identity of an already-tracked terminal.
    /// The binder anticipated by deviation 1: the candidate-adopt path and the
    /// rollout-reconcile lane both announce identity through here. Same
    /// idempotent shape as `track_terminal`'s rebind branch and
    /// `AmplifierActivityTracker::bind_session`: untracked terminal -> silent
    /// no-op (never resurrects state for an exited terminal); same id ->
    /// no-op (the client re-announces on every durability update).
    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() == Some(session_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.session_id = Some(session_id.to_string());
        // Design decision #7 (kata codex-turn-thread-scope): a rebind moves
        // the pane to a DIFFERENT thread (fork/resume, delivered by the async
        // disk fork-watch lane -- codex_proxy_route.rs:88-91). The old
        // thread's in-flight turn id and start anchor must not survive, or
        // the new thread's first turn/completed is misclassified as a stale
        // echo / collides on last_emitted_turn_key.
        state.current_proxy_turn_id = None;
        state.last_proxy_started_at = None;
        // Task 7: nor may the old thread's approval pause state.
        state.pending_approvals.clear();
        state.resume_busy_after_approval = false;
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// Rollout-reconcile lane (`reconcileProjects`, narrowed to one bound
    /// terminal): fold the rollout's latest task events into the state
    /// machine. Promotion rule (all Rust bindings are proof-carrying, so
    /// every binding is trusted -- see module deviations): a NEW
    /// `task_started`, newer than every known clear and newer than the
    /// accepted anchor, promotes to `busy`. Clear rule: a NEW clear at/after
    /// the turn anchor ends the turn (pending anchor first, then accepted),
    /// recording exactly one completion via the shared dedupe.
    pub fn reconcile_rollout(
        &mut self,
        terminal_id: &str,
        events: &CodexTaskEvents,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();

        let observed_clear = max_ts(
            events.latest_task_completed_at,
            events.latest_turn_aborted_at,
        );
        // The newest terminating event decides the clear's shape: an abort
        // (Esc-interrupt / `turn_aborted`) still ends the turn, but only a
        // HUMAN-attributed abort (reason `interrupted`/`replaced`, or a
        // reason-less legacy line) stays silent -- the human is present.
        // Any OTHER present reason is codex stopping on its own, which DOES
        // record (rings terminal.idle). Ties go to task_complete: a real
        // completion at the same instant still rings.
        let clear_is_abort = match (
            events.latest_task_completed_at,
            events.latest_turn_aborted_at,
        ) {
            (Some(completed), Some(aborted)) => aborted > completed,
            (None, Some(_)) => true,
            _ => false,
        };
        let record =
            !clear_is_abort || !abort_reason_is_human(events.latest_turn_aborted_reason.as_deref());

        // Promote on a NEW unresolved start.
        if let Some(started_at) = events.latest_task_started_at {
            let is_new = state
                .last_seen_task_started_at
                .map(|seen| started_at > seen)
                .unwrap_or(true);
            state.last_seen_task_started_at =
                max_ts(state.last_seen_task_started_at, Some(started_at));
            let effective_clear = max_ts(observed_clear, state.last_cleared_at);
            if is_new
                && state
                    .accepted_start_at
                    .map(|accepted| started_at > accepted)
                    .unwrap_or(true)
                && effective_clear
                    .map(|cleared| started_at > cleared)
                    .unwrap_or(true)
            {
                if state.pending_approvals.is_empty() {
                    state.phase = CodexPhase::Busy;
                    state.force_read_logged = false;
                    state.next_force_read_at = None;
                    state.accepted_start_at = Some(started_at);
                    state.updated_at = at;
                    state.last_observed_at = at;
                } else {
                    // Lane-interference guard (decision 8 / audit A9): the
                    // turn's own task_started folding in MID-PAUSE would flip
                    // the phase Busy, feed the gate, and silently cancel the
                    // armed approval bell. Fold the anchors as usual but
                    // defer the Busy promotion to the approval resolve.
                    state.accepted_start_at = Some(started_at);
                    state.resume_busy_after_approval = true;
                }
            }
        }

        // Clear on a NEW terminating event at/after the turn anchor.
        if let Some(cleared_at) = observed_clear {
            let is_new_clear = state
                .last_cleared_at
                .map(|seen| cleared_at > seen)
                .unwrap_or(true);
            state.last_cleared_at = max_ts(state.last_cleared_at, Some(cleared_at));
            if is_new_clear && state.swallow_next_reconcile_clear {
                // S5.a: a proxy-initiated clear already ended this physical
                // turn; eat its rollout echo one-shot (CE1, third lane).
                state.swallow_next_reconcile_clear = false;
            } else if is_new_clear {
                if state.phase == CodexPhase::Pending
                    && state
                        .pending_submit_at
                        .map(|pending| cleared_at >= pending)
                        .unwrap_or(false)
                {
                    transition_pending_after_turn_clear(
                        state,
                        at,
                        &mut self.ledger,
                        &mut completions,
                        record,
                    );
                    // CE1: swallow the PTY BEL echo of this reconciled turn end
                    // (armed regardless of whether the fold arrived as one
                    // batch or split batches -- batch-agnostic by design).
                    state.swallow_next_bel = true;
                    // S5.a: and the proxy echo of the same physical turn.
                    state.swallow_next_proxy_complete = true;
                } else if (state.phase == CodexPhase::Busy || state.phase == CodexPhase::Unknown)
                    && state
                        .accepted_start_at
                        .map(|accepted| cleared_at >= accepted)
                        .unwrap_or(false)
                {
                    transition_after_turn_clear(
                        state,
                        at,
                        &mut self.ledger,
                        &mut completions,
                        record,
                    );
                    state.swallow_next_bel = true;
                    // S5.a: and the proxy echo of the same physical turn.
                    state.swallow_next_proxy_complete = true;
                }
            }
        }

        self.effects_after_transition(terminal_id, previous, completions)
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
        // KATA namg (D1): submit-time staleness escape -- the one
        // behavioral consumer of the retired Busy->Unknown demotion. A
        // submit into a Busy terminal SILENT past the deadman window is a
        // user acting on a wedged/phantom turn (the deadman force-reads
        // could not heal it): treat it as a FRESH pending turn -- the old
        // demotion's submit semantics at the same threshold -- instead of
        // queueing behind a turn end that will never come (queueing would
        // spend the real turn's single BEL clearing the phantom: zero
        // completions, no chime). Measured BEFORE last_observed_at is
        // refreshed by this very submit.
        let stale_busy =
            state.phase == CodexPhase::Busy && at - state.last_observed_at > self.busy_deadman_ms;
        state.last_submit_at = Some(at);
        state.pending_until = Some(at + PENDING_SUBMIT_GATE_MS);
        state.pending_freshness_at = Some(at);
        state.last_observed_at = at;
        if state.phase == CodexPhase::Busy && !stale_busy {
            if state.queued_submit_at.is_none() {
                state.queued_submit_at = Some(at);
            }
            state.pending_freshness_at = None;
            let next = state.to_record();
            return changed(Some(&previous), next);
        }

        if state.phase == CodexPhase::Idle || state.phase == CodexPhase::Unknown || stale_busy {
            // A fresh pending turn starts here: any armed directed swallow
            // (CE1, generalized across the three lanes in S5.a) belongs to a
            // PREVIOUS cleared turn and is stale.
            state.swallow_next_bel = false;
            state.swallow_next_proxy_complete = false;
            state.swallow_next_reconcile_clear = false;
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
                // Deadman disarm (kata namg): observed output IS liveness --
                // clear a fired anchor + warn latch so next_deadline()'s Busy
                // arm re-bases on the refreshed last_observed_at. An armed
                // stale anchor would pin the deadline at a PAST instant while
                // the fire guard (idle_age > window) is false: expire() never
                // fires/re-arms and the hub loop spins at wait = 0 until the
                // turn ends. (Latent in amplifier/tracker.rs:266-275, which
                // resets only force_read_logged; divergence recorded in the
                // module doc and plan D2.)
                state.force_read_logged = false;
                state.next_force_read_at = None;
            }
            return Vec::new();
        }
        let tracker_count = count_tracker_turn_complete_signals(data, &parser_state_at_start);
        let clear_count = count.min(tracker_count);
        if clear_count == 0 {
            if state.phase == CodexPhase::Busy || state.phase == CodexPhase::Pending {
                state.last_observed_at = at;
                // Deadman disarm (kata namg): observed output IS liveness --
                // clear a fired anchor + warn latch so next_deadline()'s Busy
                // arm re-bases on the refreshed last_observed_at. An armed
                // stale anchor would pin the deadline at a PAST instant while
                // the fire guard (idle_age > window) is false: expire() never
                // fires/re-arms and the hub loop spins at wait = 0 until the
                // turn ends. (Latent in amplifier/tracker.rs:266-275, which
                // resets only force_read_logged; divergence recorded in the
                // module doc and plan D2.)
                state.force_read_logged = false;
                state.next_force_read_at = None;
            }
            return Vec::new();
        }

        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();
        for _ in 0..clear_count {
            // CE1: a reconcile-initiated clear already ended this physical
            // turn; its late PTY BEL echo is consumed one-shot, with no
            // transition and no completion.
            if state.swallow_next_bel {
                state.swallow_next_bel = false;
                continue;
            }
            if !consume_turn_complete_signal(state, at, &mut self.ledger, &mut completions) {
                break;
            }
            // S5.a (A11): a BEL clear ended this physical turn -- swallow its
            // late proxy echo (it could otherwise prematurely complete a
            // queued follow-up submit that is now Pending).
            state.swallow_next_proxy_complete = true;
        }
        self.effects_after_transition(terminal_id, previous, completions)
    }

    /// S5.a: proxy lane TurnStarted (third clock domain -- server-clock `at`).
    /// Promotes Idle/Unknown/Pending to Busy, edge-triggered; never completes.
    /// Thread-scoped (kata codex-turn-thread-scope): the shared app-server
    /// connection relays turn events for EVERY thread on it (sub-agent,
    /// review, fork threads -- spike scenario D). Only the bound thread's
    /// turns may drive this terminal; before a thread binds we stay
    /// conservative and ignore the proxy lane entirely (the Rust identity
    /// gate holds turn/start until adoption binds, so the window is
    /// structurally empty on the managed path -- design decision #2).
    pub fn note_proxy_turn_started(
        &mut self,
        terminal_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() != Some(thread_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        // Design invariant: a NEW proxy turn is beginning -- a stale directed
        // swallow must not eat THIS turn's completion.
        state.swallow_next_proxy_complete = false;
        state.current_proxy_turn_id = turn_id.map(str::to_string);
        state.last_proxy_started_at = Some(at);
        state.last_observed_at = at;
        if matches!(
            state.phase,
            CodexPhase::Idle | CodexPhase::Unknown | CodexPhase::Pending
        ) {
            state.phase = CodexPhase::Busy;
            state.updated_at = at;
        }
        self.effects_after_transition(terminal_id, previous, Vec::new())
    }

    /// S5.a: proxy lane TurnCompleted. Real turn ends transition to Idle and
    /// record exactly one completion; echoes of turns another lane already
    /// ended are swallowed one-shot (CE1 generalized).
    ///
    /// Guard order (kata codex-turn-thread-scope):
    /// 1. thread scope -- foreign threads (sub-agents etc.) are ignored
    ///    BEFORE any state is touched (they must not consume swallows);
    /// 2. `inProgress` -- not a turn end at all (protocol.rs:111);
    /// 3. turn-id -- a completion for a different turn than the in-flight
    ///    one is a stale echo, no-op by construction;
    /// 4. directed proxy swallow (cross-lane dedupe, unchanged);
    /// 5. status -- `completed | failed | absent` record a bell-worthy completion; `interrupted` clears silently.
    pub fn note_proxy_turn_completed(
        &mut self,
        terminal_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        status: Option<&str>,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() != Some(thread_id) {
            return Vec::new();
        }
        if status == Some("inProgress") {
            return Vec::new();
        }
        if let (Some(current), Some(completed)) = (state.current_proxy_turn_id.as_deref(), turn_id)
        {
            if current != completed {
                return Vec::new();
            }
        }
        // Node parity (codex-activity-tracker.ts onTurnCompleted): once the
        // stale-id guard passes, this completion IS the in-flight turn's
        // terminal event -- retire the id unconditionally, even when the
        // effect below is swallowed or lands in the Idle arm. A surviving id
        // could wrongly drop a later real completion whose turn/started was
        // missed (proxy reconnect / fork windows).
        state.current_proxy_turn_id = None;
        if state.swallow_next_proxy_complete {
            state.swallow_next_proxy_complete = false;
            return Vec::new();
        }
        // Task 7: an accepted terminal-status completion retires the turn's
        // approval pause state ONCE, BEFORE the phase match -- a turn that
        // completes during an approval pause routes through the Idle arm
        // (the request itself demoted the phase, and the Idle arm never
        // records or resumes), so a late resolve of the stale approval must
        // not flip the pane Busy again.
        state.pending_approvals.clear();
        state.resume_busy_after_approval = false;
        // Attention-bell policy: completed AND failed are non-human stopping causes
        // and record a completion (=> gate arms => terminal.idle). `interrupted`
        // (and only it) is human-requested and stays a silent claim. If a queued
        // submit exists the shared transition machinery re-arms instead of ringing —
        // the queued message auto-submits and work continues.
        let record = matches!(status, None | Some("completed") | Some("failed"));
        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();
        match state.phase {
            CodexPhase::Pending => {
                transition_pending_after_turn_clear(
                    state,
                    at,
                    &mut self.ledger,
                    &mut completions,
                    record,
                );
                state.swallow_next_bel = true;
                state.swallow_next_reconcile_clear = true;
            }
            CodexPhase::Busy | CodexPhase::Unknown => {
                let turn_key = state.last_proxy_started_at.or(state.pending_submit_at);
                state.phase = CodexPhase::Idle;
                state.updated_at = at;
                if record {
                    record_completion_if_idle(
                        state,
                        turn_key.or(Some(at)),
                        at,
                        &mut self.ledger,
                        &mut completions,
                    );
                } else {
                    claim_turn_key_if_idle(state, turn_key.or(Some(at)));
                }
                state.swallow_next_bel = true;
                state.swallow_next_reconcile_clear = true;
            }
            CodexPhase::Idle => {
                // Mid-pause turn end / stale echo (silent claim): an approval
                // pause demoted the phase, so the pause's turn/completed lands
                // here -- no completion, no boundary (the approval bell
                // already covers this attention event). But the anchors this
                // turn planted (accepted via the mid-pause reconcile fold,
                // pending via a pause keystroke) would otherwise survive and
                // let the codex TUI's turn-complete BEL -- or the rollout's
                // clear echo -- re-mint the same physical turn as a spurious
                // TurnComplete (a second terminal.idle for one episode).
                // Claim the turn key exactly like the Busy arm, retire the
                // anchors, and arm both cross-lane swallows. Clearing
                // accepted_start_at is safe for reconcile_rollout: its clear
                // guard requires Busy|Unknown and `.map(..).unwrap_or(false)`
                // on the anchor, and its promotion guard falls back to the
                // is_new edge-trigger.
                let turn_key = state.last_proxy_started_at.or(state.pending_submit_at);
                state.accepted_start_at = None;
                state.pending_submit_at = None;
                claim_turn_key_if_idle(state, turn_key.or(Some(at)));
                state.swallow_next_bel = true;
                state.swallow_next_reconcile_clear = true;
            }
        }
        self.effects_after_transition(terminal_id, previous, completions)
    }

    /// Approval-request pause (managed lane). Thread-scoped like turn events;
    /// requests without a threadId are accepted (the proxy is per-terminal).
    /// Public phase maps to the EXISTING not-busy value — no new wire phase.
    /// Queued input never suppresses approval bells: still blocked on a human.
    pub fn note_approval_requested(
        &mut self,
        terminal_id: &str,
        thread_id: Option<&str>,
        request_id: &str,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if let (Some(thread), Some(bound)) = (thread_id, state.session_id.as_deref()) {
            if thread != bound {
                return Vec::new();
            }
        }
        // Hardening: only a NEWLY inserted request id arms the gate. A
        // duplicate request frame (proxy retry / reconnect replay) for an id
        // already pending must not re-arm -- one boundary per approval pause.
        let newly_inserted = state.pending_approvals.insert(request_id.to_string());
        let previous = state.to_record();
        if matches!(
            state.phase,
            CodexPhase::Busy | CodexPhase::Pending | CodexPhase::Unknown
        ) {
            state.resume_busy_after_approval = true;
            state.phase = CodexPhase::Idle;
        }
        state.updated_at = at;
        let next = state.to_record();
        let mut effects = changed(Some(&previous), next);
        if newly_inserted {
            effects.push(TrackerEffect::AttentionBoundary {
                terminal_id: terminal_id.to_string(),
                at,
            });
        }
        effects
    }

    /// The approval response passed back through the proxy: the turn resumes.
    /// Cancels a pending bell within the grace (gate sees Busy); un-greens the
    /// pane. Stale/unknown request ids are no-ops.
    pub fn note_approval_resolved(
        &mut self,
        terminal_id: &str,
        request_id: &str,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if !state.pending_approvals.remove(request_id) {
            return Vec::new();
        }
        if !state.pending_approvals.is_empty() || !state.resume_busy_after_approval {
            return Vec::new();
        }
        state.resume_busy_after_approval = false;
        let previous = state.to_record();
        state.phase = CodexPhase::Busy;
        state.updated_at = at;
        state.last_observed_at = at;
        // Audit A9 hazard 2: a mid-pause Enter (the human answering the
        // approval prompt in the TUI) planted PTY pending-submit state --
        // normalize it so the NEXT turn clear is not misread as a queued
        // re-arm of the pause keystroke.
        state.pending_submit_at = None;
        state.pending_freshness_at = None;
        state.pending_until = None;
        let next = state.to_record();
        changed(Some(&previous), next)
    }

    /// Death-bell engagement extension (decision 3): a pane blocked on an
    /// approval whose process dies spontaneously must ring. Read by the hub's
    /// Exit arm alongside IdleGate::is_engaged, BEFORE any teardown.
    pub fn has_pending_approvals(&self, terminal_id: &str) -> bool {
        self.states
            .get(terminal_id)
            .map(|s| !s.pending_approvals.is_empty())
            .unwrap_or(false)
    }

    /// Shared effect-assembly tail (extracted, S5.a): convert a transition's
    /// (previous record, completions) into the emitted effect vector -- a
    /// `Changed` upsert when the record publicly changed, plus one
    /// `TurnComplete` per recorded completion.
    fn effects_after_transition(
        &mut self,
        terminal_id: &str,
        previous: CodexActivityRecord,
        completions: Vec<(Option<String>, i64, i64)>,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get(terminal_id) else {
            return Vec::new();
        };
        let next = state.to_record();
        let mut effects = changed(Some(&previous), next);
        for (session_id, at, completion_seq) in completions {
            effects.push(TrackerEffect::TurnComplete {
                terminal_id: terminal_id.to_string(),
                session_id,
                at,
                completion_seq,
            });
        }
        effects
    }

    /// `expire` / `expireState` (`codex-activity-tracker.ts:350-573`), the
    /// pending-decay + busy-deadman transitions, deadline-driven.
    pub fn expire(&mut self, at: i64) -> Vec<CodexEffect> {
        let mut effects = Vec::new();
        let busy_deadman_ms = self.busy_deadman_ms;
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
            } else if state.phase == CodexPhase::Busy {
                // Deadman (kata namg; mirror of amplifier/tracker.rs:332-357):
                // a busy terminal silent past the window requests a rollout
                // force-read and STAYS busy -- never fabricate a completion,
                // never demote on a timer. The hub drains the force-read via
                // drain_codex_lane; the offset-based tailer catches up fully,
                // so a missed inotify event costs at most one window instead
                // of a silent-forever stall. Repeats every window while the
                // silence persists (each repeat also retries a fail-quiet
                // tailer read).
                let idle_age_ms = at - state.last_observed_at;
                let due = state
                    .next_force_read_at
                    .map(|next| at >= next)
                    .unwrap_or(idle_age_ms > busy_deadman_ms);
                if idle_age_ms > busy_deadman_ms && due {
                    if !state.force_read_logged {
                        state.force_read_logged = true;
                        tracing::warn!(
                            component = "codex-activity-tracker",
                            event = "codex_activity_deadman_force_read",
                            terminal_id = %state.terminal_id,
                            age_ms = idle_age_ms,
                            "Codex terminal silent past deadman; requesting rollout force-read (staying busy)."
                        );
                    }
                    state.next_force_read_at = Some(at + busy_deadman_ms);
                    effects.push(TrackerEffect::ForceRead {
                        terminal_id: state.terminal_id.clone(),
                        at,
                    });
                }
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
                CodexPhase::Busy => Some(
                    state
                        .next_force_read_at
                        .unwrap_or(state.last_observed_at + self.busy_deadman_ms + 1),
                ),
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

/// Human-attributed abort reasons stay silent. A MISSING reason is treated
/// as human/uncertain (legacy rollouts omit it; the real-world corpus shows
/// 'interrupted' is the only observed value; uncertainty never rings).
fn abort_reason_is_human(reason: Option<&str>) -> bool {
    matches!(reason, None | Some("interrupted") | Some("replaced"))
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
            transition_pending_after_turn_clear(state, at, ledger, completions, true);
            return true;
        }
        return false;
    }
    if state.accepted_start_at.is_some() {
        transition_after_turn_clear(state, at, ledger, completions, true);
        return true;
    }
    false
}

fn transition_pending_after_turn_clear(
    state: &mut TerminalActivity,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
    record: bool,
) {
    let turn_key = state.pending_submit_at;
    let queued = has_queued_submit(state);
    // CE2: a pending-key turn end also retires any accepted anchor -- a
    // stale one (e.g. left by a deadman-demoted seeded busy) would let the
    // second BEL of a dup-BEL chunk fire a bogus extra completion.
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
        state.pending_until = None;
        state.queued_submit_at = None;
    }
    if record {
        record_completion_if_idle(state, turn_key, at, ledger, completions);
    } else {
        claim_turn_key_if_idle(state, turn_key);
    }
}

fn transition_after_turn_clear(
    state: &mut TerminalActivity,
    at: i64,
    ledger: &mut TurnCompletionLedger,
    completions: &mut Vec<(Option<String>, i64, i64)>,
    record: bool,
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
    if record {
        record_completion_if_idle(state, turn_key, at, ledger, completions);
    } else {
        claim_turn_key_if_idle(state, turn_key);
    }
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

/// Abort-shaped clears (`turn_aborted` in the rollout lane; status
/// `interrupted`/`failed` on the proxy lane, Task 2): claim the turn key
/// exactly like `record_completion_if_idle` does, but WITHOUT recording a
/// ledger completion -- the pane returns to idle silently (terminal.idle is
/// never emitted after a HUMAN-REQUESTED stop; it IS emitted for failed turns,
/// non-human abort reasons (forward-compatible — none emitted at codex <=
/// 0.147), spontaneous death while engaged, and approval pauses;
/// shared/ws-protocol.ts terminal.idle doc) and a later echo of the same
/// physical turn cannot mint a completion.
fn claim_turn_key_if_idle(state: &mut TerminalActivity, turn_key: Option<i64>) {
    let Some(turn_key) = turn_key else { return };
    if state.phase != CodexPhase::Idle {
        return;
    }
    state.last_emitted_turn_key = Some(turn_key);
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

    fn force_reads(effects: &[CodexEffect]) -> usize {
        effects
            .iter()
            .filter(|e| matches!(e, TrackerEffect::ForceRead { .. }))
            .count()
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

    #[test]
    fn bind_session_on_untracked_terminal_is_a_silent_noop() {
        let mut tracker = CodexActivityTracker::new();
        let effects = tracker.bind_session("t-unknown", "thread-9");
        assert!(effects.is_empty());
        assert!(tracker.list().is_empty());
    }

    #[test]
    fn bind_session_is_idempotent_on_reannounce_and_emits_on_change() {
        // The client re-sends `terminal.codex.candidate.persisted` on every
        // durability update -- re-binding the same id must not spam frames.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);

        let first = tracker.bind_session("t1", "thread-1");
        assert_eq!(first.len(), 1, "identity change is a public change");
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-1"));

        let again = tracker.bind_session("t1", "thread-1");
        assert!(again.is_empty(), "same id re-announce is a no-op");

        let rebound = tracker.bind_session("t1", "thread-2");
        assert_eq!(rebound.len(), 1);
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-2"));
    }

    #[test]
    fn bind_session_mid_turn_retroactively_stamps_the_completion() {
        // G3: a FRESH codex terminal has no identity at create; the candidate
        // adoption binds it mid-turn; the BEL's turn.complete must carry it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let bind = tracker.bind_session("t1", "thread-1");
        assert_eq!(bind.len(), 1, "bind while pending is a public change");
        let effects = tracker.note_output("t1", "\u{07}", 9_000);
        let complete_session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(complete_session, Some(Some("thread-1".to_string())));
    }

    #[test]
    fn track_terminal_rebind_branch_updates_identity_in_place() {
        // Pins the previously-untested rebind branch (track_terminal on an
        // existing state with a NEW session id).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let effects = tracker.track_terminal("t1", Some("thread-2"), 5);
        assert_eq!(effects.len(), 1);
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-2"));
        let noop = tracker.track_terminal("t1", Some("thread-2"), 6);
        assert!(noop.is_empty());
    }

    fn started(at: i64) -> CodexTaskEvents {
        CodexTaskEvents {
            latest_task_started_at: Some(at),
            ..Default::default()
        }
    }
    fn completed(at: i64) -> CodexTaskEvents {
        CodexTaskEvents {
            latest_task_completed_at: Some(at),
            ..Default::default()
        }
    }
    fn aborted(at: i64, reason: Option<&str>) -> CodexTaskEvents {
        CodexTaskEvents {
            latest_task_started_at: Some(at - 1_000),
            latest_task_completed_at: None,
            latest_turn_aborted_at: Some(at),
            latest_turn_aborted_reason: reason.map(str::to_string),
        }
    }

    #[test]
    fn reconcile_seeds_busy_for_an_unresolved_rollout() {
        // Resume-busy seeding: a terminal restored mid-turn (rollout shows a
        // task_started newer than any clear) paints busy immediately.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let effects = tracker.reconcile_rollout("t1", &started(100), 200);
        assert_eq!(phases(&effects), vec![CodexPhase::Busy]);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }

    #[test]
    fn reconcile_ignores_an_already_resolved_rollout() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let events = CodexTaskEvents {
            latest_task_started_at: Some(100),
            latest_task_completed_at: Some(150),
            latest_turn_aborted_at: None,
            latest_turn_aborted_reason: None,
        };
        let effects = tracker.reconcile_rollout("t1", &events, 200);
        assert!(effects.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Idle);
    }

    #[test]
    fn reconcile_clear_completes_a_seeded_busy_turn_with_identity() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let effects = tracker.reconcile_rollout("t1", &completed(300), 400);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("thread-1".to_string())));
    }

    #[test]
    fn reconcile_turn_aborted_clears_without_completing() {
        // SEMANTIC CHANGE (kata: codex-turn-thread-scope). This test replaces
        // `reconcile_turn_aborted_also_clears_and_completes`, which pinned the
        // old buggy behavior. terminal.idle is never emitted after a
        // HUMAN-REQUESTED stop; it IS emitted for failed turns, non-human
        // abort reasons (forward-compatible — none emitted at codex <= 0.147),
        // spontaneous death while engaged, and approval pauses
        // (shared/ws-protocol.ts terminal.idle doc) -- an Esc-interrupt
        // (`turn_aborted`) must return the pane to idle WITHOUT recording a
        // bell-worthy completion.
        // REFINED (attention-bell plan, Task 3): this fixture carries NO
        // abort reason, which stays silent (uncertainty never rings). Aborts
        // with a non-human reason DO record -- see the `reconcile_abort_*`
        // tests below.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let events = CodexTaskEvents {
            latest_turn_aborted_at: Some(300),
            ..Default::default()
        };
        let effects = tracker.reconcile_rollout("t1", &events, 400);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert!(
            completions(&effects).is_empty(),
            "turn_aborted must not ring the bell"
        );
    }

    /// Human-requested abort (Esc) — silent, unchanged behavior.
    #[test]
    fn reconcile_abort_with_interrupted_reason_clears_without_completing() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("sess-1"), 1_000);
        tracker.reconcile_rollout("t1", &started(2_000), 2_000);
        let effects = tracker.reconcile_rollout("t1", &aborted(5_000, Some("interrupted")), 5_000);
        assert_eq!(completions(&effects).len(), 0);
    }

    /// 'replaced' = human submitted new input — silent.
    #[test]
    fn reconcile_abort_with_replaced_reason_clears_without_completing() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("sess-1"), 1_000);
        tracker.reconcile_rollout("t1", &started(2_000), 2_000);
        let effects = tracker.reconcile_rollout("t1", &aborted(5_000, Some("replaced")), 5_000);
        assert_eq!(completions(&effects).len(), 0);
    }

    /// Missing reason = legacy rollout line / uncertainty — no heuristic bells.
    #[test]
    fn reconcile_abort_without_reason_clears_without_completing() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("sess-1"), 1_000);
        tracker.reconcile_rollout("t1", &started(2_000), 2_000);
        let effects = tracker.reconcile_rollout("t1", &aborted(5_000, None), 5_000);
        assert_eq!(completions(&effects).len(), 0);
    }

    /// Any OTHER present reason is not human-attributed — it records (rings).
    #[test]
    fn reconcile_abort_with_unknown_reason_records_a_completion() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("sess-1"), 1_000);
        tracker.reconcile_rollout("t1", &started(2_000), 2_000);
        let effects =
            tracker.reconcile_rollout("t1", &aborted(5_000, Some("token_budget_exceeded")), 5_000);
        assert_eq!(completions(&effects).len(), 1);
    }

    #[test]
    fn reconcile_task_complete_at_or_after_an_abort_still_completes() {
        // Tie-break rule: abort suppresses the chime only when it is STRICTLY
        // the newest terminating event. A real task_complete at the same
        // instant (or newer) still rings.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let events = CodexTaskEvents {
            latest_task_completed_at: Some(300),
            latest_turn_aborted_at: Some(300),
            ..Default::default()
        };
        let effects = tracker.reconcile_rollout("t1", &events, 400);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn reconcile_clear_completes_a_pending_pty_turn_exactly_once() {
        // JSONL task_complete usually lands BEFORE the PTY BEL: the pending
        // turn completes once via reconcile; the late BEL is an idle BEL and
        // must be ignored (single chime per turn -- legacy dedupe intent).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.reconcile_rollout("t1", &completed(50), 60);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
        let bel = tracker.note_output("t1", "\u{07}", 70);
        assert!(
            completions(&bel).is_empty(),
            "late BEL must not double-complete"
        );
    }

    #[test]
    fn bel_clears_a_reconcile_promoted_busy_turn_exactly_once() {
        // The reverse race: reconcile promotes Pending->Busy (task_started
        // confirms the submit), then the BEL ends the turn via the
        // accepted_start_at path (transition_after_turn_clear goes live).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10);
        let promote = tracker.reconcile_rollout("t1", &started(20), 30);
        assert_eq!(phases(&promote), vec![CodexPhase::Busy]);
        let bel = tracker.note_output("t1", "\u{07}", 9_000);
        assert_eq!(completions(&bel), vec![1]);
        // A later stale task_complete for the same turn is a no-op (idle).
        let late = tracker.reconcile_rollout("t1", &completed(8_000), 9_500);
        assert!(completions(&late).is_empty());
    }

    #[test]
    fn busy_deadman_defers_while_output_liveness_continues() {
        // KATA namg replacement for the retired Busy->Unknown demotion pin:
        // the deadman fires on SILENCE, so rollout/PTY observations that
        // refresh last_observed_at keep deferring it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy
        tracker.note_output("t1", "streaming...", 100_000); // liveness
        assert!(
            tracker.expire(200 + BUSY_DEADMAN_MS + 1).is_empty(),
            "observed at 100_000: not yet silent past the window"
        );
        let effects = tracker.expire(100_000 + BUSY_DEADMAN_MS + 1);
        assert_eq!(
            force_reads(&effects),
            1,
            "silence measured from the last observation"
        );
    }

    #[test]
    fn reconcile_on_untracked_terminal_is_a_noop() {
        let mut tracker = CodexActivityTracker::new();
        let effects = tracker.reconcile_rollout("t-unknown", &started(100), 200);
        assert!(effects.is_empty());
    }

    #[test]
    fn reconcile_clear_with_queued_submit_swallows_the_late_bel_echo() {
        // Load-bearing validation CE1: reconcile clear with a queued submit
        // re-arms Pending (transition_after_turn_clear's has_queued_submit
        // branch); the PTY BEL echo of the RECONCILED turn's end must not
        // complete the re-armed turn prematurely (the disjoint key spaces --
        // server-clock pending keys vs rollout-clock accepted keys -- make
        // last_emitted_turn_key powerless here; the swallow flag is the fix).
        //
        // Completion accounting matches the frozen PTY reference: a re-arm is
        // NOT a turn end (`record_completion_if_idle` records only when the
        // terminal lands Idle -- see its doc comment and the pinned PTY test
        // `queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`,
        // where two submitted turns also yield exactly ONE completion, seq 1).
        // So the reconcile clear here records nothing; the swallow flag is
        // what keeps the late BEL echo from prematurely completing turn 2.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10); // turn 1 pending
        tracker.reconcile_rollout("t1", &started(12), 15); // promoted busy
        tracker.note_input("t1", "\r", 20); // queued submit (turn 2)
        let clear = tracker.reconcile_rollout("t1", &completed(25), 30);
        assert!(
            completions(&clear).is_empty(),
            "re-arm to the queued turn is not a turn end (PTY parity)"
        );
        // The BEL echo of turn 1's end arrives late on the PTY lane. Without
        // the swallow flag it would end the RE-ARMED turn 2 prematurely (the
        // pending-key path lands Idle and records a bogus completion).
        let echo = tracker.note_output("t1", "\u{07}", 35);
        assert!(
            completions(&echo).is_empty(),
            "BEL echo of a reconcile-cleared turn must be swallowed"
        );
        // Turn 2 then actually runs and completes exactly once -- the FIRST
        // recorded completion (ledger seq 1; the re-arm recorded none).
        tracker.reconcile_rollout("t1", &started(40), 45);
        let done = tracker.reconcile_rollout("t1", &completed(60), 65);
        assert_eq!(completions(&done), vec![1], "turn 2 completes exactly once");
    }

    #[test]
    fn dup_bel_chunk_after_stale_busy_submit_completes_exactly_once() {
        // CE2 re-derived for the self-healing deadman (kata namg): the
        // deadman no longer demotes to Unknown; instead, a submit into the
        // stale-silent Busy terminal takes the D1 staleness escape into a
        // FRESH pending turn (note_input, same threshold as the retired
        // demotion). A dup-BEL chunk (real PTY behavior, see the existing
        // dup-BEL test) must still stamp exactly ONE completion for the one
        // physical turn end -- the pending-clear path nulls the phantom's
        // stale accepted anchor, so the second BEL of the chunk finds no
        // turn to complete. The load-bearing invariant is one completion
        // per physical turn end, regardless of which branch armed it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy, accepted=100
        tracker.expire(200 + BUSY_DEADMAN_MS + 1); // deadman fires; stays busy
        let submit_at = 200 + BUSY_DEADMAN_MS + 1_000; // silence > window: stale
        tracker.note_input("t1", "\r", submit_at); // staleness escape: fresh pending
        let bel = tracker.note_output("t1", "\u{07}\u{07}", submit_at + 500);
        assert_eq!(
            completions(&bel).len(),
            1,
            "one turn end -> exactly one completion, even for a dup-BEL chunk"
        );
    }

    #[test]
    fn deadman_force_reads_and_stays_busy_then_repeats() {
        // KATA namg: the codex busy-deadman self-heals instead of demoting.
        // A busy terminal silent past the window requests a rollout
        // force-read and STAYS busy -- never fabricate a completion, never
        // demote on a timer -- and repeats every window while the silence
        // persists (each repeat also retries a fail-quiet tailer read).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy

        let effects = tracker.expire(200 + BUSY_DEADMAN_MS + 1);
        assert_eq!(
            force_reads(&effects),
            1,
            "silent busy requests a force-read"
        );
        assert_eq!(
            tracker.list()[0].phase,
            CodexPhase::Busy,
            "the deadman never demotes on a timer"
        );
        assert!(
            phases(&effects).is_empty(),
            "staying busy is not a public change -- no Changed frame"
        );

        // Not due again until the repeat interval.
        assert!(tracker.expire(200 + BUSY_DEADMAN_MS + 2).is_empty());

        // Still silent a full window later: fires again.
        let again = tracker.expire(200 + 2 * BUSY_DEADMAN_MS + 2);
        assert_eq!(force_reads(&again), 1);
    }

    #[test]
    fn busy_deadline_follows_the_force_read_rearm() {
        // Pin RELATIVE to next_deadline() rather than assuming which
        // observation timestamp seeded last_observed_at.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let d0 = tracker
            .next_deadline()
            .expect("busy arms the deadman timer");
        let fired = tracker.expire(d0);
        assert_eq!(
            force_reads(&fired),
            1,
            "expiring at the armed deadline fires"
        );
        assert_eq!(
            tracker.next_deadline(),
            Some(d0 + BUSY_DEADMAN_MS),
            "after the fire the deadline follows the re-arm anchor"
        );
    }

    #[test]
    fn resumed_output_disarms_the_fired_deadman_anchor() {
        // KATA namg: a deadman fire arms next_force_read_at; if output then
        // resumes mid-turn, the liveness refresh must DISARM the anchor.
        // Otherwise next_deadline()'s Busy arm returns the stale (past)
        // anchor while expire()'s fire guard stays false -- nothing ever
        // fires or re-arms, and the hub loop spins at wait = 0 until the
        // turn ends. (Latent in the amplifier template, which resets only
        // the warn latch on liveness; fixed in this port -- see D2.)
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy
        let d0 = tracker.next_deadline().expect("busy arms the deadman");
        assert_eq!(force_reads(&tracker.expire(d0)), 1, "silent busy fires");

        // Output resumes mid-turn: the refresh must re-base the deadline
        // in the FUTURE relative to the new observation.
        let resume_at = d0 + 50;
        tracker.note_output("t1", "still streaming", resume_at);
        assert_eq!(
            tracker.next_deadline(),
            Some(resume_at + BUSY_DEADMAN_MS + 1),
            "resumed liveness disarms the fired anchor (no wait=0 hot-loop)"
        );
        assert!(
            tracker.expire(resume_at + 1).is_empty(),
            "a live turn never fires the deadman"
        );

        // A fresh full window of silence after the resume fires again.
        let again = tracker.expire(resume_at + BUSY_DEADMAN_MS + 1);
        assert_eq!(force_reads(&again), 1);
    }

    #[test]
    fn deadman_window_is_overridable_for_test_scale() {
        let mut tracker = CodexActivityTracker::new();
        tracker.set_busy_deadman_ms(500);
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let d0 = tracker
            .next_deadline()
            .expect("busy arms the (shrunk) deadman timer");
        assert!(d0 <= 200 + 501, "the shrunk window drives the deadline");
        let effects = tracker.expire(d0);
        assert_eq!(force_reads(&effects), 1);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }

    #[test]
    fn submit_into_stale_busy_starts_fresh_pending_and_completes_once() {
        // KATA namg (D1): the retired Busy->Unknown demotion had exactly ONE
        // behavioral consumer -- a user submit into a wedged (phantom-Busy)
        // terminal took the fresh-pending branch, and the next BEL completed
        // exactly once. Preserve that consumer directly at the submit site:
        // a submit into a Busy terminal SILENT past the deadman window
        // starts a FRESH pending turn (same threshold as the old demotion)
        // instead of queueing behind a turn end that will never come --
        // queueing would spend the real turn's single BEL on the phantom
        // and never chime.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("s1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // phantom busy
        let submit_at = 200 + 2 * BUSY_DEADMAN_MS; // still silent: stale
        tracker.note_input("t1", "\r", submit_at);
        assert_eq!(
            tracker.list()[0].phase,
            CodexPhase::Pending,
            "a stale-busy submit rescues a fresh pending turn (not a queue)"
        );
        let bel = tracker.note_output("t1", "\u{07}", submit_at + 500);
        assert_eq!(
            completions(&bel).len(),
            1,
            "the real turn's single BEL completes exactly once"
        );
    }

    #[test]
    fn proxy_turn_started_promotes_idle_to_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        let effects = tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 2_000);
        assert!(effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::Changed { .. })));
        // No completion on a start.
        assert!(!effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_turn_completes_exactly_once_per_turn() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 2_000);
        let first = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-1"),
            Some("completed"),
            3_000,
        );
        assert_eq!(
            first
                .iter()
                .filter(|e| matches!(e, TrackerEffect::TurnComplete { .. }))
                .count(),
            1
        );
        // Same physical turn reported again (proxy echo / duplicate) -> no double.
        let again = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-1"),
            Some("completed"),
            3_001,
        );
        assert!(!again
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_clear_swallows_the_late_pty_bel_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        // A pending PTY turn…
        tracker.note_input("t", "\r", 2_000);
        // …cleared by the PROXY lane (the authoritative turn end)…
        let cleared =
            tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_000);
        assert!(cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        // Late BEL echo of the SAME physical turn: swallowed, no second completion.
        let echo = tracker.note_output("t", "\u{7}", 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn reconcile_clear_swallows_the_late_proxy_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // Rollout reconcile ends the turn first…
        let events = CodexTaskEvents {
            latest_task_completed_at: Some(2_500),
            ..Default::default()
        };
        let cleared = tracker.reconcile_rollout("t", &events, 3_000);
        assert!(cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        // …then the proxy echo of the same physical turn is swallowed one-shot.
        let echo = tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn fresh_submit_disarms_all_swallow_flags() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_000); // arms bel + reconcile swallows
        tracker.note_input("t", "\r", 4_000); // fresh pending turn: disarm
                                              // A REAL turn end for the NEW turn must complete, not be swallowed.
        let done = tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 5_000);
        assert!(done
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn proxy_start_disarms_a_stale_proxy_swallow() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // Reconcile ends turn 1 and arms swallow_next_proxy_complete…
        let events = CodexTaskEvents {
            latest_task_completed_at: Some(2_500),
            ..Default::default()
        };
        tracker.reconcile_rollout("t", &events, 3_000);
        // …but turn 2 STARTS on the proxy lane before any proxy echo of turn 1
        // arrived: the stale swallow must be disarmed, not eat turn 2's end.
        tracker.note_proxy_turn_started("t", "sess", Some("turn-2"), 4_000);
        let done = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-2"),
            Some("completed"),
            5_000,
        );
        assert!(done
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    #[test]
    fn bel_clear_swallows_the_late_proxy_echo() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 1_000);
        tracker.note_input("t", "\r", 2_000);
        // A follow-up submit is QUEUED behind the pending turn…
        tracker.note_input("t", "\r", 2_500);
        // …then the PTY BEL ends turn 1 (BEL-initiated clear) and the queued
        // submit re-arms phase = Pending for turn 2. Per the pinned PTY-parity
        // accounting (`queued_submit_rearms_pending_after_the_bel_and_
        // completes_each_turn`), a re-arm is NOT a turn end: NO completion
        // here. (Deviation from the task brief's draft assertion, which
        // expected a completion on this clear — that contradicts the pinned
        // re-arm accounting the brief itself requires stay green; recorded
        // in the task report.)
        let cleared = tracker.note_output("t", "\u{7}", 3_000);
        assert!(!cleared
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
        assert_eq!(
            tracker.list()[0].phase,
            CodexPhase::Pending,
            "the queued submit re-armed turn 2"
        );
        // The proxy echo of the SAME physical turn lands next. Without the
        // BEL-clear arming it hits phase == Pending and PREMATURELY completes
        // queued turn 2 (ledger A11) — it must be swallowed instead.
        let echo = tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_050);
        assert!(!echo
            .iter()
            .any(|e| matches!(e, TrackerEffect::TurnComplete { .. })));
    }

    // ---- Thread scoping (kata: codex-turn-thread-scope) ----

    #[test]
    fn subagent_thread_turn_completed_mid_parent_turn_is_ignored() {
        // Spike scenario D (/tmp/codex-spike/spike-d.log): on a shared
        // app-server connection a sub-agent child thread emits turn/completed
        // (turn.status=completed) while the parent turn is still in progress.
        // That event must not flip Busy->Idle, must not record a completion,
        // and must not arm swallow flags that would eat the parent's real
        // completion.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-parent"), 0);
        tracker.note_proxy_turn_started("t", "thread-parent", Some("turn-parent"), 1_000);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);

        let child = tracker.note_proxy_turn_completed(
            "t",
            "thread-child",
            Some("turn-child"),
            Some("completed"),
            2_000,
        );
        assert!(
            child.is_empty(),
            "foreign-thread completion must be a no-op"
        );
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);

        // The parent's REAL completion still rings exactly once.
        let parent = tracker.note_proxy_turn_completed(
            "t",
            "thread-parent",
            Some("turn-parent"),
            Some("completed"),
            3_000,
        );
        assert_eq!(phases(&parent), vec![CodexPhase::Idle]);
        assert_eq!(completions(&parent), vec![1]);
    }

    #[test]
    fn foreign_thread_turn_started_does_not_promote_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-parent"), 0);
        let effects = tracker.note_proxy_turn_started("t", "thread-child", Some("turn-c"), 1_000);
        assert!(effects.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Idle);
    }

    #[test]
    fn unbound_terminal_ignores_proxy_turn_events() {
        // Unbound window policy (documented in the plan): before a thread
        // binds, the proxy lane is silent -- no busy promotion, no completion.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", None, 0);
        assert!(tracker
            .note_proxy_turn_started("t", "thread-x", Some("turn-1"), 1_000)
            .is_empty());
        assert!(tracker
            .note_proxy_turn_completed("t", "thread-x", Some("turn-1"), Some("completed"), 2_000)
            .is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Idle);
    }

    #[test]
    fn rebind_clears_stale_in_flight_proxy_turn_state() {
        // Design decision #7 (load-bearing ledger A9, falsified without this):
        // fork/resume rebinds arrive from the async disk fork-watch lane with
        // NO ordering guarantee vs proxy turn events. The child thread's first
        // turn/started can land BEFORE the rebind (the thread guard rightly
        // drops it); if the parent's stale current_proxy_turn_id survived the
        // rebind, the child's first turn/completed would be misclassified as
        // a stale echo -- stuck busy until reconcile.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("thread-a"), 0);
        tracker.note_proxy_turn_started("t", "thread-a", Some("turn-a1"), 1_000);
        // Child turn starts pre-rebind: dropped by the thread guard.
        tracker.note_proxy_turn_started("t", "thread-b", Some("turn-b1"), 1_200);
        // Disk fork-watch lane rebinds the pane to the child thread.
        tracker.bind_session("t", "thread-b");
        let effects = tracker.note_proxy_turn_completed(
            "t",
            "thread-b",
            Some("turn-b1"),
            Some("completed"),
            2_000,
        );
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
    }

    // ---- Status guard ----

    #[test]
    fn interrupted_status_clears_busy_without_completion() {
        // Spike scenario B: turn/interrupt yields turn/completed with
        // turn.status=interrupted. The pane returns to non-busy, no bell.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-1"),
            Some("interrupted"),
            2_000,
        );
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert!(completions(&effects).is_empty());
    }

    /// SEMANTIC CHANGE (attention-bell plan 2026-08-01): a failed turn is a
    /// non-human stopping cause — it records a completion so the IdleGate rings.
    /// Failed takes EXACTLY the completed path, so queue suppression + grace
    /// apply naturally. (Previously pinned as clears-without-completion.)
    #[test]
    fn failed_status_records_a_completion() {
        // Mirror the setup of `absent_status_still_completes_for_the_bound_thread`
        // (codex.rs:1843): track, bind thread, proxy turn started, then complete.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("failed"), 5_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(
            completions(&effects).len(),
            1,
            "failed must mint a completion"
        );
    }

    /// Failed must be indistinguishable from completed in effect shape — that is
    /// what makes queued-submit suppression and the 2s grace apply for free.
    #[test]
    fn failed_with_queued_submit_behaves_exactly_like_completed_with_queued_submit() {
        let run = |status: &str| {
            let mut tracker = CodexActivityTracker::new();
            tracker.track_terminal("t", Some("sess"), 0);
            tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
            // Queue a submit while busy (mirror the input used by
            // `queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`, codex.rs:1039).
            tracker.note_input("t", "do the next thing\r", 3_000);
            let effects =
                tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some(status), 5_000);
            (phases(&effects), completions(&effects).len())
        };
        assert_eq!(run("failed"), run("completed"));
    }

    #[test]
    fn in_progress_status_is_a_no_op() {
        // protocol.rs:111 -- turn/completed fires for ALL statuses;
        // `inProgress` is not a turn end and must not clear busy.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-1"),
            Some("inProgress"),
            2_000,
        );
        assert!(effects.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }

    #[test]
    fn absent_status_still_completes_for_the_bound_thread() {
        // Compatibility: older protocol forms omit status. Treat as a
        // positive completion so panes never hang busy.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects = tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), None, 2_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn bel_echo_after_an_interrupted_clear_does_not_ring() {
        // The interrupt-shaped clear must arm the BEL swallow like a normal
        // proxy clear does -- the aborted turn's PTY BEL echo stays silent.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("interrupted"), 2_000);
        let echo = tracker.note_output("t", "\u{7}", 2_100);
        assert!(completions(&echo).is_empty());
    }

    // ---- Turn-id dedupe ----

    #[test]
    fn stale_completion_for_a_previous_turn_id_is_ignored() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-2"), 2_000);
        // A late completion echo for an OLDER turn id arrives while turn-2
        // is running: no-op by construction.
        let stale = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-1"),
            Some("completed"),
            2_100,
        );
        assert!(stale.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
        // turn-2's real completion still rings.
        let real = tracker.note_proxy_turn_completed(
            "t",
            "sess",
            Some("turn-2"),
            Some("completed"),
            3_000,
        );
        assert_eq!(completions(&real), vec![1]);
    }

    #[test]
    fn completion_without_turn_ids_falls_back_to_phase_semantics() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", None, 1_000);
        let effects =
            tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 2_000);
        assert_eq!(completions(&effects), vec![1]);
    }

    /// Deferred minor from the thread-scope plan: the in-flight proxy turn id
    /// must not survive the turn it belongs to. A NEW turn id arriving after a
    /// completed one must not be rejected by the stale-turn-id guard.
    #[test]
    fn accepted_completion_clears_the_in_flight_proxy_turn_id() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            3_000,
        );
        // The in-flight proxy turn id must be cleared after the accepted completion.
        assert_eq!(tracker.current_proxy_turn_id_for("t1"), None);
        // With the id cleared, a follow-up turn with a new id starts cleanly and
        // its completion is NOT swallowed by the turn-id-mismatch guard.
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-2"), 4_000);
        let effects = tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-2"),
            Some("completed"),
            6_000,
        );
        assert_eq!(completions(&effects).len(), 1);
    }

    // ---- Approval pauses (attention bell, Task 7) ----

    /// Approval pause: internal waiting state, public phase flips to the
    /// EXISTING not-busy value, and the gate boundary arms (no completion).
    #[test]
    fn approval_request_pauses_busy_to_idle_and_arms_a_boundary() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        let effects = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(
            completions(&effects).len(),
            0,
            "an approval pause is not a turn end"
        );
        assert!(
            effects
                .iter()
                .any(|e| matches!(e, TrackerEffect::AttentionBoundary { at: 3_000, .. })),
            "the gate boundary must arm"
        );
    }

    #[test]
    fn approval_resolved_returns_to_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        let effects = tracker.note_approval_resolved("t1", "41", 4_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Busy], "the turn resumes");
    }

    #[test]
    fn approval_resolved_with_no_prior_busy_stays_idle() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000); // pane was idle
        let effects = tracker.note_approval_resolved("t1", "41", 4_000);
        assert_eq!(
            phases(&effects),
            Vec::<CodexPhase>::new(),
            "nothing to resume"
        );
    }

    #[test]
    fn foreign_thread_approval_request_is_ignored() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        let effects = tracker.note_approval_requested("t1", Some("subagent-thread"), "41", 3_000);
        assert!(
            effects.is_empty(),
            "a sub-agent approval must not ring the parent pane"
        );
    }

    #[test]
    fn approval_request_without_thread_id_is_accepted() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        let effects = tracker.note_approval_requested("t1", None, "41", 3_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
    }

    #[test]
    fn queued_submit_does_not_block_the_approval_boundary() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_input("t1", "queued message\r", 2_500); // still blocked on the human
        let effects = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        assert!(effects
            .iter()
            .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })));
    }

    #[test]
    fn turn_completion_clears_pending_approvals() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            5_000,
        );
        // A late response to the stale approval must not flip the pane busy.
        let effects = tracker.note_approval_resolved("t1", "41", 6_000);
        assert!(effects.is_empty());
    }

    /// A turn that ends WHILE the approval pause holds the phase at Idle must
    /// end silently (the approval bell already covers the attention event) --
    /// AND its surviving anchors must not let the codex TUI's turn-complete
    /// BEL echo re-mint the same physical turn as a spurious TurnComplete
    /// (which would ring a second terminal.idle for one episode).
    #[test]
    fn mid_pause_turn_end_silences_the_bel_echo_and_clears_anchors() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        // The turn's own task_started folds mid-pause (audit A9 branch): the
        // accepted anchor lands without flipping Busy.
        tracker.reconcile_rollout("t1", &started(3_500), 3_500);
        // The turn completes while the approval is still pending: the Idle
        // arm claims silently -- no completion.
        let done = tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            5_000,
        );
        assert!(
            completions(&done).is_empty(),
            "a mid-pause turn end must not record a completion"
        );
        // The TUI's turn-complete BEL echo of that same physical turn.
        let echo = tracker.note_output("t1", "\u{7}", 5_100);
        assert!(
            completions(&echo).is_empty(),
            "the BEL echo of a mid-pause turn end must not re-mint the turn"
        );
        let state = tracker.states.get("t1").expect("state");
        assert_eq!(state.accepted_start_at, None, "accepted anchor retired");
        assert_eq!(state.pending_submit_at, None, "pending anchor retired");
    }

    /// Node parity: the in-flight proxy turn id is retired unconditionally
    /// once the stale-id guard passes -- including swallowed echoes and the
    /// Idle arm. A surviving id could wrongly drop a later real completion
    /// whose turn/started was missed (proxy reconnect / fork windows).
    #[test]
    fn swallowed_and_idle_arm_proxy_echoes_retire_the_in_flight_turn_id() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        // The rollout lane ends the turn (fold the start, then its clear).
        tracker.reconcile_rollout("t1", &started(2_500), 2_600);
        let events = CodexTaskEvents {
            latest_task_started_at: Some(2_500),
            latest_task_completed_at: Some(3_000),
            latest_turn_aborted_at: None,
            latest_turn_aborted_reason: None,
        };
        tracker.reconcile_rollout("t1", &events, 3_100);
        // First proxy echo of the same physical turn: swallowed one-shot.
        let first = tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            3_200,
        );
        assert!(completions(&first).is_empty(), "swallowed echo is silent");
        // Second echo lands in the Idle arm: still silent.
        let second = tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            3_300,
        );
        assert!(completions(&second).is_empty(), "idle-arm echo is silent");
        // The id of the closed turn must not survive either path.
        assert_eq!(tracker.current_proxy_turn_id_for("t1"), None);
    }

    /// Hardening: a duplicate request frame for an id ALREADY pending must
    /// not push a second AttentionBoundary (re-arming the gate would re-ring
    /// the same approval pause).
    #[test]
    fn duplicate_approval_request_does_not_rearm_the_boundary() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        let first = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        assert!(first
            .iter()
            .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })));
        let dup = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_500);
        assert!(
            !dup.iter()
                .any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })),
            "a duplicate approval request frame must not re-arm the gate"
        );
    }

    /// Audit A9: the FIRST rollout fold of the turn's own task_started passes
    /// the reconcile edge-trigger (codex.rs:352-368) — landing mid-pause it
    /// would flip phase Busy, feed the gate, and silently cancel the armed
    /// approval bell. Mid-pause promotions must fold anchors but defer the
    /// phase flip to the resolve.
    #[test]
    fn reconcile_task_started_during_pending_approval_does_not_flip_busy() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        // Reuse Task 3's `started(at)` CodexTaskEvents helper.
        let effects = tracker.reconcile_rollout("t1", &started(3_500), 3_500);
        assert_eq!(
            phases(&effects),
            Vec::<CodexPhase>::new(),
            "no Busy upsert mid-pause"
        );
        // The deferred promotion resumes at resolve.
        let effects = tracker.note_approval_resolved("t1", "41", 4_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Busy]);
    }

    /// Audit A9 hazard 2: a mid-pause Enter (the human answering the approval
    /// in the TUI) plants PTY pending-submit state; resolve must normalize it
    /// so the NEXT turn clear is not misclassified as a queued re-arm (which
    /// would suppress a legitimate later bell).
    #[test]
    fn approval_resolve_normalizes_pending_submit_input_state() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        tracker.note_input("t1", "\r", 3_500); // answering the approval prompt
        tracker.note_approval_resolved("t1", "41", 4_000);
        let effects = tracker.note_proxy_turn_completed(
            "t1",
            "thread-1",
            Some("turn-1"),
            Some("completed"),
            6_000,
        );
        assert_eq!(
            phases(&effects),
            vec![CodexPhase::Idle],
            "no Pending re-arm from the pause keystroke"
        );
        assert_eq!(
            completions(&effects).len(),
            1,
            "the completion bell must not be swallowed"
        );
    }

    /// Decision 3 / audit A10: a pane blocked on an approval counts as engaged
    /// for the death bell.
    #[test]
    fn has_pending_approvals_tracks_the_pending_set() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        assert!(!tracker.has_pending_approvals("t1"));
        tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
        assert!(tracker.has_pending_approvals("t1"));
        tracker.note_approval_resolved("t1", "41", 4_000);
        assert!(!tracker.has_pending_approvals("t1"));
    }
}

# Codex Turn Thread-Scope Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Stop freshell from showing Codex panes green and ringing the bell (`terminal.idle`) while Codex is still working, by making turn-completion detection thread-scoped, status-guarded, and turn-id-deduplicated on both servers (Rust production + Node parity).

**Architecture:** The codex app-server relays `turn/started`/`turn/completed` JSON-RPC notifications for EVERY thread on a shared connection (sub-agents, review threads, forks). Both servers currently discard the notification's `threadId`/`turnId`/`status` at the routing layer, so a sub-agent's `turn/completed` flips the tracker Busy→Idle and rings the bell mid-parent-turn (verified by live spike scenario D, `/tmp/codex-spike/spike-d.log`). The fix plumbs identity through the event path and puts three guards in the trackers: (1) ignore turn events whose thread id doesn't match the terminal's bound codex thread, (2) only `status == 'completed'` records a bell-worthy completion (`interrupted`/`failed` clear the phase silently; `inProgress` is a no-op), (3) a completion for a different turn id than the in-flight one is a stale echo and a no-op. The rollout-reconcile lane gets the same status rule: `turn_aborted` clears phase without recording a completion.

**Tech Stack:** Rust (crates `freshell-activity`, `freshell-ws`, `freshell-codex`; tokio, serde_json), TypeScript Node server (`server/`), vitest.

## Global Constraints

- Work in the existing worktree `/home/dan/code/freshell/.worktrees/codex-turn-thread-scope` on branch `fix/codex-turn-thread-scope` (branched from `origin/main` @ `35fbf1357`). All commands below run from that worktree root.
- Strict Red-Green-Refactor TDD: write the failing test first, watch it fail, make it pass, never skip the refactor or the test.
- Do NOT create a PR without explicit user approval. Never restart or deploy to the self-hosted server (building is fine). Do not touch the running production server on port 3002 or any live codex sidecars.
- Wire contract is FROZEN (`WS_PROTOCOL_VERSION=7`): this plan changes NO wire shapes. `shared/ws-protocol.ts` zod schemas must not change (the `terminal.idle` doc comment at `shared/ws-protocol.ts:199-208` already promises the post-fix semantics — "Never emitted after crash/interrupt/exit; subagent completions inside a running turn never produce it" — so no doc edit is needed either). `server/terminal-stream/registry-events.ts` is a server-INTERNAL event type, not wire-visible. If you believe a wire shape must change, STOP — that is out of scope; the contract-generation workflow in `port/contract/README.md` must not be triggered by this plan.
- Keep the IdleGate 2s grace untouched: `IDLE_GRACE_MS = 2_000` (`crates/freshell-activity/src/idle.rs:30`) and `TERMINAL_IDLE_GRACE_MS = 2_000` (`server/coding-cli/truly-idle-emitter.ts:1`) stay exactly as they are.
- No client changes: `terminal.idle` remains the only bell/green edge.
- Vitest ONLY via the coordinator: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts <paths> --run`. Raw `npx vitest` is forbidden (AGENTS.md). Broad runs (`npm run check`) go through the shared coordinator gate — wait for the gate, never kill foreign holders.
- Worktree prerequisite (ledger A14): the worktree must have its own `node_modules` (`npm ci` — already performed during plan validation). The `freshell-ws`/`freshell-codex` Rust integration binaries spawn the server, which resolves the worktree-local `tsx`; without the install ~20 integration binaries fail with `Unable to resolve MCP dependency "tsx"`. Baseline at HEAD was verified green after install: 53/53 Rust test binaries (800 tests), 136/136 targeted vitest tests.
- Rust targeted tests: `cargo test -p <crate>`.
- Commit author email must be the verified `3732858+danshapiro@users.noreply.github.com`.
- `.kata.toml`: this plan does not modify it; if any step somehow does, commit it.
- `README.md` is the only end-user markdown doc — this plan file under `docs/plans/` is a working doc and is fine; create no other docs.

## Design decisions locked by this plan

1. **Guards live in the trackers** (`crates/freshell-activity/src/codex.rs`, `server/coding-cli/codex-activity-tracker.ts`), not in the routers — the trackers are pure, synchronous, and densely unit-tested; the routers/wiring stay dumb pass-throughs that merely stop discarding the payload.
2. **Unbound window = ignore.** Before a terminal has a bound codex thread id (`session_id`/`sessionId` is `None`/state absent), proxy/app-server turn events are ignored entirely (no phase change, no completion). Rationale (validated — load-bearing ledger A3): on the Rust managed path the proxy's identity gate HOLDS client `turn/start`/`thread/fork` frames until candidate adoption has bound the pane (`crates/freshell-codex/src/remote_proxy.rs:601-613`; release after adoption in `crates/freshell-ws/src/codex_proxy_route.rs:127-146`), so the unbound window is structurally empty there. On Node the fresh-create path binds only via rollout proof, which is skipped until the first turn completes (`server/terminal-registry.ts:2669-2672`, bind at `:2904`) — the ENTIRE first fresh turn runs pre-bind and the tracker has no state for it (state is created on bind), so "ignore" is byte-identical to today's behavior. The justification is therefore STATUS-QUO PARITY on Node, not fallback-lane coverage: the first fresh Node turn is dark today and stays dark (pre-existing, out of scope); the rollout lane reconciles from bind onward. This is the "simplest correct behavior" the spec asks to choose and document.
3. **Status guard:** only `Some("completed")` — or an ABSENT status (older protocol forms; avoids panes hanging busy) — records a bell-worthy completion. `interrupted`/`failed` clear the busy phase without recording. `inProgress` is a strict no-op (not a turn end at all).
4. **Turn-id dedupe:** the tracker remembers the in-flight proxy turn id (set on `turn/started`). A completion carrying a DIFFERENT turn id (both present) is a stale echo of an already-closed turn — a no-op by construction. When either id is absent, fall through to existing behavior. The existing cross-lane swallow flags (`swallow_next_bel`, `swallow_next_proxy_complete`, `swallow_next_reconcile_clear`) are KEPT unchanged — they dedupe across the disjoint clock domains (PTY BEL / rollout / proxy) that turn ids cannot reach. The five pinned swallow tests must stay green.
5. **Abort-shaped clears claim the turn key.** When a clear does not record a completion (abort/interrupt/failed), it still writes `last_emitted_turn_key`/`lastEmittedTurnKey` so a later echo of the same physical turn cannot mint a completion.
6. **Tie-break:** when `latest_task_completed_at == latest_turn_aborted_at`, the clear counts as a real completion (a genuine `task_complete` at the same instant still rings). Abort wins only when strictly newer. (Validated — ledger A8: rollout terminal events are one-per-turn and `task_complete` is never co-written for an interrupted turn, so ties are theoretical; the rule direction is safe.)
7. **Rebind clears in-flight proxy-turn state (Rust only).** Fork/resume rebinds arrive from the async disk fork-watch lane with NO ordering guarantee vs proxy turn events (`crates/freshell-ws/src/codex_proxy_route.rs:88-91` explicitly defers fork rebinds to it). `bind_session` and `track_terminal`'s rebind branch must clear `current_proxy_turn_id` AND `last_proxy_started_at` whenever the bound id changes (ledger A9, falsified without this) — otherwise the child thread's first `turn/completed` is misclassified as a stale echo (stuck busy until reconcile) or collides on `last_emitted_turn_key`. Node needs nothing: `bindTerminal` builds a fresh state literal on rebind (`server/coding-cli/codex-activity-tracker.ts:139-152`). A candidate-SET thread match (accepting any owned/forked thread) was considered to close the fork window and rejected: sub-agent threads ARE forks (spike D rollout: `forked_from_id` = parent thread), so set-matching would reintroduce the exact bug this plan fixes. Residual fork-window drops (child turn events landing pre-rebind are ignored by the thread guard) are covered by the rollout-reconcile lane after rebind.

### Residual risks (validated and accepted — see load-bearing ledger)

- **Hard kill / crash can leave a turn with NO `turn_aborted`** in the rollout (openai/codex#12843): pre-existing gap, unchanged by this plan; the busy-deadman force-read lane self-heals. Out of scope.
- **Id casing:** codex emits lowercase thread ids and every managed bind source takes the id verbatim from the wire or rollout `payload.id` (4/4 spike rollouts: filename UUID == `payload.id` == wire threadId). A hand-supplied UPPERCASE resume id would bind but never match the strict-equality guard — accepted; no normalization added.
- **Detached review threads** (separate thread, no parent turn) exist in the codex protocol but are not delivered by the 0.146 TUI (`/review` is hardcoded inline, running on the parent thread). If a future codex version flips that default, strict thread-equality would leave review work invisible — revisit on codex upgrades.
- **`turn/completed` status is a required field with vocabulary exactly `completed|interrupted|failed|inProgress`** at codex 0.146 (`thread_data.rs:246`); the absent-status fallback in decision #3 exists only for older/other protocol forms.

## File Structure

| File | Role in this plan |
|---|---|
| `crates/freshell-activity/src/codex.rs` | Tracker: thread guard, status guard, turn-id dedupe, unbound window, abort de-chime, `claim_turn_key_if_idle`, all pure unit tests (Tasks 1–2) |
| `crates/freshell-ws/src/activity.rs` | Hub: widened `HubEvent::CodexProxyTurn` + `note_codex_proxy_turn`, dispatch arm, hub-level tests (Tasks 2–3) |
| `crates/freshell-ws/src/codex_proxy_route.rs` | Router: stop discarding `TurnEventParams`, extract status via `freshell_codex::turn_status`, router-level test (Tasks 2–3) |
| `server/terminal-stream/registry-events.ts` | Node: widened `CodexTurnStartedEvent`/`CodexTurnCompletedEvent` (Task 4) |
| `server/terminal-registry.ts` | Node: emission site carries threadId/turnId/status; `codexTurnStatus` helper (Task 4) |
| `server/coding-cli/codex-activity-tracker.ts` | Node tracker: guards + `claimTurnKeyIfIdle` + reconcile abort de-chime (Tasks 5–6) |
| `test/unit/server/terminal-registry.codex-sidecar.test.ts` | Node: emission payload pin (Task 4) |
| `test/unit/server/coding-cli/codex-activity-tracker.test.ts` | Node: tracker behavior tests (Tasks 5–6) |
| `test/unit/server/coding-cli/codex-activity-wiring.test.ts` | Node: wiring fixtures updated to the new event shape (Task 5) |

`server/coding-cli/codex-activity-wiring.ts` needs NO code change (it is a 1:1 pass-through; the widened event flows through `(event: CodexTurnStartedEvent) => tracker.onTurnStarted(event)` untouched). `crates/freshell-codex` needs NO code change (`TurnEventParams` already carries `thread_id`/`turn_id`, and `status` is readable via the exported `freshell_codex::turn_status(&params)`; proven by `crates/freshell-codex/tests/remote_proxy_relay.rs:464-503`).

---

### Task 1: Rust rollout lane — `turn_aborted` clears without recording a completion

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` (reconcile clear branch ~`:311-385`; helpers `transition_pending_after_turn_clear`/`transition_after_turn_clear` ~`:619-674`; `consume_turn_complete_signal` ~`:599-617`; test `reconcile_turn_aborted_also_clears_and_completes` ~`:1113-1125`)

**Interfaces:**
- Consumes: existing `record_completion_if_idle(state, turn_key, at, ledger, completions)`, `max_ts(a, b)`, `CodexTaskEvents`.
- Produces (Task 2 depends on these):
  - `fn claim_turn_key_if_idle(state: &mut TerminalActivity, turn_key: Option<i64>)`
  - `fn transition_pending_after_turn_clear(state: &mut TerminalActivity, at: i64, ledger: &mut TurnCompletionLedger, completions: &mut Vec<(Option<String>, i64, i64)>, record: bool)`
  - `fn transition_after_turn_clear(state: &mut TerminalActivity, at: i64, ledger: &mut TurnCompletionLedger, completions: &mut Vec<(Option<String>, i64, i64)>, record: bool)`

- [ ] **Step 1: Rewrite the pinned abort test and add the tie-break test (RED)**

In `crates/freshell-activity/src/codex.rs`, REPLACE the test `reconcile_turn_aborted_also_clears_and_completes` (currently at ~`:1113-1125`) with:

```rust
    #[test]
    fn reconcile_turn_aborted_clears_without_completing() {
        // SEMANTIC CHANGE (kata: codex-turn-thread-scope). This test replaces
        // `reconcile_turn_aborted_also_clears_and_completes`, which pinned the
        // old buggy behavior. shared/ws-protocol.ts:199-208 pins terminal.idle
        // as "never emitted after crash/interrupt/exit" -- an Esc-interrupt
        // (`turn_aborted`) must return the pane to idle WITHOUT recording a
        // bell-worthy completion.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-activity reconcile_turn_aborted -- --nocapture` and `cargo test -p freshell-activity reconcile_task_complete_at_or_after`
Expected: `reconcile_turn_aborted_clears_without_completing` FAILS (`completions` is `[1]` today); the tie-break test PASSES already (that is fine — it pins the tie rule against regressions in Step 3).

- [ ] **Step 3: Implement the abort de-chime**

3a. Add the claim helper immediately after `record_completion_if_idle` (~`:696`):

```rust
/// Abort-shaped clears (`turn_aborted` in the rollout lane; status
/// `interrupted`/`failed` on the proxy lane, Task 2): claim the turn key
/// exactly like `record_completion_if_idle` does, but WITHOUT recording a
/// ledger completion -- the pane returns to idle silently
/// (shared/ws-protocol.ts:199-208: `terminal.idle` is never emitted after
/// crash/interrupt/exit) and a later echo of the same physical turn cannot
/// mint a completion.
fn claim_turn_key_if_idle(state: &mut TerminalActivity, turn_key: Option<i64>) {
    let Some(turn_key) = turn_key else { return };
    if state.phase != CodexPhase::Idle {
        return;
    }
    state.last_emitted_turn_key = Some(turn_key);
}
```

3b. Add a `record: bool` final parameter to BOTH transition helpers. The bodies stay identical except the last line:

```rust
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
```

Apply the same `record: bool` + `if record { record_completion_if_idle(...) } else { claim_turn_key_if_idle(state, turn_key); }` tail to `transition_after_turn_clear` (whose `turn_key` is `state.accepted_start_at`), leaving the rest of its body byte-identical.

3c. Update the two call sites in `consume_turn_complete_signal` (PTY BEL lane keeps recording) to pass `true`:

```rust
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
```

3d. In `reconcile_rollout`, immediately after the existing `observed_clear` computation (`:311-314`), add the abort classifier:

```rust
        let observed_clear = max_ts(
            events.latest_task_completed_at,
            events.latest_turn_aborted_at,
        );
        // The newest terminating event decides the clear's shape: an abort
        // (Esc-interrupt / `turn_aborted`) still ends the turn but must not
        // ring (shared/ws-protocol.ts:199-208 -- terminal.idle is "never
        // emitted after crash/interrupt/exit"). Ties go to task_complete: a
        // real completion at the same instant still rings.
        let clear_is_abort = match (
            events.latest_task_completed_at,
            events.latest_turn_aborted_at,
        ) {
            (Some(completed), Some(aborted)) => aborted > completed,
            (None, Some(_)) => true,
            _ => false,
        };
```

3e. In the reconcile clear branch (`:341-371`), pass the flag to both transitions — `transition_pending_after_turn_clear(state, at, &mut self.ledger, &mut completions, !clear_is_abort);` and `transition_after_turn_clear(state, at, &mut self.ledger, &mut completions, !clear_is_abort);`. The swallow-flag arming lines (`state.swallow_next_bel = true; state.swallow_next_proxy_complete = true;`) stay in place for BOTH shapes — the BEL/proxy echoes of an aborted turn must be eaten too.

3f. There is one more caller pair of the transition helpers in `note_proxy_turn_completed` (`:546-579`): pass `true` there for now (Task 2 replaces it with the status-derived flag):
`transition_pending_after_turn_clear(state, at, &mut self.ledger, &mut completions, true);`

- [ ] **Step 4: Run the crate tests to verify green**

Run: `cargo test -p freshell-activity`
Expected: ALL tests pass, including the two from Step 1 and the untouched swallow/proxy/BEL tests.

- [ ] **Step 5: Format and commit**

```bash
cargo fmt -p freshell-activity
git add crates/freshell-activity/src/codex.rs
git commit -m "fix(activity): rollout turn_aborted clears codex phase without recording a completion"
```

---

### Task 2: Rust proxy lane — plumb thread/turn/status end-to-end and guard in the tracker

This is the core fix (spec items A, B, C-proxy, D). The tracker signature change and the hub/router plumbing MUST land in one commit or the workspace will not compile.

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` (`TerminalActivity` ~`:109-163`, `track_terminal` initializer + rebind branch ~`:225-247`, `bind_session` ~`:278-289`, `note_proxy_turn_started` ~`:523-541`, `note_proxy_turn_completed` ~`:546-579`, tests ~`:1393-1531`)
- Modify: `crates/freshell-ws/src/activity.rs` (`HubEvent::CodexProxyTurn` ~`:136-140`, `note_codex_proxy_turn` ~`:269-276`, dispatch arm ~`:509-525`, test `proxy_turn_events_reach_the_codex_tracker_and_emit_turn_complete` ~`:2499-2571`)
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (turn arms ~`:57-66`)

**Interfaces:**
- Consumes (from Task 1): `transition_pending_after_turn_clear(..., record: bool)`, `claim_turn_key_if_idle(state, turn_key)`.
- Consumes (existing, unchanged): `freshell_codex::remote_proxy::TurnEventParams { thread_id: String, turn_id: Option<String>, params: Map<String, Value> }`; `freshell_codex::turn_status(&Map<String, Value>) -> Option<String>` (re-exported at `crates/freshell-codex/src/lib.rs:77`; implements `params.turn?.status ?? params.status`).
- Produces (Task 3 depends on these exact signatures):
  - `CodexActivityTracker::note_proxy_turn_started(&mut self, terminal_id: &str, thread_id: &str, turn_id: Option<&str>, at: i64) -> Vec<CodexEffect>`
  - `CodexActivityTracker::note_proxy_turn_completed(&mut self, terminal_id: &str, thread_id: &str, turn_id: Option<&str>, status: Option<&str>, at: i64) -> Vec<CodexEffect>`
  - `ActivityHub::note_codex_proxy_turn(&self, terminal_id: &str, thread_id: &str, turn_id: Option<&str>, status: Option<&str>, completed: bool)`

- [ ] **Step 1: Write the failing tracker tests**

Append to the `mod tests` block in `crates/freshell-activity/src/codex.rs`:

```rust
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
        assert!(child.is_empty(), "foreign-thread completion must be a no-op");
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
        let effects =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("interrupted"), 2_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn failed_status_clears_busy_without_completion() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("failed"), 2_000);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert!(completions(&effects).is_empty());
    }

    #[test]
    fn in_progress_status_is_a_no_op() {
        // protocol.rs:111 -- turn/completed fires for ALL statuses;
        // `inProgress` is not a turn end and must not clear busy.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", Some("turn-1"), 1_000);
        let effects =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("inProgress"), 2_000);
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
        let stale =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("completed"), 2_100);
        assert!(stale.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
        // turn-2's real completion still rings.
        let real =
            tracker.note_proxy_turn_completed("t", "sess", Some("turn-2"), Some("completed"), 3_000);
        assert_eq!(completions(&real), vec![1]);
    }

    #[test]
    fn completion_without_turn_ids_falls_back_to_phase_semantics() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t", Some("sess"), 0);
        tracker.note_proxy_turn_started("t", "sess", None, 1_000);
        let effects = tracker.note_proxy_turn_completed("t", "sess", None, Some("completed"), 2_000);
        assert_eq!(completions(&effects), vec![1]);
    }
```

- [ ] **Step 2: Mechanically update the existing proxy-turn test call sites**

The signature change breaks 13 in-crate test call sites. All existing tests bind `"sess"` at `track_terminal`, so pass `"sess"` as `thread_id`. Exact substitutions (old → new), preserving each test's semantics:

| test (line) | old call | new call |
|---|---|---|
| `proxy_turn_started_promotes_idle_to_busy` (:1397) | `note_proxy_turn_started("t", 2_000)` | `note_proxy_turn_started("t", "sess", Some("turn-1"), 2_000)` |
| `proxy_turn_completes_exactly_once_per_turn` (:1411, :1412, :1421) | `note_proxy_turn_started("t", 2_000)` / `note_proxy_turn_completed("t", 3_000)` / `note_proxy_turn_completed("t", 3_001)` | `note_proxy_turn_started("t", "sess", Some("turn-1"), 2_000)` / `note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("completed"), 3_000)` / `note_proxy_turn_completed("t", "sess", Some("turn-1"), Some("completed"), 3_001)` |
| `proxy_clear_swallows_the_late_pty_bel_echo` (:1434) | `note_proxy_turn_completed("t", 3_000)` | `note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_000)` |
| `reconcile_clear_swallows_the_late_proxy_echo` (:1460) | `note_proxy_turn_completed("t", 3_050)` | `note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_050)` |
| `fresh_submit_disarms_all_swallow_flags` (:1471, :1474) | `note_proxy_turn_completed("t", 3_000)` / `note_proxy_turn_completed("t", 5_000)` | `note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_000)` / `note_proxy_turn_completed("t", "sess", None, Some("completed"), 5_000)` |
| `proxy_start_disarms_a_stale_proxy_swallow` (:1493, :1494) | `note_proxy_turn_started("t", 4_000)` / `note_proxy_turn_completed("t", 5_000)` | `note_proxy_turn_started("t", "sess", Some("turn-2"), 4_000)` / `note_proxy_turn_completed("t", "sess", Some("turn-2"), Some("completed"), 5_000)` |
| `bel_clear_swallows_the_late_proxy_echo` (:1527) | `note_proxy_turn_completed("t", 3_050)` | `note_proxy_turn_completed("t", "sess", None, Some("completed"), 3_050)` |

Where the original scenario had no proxy `turn/started` (the swallow tests drive PTY/reconcile lanes), pass `turn_id = None` so the turn-id guard falls through — that preserves the exact cross-lane semantics each test pins.

- [ ] **Step 3: Run to verify RED**

Run: `cargo test -p freshell-activity`
Expected: FAILS to compile — `note_proxy_turn_started`/`note_proxy_turn_completed` take 2/2 extra arguments the implementation doesn't have yet. (A compile failure is this step's red.)

- [ ] **Step 4: Implement the tracker changes**

4a. Add the in-flight turn-id field to `TerminalActivity` (after `last_proxy_started_at: Option<i64>,` ~`:145`):

```rust
    /// Proxy lane (kata codex-turn-thread-scope): the turn id of the bound
    /// thread's in-flight proxy turn, set on TurnStarted. A TurnCompleted
    /// carrying a DIFFERENT turn id is a stale echo of an already-closed
    /// turn and is a no-op by construction. `None` falls back to phase
    /// semantics (older protocols omit turnId).
    current_proxy_turn_id: Option<String>,
```

and initialize it in `track_terminal`'s struct literal (next to `last_proxy_started_at: None,`): `current_proxy_turn_id: None,`.

4b. Replace `note_proxy_turn_started` with:

```rust
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
```

4c. Replace `note_proxy_turn_completed` with:

```rust
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
    /// 5. status -- only `completed` (or absent: older protocols) records a
    ///    bell-worthy completion; `interrupted`/`failed` clear silently.
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
        if let (Some(current), Some(completed)) =
            (state.current_proxy_turn_id.as_deref(), turn_id)
        {
            if current != completed {
                return Vec::new();
            }
        }
        if state.swallow_next_proxy_complete {
            state.swallow_next_proxy_complete = false;
            return Vec::new();
        }
        let record = matches!(status, None | Some("completed"));
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
            CodexPhase::Idle => {}
        }
        self.effects_after_transition(terminal_id, previous, completions)
    }
```

(Note: this replaces Task 1 Step 3f's temporary `true` with the status-derived `record`.)

4d. Clear the in-flight proxy-turn state on rebind (design decision #7 — ledger A9). In `bind_session` (~`:278-289`), after the same-id no-op check, alongside the `state.session_id = Some(...)` assignment, add:

```rust
        // Design decision #7 (kata codex-turn-thread-scope): a rebind moves
        // the pane to a DIFFERENT thread (fork/resume, delivered by the async
        // disk fork-watch lane -- codex_proxy_route.rs:88-91). The old
        // thread's in-flight turn id and start anchor must not survive, or
        // the new thread's first turn/completed is misclassified as a stale
        // echo / collides on last_emitted_turn_key.
        state.current_proxy_turn_id = None;
        state.last_proxy_started_at = None;
```

and add the same two lines in `track_terminal`'s rebind branch (~`:232-241`), next to its `existing.session_id = Some(...)` assignment (guarded by the same "id actually changed" condition that branch already establishes).

- [ ] **Step 5: Run freshell-activity, expect the crate green but the workspace still red**

Run: `cargo test -p freshell-activity`
Expected: PASS (all new + all updated tests).
Run: `cargo test -p freshell-ws --no-run`
Expected: COMPILE FAILURE at `crates/freshell-ws/src/activity.rs:517-519` (hub calls the old tracker signature) — proceed to Step 6.

- [ ] **Step 6: Widen the hub event and API (`crates/freshell-ws/src/activity.rs`)**

6a. Replace the `HubEvent::CodexProxyTurn` variant (~`:136-140`):

```rust
    /// S5.a + kata codex-turn-thread-scope: a proxy TurnStarted/TurnCompleted
    /// for a managed codex terminal, carrying the EMITTING thread's identity
    /// (which may be a sub-agent/review/fork thread, not the bound one) and,
    /// for completions, the raw turn status. The tracker owns the guards.
    CodexProxyTurn {
        terminal_id: String,
        thread_id: String,
        turn_id: Option<String>,
        status: Option<String>,
        completed: bool,
    },
```

6b. Replace `note_codex_proxy_turn` (~`:269-276`):

```rust
    /// S5.a: proxy (managed-launch) turn lane -- channel-deferred like
    /// `bind_codex_session` so all frame emission stays on the hub task.
    /// `status` is only meaningful for completions (`turn/completed` carries
    /// 'completed' | 'interrupted' | 'failed' | 'inProgress'); pass `None`
    /// for starts.
    pub fn note_codex_proxy_turn(
        &self,
        terminal_id: &str,
        thread_id: &str,
        turn_id: Option<&str>,
        status: Option<&str>,
        completed: bool,
    ) {
        let _ = self.tx.send(HubEvent::CodexProxyTurn {
            terminal_id: terminal_id.to_string(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            status: status.map(str::to_string),
            completed,
        });
    }
```

6c. Replace the dispatch arm in `handle_event` (~`:509-525`):

```rust
            HubEvent::CodexProxyTurn {
                terminal_id,
                thread_id,
                turn_id,
                status,
                completed,
            } => {
                let at = now_ms();
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = if completed {
                        inner.codex.note_proxy_turn_completed(
                            &terminal_id,
                            &thread_id,
                            turn_id.as_deref(),
                            status.as_deref(),
                            at,
                        )
                    } else {
                        inner.codex.note_proxy_turn_started(
                            &terminal_id,
                            &thread_id,
                            turn_id.as_deref(),
                            at,
                        )
                    };
                    let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                    frames
                };
                self.emit(frames);
            }
```

6d. Update the existing hub test `proxy_turn_events_reach_the_codex_tracker_and_emit_turn_complete` (~`:2499-2571`). Two edits: bind the thread at create, and pass identity on the calls. Replace the Created event and the three call lines:

```rust
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t".into(),
                mode: "codex".into(),
                // kata codex-turn-thread-scope: the proxy lane is thread-
                // scoped, so this test binds the thread at create (the
                // resume path); unbound terminals now ignore proxy turns.
                resume_session_id: Some("thread-1".into()),
                at: crate::terminal::now_ms(),
            },
        );
```

```rust
        // Exercise: proxy turn lane.
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), None, false); // started
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), Some("completed"), true); // completed
        hub.note_codex_proxy_turn("t", "thread-1", Some("turn-1"), Some("completed"), true); // duplicate echo — must not double
```

(Leave the frame assertions untouched; also update the comment `// Initial idle upsert (no sessionId -- the G3 gap state).` to `// Initial idle upsert (session bound at create).`)

- [ ] **Step 7: Update the router (`crates/freshell-ws/src/codex_proxy_route.rs`)**

Replace the two turn arms (~`:57-66`):

```rust
        RemoteProxyEvent::TurnStarted(params) => {
            if let Some(hub) = &state.activity {
                hub.note_codex_proxy_turn(
                    &terminal_id,
                    &params.thread_id,
                    params.turn_id.as_deref(),
                    None,
                    false,
                );
            }
        }
        RemoteProxyEvent::TurnCompleted(params) => {
            if let Some(hub) = &state.activity {
                // `status` lives inside params -- nested `params.turn.status`
                // on the small-frame path, flat `params.status` on the
                // oversized byte-scan path. `turn_status` handles both
                // (protocol.rs:316-333).
                let status = freshell_codex::turn_status(&params.params);
                hub.note_codex_proxy_turn(
                    &terminal_id,
                    &params.thread_id,
                    params.turn_id.as_deref(),
                    status.as_deref(),
                    true,
                );
            }
        }
```

- [ ] **Step 8: Run both crates green**

Run: `cargo test -p freshell-activity && cargo test -p freshell-ws`
Expected: PASS (includes the freshell-ws `tests/` integration suites — `codex_locator_activity.rs` and `codex_fork_rebind.rs` assert `terminal.turn.complete` via the rollout/BEL lanes, which are unchanged for bound threads).

- [ ] **Step 9: Format and commit**

```bash
cargo fmt -p freshell-activity -p freshell-ws
git add crates/freshell-activity/src/codex.rs crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_proxy_route.rs
git commit -m "fix(activity): thread-scope, status-guard, and turn-id-dedupe the codex proxy turn lane"
```

---

### Task 3: Rust freshell-ws — behavioral seam tests (hub + router)

Pin the fix at the two seams above the tracker: the hub must not ring for a foreign thread, and the router must forward thread/turn and extract the NESTED `turn.status`.

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` (append one test to `mod tests`)
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (append helpers + one test to `mod tests`)

**Interfaces:**
- Consumes (from Task 2): `ActivityHub::note_codex_proxy_turn(&self, terminal_id, thread_id, turn_id, status, completed)`; router arms forwarding `TurnEventParams`.
- Consumes (existing test harness): `hub()`, `observer_send()`, `next_frame_matching()` in `activity.rs` tests (~`:1293-1334`); `test_state()`, `tagged()` in `codex_proxy_route.rs` tests (~`:183-295`).
- Produces: nothing new for later tasks (tests only).

- [ ] **Step 1: Write the failing hub test**

Append to `mod tests` in `crates/freshell-ws/src/activity.rs`:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn foreign_thread_proxy_completion_does_not_ring() {
        // Regression pin for spike scenario D at the hub seam: a sub-agent
        // child thread's turn/completed mid-parent-turn must not emit
        // terminal.turn.complete (and therefore can never arm the IdleGate).
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t".into(),
                mode: "codex".into(),
                resume_session_id: Some("thread-parent".into()),
                at: crate::terminal::now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t"
        })
        .await
        .expect("initial upsert");

        hub.note_codex_proxy_turn("t", "thread-parent", Some("turn-parent"), None, false);
        // Sub-agent child thread completes while the parent turn runs.
        hub.note_codex_proxy_turn("t", "thread-child", Some("turn-child"), Some("completed"), true);

        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a sub-agent thread completion must not ring"
        );

        // The parent's real completion still rings.
        hub.note_codex_proxy_turn("t", "thread-parent", Some("turn-parent"), Some("completed"), true);
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t"
        })
        .await
        .expect("parent turn complete");
        assert_eq!(complete["provider"], "codex");
        assert_eq!(complete["sessionId"], "thread-parent");
    }
```

- [ ] **Step 2: Write the failing router test**

Append to `mod tests` in `crates/freshell-ws/src/codex_proxy_route.rs` (after `tagged()`):

```rust
    /// kata codex-turn-thread-scope: a hub-bearing state for observing turn
    /// routing (test_state() deliberately sets `activity: None`), plus the
    /// hub's broadcast receiver.
    fn test_state_with_hub() -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let mut state = test_state();
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(256);
        state.activity = Some(crate::activity::ActivityHub::new(StdArc::new(tx), None));
        (state, rx)
    }

    /// A TurnEventParams whose status sits NESTED at `params.turn.status`
    /// exactly like the real app-server's small-frame form -- proves the
    /// router reads it via `freshell_codex::turn_status`, not a naive
    /// `params.get("status")`.
    fn turn_params(
        thread_id: &str,
        turn_id: &str,
        nested_status: Option<&str>,
    ) -> freshell_codex::remote_proxy::TurnEventParams {
        let mut params = serde_json::Map::new();
        params.insert(
            "threadId".to_string(),
            serde_json::Value::String(thread_id.to_string()),
        );
        params.insert(
            "turnId".to_string(),
            serde_json::Value::String(turn_id.to_string()),
        );
        if let Some(status) = nested_status {
            params.insert("turn".to_string(), serde_json::json!({ "status": status }));
        }
        freshell_codex::remote_proxy::TurnEventParams {
            thread_id: thread_id.to_string(),
            turn_id: Some(turn_id.to_string()),
            params,
        }
    }

    /// Local copy of the activity.rs test harness's frame matcher (that one
    /// is `#[cfg(test)]`-private to its module).
    async fn next_frame_matching(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        wanted: &str,
        timeout_ms: u64,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(frame)) => {
                    let value: serde_json::Value = serde_json::from_str(&frame).ok()?;
                    if value["type"] == wanted && pred(&value) {
                        return Some(value);
                    }
                }
                _ => return None,
            }
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn turn_events_forward_thread_turn_and_nested_status_to_the_hub() {
        let (state, mut rx) = test_state_with_hub();
        let hub = state.activity.clone().expect("hub");
        // Track + bind the terminal the way a resume-create does.
        (hub.registry_observer())(ActivityEvent::Created {
            terminal_id: "term-t".into(),
            mode: "codex".into(),
            resume_session_id: Some("thread-parent".into()),
            at: 1,
        });

        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnStarted(turn_params("thread-parent", "turn-1", None)),
            ),
        )
        .await;

        // Foreign sub-agent completion: must not ring. The bounded no-ring
        // check sits BETWEEN the foreign and bound completions -- without it,
        // a regressed thread guard would ring HERE and the trailing
        // "exactly one" tail could still pass (the bound completion would
        // then hit the Idle arm and no-op, leaving one frame total).
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-child",
                    "turn-c",
                    Some("completed"),
                )),
            ),
        )
        .await;
        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a foreign thread completion must not ring"
        );

        // NESTED-status pin: an `inProgress` completion for the BOUND thread
        // and the in-flight turn id must not ring. THIS event is what proves
        // the router extracts `params.turn.status` via
        // `freshell_codex::turn_status`: a router that forgets the extraction
        // (or reads a naive flat `params.get("status")`) forwards `None`,
        // which records a completion (design decision #3: absent status
        // records) and rings here. The tracker's `inProgress` guard returns
        // before touching state, so the pane stays Busy for the real
        // completion below.
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-parent",
                    "turn-1",
                    Some("inProgress"),
                )),
            ),
        )
        .await;
        let premature = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(
            premature.is_err(),
            "a nested inProgress status must be extracted and must not ring"
        );

        // Bound thread's real completion with NESTED turn.status: rings once.
        route_proxy_event(
            &state,
            tagged(
                "term-t",
                RemoteProxyEvent::TurnCompleted(turn_params(
                    "thread-parent",
                    "turn-1",
                    Some("completed"),
                )),
            ),
        )
        .await;

        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "term-t"
        })
        .await
        .expect("bound thread's completion rings");
        assert_eq!(complete["sessionId"], "thread-parent");

        // Exactly one -- the foreign and inProgress completions produced nothing.
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
                v["terminalId"] == "term-t"
            }),
        )
        .await;
        assert!(second.is_err(), "exactly one turn.complete expected");
    }
```

Import note: `ActivityEvent` must be imported in this test module — add `use freshell_terminal::registry::ActivityEvent;` to the `mod tests` imports (mirror the exact import path `crates/freshell-ws/src/activity.rs` uses for `ActivityEvent`; adjust if that file imports it via a re-export). `registry_observer()` is the same public hub method the activity.rs tests call.

- [ ] **Step 3: Run to verify the tests fail meaningfully first**

These tests are written AFTER the Task 2 implementation, so they should pass immediately — their red was Task 2's red. To honor red-green discipline, verify each asserts the fixed behavior by temporarily reverting the guards: run `git stash push crates/freshell-activity/src/codex.rs` ONLY if Task 2 is uncommitted — since Task 2 IS committed, instead verify by mutation. In `note_proxy_turn_completed`, temporarily comment out BOTH:

1. the thread-scope guard: `if state.session_id.as_deref() != Some(thread_id) { return Vec::new(); }`, AND
2. the turn-id dedupe guard directly below the `inProgress` check: `if let (Some(current), Some(completed)) = (state.current_proxy_turn_id.as_deref(), turn_id) { if current != completed { return Vec::new(); } }`

Both must be disabled because these tests drive the foreign completion with a DIFFERENT turn id (`turn-c` / `turn-child`) than the bound thread's in-flight one (`turn-1` / `turn-parent` from the preceding `turn/started`): with only the thread guard removed, the turn-id guard would still drop the foreign completion and mask the red (the tests would stay green for the wrong reason). Then run:

```bash
cargo test -p freshell-ws foreign_thread_proxy_completion_does_not_ring
cargo test -p freshell-ws turn_events_forward_thread_turn_and_nested_status
```

(Two separate invocations — `cargo test` accepts only ONE positional test-name filter; passing a second positional errors with `unexpected argument` before anything compiles or runs.)

Expected: both FAIL — each at its mid-test bounded no-ring check, because the unguarded foreign completion rings (the hub test at "a sub-agent thread completion must not ring", the router test at "a foreign thread completion must not ring"). Restore the guards (`git checkout -- crates/freshell-activity/src/codex.rs` restores the committed version if you edited in place).

Then run a SECOND directed mutation to prove the router test pins the NESTED `turn.status` extraction (the router-seam property no other test covers — the hub tests inject status directly into `note_codex_proxy_turn`, bypassing the router). With `codex.rs` restored, in `crates/freshell-ws/src/codex_proxy_route.rs`'s `RemoteProxyEvent::TurnCompleted` arm temporarily replace the Task 2 Step 7 line

```rust
                let status = freshell_codex::turn_status(&params.params);
```

with

```rust
                let status: Option<String> = None;
```

and run:

```bash
cargo test -p freshell-ws turn_events_forward_thread_turn_and_nested_status
```

Expected: FAIL at "a nested inProgress status must be extracted and must not ring" — the mutated router forwards `None`, absent status records (design decision #3), and the bound-thread `inProgress` completion rings prematurely. Restore with `git checkout -- crates/freshell-ws/src/codex_proxy_route.rs`.

- [ ] **Step 4: Run green**

Run: `cargo test -p freshell-ws`
Expected: PASS, including all pre-existing router tests (they use `test_state()` with `activity: None` and are untouched).

- [ ] **Step 5: Format and commit**

```bash
cargo fmt -p freshell-ws
git add crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_proxy_route.rs
git commit -m "test(ws): pin thread-scoped codex proxy routing at the hub and router seams"
```

---

### Task 4: Node — carry threadId/turnId/status on the codex turn registry events

**Files:**
- Modify: `server/terminal-stream/registry-events.ts:38-46`
- Modify: `server/terminal-registry.ts:1920-1943` (+ one module-level helper)
- Test: `test/unit/server/terminal-registry.codex-sidecar.test.ts:865-905`

**Interfaces:**
- Consumes (existing): the sidecar callback's `event: CodexTurnEvent = { threadId: string; turnId?: string; params: Record<string, unknown> }` (`server/coding-cli/codex-app-server/client.ts:112-116`). `params` is path-dependent: small frames keep the ORIGINAL nested params (status may sit at `params.turn.status`), oversized frames are flattened to `{ threadId, turnId?, status? }` — so status must be read as `params.turn?.status ?? params.status`.
- Produces (Task 5 depends on these exact types):

```ts
export type CodexTurnStartedEvent = {
  terminalId: string
  threadId: string
  turnId?: string
  at: number
}

export type CodexTurnCompletedEvent = {
  terminalId: string
  threadId: string
  turnId?: string
  status?: string
  at: number
}
```

- [ ] **Step 1: Update the emission-pin test (RED)**

In `test/unit/server/terminal-registry.codex-sidecar.test.ts`, in the test `emits Codex turn activity events before durability early returns` (~`:865-905`), replace the two `sidecar.emit*` lines and the `expect(turnEvents)` block with:

```ts
      sidecar.emitTurnStarted({ threadId: 'thread-durable', turnId: 'turn-1', params: {} })
      sidecar.emitTurnCompleted({
        threadId: 'thread-durable',
        turnId: 'turn-1',
        // Nested like the real app-server's small-frame form -- pins that the
        // registry reads params.turn?.status ?? params.status.
        params: { turn: { status: 'completed' } },
      })

      expect(turnEvents).toEqual([
        {
          type: 'started',
          event: { terminalId: term.terminalId, threadId: 'thread-durable', turnId: 'turn-1', at: 4_200 },
        },
        {
          type: 'completed',
          event: {
            terminalId: term.terminalId,
            threadId: 'thread-durable',
            turnId: 'turn-1',
            status: 'completed',
            at: 4_200,
          },
        },
      ])
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --run`
Expected: FAIL — actual events are still `{ terminalId, at }`.

- [ ] **Step 3: Widen the event types**

Replace `server/terminal-stream/registry-events.ts:38-46` with:

```ts
export type CodexTurnStartedEvent = {
  terminalId: string
  /**
   * The codex thread that emitted `turn/started` -- NOT necessarily the
   * terminal's bound thread: sub-agent, review, and fork threads share the
   * app-server connection (kata codex-turn-thread-scope, spike scenario D).
   * Consumers MUST scope by the terminal's bound session id.
   */
  threadId: string
  turnId?: string
  at: number
}

export type CodexTurnCompletedEvent = {
  terminalId: string
  /** See CodexTurnStartedEvent.threadId -- may be a foreign thread. */
  threadId: string
  turnId?: string
  /**
   * Raw turn status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
   * (absent on older protocol forms). Only 'completed' is a positive,
   * bell-worthy completion -- see shared/ws-protocol.ts terminal.idle.
   */
  status?: string
  at: number
}
```

- [ ] **Step 4: Emit the payload**

4a. Add a module-level helper in `server/terminal-registry.ts` (near the other module-level helpers/imports, outside the class):

```ts
/**
 * `params.turn?.status ?? params.status` -- the codex turn/completed status.
 * Mirror of `freshell_codex::protocol::turn_status` and adapter.ts:922-923;
 * handles both the small-frame nested form and the large-frame flattened form.
 */
function codexTurnStatus(params: Record<string, unknown>): string | undefined {
  const turn = params.turn
  if (turn && typeof turn === 'object') {
    const nested = (turn as Record<string, unknown>).status
    if (typeof nested === 'string') return nested
  }
  const status = params.status
  return typeof status === 'string' ? status : undefined
}
```

4b. Replace the two emits in `registerCodexSidecarLifecycle` (`server/terminal-registry.ts:1920-1943`):

```ts
    const turnStartedUnsubscribe = sidecar.onTurnStarted?.((event) => {
      if (!isCurrentSidecar()) return
      this.emit('codex.turn.started', {
        terminalId: record.terminalId,
        threadId: event.threadId,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        at: Date.now(),
      } satisfies CodexTurnStartedEvent)
      void this.handleCodexTurnStarted(record.terminalId, event).catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Failed to update Codex turn-start durability state')
      })
    })
    if (turnStartedUnsubscribe) unsubscribers.push(turnStartedUnsubscribe)

    const turnCompletedUnsubscribe = sidecar.onTurnCompleted?.((event) => {
      if (!isCurrentSidecar()) return
      const status = codexTurnStatus(event.params)
      this.emit('codex.turn.completed', {
        terminalId: record.terminalId,
        threadId: event.threadId,
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(status !== undefined ? { status } : {}),
        at: Date.now(),
      } satisfies CodexTurnCompletedEvent)
      void this.handleCodexTurnCompleted(record.terminalId, event).catch((err) => {
        logger.error({ err, terminalId: record.terminalId }, 'Failed to proof Codex rollout after turn completion')
      })
    })
    if (turnCompletedUnsubscribe) unsubscribers.push(turnCompletedUnsubscribe)
```

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/coding-cli/codex-activity-wiring.test.ts --run`
Expected: PASS (the wiring test still passes — its fake registry emits plain objects and the tracker does not read the new fields yet).

- [ ] **Step 6: Commit**

```bash
git add server/terminal-stream/registry-events.ts server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "feat(server): carry threadId/turnId/status on codex turn registry events"
```

---

### Task 5: Node tracker — thread scope, status guard, turn-id dedupe

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`CodexTerminalActivity` type `:32-49`; `onTurnStarted`/`onTurnCompleted` `:238-263`; `transitionAfterTurnClear` `:372+`; `transitionPendingAfterTurnClear` `:412+`; new `claimTurnKeyIfIdle` next to `recordCompletionIfIdle` `:442+`)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Test: `test/unit/server/coding-cli/codex-activity-wiring.test.ts` (fixture update)
- Test: `test/unit/server/coding-cli/turn-completion-snapshots.test.ts` (fixture update only — pinned snapshot; deliberate, documented protocol decision; assertions unchanged)

**Interfaces:**
- Consumes (from Task 4): `CodexTurnStartedEvent`/`CodexTurnCompletedEvent` with `threadId`, `turnId?`, `status?`.
- Consumes (existing): `bindTerminal({ terminalId, sessionId, reason, session?, at })` — for codex, `state.sessionId` IS the bound thread id; a codex terminal enters `this.states` only at bind time, so the Node unbound window is inherently silent (parity with the Rust "unbound ⇒ ignore" decision).
- Produces (Task 6 depends on these):
  - `private transitionAfterTurnClear(state: CodexTerminalActivity, at: number, record = true): void`
  - `private transitionPendingAfterTurnClear(state: CodexTerminalActivity, at: number, record = true): void`
  - `private claimTurnKeyIfIdle(state: CodexTerminalActivity, turnKey: number | undefined): void`

- [ ] **Step 1: Write the failing tracker tests**

Append to `test/unit/server/coding-cli/codex-activity-tracker.test.ts` (uses the file's existing `createSession`/`createProjects` helpers):

```ts
describe('thread-scoped app-server turn events (kata codex-turn-thread-scope)', () => {
  it('ignores a sub-agent thread completion mid-parent-turn (spike scenario D)', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'thread-parent',
      reason: 'association',
      session: createSession('thread-parent'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'thread-parent', turnId: 'turn-parent', at: 1_100 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })

    // Sub-agent child thread completes while the parent turn is running.
    tracker.onTurnCompleted({
      terminalId: 'term-1',
      threadId: 'thread-child',
      turnId: 'turn-child',
      status: 'completed',
      at: 1_200,
    })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])

    // The parent's real completion still rings exactly once.
    tracker.onTurnCompleted({
      terminalId: 'term-1',
      threadId: 'thread-parent',
      turnId: 'turn-parent',
      status: 'completed',
      at: 1_300,
    })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([{ terminalId: 'term-1', sessionId: 'thread-parent', at: 1_300, completionSeq: 1 }])
  })

  it('ignores a foreign thread turn start', () => {
    const tracker = new CodexActivityTracker()
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'thread-parent',
      reason: 'association',
      session: createSession('thread-parent'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'thread-child', turnId: 'turn-c', at: 1_100 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
  })

  it('interrupted status clears busy without recording a completion', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'interrupted', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('failed status clears busy without recording a completion', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'failed', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('inProgress status is a strict no-op', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'inProgress', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])
  })

  it('absent status still records a completion (older protocol forms)', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_200 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })

  it('ignores a stale completion for a previous turn id', () => {
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', at: 1_100 })
    // Late echo for an OLDER turn while turn-2 runs: no-op by construction.
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', status: 'completed', at: 1_150 })
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'busy' })
    expect(completions).toEqual([])
    // turn-2's real completion still rings.
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-2', status: 'completed', at: 1_300 })
    expect(completions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Update the wiring test fixtures to the new event shape**

In `test/unit/server/coding-cli/codex-activity-wiring.test.ts`, the first test's two emits (`:49` and `:56`) become:

```ts
    registry.emit('codex.turn.started', { terminalId: 'term-1', threadId: 'session-1', turnId: 'turn-1', at: 1_100 })
```

```ts
    registry.emit('codex.turn.completed', {
      terminalId: 'term-1',
      threadId: 'session-1',
      turnId: 'turn-1',
      status: 'completed',
      at: 1_200,
    })
```

(The bound `sessionId` in that test is `'session-1'`, so the events must carry `threadId: 'session-1'` to pass the new filter — the old bare `{ terminalId, at }` fixtures would now be dropped, which is exactly the semantic being pinned.)

Also update the PRE-EXISTING app-server-lane tracker tests to the new event shape. In `test/unit/server/coding-cli/codex-activity-tracker.test.ts`, the `describe('turn.complete emission (server-authoritative)')` block has exactly five `onTurnStarted`/`onTurnCompleted` call sites that pass bare `{ terminalId: 'term-1', at: ... }` (`:1026`, `:1035`, `:1051`, `:1052`, `:1069`). Every test in that block binds with `sessionId: 'session-1'`, so add `threadId: 'session-1'` to each of the five calls, e.g.:

```ts
    tracker.onTurnStarted({ terminalId: 'term-1', threadId: 'session-1', at: 1_100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', threadId: 'session-1', at: 1_200 })
```

(No `turnId` needed — it stays absent, and absent turn ids fall through the dedupe guard by design.) Without this update, Step 4's thread guard (`state.sessionId !== input.threadId`, i.e. `'session-1' !== undefined`) silently drops these events and three tests fail (`promotes busy from app-server turn started and clears from turn completed`, `does not double-emit when app-server completion is followed by BEL and JSONL completion`, `clears a pending submit from app-server completion even when turn started was missed`); and because Task 4 made `threadId: string` required on both event types, the bare calls are also TypeScript errors that would fail Task 7's `npm run check`.

Finally, update the pinned snapshot suite `test/unit/server/coding-cli/turn-completion-snapshots.test.ts` — its `CodexActivityTracker` block contains the ONLY other bare `{ terminalId, at }` turn-event call sites in the repo: six calls, four at `:65-68` (all `term-1`, bound via `tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', ... })` at `:64`) and two at `:71-72` (`term-2`, bound `sessionId: 'session-2'` at `:70`). Add `threadId: 'session-1'` to the four `term-1` calls and `threadId: 'session-2'` to the two `term-2` calls; change nothing else in the file. This file's header pins its ASSERTIONS ("must never change without an explicit protocol decision") — this edit IS that explicit protocol decision, so record it in place: add a comment above the updated calls citing this plan (kata codex-turn-thread-scope: app-server turn events now carry the bound thread's required `threadId`; only the event-construction INPUTS change to the new required shape). The pinned OUTPUTS are untouched and must still pass byte-identical: because each event now carries the `threadId` matching its terminal's bound session (and no `turnId`, which falls through the dedupe guard), Task 5's thread guard passes them through exactly as before — the three-completion `toEqual`, the `completionSeq` sequence `[1, 2, 1]`, and the pinned JSON string all remain valid. If any pinned assertion fails after this fixture update, STOP: that is an implementation bug in Task 5 — never re-pin the snapshot. Without this fixture update, Task 4's required `threadId: string` makes the six bare calls TypeScript errors (failing Task 7 Step 4's `npm run check`), and at runtime the thread guard would silently drop the events (the snapshot's 3 expected completions become 0).

- [ ] **Step 3: Run to verify RED**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/coding-cli/codex-activity-wiring.test.ts test/unit/server/coding-cli/turn-completion-snapshots.test.ts --run`
Expected: the new `describe` block FAILS (foreign completion currently flips to idle and records; interrupted currently records; stale turn id currently completes). The wiring test, the updated `turn.complete emission (server-authoritative)` tests, AND the updated snapshot suite still PASS (the tracker ignores the extra fields today) — their red would arrive with the Step 4 filter if the fixtures were wrong, so they pin the contract both ways.

- [ ] **Step 4: Implement the tracker guards**

4a. Add the in-flight turn id to `CodexTerminalActivity` (`server/coding-cli/codex-activity-tracker.ts:32-49`) — insert after `lastEmittedTurnKey?: number`:

```ts
  /**
   * kata codex-turn-thread-scope: the bound thread's in-flight app-server
   * turn id (set on turn/started). A turn/completed carrying a DIFFERENT
   * turn id is a stale echo of an already-closed turn -- no-op by
   * construction. Absent ids fall back to phase semantics.
   */
  currentTurnId?: string
```

(Also initialize nothing — `undefined` is the natural initial value; verify `bindTerminal`'s state literal compiles without it since the field is optional.)

4b. Replace `onTurnStarted`/`onTurnCompleted` (`:238-263`) with:

```ts
  onTurnStarted(input: CodexTurnStartedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    // Thread scope guard (kata codex-turn-thread-scope, spike scenario D):
    // the shared app-server connection relays turn events for EVERY thread
    // (sub-agents, review threads, forks). Only the bound thread's turns
    // drive this terminal. A codex terminal enters the tracker only at bind
    // time, so the unbound window is inherently silent (parity with the
    // Rust tracker's unbound => ignore).
    if (state.sessionId === undefined || state.sessionId !== input.threadId) return

    const previous = this.toRecord(state)
    state.currentTurnId = input.turnId
    state.lastSeenTaskStartedAt = maxDefined(state.lastSeenTaskStartedAt, input.at)
    this.promoteBusy(state, input.at, input.at)
    this.commitState(state, previous)
  }

  onTurnCompleted(input: CodexTurnCompletedEvent): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    // Guard order mirrors the Rust tracker (crates/freshell-activity/src/
    // codex.rs::note_proxy_turn_completed): thread scope -> inProgress ->
    // stale turn id -> status.
    if (state.sessionId === undefined || state.sessionId !== input.threadId) return
    // turn/completed fires for ALL statuses; inProgress is not a turn end.
    if (input.status === 'inProgress') return
    if (input.turnId !== undefined && state.currentTurnId !== undefined && input.turnId !== state.currentTurnId) {
      return
    }
    // Status guard: only 'completed' (or absent -- older protocol forms)
    // records a bell-worthy completion; interrupted/failed clear silently
    // (shared/ws-protocol.ts terminal.idle: never after crash/interrupt).
    const record = input.status === undefined || input.status === 'completed'

    const previous = this.toRecord(state)
    state.lastSeenTaskCompletedAt = maxDefined(state.lastSeenTaskCompletedAt, input.at)
    if (state.phase === 'pending' && state.pendingSubmitAt !== undefined) {
      this.transitionPendingAfterTurnClear(state, input.at, record)
    } else if (state.acceptedStartAt !== undefined) {
      this.transitionAfterTurnClear(state, input.at, record)
    } else if (state.latentAcceptedStartAt !== undefined) {
      this.transitionAfterLatentTurnClear(state, input.at)
    }
    this.commitState(state, previous)
    this.flushCompletions()
  }
```

4c. Add the optional `record` parameter to both transition helpers. `transitionAfterTurnClear` signature becomes `private transitionAfterTurnClear(state: CodexTerminalActivity, at: number, record = true): void` and its final line becomes:

```ts
    if (record) {
      this.recordCompletionIfIdle(state, turnKey, at)
    } else {
      this.claimTurnKeyIfIdle(state, turnKey)
    }
```

Apply exactly the same signature + tail change to `transitionPendingAfterTurnClear`. All other call sites (`consumeTurnCompleteSignal` at `:509-531`, `reconcileProjects`) compile unchanged thanks to the default `record = true`.

4d. Add the claim helper directly below `recordCompletionIfIdle`:

```ts
  /**
   * Abort-shaped clears (turn_aborted / status interrupted|failed): claim
   * the turn key exactly like recordCompletionIfIdle does, but WITHOUT
   * recording, so a later echo of the same physical turn (BEL, JSONL
   * reconcile, app-server duplicate -- all share this key space) cannot
   * mint a completion. shared/ws-protocol.ts terminal.idle: "Never emitted
   * after crash/interrupt/exit".
   */
  private claimTurnKeyIfIdle(state: CodexTerminalActivity, turnKey: number | undefined): void {
    if (turnKey === undefined) return
    if (state.phase !== 'idle') return
    state.lastEmittedTurnKey = turnKey
  }
```

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/coding-cli/codex-activity-wiring.test.ts --run`
Expected: PASS (all new tests + all pre-existing tracker tests — the `turn.complete emission (server-authoritative)` suite now carries `threadId: 'session-1'` per Step 2 so it satisfies the thread guard, and the remaining BEL/reconcile/pending suites drive `noteInput`/`noteOutput`/`reconcileProjects`, which the app-server-lane guards do not touch).

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-activity-tracker.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/unit/server/coding-cli/codex-activity-wiring.test.ts test/unit/server/coding-cli/turn-completion-snapshots.test.ts
git commit -m "fix(server): thread-scope and status-guard codex app-server turn events"
```

---

### Task 6: Node reconcile lane — `turn_aborted` clears without recording a completion

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`reconcileProjects` `:265-348`)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`

**Interfaces:**
- Consumes (from Task 5): `transitionAfterTurnClear(state, at, record)`, `transitionPendingAfterTurnClear(state, at, record)`, `claimTurnKeyIfIdle`.
- Produces: nothing new (behavior change + tests only).

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/server/coding-cli/codex-activity-tracker.test.ts`:

```ts
describe('reconcile turn_aborted de-chime (kata codex-turn-thread-scope)', () => {
  it('turn_aborted clears busy without recording a completion', () => {
    // SEMANTIC CHANGE: shared/ws-protocol.ts terminal.idle is "never emitted
    // after crash/interrupt/exit" -- an Esc-interrupt (turn_aborted in the
    // rollout JSONL) must return the pane to idle silently.
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTurnAbortedAt: 1_180,
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toEqual([])
  })

  it('a task_complete at or after an abort still records a completion', () => {
    // Tie-break: abort suppresses the chime only when STRICTLY newest.
    const tracker = new CodexActivityTracker()
    const completions: unknown[] = []
    tracker.on('turn.complete', (event) => completions.push(event))
    tracker.bindTerminal({
      terminalId: 'term-1',
      sessionId: 'session-1',
      reason: 'association',
      session: createSession('session-1'),
      at: 1_000,
    })
    tracker.noteInput({ terminalId: 'term-1', data: '\r', at: 1_100 })
    tracker.reconcileProjects(
      createProjects(createSession('session-1', { latestTaskStartedAt: 1_150 })),
      1_200,
    )
    tracker.reconcileProjects(
      createProjects(createSession('session-1', {
        latestTaskStartedAt: 1_150,
        latestTaskCompletedAt: 1_180,
        latestTurnAbortedAt: 1_180,
      })),
      1_300,
    )
    expect(tracker.getActivity('term-1')).toMatchObject({ phase: 'idle' })
    expect(completions).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts --run`
Expected: the first new test FAILS (an abort-only clear records a completion today); the tie-break test passes already (pins the rule).

- [ ] **Step 3: Implement**

In `reconcileProjects` (`server/coding-cli/codex-activity-tracker.ts:265-348`), directly after `const clearedAt = maxDefined(nextCompletedAt, nextTurnAbortedAt)` add:

```ts
      // The newest terminating event decides the clear's shape: an abort
      // (Esc-interrupt / turn_aborted) still ends the turn but must not ring
      // (shared/ws-protocol.ts terminal.idle: "never emitted after
      // crash/interrupt/exit"). Ties go to task_complete: a real completion
      // at the same instant still rings. Mirror of the Rust tracker's
      // clear_is_abort (crates/freshell-activity/src/codex.rs).
      const clearIsAbort = nextTurnAbortedAt !== undefined
        && (nextCompletedAt === undefined || nextTurnAbortedAt > nextCompletedAt)
```

Then change the two recording transition calls in the same function:
- `this.transitionPendingAfterTurnClear(state, at)` → `this.transitionPendingAfterTurnClear(state, at, !clearIsAbort)`
- `this.transitionAfterTurnClear(state, at)` → `this.transitionAfterTurnClear(state, at, !clearIsAbort)`

(The two LATENT transitions — `transitionPendingAfterLatentTurnClear`, `transitionAfterLatentTurnClear` — never record completions and stay untouched.)

- [ ] **Step 4: Run to verify green (including the old abort phase-pin test)**

Run: `npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts --run`
Expected: PASS. The pre-existing `clears busy from turn_aborted when BEL is missed` test (`:885-913`) still passes — it pins phase/timestamps only, and the phase-clearing half of abort behavior is unchanged.

- [ ] **Step 5: Verify the ws-protocol doc comment needs no edit, then commit**

Read `shared/ws-protocol.ts:199-215` and confirm the `terminal.idle` comment ("Never emitted after crash/interrupt/exit; subagent completions inside a running turn never produce it") now DESCRIBES reality rather than contradicting it — no edit required, no schema touched.

```bash
git add server/coding-cli/codex-activity-tracker.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts
git commit -m "fix(server): reconcile turn_aborted clears codex phase without recording a completion"
```

---

### Task 7: Full verification sweep

No new behavior — prove the whole change set against the repo's targeted and integration suites, honoring AGENTS.md test coordination.

**Files:**
- Possibly modify (only if a pinned suite requires a deliberate semantic update): `test/server/ws-codex-turn-complete.test.ts`, `test/server/codex-activity-exact-subset.test.ts`

**Interfaces:**
- Consumes: everything above. Produces: a green verification record in the commit message.

- [ ] **Step 1: Rust — full targeted crates**

Run: `cargo test -p freshell-activity -p freshell-ws -p freshell-codex`
Expected: PASS. (`freshell-codex` is untouched but is in the spec's targeted set — its `remote_proxy_relay.rs` proves the event payload the router now consumes.)

- [ ] **Step 2: Rust — format + lints**

Run: `cargo fmt --all -- --check` and `cargo clippy -p freshell-activity -p freshell-ws -- -D warnings`
Expected: clean. Fix anything surfaced (refactor step of TDD), re-run Step 1.

- [ ] **Step 3: Node — targeted unit + integration suites**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts \
  test/unit/server/coding-cli/codex-activity-tracker.test.ts \
  test/unit/server/coding-cli/codex-activity-wiring.test.ts \
  test/unit/server/coding-cli/turn-completion-snapshots.test.ts \
  test/unit/server/terminal-registry.codex-sidecar.test.ts \
  test/unit/server/coding-cli/codex-app-server/json-rpc-side-effects.test.ts \
  test/server/codex-activity-exact-subset.test.ts \
  test/server/ws-codex-turn-complete.test.ts --run
```

Expected: PASS. Failure protocol (be honest, never paper over):
- `ws-codex-turn-complete.test.ts` / `codex-activity-exact-subset.test.ts` drive real registry + wiring: if a fixture emits app-server turn events without a matching bound `threadId`, that is the OLD contract — update the fixture to bind a session and carry the matching `threadId` (deliberate, with a comment citing this plan), never weaken the guard.
- `t2-codex-equivalence-rust.test.ts` is deliberately NOT in this command (load-bearing ledger A12/A14): it is silently DESELECTED under `vitest.server.config.ts` (that config's include excludes `test/unit/port/**`), and under its own `config/vitest/vitest.oracle.config.ts` it is `describe.skip` unless `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS` is set — which drives a real live codex call, off-limits for this plan. Validation proved the oracle harness is a pure WS client on the fresh-agent lane (`port/oracle/harness/t2-live-codex.ts:628-716`) that never touches the terminal-activity surfaces this plan changes, so skipping it forfeits no coverage. Do NOT add it back expecting it to run.

- [ ] **Step 4: Broad repo check (coordinated)**

Run: `npm run check`
This is a broad run — it goes through the shared test-coordinator gate; WAIT for the gate if another run holds it (never kill foreign holders). Expected: PASS (typecheck + suite). The contract freeze test inside the suite must pass untouched — this plan changed no wire schema.

- [ ] **Step 5: Commit any deliberate test updates from Step 3**

```bash
git add -A
git status --short   # review: ONLY test files expected here; nothing else
git commit -m "test: align codex turn integration fixtures with thread-scoped semantics" # only if there are staged changes
```

---

## Spec coverage map (self-review record)

| Spec item | Covered by |
|---|---|
| A. Plumb thread_id/turn_id/status through proxy path (router stops discarding; hub API widened) | Task 2 Steps 6–7; pinned by Task 3 router test |
| B. Thread-scope proxy lane in tracker; bound-thread guard; documented unbound-window behavior | Task 2 Steps 1+4 (`unbound_terminal_ignores_proxy_turn_events`, thread-guard tests); decision §"Design decisions" #2 |
| C. Status-guard completions (proxy lane) — interrupted/failed clear w/o completion | Task 2 (status tests + `record` flag) |
| C. Rollout lane: `turn_aborted` clears w/o completion; pinned test rewritten deliberately; matches ws-protocol.ts:200-203 | Task 1 (Rust), Task 6 (Node) |
| D. turn_id matching makes duplicate/stale completions no-ops; swallow flags kept for BEL/reconcile echoes; BEL-only unmanaged path not regressed | Task 2 (`stale_completion_...`, `current_proxy_turn_id`; swallow tests kept green with `turn_id = None`; rebind reset per decision #7, Step 4d + `rebind_clears_stale_in_flight_proxy_turn_state`), Task 5 (`currentTurnId`; Node rebind is naturally safe — fresh state literal) |
| E. IdleGate 2s grace untouched | Global Constraints (no idle.rs / truly-idle-emitter.ts edits anywhere in the plan) |
| F. Node parity: registry event carries threadId/turnId/status; tracker filters by bound session id; status guard; `extractTurnCompletedStatus` path consumed via `codexTurnStatus`; reconcile abort de-chime; ws-protocol doc comments verified unchanged | Tasks 4, 5, 6 |
| G. No client changes; no wire shape changes | Global Constraints; Task 7 Step 4 contract freeze |
| Testing: sub-agent regression (scenario D), interrupted, aborted, unbound window, duplicate/turn-id, ws-layer plumbing tests, Node mirrors, deliberate updates of pinned tests, targeted suites + repo checks per AGENTS.md | Tasks 1–7 throughout |

**Production-outcome proof (no silent deferrals):** the user-facing outcome — "no green/bell while Codex still works; Esc-interrupt never rings; real completion still rings exactly once" — is proven without stubs at three levels: pure tracker state machines (Tasks 1–2, 5–6), the real hub/router seam emitting real `terminal.turn.complete` frames over a real broadcast channel (Task 3), and the existing end-to-end suites (`ws-codex-turn-complete.test.ts`, freshell-ws `tests/codex_locator_activity.rs`) re-run in Task 7. The `terminal.idle` bell edge itself is downstream of `TurnComplete`/`note_turn_boundary`, which Task 3 proves is no longer reachable by foreign threads; the IdleGate's own grace behavior is pre-existing, wire-pinned, and deliberately untouched (spec item E).

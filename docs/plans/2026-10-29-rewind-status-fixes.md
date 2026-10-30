# Rewind Status Honesty Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix four fresh-agent "code rewind" defects:
1. Remove the per-turn rewind status text from the transcript entirely. Rewind remains a hover action: enabled button when a snapshot exists, disabled with the reason when it does not.
2. Add the missing user-vs-agent gate so agent response turns are never even considered for rewind status.
3. Fix the first-message addressing drop — the checkpoint outcome frame is addressed to the stale placeholder session id, so the snapshot only binds after a reload; make it bind live.
4. Show an honest "still saving" state (or nothing) while the agent's turn is running.

### Explicit constraints
- Item 5 (MCP/CLI-sent messages never get code snapshots) is explicitly out of scope for this run; separate PR later.
- Red/green/refactor TDD with unit + e2e coverage for every behavior change.
- pnpm only; TypeScript relative imports need `.js` extensions (NodeNext/ESM). Rust changes keep cargo fmt + clippy clean.
- Do not merge, deploy, or restart the live production server (port 3001) as part of this run.

### Accepted tradeoffs and residuals
- The inline "Code rewind unavailable/available for this message" transcript note and its tests are deliberately removed as a user-approved behavior change; the hover action keeps enabled/disabled state plus the reason.
- MCP/CLI-driven turns stay honestly rewind-unavailable until separate REST-lane capture work (out of scope).

**Goal:** Every transcript turn shows rewind status only where it is real: agent turns show nothing, the in-flight user turn shows "still saving," settled user turns show enabled (or disabled-with-reason) rewind, and a freshopencode session's FIRST message binds its code checkpoint live — no reload needed.

**Architecture:** Three seams. (1) Client availability policy: `getRewindAvailability` gains the user-role gate and a busy-gated pending state, extracted as a pure decision helper; the transcript's inline status `<div>` is deleted, leaving the existing hover button / action-sheet surfaces (which already render enabled/disabled/reason/pending). (2) Server broadcast addressing: the identity-enriched outcome re-broadcast in `observe_turn_identity_with_match` fans out one frame per stored session alias (re-addressing `sessionId` like the REST replay path already does), so the pane holding the materialized durable id receives the frame the same moment it holds that id. (3) Contract pins: a client unit test drives the full first-message frame sequence end-to-end (placeholder send → materialize → durable-addressed enriched frame → hover enabled without reload), and a freshopencode e2e spec does the same against the fake-opencode harness.

**Tech Stack:** React 18 + TypeScript (Vite client), Vitest + Testing Library, Playwright (e2e, cloud backend), Rust (freshell-server CheckpointService, tokio broadcast), Zod wire schemas.

## Global Constraints

- Package manager: pnpm 10.34.5 exactly; never `npm ci`/`npm install` in this tree.
- TypeScript NodeNext/ESM: relative imports need `.js` extensions.
- Test lanes: focused Vitest via `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`; focused Rust via `cargo test -p freshell-server <filter>` (narrowed selectors are delegated — no coordinator gate); e2e on the cloud backend (`FRESHELL_E2E_BACKEND=cloud`), focused via `pnpm run test:e2e:cloud -- <spec path filter>` style; broad gates only via `scripts/base-gate.sh` with `GCLOUD_ROBOT_REQUIRE=1`.
- The wire frame `freshAgent.checkpoint.outcome` schema (Zod `FreshAgentCheckpointOutcomeSchema` in `shared/ws-protocol.ts:1897-1916`, Rust mirror in `crates/freshell-protocol/src/server_messages.rs:292-317`) must NOT change: the fix re-uses the existing `sessionId` field per-alias. `test/unit/port/ws-contract-freeze.test.ts` pins the type inventory.
- Identity contract (docs/development/managed-runtime.md:593-615): rewind availability binds only from persisted native row identities; the per-alias re-addressing changes WHERE the frame is addressed, not WHAT identity it claims. Do not pre-stamp predicted identities on capture-time frames.
- Hover surfaces already exist and must not be redesigned: enabled button `aria-label="Rewind code to here"`, disabled pending `aria-label="Saving code rewind checkpoint"` + `title="Saving the code state from before this message"`, disabled unavailable `aria-label="Rewind unavailable for this message"` + `title="Rewind unavailable: <reason>"` (FreshAgentTurnActions.tsx:153-170), sheet/menu labels `Rewind code to here` / `Saving code rewind checkpoint…` / `Rewind unavailable: <reason>` (:42-74).
- A11y: keep semantic buttons and their aria-labels; removing the `role="note"/"status"` div must not remove any interactive element.
- docs/index.html contains no rewind status text (verified) — no user-doc change needed for this run.
- Never restart/redeploy the production server on port 3001; no PR creation without explicit user approval.
- Base for this worktree: 5be2481fa684bf3f87cf39020dfd286ecaf7d76e (origin/main after PR #881).

---

### Task 1: Rewind availability is role-gated and pending-while-busy (defects 2 and 4)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` — extract the fallback policy as a pure exported helper directly below `isModernCheckpointTurn` (:381-390), and move `getRewindAvailability` from :1333-1342 down to just after `isBusy`/`sessionEnded` (:3973-3974), rewritten per Step 3 (the move avoids a temporal-dead-zone `ReferenceError` on `isBusy`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: `getCheckpointAvailability(turn): CheckpointTurnAvailability | undefined` (FreshAgentView.tsx:1311, unchanged), `isModernCheckpointTurn(turn)` (:381), `isBusy` (derived at :3973, `BUSY_STATES.has(effectiveStatus)`).
- Produces: `export function unboundRewindAvailability(turn: FreshAgentTurn, agentBusy: boolean): FreshAgentTurnRewindAvailability | undefined` — the pure fallback policy: non-user turns → `undefined`; modern user turns while the agent is busy → `{ status: 'pending' }`; modern user turns while idle → `{ status: 'unavailable', reason: MODERN_TURN_CHECKPOINT_UNAVAILABLE }`; non-modern turns → `undefined`. `getRewindAvailability` becomes: role/bound lookup first (unchanged), then `unboundRewindAvailability(turn, isBusy)`, with `isBusy` added to its `useCallback` deps.

- [ ] **Step 1: Write the failing behavioral tests**

In `FreshAgentView.test.tsx`, add one `describe('fresh-agent rewind availability honesty', ...)` with two tests, using the file's existing harness idioms (frame-driven `onMessage`, snapshot turns via the outcome/snapshot frames — see the test at :3492 for the accepted-turn flow and the `isBusyEvent` frame kinds `freshAgent.status` / `freshAgent.session.snapshot` at :3144 for driving busy):

Test A — `does not consider agent response turns for rewind status at all`:
1. Build the turn objects as the harness does; assert via the pure helper (imported from the module): `unboundRewindAvailability(assistantTurn, false)` and `unboundRewindAvailability(assistantTurn, true)` are both `undefined` — the role gate holds even while busy (agent turns never become "saving"). This import is part of the red: no such export exists today.
2. Render a fresh-agent pane (existing render helper) with an opencode-style snapshot: one assistant turn with `source: 'durable'` and a `nativeTurnId`, plus one user turn.
3. Assert the assistant article's hover toolbar has no rewind button at all — not `Rewind code to here`, not `Rewind unavailable for this message` (pins that the hover role gate in canRewind is not regressed). Do NOT assert on the transcript note here; Task 2 removes it.

Test B — `shows the honest still-saving state while the agent turn is running`:
1. Render the pane with a modern user snapshot turn (turnId `msg_…`, `source: 'durable'`) that has NO bound checkpoint outcome, and drive the pane busy with a `freshAgent.session.snapshot` frame carrying a busy status (idiom per :3144).
2. Hover the user turn's article; assert the rewind button is disabled with `aria-label="Saving code rewind checkpoint"` and `title="Saving the code state from before this message"`.
3. RED today: the button instead says `aria-label="Rewind unavailable for this message"` with `title` containing `No exact code checkpoint is available for this message.`

Also add Test C — `keeps a settled unbound modern turn unavailable when the agent is idle` asserting the idle case still shows the disabled `Rewind unavailable for this message` button (this is the existing pinned behavior at :4103; assert through the hover surface so it survives Task 2).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — Test A fails to import the nonexistent helper (or fails its expectation), Test B fails with the button showing "Rewind unavailable for this message" instead of "Saving code rewind checkpoint".

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentView.tsx`, directly below `isModernCheckpointTurn` (:381-390):

```ts
// The fallback for a modern turn with no bound checkpoint outcome. Agent
// response turns are never rewindable and never even considered (defect 2).
// While this pane's agent turn is still running, the capture/identity for
// the just-sent message is legitimately in flight, so the honest state is
// "still saving" (defect 4); the definitive unavailable verdict belongs to
// settled turns only. The state is computed, never stored: it dies at the
// busy→idle edge, so it can never wedge as an immortal "saving".
export function unboundRewindAvailability(
  turn: FreshAgentTurn,
  agentBusy: boolean,
): FreshAgentTurnRewindAvailability | undefined {
  if (turn.role !== 'user') return undefined
  if (!isModernCheckpointTurn(turn)) return undefined
  return agentBusy
    ? { status: 'pending' }
    : { status: 'unavailable', reason: MODERN_TURN_CHECKPOINT_UNAVAILABLE }
}
```

And REPLACE the `getRewindAvailability` definition by MOVING it from :1333-1342 down to immediately after `sessionEnded` (:3974), rewriting it as:

```ts
const getRewindAvailability = useCallback((turn: FreshAgentTurn): FreshAgentTurnRewindAvailability | undefined => {
  const availability = getCheckpointAvailability(turn)
  if (!availability) return unboundRewindAvailability(turn, isBusy)
  if (availability.status === 'unavailable') return { status: 'unavailable', reason: availability.reason }
  return { status: availability.status }
}, [getCheckpointAvailability, isBusy])
```

The move is required, not cosmetic: `isBusy` is declared at :3973, and its first mention inside a `useCallback` dependency array evaluated at :1333 would be a temporal-dead-zone `ReferenceError` at render time. Both consumers (:4861 JSX prop, :5013 dependency list) sit after :3973, and nothing between the current definition and `isBusy` references `getRewindAvailability` (verified by `rg -n 'getRewindAvailability' src/components/fresh-agent/FreshAgentView.tsx`), so the definition must simply live below its new dependency.

(Keep the `FreshAgentTurnRewindAvailability` import; the hover button, context-menu builder and action sheet consume the result unchanged.)

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (the whole file — including the pre-existing tests at :3492, :3706, :4103, :4622, which pin hover/notice/persistence behavior that the role gate and busy-pending must not disturb; :4103's idle-unavailable expectation must keep passing because that test's pane is idle).

- [ ] **Step 5: Refactor while green**

None beyond the extraction in Step 3 (the extraction IS the refactor — the policy is now pure and unit-testable; verify no other call site duplicates the old fallback logic by `rg -n 'isModernCheckpointTurn' src/`).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything consuming `getRewindAvailability` and the availability map — `FreshAgentView.test.tsx`, `FreshAgentTranscript.test.tsx`, `FreshAgentTurnActions.test.tsx` (hover/sheet rendering of pending/unavailable/assistant states).

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix(fresh-agent): role-gate rewind status and show still-saving while the turn runs"
```

---

### Task 2: Remove the per-turn rewind status text from the transcript (defect 1)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:921` (dead local) and `:1000-1021` (the note block)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx:2057`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (assertion blocks at :3492/:3603, :3706/:3807/:3860, :4103/:4146, :4155/:4206, :4622/:4671/:4691/:4744)
- Test: `test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts` (:120/:147 available-status asserts; :250/:300 unavailable-note asserts), `test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts` (:359/:378/:407 note+status asserts, :537 status, :574/:595 note asserts)

**Interfaces:**
- Consumes: Task 1's `getRewindAvailability` semantics (unchanged by this task).
- Produces: transcript articles no longer render any inline rewind status; `TurnActionProps.getRewindAvailability` plumbing (:803, :1127, :1175, :1291-1300, :1309-1324, :1521-1527) stays for the hover button, context menu and action sheet. The `FreshAgentTurnRewindAvailability` type import (:22-23) stays.

- [ ] **Step 1: Update the unit tests to the removed behavior (red)**

1. In `FreshAgentTranscript.test.tsx:2057` (`shows unavailable rewind state and disables the action on the affected turn`): delete the `getByRole('note', …)` assertion (:2071-2072); KEEP the disabled hover-button assertion (:2073) and the builder label `Rewind unavailable: <reason>` (:2075-2077); ADD `expect(screen.queryByRole('note')).toBeNull()` and `expect(screen.queryByRole('status', { name: /Code rewind available for this message/ })).toBeNull()` to pin absence.
2. In `FreshAgentView.test.tsx`: in each listed block, replace every `getByRole('note'|'status', …)` assertion on the per-turn rewind text with either a pin of absence (`queryByRole(...)` null) or — where the block was asserting an available/pending/unavailable STATE — an assertion of the hover button's state: enabled `getByRole('button', { name: 'Rewind code to here' })` not disabled; pending `disabled` button with `aria-label` `Saving code rewind checkpoint`; unavailable `disabled` button with `aria-label` `Rewind unavailable for this message`. Keep every send-frame shape, outcome fold, persistence, restore-by-id and reload-rebind assertion untouched.
3. In both e2e specs: replace the `getByRole('status'/'note', …)` transcript-text assertions with the corresponding hover assertions already used elsewhere in those specs (`.hover()` then `getByRole('button', { name: 'Rewind code to here' })` / `{ name: 'Rewind unavailable for this message' })` with disabled state; the reason remains visible via the button `title`).

- [ ] **Step 2: Run the unit tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — the new absence assertions fail because the note block still renders.

- [ ] **Step 3: Remove the note block**

In `FreshAgentTranscript.tsx`:
1. Delete the `rewindAvailability` local at :921 (`const rewindAvailability = live ? undefined : actions.getRewindAvailability?.(actionTurn)`).
2. Delete the rendering block at :1000-1021 (the `{rewindAvailability ? (<div role=…>…) : null}`).
3. Keep everything else, including the `actions` memo, `FreshAgentTurnActions`, the builder registration and the `FreshAgentTurnRewindAvailability` type import.

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check for now-dead exports/strings: `rg -n "MODERN_TURN_CHECKPOINT_UNAVAILABLE|Saving the code state from before this message\." src/` — the constant stays (Task 1 uses it; the hover title at FreshAgentTurnActions.tsx:137 and the rewind-click notices in FreshAgentView still use their own strings). Remove only the note's unique strings if nothing else references them (expected: none unique to the note).

- [ ] **Step 6: Run impacted-test verification (unit + e2e)**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

Run (cloud, focused — both edited specs plus the two checkpoint suites that keep hover journeys):
`FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts`

Expected: PASS (all tests in both specs, including the unchanged restore journeys).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts
git commit -m "fix(fresh-agent): remove the per-turn rewind status text; hover keeps state and reason"
```

---

### Task 3: Identity-enriched outcome frames are addressed to every session alias (defect 3, server)

**Files:**
- Modify: `crates/freshell-server/src/checkpoints.rs:2101-2111` (the re-broadcast loop in `observe_turn_identity_with_match`)
- Test: `crates/freshell-server/src/checkpoints.rs` (`#[cfg(test)] mod tests`, near :8101)

**Interfaces:**
- Consumes: `StoredCheckpointOutcome { outcome, request_ids, session_aliases, … }` (checkpoints.rs:196-209); `broadcast_outcome(outcome)` (:1720-1725); the REST replay's established alias-discipline (`replay_outcome_page` filters by `session_aliases` at :1623-1630 and re-addresses `outcome.session_id` to the requested id at :1694-1697).
- Produces: unchanged wire schema; the enriched re-broadcast emits one frame per `request_id × session_alias` with `outcome.session_id = alias` (bounded by the existing 16/16 request/alias caps).

- [ ] **Step 1: Write the failing Rust test**

Add to the `#[cfg(test)] mod tests` module, modeled on `checkpoint_identity_is_durable_for_each_provider_before_forwarding` (:8101) and `replayed_checkpoint_uses_the_requested_materialized_session_alias` (:7731):

```rust
#[tokio::test]
async fn identity_re_broadcast_is_addressed_to_every_session_alias() {
    // A freshopencode first message captures under the placeholder id, then
    // materializes the durable ses_* id (observe_materialized appends it to
    // session_aliases). The identity-enriched re-broadcast must reach a pane
    // holding EITHER id, exactly like the REST replay path does.
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (broadcast_tx, mut broadcast_rx) = tokio::sync::broadcast::channel(1024);
    let service = CheckpointService::new(home.path(), broadcast_tx.clone()).await.unwrap();
    // … build a `FreshAgentSend` for provider opencode / sessionType freshopencode
    // with session_id "freshopencode-req1", request_id "req1",
    // checkpoint_intent{ logical_attempt_id: "V1StGXR8_Z5jdHi6B-myT", workspace: <workspace as resolved-project> },
    // settings.cwd = workspace; drive barrier_and_forward to a settled Available capture …
    // … feed the freshAgent.session.materialized frame { previousSessionId: "freshopencode-req1", sessionId: "ses_durable", provider, sessionType } through the observer (persist_event_before_broadcast_with_match with require_match=true) …
    // … feed the checkpointTurnIdentity freshAgent.event frame { logicalAttemptId, requestId: "req1", sessionId: "ses_durable", nativeTurnId: "msg_55c25d96e4445f67b35ea116686e169c", displayTurnId: same } with require_match=true …
    let mut outcome_frames = Vec::new();
    while let Ok(frame) = broadcast_rx.try_recv() {
        let value: serde_json::Value = serde_json::from_str(&frame).unwrap();
        if value["type"] == "freshAgent.checkpoint.outcome" { outcome_frames.push(value) }
    }
    let session_ids: Vec<&str> = outcome_frames.iter()
        .filter(|f| f["requestId"] == "req1" && f["nativeTurnId"] == "msg_55c25d96e4445f67b35ea116686e169c")
        .map(|f| f["sessionId"].as_str().unwrap()).collect();
    assert!(session_ids.contains(&"freshopencode-req1"), "the still-placeholder pane keeps its frame: {session_ids:?}");
    assert!(session_ids.contains(&"ses_durable"), "the materialized pane binds live: {session_ids:?}");
    // No duplicate (request, session) pair.
    let mut pairs = session_ids.iter().map(|s| ("req1", *s)).collect::<Vec<_>>();
    pairs.sort();
    pairs.dedup();
    assert_eq!(pairs.len(), session_ids.len());
}
```

(Fill the frame construction in from the existing tests' helpers verbatim — :8101 builds the identity event, :7731 builds the materialized frame and the seeded barrier record; keep the exact field shapes those tests use.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server checkpoints::tests::identity_re_broadcast_is_addressed_to_every_session_alias`

Expected: FAIL — the drained frames contain only `sessionId == "freshopencode-req1"` (the capture-time id); the `"ses_durable"` assertion fails.

- [ ] **Step 3: Add the minimal production implementation**

Replace the re-broadcast loop at checkpoints.rs:2101-2111 (current shape: `if record.request_ids.is_empty() { broadcast_outcome(record.outcome.clone()) } else { per-request_id clone with request_id re-addressed }`) with:

```rust
for record in records {
    // Address the enriched frame to every id the session has lived under,
    // mirroring the REST replay's alias discipline (:1694-1697): a pane
    // re-keyed by materialization holds the durable id, while a pane that
    // has not processed the materialized frame yet still holds the
    // capture-time placeholder. The client's locator + pending gates make
    // the non-matching copies inert.
    if record.request_ids.is_empty() {
        for alias in &record.session_aliases {
            let mut outcome = record.outcome.clone();
            outcome.session_id = alias.clone();
            self.broadcast_outcome(outcome);
        }
    } else {
        for request_id in &record.request_ids {
            for alias in &record.session_aliases {
                let mut outcome = record.outcome.clone();
                outcome.request_id = request_id.clone();
                outcome.session_id = alias.clone();
                self.broadcast_outcome(outcome);
            }
        }
    }
}
```

(Preserve the original two-branch structure — request-less records broadcast once per alias, request-joined records once per request × alias pair; both bounds stay capped by the existing 16/16 request/alias limits on the stored record.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server checkpoints::tests::identity_re_broadcast_is_addressed_to_every_session_alias`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

`cargo fmt -p freshell-server && cargo clippy -p freshell-server --all-targets -- -D warnings` — keep clean. Simplify the loop if the empty-targets duplication can fold into one iterator product without hurting clarity.

- [ ] **Step 6: Run impacted-test verification**

The whole CheckpointService unit module is the impacted set (broadcast-addressing, alias, identity, replay and barrier-lifecycle tests interact with this loop):

Run: `cargo test -p freshell-server checkpoints`

Expected: PASS (includes `checkpoint_identity_is_durable_for_each_provider_before_forwarding`, `codex_checkpoint_identity_is_durable_before_its_event_is_forwarded`, `replayed_checkpoint_uses_the_requested_materialized_session_alias`, `cached_durable_outcome_page_survives_when_store_becomes_unreadable`, `accepted_logical_attempt_is_never_forwarded_again`).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/checkpoints.rs
git commit -m "fix(checkpoints): broadcast identity-enriched outcomes to every session alias"
```

---

### Task 4: Client contract pin — the first message binds live through materialization (defect 3, client)

**Files:**
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: Task 3's wire contract (enriched outcome frames may arrive addressed to the durable `ses_*` id); the pane frame handlers: `freshAgent.created` (:2886), `freshAgent.checkpoint.outcome` (:2987), `freshAgent.send.accepted` (:3021), `freshAgent.session.materialized` (:2934-2974); `locatorMatchesPane` (:786-825).
- Produces: a regression pin (green now, protects the whole chain): the full first-message sequence ends with the user turn's hover button enabled WITHOUT reload or remount.

- [ ] **Step 1: Write the pinning test**

Add to `FreshAgentView.test.tsx` (opencode pane, mirroring :3492's harness setup): `binds a freshopencode first message's checkpoint live when the enriched outcome arrives addressed to the materialized session`

1. Create the pane via `freshAgent.created` with placeholder `sessionId: 'freshopencode-req1'`.
2. Send the first composer message (fire the send path as :3492 does); capture the emitted `freshAgent.send` frame and assert its `sessionId` is the placeholder and its `checkpointIntent.logicalAttemptId` matches the client's pending metadata.
3. Feed frames in server order: the initial `freshAgent.checkpoint.outcome` (sessionId `freshopencode-req1`, status `available`, checkpointId, logicalAttemptId, requestId, NO native/display ids); `freshAgent.send.accepted` (same requestId, `submittedTurnId` absent — opencode); `freshAgent.session.materialized` (previousSessionId `freshopencode-req1`, sessionId `ses_durable`); a snapshot whose user turn row is `{ turnId: 'msg_55c25d96e4445f67b35ea116686e169c', role: 'user', source: 'durable' }` (the deterministic id for the known logical attempt id); then the identity-enriched `freshAgent.checkpoint.outcome` addressed to **`ses_durable`** with `nativeTurnId`/`displayTurnId` `msg_55c25d96e4445f67b35ea116686e169c`.
4. Assert the user turn's hover button is enabled `Rewind code to here` — with NO remount and no outcome-page refetch (stub the outcome-page fetch with an assertion that it was not re-armed mid-test, or simply do not wire it — follow the :3492 idiom for its fetch stubbing).
5. Assert the pane content's persisted `checkpointOutcomes` carries the outcome with the materialized `conversationSessionKey` (the :3673 idiom).

- [ ] **Step 2: Run the test and verify it passes as a pin**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (this pins existing client behavior + the Task 3 wire contract; it is a regression pin, not a red test — if it fails, the client gates reject the durable-addressed enriched frame and the failure must be investigated before proceeding).

- [ ] **Step 3: No production implementation**

None — this task is the client-side pin. If Step 2 unexpectedly fails, STOP and investigate: the client's pending/locator gates at :2987-3019/:786-825 must already accept the durable-addressed enriched frame for a pane with matching pending metadata.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "test(fresh-agent): pin live first-message checkpoint binding through materialization"
```

---

### Task 5: E2E — a freshopencode first message offers rewind live, without reload (defect 3, end to end)

**Files:**
- Test: `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts` (add one test reusing its fake-opencode harness: `installFakeOpencode`, `createSetupHome`, `createServerOptions`, `TestHarness`, `RustServer`)

**Interfaces:**
- Consumes: the fake `opencode` fixture (`test/e2e-browser/fixtures/fake-opencode.cjs`) — it validates and persists the server-provided `messageID` prompt ids (`msg_[0-9a-f]{32}`, fixture :123-124, :174-200), so the deterministic identity observation succeeds end to end; Task 3's per-alias broadcast; Task 2's hover-only surfaces.
- Produces: one spec proving the first composer message's rewind button is enabled right after its turn completes, with no page reload.

- [ ] **Step 1: Write the spec**

Add to `freshopencode-first-send-reload-repro.spec.ts` (same harness wiring as its existing test):

```ts
test('binds the first message\'s code checkpoint live, without a reload', async ({ page }) => {
  // … boot the Rust server + fake opencode harness exactly as the existing
  // test in the file does; open a fresh freshopencode pane (picker → opencode
  // mode with a Git workspace cwd so capture succeeds) …
  // … type the first composer message and submit …
  // … wait for the assistant turn to complete (existing wait idiom) …
  const userTurn = page.getByRole('article').filter({ hasText: '<the sent text>' }).first()
  await userTurn.hover()
  const rewind = userTurn.getByRole('button', { name: 'Rewind code to here' })
  await expect(rewind).toBeEnabled()      // NO page.reload() anywhere before this
})
```

(Fill in the exact harness bootstrap from the existing test in the file — same `RustServer`/`TestHarness` calls, same wait helpers. The sent text marker should be unique per run as that spec's existing test does.)

- [ ] **Step 2: Run the spec and verify the live-binding passes**

Run: `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: PASS for the new test (and the existing one). RED alternative: if Task 3 were not in place, the new test would fail with the button disabled (`Rewind unavailable for this message`) — run this spec BEFORE Task 3 lands only if you want to observe the red; Tasks are ordered so Task 3 has already landed when this runs.

- [ ] **Step 3: No production implementation**

None expected. If the spec fails, diagnose via the pane's checkpoint outcome frames (devtools WS or server JSONL logs under the Rust server harness output) before changing code — the failure is a contract break between Task 3's fan-out and the client gates, not a spec bug to be relaxed.

- [ ] **Step 4: Run the focused spec**

Run: `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None.

- [ ] **Step 6: Run impacted-test verification**

The freshopencode spec family plus the checkpoint suites touched by this branch:

Run: `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts
git commit -m "test(e2e): freshopencode first message binds rewind live without reload"
```

---

## Residuals (accepted)

- While an agent turn runs, other unbound user rows in the same pane (e.g. historical MCP/CLI-driven rows) also display the pending "still saving" hover state; it self-corrects at the busy→idle edge. Cosmetic, rare (tooltip-only), accepted.
- If identity observation fails server-side (`checkpoint_turn_identity_unobserved`), the row settles to the honest `unavailable: No exact code checkpoint…` at idle — per the managed-runtime identity contract, unchanged.
- MCP/CLI-sent messages remain without code checkpoints (out of scope; separate REST-lane capture work).

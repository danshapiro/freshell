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

**Goal:** Every transcript turn shows rewind status only where it is real: agent turns show nothing, an in-flight user turn whose capture/identity is still unbound shows "still saving" (a bound capture honestly shows available even mid-turn), settled user turns show enabled (or disabled-with-reason) rewind, and a freshopencode session's FIRST message binds its code checkpoint live — no reload needed.

**Architecture:** Three seams. (1) Client availability policy: `getRewindAvailability` gains the user-role gate and a busy-gated pending state, extracted as a pure decision helper; the transcript's inline status `<div>` is deleted, leaving the existing hover button / action-sheet surfaces (which already render enabled/disabled/reason/pending). (2) Server broadcast addressing: the identity-enriched outcome re-broadcast in `observe_turn_identity_with_match` fans out one frame per stored session alias (re-addressing `sessionId` like the REST replay path already does), so the pane holding the materialized durable id receives the frame the same moment it holds that id. (3) Contract pins: a client unit test drives the full first-message frame sequence end-to-end (placeholder send → materialize → durable-addressed enriched frame → hover enabled without reload), and a freshopencode e2e spec does the same against the fake-opencode harness.

**Tech Stack:** React 18 + TypeScript (Vite client), Vitest + Testing Library, Playwright (e2e, cloud backend), Rust (freshell-server CheckpointService, tokio broadcast), Zod wire schemas.

## Global Constraints

- Package manager: pnpm 10.34.5 exactly; never `npm ci`/`npm install` in this tree.
- TypeScript NodeNext/ESM: relative imports need `.js` extensions.
- Test lanes: focused Vitest via `pnpm run test:vitest run <paths> --config config/vitest/vitest.config.ts`; focused Rust via `cargo test -p freshell-server <filter>` (narrowed selectors are delegated — no coordinator gate); e2e runs per-spec on its legal lane (load-bearing finder LB4/LB5, reports/load-bearing-finder.md): cloud-legal specs via `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e <spec>`, `CLOUD_SKIP_SPECS` members (the whole freshopencode family) via `pnpm run test:e2e:local <spec>`, and the closed external-target spec (`code-checkpoint-workspace-external.spec.ts`) ONLY via `GCLOUD_ROBOT_REQUIRE=1 GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com pnpm exec tsx scripts/testing/managed-provider-environment-target.ts --checkpoint`, which additionally requires a committed clean worktree — run it after the owning task's commit step, never before; broad gates only via `scripts/base-gate.sh` with `GCLOUD_ROBOT_REQUIRE=1`.
- The wire frame `freshAgent.checkpoint.outcome` schema (Zod `FreshAgentCheckpointOutcomeSchema` in `shared/ws-protocol.ts:1897-1916`, Rust mirror in `crates/freshell-protocol/src/server_messages.rs:292-317`) must NOT change: the fix re-uses the existing `sessionId` field per-alias. `test/unit/port/ws-contract-freeze.test.ts` pins the type inventory.
- Identity contract (docs/development/managed-runtime.md:593-615): rewind availability binds only from persisted native row identities; the per-alias re-addressing changes WHERE the frame is addressed, not WHAT identity it claims. Do not pre-stamp predicted identities on capture-time frames.
- Hover surfaces already exist and must not be redesigned: enabled button `aria-label="Rewind code to here"`, disabled pending `aria-label="Saving code rewind checkpoint"` + `title="Saving the code state from before this message"`, disabled unavailable `aria-label="Rewind unavailable for this message"` + `title="Rewind unavailable: <reason>"` (FreshAgentTurnActions.tsx:153-170), sheet/menu labels `Rewind code to here` / `Saving code rewind checkpoint…` / `Rewind unavailable: <reason>` (:42-74).
- A11y: keep semantic buttons and their aria-labels; removing the `role="note"/"status"` div must not remove any interactive element.
- docs/index.html contains no rewind status text (verified) — no user-doc change needed for this run.
- Never restart/redeploy the production server on port 3001; no PR creation without explicit user approval.
- Base for this worktree: 5be2481fa684bf3f87cf39020dfd286ecaf7d76e (origin/main after PR #881).

---

### Task 1: Rewind availability is role-gated and pending-while-busy (defects 2 and 4)

> **Amended by review findings (round-3 delta review):** Task 1 as originally
> drafted specified a 3-arg `unboundRewindAvailability(turn, agentBusy,
> isNewestUserTurn)` whose busy-newest cell was a BLANKET pending — any busy
> newest modern user row claimed "Saving", including MCP/CLI-driven turns
> with no capture in play at all. That design was superseded during
> implementation (rounds E1R4/round-3, and the round-3 delta review): the
> SHIPPED helper is the 4-arg
> `unboundRewindAvailability(turn, agentBusy, isNewestUserTurn, captureInFlight)`
> — pending ONLY while this pane's own composer send has a checkpoint capture
> genuinely in flight; the uncertain mid-turn window (busy, newest, no
> evidencable capture) makes NO claim at all; and the newest-user-row
> derivation follows the transcript's DISPLAYED roles (the round-3 delta
> defect-1 fix). The body below describes the shipped semantics; the source
> of truth is `src/components/fresh-agent/FreshAgentView.tsx`
> (`unboundRewindAvailability`, `paneCaptureInFlight`, `newestUserTurnKey`,
> `getRewindAvailability`).

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` — extract the fallback policy as a pure exported helper directly below `isModernCheckpointTurn` (:381-390), and move `getRewindAvailability` from :1333-1342 down to just after `isBusy`/`sessionEnded` (:3973-3974), rewritten per Step 3 (the move avoids a temporal-dead-zone `ReferenceError` on `isBusy`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, plus a NEW focused policy file `test/unit/client/components/fresh-agent/rewind-availability-policy.test.tsx`

**Interfaces:**
- Consumes: `getCheckpointAvailability(turn): CheckpointTurnAvailability | undefined` (FreshAgentView.tsx:1311, unchanged), `isModernCheckpointTurn(turn)` (:381), `isBusy` (derived at :3973, `BUSY_STATES.has(effectiveStatus)`), and the pane's transcript turn order (to identify the newest user row).
- Produces (shipped): `export function unboundRewindAvailability(turn: FreshAgentTurn, agentBusy: boolean, isNewestUserTurn: boolean, captureInFlight: boolean): FreshAgentTurnRewindAvailability | undefined` — the pure fallback policy: non-user turns → `undefined`; non-modern turns → `undefined`; the NEWEST modern user row while the agent is busy AND a capture this pane can evidence is in flight → `{ status: 'pending' }`; the newest modern user row while busy but with NOTHING evidencable in flight (the uncertain window: an MCP/CLI-driven turn, a mid-turn reload with no send metadata, a capture that already settled) → `undefined` (no claim at all — the request's "(or nothing)" acceptance); every other modern user row (newest while idle; older rows at all times) → `{ status: 'unavailable', reason: MODERN_TURN_CHECKPOINT_UNAVAILABLE }`. `getRewindAvailability` (as shipped) is: role/bound lookup first (a BOUND availability always wins — a bound `available` capture stays available even mid-turn), then a dedicated ECHO branch for the pane's pending local echo row (a busy newest echo shows `pending`, a busy non-newest (uncertain) echo shows nothing, an idle echo shows the honest unavailable — reloaded echoes never fall to the legacy enabled path), then `unboundRewindAvailability(turn, isBusy, turnIsNewestUserRow, captureInFlight)`, with `isBusy`, `newestUserTurnKey`, `captureInFlight` and `localEchoTurn` in its `useCallback` deps. The `captureInFlight` input is derived per render by `paneCaptureInFlight(pendingSendMetadataRef.current, paneContent.checkpointOutcomes, busyEpochRef.current)` — true only while one of this pane's own sends has an `available` outcome whose identity observation is still pending (no nativeTurnId) AND whose dispatch busy window is still the pane's current busy epoch (the epoch advances at every turn-settling busy→idle edge, so a settled turn's lingering metadata never mislabels a later window). The newest-user-row key (`newestUserTurnKey`) is computed from the pane's transcript order through the transcript's OWN display pipeline — `coalesceSyntheticToolResultTurns(reclassifyPtyNotificationTurns(transcriptTurns))`, the same two transforms `FreshAgentTranscript` applies in that order — so machine-injected rows that DISPLAY as non-user (opencode-pty `<pty_exited>` notification rows, raw role user; synthetic tool-result rows) never steal the newest-user slot from the real prompt (round-3 delta review defect 1); the echo branch of that derivation keeps the send-boundary comparison (`localEchoSendBoundaryRef` / the persisted `previousTurnKeys`) over the same displayed user rows, and display keys derive through `getFreshAgentDisplayTurnKey`.
- Semantics decisions (round-2 finding 1 + round-3 finding 1): a BOUND availability always wins over the busy fallback, and that is honest — the capture completes at the barrier BEFORE the turn runs, so a row that has bound an `available` capture outcome genuinely has a snapshot while the agent works (the existing e2e `fresh-agent-checkpoint-unavailable-rust.spec.ts:123` already asserts the mid-turn available state as a pinned journey, and the snapshot-refreshed `msg_`-id rows cannot bind the request-keyed capture frame — :1329-1331 requires `turn.requestId`, which schema rows do not carry — so the NEWEST unbound modern row is exactly the mid-turn surface the pending state serves). The pending state therefore applies ONLY to the newest unbound modern user row while busy AND with a capture this pane can evidence as in flight; older unbound rows (e.g. historical MCP/CLI-driven turns) keep the honest unavailable verdict at all times, per the User Request's "MCP/CLI-driven turns stay honestly rewind-unavailable" constraint. Round-4 (E1R4) adds the nothing-branch: the uncertain mid-turn window — newest unbound modern user row, busy, but with nothing this pane can evidence as in flight — shows NOTHING at all for that row (no rewind hover, per the request's explicit "(or nothing)" acceptance), and the honest unavailable verdict returns when the turn settles.

- [ ] **Step 1: Write the failing behavioral tests (no new module imports in the existing file)**

As shipped, `FreshAgentView.test.tsx` gains one `describe('fresh-agent rewind availability honesty', ...)` (frame-driven `onMessage`, snapshot turns via the outcome/snapshot frames) whose file batch does NOT import `unboundRewindAvailability` — an import of a not-yet-existing export breaks the whole file's module load and the red step never runs. The helper-level assertions live in a SEPARATE new test file (Test A below), whose import failure is its own isolated red. The shipped suite:

Test B (the red test, as shipped) — `shows the honest still-saving state on the newest user row while a genuine composer send's capture is in flight, and keeps older unbound rows honestly unavailable`: the still-saving verdict is earned by driving a REAL composer send through the pane (capture the `freshAgent.send` frame's `requestId`/`checkpointIntent.logicalAttemptId`, feed the un-enriched barrier-time `freshAgent.checkpoint.outcome` (status `available`, NO native ids), let `freshAgent.send.accepted` land the send's row in the refreshed snapshot, then drive the pane busy with a `freshAgent.session.snapshot` status frame):
1. Hover the NEWEST user turn's article; assert the rewind button is disabled with `aria-label="Saving code rewind checkpoint"` and `title="Saving the code state from before this message"`. RED against pre-Task-1 code: it said `aria-label="Rewind unavailable for this message"`.
2. Hover the OLDER user turn's article; assert the disabled `aria-label="Rewind unavailable for this message"` button with `title` containing `No exact code checkpoint is available for this message.` — pinning that older MCP/CLI-shaped rows never claim "saving".

Test B2 (the nothing-branch, as shipped) — `an active MCP/CLI-driven turn shows no rewind claim at all mid-turn, and the honest unavailable verdict at settle`: the newest user row is modern and unbound but this pane sent NOTHING (no composer send, no pending send metadata, no capture in play); while busy the row shows NO rewind claim at all (no still-saving hover, no unavailable hover, no enabled hover — the request's "(or nothing)" acceptance), and the honest unavailable verdict returns at the busy→idle settle.

Test C (green pin, keeps passing) — `keeps a settled unbound modern turn unavailable when the agent is idle`: the idle case still shows the disabled `Rewind unavailable for this message` button (asserted through the hover surface).

Test D (green pin, keeps passing) — `a bound available capture keeps showing available while the agent is busy`: a user turn that HAS a bound `available` checkpoint outcome (bound through the request-key frame path) keeps the ENABLED `Rewind code to here` hover while the pane is busy — never downgraded to pending.

Round-3 delta review defect 1 pins (as shipped, added by the delta fix): two PTY-notification tests — `a PTY notification row landing after the prompt never steals the newest-user slot` (a busy MCP/CLI-driven pane whose snapshot has a real prompt followed by an opencode-pty `<pty_exited>` row, raw role user, displayed as assistant: the prompt keeps the mid-turn NO-claim treatment, never the unavailable verdict; the notification row keeps its assistant display with no rewind affordance; the honest unavailable returns at settle) and `a PTY notification row landing mid-turn never steals the saving prompt's newest-user slot` (a genuine composer send whose capture is in flight, with the notification landing after the send's landed row: the PROMPT keeps the Saving hover, the older row keeps the honest unavailable).

The same describe also carries the shipped busy-epoch retirement, settled-unavailable, first-send materialization, slow-materialization, reload-in-echo-window, echo-boundary and stale-echo tests (see the Residuals section for their semantics).

Test A (policy unit, as shipped, in the NEW file `test/unit/client/components/fresh-agent/rewind-availability-policy.test.tsx`) — `does not consider agent response turns for rewind status at all` and `pins the user-row matrix`:
1. Import `unboundRewindAvailability` from the view module; assert `unboundRewindAvailability(assistantTurn, …)` is `undefined` for ALL four `(busy, newest, captureInFlight)` input combinations — the role gate holds for agent turns regardless of the other inputs.
2. Pin the user-row matrix at the 4-arg policy level: newest+busy+captureInFlight → `{ status: 'pending' }`; newest+busy+NO captureInFlight → `undefined` (the uncertain window makes no claim); newest+idle (either capture input) → unavailable; older rows at all inputs → unavailable; a non-modern user row → `undefined`.
3. NOTE on scope: this file tests the POLICY helper. The view-level wiring (the fallback actually running for user rows, the `captureInFlight` derivation, the echo branch) is proven by the view tests above.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/rewind-availability-policy.test.tsx --config config/vitest/vitest.config.ts`

Expected (against pre-Task-1 code): FAIL — `FreshAgentView.test.tsx` loads (no new imports there) and Test B fails on the newest row with the button showing "Rewind unavailable for this message" instead of "Saving code rewind checkpoint" (Test B's older-row half, Test C, and Test D pass — they pin current behavior); the new policy file fails on the missing-export import (its own isolated red).

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentView.tsx`, directly below `isModernCheckpointTurn` — the 4-arg helper as committed (copied verbatim from the current source; the comment documents the captureInFlight gate and the nothing-branch):

```ts
// The fallback for a modern turn with no bound checkpoint outcome. Agent
// response turns are never rewindable and never even considered (defect 2).
// "Still saving" (defect 4) belongs to the NEWEST user row only, while this
// pane's agent turn is running AND this pane's own composer send has a
// checkpoint capture genuinely in flight: an MCP/CLI-driven turn sends
// through the REST lane with no capture at all, so its row must never claim
// a save is underway even while the pane is busy. The UNCERTAIN window —
// newest user row, busy, but nothing this pane can evidence as in flight
// (an MCP/CLI-driven turn; a mid-turn reload whose fresh mount has no send
// metadata; a capture that already settled) makes NO claim at all: undefined,
// the User Request's explicit "(or nothing)" acceptance. Older unbound rows
// (historical MCP/CLI-driven turns) keep the honest unavailable verdict —
// nothing is being saved for them even while a later turn runs — and the
// newest row's honest unavailable verdict returns at the busy→idle settle.
// Every state here is computed, never stored: each dies at the busy→idle
// edge and at the capture-enrichment edge, so none can wedge.
export function unboundRewindAvailability(
  turn: FreshAgentTurn,
  agentBusy: boolean,
  isNewestUserTurn: boolean,
  captureInFlight: boolean,
): FreshAgentTurnRewindAvailability | undefined {
  if (turn.role !== 'user') return undefined
  if (!isModernCheckpointTurn(turn)) return undefined
  if (agentBusy && isNewestUserTurn && !captureInFlight) return undefined
  return agentBusy && isNewestUserTurn
    ? { status: 'pending' }
    : { status: 'unavailable', reason: MODERN_TURN_CHECKPOINT_UNAVAILABLE }
}
```

The `getRewindAvailability` wiring, as shipped (all in the component body below the `isBusy`/`sessionEnded` derivations, so no temporal-dead-zone on `isBusy`):

1. `captureInFlight` is derived each render: `paneCaptureInFlight(pendingSendMetadataRef.current, paneContent.checkpointOutcomes, busyEpochRef.current)` — an own-send `available` outcome with no `nativeTurnId` counts as in flight only while the pane is still inside the busy window (epoch) the send was dispatched in; a settled non-`available` outcome never counts.
2. `newestUserTurnKey` is a `useMemo` over `transcriptTurns` that first applies the transcript's own display pipeline — `coalesceSyntheticToolResultTurns(reclassifyPtyNotificationTurns(transcriptTurns))`, both exported from `shared/fresh-agent-turns.ts` and applied in the same order `FreshAgentTranscript` applies them — then filters the DISPLAYED user rows for the last landed key; when a local echo is displayed, the echo holds the newest-user slot only while no DISPLAYED user row landed after its send (the send-boundary key comparison, `localEchoSendBoundaryRef` or the echo record's persisted `previousTurnKeys`, over the same displayed user rows), and a stale echo yields to the last landed displayed user key.
3. `getRewindAvailability` is a `useCallback` (deps include `getCheckpointAvailability`, `isBusy`, `newestUserTurnKey`, `captureInFlight`, `localEchoTurn`): the bound lookup first (an `unavailable` bound verdict keeps its reason; anything else keeps its status — a bound `available` capture is never downgraded by the busy fallback); then the ECHO branch (the pane's pending local echo row with no bound availability: busy+newest → `{ status: 'pending' }`, busy+non-newest (uncertain) → `undefined`, idle → the honest unavailable — so a reloaded echo can never fall to the legacy enabled rewind path); then `unboundRewindAvailability(turn, isBusy, newestUserTurnKey !== undefined && getFreshAgentDisplayTurnKey(turn) === newestUserTurnKey, captureInFlight)`.

(Keep the `FreshAgentTurnRewindAvailability` import; the hover button, context-menu builder and action sheet consume the result unchanged.)

- [ ] **Step 4: Run the focused tests**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/rewind-availability-policy.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (both files — including the pre-existing tests at :3492, :3706, :4103, :4622, which pin hover/notice/persistence behavior that the role gate and busy-pending must not disturb; :4103's idle-unavailable expectation must keep passing because that test's pane is idle; Test B's older-row half and Test D keep the honest-verdict and bound-wins journeys green; and Test A's policy matrix pins the role gate at the helper level, where it actually lives).

- [ ] **Step 5: Refactor while green**

None beyond the extraction in Step 3 (the extraction IS the refactor — the policy is now pure and unit-testable; verify no other call site duplicates the old fallback logic by `rg -n 'isModernCheckpointTurn' src/`).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything consuming `getRewindAvailability` and the availability map — `FreshAgentView.test.tsx`, `FreshAgentTranscript.test.tsx`, `FreshAgentTurnActions.test.tsx` (hover/sheet rendering of pending/unavailable/assistant states).

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/rewind-availability-policy.test.tsx
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
3. In both e2e specs: replace the `getByRole('status'/'note', …)` transcript-text assertions with the corresponding hover assertions already used elsewhere in those specs (`.hover()` then `getByRole('button', { name: 'Rewind code to here' })` / `{ name: 'Rewind unavailable for this message' })` with disabled state), AND (round-3 review finding 5 — the User Request explicitly preserves the reason) keep each replaced assertion's REASON claim alive by asserting the button's `title` contains the exact reason text the old note assertion carried (e.g. `await expect(rewind).toHaveAttribute('title', /No exact code checkpoint is available for this message\./)` wherever the old assertion matched that string). AND add per-pane absence pins for the removed text (round-2 finding 2 — hover assertions alone can pass while the note still renders; round-3 finding 4 — a hand-typed regex can miss the real accessible names): FIRST enumerate the removed block's EXACT aria-labels and rendered text strings by reading `FreshAgentTranscript.tsx:1000-1021` (the available note's accessible name is `Code rewind available for this message` — NOT "is available" — and its visible text is `Code rewind is available for this message.`; enumerate all four states' names and texts verbatim from the source), THEN pin each: `await expect(paneRoot.getByRole('note')).toHaveCount(0)`, plus a `toHaveCount(0)` for each enumerated `getByRole('status', { name: <exact accessible name> })` and each enumerated `getByText(<exact visible string>)`, at the same points the old note assertions ran — so the REMOVAL itself is e2e-protected by exact-string membership, not a lossy regex.

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

- [ ] **Step 6: Run impacted-test verification (unit + cloud e2e)**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Expected: PASS.

Run (cloud-legal spec, ordinary lane): `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts`

Expected: PASS (including the unchanged restore journeys and the new absence pins).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts test/e2e-browser/specs/code-checkpoint-workspace-external.spec.ts
git commit -m "fix(fresh-agent): remove the per-turn rewind status text; hover keeps state and reason"
```

- [ ] **Step 8: Run the external-target driver verification (requires the Step 7 commit)**

The closed driver builds from a COMMITTED acceptance SHA and asserts an empty `git status --porcelain`, so it can only run AFTER the task's commit (round-2 review finding 3). It also asserts the exact robot account (`managed-provider-environment-target.ts:1192-1193`):

Run: `GCLOUD_ROBOT_REQUIRE=1 GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com pnpm exec tsx scripts/testing/managed-provider-environment-target.ts --checkpoint`

Expected: PASS (covers the six note/status assertion conversions in `code-checkpoint-workspace-external.spec.ts`). If it fails, fix and amend with a follow-up commit, then re-run.

---

### Task 3: Client contract pin — the first message binds live through materialization (defect 3, client)

**Files:**
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: the wire contract Task 4 will produce (enriched outcome frames may arrive addressed to the durable `ses_*` id); the pane frame handlers: `freshAgent.created` (:2886), `freshAgent.checkpoint.outcome` (:2987), `freshAgent.send.accepted` (:3021), `freshAgent.session.materialized` (:2934-2974); `locatorMatchesPane` (:786-825).
- Produces: a regression pin (green now, protects the whole chain): the full first-message sequence ends with the user turn's hover button enabled WITHOUT reload or remount. Ordered BEFORE the server work so the executable proof of the client chain precedes Task 4 (load-bearing finder advisory, reports/load-bearing-finder.md LB1).

- [ ] **Step 1: Write the pinning test**

Add to `FreshAgentView.test.tsx` (opencode pane, mirroring :3492's harness setup): `binds a freshopencode first message's checkpoint live when the enriched outcome arrives addressed to the materialized session`

1. Create the pane via `freshAgent.created` with placeholder `sessionId: 'freshopencode-req1'`.
2. Send the first composer message (fire the send path as :3492 does); capture the emitted `freshAgent.send` frame and assert its `sessionId` is the placeholder and its `checkpointIntent.logicalAttemptId` matches the client's pending metadata.
3. Feed frames in server order: the initial `freshAgent.checkpoint.outcome` (sessionId `freshopencode-req1`, status `available`, checkpointId, logicalAttemptId, requestId, NO native/display ids); `freshAgent.send.accepted` (same requestId, `submittedTurnId` absent — opencode); `freshAgent.session.materialized` (previousSessionId `freshopencode-req1`, sessionId `ses_durable`); a snapshot whose user turn row is `{ turnId: 'msg_55c25d96e4445f67b35ea116686e169c', role: 'user', source: 'durable' }` (the deterministic id for the known logical attempt id); then the identity-enriched `freshAgent.checkpoint.outcome` addressed to **`ses_durable`** with `nativeTurnId`/`displayTurnId` `msg_55c25d96e4445f67b35ea116686e169c`.
4. Assert the user turn's hover button is enabled `Rewind code to here` — with NO remount and no outcome-page refetch (stub the outcome-page fetch with an assertion that it was not re-armed mid-test, or simply do not wire it — follow the :3492 idiom for its fetch stubbing).
5. Assert the pane content's persisted `checkpointOutcomes` carries the outcome with the materialized `conversationSessionKey` (the :3673 idiom).

- [ ] **Step 2: Run the test and verify it passes as a pin**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (this pins existing client behavior + the Task 4 wire contract; it is a regression pin, not a red test — if it fails, the client gates reject the durable-addressed enriched frame and the failure must be investigated before proceeding).

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

### Task 4: Identity-enriched outcome frames are addressed to every session alias (defect 3, server)

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
    // Construction mirrors the existing tests' idiom (e.g. :6271):
    // CheckpointService::new(Arc<PathBuf>, Arc<Sender<String>>) -> Self —
    // it takes no async and returns no Result, so there is nothing to await
    // or unwrap (round-2 review finding 4).
    let service = Arc::new(CheckpointService::new(
        Arc::new(home.path().to_path_buf()),
        Arc::new(broadcast_tx),
    ));
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

### Task 5: E2E — a freshopencode first message offers rewind live, without reload (defect 3, end to end)

**Files:**
- Test: `test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts` — add one test reusing the file's fake-opencode harness pieces (`installFakeOpencode`, `createSetupHome`, `TestHarness`, `RustServer`), and parameterize the spec-local `createServerOptions` helper (it currently HARD-CODES `FAKE_OPENCODE_HANG_SESSION_CREATE: '1'` at :50-63, so "call it freshly without the flag" is impossible — round-2 review finding 5; add an optional `hangSessionCreate?: boolean` input defaulting to `true` so the existing test's call sites are unchanged, and the new test passes `false`)
- Test infra: `test/e2e-browser/fixtures/fake-opencode.cjs` — add the `FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH` knob (round-3 review finding 3) gating `/prompt_async` turn completion, mirroring the existing summarize-gate pattern (:667, :1632); default unset = today's behavior, so every other spec is untouched

**Interfaces:**
- Consumes: the fake `opencode` fixture (`test/e2e-browser/fixtures/fake-opencode.cjs`) — it validates and persists the server-supplied `messageID` prompt ids (`msg_[0-9a-f]{32}`, fixture :123-124, :174-200), so the deterministic identity observation succeeds end to end; Task 4's per-alias broadcast; Task 2's hover-only surfaces. This spec is in `CLOUD_SKIP_SPECS` (`playwright.cloud.config.ts:41`, provider-boot-timing class) and its new test inherits that membership — the cloud lane's `testIgnore` silently drops it, so this spec runs on the LOCAL lane only (load-bearing finding LB4, reports/load-bearing-finder.md).
- Produces: one spec proving the first composer message's rewind button is enabled right after its turn completes, with no page reload — PLUS the e2e coverage for Task 1's behaviors that the unit tests alone cannot provide (round-2 review finding 2): the mid-turn busy-pending hover, the agent-turn role gate (no rewind control on assistant rows), and the transcript note absence.

- [ ] **Step 1: Write the spec**

Add to `freshopencode-first-send-reload-repro.spec.ts` (first parameterize `createServerOptions` per the Files note):

```ts
test('binds the first message\'s code checkpoint live, without a reload', async ({ page }) => {
  // Boot the Rust server + fake opencode harness with createServerOptions({ …,
  // hangSessionCreate: false }): the hard-coded flag pins session materialization
  // in flight forever (fixture :1694-1702 never responds), so the durable ses_*
  // id would never appear and this test could never pass (LB6,
  // reports/load-bearing-finder.md). Do not inherit the existing test's
  // flag-conditioned wait helpers either.
  // … open a fresh freshopencode pane (picker → opencode mode with a Git
  // workspace cwd so capture succeeds) …
  // … type the first composer message and submit …
  // MID-TURN (Task 1 busy-pending e2e): after the snapshot's user row
  // (msg_-id, source durable — the request-keyed capture frame cannot bind it,
  // see Task 1's semantics note) is visible while the pane is still busy:
  //   await userTurn.hover()
  //   → assert the rewind button is DISABLED with aria-label
  //     "Saving code rewind checkpoint" and title "Saving the code state from
  //     before this message". DETERMINISM (round-3 review finding 3): the
  //     fake emits idle ~25 ms after /prompt_async, so this window is NOT
  //     reliably observable bare, and the existing
  //     FAKE_OPENCODE_HOLD_SUMMARIZE_GATE_PATH gates only the /summarize lane.
  //     Add a NEW fixture knob — FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH — gating
  //     the /prompt_async turn completion exactly like the summarize gate
  //     pattern (fixture :667, :1632): set it, submit the message, wait for
  //     the user row, assert the pending hover, then release the gate and let
  //     the turn settle.
  // ROLE GATE + NOTE ABSENCE (Task 1/2 e2e): on the assistant row, assert NO
  // rewind button at all (not enabled, not disabled); assert the pane has no
  // role="note"/"status" rewind-status text (toHaveCount(0) pins the removal).
  // … release the gate if held; wait for the assistant turn to settle and the
  // enriched outcome to bind …
  const userTurn = page.getByRole('article').filter({ hasText: '<the sent text>' }).first()
  await userTurn.hover()
  const rewind = userTurn.getByRole('button', { name: 'Rewind code to here' })
  await expect(rewind).toBeEnabled()      // NO page.reload() anywhere before this
})
```

(The sent text marker should be unique per run, as the file's existing test does.)

- [ ] **Step 2: Run the spec and verify the live-binding passes**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: PASS for the new test (and the existing one, which keeps its hang-flag harness and reload journey). NOTE (LB6): no e2e anywhere has composed the freshopencode checkpoint journey before — every link is individually proven (fixture messageID persistence, provider-neutral capture, the LB1 client chain, the Task 4 Rust unit test), but the composition executes for the first time here. If the new test fails on first run, treat the HARNESS as suspect first (see Step 3).

- [ ] **Step 3: No production implementation (test-infra only)**

None in src/ or crates/ — the only non-spec change is the new `FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH` knob in `fake-opencode.cjs` (default unset preserves today's fixture behavior for every other spec). If the spec fails, diagnose in this order: (1) harness-suspect-first — verify the server options really dropped the hang flag (the parameterized helper default must still keep the EXISTING test green), the prompt gate actually held the turn (server stayed busy through the pending assertion) and was released after, the fake materialized a durable `ses_*` id, the snapshot shows both rows, and the server JSONL shows the capture + identity observation + per-alias broadcast frames; (2) only then consider a contract break between Task 4's fan-out and the client gates. Never relax the spec to make it pass.

- [ ] **Step 4: Run the focused spec**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None.

- [ ] **Step 6: Run impacted-test verification (local + cloud lanes)**

Run: `pnpm run test:e2e:local test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts`

Run: `FRESHELL_E2E_BACKEND=cloud pnpm run test:e2e test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts`

Expected: PASS on both.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-first-send-reload-repro.spec.ts test/e2e-browser/fixtures/fake-opencode.cjs
git commit -m "test(e2e): freshopencode first message binds rewind live without reload"
```

- [ ] **Step 8: Run the external-target driver verification (requires the Step 7 commit)**

The closed driver builds from a COMMITTED acceptance SHA, asserts an empty `git status --porcelain`, and asserts the exact robot account (`managed-provider-environment-target.ts:1192-1193`), so it runs AFTER the task's commit (round-2 review finding 3):

Run: `GCLOUD_ROBOT_REQUIRE=1 GCLOUD_ROBOT_ACCOUNT=gcloud-robot@misc-puttering-project.iam.gserviceaccount.com pnpm exec tsx scripts/testing/managed-provider-environment-target.ts --checkpoint`

Expected: PASS (covers the six note/status assertion conversions in `code-checkpoint-workspace-external.spec.ts`). If it fails, fix and amend with a follow-up commit, then re-run.

---

## Residuals (accepted)

- The "still saving" state keys on the newest-user-row heuristic, not exact send attribution: in the rare case an MCP/CLI-driven send lands as the NEWEST user row while a composer turn is also running, that row transiently shows pending until the busy→idle edge; and with two queued sends in flight, the older of the two can show unavailable instead of pending for the overlap. Both are tooltip-only, self-correcting, and far rarer than the alternative (blanket pending, which mislabeled every historical MCP/CLI row — rejected in round-3 review finding 1).
- A reloaded second-or-later message's echo carries its send boundary in the PERSISTED echo record (E2R3): the restored echo earns the still-saving verdict while busy beside rows the boundary proves predate its send (every landed user key ⊆ the boundary); a landed row ∉ the boundary leaves the echo UNCERTAIN mid-turn — it may be a later row OR a late-landing older row (a queued second message can dispatch before the first row reaches the snapshot, and that row then lands during the second turn), which the client cannot tell apart — so the echo shows NOTHING at all until the busy→idle settle (E2R5), where the honest unavailable verdict returns. Residual, accepted: records persisted before the field existed rehydrate without it — the pane cannot place those rows in time, so such a legacy echo is uncertain beside ANY landed row: nothing mid-turn, the conservative unavailable verdict at the settle (tooltip-only, self-correcting at the stale clear).
- An un-enriched capture outcome (with its send metadata) can linger past its turn — deleted only on a send-failure frame — but it can no longer evidence an in-flight capture once its turn settled: the settle advances the busy epoch at the edge itself, or — when the settle passed while the send's optimistic echo was still pending because transcript history lagged the row (E1R5) — at the echo's clear (the row-landed clear and the stale clear both bump, gated on the pane not being busy at the clear moment; a clear firing mid-turn — slow materialization, the materialization blip's resumed busy window — keeps the window, whose capture is genuinely in flight). A later busy window's uncertain newest row then shows NOTHING instead of unavailable until that window's settle (an MCP/CLI-driven turn, a mid-turn reload with no fresh send metadata, and a capture that already settled all land here) — tooltip-only, self-correcting, and strictly within the request's "(or nothing)" acceptance. The ONE remaining corner: an OLD send's history-lagged row landing DURING a later busy window — its echo clears while busy, so no bump until that window's own settle edge, and in that one window a stale-confidence newest row can show "Saving"; tooltip-only, self-correcting at the window's settle, and reachable only when a history-lagged row lands mid-LATER-turn.
- If identity observation fails server-side (`checkpoint_turn_identity_unobserved`), the row settles to the honest `unavailable: No exact code checkpoint…` at idle — per the managed-runtime identity contract, unchanged.
- MCP/CLI-sent messages remain without code checkpoints (out of scope; separate REST-lane capture work).

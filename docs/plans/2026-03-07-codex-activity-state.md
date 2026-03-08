# Codex Activity State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add a Codex-only, server-owned busy indicator that is exact for resumed Codex sessions and for turns submitted after a Codex terminal is already bound, clears from a real server-owned BEL path, and keeps `wait-for --prompt` blocked while Codex is pending or known busy.

**Architecture:** Keep live activity out of `TerminalMetadataService`. Add a dedicated server-side `CodexActivityTracker` keyed by exact `terminalId`, feed it from exact registry binding/input/output events plus fixture-backed Codex `task_started` / `task_complete` / `turn_aborted` snapshots from the existing indexer, and publish a dedicated Codex-only websocket overlay to the client. The client stores that overlay in a non-persisted slice and pulses only from exact local `terminalId` resolution when the tracker is `busy`; `pending` remains a server-owned wait-blocking state and does not pulse the visible indicator. `wait-for --prompt` still consults the same tracker so prompt waits stay blocked during both the short bound-submit gate and the later `busy` phase.

**Tech Stack:** Node/Express, existing `CodingCliSessionIndexer`, `TerminalRegistry`, WebSocket protocol in `shared/ws-protocol.ts`, React 18, Redux Toolkit, Vitest.

---

## Direction Change

Do not try to recover fresh first turns on unbound Codex sessions.

This plan intentionally implements only the exact subset the reviewer cleared:

- resumed Codex sessions are eligible immediately
- later turns are eligible only after the terminal already has an exact Codex binding
- fresh first turns on unbound Codex sessions do not pulse
- live activity does not go through `terminal.meta` or `TerminalMetadataService`
- the client never infers activity from `sessionRef`, `resumeSessionId`, cwd, repo root, or bare provider matching

## Non-Negotiable Guardrails

- Keep scope Codex-only.
- Do not add new file watchers, log tailers, polling loops over session files, or high-frequency file I/O.
- Start detection must come only from fixture-backed Codex task-event parsing inside the existing bounded session-indexer snippet read.
- Completion must include a real server-owned BEL clear path from raw terminal output.
- Preserve existing Codex session association, `resumeSessionId`, title sync, and runtime metadata behavior.
- Fail closed: ambiguity means no pulse.
- Do not modify `server/terminal-metadata-service.ts` for live activity.
- `wait-for --prompt` must stay blocked while the tracker is `pending` or `busy`, not only during the short pre-start gate.

## Accepted Gaps

- A fresh first turn on an unbound Codex terminal still does not pulse and does not get a pre-start prompt gate.
- Busy start can lag by the current indexer debounce/throttle window.
- The user explicitly accepted that visible activity can start a few seconds late if that preserves exactness; do not widen UI pulsing from `pending` just to mask indexer delay.
- If BEL is missed and Codex never records a later `task_complete` / `turn_aborted`, the tracker may fall back to `unknown` via deadman expiry instead of proving completion.
- Bound-turn submit detection uses exact terminal ownership plus newline submission on the server input stream. That is acceptable for the cleared subset because identity is exact at that point; no cwd/session heuristics are involved.

## Out Of Scope

- No client-side activity inference from session lists.
- No recovery for fresh unbound first turns.
- No new UI copy or `docs/index.html` update for this live-only indicator.

### Task 1: Add Fixture-Backed Codex Task-Event Parsing

**Files:**
- Create: `test/fixtures/coding-cli/codex/task-events.sanitized.jsonl`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `test/unit/server/coding-cli/codex-provider.test.ts`
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`

**Step 1: Write the failing parser tests**

Add a checked-in sanitized fixture containing real Codex event shapes for:

- `event_msg.payload.type === 'task_started'`
- `event_msg.payload.type === 'task_complete'`
- `event_msg.payload.type === 'turn_aborted'`

Add this shape to the plan first, then write tests against it:

```ts
export type CodexTaskEventSnapshot = {
  latestTaskStartedAt?: number
  latestTaskCompletedAt?: number
  latestTurnAbortedAt?: number
}
```

Tests must prove:

- `parseCodexSessionContent()` returns the latest timestamps from the fixture
- unrelated `event_msg` payloads do not populate these fields
- `CodingCliSessionIndexer` preserves the parsed snapshot on the `CodingCliSession` record without any second file read

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: FAIL because `ParsedSessionMeta` / `CodingCliSession` do not yet expose Codex task-event snapshots.

**Step 3: Implement the minimal parser changes**

Thread `codexTaskEvents?: CodexTaskEventSnapshot` through:

```ts
export interface ParsedSessionMeta {
  // existing fields...
  codexTaskEvents?: CodexTaskEventSnapshot
}

export interface CodingCliSession {
  // existing fields...
  codexTaskEvents?: CodexTaskEventSnapshot
}
```

Implementation rules:

- parse timestamps only from the JSONL event payloads already in the snippet
- do not use file `mtime`, `updatedAt`, or guessed event names as activity proof
- leave non-Codex providers unchanged

**Step 4: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/fixtures/coding-cli/codex/task-events.sanitized.jsonl server/coding-cli/types.ts server/coding-cli/providers/codex.ts server/coding-cli/session-indexer.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "test(codex): add fixture-backed task event parsing"
```

### Task 2: Expose Exact Registry Events Without Changing Association Semantics

**Files:**
- Modify: `server/terminal-stream/registry-events.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-lifecycle.test.ts`
- Modify: `test/unit/server/session-association-coordinator.test.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/server/session-association.test.ts`

**Step 1: Write the failing event-surface tests**

Add tests that prove:

- `TerminalRegistry.input()` emits `terminal.input.raw`
- resume create emits `terminal.session.bound` before `terminal.created`
- association-driven Codex binding still works without any activity tracker involvement
- every real unbind path emits `terminal.session.unbound` with a reason

Use concrete reason enums:

```ts
export type SessionBindingReason = 'resume' | 'association'
export type SessionUnbindReason = 'exit' | 'rebind' | 'stale_owner' | 'repair_duplicate'
```

Representative assertions:

```ts
expect(order).toEqual(['terminal.session.bound', 'terminal.created'])
expect(onInputRaw).toHaveBeenCalledWith(expect.objectContaining({ data: '\r' }))
expect(unbound.reason).toBe('repair_duplicate')
```

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/terminal-lifecycle.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts
```

Expected: FAIL because these event types and reasons do not exist yet.

**Step 3: Implement the exact event surface**

Add these event payloads:

```ts
export type TerminalInputRawEvent = {
  terminalId: string
  data: string
  at: number
}

export type TerminalSessionBoundEvent = {
  terminalId: string
  provider: 'codex' | 'claude'
  sessionId: string
  reason: SessionBindingReason
}

export type TerminalSessionUnboundEvent = {
  terminalId: string
  provider: 'codex' | 'claude'
  sessionId: string
  reason: SessionUnbindReason
}
```

Implementation rules:

- emit `terminal.input.raw` inside `TerminalRegistry.input()` after a successful write
- extend `bindSession()` with a non-semantic `reason` argument
- pass `reason: 'resume'` from `create()` resume binding
- pass `reason: 'association'` from `SessionAssociationCoordinator`
- centralize unbind emission in one helper so `exit`, stale-owner cleanup, and legacy-owner repair all emit consistently
- do not change candidate selection, cwd matching, or existing association timing

**Step 4: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/terminal-lifecycle.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/registry-events.ts server/session-association-coordinator.ts server/terminal-registry.ts test/unit/server/terminal-lifecycle.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts
git commit -m "refactor(registry): expose exact codex activity events"
```

### Task 3: Share The BEL Parser So The Server Can Clear Busy State

**Files:**
- Create: `shared/turn-complete-signal.ts`
- Modify: `src/lib/turn-complete-signal.ts`
- Create: `test/unit/shared/turn-complete-signal.test.ts`
- Modify: `test/unit/client/lib/turn-complete-signal.test.ts`

**Step 1: Write the failing shared-parser tests**

Add shared tests that prove:

- BEL in Codex output increments the counter and is removed from cleaned output
- BEL terminating OSC is preserved, not counted
- split `ESC` / `]` OSC sequences across chunks are preserved with parser state
- parser state works for both browser and server consumers

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/turn-complete-signal.test.ts
```

Expected: FAIL because the shared helper does not exist yet.

**Step 3: Implement the shared helper**

Move the parser into `shared/turn-complete-signal.ts` with an API the server can import directly:

```ts
export type TurnCompleteSignalMode = 'shell' | 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'

export function createTurnCompleteSignalParserState(): TurnCompleteSignalParserState
export function extractTurnCompleteSignals(
  data: string,
  mode: TurnCompleteSignalMode,
  state?: TurnCompleteSignalParserState,
): { cleaned: string; count: number }
```

Leave `src/lib/turn-complete-signal.ts` as a thin client wrapper so existing browser imports keep working.

**Step 4: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/turn-complete-signal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/turn-complete-signal.ts src/lib/turn-complete-signal.ts test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/turn-complete-signal.test.ts
git commit -m "refactor(shared): share turn-complete signal parser"
```

### Task 4: Implement The Exact-Subset `CodexActivityTracker`

**Files:**
- Create: `server/coding-cli/codex-activity-tracker.ts`
- Create: `server/coding-cli/codex-activity-wiring.ts`
- Modify: `server/index.ts`
- Create: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Create: `test/server/codex-activity-exact-subset.test.ts`

**Step 1: Write the failing tracker tests**

Add tests for these exact cases:

- a resume-bound Codex terminal becomes `busy` immediately when the bound session snapshot is already unresolved
- a bound Codex terminal receiving newline input enters `pending`
- later `task_started` for the same bound session promotes `pending -> busy`
- newline on an unbound Codex terminal is ignored for activity and prompt gating
- later association after an unbound first turn seeds watermarks and does not retroactively pulse
- BEL clears `busy` immediately
- `task_complete` and `turn_aborted` clear stale `busy` if BEL was missed
- unbind, rebind, and exit clear tracker state
- deadman expiry degrades stale `busy` to `unknown`

Use a per-terminal state like:

```ts
type CodexTerminalActivity = {
  terminalId: string
  sessionId?: string
  phase: 'idle' | 'pending' | 'busy' | 'unknown'
  lastSubmitAt?: number
  pendingUntil?: number
  acceptedStartAt?: number
  lastClearedAt?: number
  lastSeenTaskStartedAt?: number
  lastSeenTaskCompletedAt?: number
  lastSeenTurnAbortedAt?: number
  parserState: TurnCompleteSignalParserState
  updatedAt: number
}
```

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/server/codex-activity-exact-subset.test.ts
```

Expected: FAIL because the tracker and exact-subset semantics do not exist.

**Step 3: Implement `CodexActivityTracker`**

Implement these rules exactly:

- ignore non-Codex terminals
- `bindTerminal()` seeds the current snapshot watermarks and marks `busy` immediately only when the bound session is already unresolved
- `noteInput()` only considers newline-bearing input (`\r` or `\n`) and only when the terminal is already bound to a Codex session
- unbound newline input does nothing
- `pending` blocks prompt waits but does not pulse the UI
- `busy` starts only from exact bound session snapshots, never from cwd/provider matching
- only BEL-only / notification-like raw output clears `pending` / `busy` immediately; visible-content BEL stays fail-closed until indexed completion proves the turn ended
- `task_complete` / `turn_aborted` also clear `busy` if they pass the accepted start watermark
- `expire()` changes long-stale `pending` back to `idle` and long-stale `busy` to `unknown`

Use bounded constants:

```ts
const PENDING_SUBMIT_GATE_MS = 6000
const BUSY_DEADMAN_MS = 120000
const ACTIVITY_SWEEP_MS = 5000
```

**Step 4: Wire the tracker**

Use `server/coding-cli/codex-activity-wiring.ts` to subscribe to:

- `terminal.session.bound`
- `terminal.session.unbound`
- `terminal.input.raw`
- `terminal.output.raw`
- `terminal.exit`

Implementation rules:

- handle bind-before-created by upserting tracker state from the bound event alone
- on `codingCliIndexer.onUpdate`, call `tracker.reconcileProjects(projects, Date.now())`
- on bind, pass the current indexed Codex snapshot if present so resumed sessions can go `busy` immediately
- do not modify existing session-association or title-sync logic

**Step 5: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/server/codex-activity-exact-subset.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/coding-cli/codex-activity-tracker.ts server/coding-cli/codex-activity-wiring.ts server/index.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/server/codex-activity-exact-subset.test.ts
git commit -m "feat(server): track exact-subset codex activity"
```

### Task 5: Publish A Dedicated Codex Activity Overlay Over WebSocket

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Create: `src/store/codexActivitySlice.ts`
- Modify: `src/store/store.ts`
- Modify: `src/App.tsx`
- Create: `test/server/ws-codex-activity.test.ts`
- Create: `test/unit/client/store/codexActivitySlice.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing protocol and client-state tests**

Add a Codex-only websocket overlay:

```ts
export const CodexActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'pending', 'busy', 'unknown']),
  updatedAt: z.number().int().nonnegative(),
})
```

Messages:

```ts
{ type: 'codex.activity.list', requestId: string }
{ type: 'codex.activity.list.response', requestId: string, terminals: CodexActivityRecord[] }
{ type: 'codex.activity.updated', upsert: CodexActivityRecord[], remove: string[] }
```

Tests must prove:

- `WsHandler` serves list responses and broadcasts updates
- the client sends `codex.activity.list` after `ready`
- snapshot reducers preserve newer live updates by `updatedAt`
- updates and removals ratchet cleanly in a dedicated non-persisted slice

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/server/ws-codex-activity.test.ts
npx vitest run test/unit/client/store/codexActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: FAIL because the websocket protocol and slice do not exist.

**Step 3: Implement the websocket overlay**

Implementation rules:

- add the new schemas and inferred types to `shared/ws-protocol.ts`
- extend `WsHandler` with a `codexActivityListProvider`
- add `broadcastCodexActivityUpdated()`
- in `server/index.ts`, subscribe to tracker change events and broadcast only semantic transitions
- create `src/store/codexActivitySlice.ts` with snapshot/upsert/remove reducers
- request the snapshot in `src/App.tsx` on `ready`, mirroring the existing `terminal.meta.list` bootstrap

Do not touch `server/terminal-metadata-service.ts`.

**Step 4: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/server/ws-codex-activity.test.ts
npx vitest run test/unit/client/store/codexActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/index.ts src/store/codexActivitySlice.ts src/store/store.ts src/App.tsx test/server/ws-codex-activity.test.ts test/unit/client/store/codexActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat(ws): publish codex activity overlay"
```

### Task 6: Drive The Real Pane/Tab Status Indicators From Exact Terminal Identity

**Files:**
- Create: `src/lib/codex-activity-resolver.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/panes/PaneHeader.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TabItem.tsx`
- Create: `test/unit/client/lib/codex-activity-resolver.test.ts`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Create: `test/e2e/codex-activity-indicator-flow.test.tsx`

**Step 1: Write the failing exact-identity UI tests**

Add tests that prove:

- a pane pulses only when its exact live `terminalId` record is `busy`
- a single-pane tab may fall back to exact `tab.terminalId` during rehydrate
- no pulse ever comes from `resumeSessionId`, `sessionRef`, cwd, checkout root, repo root, or provider-only fallback
- a tab pulses when any exact terminal id in that tab is `busy`
- `pending` blocks waits but does not pulse the visible indicator

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run test/unit/client/lib/codex-activity-resolver.test.ts test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx
```

Expected: FAIL because the UI does not yet consume the new Codex activity overlay.

**Step 3: Implement the exact resolver**

Create a tiny resolver with these rules:

```ts
export function resolveExactCodexActivity(
  byTerminalId: Record<string, CodexActivityRecord>,
  opts: { terminalId?: string; tabTerminalId?: string; isOnlyPane: boolean },
): CodexActivityRecord | undefined {
  if (opts.terminalId) return byTerminalId[opts.terminalId]
  if (opts.isOnlyPane && opts.tabTerminalId) return byTerminalId[opts.tabTerminalId]
  return undefined
}
```

Implementation rules:

- do not inspect `resumeSessionId`
- do not inspect `sessionRef`
- do not inspect cwd-ish metadata
- pulse only when `phase === 'busy'` and the terminal is still `running`

**Step 4: Wire the indicators**

Add `activityPulse?: boolean` props:

- `PaneHeader`
- `TabItem`

Use them to pulse the existing visible status icons, not a hidden side channel.

**Step 5: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run test/unit/client/lib/codex-activity-resolver.test.ts test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/codex-activity-resolver.ts src/components/panes/PaneContainer.tsx src/components/panes/Pane.tsx src/components/panes/PaneHeader.tsx src/components/TabBar.tsx src/components/TabItem.tsx test/unit/client/lib/codex-activity-resolver.test.ts test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx
git commit -m "feat(ui): pulse exact codex busy state"
```

### Task 7: Keep `wait-for --prompt` Blocked While Codex Is Pending Or Busy

**Files:**
- Modify: `server/agent-api/router.ts`
- Modify: `server/index.ts`
- Create: `test/server/agent-wait-for-api.test.ts`
- Modify: `test/e2e/agent-cli-flow.test.ts`

**Step 1: Write the failing wait-for tests**

Add route-level tests that prove:

- a Codex pane with a prompt-looking buffer does not return `reason: 'prompt'` while the tracker says `pending`
- the same pane does not return `reason: 'stable'` while the tracker says `busy`
- once the tracker unblocks, `wait-for --prompt` succeeds normally
- non-Codex panes keep the current behavior

Add one CLI e2e test showing `wait-for --prompt` stays blocked across multiple polling turns while the injected fake tracker reports `busy`, then exits only after the fake tracker clears.

**Step 2: Run the tests and confirm they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/server/agent-wait-for-api.test.ts
npx vitest run test/e2e/agent-cli-flow.test.ts
```

Expected: FAIL because the router does not yet consult the tracker.

**Step 3: Implement router gating**

Pass the tracker into `createAgentApiRouter()` and gate only the prompt path:

```ts
if (waitPrompt && term.mode === 'codex' && codexActivityTracker?.isPromptBlocked(term.terminalId, Date.now())) {
  stableSince = Date.now()
  await sleep(200)
  continue
}
```

Implementation rules:

- block prompt detection while `phase === 'pending' || phase === 'busy'`
- do not block on `idle` or `unknown`
- reset `stableSince` while blocked so quiet time does not accumulate behind the gate
- leave pattern-only and exit-only waits unchanged

**Step 4: Re-run the tests and confirm they pass**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/server/agent-wait-for-api.test.ts
npx vitest run test/e2e/agent-cli-flow.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-api/router.ts server/index.ts test/server/agent-wait-for-api.test.ts test/e2e/agent-cli-flow.test.ts
git commit -m "feat(agent-api): block codex prompt waits on busy state"
```

## Final Verification

Run the focused suites first:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/coding-cli/codex-provider.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/terminal-lifecycle.test.ts test/unit/server/session-association-coordinator.test.ts test/unit/server/terminal-registry.test.ts test/server/session-association.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts test/server/codex-activity-exact-subset.test.ts test/server/ws-codex-activity.test.ts test/server/agent-wait-for-api.test.ts
npx vitest run test/unit/shared/turn-complete-signal.test.ts test/unit/client/lib/turn-complete-signal.test.ts test/unit/client/store/codexActivitySlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/codex-activity-resolver.test.ts test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx test/e2e/agent-cli-flow.test.ts
```

Expected: PASS.

Run repo-wide safety checks before any rebase/merge work:

```bash
npm run lint
npm run check
npm test
```

Expected: PASS.

## Implementation Notes For The Executor

- Do not edit `server/terminal-metadata-service.ts`.
- Do not add client-side activity heuristics.
- If a test tempts you to pulse from `resumeSessionId` or `sessionRef`, change the test to fail closed instead.
- If a fresh unbound first turn appears in manual testing and does not pulse, that is the intended behavior for this plan.

# Tab/Pane Status Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` (inline, batched with checkpoints) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a **single PR** by explicit user request (clean rollback), so all tasks land on one branch (`fix/tab-status-reliability`).

**Goal:** Make tab/pane status (BLUE busy, GREEN needs-attention, SOUND on idle, and CLEAR-on-engage) correct and reliable across **every** agent surface — terminal-mode claude/codex/opencode/gemini/kimi, fresh-agent SDK panes (freshclaude/freshcodex/freshopencode/kilroy), and legacy agent-chat.

**Architecture:** The codebase has **two decoupled status pipelines**: (A) BLUE/busy, a client pull-model in `resolvePaneActivity()` reading per-agent Redux activity slices; (B) GREEN+SOUND, a push-model funneling through `recordTurnComplete` → `pendingEvents` → `useTurnCompletionNotifications`, whose only two dispatch sites are **terminal-only**. This plan does **not** rewrite the two-pipeline split; it (1) makes codex GREEN server-authoritative like claude/opencode, (2) adds a single SDK status-edge bridge so non-terminal panes feed pipeline B, (3) makes completions durable across reconnect, (4) closes stuck-blue gaps, and (5) fixes aggregation/clearing so green clears on any real engagement.

**Tech Stack:** React 18 + Redux Toolkit, listener middleware, xterm.js, Node/Express, ws, Zod, Vitest + Testing Library + superwstest. NodeNext/ESM — **all relative imports need `.js` extensions** in `server/` and `shared/`.

---

## Product decisions (baked in — from the user)

1. **Active+idle tab DOES go green.** Both a **pane click** and a **real keystroke** dismiss it, in **both** `attentionDismiss` modes. `attentionDismiss` ('click'|'type') is demoted to governing only how **background** tabs clear when navigated to. (So we do NOT suppress green on the focused pane; we make clearing robust.)
2. **Waiting-for-approval → GREEN + one sound** (same as turn-complete) on non-focused tabs.
3. **opencode reconnect/association completions: do it right** — route through the association round-trip (no false-green, no false-blue). If this introduces serious perf issues, fix them or stop and report.
4. **gemini/kimi: stop advertising as status-capable.** Reconcile the client normalizer with `supportsTurnSignal`; document them status-inert. (No new tracker now.)
5. **Codex blue onset: implement C (wire `onTurnStarted`) for accurate instant blue, AND A (render `pending` as blue) for the sub-second gap.** Short-term false-blue is acceptable; long-term is not — ensure a no-op submit's pending-blue decays quickly.

---

## Status model (target behavior)

| State | Color | Meaning | Fires when | Clears when |
|---|---|---|---|---|
| Busy | **BLUE** | agent actively working/streaming | turn starts (or submit, optimistically) | turn ends / deadman |
| Needs attention | **GREEN** | turn finished OR waiting on user input | turn completes / enters pending-permission | user clicks the pane OR types a real keystroke; background tabs per `attentionDismiss` |
| Sound | — | one chime | green fires AND tab is not the focused+active tab | — |

---

## Root causes (the 33 confirmed defects collapse to 6)

- **RC-1** GREEN/SOUND is structurally terminal-only → all fresh-agent + agent-chat panes, and gemini/kimi, have no completion path (incl. the waiting-for-approval blind spot). → **Task 3, 9**
- **RC-2** Codex GREEN is client-only: re-greens/re-chimes on every scrollback replay, loose-count false green, lost on disconnect. → **Task 2**
- **RC-3** Turn-complete is fire-and-forget: claude/opencode lose completions across refresh; claude resume mid-turn; opencode association/snapshot edges. → **Task 4, 7, 8**
- **RC-4** BLUE has no liveness guarantee: opencode no deadman; SDK error/stream-end stuck blue; reload flash. → **Task 5, 6, 11**
- **RC-5** Codex blue onset lags (debounced file-watch; pending not rendered). → **Task 11**
- **RC-6** Aggregation/clearing too narrow: active-focused stays green; multi-pane non-source click; single-dot ANDs blue with last-writer tab.status; type-mode clears on any keystroke. → **Task 10**

---

## File map (created / modified)

**Redux / hooks / client lib**
- `src/store/turnCompletionSlice.ts` — generalize dedupe; add `seq`-aware durable apply helper. (Task 1, 4)
- `src/store/turnCompletionAttention.ts` *(new)* — shared selector: map a sessionKey → `{tabId, paneId}`; export a `clearAttentionForPane` thunk. (Task 1, 10)
- `src/hooks/useTurnCompletionNotifications.ts` — keep marking; clear-effect stays background-only per `attentionDismiss`. (Task 10)
- `src/hooks/useAgentSessionTurnCompletion.ts` *(new)* — listens to fresh-agent + agent-chat status edges and pending-permission edges → `recordTurnComplete`. (Task 3)
- `src/lib/pane-activity.ts` — **export** `isFreshAgentBusy`, `isAgentChatBusy`, `resolveFreshAgentSessionKey`, `resolveAgentChatSessionKey` (all module-local today); codex `pending`→blue; `session==null`→not busy. (Task 1, 3, 11)
- `src/lib/turn-complete-signal.ts` — drop gemini/kimi from normalizer. (Task 9)
- `src/components/TerminalView.tsx` — codex out of client gate; `sendInput` synthetic flag; real-engagement clear. (Task 2, 10)
- `src/components/panes/PaneContainer.tsx` — `handleFocus` clears tab+pane on any in-tab pane focus, both modes. (Task 10)
- `src/components/TabItem.tsx` — drop redundant `&& tab.status==='running'`. (Task 10)
- `src/components/fresh-agent/FreshAgentView.tsx` — clear attention on real input; optimistic running on send. (Task 10, 11)
- `src/App.tsx` — mount `useAgentSessionTurnCompletion`; apply durable completion snapshot; add `resetOpencodeActivityOverlay()` to auth-fail handler. (Task 3, 4, 12)

**Server**
- `server/coding-cli/codex-activity-tracker.ts` — emit `turn.complete`; wire `onTurnStarted`/`onTurnCompleted`. (Task 2, 11)
- `server/coding-cli/codex-activity-wiring.ts` — feed sidecar turn events into tracker. (Task 11)
- `server/coding-cli/claude-activity-tracker.ts` — durable completion marker / `completionSeq` (Task 4). **No resume-busy seeding** (cut in Task 8 — no unresolved-turn source).
- `server/coding-cli/claude-activity-wiring.ts` — resilient bound-before-created ordering. (Task 8)
- `server/coding-cli/opencode-activity-tracker.ts` + `opencode-activity-wiring.ts` — deadman/sweep + watchdog. (Task 5)
- `server/coding-cli/opencode-ownership-reducer.ts` — reject/snapshot → association-gated turnComplete. (Task 7)
- `server/sdk-bridge.ts` — broadcast `sdk.status: idle` on natural end and error. (Task 6)
- `server/index.ts` — wire `codexActivity.tracker.on('turn.complete', …)`; include durable completions in activity snapshot. (Task 2, 4)
- `shared/ws-protocol.ts` — add `'codex'` to `TerminalTurnCompleteSchema.provider`; durable completion snapshot fields. (Task 2, 4)
- `src/lib/tab-codex-activity.ts` — **delete** (dead). (Task 12)

**Docs**
- `docs/index.html` — reflect status indicators if represented. (Task 13)
- `AGENTS.md` / code comments — document gemini/kimi status-inert; codex server-authoritative. (Task 9, 13)

---

## Conventions for every task

- TDD: write the failing test → run it red → minimal impl → run it green → refactor → commit.
- Run focused tests with `npm run test:vitest -- <path> --run`.
- Server/shared imports use `.js` suffix.
- Commit after each task with a `feat:`/`fix:`/`test:`/`refactor:` message scoped to status.
- **Do not** restart the self-hosted dev server. Playwright milestones use a **separate** server on a unique port (see "Playwright milestones").

---

## Task 1: Generalize turn-completion keying (foundation)

Make `recordTurnComplete` usable for non-terminal panes (no real `terminalId`) and replay-safe (monotonic dedupe), and add the sessionKey→pane mapping selector.

**Files:**
- Modify: `src/store/turnCompletionSlice.ts`
- Create: `src/store/turnCompletionAttention.ts`
- Test: `test/unit/client/store/turnCompletionSlice.test.ts` (extend if exists; else create)
- Test: `test/unit/client/store/turnCompletionAttention.test.ts`

- [ ] **Step 1: Failing test — monotonic dedupe**

```ts
// turnCompletionSlice.test.ts
import reducer, { recordTurnComplete } from '@/store/turnCompletionSlice'

it('dedupes by terminalId on non-increasing at (replay-safe)', () => {
  let s = reducer(undefined, recordTurnComplete({ tabId: 't', paneId: 'p', terminalId: 'term1', at: 100 }))
  expect(s.pendingEvents).toHaveLength(1)
  // replayed older/equal completion is ignored
  s = reducer(s, recordTurnComplete({ tabId: 't', paneId: 'p', terminalId: 'term1', at: 100 }))
  s = reducer(s, recordTurnComplete({ tabId: 't', paneId: 'p', terminalId: 'term1', at: 50 }))
  expect(s.pendingEvents).toHaveLength(1)
  // strictly newer completion records
  s = reducer(s, recordTurnComplete({ tabId: 't', paneId: 'p', terminalId: 'term1', at: 101 }))
  expect(s.pendingEvents).toHaveLength(2)
})

it('keys dedupe independently per sessionKey passed as terminalId (SDK panes)', () => {
  let s = reducer(undefined, recordTurnComplete({ tabId: 't', paneId: 'p1', terminalId: 'claude:abc', at: 10 }))
  s = reducer(s, recordTurnComplete({ tabId: 't', paneId: 'p2', terminalId: 'codex:def', at: 10 }))
  expect(s.pendingEvents).toHaveLength(2)
})
```

- [ ] **Step 2: Run red** — `npm run test:vitest -- test/unit/client/store/turnCompletionSlice.test.ts --run` → FAIL (second `at:100` currently `===` returns, but `at:50` would currently record because `50 !== 100`).

- [ ] **Step 3: Minimal impl** — change `recordTurnComplete` dedupe to monotonic:

```ts
recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
  const { terminalId, at } = action.payload
  const last = state.lastAtByTerminalId[terminalId]
  if (last !== undefined && at <= last) return
  state.lastAtByTerminalId[terminalId] = at
  state.seq += 1
  state.pendingEvents.push({ ...action.payload, seq: state.seq })
},
```

(`terminalId` remains the dedupe key; SDK callers pass a sessionKey string. `markTab/PaneAttention` already key on tabId/paneId, so nothing else changes.)

- [ ] **Step 4: Failing test — sessionKey→pane selector**

```ts
// turnCompletionAttention.test.ts
import { selectPaneBySessionKey } from '@/store/turnCompletionAttention'

it('maps a fresh-agent sessionKey to its tab+pane', () => {
  const state = makeStoreStateWithFreshAgentPane({ tabId: 'T', paneId: 'P', provider: 'claude', sessionId: 'abc' })
  expect(selectPaneBySessionKey(state, 'claude:abc')).toEqual({ tabId: 'T', paneId: 'P' })
})
it('maps an agent-chat sessionKey to its tab+pane', () => {
  const state = makeStoreStateWithAgentChatPane({ tabId: 'T', paneId: 'P', provider: 'claude', sessionId: 'xyz' })
  expect(selectPaneBySessionKey(state, 'claude:xyz')).toEqual({ tabId: 'T', paneId: 'P' })
})
it('returns null when no pane owns the sessionKey', () => {
  expect(selectPaneBySessionKey(makeEmptyState(), 'claude:none')).toBeNull()
})
```

- [ ] **Step 5: Run red.**

- [ ] **Step 6: Impl `src/store/turnCompletionAttention.ts`** — export `resolveFreshAgentSessionKey`/`resolveAgentChatSessionKey` from `pane-activity.ts` (currently module-local) and reuse them + `collectPaneEntries` to scan `state.panes.layouts`. Return `{ tabId, paneId } | null`. Match `content.kind === 'fresh-agent'` / `'agent-chat'` whose computed sessionKey equals the argument. (Mirror `selectTabPaneByTerminalId` in `src/store/selectors/paneTerminalSelectors.ts`.)

  > **TWO KEY NAMESPACES (load-bearing finding `sessionkey-shapes-match`):** the **dedupe/selector key** used for `recordTurnComplete.terminalId` and `selectPaneBySessionKey` is `provider:sessionId` (what `resolveFreshAgentSessionKey`/`resolveAgentChatSessionKey` return). The fresh-agent **slice-lookup key** (to read `state.freshAgent[...]`) is a *different* string: `makeFreshAgentSessionKey({sessionType, provider, sessionId})` (`freshAgentSlice.ts:36-38`). The Task-3 hook must read slice state via `makeFreshAgentSessionKey` (fresh-agent) / `sessionId` (agent-chat), but compute the dedupe + pane-selector key via `resolveFreshAgentSessionKey`/`resolveAgentChatSessionKey` (`provider:sessionId`). The test fixtures (`'claude:abc'`) are the `provider:sessionId` form. Mixing these silently returns `null` → no green for fresh-agent.

- [ ] **Step 7: Run green.**

- [ ] **Step 8: Commit** — `refactor(status): monotonic turn-complete dedupe + sessionKey→pane selector`.

---

## Task 2: Codex turn-complete server-authoritative (RC-2)

Emit `turn.complete` from `CodexActivityTracker`; broadcast it; remove codex from the client BEL gate. Kills replay re-green/re-chime, loose-count false green, and disconnect loss.

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts`
- Modify: `server/index.ts:427-449`
- Modify: `shared/ws-protocol.ts:156`
- Modify: `src/components/TerminalView.tsx` (the `mode !== 'claude'` gate)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (replay case)
- Test (integration): `test/server/*codex*turn-complete*.test.ts` (new)

- [ ] **Step 1: Failing unit test — tracker emits exactly once on a real turn, silent on stray/idle BEL**

```ts
const tracker = new CodexActivityTracker()
const events: any[] = []
tracker.on('turn.complete', (e) => events.push(e))
tracker.bindTerminal({ terminalId: 'tc', sessionId: 's', reason: 'start', at: 0 })
tracker.noteInput({ terminalId: 'tc', data: '\r', at: 1 })          // pending
// simulate task_started → busy via reconcileProjects OR onTurnStarted (Task 11)
tracker.reconcileProjects([projectWithStartedAt('s', 2)], 2)         // busy
tracker.noteOutput({ terminalId: 'tc', data: TURN_COMPLETE_SIGNAL, at: 3 }) // BEL clears busy
expect(events).toEqual([{ terminalId: 'tc', sessionId: 's', at: 3 }])

// stray BEL while idle does NOT emit
tracker.noteOutput({ terminalId: 'tc', data: TURN_COMPLETE_SIGNAL, at: 4 })
expect(events).toHaveLength(1)
```

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Impl — emit once per real turn-END, with cross-source dedupe.** Add a private completion buffer mirroring claude, BUT two load-bearing findings change the naive design:

  **(a) Emit only on the →idle branch, not "top of transition" (`codex-transitions-not-exactly-one-turn`).** `transitionAfterTurnClear` (`:323-343`) and `transitionPendingAfterTurnClear` (`:361-379`) BOTH re-arm to `phase='pending'` when `hasQueuedSubmit(state)` is true (back-to-back submits). A completion fired there would green mid-multi-turn. So record the completion **only when the transition resolves to `phase==='idle'`** (i.e. after the transition runs, check `state.phase==='idle'`), not unconditionally at the top.

  **(b) Per-turn dedupe across THREE emit sources (`codex-jsonl-bel-no-double` + onTurnCompleted).** Live BEL (`noteOutput`), JSONL reconcile (`reconcileProjects`), and the sidecar `onTurnCompleted` (Task 11) can all clear the same logical turn. Dedupe on a per-turn identity = the `acceptedStartAt`/`pendingSubmitAt` of the turn being cleared. Track `lastEmittedTurnKey` per state; only emit if the cleared turn's key differs from the last emitted.

```ts
export type CodexTurnCompleteEvent = { terminalId: string; sessionId?: string; at: number }
private pendingCompletions: CodexTurnCompleteEvent[] = []

// turnKey = the start identity of the turn that is ending (acceptedStartAt, else pendingSubmitAt).
private maybeRecordCompletion(state: CodexTerminalActivity, turnKey: number | undefined, at: number): void {
  if (turnKey === undefined) return
  if (state.phase !== 'idle') return            // re-armed to pending → not a turn END
  if (state.lastEmittedTurnKey === turnKey) return  // already emitted by another source
  state.lastEmittedTurnKey = turnKey
  this.pendingCompletions.push({
    terminalId: state.terminalId,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    at,
  })
}
private flushCompletions(): void {
  if (this.pendingCompletions.length === 0) return
  const out = this.pendingCompletions; this.pendingCompletions = []
  for (const c of out) this.emit('turn.complete', c)
}
```

  Capture `turnKey = state.acceptedStartAt ?? state.pendingSubmitAt` BEFORE the transition mutates state, run the transition, then `maybeRecordCompletion(state, turnKey, at)`. Do **not** emit from the `*LatentTurnClear` paths (association clears that never showed busy). Add `lastEmittedTurnKey?: number` to `CodexTerminalActivity`. Flush after `commitState` in `noteOutput`, after the loop in `reconcileProjects`, and in `onTurnCompleted` (Task 11). **Pending-decay does NOT emit** (`codex-pending-decay-no-emit`): a `pending` that decays via `expireState` without a BEL/task_completed/onTurnCompleted is a no-op submit, and correctly produces no green.

- [ ] **Step 3b: Failing test — back-to-back submits emit exactly ONE completion at final idle (Fresh-Eyes #1, round 2).** Because a clear with a queued submit re-arms to `pending` (`codex-activity-tracker.ts:330-337`, `:366-372`) — agent is still busy with the queued turn — the emit-on-`idle`-only rule correctly produces **no** completion on that intermediate re-arm. Sequence: submit1→busy, submit2 (queued), BEL clears turn1 → re-arms to `pending` (turn2) → **0 completions** (agent still busy); turn2 `task_started`→busy, BEL clears turn2 → `idle` → **1 completion total**. Assert exactly one `turn.complete` across the whole sequence, fired at final idle. And: a turn cleared by live BEL is NOT re-emitted when a later `reconcileProjects` sees the JSONL completion (same `turnKey`).

- [ ] **Step 4: Run green (unit).**

- [ ] **Step 5: Wire broadcast** — `shared/ws-protocol.ts:156` → `provider: z.enum(['opencode', 'claude', 'codex'])`. In `server/index.ts` after the claude block (`:449`):

```ts
codexActivity.tracker.on('turn.complete', (payload) => {
  wsHandler.broadcastTerminalTurnComplete({
    provider: 'codex',
    terminalId: payload.terminalId,
    at: payload.at,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
  })
})
```

> **ORDERING (Fresh-Eyes #2, round 2):** Task 2 broadcasts WITHOUT `seq` — identical in shape to the existing claude/opencode broadcasts (`server/index.ts:436-449`) — and the client handles codex exactly like claude/opencode today (`App.tsx` live handler → `recordTurnComplete`). So Task 2 is self-consistent and commits green on its own. The `seq` field (and the switch to the seq-gated `applyServerCompletion` thunk) is added **later in Task 4** for ALL three providers at once. This keeps each task's "run green + commit" valid.

- [ ] **Step 6: Update the existing codex client-completion test (Fresh-Eyes #8).** `test/unit/client/components/TerminalView.lifecycle.test.tsx:792-879` currently asserts a **live** codex BEL records a client-side turn completion. After codex leaves the client gate, that behavior is gone — **rewrite** that test to assert codex BEL no longer records a client-side completion (the server path now owns it), so the suite stays green. Then add the NEW replay test below.

- [ ] **Step 6b: Failing client replay test** — in `TerminalView.lifecycle.test.tsx`, mirror the existing claude replay-BEL test but for `mode: 'codex'`: feed a replayed scrollback frame containing a BEL and assert `store.getState().turnCompletion.pendingEvents` stays length 0.

- [ ] **Step 7: Impl client gate** — in `TerminalView.tsx`, change the dispatch gate from `mode !== 'claude'` to `mode !== 'claude' && mode !== 'codex'` so the client never mints codex turn-completes (live or replayed). Server is now the single source.

- [ ] **Step 8: Run green (client).**

- [ ] **Step 9: Integration test** — a detached/hidden codex pane: server emits one `terminal.turn.complete` on a busy-clearing BEL; reconnect replay of the same scrollback does NOT produce a second (server doesn't re-emit; client gate is off). Assert via superwstest-style harness mirroring existing opencode/claude turn-complete server tests.

- [ ] **Step 10: Commit** — `fix(status): make codex turn-complete server-authoritative (kills replay re-green)`.

---

## Task 3: SDK turn-complete + attention bridge (RC-1: idle completion + waiting-for-approval)

One listener-middleware/hook observes fresh-agent + agent-chat session edges and dispatches `recordTurnComplete` so the existing GREEN/SOUND pipeline fires for non-terminal panes — including waiting-for-approval (decision 2).

**Files:**
- Create: `src/hooks/useAgentSessionTurnCompletion.ts`
- Modify: `src/App.tsx` (mount it next to `useTurnCompletionNotifications`)
- Modify: `src/lib/pane-activity.ts` (export `isFreshAgentBusy`, `isAgentChatBusy` for reuse; do NOT change their logic here)
- Test: `test/unit/client/hooks/useAgentSessionTurnCompletion.test.tsx`
- Test (e2e): `test/e2e/fresh-agent-turn-complete-notification.test.tsx`

- [ ] **Step 1: Failing test — busy→idle fires once**

```tsx
// running → idle fires green+sound exactly once for a backgrounded fresh-agent pane
renderHookWithStore(useAgentSessionTurnCompletion, { preloaded: freshAgentRunning('claude:abc', tab='T', pane='P') })
act(() => store.dispatch(setSessionStatus({ ...id, status: 'idle' })))
expect(store.getState().turnCompletion.attentionByPane['P']).toBe(true)
expect(store.getState().turnCompletion.attentionByTab['T']).toBe(true)
```

- [ ] **Step 2: Failing test — guards (no spurious fire)**

```tsx
// idle-on-first-observe does NOT fire (attach/snapshot hydration of a finished session)
renderHookWithStore(useAgentSessionTurnCompletion, { preloaded: freshAgentIdle('claude:abc') })
expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)

// pending permission suppresses turn-complete but FIRES attention (decision 2)
// NOTE (Fresh-Eyes #9): use the REAL action shapes — fresh-agent:
//   addPermissionRequest({ sessionId, sessionType, provider, requestId, ...request })
// agent-chat: addPermissionRequest({ sessionId, requestId, ...request }).
act(() => store.dispatch(addPermissionRequest({ sessionId: 'abc', sessionType: 'freshclaude', provider: 'claude', requestId: 'perm1', /* ...request fields */ })))
expect(store.getState().turnCompletion.attentionByPane['P']).toBe(true)  // waiting-for-approval green

// resolving uses the REAL action name `removePermission` (Fresh-Eyes #4, round 2):
//   fresh-agent removePermission({sessionId, sessionType, provider, requestId}); agent-chat removePermission({sessionId, requestId}).
// Does NOT auto-clear here (see Step 4): green clears via engage.
act(() => store.dispatch(removePermission({ sessionId: 'abc', sessionType: 'freshclaude', provider: 'claude', requestId: 'perm1' })))
```

- [ ] **Step 3: Run red.**

- [ ] **Step 4: Impl `useAgentSessionTurnCompletion`** — select `freshAgentSessions`, `agentChatSessions`, and pane layouts. Keep a `useRef<Map<sessionKey, { wasBusy: boolean; hadPending: boolean }>>`. On each change:
  - compute `isBusy` via exported `isFreshAgentBusy`/`isAgentChatBusy`, and `hasPending = pendingPermissions||pendingQuestions non-empty`.
  - **Turn complete:** on an observed `wasBusy === true → isBusy === false && !hasPending` edge, look up pane via `selectPaneBySessionKey` (Task 1) and `dispatch(recordTurnComplete({ tabId, paneId, terminalId: sessionKey, at: Date.now() }))`.
  - **Waiting-for-approval:** on an observed `hadPending === false → hasPending === true` edge, dispatch `recordTurnComplete` likewise (green+sound). Keep `busy=false` in pane-activity (unchanged) so blue is off; green is the signal.
  - **Do NOT auto-clear on resolution (Fresh-Eyes #3).** The earlier "clear if pending→0 AND status still idle" rule is unsound: resolving a permission does NOT change `status` (`freshAgentSlice.ts:293-297`, `agentChatSlice.ts:346-349`), and after the agent resumes, `status` becomes `running` again → the auto-clear condition is false → green sticks WHILE blue resumes. Instead, rely on **engage-clear** (Task 10): the user's act of approving/denying is a click/keystroke on that pane, which clears its green via `handleFocus`/`term.onData`/composer-submit. A pending request resolved with NO user engagement (e.g. backgrounded auto-resolve — rare for permissions, which require a user answer) simply leaves green until the user visits, which is the correct "needs attention" semantics (and favors false-green over false-blue per decision 3).
  - **Critical guard:** never fire on the FIRST observation of a session (initialize the ref entry from the first snapshot without firing). This prevents spurious green on tab restore / snapshot hydration of an already-idle or already-pending session.
  - Must observe BOTH discrete reducers AND `freshAgentSnapshotReceived` (fresh-agent pending arrives via snapshots) — selecting the slice state covers both because the hook reacts to state, not actions.

- [ ] **Step 5: Run green.** Mount in `App.tsx`: `useAgentSessionTurnCompletion()` adjacent to the existing `useTurnCompletionNotifications()` call.

- [ ] **Step 6: e2e** — backgrounded fresh-agent (claude) finishes a turn → tab goes green + one sound; a backgrounded fresh-agent entering pending-permission → green + one sound; focused+active session completing → green, no sound. Reattach/snapshot of an already-idle session → no green, no sound.

- [ ] **Step 7: Commit** — `feat(status): green+sound for fresh-agent & agent-chat completion and waiting-for-approval`.

---

## Task 4: Durable turn-complete across reconnect/refresh (RC-3)

Deliver a completion that lands during a disconnect/refresh window **exactly once** — without double-notifying a client that already heard it live.

> **DESIGN (Fresh-Eyes #1 + load-bearing `no-unified-ready-activity-snapshot`/`monotonic-at-vs-seq-interaction`):** The naive ack design double-notifies: the **live** `terminal.turn.complete` has no `seq`/ack, so a client that heard a live completion, played sound, then refreshes, would receive the still-unacked marker and play again (`App.tsx:1032-1044` records live with no seq; `:800-835` re-requests all lists every `ready`). Fix with a **seq + client-persisted-state** model, no ack message:
> 1. Each tracker assigns a **monotonic per-terminal `completionSeq`** per completion and keeps only the **latest completion per terminalId** (`{completionSeq, at}` — bounded, no queue).
> 2. The **live** `terminal.turn.complete` carries `completionSeq`. Each `*.activity.list.response` carries `latestTurnCompletions: {terminalId, at, completionSeq}[]` (latest per terminal).
> 3. **NAMING (Fresh-Eyes #2, round 3):** the server/durable sequence is `completionSeq` — a **distinct** field from the existing client-local `pendingEvents[].seq` (a reducer-generated global cursor in `turnCompletionSlice.ts:10,36`; leave it untouched and locally generated). A **thunk** `applyServerCompletion({terminalId, provider, at, completionSeq})` (NOT a slice reducer — Fresh-Eyes #3, round 2: `TurnCompleteEvent` requires `tabId`+`paneId` which only the caller can resolve) does: read `state.turnCompletion.lastAppliedCompletionSeqByTerminalId[terminalId]`; if `completionSeq` is not newer, no-op; else resolve the pane via `selectTabPaneByTerminalId` (as the live handler already does at `App.tsx:1036`) and dispatch `recordTurnComplete({ tabId, paneId, terminalId, at, completionSeq })`. `recordTurnComplete` gains an **optional `completionSeq`**: when present it dedupes on `completionSeq` (recording `lastAppliedCompletionSeqByTerminalId`) instead of the `at` guard, and still assigns its own local `pendingEvents[].seq`. If no pane currently owns the terminal (detached/no layout), skip — a later list-response re-offers it once a pane exists. Both the live `terminal.turn.complete` handler and the three `*.activity.list.response` handlers call this same thunk. Note `completionSeq` is **per-tracker/provider scoped** (not global), so dedupe is keyed per `terminalId` — out-of-order completions across providers are independent.
> 4. **Persist** `lastAppliedCompletionSeqByTerminalId` **and** `attentionByTab`/`attentionByPane` to localStorage (via `persistMiddleware`). On refresh, the client rehydrates the applied `completionSeq` (so the list-response's same-`completionSeq` latest is `<=` lastApplied → no replay) AND the green attention (so it stays shown). On a true disconnect, the missed completion's `completionSeq` is `> lastApplied` → applied once. No ack, no client→server state push.

**Files:**
- Modify: `server/coding-cli/claude-activity-tracker.ts`, `codex-activity-tracker.ts`, `opencode-activity-tracker.ts` (assign monotonic per-terminal `completionSeq` per completion; keep `latestCompletion[terminalId]={completionSeq,at}` **outside** the busy-record map so opencode idle-remove doesn't drop it; `listLatestCompletions()`)
- Modify: `shared/ws-protocol.ts` (`TerminalTurnCompleteSchema` gains `completionSeq`; each `*.activity.list.response` gains `latestTurnCompletions?: { terminalId, at, completionSeq }[]`)
- Modify: `server/ws-handler.ts` (`broadcastTerminalTurnComplete` includes `completionSeq`; attach `latestTurnCompletions` to each `*.activity.list.response`)
- Modify: `src/store/turnCompletionSlice.ts` (add `lastAppliedCompletionSeqByTerminalId`; extend `recordTurnComplete` payload with optional `completionSeq` → when present, dedupe on `completionSeq` and record it; the local `pendingEvents[].seq` cursor is UNCHANGED; mark attention + applied-completionSeq for persistence)
- Create: `src/store/turnCompletionThunks.ts` (or co-locate) — `applyServerCompletion({terminalId, provider, at, completionSeq})` thunk: completionSeq-gate against state, resolve pane via `selectTabPaneByTerminalId`, dispatch `recordTurnComplete({tabId, paneId, terminalId, at, completionSeq})`
- Modify: `src/store/persistMiddleware.ts` (persist+rehydrate the `turnCompletion` attention + `lastAppliedCompletionSeqByTerminalId`)
- Modify: `src/App.tsx` (the live `terminal.turn.complete` handler and the three `*.activity.list.response` handlers both dispatch the `applyServerCompletion` thunk)
- Test: tracker unit (seq monotonic; latest survives idle-remove), slice unit (seq-gated apply is idempotent; rehydrated seq suppresses replay), ws-handler/integration (completion during disconnect delivered once on reconnect; a client that heard it live does NOT replay after refresh)

- [ ] **Step 1: Failing tracker test** — completion increments a monotonic per-terminal `completionSeq`; `listLatestCompletions()` returns the latest per terminal; the latest is **not** dropped when the opencode busy record is removed on idle.
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Failing slice + thunk tests** — (slice) `recordTurnComplete({tabId,paneId,terminalId,at,completionSeq})` pushes a pending event (with its own local `seq`) and sets `lastAppliedCompletionSeqByTerminalId`; a second dispatch with same/lower `completionSeq` is a no-op; with `lastAppliedCompletionSeqByTerminalId` pre-seeded (rehydrated), a same-`completionSeq` dispatch is dropped. (thunk) `applyServerCompletion` resolves the pane via `selectTabPaneByTerminalId` and dispatches `recordTurnComplete` with the resolved `tabId/paneId`; when no pane owns the terminal it dispatches nothing.
- [ ] **Step 4: Run red → impl → green.**
- [ ] **Step 5: Failing integration test** — (a) codex/claude/opencode turn completes while the only client is disconnected; on reconnect the `*.activity.list.response` carries `latestTurnCompletions`, client applies exactly one (green+sound). (b) A client that heard the live completion (`completionSeq` applied + persisted) then refreshes: the list-response's same-`completionSeq` latest does NOT re-fire (no double sound), and green is restored from persisted attention. (c) cross-provider out-of-order: completions on two terminals with independent `completionSeq` both apply (per-terminal keying).
- [ ] **Step 6: Impl** the live `seq`, list-response attachment, seq-gated `applyServerCompletion`, and persistence. Run green.
- [ ] **Step 7: Commit** — `fix(status): durable, replay-safe turn-complete via seq + persisted attention`.

> **Checkpoint:** This task touches the live path (Task 2's broadcast must also carry `seq`) and persistence. Keep `recordTurnComplete` (Task 1/3, `at`-keyed) for SDK panes — their green also survives refresh via the persisted attention, and the busy→idle hook's first-observe guard prevents re-firing on rehydrate. If the seq plumbing balloons, the fallback is a 30–60s server replay queue on reconnect, but seq+persist is preferred and strictly avoids double-notify.

---

## Task 5: opencode deadman + idle-read watchdog (RC-4)

> **PLACEMENT CORRECTION (load-bearing `opencode-tracker-no-deadman-no-interval`):** the tracker has NO `expire`/`lastObservedAt`, its constructor injects only `setTimeoutFn`/`clearTimeoutFn`/`now`/`random`, and `consumeEvents` is a **private tracker method**. The wiring (`wireOpencodeActivityTracker`) has NO `setIntervalFn`/`clearIntervalFn` param (unlike the claude/codex wirings). So: `expire`+`lastObservedAt`+the read-stall watchdog all live IN THE TRACKER; the interval injection is ADDED to the wiring (mirroring claude/codex wirings).

**Files:**
- Modify: `server/coding-cli/opencode-activity-tracker.ts` (add `lastObservedAt` to each record refreshed on every SSE/snapshot observation; add public `expire(at)` that `removeRecord`s busy records older than `OPENCODE_BUSY_DEADMAN_MS` ~120_000 — opencode has no `idle` phase; add the read-stall watchdog inside the private `consumeEvents`)
- Modify: `server/coding-cli/opencode-activity-wiring.ts` (add injectable `setIntervalFn`/`clearIntervalFn` params mirroring `codex-activity-wiring.ts`; schedule a 5s `tracker.expire(now())` sweep; clear it in `dispose`)
- Test: tracker unit (stale record removed by `expire`; watchdog reconnect on read stall), wiring unit (sweep scheduled with injected interval and cleared on dispose)

- [ ] **Step 1: Failing test** — a `busy` record whose `lastObservedAt` is older than the deadman is removed by `expire(now)`; refreshed on any SSE/snapshot observation; the wiring schedules `expire` via the injected interval and clears it on dispose.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Impl** deadman + sweep mirroring claude/codex (`expire` **removes** the record). Add the watchdog in the tracker's `consumeEvents` (using the injected `setTimeoutFn`) that aborts/reconnects the read cycle if no bytes within a bounded interval, resetting on **any** received SSE block (not just status events) so a genuinely long turn isn't torn down.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `fix(status): opencode busy deadman + idle-read watchdog (no stuck blue)`.

---

## Task 6: SDK idle broadcast on natural end + error (RC-4)

> **BUSY = `streamingActive || status==='running'` (load-bearing `sdk-status-idle-doesnt-clear-streaming`):** `setSessionStatus` sets `status` ONLY; it does not clear `streamingActive` (`agentChatSlice.ts:371-377`, `freshAgentSlice.ts:277-281`). So broadcasting `sdk.status: idle` alone will NOT clear blue if `streamingActive` is stuck. The client handler for `sdk.status: 'idle'` (and the `sessionError` reset) MUST also clear `streamingActive`.

**Files:**
- Modify: `server/sdk-bridge.ts` (`consumeStream`: natural-end else-branch ~`:343-350` and catch ~`:322-328` broadcast `{ type: 'sdk.status', sessionId, status: 'idle' }` after setting `state.status='idle'`)
- Modify: `src/lib/sdk-message-handler.ts` + `src/lib/fresh-agent-ws.ts` (on `sdk.status: 'idle'`, dispatch a reducer that clears `streamingActive` in addition to setting status — extend `setSessionStatus` to clear `streamingActive` when status is a terminal/idle value, or add `markSessionIdle`)
- Modify: `src/store/agentChatSlice.ts` (`sessionError` clears `streamingActive`, resets `running`→`idle` for non-`RESTORE_*` codes; idle-status path clears `streamingActive`), `src/store/freshAgentSlice.ts` (same)
- Test: server unit (bridge broadcasts status/idle on natural end without `result`, and on error), client unit (`sdk.status idle` and `sessionError` both leave `isAgentChatBusy`/`isFreshAgentBusy` false — i.e. `streamingActive` cleared AND status non-running; `pendingEvents` unchanged — error ≠ completion)

- [ ] **Step 1: Failing server test** — after a stream ends without a `result` message, and after a thrown error, the bridge broadcasts an idle status.
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Failing client test** — handling `sdk.status: 'idle'` clears `streamingActive` so `isFreshAgentBusy`/`isAgentChatBusy` return false; `sessionError` (non-RESTORE) clears `streamingActive` and sets `idle`; `pendingEvents` unchanged (no spurious green).
- [ ] **Step 4: Run red → impl → green.**
- [ ] **Step 5: Commit** — `fix(status): clear SDK blue (streamingActive+status) on stream-end and error`.

---

## Task 7: opencode association-gated completion (RC-3, decision 3)

> **DECISION (Fresh-Eyes #4 + #5):** Do **NOT** emit on the reject path. `bindSession` failure includes `session_already_owned` (`opencode-session-controller.ts:110-118`, `terminal-registry.ts:3764-3775` — another terminal owns the session); emitting a terminal-scoped completion there would **false-green** the candidate after ownership was explicitly denied (and the real owner emits its own). Also the reject types require a `sessionId: string` (`opencode-ownership-reducer.ts:73-77`, `opencode-activity-tracker.ts:41-45`), so omitting it would not compile. A rejected association means "this is not your turn" → **no green is the correct outcome** (a missed-green at worst, never a false-green). The fix is purely the **snapshot→association-gated** path: candidate idles route through `awaitingAssociation`+`requestAssociation`, and only the controller-driven **confirm** emits `turnComplete` (with the real `sessionId`). The SNAPSHOT `knownBusy`→quiet branch (`:322-328`) does NOT emit today (only SSE-idle `knownBusy`→quiet at `:230-242` does), so that direct emit (sessionId trusted) is the only other addition.

**Files:**
- Modify: `server/coding-cli/opencode-ownership-reducer.ts` — (a) `reduceSnapshot` candidate→quiet (`:342-348`): transition to `awaitingAssociation` and emit **BOTH `activityRemove` AND `requestAssociation`** (Fresh-Eyes #6, round 2: keep `activityRemove` to clear blue — the controller's later `turnComplete` does NOT remove the activity record (`opencode-activity-tracker.ts:595`), so dropping `activityRemove` here would leave the pane stuck blue), mirroring the SSE-idle `reduceIdle` candidate branch (`:214-227`); (b) `reduceSnapshot` `knownBusy`→quiet (`:322-328`): keep `activityRemove` and add a direct `turnComplete` emit (sessionId trusted). **No reject-path change.**
- Test: `test/unit/server/coding-cli/opencode-ownership-reducer.test.ts` — the existing "never emits turn completion from snapshots" test is replaced with: candidate snapshot-idle → **`activityRemove` + `requestAssociation`** (no direct turnComplete, blue cleared); `knownBusy` snapshot-idle → `activityRemove` + direct turnComplete; reject of an awaiting association → NO turnComplete (no false-green); disconnect-gap first-turn (candidate busy → stream drop → reconnect snapshot empty → `activityRemove`+requestAssociation → **confirm** → turnComplete).

- [ ] **Step 1: Failing reducer tests** (snapshot association-gated; reject emits nothing).
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Perf guard (decision 3)** — the association round-trip adds one confirm/reject per first-turn-in-disconnect-gap, not per turn. Add a test asserting no extra association traffic on the steady-state SSE-idle path. If a perf regression appears in the Playwright milestone, fix it or stop and report.
- [ ] **Step 4: Commit** — `fix(status): opencode first-turn completion via association round-trip (snapshot)`.

---

## Task 8: claude bound-before-created ordering (RC-3)

> **SCOPE CUT (Fresh-Eyes #7):** the planned resume-busy **seeding** is dropped. `claude-activity-wiring.ts:24-50` has no session indexer / unresolved-turn source (`registry-events.ts:18-23` provides only terminal/provider/session/reason), so seeding every `reason==='resume'` would turn already-idle resumed Claude sessions **blue until the 120 s deadman** (`claude-activity-tracker.ts:165-181`) — a long-lived false-blue, which decision 5 forbids. Without an "unresolved turn" signal there is no safe seed. Keep only the **bound-before-created ordering** fix (safe hygiene). Document the resume-mid-turn missed-green as a known limitation (needs a claude turn-state source — deferred).

**Files:**
- Modify: `server/coding-cli/claude-activity-wiring.ts` — make `onBound` resilient to firing before `terminal.created` (lazily `trackTerminal` first, or also track on `terminal.session.bound`) so the record + sessionId exist regardless of event order.
- Test: wiring test emitting `terminal.session.bound` BEFORE `terminal.created` (production order) asserts the record exists with its sessionId (phase `idle` — no seeding).

- [ ] **Step 1: Failing wiring test** (bound-before-created → record exists).
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Commit** — `fix(status): claude resilient bind/create ordering`.

---

## Task 9: De-advertise gemini/kimi (RC-1, decision 4)

> **NOTE (load-bearing `gemini-kimi-already-count-zero`):** `extractTurnCompleteSignals(..., 'gemini')` already returns `count: 0` because shared `supportsTurnSignal` is claude/codex-only. So removing the normalizer branches changes NO turn-complete behavior — it's a consistency/clarity refactor (stop the client implying a capability the shared gate rejects) + docs. The meaningful test is on the normalizer's mapping, so **export `normalizeTurnCompleteSignalMode`** and assert it.

**Files:**
- Modify: `src/lib/turn-complete-signal.ts` — `export` `normalizeTurnCompleteSignalMode`; remove `case 'gemini'` / `case 'kimi'` so they fall to `'shell'`, agreeing with shared `supportsTurnSignal`.
- Modify: `AGENTS.md` (or `docs/`) — document gemini/kimi terminal modes as status-inert (no blue/green/sound) pending a real turn-complete signal.
- Test: `test/unit/client/lib/turn-complete-signal.test.ts` — `normalizeTurnCompleteSignalMode('gemini') === 'shell'` and `'kimi' === 'shell'` (post-change), while `'claude'`/`'codex'`/`'opencode'` are preserved. (Not a tautology: it pins the normalizer↔`supportsTurnSignal` contract.)

- [ ] **Step 1: Failing test** — normalizer maps gemini/kimi → `'shell'` (currently returns `'gemini'`/`'kimi'` → red).
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Commit** — `refactor(status): de-advertise gemini/kimi (normalizer↔supportsTurnSignal consistency)`.

---

## Task 10: Robust GREEN clearing — both gestures dismiss (RC-6, decision 1)

Keep marking green (incl. active+idle). Make a **pane click** and a **real keystroke** both clear the focused pane+tab in **both** modes; fix multi-pane clearing; gate type-mode clearing to real engagement. `attentionDismiss` governs only background-tab navigation clearing.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (`handleFocus`)
- Modify: `src/components/TerminalView.tsx` (`sendInput({synthetic})`; `term.onData` real-engagement clear; clear in both modes)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (clear attention on real input submit)
- Modify: `src/components/agent-chat/AgentChatView.tsx` / `ChatComposer.tsx` (clear attention on `sdk.send` submit — **Fresh-Eyes #2**: legacy agent-chat is in scope and was omitted; `AgentChatView.tsx:739-757` sends without clearing today)
- Modify: `src/components/TabItem.tsx` (drop `&& tab.status==='running'` at BOTH `:18` and `:72`)
- Modify: `src/hooks/useTurnCompletionNotifications.ts` (`:80-92`) AND `src/components/TabBar.tsx` (`:333-339`) — the tab-switch / tab-click clear paths currently clear only the tab + **active** pane; extend them to clear **all panes of the tab** (collect via the tab's layout), else a background split tab where pane B has attention and pane A is active stays green on pane B after switching in (Fresh-Eyes #1, round 3 — `PaneContainer.tsx:503` renders headers from `attentionByPane[node.id]`). Keep the `attentionDismiss` ('click' vs 'type') gate on these *tab-navigation* paths (decision 1: it governs background-tab clearing). Active-tab marking is unchanged; the existing persistence test stays valid per decision 1.
- Tests: PaneContainer (any in-tab pane focus clears tab+ALL panes, both modes), useTurnCompletionNotifications/TabBar (switching to a split tab clears ALL its panes in 'click' mode), TerminalView (printable/Enter clears; arrow/synthetic does not), TabItem (multi-pane busy + tab.status='exited' → blue), FreshAgentView + AgentChatView (submit AND permission-response clear attention)

- [ ] **Step 1: Failing test — handleFocus clears tab + ALL panes on any in-tab pane focus (both modes)**

```tsx
// pane-B completed → attentionByPane['B'] and attentionByTab['T'] set.
// Focus pane-A → assert clearTabAttention('T') AND clearPaneAttention('B') (and 'A') dispatched.
// Repeat for both attentionDismiss modes (click and type).
```

- [ ] **Step 1b: Failing test — permission/question response clears attention**: a backgrounded fresh-agent/agent-chat pane in waiting-for-approval (green); invoking the approve/deny (or answer) handler dispatches clearPaneAttention+clearTabAttention for that pane's tab (Fresh-Eyes #8).

- [ ] **Step 2: Failing test — TabItem single dot**: multi-pane tab, `iconsOnTabs=false`, `busyPaneIds` non-empty, `tab.status='exited'` → dot is `fill-blue-500`.

- [ ] **Step 3: Failing test — real-engagement gating (via `term.onData`)**: feeding `term.onData('x')` clears attention; `'\r'` (Enter) clears; `'\x1b[A'` (arrow) does NOT clear; `'\x1b[200~paste\x1b[201~'` clears (paste); and a `sendInput(data, { synthetic: true })` from scroll-translation/DECRQM does NOT clear (it no longer routes through the clear path). Cover both `attentionDismiss` modes.

- [ ] **Step 4: Run red.**

- [ ] **Step 5: Impl** (load-bearing `sendinput-no-synthetic-clears-any-data-type-mode` + `tabitem-double-running-gate`):
  - `PaneContainer.handleFocus` (`:346-352`): on focus, clear the **tab AND every pane in that tab** — not just the focused pane (Fresh-Eyes #7, round 2: pane headers render from `attentionByPane[node.id]` at `:503`; clearing only the focused pane leaves a sibling pane's header green after the user has visited the tab). Collect the tab's pane IDs from its layout (`collectPaneEntries`) and `dispatch(clearPaneAttention({paneId}))` for each, plus `dispatch(clearTabAttention({tabId}))` — unconditionally (remove BOTH the `attentionDismiss==='click'` gate and the "only if this pane has attention" gate). Then `setActivePane`. (Rationale: focusing any pane means the user is viewing the tab; a split shows all panes, so all are "seen".)
  - `TerminalView.tsx`: the attention-clear currently lives INSIDE `sendInput` (`:662-676`, `'type'`-mode, any data), which is also called by scroll-translation (`:691`) and startup/DECRQM auto-replies (`:1081`). **Move the clear OUT of `sendInput`** into the `term.onData` handler (`:1426-1427`, real user typing). **Predicate (Fresh-Eyes #5, round 2 — arrows must NOT clear):** a bare arrow/cursor key is `\x1b[A`/`\x1b[B`/`\x1b OA`… which contains printable `[`/`A`, so a naive "has printable char" test wrongly clears. Instead, **strip recognized ANSI escape sequences** (CSI `\x1b[…final`, SS3 `\x1bO…`, OSC) from `data` first, then clear pane+tab attention iff the remainder contains a printable char (`[^\x00-\x1f\x7f]`) or a CR/LF — in **both** modes. So `\x1b[A` → strips to `''` → no clear; `x` → clear; `\r` → clear; a bracketed paste `\x1b[200~text\x1b[201~` → strips markers → `text` → clear (paste is engagement). `sendInput` keeps a `{ synthetic?: boolean }` option only if still needed elsewhere; synthetic callers no longer clear because the clear no longer lives in `sendInput`.
  - `FreshAgentView.tsx` AND `AgentChatView.tsx`/`ChatComposer.tsx`: dispatch the same tab+all-panes clear on (a) send/submit of a real message, AND (b) **permission/question response handlers** — approve/deny/answer (Fresh-Eyes #8, round 2: those are child-button activations that bypass `Pane`'s mousedown/keydown focus at `Pane.tsx:64`, so a keyboard approval would otherwise leave waiting-for-approval green stuck; `FreshAgentView.tsx:890` and `AgentChatView.tsx:773` only send the response today). Responding to a permission/question IS engagement → clear that pane's tab green.
  - `TabItem.tsx`: drop `&& tab.status==='running'` at **BOTH** sites — the `StatusDot` internal (`:18`) AND the call site (`:72`) — so `busy ? 'fill-blue-500' : getTerminalStatusDotClassName(status)`.

- [ ] **Step 6: Run green.**

- [ ] **Step 7: Commit** — `fix(status): green clears on any real engagement; fix multi-pane + single-dot`.

---

## Task 11: Codex blue onset (decision 5: C + A) + restore-window blue (RC-5, RC-4)

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` — add `onTurnStarted(terminalId, at)` → `promoteBusy` immediately; `onTurnCompleted(terminalId, at)` → clear + emit turn.complete (reuses Task 2 emit). `reconcileProjects` stays as fallback.
- Modify: `server/terminal-registry.ts` — **the registry has no activity-tracker reference and is constructed before `wireCodexActivityTracker` (Fresh-Eyes #6)**, so it cannot call the tracker directly. Instead, at the sidecar subscription callback (`:1697-1711`) **emit a registry event** (e.g. `codex.turn.started` / `codex.turn.completed` with `{terminalId, at}`) — emitted BEFORE/independent of the durability early-returns inside `handleCodexTurnStarted`/`handleCodexTurnCompleted` (`:2023`, `:2053`), so `durable` sessions still get instant blue (load-bearing `codex-turn-event-gating`). Add the event to `server/terminal-stream/registry-events.ts` if needed.
- Modify: `server/coding-cli/codex-activity-wiring.ts` — subscribe to the new `codex.turn.started`/`codex.turn.completed` registry events (the wiring already has both the registry event stream and the tracker) and call `tracker.onTurnStarted(terminalId, at)` / `tracker.onTurnCompleted(terminalId, at)`. The sidecar is present for terminal-mode codex (`codex-sidecar-turn-events-terminal-mode`); `reconcileProjects` stays as the fallback for any path without it.
- Modify: `src/lib/pane-activity.ts` — codex branch returns busy for `phase === 'busy' || phase === 'pending'` (A). Ensure no-op pending decays to idle quickly (server sweep already flips pending→idle; verify the decay path so blue can't linger long-term).
- Modify: `src/lib/pane-activity.ts` — `isFreshAgentBusy`/`isAgentChatBusy`: when `session == null`, return `false` (do not treat persisted `content.status` as live busy → kills reload blue flash).
- Tests: codex tracker (`onTurnStarted` promotes busy instantly; `onTurnCompleted` emits turn.complete; no-op submit pending decays to idle → blue clears), pane-activity (`pending`→busy; `session==null`→not busy)

- [ ] **Step 1: Failing test — onTurnStarted promotes busy immediately** (no reconcile needed); **onTurnCompleted** clears + emits turn.complete.
- [ ] **Step 2: Failing test — pane-activity** renders codex `pending` as busy; and `isFreshAgentBusy({status:'running'}, undefined)` (no session) returns `false`.
- [ ] **Step 3: Failing test — no long-term false blue**: a submit (`pending`) with no `task_started`/`onTurnStarted` and no output decays to idle within the bounded window (assert via `expire(at)` past the gate); blue clears.
- [ ] **Step 4: Run red → impl → green.** For C, read `terminal-registry.ts` `handleCodexTurnStarted`/`onTurnStarted` and route into `codexActivity.tracker.onTurnStarted/onTurnCompleted`.
- [ ] **Step 5: Commit** — `feat(status): instant accurate codex blue via onTurnStarted (+pending), fix reload blue flash`.

---

## Task 12: Hygiene (RC-4 tail + dead code)

**Files:**
- Modify: `src/App.tsx:~493` — add `resetOpencodeActivityOverlay()` alongside the codex/claude resets in the auth-failure handler.
- Delete: `src/lib/tab-codex-activity.ts` (no callers).
- Test: grep confirms no imports of the deleted file; auth-failure handler test asserts all three overlays reset.

- [ ] **Step 1: Failing/adjusted test** for the auth-failure overlay reset (all three).
- [ ] **Step 2: Impl + delete dead file.** Verify with `grep -rn "tab-codex-activity" src test` → no results.
- [ ] **Step 3: Run green.**
- [ ] **Step 4: Commit** — `chore(status): reset opencode overlay on auth-fail; delete dead tab-codex-activity`.

---

## Task 13: Docs, full verify, and Playwright milestone

- [ ] **Step 1:** Update `docs/index.html` if the status indicators (busy/attention dots) are represented in the mock; reflect that fresh-agent/agent-chat now show green+sound. (Minor; the mock is nonfunctional.)
- [ ] **Step 2:** Update `AGENTS.md` / code comments: codex turn-complete is now server-authoritative; gemini/kimi are status-inert.
- [ ] **Step 3:** `npm run lint` (a11y) → fix any new violations.
- [ ] **Step 4:** Coordinated full suite: `FRESHELL_TEST_SUMMARY="tab-status-reliability full verify" npm test` → all green.
- [ ] **Step 5:** `npm run check` (typecheck + suite) → green.
- [ ] **Step 6:** Playwright milestone (separate server — see below).
- [ ] **Step 7:** Commit any doc/lint fixes — `docs(status): reflect status-indicator behavior`.

---

## Playwright milestones (after major checkpoints)

Run after **Task 2** (codex), after **Task 3** (SDK green/sound + waiting-for-approval), and at **Task 13** (full). Use a **separate** production server on a unique port; never touch the self-hosted dev server.

```bash
# from the worktree
cd /home/dan/code/freshell/.worktrees/tab-status-reliability
npm run build   # build guard is fine in a worktree
PORT=3955 npm start > /tmp/freshell-3955.log 2>&1 & echo $! > /tmp/freshell-3955.pid
# verify it belongs to the worktree before any later stop:
ps -fp "$(cat /tmp/freshell-3955.pid)"
# ... drive via the freshell MCP tools / Playwright: open a codex tab, submit, background it,
#     assert the tab dot goes blue→green and a sound fires; refresh and assert NO re-green.
#     open a freshclaude tab, submit, background it, assert green+sound; trigger a permission
#     prompt and assert green+sound; click the pane / type and assert it clears.
# stop ONLY our server:
kill "$(cat /tmp/freshell-3955.pid)" && rm -f /tmp/freshell-3955.pid
```

Manual acceptance checklist:
- codex: blue on submit (instant), green+sound on idle when backgrounded, **no** re-green/re-chime on refresh.
- freshclaude/freshcodex/freshopencode: blue on submit, green+sound on idle when backgrounded.
- waiting-for-approval: green+sound when backgrounded; clears on resolve/engage.
- green clears on pane click AND on a real keystroke (both `attentionDismiss` modes).
- gemini/kimi: no misleading status (inert).
- no stuck blue after opencode stall / SDK error.

---

## Self-Review (run before load-bearing)

**1. Spec coverage:** every product decision maps to a task — D1→T10, D2→T3, D3→T7, D4→T9, D5→T11. Every RC maps: RC-1→T3/T9, RC-2→T2, RC-3→T4/T7/T8, RC-4→T5/T6/T11, RC-5→T11, RC-6→T10. Hygiene→T12.

**2. Placeholder scan:** no TBD/"handle edge cases"; each task names exact files + the test to write. The two genuinely open design choices (Task 4 durable-marker vs replay-queue; Task 7 reject-all vs suppress-`session_already_owned`) are flagged as explicit checkpoints, not placeholders.

**3. Type consistency:** `recordTurnComplete` keeps `{tabId,paneId,terminalId,at}` (SDK passes sessionKey as `terminalId`); `CodexTurnCompleteEvent` mirrors `ClaudeTurnCompleteEvent`; `provider` enum gains `'codex'` everywhere `TerminalTurnComplete` is used.

## Load-bearing findings (resolved — validated by direct code inspection)

All assumptions were validated by reading the actual code (the cheapest reliable method). Resolutions are folded into the tasks above:

- **`sessionkey-shapes-match` (high):** fresh-agent slice-lookup key = `makeFreshAgentSessionKey(...)`; dedupe/selector key = `provider:sessionId`. Two namespaces — see Task 1 Step 6 callout.
- **`codex-transitions-not-exactly-one-turn` + `codex-jsonl-bel-no-double` (high):** both clear-transitions re-arm to `pending` on queued submits, and there are 3 emit sources (BEL, JSONL, sidecar `onTurnCompleted`). Resolved by `maybeRecordCompletion` (emit only on →idle, per-turn dedupe via `lastEmittedTurnKey`) — Task 2 Step 3.
- **`codex-pending-decay-no-emit` (medium):** pending decay does NOT emit — correct (no-op submits shouldn't green) — Task 2 Step 3.
- **`codex-turn-event-gating` / `…-terminal-mode` (medium):** tap sidecar events at the subscription, before durability gates — Task 11.
- **`sdk-status-idle-doesnt-clear-streaming` (high):** busy reads `streamingActive`; idle path must clear it — Task 6 callout.
- **`no-unified-ready-activity-snapshot` + `monotonic-at-vs-seq-interaction` (high):** no ready-snapshot; piggyback on `*.activity.list.response` + ack; seq-based idempotency — Task 4 callout.
- **`opencode-tracker-no-deadman-no-interval` (high):** `expire`/`lastObservedAt`/watchdog live in the tracker; interval injection added to the wiring — Task 5 callout.
- **`reject-has-no-reason-param` (medium):** terminal-scoped reject-all-emits (omit sessionId); snapshot `knownBusy` needs a new emit — Task 7 callout.
- **`gemini-kimi-already-count-zero` (low):** count already 0; Task 9 is a consistency refactor + docs; test the normalizer mapping — Task 9 callout.
- **`sendinput-no-synthetic-clears-any-data-type-mode` + `tabitem-double-running-gate` (medium/low):** move clear into `term.onData`; edit both TabItem sites — Task 10 Step 5.
- **`exports-missing-in-pane-activity` (low):** export 4 functions from `pane-activity.ts` — file map updated.
- **`terminalid-only-dedupe-downstream`, `codex-tracker-has-no-turn-events`, `turn-complete-schema-provider-enum`, `opencode-record-removed-on-idle`, `authfail-handler-missing-opencode-reset` (confirmed):** the plan's assumptions hold as written.

## Fresh Eyes round 1 corrections (applied)

GPT/codex independent review (FAILED → corrected) surfaced 9 blocking defects, all folded in:

1. **Durable double-notify** — live `terminal.turn.complete` had no `seq`; redesigned Task 4 around live-path `seq` + client-persisted `lastAppliedSeqByTerminalId` + persisted attention (no ack message). 2. **Task 10 omitted agent-chat** clear-on-engage → added `AgentChatView`/`ChatComposer`. 3. **Pending-permission status-based auto-clear could stick green** → removed; rely on engage-clear. 4. **opencode reject-all false-greens `session_already_owned`** + 5. **wouldn't compile (sessionId required)** → dropped reject-path emit; snapshot→association-gated confirm only. 6. **Task 11 registry→tracker dependency missing** → route via a new registry event consumed by `wireCodexActivityTracker`. 7. **Claude resume seeding had no unresolved-turn source (false-blue)** → cut seeding; kept ordering-only. 8. **Task 2 broke `TerminalView.lifecycle.test.tsx:792-879`** → added a step to rewrite it. 9. **Task 3 red-test used nonexistent action payloads** → corrected to real `addPermissionRequest` shapes.

## Fresh Eyes round 2 corrections (applied)

Second GPT/codex review (FAILED → corrected) found 8 deeper defects, all folded in:

1. **Task 2 emit-on-idle vs back-to-back test contradiction** → Step 3b rewritten: queued submits emit exactly ONE completion at final idle, none on the re-arm. 2. **Task 2 used `seq` before Task 4 adds it** → Task 2 broadcasts seq-less (like claude/opencode); Task 4 adds `seq` to all three. 3. **`applyServerCompletion` reducer can't build a `tabId/paneId` event** → made it a thunk that resolves the pane + seq-gates, dispatching `recordTurnComplete` (now with optional `seq`). 4. **`removePermissionRequest` doesn't exist** → real name `removePermission`. 5. **arrow key `\x1b[A` contains printable `[A`** → strip ANSI escapes before the printable/CR-LF test. 6. **candidate-idle dropped `activityRemove` → stuck blue** → keep `activityRemove` + add `requestAssociation`. 7. **clearing only the focused pane left a sibling pane green** → clear the tab AND all panes of the tab on focus. 8. **keyboard permission approval bypasses pane focus** → permission/question response handlers also clear attention.

## Fresh Eyes round 3 corrections (applied)

Third GPT/codex review (FAILED → corrected; issues narrowed 9→8→3, converging) found 3 defects, all folded in:

1. **Tab-navigation clear paths omitted** — `TabBar.tsx:333-339` + `useTurnCompletionNotifications.ts:80-92` clear only the active pane → a sibling pane stays green when switching INTO a split tab. Now both clear ALL panes of the tab. 2. **`seq` name collision** — server completion seq vs the existing client-local `pendingEvents[].seq` cursor. Renamed the server/durable field to **`completionSeq`** (per-terminal scoped), `pendingEvents[].seq` left untouched. 3. **Stale file-map line** said claude tracker gets resume-busy seeding (contradicts the Task 8 scope cut) → corrected.

**Review loop closed:** 3 plan reviews run (the cap), 20 distinct defects caught and fixed before any implementation. Remaining residual risk moves to the implementation Fresh-Eyes rounds (up to 5).

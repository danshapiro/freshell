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
- `src/lib/pane-activity.ts` — codex `pending`→blue; `session==null`→not busy; export busy helpers. (Task 11)
- `src/lib/turn-complete-signal.ts` — drop gemini/kimi from normalizer. (Task 9)
- `src/components/TerminalView.tsx` — codex out of client gate; `sendInput` synthetic flag; real-engagement clear. (Task 2, 10)
- `src/components/panes/PaneContainer.tsx` — `handleFocus` clears tab+pane on any in-tab pane focus, both modes. (Task 10)
- `src/components/TabItem.tsx` — drop redundant `&& tab.status==='running'`. (Task 10)
- `src/components/fresh-agent/FreshAgentView.tsx` — clear attention on real input; optimistic running on send. (Task 10, 11)
- `src/App.tsx` — mount `useAgentSessionTurnCompletion`; apply durable completion snapshot; add `resetOpencodeActivityOverlay()` to auth-fail handler. (Task 3, 4, 12)

**Server**
- `server/coding-cli/codex-activity-tracker.ts` — emit `turn.complete`; wire `onTurnStarted`/`onTurnCompleted`. (Task 2, 11)
- `server/coding-cli/codex-activity-wiring.ts` — feed sidecar turn events into tracker. (Task 11)
- `server/coding-cli/claude-activity-tracker.ts` — resume-busy seeding; durable completion marker. (Task 4, 8)
- `server/coding-cli/claude-activity-wiring.ts` — resilient bound-before-created. (Task 8)
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

- [ ] **Step 6: Impl `src/store/turnCompletionAttention.ts`** — reuse the existing key builders from `pane-activity.ts` (`resolveFreshAgentSessionKey`, `resolveAgentChatSessionKey`) and `collectPaneEntries` to scan `state.panes.layouts`. Return `{ tabId, paneId } | null`. Match `content.kind === 'fresh-agent'` / `'agent-chat'` whose computed sessionKey equals the argument. (Mirror `selectTabPaneByTerminalId` in `src/store/selectors/paneTerminalSelectors.ts`.)

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

- [ ] **Step 3: Impl — emit inside the real busy/pending→idle transitions.** Add a private completion-collection mirroring claude. The clean insertion point: `transitionAfterTurnClear` (busy→idle) and `transitionPendingAfterTurnClear` (pending-with-real-submit→idle) — the two transitions that represent a user-visible turn ending. Do **not** emit from the `*LatentTurnClear` paths (association clears that never showed busy). Collect into an instance buffer flushed after `commitState`:

```ts
private pendingCompletions: CodexTurnCompleteEvent[] = []

private recordCompletion(state: CodexTerminalActivity, at: number): void {
  this.pendingCompletions.push({
    terminalId: state.terminalId,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    at,
  })
}
// call this.recordCompletion(state, at) at the top of transitionAfterTurnClear and
// transitionPendingAfterTurnClear (before mutating phase).
// Flush after every commitState in noteOutput / reconcileProjects / onTurnCompleted:
private flushCompletions(): void {
  if (this.pendingCompletions.length === 0) return
  const out = this.pendingCompletions
  this.pendingCompletions = []
  for (const c of out) this.emit('turn.complete', c)
}
```

Define `export type CodexTurnCompleteEvent = { terminalId: string; sessionId?: string; at: number }`. Ensure `noteOutput` calls `this.flushCompletions()` after `this.commitState(...)`, and `reconcileProjects` calls it after the loop. **Dedup note:** once a live BEL clears the turn (phase→idle, `acceptedStartAt` undefined), a later JSONL reconcile cannot re-run the transition, so the JSONL backstop never double-emits within a turn.

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

- [ ] **Step 6: Failing client replay test** — in `TerminalView.lifecycle.test.tsx`, mirror the existing claude replay-BEL test but for `mode: 'codex'`: feed a replayed scrollback frame containing a BEL and assert `store.getState().turnCompletion.pendingEvents` stays length 0.

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
act(() => store.dispatch(addPermissionRequest({ sessionKey: 'claude:abc', id: 'perm1' })))
expect(store.getState().turnCompletion.attentionByPane['P']).toBe(true)  // waiting-for-approval green

// resolving the permission clears attention if pane not yet visited
act(() => store.dispatch(removePermissionRequest({ sessionKey: 'claude:abc', id: 'perm1' })))
```

- [ ] **Step 3: Run red.**

- [ ] **Step 4: Impl `useAgentSessionTurnCompletion`** — select `freshAgentSessions`, `agentChatSessions`, and pane layouts. Keep a `useRef<Map<sessionKey, { wasBusy: boolean; hadPending: boolean }>>`. On each change:
  - compute `isBusy` via exported `isFreshAgentBusy`/`isAgentChatBusy`, and `hasPending = pendingPermissions||pendingQuestions non-empty`.
  - **Turn complete:** on an observed `wasBusy === true → isBusy === false && !hasPending` edge, look up pane via `selectPaneBySessionKey` (Task 1) and `dispatch(recordTurnComplete({ tabId, paneId, terminalId: sessionKey, at: Date.now() }))`.
  - **Waiting-for-approval:** on an observed `hadPending === false → hasPending === true` edge, dispatch `recordTurnComplete` likewise (green+sound). Keep `busy=false` in pane-activity (unchanged) so blue is off; green is the signal.
  - **Clear on resolution:** on `hasPending true → false` with the pane not active/focused, dispatch `clearPaneAttention`/`clearTabAttention` only if the pane was greened by a pending edge and the turn didn't otherwise complete. (Simplest: let the normal engage-to-clear path handle it; only auto-clear if pending drops to zero AND status is still idle AND no completion fired.)
  - **Critical guard:** never fire on the FIRST observation of a session (initialize the ref entry from the first snapshot without firing). This prevents spurious green on tab restore / snapshot hydration of an already-idle or already-pending session.
  - Must observe BOTH discrete reducers AND `freshAgentSnapshotReceived` (fresh-agent pending arrives via snapshots) — selecting the slice state covers both because the hook reacts to state, not actions.

- [ ] **Step 5: Run green.** Mount in `App.tsx`: `useAgentSessionTurnCompletion()` adjacent to the existing `useTurnCompletionNotifications()` call.

- [ ] **Step 6: e2e** — backgrounded fresh-agent (claude) finishes a turn → tab goes green + one sound; a backgrounded fresh-agent entering pending-permission → green + one sound; focused+active session completing → green, no sound. Reattach/snapshot of an already-idle session → no green, no sound.

- [ ] **Step 7: Commit** — `feat(status): green+sound for fresh-agent & agent-chat completion and waiting-for-approval`.

---

## Task 4: Durable turn-complete across reconnect/refresh (RC-3)

Persist a per-terminal pending-attention marker server-side so a completion that lands during a disconnect window is delivered (once) on reconnect.

**Files:**
- Modify: `server/coding-cli/claude-activity-tracker.ts`, `codex-activity-tracker.ts`, `opencode-activity-tracker.ts` (record `turnCompleteSeq` + `lastTurnCompletedAt`; expose unacked completions)
- Modify: `server/index.ts` / `server/ws-handler.ts` (include unacked completions in the activity snapshot delivered at/after `ready`)
- Modify: `shared/ws-protocol.ts` (snapshot carries `pendingTurnCompletions: { terminalId, provider, at, seq }[]`)
- Modify: `src/App.tsx` (on snapshot, dispatch `recordTurnComplete` once per unseen seq; send an ack)
- Test: tracker unit (marker survives idle until acked), ws-handler/integration (completion during disconnect delivered once on reconnect; ack clears it)

- [ ] **Step 1: Failing tracker test** — a completion increments `turnCompleteSeq`; `listPendingCompletions()` returns it; after `acknowledgeCompletion(terminalId, seq)` it is gone; for opencode the marker is **not** deleted when the busy record is removed on idle.

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Impl** — give each tracker a small `Map<terminalId, { seq, at }>` of unacked completions, incremented wherever `turn.complete` is emitted; `listPendingCompletions()` and `acknowledgeCompletion()` methods. Store it **outside** the busy-record map (so opencode idle-remove doesn't drop it).

- [ ] **Step 4: Failing integration test** — client A connects, codex/claude/opencode turn completes while A is the only client and is then disconnected; client B (or A reconnecting) authenticates and the post-`ready` snapshot includes the unacked completion; client dispatches exactly one `recordTurnComplete`; after the client acks, a second reconnect does not re-deliver.

- [ ] **Step 5: Impl snapshot + ack** — extend the activity snapshot path to include `pendingTurnCompletions`. On the client, after applying, send `{ type: 'terminal.turn.complete.ack', completions: [{terminalId, seq}] }`; server calls `acknowledgeCompletion`. Idempotent via seq + the Task-1 monotonic `at` guard.

- [ ] **Step 6: Run green.**

- [ ] **Step 7: Commit** — `fix(status): durable turn-complete across reconnect (claude/codex/opencode)`.

> **Checkpoint:** This is the most cross-cutting task. If the ack/snapshot protocol balloons, prefer the lighter alternative noted in the investigation — a short-lived (30–60s) server-side replay queue delivered to any client authenticating within the grace window — but the persisted-marker is preferred. Decide before writing the protocol; do not do both.

---

## Task 5: opencode deadman + idle-read watchdog (RC-4)

**Files:**
- Modify: `server/coding-cli/opencode-activity-tracker.ts` (add `lastObservedAt`, `expire(at)` removing busy records past `OPENCODE_BUSY_DEADMAN_MS` ~120_000)
- Modify: `server/coding-cli/opencode-activity-wiring.ts` (5s sweep via injectable `setIntervalFn`/`clearIntervalFn`, cleared in `dispose`; idle-read watchdog in `consumeEvents`)
- Test: tracker unit (stale record removed by `expire`), wiring unit (sweep scheduled/cleared; watchdog reconnects on read stall)

- [ ] **Step 1: Failing test** — a `busy` record whose `lastObservedAt` is older than the deadman is removed by `expire(now)`; refreshed on any SSE/snapshot observation.
- [ ] **Step 2: Run red.**
- [ ] **Step 3: Impl** deadman + sweep mirroring claude/codex (`expire` removes the record since opencode has no `idle` phase). Add a watchdog in `consumeEvents` that aborts/reconnects the read cycle if no bytes within a bounded interval, resetting on **any** received SSE block (not just status events) so a genuinely long turn isn't torn down.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** — `fix(status): opencode busy deadman + idle-read watchdog (no stuck blue)`.

---

## Task 6: SDK idle broadcast on natural end + error (RC-4)

**Files:**
- Modify: `server/sdk-bridge.ts` (`consumeStream`: natural-end else-branch ~`:343-350` and catch ~`:322-328` broadcast `{ type: 'sdk.status', sessionId, status: 'idle' }` after setting `state.status='idle'`)
- Modify: `src/store/agentChatSlice.ts` (`sessionError` clears `streamingActive`, resets `running`→`idle` for non-`RESTORE_*` codes), `src/store/freshAgentSlice.ts` (same)
- Test: server unit (bridge broadcasts status/idle on natural end without `result`, and on error), client unit (`sessionError` leaves status non-running; no green/sound — error ≠ completion)

- [ ] **Step 1: Failing server test** — after a stream ends without a `result` message, and after a thrown error, the bridge broadcasts an idle status.
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Failing client test** — `sessionError` (non-RESTORE) clears `streamingActive` and sets `idle`; `isAgentChatBusy`/`isFreshAgentBusy` return false; `pendingEvents` unchanged (no spurious green).
- [ ] **Step 4: Run red → impl → green.**
- [ ] **Step 5: Commit** — `fix(status): clear SDK blue on natural stream-end and error`.

---

## Task 7: opencode association-gated completion (RC-3, decision 3)

**Files:**
- Modify: `server/coding-cli/opencode-ownership-reducer.ts` — (a) reject path (`:447-461`): when `awaitingAssociation` for the same session, also emit `turnComplete` (terminal-scoped: omit sessionId, OR suppress only for `session_already_owned` by plumbing `reason`); (b) `reduceSnapshot` candidate→quiet (`:342-360`): transition to `awaitingAssociation` + `requestAssociation` instead of emitting only `activityRemove`; `knownBusy`→quiet may emit `turnComplete` directly.
- Test: `test/unit/server/coding-cli/opencode-ownership-reducer.test.ts` — reject emits/suppresses per reason; the existing "never emits turn completion from snapshots" test is replaced with association-gated assertions; disconnect-gap first-turn (candidate busy → stream drop → reconnect snapshot empty → requestAssociation → confirm → turnComplete).

- [ ] **Step 1: Failing reducer tests** (reject + snapshot association-gated).
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Perf guard (decision 3)** — the association round-trip adds one confirm/reject per first-turn-in-disconnect-gap, not per turn. Add a test asserting no extra association traffic on the steady-state SSE-idle path. If a perf regression appears in the Playwright milestone, fix it or stop and report.
- [ ] **Step 4: Commit** — `fix(status): opencode completion via association round-trip on reject/snapshot`.

---

## Task 8: claude resume-busy seeding + bound-before-created ordering (RC-3)

**Files:**
- Modify: `server/coding-cli/claude-activity-tracker.ts` — add resume-aware seeding: a `trackTerminal`/`bindSession` with `reason==='resume'` for an unresolved session seeds `phase='busy'` (deadman self-heals if no output; a completing BEL now finds `inFlight>0` → emits turn.complete). Add `inFlight=1` on seed.
- Modify: `server/coding-cli/claude-activity-wiring.ts` — make `onBound` resilient to firing before `terminal.created` (lazily `trackTerminal` first, or also track on `terminal.session.bound`).
- Test: wiring test emitting `terminal.session.bound` BEFORE `terminal.created` (production order) asserts the record exists and (resume) is busy.

- [ ] **Step 1: Failing wiring test** (bound-before-created).
- [ ] **Step 2: Run red → impl → green.** Guard seeding to `reason==='resume'` only.
- [ ] **Step 3: Commit** — `fix(status): claude resume-busy seeding + resilient bind ordering`.

---

## Task 9: De-advertise gemini/kimi (RC-1, decision 4)

**Files:**
- Modify: `src/lib/turn-complete-signal.ts` — remove `case 'gemini'` / `case 'kimi'` from `normalizeTurnCompleteSignalMode` so they fall to `'shell'`, agreeing with shared `supportsTurnSignal` (claude/codex only).
- Modify: `AGENTS.md` (or `docs/`) — document gemini/kimi terminal modes as status-inert (no blue/green/sound) pending a real turn-complete signal.
- Test: `test/unit/client/lib/turn-complete-signal.test.ts` — `extractTurnCompleteSignals('…\x07', 'gemini')` returns `count: 0`; same for `'kimi'`.

- [ ] **Step 1: Failing test** (gemini/kimi → count 0).
- [ ] **Step 2: Run red → impl → green.**
- [ ] **Step 3: Commit** — `fix(status): stop advertising gemini/kimi as status-capable`.

---

## Task 10: Robust GREEN clearing — both gestures dismiss (RC-6, decision 1)

Keep marking green (incl. active+idle). Make a **pane click** and a **real keystroke** both clear the focused pane+tab in **both** modes; fix multi-pane clearing; gate type-mode clearing to real engagement. `attentionDismiss` governs only background-tab navigation clearing.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (`handleFocus`)
- Modify: `src/components/TerminalView.tsx` (`sendInput({synthetic})`; `term.onData` real-engagement clear; clear in both modes)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (clear attention on real input submit)
- Modify: `src/components/TabItem.tsx` (drop `&& tab.status==='running'`)
- Keep: `src/hooks/useTurnCompletionNotifications.ts` clear-effect as background-tab/`attentionDismiss` behavior (no change to active-tab marking; the existing persistence test stays valid per decision 1)
- Tests: PaneContainer (any in-tab pane focus clears tab+pane, both modes), TerminalView (printable/Enter clears; arrow/synthetic does not), TabItem (multi-pane busy + tab.status='exited' → blue), FreshAgentView (submit clears attention)

- [ ] **Step 1: Failing test — handleFocus clears tab+pane on any in-tab pane focus (both modes)**

```tsx
// click mode: pane-B completed (tab green), click pane-A → clearTabAttention dispatched
// type mode: same — clicking a pane always dismisses its tab's green
```

- [ ] **Step 2: Failing test — TabItem single dot**: multi-pane tab, `iconsOnTabs=false`, `busyPaneIds` non-empty, `tab.status='exited'` → dot is `fill-blue-500`.

- [ ] **Step 3: Failing test — type-mode engagement gating**: `sendInput('x')` clears; `sendInput('\x1b[A')` (arrow) does not; `sendInput(data, { synthetic: true })` does not.

- [ ] **Step 4: Run red.**

- [ ] **Step 5: Impl**:
  - `PaneContainer.handleFocus`: on focus, if the tab/pane has attention, `dispatch(clearPaneAttention({paneId}))` and `dispatch(clearTabAttention({tabId}))` — unconditionally (remove the `attentionDismiss==='click'` gate and the "only if this pane has attention" gate). Then `setActivePane`.
  - `TerminalView.tsx`: add `sendInput(data, opts?: { synthetic?: boolean })`; pass `synthetic: true` from scroll-translation (`translateScrollLinesToInput`) and DECRQM auto-replies. For `term.onData` (real user typing), clear attention (pane+tab) when `data` contains a printable char (`/[^\x00-\x1f\x7f]/`) or CR/LF — in **both** modes. Remove the `attentionDismiss==='type'`-only gating for this clear.
  - `FreshAgentView.tsx`: on send/submit of a real message, dispatch the same clear for its pane+tab.
  - `TabItem.tsx`: `StatusDot` → `busy ? 'fill-blue-500' : getTerminalStatusDotClassName(status)` (drop `&& status==='running'`).

- [ ] **Step 6: Run green.**

- [ ] **Step 7: Commit** — `fix(status): green clears on any real engagement; fix multi-pane + single-dot`.

---

## Task 11: Codex blue onset (decision 5: C + A) + restore-window blue (RC-5, RC-4)

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` — add `onTurnStarted(terminalId, at)` → `promoteBusy` immediately; `onTurnCompleted(terminalId, at)` → clear + emit turn.complete (reuses Task 2 emit). `reconcileProjects` stays as fallback.
- Modify: `server/coding-cli/codex-activity-wiring.ts` (+ `server/terminal-registry.ts` `handleCodexTurnStarted` ~`:2016` / `onTurnStarted` wiring ~`:1697`) — feed the sidecar turn events into the tracker (currently received but not wired to the tracker).
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

**Known assumptions to validate in load-bearing:** (a) codex `onTurnStarted`/`onTurnCompleted` sidecar events exist and reach `terminal-registry.ts` for **terminal-mode** codex (not just fresh-codex); (b) emitting codex turn.complete from `transitionAfterTurnClear` + `transitionPendingAfterTurnClear` is exactly-once-per-turn and never double-fires with the JSONL reconcile or `onTurnCompleted`; (c) the durable-completion `at`/`seq` dedupe interacts correctly with the Task-1 monotonic guard across reconnect; (d) `selectPaneBySessionKey` key construction matches what the SDK slices actually store; (e) the no-op codex `pending` decays fast enough that A never yields a long-lived false-blue.

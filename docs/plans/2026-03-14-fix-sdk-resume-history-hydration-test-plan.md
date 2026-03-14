# SDK Resume History Hydration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix regression lane 1 only: resumed SDK-created FreshClaude sessions must stay in restore mode until durable history is known, without regressing fresh-create UX or orphan cleanup.

**Architecture:** Keep the fix client-owned. Before `sdk.create` is sent, record per-request create intent in Redux so `sessionCreated` can distinguish a fresh create from a resume and set `historyLoaded` correctly. Keep `sdk.session.snapshot.latestTurnId` as the server-owned hint for whether durable turns exist; `latestTurnId === null` ends restore mode without an unnecessary HTTP fetch, while non-null keeps the client in restore mode until the first timeline window lands.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest, Testing Library, jsdom e2e flows, Node WebSocket harnesses.

---

## Strategy Gate

- Fix the contract where it is wrong: `sessionCreated()` currently equates "SDK session exists" with "durable history is loaded". That is true for fresh creates and false for resumed creates; the regression comes directly from that conflation.
- Keep create intent in the client. The browser already knows whether it sent `resumeSessionId`, so echoing that fact back through the WebSocket protocol would be unnecessary churn.
- Keep snapshot semantics in the server. `sdk.session.snapshot.latestTurnId` tells the client whether durable turns exist, but it does not tell the client whether the original create was fresh or resumed. Reusing it for both meanings would reintroduce a fresh-create "Restoring session..." flash between `sdk.created` and `sdk.session.snapshot`.
- Do not patch only `AgentChatView` render logic. A render-only exception would hide the symptom in one screen while leaving the reducer contract wrong for reloads, cleanup, and future consumers.

## Scope And Sources Of Truth

- **S0 Scope:** This lane fixes only the first reviewed regression: resumed SDK sessions skipping durable history hydration because the new SDK session is marked loaded too early.
- **S1 Fresh create contract:** a brand-new SDK session should not show `Restoring session...` after `sdk.created`.
- **S2 Resumed create contract:** a resumed SDK session must stay in restore mode until either the first timeline page lands or `sdk.session.snapshot.latestTurnId === null` proves there is no durable backlog.
- **S3 Timeline identity contract:** before `sdk.session.init` arrives, the client must still hydrate timeline data against `resumeSessionId` when one was supplied.
- **S4 Pending-create cleanup contract:** closing a pane before pane content mirrors `sessionId` must still kill the SDK session and clear orphaned Redux state.
- **S5 Server contract relied on by this lane:** for resumed `sdk.create`, `server/ws-handler.ts` currently sends `sdk.created`, then `sdk.session.snapshot`, then the preliminary `sdk.session.init`.

## Relevant Existing Patterns

- Reuse the reducer harness already in `test/unit/client/agentChatSlice.test.ts`; do not invent a second slice test file.
- Reuse the reactive wrapper pattern already present near the bottom of `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx` for "pane content comes from Redux and re-renders when layout changes".
- Follow the store/mocking shape used in `test/e2e/agent-chat-polish-flow.test.tsx` for the new jsdom e2e file.
- Use `src/lib/sdk-message-handler.ts` in the e2e regression so the test covers the real `sdk.created -> sdk.session.snapshot` dispatch path instead of manually dispatching only reducer actions.

### Task 1: Lock The Reducer Contract

**Files:**
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`

**Step 1: Write the failing reducer tests**

Extend `test/unit/client/agentChatSlice.test.ts` to pin the new state contract explicitly:

```ts
it('records pending create intent before sdk.created', () => {
  const state = agentChatReducer(initial, registerPendingCreate({
    requestId: 'resume-req',
    expectsHistoryHydration: true,
  }))

  expect(state.pendingCreates['resume-req']).toEqual({
    expectsHistoryHydration: true,
    sessionId: undefined,
  })
})

it('marks a fresh create as history-loaded immediately', () => {
  let state = agentChatReducer(initial, registerPendingCreate({
    requestId: 'fresh-req',
    expectsHistoryHydration: false,
  }))
  state = agentChatReducer(state, sessionCreated({
    requestId: 'fresh-req',
    sessionId: 'sdk-fresh',
  }))

  expect(state.sessions['sdk-fresh'].historyLoaded).toBe(true)
})

it('keeps a resumed create restoring until durable history is known', () => {
  let state = agentChatReducer(initial, registerPendingCreate({
    requestId: 'resume-req',
    expectsHistoryHydration: true,
  }))
  state = agentChatReducer(state, sessionCreated({
    requestId: 'resume-req',
    sessionId: 'sdk-resume',
  }))

  expect(state.sessions['sdk-resume'].historyLoaded).toBe(false)
})

it('ends restore mode immediately when snapshot says there is no backlog', () => {
  let state = agentChatReducer(initial, registerPendingCreate({
    requestId: 'resume-empty',
    expectsHistoryHydration: true,
  }))
  state = agentChatReducer(state, sessionCreated({
    requestId: 'resume-empty',
    sessionId: 'sdk-empty',
  }))
  state = agentChatReducer(state, sessionSnapshotReceived({
    sessionId: 'sdk-empty',
    latestTurnId: null,
    status: 'idle',
  }))

  expect(state.sessions['sdk-empty'].historyLoaded).toBe(true)
})
```

Also update the existing `clears a pendingCreates entry` assertion so it expects the new object shape rather than a bare string.

**Step 2: Run the focused reducer test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/agentChatSlice.test.ts
```

Expected: FAIL because `registerPendingCreate` does not exist yet and `sessionCreated()` still hard-codes `historyLoaded = true`.

**Step 3: Implement the minimal reducer/type change**

Introduce a structured pending-create record and consume it inside `sessionCreated()`:

```ts
export type PendingAgentCreate = {
  sessionId?: string
  expectsHistoryHydration: boolean
}

export interface AgentChatState {
  sessions: Record<string, ChatSessionState>
  pendingCreates: Record<string, PendingAgentCreate>
  availableModels: Array<{ value: string; displayName: string; description: string }>
}
```

Add a reducer for request registration and update `sessionCreated()` / `sessionSnapshotReceived()`:

```ts
registerPendingCreate(state, action: PayloadAction<{
  requestId: string
  expectsHistoryHydration: boolean
}>) {
  const current = state.pendingCreates[action.payload.requestId]
  state.pendingCreates[action.payload.requestId] = {
    sessionId: current?.sessionId,
    expectsHistoryHydration: action.payload.expectsHistoryHydration,
  }
},

sessionCreated(state, action) {
  const pending = state.pendingCreates[action.payload.requestId]
  const expectsHistoryHydration = pending?.expectsHistoryHydration ?? false
  const session = ensureSession(state, action.payload.sessionId)

  session.historyLoaded = !expectsHistoryHydration
  state.pendingCreates[action.payload.requestId] = {
    sessionId: action.payload.sessionId,
    expectsHistoryHydration,
  }
},

sessionSnapshotReceived(state, action) {
  const session = ensureSession(state, action.payload.sessionId)
  session.latestTurnId = action.payload.latestTurnId
  session.status = action.payload.status
  if (action.payload.latestTurnId === null) {
    session.historyLoaded = true
  }
}
```

Preserve the current fallback behavior for any unexpected `sdk.created` with no registered request by defaulting `expectsHistoryHydration` to `false`.

**Step 4: Re-run the reducer test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/agentChatSlice.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts
git commit -m "fix: track resume history intent in agent chat state"
```

### Task 2: Lock The Real Resumed-Create Flow And Wire The View

**Files:**
- Create: `test/e2e/agent-chat-resume-history-flow.test.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`

**Step 1: Write the failing e2e regression**

Create a jsdom e2e test that uses the real message handler and a reactive pane wrapper. Reuse the same store/mocking style as `test/e2e/agent-chat-polish-flow.test.tsx`, plus `initLayout()` and a `useSelector()` wrapper so pane content is re-read from Redux after `sdk.created`.

The core test should look like this:

```tsx
it('hydrates durable history after sdk.created for a resumed create', async () => {
  getAgentTimelinePage.mockResolvedValue({
    sessionId: 'cli-session-1',
    items: [
      {
        turnId: 'turn-2',
        sessionId: 'cli-session-1',
        role: 'assistant',
        summary: 'Recent summary',
        timestamp: '2026-03-10T10:01:00.000Z',
      },
    ],
    nextCursor: null,
    revision: 2,
  })
  getAgentTurnBody.mockResolvedValue({
    sessionId: 'cli-session-1',
    turnId: 'turn-2',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hydrated from durable history' }],
      timestamp: '2026-03-10T10:01:00.000Z',
    },
  })

  const store = makeStore()
  store.dispatch(initLayout({
    tabId: 't1',
    paneId: 'p1',
    content: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-resume',
      status: 'creating',
      resumeSessionId: 'cli-session-1',
    },
  }))

  render(
    <Provider store={store}>
      <ReactivePane store={store} />
    </Provider>,
  )

  expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
    type: 'sdk.create',
    requestId: 'req-resume',
    resumeSessionId: 'cli-session-1',
  }))

  act(() => {
    handleSdkMessage(store.dispatch, {
      type: 'sdk.created',
      requestId: 'req-resume',
      sessionId: 'sdk-sess-1',
    })
    handleSdkMessage(store.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
    })
  })

  expect(screen.getByText(/restoring session/i)).toBeInTheDocument()
  await waitFor(() => {
    expect(getAgentTimelinePage).toHaveBeenCalledWith(
      'cli-session-1',
      expect.objectContaining({ priority: 'visible' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
  expect(await screen.findByText('Hydrated from durable history')).toBeInTheDocument()
})
```

Keep `sdk.created` and `sdk.session.snapshot` in the same `act()` block so the test covers the real race instead of an artificially serialized flow.

**Step 2: Run the e2e regression to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: FAIL because `sessionCreated()` already marked the resumed session as loaded, so the component never stays in restore mode and never requests the durable timeline page.

**Step 3: Implement the minimal view wiring**

`AgentChatView.tsx` must register request intent before sending `sdk.create`, and it must read the new `pendingCreates` record shape:

```ts
const pendingSessionId = useAppSelector(
  (s) => s.agentChat.pendingCreates[paneContent.createRequestId]?.sessionId,
)

dispatch(registerPendingCreate({
  requestId: paneContent.createRequestId,
  expectsHistoryHydration: Boolean(paneContent.resumeSessionId),
}))

ws.send({
  type: 'sdk.create',
  requestId: paneContent.createRequestId,
  ...
})
```

Do not add a special `resumeSessionId` render branch. The reducer contract from Task 1 should be sufficient for `isRestoring` and the existing timeline-load effect to behave correctly.

**Step 4: Re-run the e2e regression**

Run:

```bash
npm run test:vitest -- --run test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/agent-chat-resume-history-flow.test.tsx src/components/agent-chat/AgentChatView.tsx
git commit -m "fix: hydrate resumed sdk sessions from durable history"
```

### Task 3: Preserve Fresh-Create UX And Pending-Create Cleanup

**Files:**
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Write the failing edge-case tests**

Extend `AgentChatView.reload.test.tsx` so it documents both sides of the contract after the reducer change:

```tsx
it('does not show restoring for a fresh sdk.created session', () => {
  store.dispatch(registerPendingCreate({
    requestId: 'req-fresh',
    expectsHistoryHydration: false,
  }))
  store.dispatch(sessionCreated({
    requestId: 'req-fresh',
    sessionId: 'sdk-fresh',
  }))

  render(<Provider store={store}><AgentChatView ... paneContent={{
    kind: 'agent-chat',
    provider: 'freshclaude',
    createRequestId: 'req-fresh',
    sessionId: 'sdk-fresh',
    status: 'starting',
  }} /></Provider>)

  expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
  expect(screen.getByText('Freshclaude')).toBeInTheDocument()
})

it('does not issue an HTTP timeline fetch when snapshot proves the resumed session is empty', async () => {
  store.dispatch(registerPendingCreate({
    requestId: 'req-empty',
    expectsHistoryHydration: true,
  }))
  store.dispatch(sessionCreated({
    requestId: 'req-empty',
    sessionId: 'sdk-empty',
  }))
  store.dispatch(sessionSnapshotReceived({
    sessionId: 'sdk-empty',
    latestTurnId: null,
    status: 'idle',
  }))

  render(<Provider store={store}><AgentChatView ... paneContent={{
    kind: 'agent-chat',
    provider: 'freshclaude',
    createRequestId: 'req-empty',
    sessionId: 'sdk-empty',
    status: 'idle',
    resumeSessionId: 'cli-empty',
  }} /></Provider>)

  await act(async () => { await Promise.resolve() })
  expect(getAgentTimelinePage).not.toHaveBeenCalled()
  expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
})
```

Add a `PaneContainer` regression for the new pending-create shape:

```tsx
it('kills and clears a pending agent-chat session using pendingCreates.sessionId', () => {
  const store = createStore(..., {
    sessions: {
      'sdk-sess-1': {
        sessionId: 'sdk-sess-1',
        status: 'starting',
        messages: [],
        timelineItems: [],
        timelineBodies: {},
        streamingText: '',
        streamingActive: false,
        pendingPermissions: {},
        pendingQuestions: {},
        totalCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    },
    pendingCreates: {
      'req-1': {
        sessionId: 'sdk-sess-1',
        expectsHistoryHydration: true,
      },
    },
    availableModels: [],
  })

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)
  fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

  expect(wsSend).toHaveBeenCalledWith({ type: 'sdk.kill', sessionId: 'sdk-sess-1' })
  expect(store.getState().agentChat.pendingCreates['req-1']).toBeUndefined()
})
```

**Step 2: Run the focused client tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected: FAIL because `PaneContainer` still treats `pendingCreates[requestId]` as a bare string, and the updated reload tests are still documenting behavior the code has not fully protected.

**Step 3: Finish the cleanup path narrowly**

Update `PaneContainer.tsx` to read the structured pending-create entry once and use its `sessionId` only when one exists:

```ts
const pendingCreate = sdkPendingCreates[content.createRequestId]
const pendingSessionId = pendingCreate?.sessionId
const sessionId = content.sessionId || pendingSessionId

if (!content.sessionId && pendingSessionId) {
  dispatch(removeSession({ sessionId: pendingSessionId }))
  dispatch(clearPendingCreate({ requestId: content.createRequestId }))
}
```

Do not remove the existing `cancelCreate(content.createRequestId)` path for the pre-`sdk.created` case. That behavior is still needed when the pane is closed before any SDK session ID exists.

**Step 4: Re-run the focused client tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx src/components/panes/PaneContainer.tsx
git commit -m "test: protect resumed create edge cases and cleanup"
```

### Task 4: Characterize The Server Contract This Lane Depends On

**Files:**
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Add the server characterization test**

Write a focused test that proves the current resume-create ordering and snapshot semantics:

```ts
it('for resumed sdk.create sends sdk.created, then sdk.session.snapshot, then sdk.session.init', async () => {
  const durableSessionId = '00000000-0000-4000-8000-000000000241'
  loadSessionHistoryMock.mockResolvedValue([
    {
      role: 'user',
      content: [{ type: 'text', text: 'Earlier question' }],
      timestamp: '2026-03-10T10:00:00.000Z',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Earlier answer' }],
      timestamp: '2026-03-10T10:00:01.000Z',
    },
  ])

  const ws = await connectAndAuth()
  try {
    const messages: any[] = []
    const collected = new Promise<void>((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const parsed = JSON.parse(data.toString())
        if (
          parsed.type === 'sdk.created'
          || parsed.type === 'sdk.session.snapshot'
          || parsed.type === 'sdk.session.init'
        ) {
          messages.push(parsed)
        }
        if (messages.length >= 3) {
          ws.off('message', onMessage)
          resolve()
        }
      }
      ws.on('message', onMessage)
    })

    ws.send(JSON.stringify({
      type: 'sdk.create',
      requestId: 'req-resume-order',
      resumeSessionId: durableSessionId,
    }))

    await collected

    expect(messages.map((m) => m.type).slice(0, 3)).toEqual([
      'sdk.created',
      'sdk.session.snapshot',
      'sdk.session.init',
    ])
    expect(messages[1]).toEqual(expect.objectContaining({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-1',
    }))
  } finally {
    ws.close()
  }
})
```

Reuse the existing `on('message', ...)` collection style already present in this file; do not invent a second WebSocket harness.

**Step 2: Run the focused server test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS immediately. If it fails, stop and re-plan the lane, because the chosen client-only fix would no longer rest on a true server contract.

**Step 3: Commit**

```bash
git add test/unit/server/ws-handler-sdk.test.ts
git commit -m "test: characterize sdk resume snapshot ordering"
```

## Final Verification

1. Run the focused lane together:

```bash
npm run test:vitest -- --run test/unit/client/agentChatSlice.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/ws-handler-sdk.test.ts
```

Expected: all targeted unit, client integration, e2e, and server characterization tests PASS.

2. Run lint because this lane changes shared React/TypeScript code:

```bash
npm run lint
```

Expected: PASS.

3. Check the coordinator before the broad run:

```bash
npm run test:status
```

Expected: either no holder, or a clear wait instruction from the coordinator.

4. Run high-level verification for the lane:

```bash
FRESHELL_TEST_SUMMARY="lane1 sdk resume history hydration" npm run check
```

Expected: PASS. This is the lane-complete bar in the worktree because it covers typecheck plus the coordinated full suite.

## Notes

- No docs update is needed. This is a regression fix for existing behavior, not a new user-facing feature.
- Do not change `server/ws-handler.ts` unless Task 4 disproves the current contract. This lane should stay client-owned unless the characterization test says otherwise.

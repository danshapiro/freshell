# SDK Resume History Hydration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make resumed SDK-created FreshClaude sessions stay in restore mode until durable history is actually hydrated, while preserving the existing no-flash behavior for fresh creates and the existing orphan-cleanup behavior for pending creates.

**Architecture:** Keep the fix client-owned. The client already knows whether a given `sdk.create` is a fresh create or a resume, so record that intent in Redux before the WebSocket message is sent and consume it inside `sessionCreated`. `historyLoaded` must mean "the UI has enough durable history information to stop restoring", not merely "a session record exists"; resumed creates therefore start with `historyLoaded=false`, fresh creates start with `historyLoaded=true`, and `sdk.session.snapshot` with `latestTurnId === null` closes the restore path without forcing an unnecessary HTTP timeline fetch.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest, Testing Library, jsdom e2e tests, WebSocket unit harnesses.

---

## Strategy Gate

- Solve the state-contract bug at the Redux lifecycle boundary, not with a one-off `AgentChatView` exception.
  The regression happens because `sessionCreated` treats every create like a fresh create. Fixing that contract once is cleaner than sprinkling `resumeSessionId` checks through render effects.
- Do not infer restore mode only from `sdk.session.snapshot.latestTurnId`.
  That would reintroduce a fresh-create flash between `sdk.created` and `sdk.session.snapshot`, breaking the existing "fresh create never shows restoring" contract.
- Do not expand the WebSocket protocol just to echo client-owned request intent.
  The client already knows whether it sent `resumeSessionId`; storing that in Redux is narrower and avoids unnecessary protocol churn.

## Sources Of Truth

- **ST1 Fresh create contract:** a brand-new SDK session should not show `Restoring session...` after `sdk.created`.
- **ST2 Resumed create contract:** a resumed SDK session must stay in restore mode until either the first timeline window lands or `sdk.session.snapshot` proves there is no durable backlog (`latestTurnId === null`).
- **ST3 Snapshot contract:** `sdk.session.snapshot.latestTurnId` is the server hint for whether durable turns exist; `null` means no HTTP timeline hydrate is needed.
- **ST4 Pending-create contract:** the client must keep enough create metadata to wire `sessionId` back into the pane and to kill or clean up orphan sessions if the pane closes before mirroring completes.
- **ST5 Testing bar:** this lane needs both unit coverage and a realistic e2e-style regression covering the actual `sdk.create -> sdk.created -> sdk.session.snapshot -> HTTP timeline` flow.

## Harness Requirements

No new standalone harness is required.

- **H1 Client reducer harness:** `test/unit/client/agentChatSlice.test.ts`
  Uses the real reducer to verify `pendingCreates`, `sessionCreated`, `sessionSnapshotReceived`, and `timelinePageReceived`.
- **H2 AgentChat reload harness:** `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  Uses a real store, mocked WS client, and mocked HTTP timeline APIs to verify restore behavior from `AgentChatView`.
- **H3 AgentChat integrated jsdom e2e harness:** new `test/e2e/agent-chat-resume-history-flow.test.tsx`
  Renders `AgentChatView` with real store reducers, uses `handleSdkMessage()` for incoming SDK frames, lets the component mirror `pendingCreates` back into pane content, and mocks the timeline HTTP API.
- **H4 Pane cleanup harness:** `test/unit/client/components/panes/PaneContainer.test.tsx`
  Verifies that the new structured pending-create state still lets pane close paths send `sdk.kill` and clear orphaned pending state.
- **H5 Server WS harness:** `test/unit/server/ws-handler-sdk.test.ts`
  Characterizes the existing `sdk.create` resume snapshot ordering so the client-side fix depends on an explicitly tested contract.

### Task 1: Lock The Real Regression And Implement The Client Contract

**Files:**
- Create: `test/e2e/agent-chat-resume-history-flow.test.tsx`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Write the failing integrated regression**

Add a new jsdom e2e test that exercises the real restore flow for a resumed create:

```tsx
it('hydrates the HTTP timeline after sdk.created for a resumed create', async () => {
  render(<ReactiveAgentChatWrapper paneContent={{
    kind: 'agent-chat',
    provider: 'freshclaude',
    createRequestId: 'req-1',
    resumeSessionId: 'cli-session-1',
    status: 'creating',
  }} />)

  expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
    type: 'sdk.create',
    requestId: 'req-1',
    resumeSessionId: 'cli-session-1',
  }))

  act(() => {
    handleSdkMessage(store.dispatch, {
      type: 'sdk.created',
      requestId: 'req-1',
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
})
```

**Step 2: Run the regression test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: FAIL because `getAgentTimelinePage` is never called after `sdk.created` for the resumed create.

**Step 3: Implement the minimal client contract fix**

Change `pendingCreates` from `requestId -> sessionId` into a structured record that also tracks whether the create expects durable history hydration:

```ts
export type PendingAgentCreate = {
  sessionId?: string
  expectsHistoryHydration: boolean
}

registerPendingCreate(state, action: PayloadAction<{
  requestId: string
  expectsHistoryHydration: boolean
}>) {
  state.pendingCreates[action.payload.requestId] = {
    sessionId: state.pendingCreates[action.payload.requestId]?.sessionId,
    expectsHistoryHydration: action.payload.expectsHistoryHydration,
  }
}

sessionCreated(state, action) {
  const pending = state.pendingCreates[action.payload.requestId]
  const expectsHistoryHydration = pending?.expectsHistoryHydration ?? false
  const session = ensureSession(state, action.payload.sessionId)
  session.historyLoaded = !expectsHistoryHydration
  state.pendingCreates[action.payload.requestId] = {
    sessionId: action.payload.sessionId,
    expectsHistoryHydration,
  }
}

sessionSnapshotReceived(state, action) {
  const session = ensureSession(state, action.payload.sessionId)
  session.latestTurnId = action.payload.latestTurnId
  session.status = action.payload.status
  if (action.payload.latestTurnId === null) {
    session.historyLoaded = true
  }
}
```

Wire the new intent into `AgentChatView` before `sdk.create` is sent, and update selectors/cleanup to read `pendingCreates[requestId]?.sessionId`:

```ts
dispatch(registerPendingCreate({
  requestId: paneContent.createRequestId,
  expectsHistoryHydration: Boolean(paneContent.resumeSessionId),
}))

const pendingSessionId = useAppSelector(
  (s) => s.agentChat.pendingCreates[paneContent.createRequestId]?.sessionId,
)
```

In `PaneContainer`, preserve orphan cleanup with the new record shape:

```ts
const pendingCreate = sdkPendingCreates[content.createRequestId]
const pendingSessionId = pendingCreate?.sessionId
const sessionId = content.sessionId || pendingSessionId
```

**Step 4: Run the integrated regression again**

Run:

```bash
npm run test:vitest -- --run test/e2e/agent-chat-resume-history-flow.test.tsx
```

Expected: PASS, and the test reaches the mocked HTTP timeline request using `resumeSessionId`.

**Step 5: Commit**

```bash
git add test/e2e/agent-chat-resume-history-flow.test.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx src/components/panes/PaneContainer.tsx
git commit -m "fix: restore history for resumed sdk creates"
```

### Task 2: Preserve Fresh-Create And Empty-Snapshot Contracts With Unit Tests

**Files:**
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`

**Step 1: Write the failing client regression/unit tests**

Extend `agentChatSlice` coverage so it proves all three states explicitly:

```ts
it('marks a fresh create as history-loaded immediately', () => {
  let state = reducer(undefined, registerPendingCreate({
    requestId: 'fresh',
    expectsHistoryHydration: false,
  }))
  state = reducer(state, sessionCreated({ requestId: 'fresh', sessionId: 'sdk-fresh' }))
  expect(state.sessions['sdk-fresh'].historyLoaded).toBe(true)
})

it('keeps a resumed create restoring until history lands', () => {
  let state = reducer(undefined, registerPendingCreate({
    requestId: 'resume',
    expectsHistoryHydration: true,
  }))
  state = reducer(state, sessionCreated({ requestId: 'resume', sessionId: 'sdk-resume' }))
  expect(state.sessions['sdk-resume'].historyLoaded).toBe(false)
})

it('ends restore immediately when snapshot says there is no backlog', () => {
  let state = reducer(undefined, registerPendingCreate({
    requestId: 'resume-empty',
    expectsHistoryHydration: true,
  }))
  state = reducer(state, sessionCreated({ requestId: 'resume-empty', sessionId: 'sdk-empty' }))
  state = reducer(state, sessionSnapshotReceived({
    sessionId: 'sdk-empty',
    latestTurnId: null,
    status: 'idle',
  }))
  expect(state.sessions['sdk-empty'].historyLoaded).toBe(true)
})
```

Add/adjust `AgentChatView.reload` coverage for both sides of the contract:

```tsx
it('does not show restoring for a fresh sdk.created session', () => {
  store.dispatch(registerPendingCreate({
    requestId: 'req-1',
    expectsHistoryHydration: false,
  }))
  store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-fresh' }))
  render(<AgentChatView ... paneContent={{ ...pane, sessionId: 'sess-fresh', status: 'starting' }} />)
  expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
})

it('uses resumeSessionId to hydrate after sdk.created for a resumed create', async () => {
  store.dispatch(registerPendingCreate({
    requestId: 'req-1',
    expectsHistoryHydration: true,
  }))
  store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-reload-1' }))
  store.dispatch(sessionSnapshotReceived({
    sessionId: 'sess-reload-1',
    latestTurnId: 'turn-2',
    status: 'idle',
  }))
  render(<AgentChatView ... paneContent={{ ...RELOAD_PANE, resumeSessionId: 'cli-session-1' }} />)
  await waitFor(() => expect(getAgentTimelinePage).toHaveBeenCalledWith('cli-session-1', expect.anything(), expect.anything()))
})
```

**Step 2: Run the focused client tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/agentChatSlice.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: FAIL on at least one fresh-vs-resume assertion until the reducer and selector changes are complete.

**Step 3: Finish any remaining reducer/comment cleanup**

Tighten comments so they match the real contract:

```ts
/** True once the UI has enough durable-history state to stop restoring. */
historyLoaded?: boolean
```

If any focused tests still fail, finish the minimal adjustments in the reducer or selector layer. Do not add any new `resumeSessionId` branch directly in the render effect if the state contract can express it.

**Step 4: Re-run the focused client tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/agentChatSlice.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx
git commit -m "test: cover fresh and resumed sdk history contracts"
```

### Task 3: Preserve Pending-Create Cleanup And Characterize The Server Snapshot Hint

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Write the failing cleanup regression**

Add a `PaneContainer` test for the exact state shape that changed: a pane is closed after `sdk.created` populated the pending create record, but before `paneContent.sessionId` has been mirrored into pane content.

```tsx
it('kills and clears a pending agent-chat session using pendingCreates.sessionId', () => {
  const store = createStore(..., {
    pendingCreates: {
      'req-1': { sessionId: 'sdk-sess-1', expectsHistoryHydration: true },
    },
    sessions: {
      'sdk-sess-1': { sessionId: 'sdk-sess-1', status: 'starting', ... },
    },
  })

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)
  fireEvent.click(screen.getByRole('button', { name: /close pane/i }))

  expect(wsSend).toHaveBeenCalledWith({ type: 'sdk.kill', sessionId: 'sdk-sess-1' })
  expect(store.getState().agentChat.pendingCreates['req-1']).toBeUndefined()
})
```

Add a server characterization test proving the client-side fix is leaning on an explicit server contract:

```ts
it('sends sdk.session.snapshot with latestTurnId before sdk.session.init for resumed sdk.create', async () => {
  loadSessionHistoryMock.mockResolvedValue([
    { role: 'user', content: [{ type: 'text', text: 'Earlier question' }], timestamp: '2026-03-10T10:00:00.000Z' },
    { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }], timestamp: '2026-03-10T10:00:01.000Z' },
  ])

  // collect sdk.created, sdk.session.snapshot, sdk.session.init
  // assert ordering and snapshot.latestTurnId === 'turn-1'
})
```

**Step 2: Run the focused cleanup/server tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneContainer.test.tsx
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/ws-handler-sdk.test.ts
```

Expected: the PaneContainer test fails until the selector/cleanup path uses `pendingCreates[requestId]?.sessionId`; the server characterization should pass once written, and if it does not, stop and fix the server contract before proceeding.

**Step 3: Finish the cleanup path**

Keep the cleanup logic narrow:

```ts
const pendingCreate = sdkPendingCreates[content.createRequestId]
if (!content.sessionId && pendingCreate?.sessionId) {
  dispatch(removeSession({ sessionId: pendingCreate.sessionId }))
  dispatch(clearPendingCreate({ requestId: content.createRequestId }))
}
```

Do not remove the existing `cancelCreate()` path for the pre-`sdk.created` case.

**Step 4: Re-run the focused cleanup/server tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneContainer.test.tsx
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/panes/PaneContainer.test.tsx test/unit/server/ws-handler-sdk.test.ts src/components/panes/PaneContainer.tsx
git commit -m "test: protect sdk pending-create cleanup"
```

## Final Verification

1. Run the focused lane together:

```bash
npm run test:vitest -- --run test/e2e/agent-chat-resume-history-flow.test.tsx test/unit/client/agentChatSlice.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/ws-handler-sdk.test.ts
```

Expected: all targeted client and server tests PASS.

2. Check the coordinator before the broad repo run:

```bash
npm run test:status
```

Expected: no conflicting holder, or a clear wait instruction from the coordinator.

3. Run coordinated broad verification:

```bash
FRESHELL_TEST_SUMMARY="lane1 sdk resume history hydration" npm test
```

Expected: coordinated full suite PASS.

## Notes

- No docs update is needed. This is a regression fix for an existing feature, not a new user-facing capability.
- If the broad run finds unrelated failures, stop and repair them before considering this lane complete; do not hand-wave them away as pre-existing.

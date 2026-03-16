# Fix Claude Session Activity Indicator (Not Turning Green) Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Fix Claude Code terminal sessions incorrectly re-entering the "working" (busy/blue) state after their turn completes, preventing the activity indicator from turning green/idle.

**Architecture:** Add a `turnCompletedSinceLastInputRef` boolean ref to `TerminalView.tsx` that acts as a guard. When a turn-complete signal (BEL) is detected, the ref is set to `true`. When the user submits input (enter key), the ref is reset to `false`. The `handleTerminalOutput` function's "set working" branch is gated behind this ref being `false`, preventing post-BEL output (like Claude's next prompt rendering) from re-triggering the busy state. Codex does not need this fix because its activity is tracked server-side by `CodexActivityTracker`, which has its own state machine with proper turn lifecycle management.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, TypeScript

---

## Root Cause Analysis

The bug is in `src/components/TerminalView.tsx`, in the `handleTerminalOutput` callback (lines 745-781). The flow is:

1. User presses Enter in a Claude terminal -> `sendInput` dispatches `setPaneRuntimeActivity({ phase: 'pending' })`
2. Claude produces output -> `handleTerminalOutput` sees `count === 0` (no BEL yet), sets `phase: 'working'` -- correct
3. Claude finishes its turn, emits BEL (\x07) -> `handleTerminalOutput` sees `count > 0`, dispatches `clearPaneRuntimeActivity` -- correct, indicator goes green
4. **Claude renders its next prompt** (e.g., `>`, or prompt text with ANSI codes) -> `handleTerminalOutput` sees `count === 0` and `cleaned` is non-empty, so it dispatches `setPaneRuntimeActivity({ phase: 'working' })` again -- **BUG**: indicator goes back to blue/busy

The guard `!seqStateRef.current.pendingReplay` only prevents activity during initial replay, not after turn completion. There is no mechanism to prevent output after BEL from re-triggering the working state.

Codex does not have this problem because its busy state is tracked server-side by `CodexActivityTracker` (in `server/coding-cli/codex-activity-tracker.ts`), which manages a proper state machine with `bindTerminal`, `noteInput`, `noteOutput`, and project reconciliation. The client-side claude activity tracking is simpler -- it relies on the BEL signal to clear and any non-BEL output to set busy -- which makes it vulnerable to this race.

## Fix Design

Add a single `useRef<boolean>` called `turnCompletedSinceLastInputRef` (initialized to `true` so a fresh terminal doesn't immediately show busy on first output before any user interaction):

- **In `handleTerminalOutput`**: When `count > 0` (BEL detected), set `turnCompletedSinceLastInputRef.current = true`
- **In `handleTerminalOutput`**: The "set working" branch adds an additional guard: `&& !turnCompletedSinceLastInputRef.current`
- **In `sendInput`**: When `isClaudeTurnSubmit(data)` is true, reset `turnCompletedSinceLastInputRef.current = false`

This is the minimal, correct fix. The ref does not need to be in Redux because it is purely local to the TerminalView component instance and has no cross-component visibility requirements. It mirrors how `seqStateRef` gates replay-phase output.

### Why `true` as initial value

A fresh Claude terminal will render its initial prompt before the user has typed anything. Without initializing to `true`, the first prompt output would set the pane to "working" even though no user turn has been submitted. Initializing to `true` ensures the indicator stays idle until the user actually submits a prompt.

---

### Task 1: Write the failing test for output-after-BEL re-triggering busy

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing test**

Add a new test case after the existing `'tracks claude terminal runtime activity from submit to output to turn completion'` test. The new test should:

1. Set up a Claude terminal pane with `paneRuntimeActivity` in the store (same pattern as the existing activity test at line 787)
2. Simulate user input (Enter key via `onData('\r')`) -- asserts `phase: 'pending'`
3. Send `terminal.attach.ready` to complete the attach handshake
4. Send a `terminal.output` with regular text -- asserts `phase: 'working'`
5. Send a `terminal.output` with BEL (`\x07`) -- asserts activity is cleared (undefined)
6. **Send another `terminal.output` with regular text** (simulating Claude's next prompt) -- **asserts activity is still cleared (undefined)**, not re-set to working

The test name should be: `'does not re-enter working state when claude output arrives after turn completion BEL'`

Here is the complete test body:

```typescript
it('does not re-enter working state when claude output arrives after turn completion BEL', async () => {
  const tabId = 'tab-claude-post-bel'
  const paneId = 'pane-claude-post-bel'
  const terminalId = 'term-claude-post-bel'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-claude-post-bel',
    status: 'running',
    mode: 'claude',
    shell: 'system',
    terminalId,
    resumeSessionId: '22222222-2222-4222-8222-222222222222',
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'claude',
          status: 'running',
          title: 'Claude',
          titleSetByUser: false,
          terminalId,
          resumeSessionId: '22222222-2222-4222-8222-222222222222',
          createRequestId: 'req-claude-post-bel',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
      paneRuntimeActivity: { byPaneId: {} },
    },
  })

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(messageHandler).not.toBeNull()
  })
  await waitFor(() => {
    expect(terminalInstances.length).toBeGreaterThan(0)
  })

  const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
  expect(onData).toBeTypeOf('function')

  // Step 1: User submits input -> pending
  act(() => {
    onData?.('\r')
  })

  expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
    source: 'terminal',
    phase: 'pending',
  })

  // Complete attach handshake
  const initialAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  act(() => {
    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 0,
      replayFromSeq: 1,
      replayToSeq: 0,
      attachRequestId: initialAttach?.attachRequestId,
    })
  })

  // Step 2: Claude produces output -> working
  act(() => {
    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'Claude is thinking...',
    })
  })

  expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
    source: 'terminal',
    phase: 'working',
  })

  // Step 3: Turn completion BEL -> cleared
  act(() => {
    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 2,
      data: '\x07',
    })
  })

  expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

  // Step 4: Post-BEL output (Claude's next prompt) -> should STAY cleared
  act(() => {
    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 3,
      seqEnd: 3,
      data: '\r\n> ',
    })
  })

  // THIS IS THE KEY ASSERTION: activity should still be cleared, not re-set to working
  expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
})
```

**Step 2: Run the test to confirm it fails**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "does not re-enter working state when claude output arrives after turn completion BEL"`
- [ ] Expected: FAIL -- the last assertion (`toBeUndefined()`) fails because the current code re-dispatches `setPaneRuntimeActivity({ phase: 'working' })` on the post-BEL output chunk.

### Task 2: Implement the fix in TerminalView.tsx

**Files:**
- Modify: `src/components/TerminalView.tsx`

**Step 1: Add the ref declaration**

In the refs section of the component (around line 233, after `terminalFirstOutputMarkedRef`), add:

```typescript
const turnCompletedSinceLastInputRef = useRef(true)
```

The `true` initialization ensures a fresh terminal does not show as busy when its initial prompt renders before the user has typed anything.

**Step 2: Gate the "set working" branch in `handleTerminalOutput`**

In `handleTerminalOutput` (around line 749), after the `count > 0` block that calls `clearPaneRuntimeActivity`, set the ref:

Change the block starting at line 749:
```typescript
if (count > 0 && tid) {
  dispatch(recordTurnComplete({
    tabId,
    paneId: paneIdRef.current,
    terminalId: tid,
    at: Date.now(),
  }))
  if (mode === 'claude') {
    dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
  }
}
```

To:
```typescript
if (count > 0 && tid) {
  dispatch(recordTurnComplete({
    tabId,
    paneId: paneIdRef.current,
    terminalId: tid,
    at: Date.now(),
  }))
  if (mode === 'claude') {
    dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
    turnCompletedSinceLastInputRef.current = true
  }
}
```

Then, change the "set working" condition (around line 761):

From:
```typescript
if (
  mode === 'claude'
  && cleaned
  && count === 0
  && !seqStateRef.current.pendingReplay
) {
```

To:
```typescript
if (
  mode === 'claude'
  && cleaned
  && count === 0
  && !seqStateRef.current.pendingReplay
  && !turnCompletedSinceLastInputRef.current
) {
```

**Step 3: Reset the ref in `sendInput`**

In the `sendInput` callback (around line 796), inside the `isClaudeTurnSubmit(data)` branch, add the reset:

Change:
```typescript
if (contentRef.current?.mode === 'claude' && isClaudeTurnSubmit(data)) {
  dispatch(setPaneRuntimeActivity({
    paneId: paneIdRef.current,
    source: 'terminal',
    phase: 'pending',
  }))
}
```

To:
```typescript
if (contentRef.current?.mode === 'claude' && isClaudeTurnSubmit(data)) {
  turnCompletedSinceLastInputRef.current = false
  dispatch(setPaneRuntimeActivity({
    paneId: paneIdRef.current,
    source: 'terminal',
    phase: 'pending',
  }))
}
```

**Step 4: Run the test to confirm it passes**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "does not re-enter working state when claude output arrives after turn completion BEL"`
- [ ] Expected: PASS

**Step 5: Run the existing activity test to confirm no regression**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "tracks claude terminal runtime activity from submit to output to turn completion"`
- [ ] Expected: PASS -- the existing test still works because it follows the sequence: input -> output (sets working) -> BEL (clears), and does not send output after BEL.

### Task 3: Run the full lifecycle test file and related tests

**Files:** (no changes, verification only)

**Step 1: Run the full TerminalView lifecycle test suite**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx`
- [ ] Expected: All tests PASS

**Step 2: Run pane-activity related tests**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && npx vitest run test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx 2>/dev/null || npx vitest run test/unit/client/lib/pane-activity.test.ts`
- [ ] Expected: PASS

**Step 3: Commit**

- [ ] Commit with message: `fix: prevent Claude terminal from re-entering working state after turn-complete BEL`

### Task 4: Run the coordinated full test suite

**Step 1: Run the full test suite**

- [ ] Run: `cd /home/user/code/freshell/.worktrees/fix-claude-session-green && FRESHELL_TEST_SUMMARY="fix-claude-session-green: post-BEL activity guard" npm test`
- [ ] Expected: All tests PASS

If any tests fail, investigate and fix before proceeding.

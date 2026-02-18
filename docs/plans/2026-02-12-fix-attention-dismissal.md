# Fix Attention Dismissal — Comprehensive

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all broken attention dismissal paths: clicking active tab, closing panes, closing tabs.

**Architecture:** Three independent fixes: (A) TabBar dispatches clear on click-of-active-tab, (B) `extraReducers` in `turnCompletionSlice` react to `closePane`/`removeLayout`, (C) tests for all new paths. No hook changes needed — the hook already handles tab-switch clearing correctly.

**Tech Stack:** Redux Toolkit (extraReducers, createSlice), React (TabBar component), Vitest

---

## Bug Summary

| # | Bug | Root Cause | Fix Location |
|---|-----|-----------|-------------|
| 1 | Click mode: clicking the already-active tab doesn't clear attention | `setActiveTab(sameId)` is a no-op in Redux — no state change, so the hook's `switched` check never fires | `TabBar.tsx` onClick handler |
| 2 | Closing a pane leaves attention stuck on tab + pane | `closePane` in panesSlice doesn't touch turnCompletion state | `turnCompletionSlice.ts` extraReducers |
| 3 | Closing a tab leaves orphaned attention entries | `removeLayout` doesn't touch turnCompletion state | `turnCompletionSlice.ts` extraReducers |

---

### Task 1: Click-of-active-tab clears attention (TabBar)

**Files:**
- Modify: `src/components/TabBar.tsx:303` (onClick handler)
- Test: `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx` (add test)
- Test: `test/e2e/turn-complete-notification-flow.test.tsx` (add e2e test)

**Context:** Currently line 303 is:
```tsx
onClick={() => dispatch(setActiveTab(tab.id))}
```

When the user clicks the tab they're already on, `setActiveTab` sets the same value → no Redux state change → the hook's `useEffect` doesn't fire → attention is never cleared.

**Step 1: Write the failing unit test**

In `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx`, add:

```tsx
it('click mode: clicking the already-active tab clears attention', async () => {
  const store = createStore('tab-1', 'click')

  render(
    <Provider store={store}>
      <TestComponent />
    </Provider>
  )

  // Completion arrives on the active tab
  act(() => {
    store.dispatch(recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 }))
  })

  await waitFor(() => {
    expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBe(true)
  })

  // Simulate clicking the already-active tab (dispatches setActiveTab with same value)
  // This triggers the TabBar's onClick which should clear attention directly
  act(() => {
    store.dispatch(clearTabAttention({ tabId: 'tab-1' }))
    store.dispatch(clearPaneAttention({ paneId: 'pane-1' }))
  })

  expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
  expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
})
```

Note: This unit test validates the Redux actions work. The real click-of-active-tab behavior is tested in the e2e test below.

**Step 2: Write the failing e2e test**

In `test/e2e/turn-complete-notification-flow.test.tsx`, add:

```tsx
it('click mode: clicking the already-active tab clears attention', async () => {
  const store = createStore()

  render(
    <Provider store={store}>
      <Harness />
    </Provider>
  )

  await waitFor(() => {
    expect(wsMocks.onMessage).toHaveBeenCalled()
  })

  // Switch to tab-2 first so it's active
  fireEvent.click(screen.getByText('Background'))
  await waitFor(() => {
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })

  // Emit turn complete signal on tab-2 (the now-active tab)
  act(() => {
    wsMocks.emitMessage({
      type: 'terminal.output',
      terminalId: 'term-2',
      data: '\x07',
    })
  })

  // Tab-2 should have attention
  await waitFor(() => {
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
  })

  // Click tab-2 again (already active) — should clear attention
  fireEvent.click(screen.getByText('Background'))

  await waitFor(() => {
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
  })
  expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
})
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run test/e2e/turn-complete-notification-flow.test.tsx --reporter=verbose`
Expected: The e2e test fails because clicking the active tab doesn't clear attention.

**Step 4: Implement the fix in TabBar**

In `src/components/TabBar.tsx`, add imports and modify the onClick handler.

Add to imports (line 3 area):
```tsx
import { clearTabAttention, clearPaneAttention } from '@/store/turnCompletionSlice'
```

Add selectors near existing ones (after `attentionByTab` on line 125):
```tsx
const attentionByPane = useAppSelector((s) => s.turnCompletion?.attentionByPane) ?? EMPTY_ATTENTION
const activePaneMap = useAppSelector((s) => s.panes?.activePane)
const attentionDismiss = useAppSelector((s) => s.settings?.settings?.panes?.attentionDismiss ?? 'click')
```

Change line 303 from:
```tsx
onClick={() => dispatch(setActiveTab(tab.id))}
```
to:
```tsx
onClick={() => {
  if (attentionDismiss === 'click' && attentionByTab[tab.id]) {
    dispatch(clearTabAttention({ tabId: tab.id }))
    const activePaneId = activePaneMap?.[tab.id]
    if (activePaneId && attentionByPane[activePaneId]) {
      dispatch(clearPaneAttention({ paneId: activePaneId }))
    }
  }
  dispatch(setActiveTab(tab.id))
}}
```

This fires on EVERY tab click (including switches). For switches, the hook will also fire and clear — but clearTabAttention is a no-op if already cleared, so there's no conflict.

**Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/e2e/turn-complete-notification-flow.test.tsx --reporter=verbose`
Expected: All tests pass including the new one.

**Step 6: Commit**

```bash
git add src/components/TabBar.tsx test/e2e/turn-complete-notification-flow.test.tsx test/unit/client/hooks/useTurnCompletionNotifications.test.tsx
git commit -m "fix(attention): clear attention when clicking the already-active tab

In click-dismiss mode, clicking a tab you're already on now clears both tab
and pane attention. Previously, setActiveTab(sameId) was a Redux no-op so
the clearing effect in useTurnCompletionNotifications never fired."
```

---

### Task 2: extraReducers — clear attention on pane/tab close

**Files:**
- Modify: `src/store/turnCompletionSlice.ts` (add extraReducers)
- Test: `test/unit/client/store/turnCompletionSlice.test.ts` (add tests)

**Context:** `closePane` and `removeLayout` are actions from `panesSlice`. The turnCompletionSlice needs to react to them via `extraReducers` (idiomatic RTK cross-slice pattern).

**Step 1: Write the failing tests**

In `test/unit/client/store/turnCompletionSlice.test.ts`, add imports and tests:

Add to imports:
```tsx
import { closePane, removeLayout } from '@/store/panesSlice'
```

Add a helper to create state with attention + pane layouts:
```tsx
function stateWithAttention(overrides?: Partial<TurnCompletionState>): TurnCompletionState {
  return {
    seq: 0,
    lastEvent: null,
    pendingEvents: [],
    attentionByTab: { 'tab-1': true },
    attentionByPane: { 'pane-1': true },
    ...overrides,
  }
}
```

Add new test cases in the existing describe block:

```tsx
describe('extraReducers — pane/tab close cleanup', () => {
  it('closePane clears both pane and tab attention', () => {
    const state = stateWithAttention()
    const next = reducer(state, closePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(next.attentionByTab['tab-1']).toBeUndefined()
    expect(next.attentionByPane['pane-1']).toBeUndefined()
  })

  it('closePane on a pane without attention is a no-op', () => {
    const state = stateWithAttention()
    const next = reducer(state, closePane({ tabId: 'tab-2', paneId: 'pane-99' }))
    // Existing attention for tab-1/pane-1 is untouched
    expect(next.attentionByTab['tab-1']).toBe(true)
    expect(next.attentionByPane['pane-1']).toBe(true)
  })

  it('removeLayout clears tab attention', () => {
    const state = stateWithAttention()
    const next = reducer(state, removeLayout({ tabId: 'tab-1' }))
    expect(next.attentionByTab['tab-1']).toBeUndefined()
    // Pane entries are orphaned but not cleared (no tab→pane mapping in this slice)
  })

  it('removeLayout on a tab without attention is a no-op', () => {
    const state = stateWithAttention()
    const next = reducer(state, removeLayout({ tabId: 'tab-99' }))
    expect(next.attentionByTab['tab-1']).toBe(true)
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client/store/turnCompletionSlice.test.ts --reporter=verbose`
Expected: FAIL — `closePane` and `removeLayout` are not recognized by the turnCompletionSlice reducer yet.

Note: `closePane` requires valid pane layout state to actually modify the panes slice, but the turnCompletionSlice extraReducer fires regardless — it only looks at the action payload. The reducer test passes state directly to the turnCompletion reducer, so the panes slice layout validity doesn't matter.

**Step 3: Implement extraReducers**

In `src/store/turnCompletionSlice.ts`:

Add import at the top:
```tsx
import { closePane, removeLayout } from './panesSlice.js'
```

Change the `createSlice` call to add `extraReducers` after the `reducers` block:

```tsx
const turnCompletionSlice = createSlice({
  name: 'turnCompletion',
  initialState,
  reducers: {
    // ... existing reducers unchanged ...
  },
  extraReducers: (builder) => {
    builder
      .addCase(closePane, (state, action) => {
        const { tabId, paneId } = action.payload
        delete state.attentionByPane[paneId]
        delete state.attentionByTab[tabId]
      })
      .addCase(removeLayout, (state, action) => {
        const { tabId } = action.payload
        delete state.attentionByTab[tabId]
      })
  },
})
```

**Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/client/store/turnCompletionSlice.test.ts --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/store/turnCompletionSlice.ts test/unit/client/store/turnCompletionSlice.test.ts
git commit -m "fix(attention): clear attention state on pane/tab close

Add extraReducers to turnCompletionSlice that react to closePane and
removeLayout from panesSlice. On closePane, both attentionByPane[paneId]
and attentionByTab[tabId] are cleared. On removeLayout (tab close),
attentionByTab[tabId] is cleared."
```

---

### Task 3: Full test suite + verify

**Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass (including the new ones from Tasks 1 and 2).

**Step 2: Commit if any fixes were needed**

If any existing tests broke, fix them and commit.

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/components/TabBar.tsx` | onClick: dispatch clearTabAttention/clearPaneAttention in click mode (handles already-active tab) |
| `src/store/turnCompletionSlice.ts` | Add extraReducers for closePane → clear pane+tab attention, removeLayout → clear tab attention |
| `test/unit/client/store/turnCompletionSlice.test.ts` | 4 new tests for extraReducers |
| `test/e2e/turn-complete-notification-flow.test.tsx` | 1 new e2e test for click-of-active-tab |
| `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx` | 1 new unit test (optional — validates actions work) |

## Design Notes

- **Click-of-active-tab**: Handled in TabBar rather than the hook because `setActiveTab(sameId)` is a Redux no-op — no dependency change → no effect. The TabBar click handler is the only place that knows a click happened.
- **extraReducers vs middleware**: extraReducers is the idiomatic RTK pattern for cross-slice reactions. No middleware or thunk needed.
- **Tab attention clearing on closePane is aggressive**: Closing ANY pane in a tab clears the tab's attention, even if another pane still has attention. This is correct UX — the user is actively engaged with this tab (they're closing panes), so the tab-level indicator should dismiss. The remaining pane still has its pane-level indicator.
- **Orphaned pane entries on removeLayout**: When a tab is closed, its `attentionByPane` entries are not cleaned up (we don't have a tab→pane mapping in the turnCompletion state). These are harmless — no component selects them — and will be overwritten if the same pane ID is reused.

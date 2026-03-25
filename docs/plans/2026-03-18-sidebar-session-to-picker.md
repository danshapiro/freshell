# Sidebar Session Click Routes to Picker Pane — Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a picker pane exists in the active tab's layout, clicking a sidebar session rehydrates into that picker pane instead of splitting a new pane. When multiple picker panes exist, select the leftmost (then uppermost) using tree traversal order.

**Architecture:** Add a `findFirstPickerPane` tree-traversal utility to `src/lib/pane-utils.ts`. Insert a new step between dedup (step 1) and fallback (step 2) in `handleItemClick` in `Sidebar.tsx` that finds a picker pane and dispatches `updatePaneContent` + `setActivePane` instead of `addPane`. The `collectPaneEntries` traversal order (left-child-first, depth-first) already implements the "leftmost then uppermost" tiebreak rule.

**Tech Stack:** React 18, Redux Toolkit, Vitest, React Testing Library

---

## Design Decisions

### Where to put the picker-finding logic

**Decision:** Add `findFirstPickerPane` to `src/lib/pane-utils.ts`.

**Justification:** `pane-utils.ts` already contains tree-traversal helpers (`collectPaneEntries`, `findPaneContent`, `collectTerminalIds`, etc.) that operate on `PaneNode` trees. A new `findFirstPickerPane` function is a natural fit here. It does not belong in the Redux slice (where `collectLeaves` lives) because the slice's helpers are private to the reducer, and this logic needs to be called from a React component. It does not belong in the Sidebar itself because it's a pure tree utility with no UI coupling.

### Tiebreak: leftmost then uppermost

**Decision:** Use left-to-right depth-first traversal (same as `collectPaneEntries` and the slice's `collectLeaves`).

**Justification:** The pane tree is a binary tree where splits are either horizontal or vertical. Left child appears first spatially (left or top). A left-to-right depth-first traversal visits the visually leftmost pane first, then for panes at the same horizontal position, the topmost. This matches the user's stated tiebreak rule. The existing `collectPaneEntries` function in `pane-utils.ts` already traverses in this order.

### Interaction with dedup (step 1)

**Decision:** Dedup takes priority over picker. If a session is already open somewhere, the dedup path fires and the picker is ignored.

**Justification:** The user confirmed this: "If there is a panel picker up, and you click a session from the sidebar, put it in the panel picker." The "already open" dedup path is a separate concern — it prevents opening the same session twice. The picker path only applies when the session would otherwise create a new pane.

### Scope: active tab only

**Decision:** Only search for picker panes in the active tab's layout.

**Justification:** The existing step 3 (split new pane) only operates on the active tab. The picker search should have the same scope. If the active tab has no picker but another tab does, the session should split in the active tab as before. Searching other tabs would change existing behavior in ways the user didn't request.

### updatePaneContent vs addPane

**Decision:** Use `updatePaneContent` to replace the picker's `{ kind: 'picker' }` content with the resume content, and `setActivePane` to focus the filled pane.

**Justification:** This is the same pattern used by `PickerWrapper` in `PaneContainer.tsx` (line 641). It replaces content in-place without changing the tree shape, which is exactly what the user wants — "put it in the panel picker instead of a new panel."

### Session metadata update

**Decision:** The picker path also updates `sessionMetadataByKey` on the tab, same as the split path.

**Justification:** Session metadata is needed regardless of how the session enters the tab (split or picker fill). Omitting it would create an inconsistency where sessions opened via picker don't get their metadata tracked on the tab.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/pane-utils.ts` | Modify | Add `findFirstPickerPane` tree-traversal helper |
| `src/components/Sidebar.tsx` | Modify | Add picker-pane step (step 2.5) in `handleItemClick` |
| `test/e2e/sidebar-click-opens-pane.test.tsx` | Modify | Add 6 new test cases for picker behavior |

No new files. No server changes. No backend changes.

---

## Task 1: Add `findFirstPickerPane` utility to `pane-utils.ts`

**Files:**
- Modify: `src/lib/pane-utils.ts`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This task adds the pure tree-traversal helper. It returns the pane ID of the first picker leaf in traversal order, or `undefined` if none exists.

- [ ] **Step 1: Write the failing test — single picker pane (happy path)**

Add a new `describe('sidebar click routes to picker pane')` block in `test/e2e/sidebar-click-opens-pane.test.tsx`. First test: active tab has one leaf pane with `kind: 'picker'`. Click a session. Assert: layout remains a leaf (not split), content has `resumeSessionId` matching the clicked session, no new tab created.

```tsx
// In test/e2e/sidebar-click-opens-pane.test.tsx, add inside the existing describe block:

it('clicking a session fills an existing picker pane instead of splitting', async () => {
  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project',
      sessions: [
        {
          sessionId: sessionId('fill-picker'),
          projectPath: '/home/user/project',
          lastActivityAt: Date.now(),
          title: 'Fill picker session',
          cwd: '/home/user/project',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{ id: 'tab-1', mode: 'shell' }],
    activeTabId: 'tab-1',
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-picker',
          content: { kind: 'picker' },
        },
      },
      activePane: { 'tab-1': 'pane-picker' },
      paneTitles: {},
    },
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Fill picker session').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()

  // Should NOT create a new tab
  expect(state.tabs.tabs).toHaveLength(1)
  // Layout should remain a leaf (not split)
  const layout = state.panes.layouts['tab-1']
  expect(layout.type).toBe('leaf')
  // Content should be the resumed session, not picker
  if (layout.type === 'leaf') {
    expect(layout.content.kind).toBe('terminal')
    if (layout.content.kind === 'terminal') {
      expect(layout.content.resumeSessionId).toBe(sessionId('fill-picker'))
      expect(layout.content.mode).toBe('claude')
    }
  }
  // Active pane should be the picker pane (now filled)
  expect(state.panes.activePane['tab-1']).toBe('pane-picker')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "clicking a session fills an existing picker pane"`
Expected: FAIL — the current code splits a new pane instead of filling the picker.

- [ ] **Step 3: Implement `findFirstPickerPane` in `pane-utils.ts`**

Add the following function to `src/lib/pane-utils.ts`:

```typescript
/**
 * Find the first picker pane in a pane tree using left-to-right depth-first traversal.
 * This traversal order produces "leftmost then uppermost" tiebreaking:
 * left children appear before right children at each split level.
 * Returns the pane ID if found, undefined otherwise.
 */
export function findFirstPickerPane(node: PaneNode): string | undefined {
  if (node.type === 'leaf') {
    return node.content.kind === 'picker' ? node.id : undefined
  }
  return findFirstPickerPane(node.children[0]) ?? findFirstPickerPane(node.children[1])
}
```

- [ ] **Step 4: Add picker step to `handleItemClick` in `Sidebar.tsx`**

In `src/components/Sidebar.tsx`:

1. Add `updatePaneContent` to the import from `@/store/panesSlice`:
   ```typescript
   import { addPane, setActivePane, updatePaneContent } from '@/store/panesSlice'
   ```

2. Add import for `findFirstPickerPane`:
   ```typescript
   import { findFirstPickerPane } from '@/lib/pane-utils'
   ```

3. Insert a new step between the existing step 2 (fallback — no active tab) and step 3 (normal — split). The new step goes right after the `if (!currentActiveTabId || !activeLayout)` block and before the `// 3. Normal: split a new pane` comment. The new code:

```typescript
    // 2.5. Picker: if the active tab has a picker pane, fill it instead of splitting
    const pickerPaneId = findFirstPickerPane(activeLayout)
    if (pickerPaneId) {
      dispatch(updatePaneContent({
        tabId: currentActiveTabId,
        paneId: pickerPaneId,
        content: buildResumeContent({
          sessionType,
          sessionId: item.sessionId,
          cwd: item.cwd,
          terminalId: runningTerminalId,
          agentChatProviderSettings: providerSettings,
        }),
      }))
      dispatch(setActivePane({ tabId: currentActiveTabId, paneId: pickerPaneId }))
      const activeTab = state.tabs.tabs.find((tab) => tab.id === currentActiveTabId)
      const sessionMetadataByKey = mergeSessionMetadataByKey(
        activeTab?.sessionMetadataByKey,
        provider,
        item.sessionId,
        {
          sessionType,
          firstUserMessage: item.firstUserMessage,
          isSubagent: item.isSubagent,
          isNonInteractive: item.isNonInteractive,
        },
      )
      if (activeTab && sessionMetadataByKey !== activeTab.sessionMetadataByKey) {
        dispatch(updateTab({
          id: currentActiveTabId,
          updates: { sessionMetadataByKey },
        }))
      }
      onNavigate('terminal')
      return
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "clicking a session fills an existing picker pane"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add src/lib/pane-utils.ts src/components/Sidebar.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "feat: route sidebar session click to picker pane instead of splitting"
```

---

## Task 2: Test picker pane alongside non-picker pane

**Files:**
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This test verifies that when the active tab has a split with one picker leaf and one shell leaf, clicking a session replaces the picker leaf's content and leaves the shell untouched.

- [ ] **Step 1: Write the test**

```tsx
it('clicking a session fills picker pane when tab has picker plus non-picker pane', async () => {
  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project',
      sessions: [
        {
          sessionId: sessionId('fill-picker-split'),
          projectPath: '/home/user/project',
          lastActivityAt: Date.now(),
          title: 'Fill picker in split',
          cwd: '/home/user/project',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{ id: 'tab-1', mode: 'shell' }],
    activeTabId: 'tab-1',
    panes: {
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-shell',
              content: {
                kind: 'terminal',
                mode: 'shell',
                createRequestId: 'req-shell',
                status: 'running',
              },
            },
            {
              type: 'leaf',
              id: 'pane-picker',
              content: { kind: 'picker' },
            },
          ],
        },
      },
      activePane: { 'tab-1': 'pane-shell' },
      paneTitles: {},
    },
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Fill picker in split').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()

  // Should NOT create a new tab
  expect(state.tabs.tabs).toHaveLength(1)
  // Layout should still be a split (no extra pane added)
  const layout = state.panes.layouts['tab-1']
  expect(layout.type).toBe('split')
  if (layout.type === 'split') {
    // Shell pane untouched
    const shellPane = layout.children[0]
    expect(shellPane.type).toBe('leaf')
    if (shellPane.type === 'leaf') {
      expect(shellPane.content.kind).toBe('terminal')
      if (shellPane.content.kind === 'terminal') {
        expect(shellPane.content.mode).toBe('shell')
      }
    }
    // Picker pane replaced with session
    const filledPane = layout.children[1]
    expect(filledPane.type).toBe('leaf')
    if (filledPane.type === 'leaf') {
      expect(filledPane.content.kind).toBe('terminal')
      if (filledPane.content.kind === 'terminal') {
        expect(filledPane.content.resumeSessionId).toBe(sessionId('fill-picker-split'))
        expect(filledPane.content.mode).toBe('claude')
      }
    }
  }
  // Active pane should switch to the filled picker pane
  expect(state.panes.activePane['tab-1']).toBe('pane-picker')
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "clicking a session fills picker pane when tab has picker plus non-picker pane"`
Expected: PASS (the implementation from Task 1 already handles this case)

- [ ] **Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: picker pane fills correctly in split layout"
```

---

## Task 3: Test two-picker tiebreak (leftmost wins)

**Files:**
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This test verifies the tiebreak rule: when two picker panes exist, the leftmost (first in tree traversal) is filled.

- [ ] **Step 1: Write the test**

```tsx
it('with two picker panes, fills the leftmost one (tiebreak)', async () => {
  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project',
      sessions: [
        {
          sessionId: sessionId('tiebreak-session'),
          projectPath: '/home/user/project',
          lastActivityAt: Date.now(),
          title: 'Tiebreak session',
          cwd: '/home/user/project',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{ id: 'tab-1', mode: 'shell' }],
    activeTabId: 'tab-1',
    panes: {
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-left-picker',
              content: { kind: 'picker' },
            },
            {
              type: 'leaf',
              id: 'pane-right-picker',
              content: { kind: 'picker' },
            },
          ],
        },
      },
      activePane: { 'tab-1': 'pane-right-picker' },
      paneTitles: {},
    },
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Tiebreak session').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()

  const layout = state.panes.layouts['tab-1']
  expect(layout.type).toBe('split')
  if (layout.type === 'split') {
    // Left picker should be filled
    const leftPane = layout.children[0]
    expect(leftPane.type).toBe('leaf')
    if (leftPane.type === 'leaf') {
      expect(leftPane.content.kind).toBe('terminal')
      if (leftPane.content.kind === 'terminal') {
        expect(leftPane.content.resumeSessionId).toBe(sessionId('tiebreak-session'))
      }
    }
    // Right picker should remain a picker
    const rightPane = layout.children[1]
    expect(rightPane.type).toBe('leaf')
    if (rightPane.type === 'leaf') {
      expect(rightPane.content.kind).toBe('picker')
    }
  }
  // Active pane should switch to the left picker (the one that was filled)
  expect(state.panes.activePane['tab-1']).toBe('pane-left-picker')
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "with two picker panes, fills the leftmost one"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: two picker panes tiebreak selects leftmost"
```

---

## Task 4: Test dedup takes precedence over picker

**Files:**
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This test verifies that when a session is already open in a pane AND a picker pane exists, the dedup path fires (focuses the existing pane) and the picker is ignored.

- [ ] **Step 1: Write the test**

```tsx
it('dedup takes precedence over picker pane when session already open', async () => {
  const targetId = sessionId('already-open-with-picker')

  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project',
      sessions: [
        {
          sessionId: targetId,
          projectPath: '/home/user/project',
          lastActivityAt: Date.now(),
          title: 'Already open with picker',
          cwd: '/home/user/project',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [
      { id: 'tab-1', mode: 'shell' },
      { id: 'tab-2', mode: 'claude' },
    ],
    activeTabId: 'tab-1',
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-picker',
          content: { kind: 'picker' },
        },
        'tab-2': {
          type: 'leaf',
          id: 'pane-existing',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-existing',
            status: 'running',
            resumeSessionId: targetId,
          },
        },
      },
      activePane: {
        'tab-1': 'pane-picker',
        'tab-2': 'pane-existing',
      },
      paneTitles: {},
    },
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Already open with picker').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()

  // Should switch to tab-2 where the session lives (dedup)
  expect(state.tabs.activeTabId).toBe('tab-2')
  expect(state.panes.activePane['tab-2']).toBe('pane-existing')
  // Picker in tab-1 should remain untouched
  const tab1Layout = state.panes.layouts['tab-1']
  expect(tab1Layout.type).toBe('leaf')
  if (tab1Layout.type === 'leaf') {
    expect(tab1Layout.content.kind).toBe('picker')
  }
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "dedup takes precedence over picker"`
Expected: PASS (dedup logic is unchanged and runs before picker check)

- [ ] **Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: dedup takes precedence over picker pane"
```

---

## Task 5: Regression — no picker present still splits

**Files:**
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This is explicitly a regression test: when no picker exists, the existing split behavior must be unchanged. The existing test `'clicking a session splits a pane in the current tab'` already covers this, but we add a more targeted variant that confirms the new code path is cleanly skipped.

- [ ] **Step 1: Run existing regression test**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "clicking a session splits a pane in the current tab"`
Expected: PASS (existing behavior unchanged)

- [ ] **Step 2: Commit** (no-op — existing test provides regression coverage)

No new test needed; this step confirms the existing tests pass with the new code.

---

## Task 6: Test agent-chat session type fills picker

**Files:**
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

This test verifies that a freshclaude (agent-chat) session fills a picker pane with `kind: 'agent-chat'` content.

- [ ] **Step 1: Write the test**

```tsx
it('clicking a freshclaude session fills a picker pane with agent-chat content', async () => {
  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/user/project',
      sessions: [
        {
          sessionId: sessionId('freshclaude-picker'),
          projectPath: '/home/user/project',
          lastActivityAt: Date.now(),
          title: 'Freshclaude into picker',
          cwd: '/home/user/project',
          sessionType: 'freshclaude',
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{ id: 'tab-1', mode: 'shell' }],
    activeTabId: 'tab-1',
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-picker',
          content: { kind: 'picker' },
        },
      },
      activePane: { 'tab-1': 'pane-picker' },
      paneTitles: {},
    },
  })

  renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Freshclaude into picker').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()

  expect(state.tabs.tabs).toHaveLength(1)
  const layout = state.panes.layouts['tab-1']
  expect(layout.type).toBe('leaf')
  if (layout.type === 'leaf') {
    expect(layout.content.kind).toBe('agent-chat')
    if (layout.content.kind === 'agent-chat') {
      expect(layout.content.provider).toBe('freshclaude')
      expect(layout.content.resumeSessionId).toBe(sessionId('freshclaude-picker'))
    }
  }
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx -t "clicking a freshclaude session fills a picker pane"`
Expected: PASS (the implementation uses `buildResumeContent` which already handles freshclaude → agent-chat routing)

- [ ] **Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test: agent-chat session fills picker pane correctly"
```

---

## Task 7: Add `findFirstPickerPane` unit test

**Files:**
- Create: `test/unit/client/lib/pane-utils.test.ts` (or add to existing if present)
- Test: `test/unit/client/lib/pane-utils.test.ts`

The `findFirstPickerPane` utility is pure logic and deserves a focused unit test to cover edge cases (no picker, single picker, nested split with picker in left vs right child).

- [ ] **Step 1: Check if pane-utils test file exists**

Run: `ls /home/user/code/freshell/.worktrees/sidebar-session-to-picker/test/unit/client/lib/pane-utils.test.ts 2>/dev/null || echo "does not exist"`

- [ ] **Step 2: Write the unit tests**

Create or add to `test/unit/client/lib/pane-utils.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { findFirstPickerPane } from '@/lib/pane-utils'
import type { PaneNode } from '@/store/paneTypes'

describe('findFirstPickerPane', () => {
  it('returns undefined for a single non-picker leaf', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-1',
      content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' },
    }
    expect(findFirstPickerPane(node)).toBeUndefined()
  })

  it('returns the id for a single picker leaf', () => {
    const node: PaneNode = {
      type: 'leaf',
      id: 'pane-picker',
      content: { kind: 'picker' },
    }
    expect(findFirstPickerPane(node)).toBe('pane-picker')
  })

  it('returns the left picker in a horizontal split with two pickers', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'picker' } },
        { type: 'leaf', id: 'right', content: { kind: 'picker' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('left')
  })

  it('finds a picker in the right subtree when left has none', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
        { type: 'leaf', id: 'right', content: { kind: 'picker' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('right')
  })

  it('returns undefined for a split with no picker panes', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
        { type: 'leaf', id: 'right', content: { kind: 'terminal', mode: 'claude', createRequestId: 'r2', status: 'running' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBeUndefined()
  })

  it('finds picker in deeply nested left subtree', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-outer',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'split',
          id: 'split-inner',
          direction: 'vertical',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'top-left', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
            { type: 'leaf', id: 'bottom-left', content: { kind: 'picker' } },
          ],
        },
        { type: 'leaf', id: 'right', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r2', status: 'running' } },
      ],
    }
    expect(findFirstPickerPane(node)).toBe('bottom-left')
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/unit/client/lib/pane-utils.test.ts`
Expected: PASS (all 6 unit tests)

- [ ] **Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/unit/client/lib/pane-utils.test.ts
git commit -m "test: unit tests for findFirstPickerPane utility"
```

---

## Task 8: Fix missing `BackgroundTerminal` import in test file

**Files:**
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

The test file references `BackgroundTerminal` type (line 85) but does not import it.

- [ ] **Step 1: Add the import**

Add to the imports in `test/e2e/sidebar-click-opens-pane.test.tsx`:

```typescript
import type { BackgroundTerminal } from '@/store/types'
```

This import should be placed alongside the existing `import type { ProjectGroup } from '@/store/types'` — merge them into a single import:

```typescript
import type { ProjectGroup, BackgroundTerminal } from '@/store/types'
```

- [ ] **Step 2: Run all tests in the file to verify nothing breaks**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "fix: add missing BackgroundTerminal type import in test"
```

---

## Task 9: Run full test suite and refactor

**Files:**
- All modified files from above

- [ ] **Step 1: Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx`
Expected: All tests PASS (existing + new)

- [ ] **Step 2: Run typecheck**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Run lint**

Run: `cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker && npm run lint`
Expected: No lint errors

- [ ] **Step 4: Review for refactoring opportunities**

Check if the session metadata update code (the `mergeSessionMetadataByKey` block) is duplicated between the picker path and the split path. If so, extract it into a local helper within `handleItemClick` to DRY it up. The extracted helper would take `(tabId, provider, item)` and dispatch the `updateTab` if needed.

If refactoring is done, re-run all tests to verify.

- [ ] **Step 5: Commit any refactoring**

```bash
cd /home/user/code/freshell/.worktrees/sidebar-session-to-picker
git add -A
git commit -m "refactor: DRY session metadata update in handleItemClick"
```

---

## Summary of Changes

| File | Lines Changed (approx.) | What Changes |
|---|---|---|
| `src/lib/pane-utils.ts` | +12 | New `findFirstPickerPane` function |
| `src/components/Sidebar.tsx` | +25, ~2 import lines | New picker step in `handleItemClick`, new imports |
| `test/e2e/sidebar-click-opens-pane.test.tsx` | +200 | 5 new e2e test cases, import fix |
| `test/unit/client/lib/pane-utils.test.ts` | +70 (new) | 6 unit tests for `findFirstPickerPane` |

Total: ~310 lines added/changed across 4 files.

## Risks and Mitigations

1. **Tree traversal order mismatch:** The `findFirstPickerPane` function uses the same left-to-right depth-first traversal as every other tree walker in the codebase (`collectLeaves`, `collectPaneEntries`, `collectPaneContents`). The tiebreak test (Task 3) explicitly verifies leftmost-wins behavior.

2. **Picker in non-active tab:** By design, only the active tab's layout is searched. This matches the scope of the existing split behavior and prevents unexpected cross-tab effects.

3. **Race with picker UI:** The picker pane's `kind: 'picker'` content is stable until the user selects a type through the picker UI. If the user clicks a sidebar session while the picker is visible, `handleItemClick` reads the store synchronously, so it will always see the current content. No race condition exists.

4. **Session metadata consistency:** The picker path includes the same `mergeSessionMetadataByKey` + `updateTab` logic as the split path, ensuring session metadata is tracked regardless of entry path.

# Sidebar Click Opens Pane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make sidebar session clicks open sessions as panes in the current tab instead of creating new tabs.

**Architecture:** Add a `findPaneForSession` utility to locate existing panes by session (with tab-level fallback for early boot), then change the sidebar click handler to use `addPane` (split active pane) instead of `openSessionTab`. Dedup focuses existing pane; fallback creates new tab when no tabs exist or active tab has no layout.

**Tech Stack:** React, Redux Toolkit, Vitest

---

### Task 1: Add `findPaneForSession` utility — write failing tests

**Files:**
- Test: `test/unit/client/lib/session-utils.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block at the end of `session-utils.test.ts`:

```typescript
describe('findPaneForSession', () => {
  it('returns tabId and paneId when session is in a leaf', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('claude', VALID_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-a',
    })
  })

  it('finds session in a nested split', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
        leaf('pane-b', terminalContent('claude', VALID_SESSION_ID)),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-b',
    })
  })

  it('finds session in a background tab', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
          'tab-2': leaf('pane-b', terminalContent('codex', OTHER_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-a', 'tab-2': 'pane-b' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, 'codex', OTHER_SESSION_ID)).toEqual({
      tabId: 'tab-2',
      paneId: 'pane-b',
    })
  })

  it('returns undefined when session is not open', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
        },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toBeUndefined()
  })

  it('returns undefined for tabs without layouts', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toBeUndefined()
  })

  it('falls back to tab-level match when tab has resumeSessionId but no layout', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', mode: 'claude', resumeSessionId: VALID_SESSION_ID }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    // Returns tabId but no paneId since there's no pane tree yet
    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
      tabId: 'tab-1',
      paneId: undefined,
    })
  })
})
```

Update the import line at the top of the file — change:
```typescript
import { getSessionsForHello, findTabIdForSession } from '@/lib/session-utils'
```
to:
```typescript
import { getSessionsForHello, findTabIdForSession, findPaneForSession } from '@/lib/session-utils'
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/unit/client/lib/session-utils.test.ts`
Expected: FAIL — `findPaneForSession` is not exported from `@/lib/session-utils`

**Step 3: Commit**

```bash
git add test/unit/client/lib/session-utils.test.ts
git commit -m "test: add failing tests for findPaneForSession utility"
```

---

### Task 2: Implement `findPaneForSession`

**Files:**
- Modify: `src/lib/session-utils.ts`

**Step 1: Add the function**

Add this function after `findTabIdForSession` (after line 78) in `src/lib/session-utils.ts`:

```typescript
/**
 * Find the tab and pane that contain a specific session.
 * Walks all tabs' pane trees looking for a terminal pane matching the provider + sessionId.
 * Falls back to tab-level resumeSessionId when no layout exists (early boot/rehydration).
 */
export function findPaneForSession(
  state: RootState,
  provider: CodingCliProviderName,
  sessionId: string
): { tabId: string; paneId: string | undefined } | undefined {
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (layout) {
      const paneId = findPaneInNode(layout, provider, sessionId)
      if (paneId) return { tabId: tab.id, paneId }
      continue
    }

    // Fallback: tab has resumeSessionId but no pane layout yet (early boot)
    const tabProvider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
    if (tabProvider !== provider) continue
    const tabSessionId = tab.resumeSessionId
    if (!tabSessionId) continue
    if (provider === 'claude' && !isValidClaudeSessionId(tabSessionId)) continue
    if (tabSessionId === sessionId) return { tabId: tab.id, paneId: undefined }
  }
  return undefined
}

function findPaneInNode(
  node: PaneNode,
  provider: CodingCliProviderName,
  sessionId: string
): string | undefined {
  if (node.type === 'leaf') {
    const ref = extractSessionRef(node.content)
    if (ref && ref.provider === provider && ref.sessionId === sessionId) {
      return node.id
    }
    return undefined
  }
  return findPaneInNode(node.children[0], provider, sessionId)
    ?? findPaneInNode(node.children[1], provider, sessionId)
}
```

Add `PaneNode` to the existing imports at the top of the file:
```typescript
import type { PaneContent, PaneNode } from '@/store/paneTypes'
```

**Step 2: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/lib/session-utils.test.ts`
Expected: All `findPaneForSession` tests PASS

**Step 3: Commit**

```bash
git add src/lib/session-utils.ts
git commit -m "feat: add findPaneForSession utility for pane-level session lookup

Includes tab-level fallback for early boot when pane layouts haven't
been hydrated yet, mirroring findTabIdForSession behavior."
```

---

### Task 3: Add typed `useAppStore` hook

**Files:**
- Modify: `src/store/hooks.ts`

The project uses `useAppDispatch` and `useAppSelector` typed hooks. We need `useAppStore` for type-safe `store.getState()` access in the sidebar click handler.

**Step 1: Add the hook**

Add to `src/store/hooks.ts`:

```typescript
import { TypedUseSelectorHook, useDispatch, useSelector, useStore } from 'react-redux'
import type { RootState, AppDispatch } from './store'

export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
export const useAppStore = () => useStore<RootState>()
```

**Step 2: Run full test suite to verify no regressions**

Run: `npm test`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/store/hooks.ts
git commit -m "feat: add useAppStore typed hook for store.getState() access"
```

---

### Task 4: Update sidebar click handler — write failing tests

**Files:**
- Test: `test/unit/client/components/Sidebar.test.tsx`

We need to test three scenarios for the click handler:
1. Session already open in a pane → focuses it (dispatches `setActiveTab` + `setActivePane`)
2. No active tab → falls back to `openSessionTab` (creates new tab)
3. Normal case → dispatches `addPane` on current tab
4. Active tab has no layout → falls back to `openSessionTab`

**Step 1: Identify existing sidebar test structure**

Read `test/unit/client/components/Sidebar.test.tsx` to understand how the test store is set up, how sessions are rendered, and how clicks are triggered. Match those patterns.

**Step 2: Add the failing tests**

Add a new `describe('sidebar click opens pane', ...)` block. These tests should:

- Set up a store with tabs and pane layouts
- Render the sidebar with sessions
- Click a session item
- Assert the correct Redux state changes (check `store.getState()` for pane splits, active tab, active pane)

The exact test code depends on the existing test setup patterns in the file. Write tests matching those patterns.

**Step 3: Run tests to verify they fail**

Run: `npm test -- --run test/unit/client/components/Sidebar.test.tsx`
Expected: FAIL — sidebar still dispatches `openSessionTab`

**Step 4: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx
git commit -m "test: add failing tests for sidebar click opening panes"
```

---

### Task 5: Update `Sidebar.tsx` click handler

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: Update imports**

Add these imports to `Sidebar.tsx`:

```typescript
import { setActiveTab } from '@/store/tabsSlice'
import { addPane, setActivePane } from '@/store/panesSlice'
import { findPaneForSession } from '@/lib/session-utils'
import { useAppStore } from '@/store/hooks'
```

Keep `openSessionTab` — still needed for the no-active-tab and no-layout fallbacks.

**Step 2: Add store hook**

Inside the component body, before `handleItemClick`:

```typescript
const store = useAppStore()
```

**Step 3: Rewrite `handleItemClick`**

Replace the current `handleItemClick` (lines 202-212):

```typescript
const handleItemClick = useCallback((item: SessionItem) => {
  const provider = item.provider as CodingCliProviderName
  dispatch(openSessionTab({
    sessionId: item.sessionId,
    title: item.title,
    cwd: item.cwd,
    provider,
    terminalId: item.isRunning ? item.runningTerminalId : undefined,
  }))
  onNavigate('terminal')
}, [dispatch, onNavigate])
```

With:

```typescript
const handleItemClick = useCallback((item: SessionItem) => {
  const provider = item.provider as CodingCliProviderName
  const state = store.getState()
  const runningTerminalId = item.isRunning ? item.runningTerminalId : undefined

  // 1. Dedup: if session is already open in a pane, focus it
  const existing = findPaneForSession(state, provider, item.sessionId)
  if (existing) {
    dispatch(setActiveTab(existing.tabId))
    if (existing.paneId) {
      dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
    }
    onNavigate('terminal')
    return
  }

  // 2. Fallback: no active tab or active tab has no layout → create new tab
  const activeLayout = activeTabId ? state.panes.layouts[activeTabId] : undefined
  if (!activeTabId || !activeLayout) {
    dispatch(openSessionTab({
      sessionId: item.sessionId,
      title: item.title,
      cwd: item.cwd,
      provider,
      terminalId: runningTerminalId,
    }))
    onNavigate('terminal')
    return
  }

  // 3. Normal: split a new pane in the current tab
  dispatch(addPane({
    tabId: activeTabId,
    newContent: {
      kind: 'terminal',
      mode: provider,
      resumeSessionId: item.sessionId,
      initialCwd: item.cwd,
      terminalId: runningTerminalId,
      status: runningTerminalId ? 'running' : 'creating',
    },
  }))
  onNavigate('terminal')
}, [dispatch, onNavigate, activeTabId, store])
```

Key changes vs. original plan:
- Uses `useAppStore()` (typed) instead of raw `useStore()` from react-redux
- Checks `existing.paneId` before dispatching `setActivePane` (handles tab-level fallback where paneId is undefined)
- Guards against active tab having no layout — falls back to `openSessionTab` instead of a no-op `addPane`

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/components/Sidebar.test.tsx`
Expected: All sidebar tests PASS (both old and new)

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: sidebar click opens session in pane instead of new tab

Left-clicking a session in the sidebar now splits a new pane in the
current tab. If the session is already open, focuses the existing pane.
Falls back to creating a new tab when no tabs exist or active tab has
no layout yet."
```

---

### Task 6: Add e2e test for sidebar-click-opens-pane flow

**Files:**
- Create: `test/e2e/sidebar-click-opens-pane.test.tsx`

The project requires both unit and e2e coverage. This e2e test verifies the full user interaction flow with rendered components, a real Redux store, and mocked WebSocket/xterm.

**Step 1: Write the e2e test**

Follow the pattern from `test/e2e/tab-focus-behavior.test.tsx`:
- Configure a full store with tabs, panes, sessions, settings, connection
- Mock ws-client, xterm, xterm-addon-fit, ResizeObserver
- Render the Sidebar component wrapped in `<Provider>`
- Populate sessions state so sidebar items appear

Test scenarios:

1. **Click session → splits pane in current tab**: Set up a store with one tab that has a layout. Click a session in the sidebar. Verify `store.getState().panes.layouts[tabId]` now has a split with two leaves, one containing the clicked session's `resumeSessionId`.

2. **Click session already open → focuses existing pane**: Set up store where a session is already in a pane. Click that same session. Verify no new pane is created and `activePane` points to the existing pane.

3. **Click session with no active tab → creates new tab**: Set up store with no tabs. Click a session. Verify a new tab is created.

**Step 2: Run the e2e test**

Run: `npm test -- --run test/e2e/sidebar-click-opens-pane.test.tsx`
Expected: All tests PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test(e2e): add sidebar click opens pane integration test

Verifies full flow: click splits pane, dedup focuses existing,
no-tab fallback creates tab."
```

---

### Task 7: Refactor and cleanup

**Step 1: Review for duplication**

Check if the pane-opening logic in `handleItemClick` and `openSessionInThisTab` (in `ContextMenuProvider.tsx`) can share code. If nearly identical, extract a shared helper. If minor differences exist (e.g., context menu has `menuState` dependency), leave them separate.

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 3: Final commit (if refactored)**

```bash
git add -A
git commit -m "refactor: extract shared session-to-pane-content helper"
```

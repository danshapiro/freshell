# Alt+H Reopen Closed Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Alt+H keyboard shortcut to reopen the most recently closed tab, restoring its full pane layout, tab metadata, and making it active — in LIFO order across repeated presses.

**Architecture:** The feature threads through four layers: (1) shortcut detection in `getTabLifecycleAction` mapping Alt+H to `'reopen'`, (2) a dedicated reopen stack in `tabRegistrySlice` that captures every closed tab's full `PaneNode` layout tree alongside its `Tab` metadata (separate from the existing `localClosed` registry which only stores flat pane snapshots and applies a heuristic keep filter), (3) a `reopenClosedTab` async thunk that pops from the stack, re-creates the tab via `addTab`, and injects the saved layout directly into the panes slice, and (4) xterm passthrough so Alt+H does not get consumed by the terminal.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Vitest, Playwright

---

## Design Decisions

### D1: A separate `reopenStack` in tabRegistrySlice instead of reusing `localClosed`

The existing `localClosed: Record<string, RegistryTabRecord>` map has two problems for reopen:

1. **Heuristic filtering:** `shouldKeepClosedTab` discards short-lived single-pane tabs without custom titles. But Alt+H should reopen ANY closed tab, even a 1-second-old default tab. Users expect immediate undo semantics.

2. **Flat pane snapshots:** `RegistryTabRecord.panes` is a flat array of `RegistryPaneSnapshot` — the tree structure (split directions, sizes) is lost. Reopening a multi-split tab from flat snapshots would produce wrong layouts.

Instead, we add `reopenStack: ClosedTabEntry[]` to `TabRegistryState`, where `ClosedTabEntry` stores:
- The full `Tab` object (title, mode, shell, session IDs, etc.)
- The full `PaneNode` layout tree
- The `paneTitles` record
- A `closedAt` timestamp for LIFO ordering

The existing `localClosed` / `recordClosedTabSnapshot` flow is untouched — it continues to serve the TabsView "Recently Closed" display. The reopen stack is purely for Alt+H undo semantics.

**Justification:** The two features have fundamentally different requirements. `localClosed` is a filtered, flat, cross-device sync payload. The reopen stack is an unfiltered, full-fidelity, session-local undo buffer. Forcing them to share a data structure would either break the existing filtering or lose layout fidelity.

### D2: Stack is capped at 20 entries, not persisted

The reopen stack is:
- **Capped at 20 entries** — enough for any realistic undo chain, small enough to never be a memory concern. When a 21st entry is pushed, the oldest is evicted.
- **Not persisted to localStorage** — reopening is a session-local undo action. If you refresh the page, the reopen stack is empty. This avoids stale terminal IDs and layout references surviving across page loads.
- **Not synced across tabs/devices** — each browser tab has its own independent reopen stack.

**Justification:** Reopen is an "undo close" action, not a history feature. The TabsView "Recently Closed" section already handles history. Persisting or syncing the stack would add complexity with little benefit and stale-state risk.

### D3: Restoring the layout tree uses `initLayout` for single-pane, direct state injection for multi-pane

For a reopened tab, we need to inject the saved `PaneNode` tree into `panes.layouts[tabId]`. The existing `initLayout` reducer only creates single-leaf layouts and has a "don't overwrite" guard.

We add a new `restoreLayout` reducer to `panesSlice` that:
- Takes `{ tabId, layout: PaneNode, paneTitles: Record<string, string> }`
- Sets `state.layouts[tabId]` directly to the provided tree
- Sets `state.paneTitles[tabId]` to the provided titles
- Sets `state.activePane[tabId]` to the first leaf in the tree
- Normalizes all leaf content through `normalizePaneContent` (which assigns fresh `createRequestId` values, resets `terminalId` to `undefined`, and sets `status` to `'creating'`)

This means all terminals in a reopened tab go through the normal creation flow — new PTY processes are spawned. The tab's visual arrangement is restored, but terminal scrollback is not (it was lost when the PTY was destroyed on close). This is correct: the layout is the valuable thing to preserve; scrollback is ephemeral.

**Justification:** Direct state injection is the only way to restore arbitrary split trees. The normalization step ensures no stale terminal IDs are reused, and the normal terminal lifecycle manages the new PTY creation.

### D4: The `addTab` reducer needs a `titleSetByUser` field in its payload

Currently `AddTabPayload` does not include `titleSetByUser`. When restoring a closed tab that had a user-set title, we need to preserve that flag so the title doesn't get auto-overwritten. We add `titleSetByUser?: boolean` to `AddTabPayload` and wire it through.

**Justification:** Without this, a restored tab with a custom title like "Backend Server" would immediately get overwritten by auto-naming to "Tab 3" or the terminal's CWD.

### D5: Pane content normalization on restore resets terminal lifecycle

When a tab is reopened, its pane contents are normalized:
- `terminalId` is cleared (set to `undefined`) — the old PTY process is gone
- `createRequestId` gets a fresh value via `nanoid()` — triggers new `terminal.create`
- `status` is reset to `'creating'`
- Browser panes get a fresh `browserInstanceId`
- Editor panes preserve their content and file path
- Agent-chat panes get fresh `createRequestId` and reset to `'creating'` status

This means the tab reopens with its split layout intact, but all terminals start fresh. For coding CLI panes with `resumeSessionId`, the session resume flow will automatically reconnect to the session if it's still running.

**Justification:** The old PTY processes were destroyed when the tab was closed. There's no way to "reconnect" to them. The layout geometry (which splits, what sizes, what modes) is the valuable state. Terminals starting fresh is the correct behavior.

---

## File Structure

### New Files
- `test/unit/client/store/tabsSlice.reopen-tab.test.ts` — Unit tests for the `reopenClosedTab` thunk
- `test/unit/client/lib/tab-switch-shortcuts.reopen.test.ts` — Unit tests for Alt+H shortcut detection (extends existing test file pattern)
- `test/e2e-browser/specs/reopen-tab.spec.ts` — Playwright E2E test for the full reopen flow

### Modified Files
- `src/lib/tab-switch-shortcuts.ts` — Add `'reopen'` to `TabLifecycleAction`, detect Alt+H
- `src/lib/keyboard-shortcuts.ts` — Add Alt+H entry to `KEYBOARD_SHORTCUTS` array
- `src/store/tabRegistrySlice.ts` — Add `reopenStack` state, `pushReopenEntry` and `popReopenEntry` reducers
- `src/store/tabsSlice.ts` — Add `titleSetByUser` to `AddTabPayload`, create `reopenClosedTab` thunk
- `src/store/panesSlice.ts` — Add `restoreLayout` reducer
- `src/App.tsx` — Handle `'reopen'` lifecycle action
- `src/components/TerminalView.tsx` — Return `false` for Alt+H in xterm custom key handler

---

## Tasks

### Task 1: Shortcut Detection — Alt+H maps to `'reopen'`

**Files:**
- Modify: `src/lib/tab-switch-shortcuts.ts`
- Test: `test/unit/client/lib/tab-switch-shortcuts.test.ts`

- [ ] **Step 1: Write the failing test for Alt+H detection**

Add tests to the existing file `test/unit/client/lib/tab-switch-shortcuts.test.ts`:

```typescript
it('maps Alt+H to reopen', () => {
  expect(getTabLifecycleAction({
    altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
    code: 'KeyH',
  })).toBe('reopen')
})

it('rejects Alt+Ctrl+H (modifier combo)', () => {
  expect(getTabLifecycleAction({
    altKey: true, ctrlKey: true, shiftKey: false, metaKey: false,
    code: 'KeyH',
  })).toBeNull()
})

it('rejects Alt+Shift+H (modifier combo)', () => {
  expect(getTabLifecycleAction({
    altKey: true, ctrlKey: false, shiftKey: true, metaKey: false,
    code: 'KeyH',
  })).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/lib/tab-switch-shortcuts.test.ts`
Expected: FAIL — `getTabLifecycleAction` returns `null` for `KeyH`

- [ ] **Step 3: Implement Alt+H detection**

In `src/lib/tab-switch-shortcuts.ts`:

Change the type:
```typescript
export type TabLifecycleAction = 'new' | 'close' | 'reopen'
```

Add to `getTabLifecycleAction`:
```typescript
if (event.code === 'KeyH') return 'reopen'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/lib/tab-switch-shortcuts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-switch-shortcuts.ts test/unit/client/lib/tab-switch-shortcuts.test.ts
git commit -m "feat: detect Alt+H as 'reopen' tab lifecycle action"
```

---

### Task 2: Reopen Stack in tabRegistrySlice

**Files:**
- Modify: `src/store/tabRegistrySlice.ts`
- Test: `test/unit/client/store/tabRegistrySlice.test.ts`

- [ ] **Step 1: Write the failing test for pushReopenEntry and popReopenEntry**

Add to `test/unit/client/store/tabRegistrySlice.test.ts`:

```typescript
import reducer, {
  setTabRegistryLoading,
  setTabRegistrySnapshot,
  setTabRegistrySyncError,
  recordClosedTabSnapshot,
  pushReopenEntry,
  popReopenEntry,
} from '../../../../src/store/tabRegistrySlice'
import type { Tab } from '../../../../src/store/types'
import type { PaneNode } from '../../../../src/store/paneTypes'

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    createRequestId: 'req-1',
    title: 'Test Tab',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: 1000,
    ...overrides,
  }
}

function makeLeafLayout(id = 'pane-1'): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      terminalId: 'term-1',
      createRequestId: 'crq-1',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    },
  }
}

describe('reopenStack', () => {
  it('pushReopenEntry adds entry and popReopenEntry removes most recent', () => {
    let state = reducer(undefined, pushReopenEntry({
      tab: makeTab({ id: 'tab-a' }),
      layout: makeLeafLayout(),
      paneTitles: { 'pane-1': 'Shell' },
      closedAt: 100,
    }))
    state = reducer(state, pushReopenEntry({
      tab: makeTab({ id: 'tab-b' }),
      layout: makeLeafLayout('pane-2'),
      paneTitles: { 'pane-2': 'Shell 2' },
      closedAt: 200,
    }))

    expect(state.reopenStack).toHaveLength(2)

    state = reducer(state, popReopenEntry())
    expect(state.reopenStack).toHaveLength(1)
    expect(state.reopenStack[0].tab.id).toBe('tab-a')
  })

  it('popReopenEntry on empty stack is a no-op', () => {
    const state = reducer(undefined, popReopenEntry())
    expect(state.reopenStack).toHaveLength(0)
  })

  it('caps stack at 20 entries, evicting oldest', () => {
    let state = reducer(undefined, { type: 'unknown' })
    for (let i = 0; i < 25; i++) {
      state = reducer(state, pushReopenEntry({
        tab: makeTab({ id: `tab-${i}` }),
        layout: makeLeafLayout(`pane-${i}`),
        paneTitles: {},
        closedAt: i,
      }))
    }
    expect(state.reopenStack).toHaveLength(20)
    // Oldest entries (0-4) should have been evicted
    expect(state.reopenStack[0].tab.id).toBe('tab-5')
    expect(state.reopenStack[19].tab.id).toBe('tab-24')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/store/tabRegistrySlice.test.ts`
Expected: FAIL — `pushReopenEntry` and `popReopenEntry` are not exported

- [ ] **Step 3: Implement reopenStack in tabRegistrySlice**

In `src/store/tabRegistrySlice.ts`:

Add import at the top:
```typescript
import type { Tab } from './types'
import type { PaneNode } from './paneTypes'
```

Add the `ClosedTabEntry` type and `REOPEN_STACK_MAX`:
```typescript
export interface ClosedTabEntry {
  tab: Tab
  layout: PaneNode
  paneTitles: Record<string, string>
  closedAt: number
}

const REOPEN_STACK_MAX = 20
```

Add `reopenStack` to `TabRegistryState`:
```typescript
reopenStack: ClosedTabEntry[]
```

Add to `initialState`:
```typescript
reopenStack: [],
```

Add two reducers:
```typescript
pushReopenEntry: (state, action: PayloadAction<ClosedTabEntry>) => {
  state.reopenStack.push(action.payload)
  if (state.reopenStack.length > REOPEN_STACK_MAX) {
    state.reopenStack = state.reopenStack.slice(state.reopenStack.length - REOPEN_STACK_MAX)
  }
},
popReopenEntry: (state) => {
  state.reopenStack.pop()
},
```

Export the new actions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/store/tabRegistrySlice.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tabRegistrySlice.ts test/unit/client/store/tabRegistrySlice.test.ts
git commit -m "feat: add reopenStack to tabRegistrySlice for Alt+H undo buffer"
```

---

### Task 3: Add `restoreLayout` reducer to panesSlice

**Files:**
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/store/tabsSlice.reopen-tab.test.ts` (will be created in Task 4 — test restoreLayout in context of full thunk)

- [ ] **Step 1: Write the failing test for restoreLayout**

Create `test/unit/client/store/panesSlice.restore-layout.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import panesReducer, { restoreLayout } from '@/store/panesSlice'
import type { PaneNode, PanesState } from '@/store/paneTypes'

function emptySt(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
  }
}

describe('restoreLayout', () => {
  it('injects a single-leaf layout with normalized content', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'terminal',
        terminalId: 'stale-term-id',
        createRequestId: 'stale-crq',
        status: 'running',
        mode: 'shell',
        shell: 'system',
      },
    }

    const state = panesReducer(emptySt(), restoreLayout({
      tabId: 'tab-1',
      layout,
      paneTitles: { p1: 'My Shell' },
    }))

    expect(state.layouts['tab-1']).toBeDefined()
    const restored = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(restored.type).toBe('leaf')
    // terminalId should be cleared (new terminal will be created)
    expect(restored.content.kind).toBe('terminal')
    if (restored.content.kind === 'terminal') {
      expect(restored.content.terminalId).toBeUndefined()
      expect(restored.content.status).toBe('creating')
      expect(restored.content.createRequestId).not.toBe('stale-crq')
    }
    expect(state.paneTitles['tab-1']?.p1).toBe('My Shell')
    expect(state.activePane['tab-1']).toBe('p1')
  })

  it('injects a split layout and sets activePane to first leaf', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'p1',
          content: {
            kind: 'terminal',
            terminalId: 'old-1',
            createRequestId: 'old-crq-1',
            status: 'running',
            mode: 'shell',
          },
        },
        {
          type: 'leaf',
          id: 'p2',
          content: {
            kind: 'browser',
            browserInstanceId: 'old-browser',
            url: 'https://example.com',
            devToolsOpen: false,
          },
        },
      ],
    }

    const state = panesReducer(emptySt(), restoreLayout({
      tabId: 'tab-2',
      layout,
      paneTitles: { p1: 'Shell', p2: 'Browser' },
    }))

    const root = state.layouts['tab-2']!
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      const left = root.children[0]
      expect(left.type).toBe('leaf')
      if (left.type === 'leaf' && left.content.kind === 'terminal') {
        expect(left.content.terminalId).toBeUndefined()
        expect(left.content.status).toBe('creating')
      }
      const right = root.children[1]
      if (right.type === 'leaf' && right.content.kind === 'browser') {
        expect(right.content.browserInstanceId).not.toBe('old-browser')
      }
    }
    expect(state.activePane['tab-2']).toBe('p1')
  })

  it('does not overwrite an existing layout', () => {
    const existing: PaneNode = {
      type: 'leaf',
      id: 'existing-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'keep-me',
        status: 'running',
        mode: 'shell',
      },
    }
    const initial = emptySt()
    initial.layouts['tab-1'] = existing
    initial.activePane['tab-1'] = 'existing-pane'

    const newLayout: PaneNode = {
      type: 'leaf',
      id: 'new-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'new-crq',
        status: 'creating',
        mode: 'shell',
      },
    }

    const state = panesReducer(initial, restoreLayout({
      tabId: 'tab-1',
      layout: newLayout,
      paneTitles: {},
    }))

    // Should not overwrite — existing layout preserved
    expect(state.layouts['tab-1'].type).toBe('leaf')
    if (state.layouts['tab-1'].type === 'leaf') {
      expect(state.layouts['tab-1'].id).toBe('existing-pane')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/store/panesSlice.restore-layout.test.ts`
Expected: FAIL — `restoreLayout` is not exported from panesSlice

- [ ] **Step 3: Implement restoreLayout**

In `src/store/panesSlice.ts`, add a new reducer inside `panesSlice.reducers`:

```typescript
restoreLayout: (
  state,
  action: PayloadAction<{ tabId: string; layout: PaneNode; paneTitles: Record<string, string> }>
) => {
  const { tabId, layout, paneTitles } = action.payload
  // Don't overwrite existing layout (same guard as initLayout)
  if (state.layouts[tabId]) return

  // Deep-normalize all leaf content (clears stale terminalId, generates fresh createRequestId)
  const normalizedLayout = normalizeRestoredTree(layout)
  state.layouts[tabId] = normalizedLayout
  state.activePane[tabId] = findFirstLeafId(normalizedLayout)
  state.paneTitles[tabId] = paneTitles
  reconcileRefreshRequestsForTab(state, tabId)
},
```

Add two helper functions before the slice definition:

```typescript
function normalizeRestoredTree(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: node.id,
      content: normalizePaneContent(node.content),
    }
  }
  return {
    type: 'split',
    id: node.id,
    direction: node.direction,
    sizes: node.sizes,
    children: [
      normalizeRestoredTree(node.children[0]),
      normalizeRestoredTree(node.children[1]),
    ],
  }
}

function findFirstLeafId(node: PaneNode): string {
  if (node.type === 'leaf') return node.id
  return findFirstLeafId(node.children[0])
}
```

Export `restoreLayout` from the actions destructure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/store/panesSlice.restore-layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/panesSlice.ts test/unit/client/store/panesSlice.restore-layout.test.ts
git commit -m "feat: add restoreLayout reducer to panesSlice for tab reopen"
```

---

### Task 4: Add `titleSetByUser` to `AddTabPayload` and Create `reopenClosedTab` Thunk

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Test: `test/unit/client/store/tabsSlice.reopen-tab.test.ts`

- [ ] **Step 1: Write the failing test for reopenClosedTab**

Create `test/unit/client/store/tabsSlice.reopen-tab.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab, closeTab, reopenClosedTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, addPane } from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
    },
  })
}

describe('reopenClosedTab', () => {
  it('does nothing when reopen stack is empty', async () => {
    const store = createStore()
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(0)
  })

  it('reopens the most recently closed tab in LIFO order', async () => {
    const store = createStore()

    // Create and set up two tabs
    store.dispatch(addTab({ title: 'First' }))
    const firstId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId: firstId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    store.dispatch(addTab({ title: 'Second' }))
    const secondId = store.getState().tabs.tabs[1].id
    store.dispatch(initLayout({
      tabId: secondId,
      content: { kind: 'terminal', mode: 'claude' },
    }))

    // Close both (second then first — stack order: first on bottom, second on top)
    await store.dispatch(closeTab(secondId) as any)
    await store.dispatch(closeTab(firstId) as any)

    expect(store.getState().tabs.tabs).toHaveLength(0)
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(2)

    // Reopen — should get "First" back (LIFO — it was closed last)
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.tabs[0].title).toBe('First')
    expect(store.getState().tabs.activeTabId).toBe(store.getState().tabs.tabs[0].id)

    // Layout should be restored
    const tabId = store.getState().tabs.tabs[0].id
    expect(store.getState().panes.layouts[tabId]).toBeDefined()

    // Reopen again — should get "Second"
    await store.dispatch(reopenClosedTab() as any)
    expect(store.getState().tabs.tabs).toHaveLength(2)
    expect(store.getState().tabs.tabs[1].title).toBe('Second')

    // Stack should now be empty
    expect(store.getState().tabRegistry.reopenStack).toHaveLength(0)
  })

  it('preserves multi-pane layout structure on reopen', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Multi-pane' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))
    store.dispatch(addPane({
      tabId,
      newContent: { kind: 'terminal', mode: 'claude' },
    }))

    // Verify multi-pane before close
    const layoutBefore = store.getState().panes.layouts[tabId]!
    expect(layoutBefore.type).toBe('split')

    await store.dispatch(closeTab(tabId) as any)
    expect(store.getState().tabs.tabs).toHaveLength(0)

    await store.dispatch(reopenClosedTab() as any)
    const newTabId = store.getState().tabs.tabs[0].id
    const layoutAfter = store.getState().panes.layouts[newTabId]!
    expect(layoutAfter.type).toBe('split')
  })

  it('restores titleSetByUser flag', async () => {
    const store = createStore()

    store.dispatch(addTab({ title: 'Custom Title' }))
    const tabId = store.getState().tabs.tabs[0].id
    // Simulate user setting the title
    store.dispatch({ type: 'tabs/updateTab', payload: { id: tabId, updates: { titleSetByUser: true } } })
    store.dispatch(initLayout({
      tabId,
      content: { kind: 'terminal', mode: 'shell' },
    }))

    await store.dispatch(closeTab(tabId) as any)
    await store.dispatch(reopenClosedTab() as any)

    expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(true)
    expect(store.getState().tabs.tabs[0].title).toBe('Custom Title')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/store/tabsSlice.reopen-tab.test.ts`
Expected: FAIL — `reopenClosedTab` is not exported

- [ ] **Step 3: Implement `titleSetByUser` in AddTabPayload and the `reopenClosedTab` thunk**

In `src/store/tabsSlice.ts`:

Add `titleSetByUser` to `AddTabPayload`:
```typescript
type AddTabPayload = {
  id?: string
  title?: string
  titleSetByUser?: boolean
  // ... rest of existing fields
}
```

Wire it through in the `addTab` reducer body — add to the `tab` object construction:
```typescript
titleSetByUser: payload.titleSetByUser,
```

Add import for `pushReopenEntry` and `popReopenEntry`:
```typescript
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry } from './tabRegistrySlice'
import { restoreLayout } from './panesSlice'
```

In the existing `closeTab` thunk, add a `pushReopenEntry` dispatch right after the `recordClosedTabSnapshot` logic block (around line 281), BEFORE `removeTab` and `removeLayout` are called. This ensures EVERY closed tab goes on the reopen stack, regardless of `shouldKeepClosedTab`:

```typescript
// Always push to reopen stack (Alt+H should reopen any closed tab)
if (tab && layout) {
  dispatch(pushReopenEntry({
    tab: { ...tab },
    layout: JSON.parse(JSON.stringify(layout)),
    paneTitles: { ...(stateBeforeClose.panes.paneTitles[tabId] || {}) },
    closedAt: Date.now(),
  }))
}
```

Note: We deep-copy `layout` via `JSON.parse(JSON.stringify(...))` because Immer proxies are invalidated after the reducer runs. The `tab` spread is sufficient because Tab has only primitive/simple fields.

Create the `reopenClosedTab` thunk:

```typescript
export const reopenClosedTab = createAsyncThunk(
  'tabs/reopenClosedTab',
  async (_, { dispatch, getState }) => {
    const state = getState() as RootState
    const stack = state.tabRegistry.reopenStack
    if (stack.length === 0) return

    const entry = stack[stack.length - 1]
    dispatch(popReopenEntry())

    const newTabId = nanoid()
    dispatch(addTab({
      id: newTabId,
      title: entry.tab.title,
      titleSetByUser: entry.tab.titleSetByUser,
      mode: entry.tab.mode,
      shell: entry.tab.shell,
      initialCwd: entry.tab.initialCwd,
      codingCliSessionId: entry.tab.codingCliSessionId,
      codingCliProvider: entry.tab.codingCliProvider,
      resumeSessionId: entry.tab.resumeSessionId,
      sessionMetadataByKey: entry.tab.sessionMetadataByKey,
    }))

    dispatch(restoreLayout({
      tabId: newTabId,
      layout: entry.layout,
      paneTitles: entry.paneTitles,
    }))
  }
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/store/tabsSlice.reopen-tab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts
git commit -m "feat: add reopenClosedTab thunk with LIFO reopen stack"
```

---

### Task 5: App-level Dispatch — Alt+H dispatches `reopenClosedTab`

**Files:**
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.test.tsx` (add test to existing file)

- [ ] **Step 1: Write the failing test for Alt+H dispatching reopenClosedTab**

In `test/unit/client/components/App.test.tsx`, locate the existing keyboard shortcut test section. Add:

```typescript
it('dispatches reopenClosedTab on Alt+H', async () => {
  // Render the app
  // Fire Alt+H keydown event
  // Assert the thunk was dispatched
})
```

However, testing the full App component with Redux integration is complex. Instead, verify this through the existing e2e test (Task 7). For the unit level, the shortcut detection is already covered in Task 1. The wiring in App.tsx is a thin integration layer.

Given the App.tsx test complexity, we will verify App-level dispatch correctness through the e2e-browser test in Task 7.

- [ ] **Step 2: Implement Alt+H handling in App.tsx**

In `src/App.tsx`, find the `onKeyDown` handler that processes lifecycle actions (around line 935). Import `reopenClosedTab`:

```typescript
import { addTab, closeTab, switchToNextTab, switchToPrevTab, reopenClosedTab } from '@/store/tabsSlice'
```

Modify the lifecycle action block:
```typescript
const lifecycleAction = getTabLifecycleAction(e)
if (lifecycleAction) {
  e.preventDefault()
  if (lifecycleAction === 'new') {
    dispatch(addTab())
  } else if (lifecycleAction === 'reopen') {
    dispatch(reopenClosedTab())
  } else {
    const activeTabId = appStore.getState().tabs.activeTabId
    if (activeTabId) dispatch(closeTab(activeTabId))
  }
  return
}
```

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire Alt+H to reopenClosedTab dispatch in App.tsx"
```

---

### Task 6: Terminal Passthrough — xterm returns `false` for Alt+H

**Files:**
- Modify: `src/components/TerminalView.tsx`

- [ ] **Step 1: Verify the existing passthrough pattern**

The existing code in `TerminalView.tsx` already has a block (around line 1166):
```typescript
if (getTabLifecycleAction(event)) {
  return false
}
```

Because we added `'reopen'` to the `TabLifecycleAction` type and `KeyH` to the detection function in Task 1, this existing block already handles Alt+H correctly — `getTabLifecycleAction` will return `'reopen'` for Alt+H, and the handler returns `false`, preventing xterm from consuming the keystroke.

No code change is needed. Verify by checking the existing logic.

- [ ] **Step 2: Write a test to confirm the passthrough behavior**

The passthrough behavior is implicitly tested by the shortcut detection tests in Task 1 (the function returns a truthy value for Alt+H, causing the `if` to trigger and return `false`). No separate test file is needed.

- [ ] **Step 3: Commit (no changes needed — document verification)**

No commit needed; the existing code handles this case after Task 1's changes.

---

### Task 7: Keyboard Shortcuts Display — Add Alt+H entry

**Files:**
- Modify: `src/lib/keyboard-shortcuts.ts`

- [ ] **Step 1: Write the failing test**

Check if there are existing tests for the KEYBOARD_SHORTCUTS array:

There are no dedicated tests for the keyboard-shortcuts registry (it's a static data declaration). We verify this visually in the e2e test.

- [ ] **Step 2: Add the entry**

In `src/lib/keyboard-shortcuts.ts`, add after the `Alt+W` entry:

```typescript
{ keys: ['Alt', 'H'], description: 'Reopen closed tab', category: 'tabs' },
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/keyboard-shortcuts.ts
git commit -m "feat: add Alt+H to KEYBOARD_SHORTCUTS display array"
```

---

### Task 8: Registry Interaction — Closed entry removed from localClosed on reopen

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Test: `test/unit/client/store/tabsSlice.reopen-tab.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/unit/client/store/tabsSlice.reopen-tab.test.ts`:

```typescript
it('clears the corresponding localClosed entry when reopening a tab that had one', async () => {
  const store = createStore()

  // Create a tab with enough "significance" to be kept in localClosed
  store.dispatch(addTab({ title: 'Important' }))
  const tabId = store.getState().tabs.tabs[0].id
  // Set titleSetByUser so shouldKeepClosedTab returns true
  store.dispatch({ type: 'tabs/updateTab', payload: { id: tabId, updates: { titleSetByUser: true } } })
  store.dispatch(initLayout({
    tabId,
    content: { kind: 'terminal', mode: 'shell' },
  }))

  await store.dispatch(closeTab(tabId) as any)

  // Both localClosed and reopenStack should have entries
  expect(Object.keys(store.getState().tabRegistry.localClosed).length).toBeGreaterThan(0)
  expect(store.getState().tabRegistry.reopenStack.length).toBeGreaterThan(0)

  // Get the tabKey used in localClosed
  const closedTabKey = Object.keys(store.getState().tabRegistry.localClosed)[0]

  await store.dispatch(reopenClosedTab() as any)

  // After reopen, localClosed entry should be removed
  expect(store.getState().tabRegistry.localClosed[closedTabKey]).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- --run test/unit/client/store/tabsSlice.reopen-tab.test.ts`
Expected: FAIL — localClosed entry is still present after reopen

- [ ] **Step 3: Add clearClosedTabSnapshot dispatch to reopenClosedTab thunk**

In `src/store/tabsSlice.ts`, in the `reopenClosedTab` thunk, after `dispatch(popReopenEntry())`:

```typescript
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry, clearClosedTabSnapshot } from './tabRegistrySlice'
```

Add inside the thunk, after popping:
```typescript
// Remove from localClosed registry if present (prevents stale "recently closed" entry)
const deviceId = state.tabRegistry.deviceId
const closedTabKey = `${deviceId}:${entry.tab.id}`
dispatch(clearClosedTabSnapshot(closedTabKey))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- --run test/unit/client/store/tabsSlice.reopen-tab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts
git commit -m "feat: clear localClosed entry when reopening a closed tab"
```

---

### Task 9: Playwright E2E Browser Integration Test

**Files:**
- Create: `test/e2e-browser/specs/reopen-tab.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `test/e2e-browser/specs/reopen-tab.spec.ts`:

```typescript
import { test, expect } from '../helpers/fixtures.js'

test.describe('Reopen Closed Tab (Alt+H)', () => {
  test('reopens the most recently closed tab with Alt+H in LIFO order', async ({ freshellPage, page, harness }) => {
    // Start with one tab
    await harness.waitForTabCount(1)

    // Create a second tab via Alt+T
    await page.keyboard.press('Alt+t')
    await harness.waitForTabCount(2)

    // Create a third tab via Alt+T
    await page.keyboard.press('Alt+t')
    await harness.waitForTabCount(3)

    // Get tab titles for verification
    const state1 = await harness.getState()
    const tab2Title = state1.tabs.tabs[1].title
    const tab3Title = state1.tabs.tabs[2].title

    // Close tab 3 (active)
    await page.keyboard.press('Alt+w')
    await harness.waitForTabCount(2)

    // Close tab 2 (now active)
    await page.keyboard.press('Alt+w')
    await harness.waitForTabCount(1)

    // Reopen — should get tab 2 back (LIFO)
    await page.keyboard.press('Alt+h')
    await harness.waitForTabCount(2)

    const state2 = await harness.getState()
    expect(state2.tabs.tabs[1].title).toBe(tab2Title)
    expect(state2.tabs.activeTabId).toBe(state2.tabs.tabs[1].id)

    // Reopen again — should get tab 3 back
    await page.keyboard.press('Alt+h')
    await harness.waitForTabCount(3)

    const state3 = await harness.getState()
    expect(state3.tabs.tabs[2].title).toBe(tab3Title)
  })

  test('Alt+H with empty reopen stack does nothing', async ({ freshellPage, page, harness }) => {
    await harness.waitForTabCount(1)

    // Press Alt+H when nothing has been closed
    await page.keyboard.press('Alt+h')
    // Should still have 1 tab
    const state = await harness.getState()
    expect(state.tabs.tabs).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the E2E test**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts test/e2e-browser/specs/reopen-tab.spec.ts`
Expected: PASS (since all implementation is already in place from Tasks 1-8)

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/reopen-tab.spec.ts
git commit -m "test: add Playwright E2E test for Alt+H reopen closed tab"
```

---

### Task 10: Run Full Test Suite and Refactor

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test:vitest -- --run`
Expected: All existing tests pass, no regressions.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No lint violations.

- [ ] **Step 4: Review for refactoring opportunities**

Check:
- Are the new helpers (`normalizeRestoredTree`, `findFirstLeafId`) well-placed?
- Is the deep-copy in `closeTab` (via `JSON.parse(JSON.stringify(...))`) clean enough, or should we use `structuredClone`?
- Are the test assertions specific enough?
- Are there any remaining `any` types that should be narrowed?

- [ ] **Step 5: Apply refactoring and commit**

```bash
git add -A
git commit -m "refactor: clean up reopen-tab implementation after review"
```

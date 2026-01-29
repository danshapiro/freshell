# Split Panes with FAB Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a FAB (Floating Action Button) that allows splitting terminal tabs into multiple resizable panes containing terminals or browsers.

**Architecture:** A recursive tree data structure stores pane layouts in Redux. Each tab has a root PaneNode that is either a leaf (single pane) or a split (two children). The PaneLayout component recursively renders this tree with draggable dividers between splits.

**Tech Stack:** React, Redux Toolkit, Tailwind CSS, xterm.js (existing), iframe for browser panes.

---

## Task 1: Create Pane Types

Define the core type definitions for the pane system.

**Files:**
- Create: `src/store/paneTypes.ts`

**Step 1: Write the type definitions**

```typescript
// src/store/paneTypes.ts

/**
 * Content that can be displayed in a pane
 */
export type PaneContent =
  | { kind: 'terminal'; terminalId?: string; mode?: 'shell' | 'claude' | 'codex'; resumeSessionId?: string; initialCwd?: string }
  | { kind: 'browser'; url: string; devToolsOpen: boolean }

/**
 * Recursive tree structure for pane layouts.
 * A leaf is a single pane with content.
 * A split divides space between two children.
 */
export type PaneNode =
  | { type: 'leaf'; id: string; content: PaneContent }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [PaneNode, PaneNode]; sizes: [number, number] }

/**
 * Redux state for pane layouts
 */
export interface PanesState {
  /** Map of tabId -> root pane node */
  layouts: Record<string, PaneNode>
  /** Map of tabId -> currently focused pane id */
  activePane: Record<string, string>
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit src/store/paneTypes.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/store/paneTypes.ts
git commit -m "feat(panes): add pane type definitions"
```

---

## Task 2: Create panesSlice with Tests (TDD)

Build the Redux slice for managing pane state, test-first.

**Files:**
- Create: `test/unit/client/store/panesSlice.test.ts`
- Create: `src/store/panesSlice.ts`

**Step 1: Write failing tests for initLayout**

```typescript
// test/unit/client/store/panesSlice.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import panesReducer, {
  initLayout,
  PanesState,
} from '../../../../src/store/panesSlice'

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-pane-id'),
}))

describe('panesSlice', () => {
  let initialState: PanesState

  beforeEach(() => {
    initialState = {
      layouts: {},
      activePane: {},
    }
    vi.clearAllMocks()
  })

  describe('initLayout', () => {
    it('creates a single-pane layout for a tab', () => {
      const state = panesReducer(
        initialState,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'terminal', mode: 'shell' },
        })
      )

      expect(state.layouts['tab-1']).toBeDefined()
      expect(state.layouts['tab-1'].type).toBe('leaf')
      if (state.layouts['tab-1'].type === 'leaf') {
        expect(state.layouts['tab-1'].content.kind).toBe('terminal')
      }
      expect(state.activePane['tab-1']).toBe('test-pane-id')
    })

    it('does not overwrite existing layout', () => {
      const existingLayout: PanesState = {
        layouts: {
          'tab-1': { type: 'leaf', id: 'existing-pane', content: { kind: 'terminal' } },
        },
        activePane: { 'tab-1': 'existing-pane' },
      }

      const state = panesReducer(
        existingLayout,
        initLayout({
          tabId: 'tab-1',
          content: { kind: 'browser', url: '', devToolsOpen: false },
        })
      )

      // Should keep existing layout
      if (state.layouts['tab-1'].type === 'leaf') {
        expect(state.layouts['tab-1'].id).toBe('existing-pane')
      }
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL - module not found

**Step 3: Write minimal implementation for initLayout**

```typescript
// src/store/panesSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { nanoid } from 'nanoid'
import type { PanesState, PaneContent, PaneNode } from './paneTypes'

const initialState: PanesState = {
  layouts: {},
  activePane: {},
}

export const panesSlice = createSlice({
  name: 'panes',
  initialState,
  reducers: {
    initLayout: (
      state,
      action: PayloadAction<{ tabId: string; content: PaneContent }>
    ) => {
      const { tabId, content } = action.payload
      // Don't overwrite existing layout
      if (state.layouts[tabId]) return

      const paneId = nanoid()
      state.layouts[tabId] = {
        type: 'leaf',
        id: paneId,
        content,
      }
      state.activePane[tabId] = paneId
    },
  },
})

export const { initLayout } = panesSlice.actions
export default panesSlice.reducer
export type { PanesState }
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/store/panesSlice.test.ts src/store/panesSlice.ts
git commit -m "feat(panes): add panesSlice with initLayout action"
```

---

## Task 3: Add splitPane Action (TDD)

Add the core splitting functionality.

**Files:**
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `src/store/panesSlice.ts`

**Step 1: Write failing tests for splitPane**

Add to the test file:

```typescript
import panesReducer, {
  initLayout,
  splitPane,
  PanesState,
} from '../../../../src/store/panesSlice'

// ... existing tests ...

describe('splitPane', () => {
  it('converts a leaf pane into a split with two children', () => {
    // Setup: create initial layout
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal', mode: 'shell' },
      })
    )

    const originalPaneId = state.activePane['tab-1']

    // Split the pane
    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: originalPaneId,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    const root = state.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      expect(root.direction).toBe('horizontal')
      expect(root.sizes).toEqual([50, 50])
      expect(root.children).toHaveLength(2)
      expect(root.children[0].type).toBe('leaf')
      expect(root.children[1].type).toBe('leaf')
      // Original content in first child
      if (root.children[0].type === 'leaf') {
        expect(root.children[0].content.kind).toBe('terminal')
      }
      // New content in second child
      if (root.children[1].type === 'leaf') {
        expect(root.children[1].content.kind).toBe('browser')
      }
    }
  })

  it('sets the new pane as active', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal' },
      })
    )

    const originalPaneId = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: originalPaneId,
        direction: 'vertical',
        newContent: { kind: 'terminal', mode: 'claude' },
      })
    )

    // Active pane should be the new pane (second child)
    const root = state.layouts['tab-1']
    if (root.type === 'split' && root.children[1].type === 'leaf') {
      expect(state.activePane['tab-1']).toBe(root.children[1].id)
    }
  })

  it('handles nested splits', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal' },
      })
    )

    const pane1Id = state.activePane['tab-1']

    // First split
    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane1Id,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    const pane2Id = state.activePane['tab-1']

    // Second split on the new pane
    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane2Id,
        direction: 'vertical',
        newContent: { kind: 'terminal', mode: 'shell' },
      })
    )

    // Should have nested structure
    const root = state.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      expect(root.children[0].type).toBe('leaf') // original terminal
      expect(root.children[1].type).toBe('split') // nested split
      if (root.children[1].type === 'split') {
        expect(root.children[1].direction).toBe('vertical')
      }
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL - splitPane is not exported

**Step 3: Implement splitPane**

Add to panesSlice.ts:

```typescript
// Helper to find and replace a pane in the tree
function findAndReplace(
  node: PaneNode,
  targetId: string,
  replacement: PaneNode
): PaneNode | null {
  if (node.type === 'leaf') {
    if (node.id === targetId) return replacement
    return null
  }

  // It's a split - check children
  const leftResult = findAndReplace(node.children[0], targetId, replacement)
  if (leftResult) {
    return {
      ...node,
      children: [leftResult, node.children[1]],
    }
  }

  const rightResult = findAndReplace(node.children[1], targetId, replacement)
  if (rightResult) {
    return {
      ...node,
      children: [node.children[0], rightResult],
    }
  }

  return null
}

// In the slice reducers:
splitPane: (
  state,
  action: PayloadAction<{
    tabId: string
    paneId: string
    direction: 'horizontal' | 'vertical'
    newContent: PaneContent
  }>
) => {
  const { tabId, paneId, direction, newContent } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  const newPaneId = nanoid()

  // Find the target pane and get its content
  function findPane(node: PaneNode, id: string): PaneNode | null {
    if (node.type === 'leaf') return node.id === id ? node : null
    return findPane(node.children[0], id) || findPane(node.children[1], id)
  }

  const targetPane = findPane(root, paneId)
  if (!targetPane || targetPane.type !== 'leaf') return

  // Create the split node
  const splitNode: PaneNode = {
    type: 'split',
    id: nanoid(),
    direction,
    sizes: [50, 50],
    children: [
      { ...targetPane }, // Keep original pane
      { type: 'leaf', id: newPaneId, content: newContent }, // New pane
    ],
  }

  // Replace the target pane with the split
  const newRoot = findAndReplace(root, paneId, splitNode)
  if (newRoot) {
    state.layouts[tabId] = newRoot
    state.activePane[tabId] = newPaneId
  }
},
```

Don't forget to export: `export const { initLayout, splitPane } = panesSlice.actions`

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/store/panesSlice.test.ts src/store/panesSlice.ts
git commit -m "feat(panes): add splitPane action with tree manipulation"
```

---

## Task 4: Add closePane Action (TDD)

Add pane closing with collapse behavior.

**Files:**
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `src/store/panesSlice.ts`

**Step 1: Write failing tests for closePane**

```typescript
describe('closePane', () => {
  it('does nothing when closing the only pane', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal' },
      })
    )

    const paneId = state.activePane['tab-1']

    state = panesReducer(
      state,
      closePane({ tabId: 'tab-1', paneId })
    )

    // Should still have the layout
    expect(state.layouts['tab-1']).toBeDefined()
    expect(state.layouts['tab-1'].type).toBe('leaf')
  })

  it('collapses split to remaining pane when one child is closed', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal' },
      })
    )

    const pane1Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane1Id,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    const pane2Id = state.activePane['tab-1'] // The browser pane

    // Close the browser pane
    state = panesReducer(
      state,
      closePane({ tabId: 'tab-1', paneId: pane2Id })
    )

    // Should collapse back to single leaf
    expect(state.layouts['tab-1'].type).toBe('leaf')
    if (state.layouts['tab-1'].type === 'leaf') {
      expect(state.layouts['tab-1'].content.kind).toBe('terminal')
    }
  })

  it('sets active pane to sibling when active pane is closed', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'terminal' },
      })
    )

    const pane1Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane1Id,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    const pane2Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      closePane({ tabId: 'tab-1', paneId: pane2Id })
    )

    // Active should switch to the remaining pane
    expect(state.activePane['tab-1']).toBe(pane1Id)
  })

  it('handles closing pane in nested split', () => {
    // Create: terminal | (browser / terminal)
    let state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: { kind: 'terminal' } })
    )
    const pane1Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane1Id,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )
    const pane2Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane2Id,
        direction: 'vertical',
        newContent: { kind: 'terminal', mode: 'claude' },
      })
    )
    const pane3Id = state.activePane['tab-1']

    // Close pane3 (the claude terminal in nested split)
    state = panesReducer(
      state,
      closePane({ tabId: 'tab-1', paneId: pane3Id })
    )

    // Should collapse nested split, but keep top-level split
    const root = state.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      expect(root.children[0].type).toBe('leaf') // terminal
      expect(root.children[1].type).toBe('leaf') // browser (collapsed from nested)
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL - closePane is not exported

**Step 3: Implement closePane**

```typescript
closePane: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string }>
) => {
  const { tabId, paneId } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  // Can't close the only pane
  if (root.type === 'leaf') return

  // Find the parent split containing this pane and its sibling
  function findParentAndSibling(
    node: PaneNode,
    targetId: string,
    parent: PaneNode | null = null
  ): { parent: PaneNode; sibling: PaneNode; siblingIndex: 0 | 1 } | null {
    if (node.type === 'leaf') return null

    // Check if either child is the target
    if (node.children[0].type === 'leaf' && node.children[0].id === targetId) {
      return { parent: node, sibling: node.children[1], siblingIndex: 1 }
    }
    if (node.children[1].type === 'leaf' && node.children[1].id === targetId) {
      return { parent: node, sibling: node.children[0], siblingIndex: 0 }
    }

    // Recurse into children
    return (
      findParentAndSibling(node.children[0], targetId, node) ||
      findParentAndSibling(node.children[1], targetId, node)
    )
  }

  const result = findParentAndSibling(root, paneId)
  if (!result) return

  const { parent, sibling } = result

  // Replace the parent split with the sibling
  if (parent === root) {
    // Parent is root - sibling becomes new root
    state.layouts[tabId] = sibling
  } else {
    // Replace parent with sibling in the tree
    const newRoot = findAndReplace(root, parent.id, sibling)
    if (newRoot) {
      state.layouts[tabId] = newRoot
    }
  }

  // Update active pane if needed
  if (state.activePane[tabId] === paneId) {
    // Find first leaf in sibling
    function findFirstLeaf(node: PaneNode): string {
      if (node.type === 'leaf') return node.id
      return findFirstLeaf(node.children[0])
    }
    state.activePane[tabId] = findFirstLeaf(sibling)
  }
},
```

Export it: `export const { initLayout, splitPane, closePane } = panesSlice.actions`

**Step 4: Run test to verify it passes**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/store/panesSlice.test.ts src/store/panesSlice.ts
git commit -m "feat(panes): add closePane action with collapse behavior"
```

---

## Task 5: Add Remaining Slice Actions

Add setActivePane, resizePanes, updatePaneContent, removeLayout.

**Files:**
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `src/store/panesSlice.ts`

**Step 1: Write tests for remaining actions**

```typescript
describe('setActivePane', () => {
  it('updates the active pane for a tab', () => {
    let state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: { kind: 'terminal' } })
    )
    const pane1Id = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId: pane1Id,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    // Switch back to first pane
    state = panesReducer(
      state,
      setActivePane({ tabId: 'tab-1', paneId: pane1Id })
    )

    expect(state.activePane['tab-1']).toBe(pane1Id)
  })
})

describe('resizePanes', () => {
  it('updates split sizes', () => {
    let state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: { kind: 'terminal' } })
    )
    const paneId = state.activePane['tab-1']

    state = panesReducer(
      state,
      splitPane({
        tabId: 'tab-1',
        paneId,
        direction: 'horizontal',
        newContent: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )

    const root = state.layouts['tab-1']
    if (root.type !== 'split') throw new Error('Expected split')

    state = panesReducer(
      state,
      resizePanes({ tabId: 'tab-1', splitId: root.id, sizes: [70, 30] })
    )

    const newRoot = state.layouts['tab-1']
    if (newRoot.type === 'split') {
      expect(newRoot.sizes).toEqual([70, 30])
    }
  })
})

describe('updatePaneContent', () => {
  it('updates content of a pane', () => {
    let state = panesReducer(
      initialState,
      initLayout({
        tabId: 'tab-1',
        content: { kind: 'browser', url: '', devToolsOpen: false },
      })
    )
    const paneId = state.activePane['tab-1']

    state = panesReducer(
      state,
      updatePaneContent({
        tabId: 'tab-1',
        paneId,
        content: { kind: 'browser', url: 'https://example.com', devToolsOpen: true },
      })
    )

    const root = state.layouts['tab-1']
    if (root.type === 'leaf' && root.content.kind === 'browser') {
      expect(root.content.url).toBe('https://example.com')
      expect(root.content.devToolsOpen).toBe(true)
    }
  })
})

describe('removeLayout', () => {
  it('removes layout for a tab', () => {
    let state = panesReducer(
      initialState,
      initLayout({ tabId: 'tab-1', content: { kind: 'terminal' } })
    )

    state = panesReducer(state, removeLayout({ tabId: 'tab-1' }))

    expect(state.layouts['tab-1']).toBeUndefined()
    expect(state.activePane['tab-1']).toBeUndefined()
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: FAIL

**Step 3: Implement remaining actions**

```typescript
setActivePane: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string }>
) => {
  const { tabId, paneId } = action.payload
  state.activePane[tabId] = paneId
},

resizePanes: (
  state,
  action: PayloadAction<{ tabId: string; splitId: string; sizes: [number, number] }>
) => {
  const { tabId, splitId, sizes } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  function updateSizes(node: PaneNode): PaneNode {
    if (node.type === 'leaf') return node
    if (node.id === splitId) {
      return { ...node, sizes }
    }
    return {
      ...node,
      children: [updateSizes(node.children[0]), updateSizes(node.children[1])],
    }
  }

  state.layouts[tabId] = updateSizes(root)
},

updatePaneContent: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string; content: PaneContent }>
) => {
  const { tabId, paneId, content } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  function updateContent(node: PaneNode): PaneNode {
    if (node.type === 'leaf') {
      if (node.id === paneId) {
        return { ...node, content }
      }
      return node
    }
    return {
      ...node,
      children: [updateContent(node.children[0]), updateContent(node.children[1])],
    }
  }

  state.layouts[tabId] = updateContent(root)
},

removeLayout: (
  state,
  action: PayloadAction<{ tabId: string }>
) => {
  const { tabId } = action.payload
  delete state.layouts[tabId]
  delete state.activePane[tabId]
},
```

Export all: `export const { initLayout, splitPane, closePane, setActivePane, resizePanes, updatePaneContent, removeLayout } = panesSlice.actions`

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run test/unit/client/store/panesSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/store/panesSlice.test.ts src/store/panesSlice.ts
git commit -m "feat(panes): add setActivePane, resizePanes, updatePaneContent, removeLayout"
```

---

## Task 6: Integrate panesSlice into Store

Wire up the slice and persistence.

**Files:**
- Modify: `src/store/store.ts`
- Modify: `src/store/persistMiddleware.ts`

**Step 1: Add panesReducer to store**

```typescript
// src/store/store.ts
import panesReducer, { hydratePanes } from './panesSlice'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    panes: panesReducer,  // Add this
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
    claude: claudeReducer,
  },
  // ... rest unchanged
})

// Add panes hydration after tabs hydration
const persistedPanes = loadPersistedPanes()
if (persistedPanes?.panes) {
  store.dispatch(hydratePanes(persistedPanes.panes))
}
```

**Step 2: Add hydratePanes action to slice**

In `panesSlice.ts`:

```typescript
hydratePanes: (state, action: PayloadAction<PanesState>) => {
  state.layouts = action.payload.layouts || {}
  state.activePane = action.payload.activePane || {}
},
```

Export it.

**Step 3: Update persist middleware**

```typescript
// src/store/persistMiddleware.ts
const PANES_STORAGE_KEY = 'freshell.panes.v1'

export function loadPersistedPanes(): any | null {
  try {
    const raw = localStorage.getItem(PANES_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export const persistMiddleware: Middleware<{}, RootState> = (store) => (next) => (action) => {
  const result = next(action)
  const state = store.getState()

  // Persist tabs
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: state.tabs }))
  } catch { /* ignore */ }

  // Persist panes
  try {
    localStorage.setItem(PANES_STORAGE_KEY, JSON.stringify({ panes: state.panes }))
  } catch { /* ignore */ }

  return result
}
```

**Step 4: Verify app still loads**

Run: `npm run dev`
Expected: App loads without errors

**Step 5: Commit**

```bash
git add src/store/store.ts src/store/persistMiddleware.ts src/store/panesSlice.ts
git commit -m "feat(panes): integrate panesSlice into store with persistence"
```

---

## Task 7: Create Pane Component

Build the individual pane wrapper with close button and focus glow.

**Files:**
- Create: `src/components/panes/Pane.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/Pane.tsx
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PaneContent } from '@/store/paneTypes'

interface PaneProps {
  id: string
  content: PaneContent
  isActive: boolean
  isOnlyPane: boolean
  onClose: () => void
  onFocus: () => void
  children: React.ReactNode
}

export default function Pane({
  id,
  content,
  isActive,
  isOnlyPane,
  onClose,
  onFocus,
  children,
}: PaneProps) {
  return (
    <div
      className={cn(
        'relative h-full w-full overflow-hidden',
        isActive && 'shadow-[0_0_0_2px_rgba(255,255,255,0.3),0_0_20px_rgba(255,255,255,0.1)]'
      )}
      onClick={onFocus}
    >
      {/* Close button - hidden if only pane */}
      {!isOnlyPane && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="absolute top-1 right-1 z-10 p-1 rounded opacity-50 hover:opacity-100 text-muted-foreground hover:bg-muted/50 transition-opacity"
          title="Close pane"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Content */}
      <div className="h-full w-full">
        {children}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/panes/Pane.tsx
git commit -m "feat(panes): add Pane component with close button and focus glow"
```

---

## Task 8: Create PaneDivider Component

Build the draggable resize divider.

**Files:**
- Create: `src/components/panes/PaneDivider.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/PaneDivider.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface PaneDividerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onResizeEnd: () => void
}

export default function PaneDivider({ direction, onResize, onResizeEnd }: PaneDividerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
  }, [direction])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos
      onResize(delta)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onResizeEnd()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, direction, onResize, onResizeEnd])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        'flex-shrink-0 bg-border hover:bg-muted-foreground transition-colors',
        direction === 'horizontal'
          ? 'w-1 cursor-col-resize'
          : 'h-1 cursor-row-resize',
        isDragging && 'bg-muted-foreground'
      )}
    />
  )
}
```

**Step 2: Commit**

```bash
git add src/components/panes/PaneDivider.tsx
git commit -m "feat(panes): add PaneDivider component for resize"
```

---

## Task 9: Create PaneContainer Component

Build the recursive renderer for the pane tree.

**Files:**
- Create: `src/components/panes/PaneContainer.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/PaneContainer.tsx
import { useRef, useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { closePane, setActivePane, resizePanes } from '@/store/panesSlice'
import type { PaneNode, PaneContent } from '@/store/paneTypes'
import Pane from './Pane'
import PaneDivider from './PaneDivider'
import TerminalView from '../TerminalView'
import BrowserPane from './BrowserPane'
import { cn } from '@/lib/utils'

interface PaneContainerProps {
  tabId: string
  node: PaneNode
  isRoot?: boolean
}

export default function PaneContainer({ tabId, node, isRoot = false }: PaneContainerProps) {
  const dispatch = useAppDispatch()
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const containerRef = useRef<HTMLDivElement>(null)

  // Check if this is the only pane (root is a leaf)
  const rootNode = useAppSelector((s) => s.panes.layouts[tabId])
  const isOnlyPane = rootNode?.type === 'leaf'

  const handleClose = useCallback((paneId: string) => {
    dispatch(closePane({ tabId, paneId }))
  }, [dispatch, tabId])

  const handleFocus = useCallback((paneId: string) => {
    dispatch(setActivePane({ tabId, paneId }))
  }, [dispatch, tabId])

  const handleResize = useCallback((splitId: string, delta: number, direction: 'horizontal' | 'vertical') => {
    if (!containerRef.current) return

    const container = containerRef.current
    const totalSize = direction === 'horizontal' ? container.offsetWidth : container.offsetHeight
    const percentDelta = (delta / totalSize) * 100

    // Get current sizes from the node
    if (node.type !== 'split' || node.id !== splitId) return

    const [size1, size2] = node.sizes
    const newSize1 = Math.max(10, Math.min(90, size1 + percentDelta))
    const newSize2 = 100 - newSize1

    dispatch(resizePanes({ tabId, splitId, sizes: [newSize1, newSize2] }))
  }, [dispatch, tabId, node])

  const handleResizeEnd = useCallback(() => {
    // Could trigger terminal resize here if needed
  }, [])

  // Render a leaf pane
  if (node.type === 'leaf') {
    return (
      <Pane
        id={node.id}
        content={node.content}
        isActive={activePane === node.id}
        isOnlyPane={isOnlyPane}
        onClose={() => handleClose(node.id)}
        onFocus={() => handleFocus(node.id)}
      >
        {renderContent(tabId, node.id, node.content)}
      </Pane>
    )
  }

  // Render a split
  const [size1, size2] = node.sizes

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex h-full w-full',
        node.direction === 'horizontal' ? 'flex-row' : 'flex-col'
      )}
    >
      <div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size1}%` }} className="min-w-0 min-h-0">
        <PaneContainer tabId={tabId} node={node.children[0]} />
      </div>

      <PaneDivider
        direction={node.direction}
        onResize={(delta) => handleResize(node.id, delta, node.direction)}
        onResizeEnd={handleResizeEnd}
      />

      <div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size2}%` }} className="min-w-0 min-h-0">
        <PaneContainer tabId={tabId} node={node.children[1]} />
      </div>
    </div>
  )
}

function renderContent(tabId: string, paneId: string, content: PaneContent) {
  if (content.kind === 'terminal') {
    // Terminal panes need a unique key based on paneId for proper lifecycle
    return <TerminalView key={paneId} tabId={tabId} paneId={paneId} hidden={false} />
  }

  if (content.kind === 'browser') {
    return <BrowserPane paneId={paneId} tabId={tabId} url={content.url} devToolsOpen={content.devToolsOpen} />
  }

  return null
}
```

**Step 2: Commit**

```bash
git add src/components/panes/PaneContainer.tsx
git commit -m "feat(panes): add PaneContainer recursive renderer"
```

---

## Task 10: Create BrowserPane Component

Build the embedded browser with toolbar.

**Files:**
- Create: `src/components/panes/BrowserPane.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/BrowserPane.tsx
import { useState, useRef, useCallback } from 'react'
import { ArrowLeft, ArrowRight, RotateCcw, X, Wrench } from 'lucide-react'
import { useAppDispatch } from '@/store/hooks'
import { updatePaneContent } from '@/store/panesSlice'
import { cn } from '@/lib/utils'

interface BrowserPaneProps {
  paneId: string
  tabId: string
  url: string
  devToolsOpen: boolean
}

export default function BrowserPane({ paneId, tabId, url, devToolsOpen }: BrowserPaneProps) {
  const dispatch = useAppDispatch()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [inputUrl, setInputUrl] = useState(url)
  const [isLoading, setIsLoading] = useState(false)
  const [history, setHistory] = useState<string[]>(url ? [url] : [])
  const [historyIndex, setHistoryIndex] = useState(url ? 0 : -1)

  const navigate = useCallback((newUrl: string) => {
    if (!newUrl.trim()) return

    // Add protocol if missing
    let fullUrl = newUrl
    if (!fullUrl.match(/^https?:\/\//)) {
      fullUrl = 'https://' + fullUrl
    }

    setInputUrl(fullUrl)
    setIsLoading(true)

    // Update history
    const newHistory = [...history.slice(0, historyIndex + 1), fullUrl]
    setHistory(newHistory)
    setHistoryIndex(newHistory.length - 1)

    // Persist to Redux
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { kind: 'browser', url: fullUrl, devToolsOpen },
    }))
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setInputUrl(history[newIndex])
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      setInputUrl(history[newIndex])
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: { kind: 'browser', url: history[newIndex], devToolsOpen },
      }))
    }
  }, [dispatch, tabId, paneId, devToolsOpen, history, historyIndex])

  const refresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
      setIsLoading(true)
    }
  }, [])

  const stop = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = 'about:blank'
      setIsLoading(false)
    }
  }, [])

  const toggleDevTools = useCallback(() => {
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: { kind: 'browser', url, devToolsOpen: !devToolsOpen },
    }))
  }, [dispatch, tabId, paneId, url, devToolsOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      navigate(inputUrl)
    }
  }

  const currentUrl = history[historyIndex] || ''

  return (
    <div className="flex flex-col h-full w-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-card">
        <button
          onClick={goBack}
          disabled={historyIndex <= 0}
          className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <button
          onClick={goForward}
          disabled={historyIndex >= history.length - 1}
          className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          title="Forward"
        >
          <ArrowRight className="h-4 w-4" />
        </button>

        <button
          onClick={isLoading ? stop : refresh}
          className="p-1.5 rounded hover:bg-muted"
          title={isLoading ? 'Stop' : 'Refresh'}
        >
          {isLoading ? <X className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
        </button>

        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          className="flex-1 h-8 px-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
          autoFocus={!url}
        />

        <button
          onClick={toggleDevTools}
          className={cn(
            'p-1.5 rounded hover:bg-muted',
            devToolsOpen && 'bg-muted'
          )}
          title="Developer Tools"
        >
          <Wrench className="h-4 w-4" />
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 flex min-h-0">
        {/* iframe */}
        <div className={cn('flex-1 min-w-0', devToolsOpen && 'border-r border-border')}>
          {currentUrl ? (
            <iframe
              ref={iframeRef}
              src={currentUrl}
              className="w-full h-full border-0 bg-white"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              onLoad={() => setIsLoading(false)}
              title="Browser content"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Enter a URL to browse
            </div>
          )}
        </div>

        {/* Dev tools panel */}
        {devToolsOpen && (
          <div className="w-[40%] min-w-[200px] bg-card flex flex-col">
            <div className="px-3 py-2 border-b border-border text-sm font-medium">
              Developer Tools
            </div>
            <div className="flex-1 p-3 text-sm text-muted-foreground overflow-auto">
              <p className="mb-2">Limited dev tools for embedded browsers.</p>
              <p className="text-xs">
                Due to browser security restrictions, full dev tools access requires the page to be same-origin or opened in a separate window.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/panes/BrowserPane.tsx
git commit -m "feat(panes): add BrowserPane component with toolbar and dev tools panel"
```

---

## Task 11: Create FloatingActionButton Component

Build the FAB with dropdown menu.

**Files:**
- Create: `src/components/panes/FloatingActionButton.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/FloatingActionButton.tsx
import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, Terminal, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FloatingActionButtonProps {
  onAddTerminal: () => void
  onAddBrowser: () => void
}

export default function FloatingActionButton({ onAddTerminal, onAddBrowser }: FloatingActionButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleAddTerminal = useCallback(() => {
    onAddTerminal()
    setIsOpen(false)
  }, [onAddTerminal])

  const handleAddBrowser = useCallback(() => {
    onAddBrowser()
    setIsOpen(false)
  }, [onAddBrowser])

  return (
    <div className="absolute bottom-4 right-4 z-50">
      {/* Dropdown menu */}
      {isOpen && (
        <div
          ref={menuRef}
          className="absolute bottom-14 right-0 mb-2 w-40 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
        >
          <button
            onClick={handleAddTerminal}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors"
          >
            <Terminal className="h-4 w-4" />
            Terminal
          </button>
          <button
            onClick={handleAddBrowser}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-muted transition-colors"
          >
            <Globe className="h-4 w-4" />
            Browser
          </button>
        </div>
      )}

      {/* FAB button */}
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'h-12 w-12 rounded-full bg-foreground text-background',
          'flex items-center justify-center',
          'shadow-lg hover:shadow-xl transition-all',
          'hover:scale-105 active:scale-95',
          isOpen && 'rotate-45'
        )}
        title="Add pane"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/panes/FloatingActionButton.tsx
git commit -m "feat(panes): add FloatingActionButton with dropdown menu"
```

---

## Task 12: Create PaneLayout Component

Build the root layout component that ties everything together.

**Files:**
- Create: `src/components/panes/PaneLayout.tsx`

**Step 1: Create the component**

```typescript
// src/components/panes/PaneLayout.tsx
import { useCallback, useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { initLayout, splitPane } from '@/store/panesSlice'
import type { PaneContent } from '@/store/paneTypes'
import PaneContainer from './PaneContainer'
import FloatingActionButton from './FloatingActionButton'

interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContent
}

export default function PaneLayout({ tabId, defaultContent }: PaneLayoutProps) {
  const dispatch = useAppDispatch()
  const layout = useAppSelector((s) => s.panes.layouts[tabId])
  const activePane = useAppSelector((s) => s.panes.activePane[tabId])
  const containerRef = useRef<HTMLDivElement>(null)

  // Initialize layout if not exists
  useEffect(() => {
    if (!layout) {
      dispatch(initLayout({ tabId, content: defaultContent }))
    }
  }, [dispatch, tabId, layout, defaultContent])

  // Determine split direction based on container dimensions
  const getSplitDirection = useCallback((): 'horizontal' | 'vertical' => {
    if (!containerRef.current) return 'horizontal'
    const { width, height } = containerRef.current.getBoundingClientRect()
    return width >= height ? 'horizontal' : 'vertical'
  }, [])

  const handleAddTerminal = useCallback(() => {
    if (!activePane) return
    dispatch(splitPane({
      tabId,
      paneId: activePane,
      direction: getSplitDirection(),
      newContent: { kind: 'terminal', mode: 'shell' },
    }))
  }, [dispatch, tabId, activePane, getSplitDirection])

  const handleAddBrowser = useCallback(() => {
    if (!activePane) return
    dispatch(splitPane({
      tabId,
      paneId: activePane,
      direction: getSplitDirection(),
      newContent: { kind: 'browser', url: '', devToolsOpen: false },
    }))
  }, [dispatch, tabId, activePane, getSplitDirection])

  if (!layout) {
    return <div className="h-full w-full" /> // Loading state
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={layout} isRoot />
      <FloatingActionButton
        onAddTerminal={handleAddTerminal}
        onAddBrowser={handleAddBrowser}
      />
    </div>
  )
}
```

**Step 2: Create index file for exports**

```typescript
// src/components/panes/index.ts
export { default as PaneLayout } from './PaneLayout'
export { default as Pane } from './Pane'
export { default as PaneContainer } from './PaneContainer'
export { default as PaneDivider } from './PaneDivider'
export { default as BrowserPane } from './BrowserPane'
export { default as FloatingActionButton } from './FloatingActionButton'
```

**Step 3: Commit**

```bash
git add src/components/panes/PaneLayout.tsx src/components/panes/index.ts
git commit -m "feat(panes): add PaneLayout root component"
```

---

## Task 13: Update TerminalView to Support Pane Mode

Modify TerminalView to work within panes (accepting paneId instead of just tabId).

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/panesSlice.ts`

**Step 1: Update TerminalView props**

The key changes:
1. Accept optional `paneId` prop
2. Use pane content for terminal config when paneId provided
3. Store terminalId in pane content instead of tab

```typescript
// In TerminalView.tsx, update the interface:
interface TerminalViewProps {
  tabId: string
  paneId?: string  // Optional - if provided, uses pane content
  hidden?: boolean
}

export default function TerminalView({ tabId, paneId, hidden }: TerminalViewProps) {
  const dispatch = useAppDispatch()
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))
  const paneContent = useAppSelector((s) => {
    if (!paneId) return null
    const layout = s.panes.layouts[tabId]
    if (!layout) return null
    // Find the pane in the tree
    function findPane(node: any): any {
      if (node.type === 'leaf' && node.id === paneId) return node.content
      if (node.type === 'split') {
        return findPane(node.children[0]) || findPane(node.children[1])
      }
      return null
    }
    return findPane(layout)
  })
  const settings = useAppSelector((s) => s.settings.settings)

  // Use pane content if available, otherwise fall back to tab
  const terminalConfig = paneId && paneContent?.kind === 'terminal'
    ? paneContent
    : { mode: tab?.mode, resumeSessionId: tab?.resumeSessionId, initialCwd: tab?.initialCwd }

  // ... rest of component uses terminalConfig instead of directly reading from tab
```

This is a larger refactor. The key insight is that when `paneId` is provided, the terminal config comes from the pane content in Redux, and we need to update the pane content (not the tab) when terminalId is assigned.

**Step 2: Add action to update pane terminal ID**

In `panesSlice.ts`, the `updatePaneContent` action already handles this.

**Step 3: Test manually**

Run: `npm run dev`
Expected: Existing terminal functionality still works

**Step 4: Commit**

```bash
git add src/components/TerminalView.tsx
git commit -m "feat(panes): update TerminalView to support pane mode"
```

---

## Task 14: Update TabContent to Use PaneLayout

Replace direct TerminalView rendering with PaneLayout.

**Files:**
- Modify: `src/components/TabContent.tsx`

**Step 1: Update TabContent**

```typescript
// src/components/TabContent.tsx
import { PaneLayout } from './panes'
import ClaudeSessionView from './ClaudeSessionView'
import { useAppSelector } from '@/store/hooks'
import type { PaneContent } from '@/store/paneTypes'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))

  if (!tab) return null

  // For claude mode with existing claudeSessionId, use ClaudeSessionView directly
  // (This is for viewing historical sessions, not live terminals)
  if (tab.mode === 'claude' && tab.claudeSessionId && !tab.terminalId) {
    return <ClaudeSessionView sessionId={tab.claudeSessionId} hidden={hidden} />
  }

  // Build default content based on tab mode
  const defaultContent: PaneContent = {
    kind: 'terminal',
    mode: tab.mode,
    resumeSessionId: tab.resumeSessionId,
    initialCwd: tab.initialCwd,
  }

  // Use PaneLayout for all terminal-based tabs
  return (
    <div className={hidden ? 'hidden' : 'h-full w-full'}>
      <PaneLayout tabId={tabId} defaultContent={defaultContent} />
    </div>
  )
}
```

**Step 2: Test the integration**

Run: `npm run dev`
Expected: App loads, FAB visible in bottom-right, clicking FAB shows menu

**Step 3: Commit**

```bash
git add src/components/TabContent.tsx
git commit -m "feat(panes): integrate PaneLayout into TabContent"
```

---

## Task 15: Update Sidebar Session Click Behavior

When clicking a Claude session in sidebar, open in new tab if not already open.

**Files:**
- Modify: `src/components/Sidebar.tsx`

**Step 1: Update handleItemClick**

The current implementation already handles most cases. Update to ensure it opens in a new tab when session isn't open:

```typescript
const handleItemClick = (item: SessionItem) => {
  if (item.isRunning && item.runningTerminalId) {
    // Session is running - find tab with this terminal
    const existingTab = tabs.find((t) => t.terminalId === item.runningTerminalId)
    if (existingTab) {
      dispatch(setActiveTab(existingTab.id))
    } else {
      // Terminal running but no tab - create one to attach
      dispatch(addTab({
        title: item.title,
        terminalId: item.runningTerminalId,
        status: 'running',
        mode: 'claude'
      }))
    }
  } else {
    // Session not running - always open in new tab
    dispatch(addTab({
      title: item.title,
      mode: 'claude',
      initialCwd: item.cwd,
      resumeSessionId: item.sessionId
    }))
  }
  onNavigate('terminal')
}
```

This matches the requirement: "If it's not open, open it in a new tab".

**Step 2: Test**

Run: `npm run dev`
Expected: Clicking session in sidebar opens new tab if not already open

**Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat(panes): update sidebar to open sessions in new tab"
```

---

## Task 16: Clean Up Tab Removal

When a tab is closed, clean up its pane layout.

**Files:**
- Modify: `src/store/tabsSlice.ts`

**Step 1: Add listener or coordinate cleanup**

The cleanest approach is to handle this in a middleware or by dispatching `removeLayout` when `removeTab` is dispatched. Since we're using Redux Toolkit, we can add a listener:

```typescript
// In store.ts, add after store creation:
import { removeTab } from './tabsSlice'
import { removeLayout } from './panesSlice'

// Clean up pane layout when tab is removed
store.subscribe(() => {
  // This is a simple approach - could also use RTK listener middleware
})

// Better approach: create a thunk
// src/store/tabsSlice.ts
import { createAsyncThunk } from '@reduxjs/toolkit'
import { removeLayout } from './panesSlice'

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch }) => {
    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))
  }
)
```

Then use `closeTab` instead of `removeTab` in components.

**Step 2: Update TabBar to use closeTab**

```typescript
// In TabBar.tsx, change:
dispatch(removeTab(id))
// To:
dispatch(closeTab(id))
```

**Step 3: Test**

Run: `npm run dev`
Expected: Closing a tab cleans up its pane layout from localStorage

**Step 4: Commit**

```bash
git add src/store/tabsSlice.ts src/store/store.ts src/components/TabBar.tsx
git commit -m "feat(panes): clean up pane layout when tab is closed"
```

---

## Task 17: Final Integration Test

Test the complete flow manually.

**Steps:**
1. Start dev server: `npm run dev`
2. Open app in browser
3. Verify FAB is visible in bottom-right
4. Click FAB → select "Terminal" → verify split appears
5. Click FAB → select "Browser" → verify three panes
6. Enter URL in browser pane → verify navigation works
7. Drag dividers → verify resize works
8. Click X on a pane → verify it closes and remaining panes expand
9. Refresh page → verify layout persists
10. Click Claude session in sidebar → verify opens in new tab

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 2: Commit any final fixes**

```bash
git add -A
git commit -m "feat(panes): complete split panes with FAB implementation"
```

---

## Summary

This plan implements:
- Recursive pane tree data structure in Redux
- FAB with dropdown for adding Terminal/Browser panes
- Auto-detection of split direction based on container aspect ratio
- Draggable dividers for resizing
- Close button on each pane (except when single pane)
- Monochrome glow for active pane focus
- Browser pane with URL bar, navigation, and dev tools panel
- Persistence of pane layouts to localStorage
- Sidebar opens Claude sessions in new tabs

Total: 17 tasks covering types, Redux slice (TDD), 6 components, integration, and testing.

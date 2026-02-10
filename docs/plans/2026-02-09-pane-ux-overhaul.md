# Pane UX Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform pane management from a clunky, grid-rebuilding system into an intuitive, consumer-grade layout experience where panes open predictably, close gracefully, resize with smart snapping, and can be zoomed for focus.

**Architecture:** Replace the grid-rebuild behavior in `addPane`/`closePane` with tree-preserving operations (split active pane on add, promote sibling on close). Add a smart divider snapping system that lets bars move independently by default, with intersection dragging (2D) and live magnetization to original positions and collinear seams. Add pane zoom (maximize/restore). All thresholds in % of smallest container dimension.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS, Vitest, Testing Library

---

## Design Spec (from conversation)

### Mental Model
Panes are mini-windows inside a tab. Users open, arrange, resize, focus, and close them. No "splitting" terminology in the UI.

### Opening a Pane
The (+) FAB opens a new pane **next to the active pane** (split right) instead of rebuilding the entire layout into a grid. The existing pane tree structure is preserved.

### Closing a Pane
When a pane is closed, its **sibling promotes** to fill the space. The tree is NOT rebuilt into a grid. The remaining layout stays exactly as the user arranged it.

### Resizing (Divider Snapping)

**Independent bars:** Every divider bar moves independently by default (1D drag).

**Intersection dragging:** When hovering over where bars cross or meet (T-junction or cross), the cursor changes and dragging moves all connected bars in 2D.

**Snap rules (all thresholds = `snapThreshold`% of smallest container dimension):**

| Drag type | Axis | Snaps to |
|-----------|------|----------|
| 1D bar | perpendicular | Original position |
| 1D bar | perpendicular | Collinear seam (another bar of same orientation that would align) |
| 2D intersection | X | Original X (constrains to Y-only movement) |
| 2D intersection | Y | Original Y (constrains to X-only movement) |

- **Shift held** = all snapping bypassed
- **Live magnetization** during drag (not on release)
- **Default threshold:** 4%
- **Setting:** `panes.snapThreshold` (0-8, 0 = off)

### Zoom (Maximize/Restore)
A maximize button in the pane header. When zoomed, one pane fills the tab; others are hidden but preserved. Press Escape, click the button again, or press the keyboard shortcut to restore.

### Context Menu Additions
The pane context menu gets "Split right" and "Split down" items (user-facing labels, not "split horizontal/vertical").

---

## Task 1: Change `closePane` to Promote Sibling Instead of Grid Rebuild

The highest-impact change. Currently `closePane` collects all remaining leaves and rebuilds a grid. Instead, it should find the parent split of the closed pane and replace the parent with the surviving sibling.

**Files:**
- Modify: `src/store/panesSlice.ts` (lines 504-538, the `closePane` reducer)
- Modify: `test/unit/client/store/panesSlice.test.ts` (lines 510-721, closePane tests)

### Step 1: Write failing tests for sibling promotion

Add tests in `test/unit/client/store/panesSlice.test.ts` inside the existing `closePane` describe block. These tests should cover:

**Test 1a: Closing right child of a split promotes left child**
```typescript
it('promotes sibling when closing right child of a split', () => {
  // Setup: root is a horizontal split with two leaves (A left, B right)
  // Action: close B
  // Expected: root becomes leaf A (not a grid rebuild)
  // Verify: A's id is preserved, A's content is preserved
  const tabId = 'tab1'
  const leftLeaf = { type: 'leaf' as const, id: 'left', content: terminalContent('left-req') }
  const rightLeaf = { type: 'leaf' as const, id: 'right', content: terminalContent('right-req') }
  const root: PaneNode = {
    type: 'split', id: 'split1', direction: 'horizontal',
    sizes: [60, 40], children: [leftLeaf, rightLeaf],
  }
  const state = makeState({ [tabId]: root }, { [tabId]: 'right' })
  const result = panesReducer(state, closePane({ tabId, paneId: 'right' }))
  // Root should now be the left leaf directly (promoted)
  expect(result.layouts[tabId]).toEqual(leftLeaf)
  expect(result.activePane[tabId]).toBe('left')
})
```

**Test 1b: Closing left child of a split promotes right child**
```typescript
it('promotes sibling when closing left child of a split', () => {
  const tabId = 'tab1'
  const leftLeaf = { type: 'leaf' as const, id: 'left', content: terminalContent('left-req') }
  const rightLeaf = { type: 'leaf' as const, id: 'right', content: terminalContent('right-req') }
  const root: PaneNode = {
    type: 'split', id: 'split1', direction: 'vertical',
    sizes: [50, 50], children: [leftLeaf, rightLeaf],
  }
  const state = makeState({ [tabId]: root }, { [tabId]: 'left' })
  const result = panesReducer(state, closePane({ tabId, paneId: 'left' }))
  expect(result.layouts[tabId]).toEqual(rightLeaf)
  expect(result.activePane[tabId]).toBe('right')
})
```

**Test 1c: Closing pane in nested split preserves the rest of the tree**
```typescript
it('preserves tree structure when closing a pane in a nested split', () => {
  // Setup: root is V-split(H-split(A, B), C)
  // Action: close A
  // Expected: root becomes V-split(B, C) — B promoted to replace H-split
  // The outer split and C are completely untouched
  const tabId = 'tab1'
  const a = { type: 'leaf' as const, id: 'a', content: terminalContent('a-req') }
  const b = { type: 'leaf' as const, id: 'b', content: terminalContent('b-req') }
  const c = { type: 'leaf' as const, id: 'c', content: terminalContent('c-req') }
  const innerSplit: PaneNode = {
    type: 'split', id: 'inner', direction: 'horizontal',
    sizes: [50, 50], children: [a, b],
  }
  const root: PaneNode = {
    type: 'split', id: 'outer', direction: 'vertical',
    sizes: [70, 30], children: [innerSplit, c],
  }
  const state = makeState({ [tabId]: root }, { [tabId]: 'a' })
  const result = panesReducer(state, closePane({ tabId, paneId: 'a' }))
  // Outer split should remain with same sizes, but inner replaced by b
  expect(result.layouts[tabId]).toEqual({
    type: 'split', id: 'outer', direction: 'vertical',
    sizes: [70, 30], children: [b, c],
  })
  expect(result.activePane[tabId]).toBe('b')
})
```

**Test 1d: Closing pane in deeply nested tree preserves all other structure**
```typescript
it('preserves deeply nested tree structure', () => {
  // Setup: root = V-split(H-split(A, B), H-split(C, D))
  // Close B
  // Expected: root = V-split(A, H-split(C, D))
  // H-split(C, D) is completely untouched including sizes
  const tabId = 'tab1'
  const a = { type: 'leaf' as const, id: 'a', content: terminalContent('a-req') }
  const b = { type: 'leaf' as const, id: 'b', content: terminalContent('b-req') }
  const c = { type: 'leaf' as const, id: 'c', content: terminalContent('c-req') }
  const d = { type: 'leaf' as const, id: 'd', content: terminalContent('d-req') }
  const top: PaneNode = {
    type: 'split', id: 'top', direction: 'horizontal',
    sizes: [40, 60], children: [a, b],
  }
  const bottom: PaneNode = {
    type: 'split', id: 'bottom', direction: 'horizontal',
    sizes: [30, 70], children: [c, d],
  }
  const root: PaneNode = {
    type: 'split', id: 'root', direction: 'vertical',
    sizes: [50, 50], children: [top, bottom],
  }
  const state = makeState({ [tabId]: root }, { [tabId]: 'b' })
  const result = panesReducer(state, closePane({ tabId, paneId: 'b' }))
  expect(result.layouts[tabId]).toEqual({
    type: 'split', id: 'root', direction: 'vertical',
    sizes: [50, 50], children: [a, bottom],
  })
  // Bottom split preserved exactly (including sizes)
  expect((result.layouts[tabId] as any).children[1]).toBe(bottom)
})
```

**Test 1e: Still can't close the only pane**
```typescript
it('does nothing when closing the only pane', () => {
  const tabId = 'tab1'
  const leaf = { type: 'leaf' as const, id: 'only', content: terminalContent('only-req') }
  const state = makeState({ [tabId]: leaf }, { [tabId]: 'only' })
  const result = panesReducer(state, closePane({ tabId, paneId: 'only' }))
  expect(result.layouts[tabId]).toEqual(leaf)
})
```

### Step 2: Run tests to verify they fail

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npx vitest run test/unit/client/store/panesSlice.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: New tests fail because `closePane` still does grid rebuild (the promoted sibling tests will see grid-rebuilt structures instead of promoted siblings).

### Step 3: Implement sibling promotion in `closePane`

Replace the `closePane` reducer body in `src/store/panesSlice.ts` (lines 504-538). The new algorithm:

1. If root is a leaf, bail (can't close only pane) — unchanged
2. Find the parent split that contains the target pane as a direct child
3. Get the sibling (the other child of that parent split)
4. Replace the parent split with the sibling in the tree

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

  // Find parent split of target pane and replace it with the sibling
  function removePane(node: PaneNode, targetId: string): PaneNode | null {
    if (node.type === 'leaf') return null

    // Check if target is a direct child
    const [left, right] = node.children
    if (left.type === 'leaf' && left.id === targetId) return right
    if (right.type === 'leaf' && right.id === targetId) return left

    // Check if target is in a split child (the split itself might be the target's container)
    if (left.type === 'split' && left.id === targetId) return right
    if (right.type === 'split' && right.id === targetId) return left

    // Recurse into children
    const leftResult = removePane(left, targetId)
    if (leftResult) {
      return { ...node, children: [leftResult, right] }
    }
    const rightResult = removePane(right, targetId)
    if (rightResult) {
      return { ...node, children: [left, rightResult] }
    }
    return null
  }

  const newRoot = removePane(root, paneId)
  if (newRoot) {
    state.layouts[tabId] = newRoot

    // Update active pane if needed
    if (state.activePane[tabId] === paneId) {
      const leaves = collectLeaves(newRoot)
      state.activePane[tabId] = leaves[leaves.length - 1].id
    }

    // Clean up pane title
    if (state.paneTitles[tabId]?.[paneId]) {
      delete state.paneTitles[tabId][paneId]
    }
  }
},
```

### Step 4: Run tests to verify they pass

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npx vitest run test/unit/client/store/panesSlice.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: All tests pass, including existing tests that should still work (closing right child of a 2-pane split should still leave a single leaf, which is the same result as before).

### Step 5: Update existing tests that assumed grid rebuild

Some existing `closePane` tests may assert grid-rebuild behavior (collecting leaves and rebuilding). Review and update any that check for grid structure after close — they should now check for sibling promotion.

### Step 6: Run full test suite

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npm test 2>&1 | tail -10`

Expected: All 2424+ tests pass.

### Step 7: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts
git commit -m "feat(panes): replace grid rebuild on close with sibling promotion

closePane now promotes the surviving sibling to fill the parent split's
space, preserving the rest of the tree structure exactly as the user
arranged it. Previously, all remaining leaves were collected and rebuilt
into a fixed grid pattern, destroying custom arrangements.

- If closing a direct child of a split, the other child takes the parent's place
- Nested tree structure (sizes, directions, deeper splits) is fully preserved
- Active pane set to nearest remaining leaf if closed pane was active"
```

---

## Task 2: Change `addPane` to Split Active Pane Instead of Grid Rebuild

Currently the FAB (+) button collects all leaves and rebuilds a grid. Instead, it should split the active pane to the right (horizontal split), placing the new pane next to what the user is working on.

**Files:**
- Modify: `src/store/panesSlice.ts` (lines 446-478, the `addPane` reducer)
- Modify: `test/unit/client/store/panesSlice.test.ts` (addPane tests)

### Step 1: Write failing tests for split-active-pane behavior

Add tests in the existing `addPane` describe block:

**Test 2a: Adding a pane splits the active pane horizontally (right)**
```typescript
it('splits the active pane to the right', () => {
  const tabId = 'tab1'
  const leaf = { type: 'leaf' as const, id: 'active', content: terminalContent('active-req') }
  const state = makeState({ [tabId]: leaf }, { [tabId]: 'active' })
  const result = panesReducer(state, addPane({
    tabId,
    newContent: { kind: 'picker' },
  }))
  // Root should be a horizontal split with active pane on left, new pane on right
  const root = result.layouts[tabId]
  expect(root.type).toBe('split')
  if (root.type !== 'split') return
  expect(root.direction).toBe('horizontal')
  expect(root.sizes).toEqual([50, 50])
  expect(root.children[0]).toEqual(leaf) // Original pane preserved
  expect(root.children[1].type).toBe('leaf')
  if (root.children[1].type === 'leaf') {
    expect(root.children[1].content.kind).toBe('picker')
  }
})
```

**Test 2b: Adding a pane in multi-pane layout splits only the active pane**
```typescript
it('splits only the active pane, preserving the rest of the tree', () => {
  // Setup: H-split(A, B), A is active
  // Action: addPane
  // Expected: H-split(H-split(A, new), B) — only A was split
  const tabId = 'tab1'
  const a = { type: 'leaf' as const, id: 'a', content: terminalContent('a-req') }
  const b = { type: 'leaf' as const, id: 'b', content: terminalContent('b-req') }
  const root: PaneNode = {
    type: 'split', id: 'split1', direction: 'horizontal',
    sizes: [50, 50], children: [a, b],
  }
  const state = makeState({ [tabId]: root }, { [tabId]: 'a' })
  const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))
  const newRoot = result.layouts[tabId]
  expect(newRoot.type).toBe('split')
  if (newRoot.type !== 'split') return
  // B should be completely untouched
  expect(newRoot.children[1]).toBe(b)
  // A's position should now contain a split
  expect(newRoot.children[0].type).toBe('split')
})
```

**Test 2c: New pane becomes active**
```typescript
it('sets the new pane as active', () => {
  const tabId = 'tab1'
  const leaf = { type: 'leaf' as const, id: 'active', content: terminalContent('active-req') }
  const state = makeState({ [tabId]: leaf }, { [tabId]: 'active' })
  const result = panesReducer(state, addPane({ tabId, newContent: { kind: 'picker' } }))
  expect(result.activePane[tabId]).not.toBe('active')
  // Active should be the new pane's id
  const root = result.layouts[tabId]
  if (root.type === 'split' && root.children[1].type === 'leaf') {
    expect(result.activePane[tabId]).toBe(root.children[1].id)
  }
})
```

### Step 2: Run tests to verify they fail

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npx vitest run test/unit/client/store/panesSlice.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|PASS" | tail -20`

Expected: New tests fail (grid rebuild produces different structure than expected split-right behavior).

### Step 3: Implement split-active-pane in `addPane`

Replace the `addPane` reducer body in `src/store/panesSlice.ts`:

```typescript
addPane: (
  state,
  action: PayloadAction<{
    tabId: string
    newContent: PaneContentInput
  }>
) => {
  const { tabId, newContent } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  const activePaneId = state.activePane[tabId]
  const newPaneId = nanoid()
  const normalizedContent = normalizeContent(newContent)

  const newLeaf: PaneNode = {
    type: 'leaf',
    id: newPaneId,
    content: normalizedContent,
  }

  if (root.type === 'leaf') {
    // Only one pane — split root horizontally
    state.layouts[tabId] = {
      type: 'split',
      id: nanoid(),
      direction: 'horizontal',
      sizes: [50, 50],
      children: [root, newLeaf],
    }
  } else {
    // Multiple panes — find the active pane and split it
    const targetId = activePaneId || collectLeaves(root)[0].id
    const splitNode: PaneNode = {
      type: 'split',
      id: nanoid(),
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        // placeholder — will be replaced by findAndReplace
        { type: 'leaf', id: 'placeholder', content: normalizedContent },
        newLeaf,
      ],
    }

    // We need to find the target leaf and wrap it in a split
    function splitTarget(node: PaneNode, targetId: string): PaneNode | null {
      if (node.type === 'leaf') {
        if (node.id === targetId) {
          return {
            type: 'split',
            id: nanoid(),
            direction: 'horizontal',
            sizes: [50, 50],
            children: [node, newLeaf],
          }
        }
        return null
      }
      const leftResult = splitTarget(node.children[0], targetId)
      if (leftResult) {
        return { ...node, children: [leftResult, node.children[1]] }
      }
      const rightResult = splitTarget(node.children[1], targetId)
      if (rightResult) {
        return { ...node, children: [node.children[0], rightResult] }
      }
      return null
    }

    const newRoot = splitTarget(root, targetId)
    if (newRoot) {
      state.layouts[tabId] = newRoot
    }
  }

  state.activePane[tabId] = newPaneId

  // Initialize title for new pane
  if (!state.paneTitles[tabId]) {
    state.paneTitles[tabId] = {}
  }
  state.paneTitles[tabId][newPaneId] = derivePaneTitle(normalizedContent)
},
```

### Step 4: Run tests to verify they pass

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npx vitest run test/unit/client/store/panesSlice.test.ts --reporter=verbose 2>&1 | tail -30`

### Step 5: Update existing addPane tests

Existing tests that assert grid-rebuild structure (2-row layouts, ceiling division) need to be updated to reflect the new split-active-pane behavior. Remove or update the grid-specific assertions.

### Step 6: Run full test suite

Run: `cd /home/user/code/freshell/.worktrees/pane-ux && npm test 2>&1 | tail -10`

### Step 7: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts
git commit -m "feat(panes): add pane by splitting active pane instead of grid rebuild

addPane now creates a horizontal split at the active pane's position,
placing the new pane to the right. This preserves the existing layout
structure instead of destroying it with a grid rebuild.

- Single pane: splits root horizontally (same visual result as before)
- Multi-pane: only the active pane is split; all other panes untouched
- New pane becomes active
- Remove buildGridLayout and buildHorizontalRow (no longer used)"
```

---

## Task 3: Add "Split Right" and "Split Down" to Pane Context Menu

Expose the existing `splitPane` action through the context menu with consumer-friendly labels.

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts` (lines 223-234, pane menu)
- Modify: `src/components/context-menu/menu-defs.ts` (lines 10-50, MenuActions type)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (wire up new actions)
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts`

### Step 1: Write failing tests

Add tests for the new pane context menu items:

```typescript
it('pane context menu includes split right and split down', () => {
  const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
  const items = buildMenuItems(target, mockContext)
  const ids = items.filter(i => i.type === 'item').map(i => i.id)
  expect(ids).toContain('split-right')
  expect(ids).toContain('split-down')
})

it('split right calls splitPane with horizontal direction', () => {
  const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
  const items = buildMenuItems(target, mockContext)
  const splitRight = items.find(i => i.type === 'item' && i.id === 'split-right')
  expect(splitRight).toBeDefined()
  if (splitRight?.type === 'item') splitRight.onSelect()
  expect(mockActions.splitPane).toHaveBeenCalledWith('tab1', 'pane1', 'horizontal')
})

it('split down calls splitPane with vertical direction', () => {
  const target: ContextTarget = { kind: 'pane', tabId: 'tab1', paneId: 'pane1' }
  const items = buildMenuItems(target, mockContext)
  const splitDown = items.find(i => i.type === 'item' && i.id === 'split-down')
  expect(splitDown).toBeDefined()
  if (splitDown?.type === 'item') splitDown.onSelect()
  expect(mockActions.splitPane).toHaveBeenCalledWith('tab1', 'pane1', 'vertical')
})
```

### Step 2: Run tests to verify they fail

### Step 3: Add `splitPane` to MenuActions and build menu items

In `menu-defs.ts`, add to `MenuActions` type:
```typescript
splitPane: (tabId: string, paneId: string, direction: 'horizontal' | 'vertical') => void
```

In the `target.kind === 'pane'` block (line 223), add before the rename item:
```typescript
{ type: 'item', id: 'split-right', label: 'Split right', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'horizontal') },
{ type: 'item', id: 'split-down', label: 'Split down', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'vertical') },
{ type: 'separator', id: 'pane-split-sep' },
```

### Step 4: Wire up the action in ContextMenuProvider

In `ContextMenuProvider.tsx`, add the `splitPane` action implementation to the `menuActions` object. It should dispatch the Redux `splitPane` action with a `{ kind: 'picker' }` content for the new pane.

### Step 5: Run tests to verify they pass

### Step 6: Run full test suite

### Step 7: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/components/context-menu/menu-defs.ts src/components/context-menu/ContextMenuProvider.tsx test/
git commit -m "feat(panes): add 'Split right' and 'Split down' to pane context menu

Exposes the existing splitPane reducer through the pane right-click menu
with consumer-friendly labels. Split right creates a horizontal split,
Split down creates a vertical split. New pane opens a picker."
```

---

## Task 4: Add Pane Zoom (Maximize/Restore)

Add a maximize button to the pane header and a `zoomedPane` state per tab. When zoomed, only that pane renders; everything else is hidden but preserved.

**Files:**
- Modify: `src/store/paneTypes.ts` (add `zoomedPane` to PanesState)
- Modify: `src/store/panesSlice.ts` (add `toggleZoom` reducer)
- Modify: `src/components/panes/PaneHeader.tsx` (add maximize/restore button)
- Modify: `src/components/panes/PaneContainer.tsx` (respect zoom state)
- Modify: `src/components/panes/PaneLayout.tsx` (render zoomed pane)
- Create: `test/unit/client/store/panesSlice-zoom.test.ts`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

### Step 1: Write failing tests for zoom state

Create `test/unit/client/store/panesSlice-zoom.test.ts`:

```typescript
describe('toggleZoom', () => {
  it('sets zoomedPane when not zoomed', () => {
    const tabId = 'tab1'
    const state = makeState(/* layout with panes */)
    const result = panesReducer(state, toggleZoom({ tabId, paneId: 'pane1' }))
    expect(result.zoomedPane[tabId]).toBe('pane1')
  })

  it('clears zoomedPane when already zoomed on same pane', () => {
    const state = { ...makeState(/*...*/), zoomedPane: { tab1: 'pane1' } }
    const result = panesReducer(state, toggleZoom({ tabId: 'tab1', paneId: 'pane1' }))
    expect(result.zoomedPane['tab1']).toBeUndefined()
  })

  it('switches zoom to different pane', () => {
    const state = { ...makeState(/*...*/), zoomedPane: { tab1: 'pane1' } }
    const result = panesReducer(state, toggleZoom({ tabId: 'tab1', paneId: 'pane2' }))
    expect(result.zoomedPane['tab1']).toBe('pane2')
  })

  it('clears zoom when zoomed pane is closed', () => {
    // closePane should also clear zoomedPane if the closed pane was zoomed
  })
})
```

### Step 2: Run tests to verify they fail

### Step 3: Add `zoomedPane` to state and `toggleZoom` reducer

In `src/store/paneTypes.ts`, add to `PanesState`:
```typescript
zoomedPane: Record<string, string | undefined>  // tabId -> zoomed paneId
```

In `src/store/panesSlice.ts`, add to initial state and add reducer:
```typescript
toggleZoom: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string }>
) => {
  const { tabId, paneId } = action.payload
  if (!state.zoomedPane) state.zoomedPane = {}
  if (state.zoomedPane[tabId] === paneId) {
    delete state.zoomedPane[tabId]
  } else {
    state.zoomedPane[tabId] = paneId
  }
},
```

Also update `closePane` to clear zoom if zoomed pane is closed:
```typescript
// In closePane, after removing the pane:
if (state.zoomedPane?.[tabId] === paneId) {
  delete state.zoomedPane[tabId]
}
```

### Step 4: Run tests to verify they pass

### Step 5: Add maximize button to PaneHeader

In `src/components/panes/PaneHeader.tsx`, add a maximize/restore icon button next to the close button. Use `Maximize2` / `Minimize2` from lucide-react. The button calls a new `onToggleZoom` prop.

```typescript
// Before the close button:
<button
  onMouseDown={(e) => e.stopPropagation()}
  onClick={onToggleZoom}
  aria-label={isZoomed ? 'Restore pane' : 'Maximize pane'}
  title={isZoomed ? 'Restore pane' : 'Maximize pane'}
  className="p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity"
>
  {isZoomed ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
</button>
```

### Step 6: Update PaneLayout to render zoomed pane

In `PaneLayout.tsx`, check `zoomedPane[tabId]`. If set, find that leaf in the tree and render it full-size instead of the full tree. Show a subtle indicator (e.g., the Minimize2 icon is highlighted).

### Step 7: Add Escape key handler for unzoom

In `PaneLayout.tsx` or `PaneContainer.tsx`, add a keydown listener: if Escape is pressed while a pane is zoomed, dispatch `toggleZoom` to unzoom.

### Step 8: Write component tests for zoom rendering

### Step 9: Run full test suite

### Step 10: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/store/paneTypes.ts src/store/panesSlice.ts src/components/panes/PaneHeader.tsx src/components/panes/PaneLayout.tsx src/components/panes/PaneContainer.tsx test/
git commit -m "feat(panes): add maximize/restore zoom for panes

Adds a maximize button to the pane header that zooms a single pane to
fill the entire tab. Other panes are hidden but preserved in the tree.

- Toggle zoom via header button or Escape key to restore
- Zoom state is per-tab (zoomedPane map in Redux)
- Closing a zoomed pane automatically clears zoom
- Minimize2/Maximize2 icons indicate current state"
```

---

## Task 5: Add Snap Threshold Setting

Add `panes.snapThreshold` to settings (0-8, default 4). This will be consumed by the divider snapping logic in Task 6.

**Files:**
- Modify: `src/store/types.ts` (AppSettings interface)
- Modify: `src/store/settingsSlice.ts` (defaultSettings, mergeSettings)
- Modify: `server/config-store.ts` (server-side type and defaults)
- Modify: `src/components/SettingsView.tsx` (UI control)
- Modify: `test/unit/client/store/settingsSlice.test.ts`

### Step 1: Write failing test for settings merge

```typescript
it('merges panes.snapThreshold without clobbering defaultNewPane', () => {
  const base = { ...defaultSettings }
  const patch = { panes: { snapThreshold: 6 } }
  const result = mergeSettings(base, patch as any)
  expect(result.panes.snapThreshold).toBe(6)
  expect(result.panes.defaultNewPane).toBe('ask') // preserved
})
```

### Step 2: Run test to verify it fails

### Step 3: Add to types and defaults

In `src/store/types.ts`, add `snapThreshold: number` to the `panes` object in `AppSettings`.

In `src/store/settingsSlice.ts`, add `snapThreshold: 4` to `defaultSettings.panes`.

In `server/config-store.ts`, add the same field and default.

### Step 4: Add UI control

In `SettingsView.tsx`, in the Panes section, add a `SettingsRow` with a `RangeSlider`:
- Label: "Snap distance"
- Description: "How strongly pane dividers snap to alignment. 0 = off."
- Min: 0, Max: 8, Step: 1, Default: 4
- Format: `(v) => v === 0 ? 'Off' : '${v}%'`

### Step 5: Run tests to verify they pass

### Step 6: Run full test suite

### Step 7: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/store/types.ts src/store/settingsSlice.ts server/config-store.ts src/components/SettingsView.tsx test/
git commit -m "feat(settings): add panes.snapThreshold setting

Adds a configurable snap distance for pane divider alignment (0-8%,
default 4%). Threshold is % of the container's smallest dimension.
0 disables snapping entirely. Setting visible in Settings > Panes."
```

---

## Task 6: Implement Divider Snapping System

The core snapping logic. Each 1D bar drag snaps to its original position and to collinear seams. All thresholds are `snapThreshold`% of the container's smallest dimension. Shift key bypasses snapping.

**Files:**
- Create: `src/lib/pane-snap.ts` (pure functions for snap calculations)
- Create: `test/unit/lib/pane-snap.test.ts`
- Modify: `src/components/panes/PaneDivider.tsx` (consume snap logic)
- Modify: `src/components/panes/PaneContainer.tsx` (pass snap context to dividers)

### Step 1: Design the snap utility API

`src/lib/pane-snap.ts` exports pure functions:

```typescript
/**
 * Compute the snapped position for a 1D divider drag.
 *
 * @param currentPercent - The divider's current position in %
 * @param originalPercent - Where the divider started before this drag
 * @param collinearPositions - Positions of other bars of the same orientation (in %)
 * @param snapThreshold - Snap distance in % of smallest container dimension
 * @param shiftHeld - If true, bypass all snapping
 * @returns The snapped position (same as currentPercent if no snap)
 */
export function snap1D(
  currentPercent: number,
  originalPercent: number,
  collinearPositions: number[],
  snapThreshold: number,
  shiftHeld: boolean,
): number

/**
 * Collect positions of all dividers of a given orientation in the pane tree.
 * Returns absolute positions (0-100%) by traversing the tree and accumulating
 * size offsets.
 */
export function collectDividerPositions(
  root: PaneNode,
  orientation: 'horizontal' | 'vertical',
): number[]
```

### Step 2: Write comprehensive tests for `snap1D`

```typescript
describe('snap1D', () => {
  it('returns currentPercent when no snap targets are nearby', () => {
    expect(snap1D(65, 50, [], 4, false)).toBe(65)
  })

  it('snaps to original position when within threshold', () => {
    expect(snap1D(52, 50, [], 4, false)).toBe(50)
  })

  it('does not snap to original when outside threshold', () => {
    expect(snap1D(55, 50, [], 4, false)).toBe(55)
  })

  it('snaps to collinear seam when within threshold', () => {
    expect(snap1D(68, 50, [70], 4, false)).toBe(70)
  })

  it('does not snap to collinear seam when outside threshold', () => {
    expect(snap1D(60, 50, [70], 4, false)).toBe(60)
  })

  it('prefers original over collinear when both in range', () => {
    // Original at 50, collinear at 52, current at 51 — snap to nearest
    expect(snap1D(51, 50, [52], 4, false)).toBe(50) // original is closer
  })

  it('bypasses all snapping when shift is held', () => {
    expect(snap1D(52, 50, [53], 4, true)).toBe(52)
  })

  it('returns currentPercent when threshold is 0 (snapping disabled)', () => {
    expect(snap1D(52, 50, [53], 0, false)).toBe(52)
  })

  it('snaps to nearest target when multiple are in range', () => {
    expect(snap1D(46, 50, [45], 4, false)).toBe(45) // collinear is closer
  })
})
```

### Step 3: Write tests for `collectDividerPositions`

```typescript
describe('collectDividerPositions', () => {
  it('returns empty for a leaf node', () => {
    const leaf = { type: 'leaf' as const, id: 'a', content: someContent }
    expect(collectDividerPositions(leaf, 'horizontal')).toEqual([])
  })

  it('returns position for a single horizontal split', () => {
    const root = {
      type: 'split' as const, id: 's1', direction: 'horizontal' as const,
      sizes: [60, 40] as [number, number],
      children: [leaf('a'), leaf('b')],
    }
    // The divider is at 60% from the left
    expect(collectDividerPositions(root, 'horizontal')).toEqual([60])
  })

  it('returns no positions for mismatched orientation', () => {
    const root = {
      type: 'split' as const, id: 's1', direction: 'vertical' as const,
      sizes: [50, 50] as [number, number],
      children: [leaf('a'), leaf('b')],
    }
    expect(collectDividerPositions(root, 'horizontal')).toEqual([])
  })

  it('returns nested positions with correct absolute offsets', () => {
    // V-split(H-split(A, B), H-split(C, D))
    // Top H-split divider at 50% of top half
    // Bottom H-split divider at 50% of bottom half
    // Both are at absolute 50% horizontally (within their row)
    // But they're independent bars
  })
})
```

### Step 4: Run tests to verify they fail

### Step 5: Implement `snap1D` and `collectDividerPositions`

The `snap1D` function:
1. If `shiftHeld` or `snapThreshold === 0`, return `currentPercent`
2. Collect all snap targets: `[originalPercent, ...collinearPositions]`
3. Find the closest target within `snapThreshold`
4. If found, return that target; otherwise return `currentPercent`

The `collectDividerPositions` function:
1. Recursively traverse the tree
2. Track the absolute offset and scale at each level
3. When encountering a split of the matching orientation, compute the absolute position of the divider: `offset + sizes[0] * scale / 100`
4. Recurse into children with updated offset/scale

### Step 6: Run tests to verify they pass

### Step 7: Integrate snapping into PaneDivider

Modify `PaneDivider.tsx`:
- Accept new props: `snapThreshold`, `originalPosition`, `collinearPositions`
- On drag start, capture the original size as `originalPosition`
- On each drag move, compute the new position and pass through `snap1D` before calling `onResize`
- Check `e.shiftKey` on mousemove/touchmove events

Modify `PaneContainer.tsx`:
- Read `snapThreshold` from settings: `useAppSelector(s => s.settings?.settings?.panes?.snapThreshold ?? 4)`
- Compute `collinearPositions` for each divider using `collectDividerPositions`
- Pass the snap props to each `PaneDivider`

### Step 8: Run full test suite

### Step 9: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/lib/pane-snap.ts test/unit/lib/pane-snap.test.ts src/components/panes/PaneDivider.tsx src/components/panes/PaneContainer.tsx
git commit -m "feat(panes): implement divider snapping with collinear alignment

1D divider drags now snap to their original position and to collinear
seams (other bars of the same orientation that would form a clean line).

- Snap threshold from settings (panes.snapThreshold, default 4%)
- Threshold is % of container's smallest dimension
- Hold Shift to bypass all snapping
- Pure snap logic in src/lib/pane-snap.ts with full test coverage
- collectDividerPositions computes absolute bar positions from tree"
```

---

## Task 7: Implement 2D Intersection Dragging

Add hit detection for intersections (where bars cross or meet) and 2D dragging that moves all connected bars simultaneously, with X/Y axis snapping to original coordinates.

**Files:**
- Modify: `src/lib/pane-snap.ts` (add intersection detection, `snap2D`)
- Create: `src/components/panes/IntersectionDragOverlay.tsx` (transparent overlay for intersection hit detection)
- Modify: `src/components/panes/PaneLayout.tsx` (render overlay)
- Modify: `src/store/panesSlice.ts` (batch resize action for multiple splits)
- Create: `test/unit/lib/pane-snap-2d.test.ts`
- Create: `test/unit/client/components/panes/IntersectionDragOverlay.test.tsx`

### Step 1: Design the intersection detection API

Add to `src/lib/pane-snap.ts`:

```typescript
export interface DividerRect {
  splitId: string
  direction: 'horizontal' | 'vertical'
  /** Position along the perpendicular axis (0-100%) */
  position: number
  /** Start of the bar along its own axis (0-100%) */
  start: number
  /** End of the bar along its own axis (0-100%) */
  end: number
}

export interface Intersection {
  /** Pixel position within the container */
  x: number
  y: number
  /** All split IDs that meet at this intersection */
  splitIds: string[]
  /** The divider rects involved */
  dividers: DividerRect[]
}

/**
 * Find all intersections in the pane tree.
 * An intersection is where two dividers of different orientations
 * meet or cross.
 */
export function findIntersections(
  root: PaneNode,
  containerWidth: number,
  containerHeight: number,
): Intersection[]

/**
 * Snap for 2D intersection drag.
 * Snaps X to original X and Y to original Y independently.
 */
export function snap2D(
  currentX: number, currentY: number,
  originalX: number, originalY: number,
  snapThreshold: number,
  shiftHeld: boolean,
): { x: number; y: number }
```

### Step 2: Write tests for intersection detection and snap2D

Test `findIntersections` with:
- 2x2 grid (one cross intersection at center)
- 3-pane L-shape (one T-intersection)
- 2x3 grid (two intersections)
- No intersections (single split)

Test `snap2D` with:
- Snaps X to original when within threshold
- Snaps Y to original when within threshold
- Both snap independently
- Both snap simultaneously (return to origin)
- Shift bypasses

### Step 3: Implement intersection detection and snap2D

`findIntersections`:
1. Compute `DividerRect` for every split node (absolute position in 0-100% space)
2. For each pair of dividers with different orientations, check if they cross or meet
3. Two bars intersect if the perpendicular bar's position falls within the parallel bar's start..end range and vice versa
4. Group intersections by proximity (same point)

`snap2D`:
```typescript
export function snap2D(
  currentX: number, currentY: number,
  originalX: number, originalY: number,
  snapThreshold: number,
  shiftHeld: boolean,
): { x: number; y: number } {
  if (shiftHeld || snapThreshold === 0) return { x: currentX, y: currentY }
  return {
    x: Math.abs(currentX - originalX) <= snapThreshold ? originalX : currentX,
    y: Math.abs(currentY - originalY) <= snapThreshold ? originalY : currentY,
  }
}
```

### Step 4: Add batch resize reducer

In `panesSlice.ts`, add:
```typescript
resizeMultipleSplits: (
  state,
  action: PayloadAction<{
    tabId: string
    resizes: Array<{ splitId: string; sizes: [number, number] }>
  }>
) => {
  const { tabId, resizes } = action.payload
  const root = state.layouts[tabId]
  if (!root) return

  function applySizes(node: PaneNode): PaneNode {
    if (node.type === 'leaf') return node
    const match = resizes.find(r => r.splitId === node.id)
    const updatedNode = match ? { ...node, sizes: match.sizes } : node
    if (updatedNode.type === 'split') {
      return {
        ...updatedNode,
        children: [applySizes(updatedNode.children[0]), applySizes(updatedNode.children[1])],
      }
    }
    return updatedNode
  }

  state.layouts[tabId] = applySizes(root)
},
```

### Step 5: Build IntersectionDragOverlay component

A transparent overlay positioned over the pane container. It:
1. Computes intersections on mount and when layout changes
2. On mouse move, checks proximity to intersections (within ~12px)
3. Changes cursor to `move` when near an intersection
4. On mouse down near an intersection, starts 2D drag
5. During drag, computes delta for each connected bar and dispatches `resizeMultipleSplits`
6. Applies `snap2D` to the intersection position

### Step 6: Write component tests

### Step 7: Run full test suite

### Step 8: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/lib/pane-snap.ts src/components/panes/IntersectionDragOverlay.tsx src/components/panes/PaneLayout.tsx src/store/panesSlice.ts test/
git commit -m "feat(panes): add 2D intersection dragging for dividers

When hovering where dividers cross or meet, the cursor changes to a move
cursor. Dragging moves all connected bars in 2D simultaneously.

- X snaps to original X (constrains to Y-only movement)
- Y snaps to original Y (constrains to X-only movement)
- 3-way T-junctions and 4-way crosses both supported
- resizeMultipleSplits reducer for batched size updates
- Full intersection detection from pane tree geometry"
```

---

## Task 8: Improve Divider Visual Affordance

Make dividers more discoverable with wider hover areas and a grab indicator.

**Files:**
- Modify: `src/components/panes/PaneDivider.tsx` (styling)
- Modify: `test/unit/client/components/panes/PaneDivider.test.tsx`

### Step 1: Write tests for new visual states

```typescript
it('shows grab indicator on hover', () => {
  render(<PaneDivider direction="horizontal" onResize={vi.fn()} onResizeEnd={vi.fn()} />)
  const divider = screen.getByRole('button')
  // Verify the grab handle element exists
  expect(divider.querySelector('[data-grab-handle]')).toBeInTheDocument()
})
```

### Step 2: Update PaneDivider styling

Change the divider from a thin 4px bar to a wider interaction zone:
- **Hit area:** 12px wide (invisible padding around the visible bar)
- **Visible bar:** 1px line (same as current border color)
- **On hover:** Bar widens to 3px, shows subtle grab dots (three small dots in a column/row)
- **During drag:** Bar stays 3px, highlighted color

Implementation approach — use a wrapper div for hit area with a centered visible line:
```typescript
<div
  className={cn(
    'flex-shrink-0 relative group touch-none',
    direction === 'horizontal'
      ? 'w-3 cursor-col-resize'   // 12px hit area
      : 'h-3 cursor-row-resize',
  )}
  // ... handlers
>
  {/* Visible bar */}
  <div className={cn(
    'absolute bg-border transition-all',
    direction === 'horizontal'
      ? 'w-px h-full left-1/2 -translate-x-1/2 group-hover:w-[3px]'
      : 'h-px w-full top-1/2 -translate-y-1/2 group-hover:h-[3px]',
    isDragging && (direction === 'horizontal' ? 'w-[3px]' : 'h-[3px]'),
    isDragging ? 'bg-muted-foreground' : 'group-hover:bg-muted-foreground',
  )} />
  {/* Grab dots (visible on hover) */}
  <div className={cn(
    'absolute opacity-0 group-hover:opacity-40 transition-opacity',
    // centered dots
  )} data-grab-handle />
</div>
```

### Step 3: Run tests to verify they pass

### Step 4: Run full test suite

### Step 5: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/components/panes/PaneDivider.tsx test/
git commit -m "feat(panes): improve divider visual affordance

Dividers now have a 12px hit area (up from 4px) with a 1px visible line
that widens to 3px on hover. Subtle grab dots appear on hover to
indicate the divider is draggable. During drag, the bar stays highlighted.

Visual change only — interaction behavior unchanged."
```

---

## Task 9: Clean Up Dead Code

Remove `buildGridLayout` and `buildHorizontalRow` from `panesSlice.ts` since they're no longer used after Tasks 1-2.

**Files:**
- Modify: `src/store/panesSlice.ts`
- Modify: `test/unit/client/store/panesSlice.test.ts` (remove grid-specific tests)

### Step 1: Verify no remaining references

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
grep -r "buildGridLayout\|buildHorizontalRow" src/ test/
```

### Step 2: Remove functions and tests

Delete `buildGridLayout` (lines 266-297) and `buildHorizontalRow` (lines 230-253) from `panesSlice.ts`.

Remove any tests that specifically tested grid layout patterns (2-row layouts, ceiling division).

### Step 3: Run full test suite

### Step 4: Commit

```bash
cd /home/user/code/freshell/.worktrees/pane-ux
git add src/store/panesSlice.ts test/
git commit -m "refactor(panes): remove dead grid layout code

Remove buildGridLayout and buildHorizontalRow, which are no longer
called after switching addPane and closePane to tree-preserving
operations. Remove associated grid-pattern tests."
```

---

## Task Dependency Graph

```
Task 1 (closePane sibling promotion)  ─┐
Task 2 (addPane split active)         ─┤─→ Task 9 (clean up dead code)
Task 3 (context menu split items)     ─┘
Task 4 (zoom/maximize)                    (independent)
Task 5 (snap threshold setting)       ─→ Task 6 (1D snapping) ─→ Task 7 (2D intersection)
Task 8 (divider visual affordance)        (independent, but nice before Task 6-7)
```

Recommended execution order: 1, 2, 3, 9, 5, 4, 8, 6, 7

---

## Notes for Implementer

- **Testing helpers:** The existing test file `test/unit/client/store/panesSlice.test.ts` already has helpers like `terminalContent()` and `makeState()` — use them.
- **Don't break persistence:** The `zoomedPane` field should NOT be persisted to localStorage (it's ephemeral). Check `persistMiddleware.ts` to make sure it's excluded.
- **Terminal lifecycle:** When the tree structure changes (close, add), existing terminal panes keep their `createRequestId` and `terminalId` — no reconnection needed. Only new panes get new `createRequestId`s.
- **The divider width change (Task 8) may affect resize delta calculation.** The `handleResize` in `PaneContainer.tsx` uses `container.offsetWidth/Height` for percentage conversion — the wider hit area shouldn't affect this since the hit area is just padding, not layout width.
- **Intersection detection (Task 7) requires computing absolute pixel positions from the percentage tree.** Use `containerRef.current.getBoundingClientRect()` in PaneLayout.

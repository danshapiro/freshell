# Fix Terminal Resize on Tab Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix terminal width being incorrectly set when switching tabs, by propagating the `hidden` prop through the component hierarchy so `TerminalView` knows when it becomes visible.

**Architecture:** Thread the `hidden` prop from `TabContent` through `PaneLayout` and `PaneContainer` to `TerminalView`. This allows `TerminalView`'s visibility effect (which triggers `fit()` and sends resize) to fire correctly when tabs are switched.

**Tech Stack:** React, Redux Toolkit, xterm.js, Vitest, Testing Library

---

## Root Cause Summary

The bug occurs because:
1. `TabContent.tsx` receives `hidden` prop from `App.tsx` when tab is not active
2. `TabContent` applies CSS `hidden` class to its wrapper div, but doesn't pass `hidden` to children
3. `PaneLayout` and `PaneContainer` don't accept or pass `hidden` prop
4. `PaneContainer` always renders `TerminalView` with `hidden={false}`
5. `TerminalView`'s visibility effect (lines 169-183) only fires when `hidden` prop changes
6. Since `hidden` is always `false`, the resize logic never triggers on tab switch

---

### Task 1: Add `hidden` Prop to PaneLayout

**Files:**
- Modify: `src/components/panes/PaneLayout.tsx`
- Test: `test/unit/client/components/panes/PaneLayout.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/PaneLayout.test.tsx`:

```typescript
describe('hidden prop propagation', () => {
  it('passes hidden prop to PaneContainer', () => {
    const store = createStore({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'terminal', mode: 'shell' },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
    })

    const { rerender } = renderWithStore(
      <PaneLayout tabId="tab-1" defaultContent={{ kind: 'terminal', mode: 'shell' }} hidden={true} />,
      store
    )

    // Check that PaneContainer received hidden=true (via mock inspection)
    expect(mockPaneContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: true }),
      expect.anything()
    )

    // Rerender with hidden=false
    rerender(
      <Provider store={store}>
        <PaneLayout tabId="tab-1" defaultContent={{ kind: 'terminal', mode: 'shell' }} hidden={false} />
      </Provider>
    )

    expect(mockPaneContainer).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: false }),
      expect.anything()
    )
  })
})
```

Note: You'll need to add a mock for PaneContainer at the top of the test file:

```typescript
const mockPaneContainer = vi.fn(() => <div data-testid="pane-container" />)
vi.mock('@/components/panes/PaneContainer', () => ({
  default: mockPaneContainer,
}))
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/panes/PaneLayout.test.tsx -t "passes hidden prop"`

Expected: FAIL - `hidden` prop not being passed

**Step 3: Write minimal implementation**

In `src/components/panes/PaneLayout.tsx`:

1. Add `hidden` to the interface:
```typescript
interface PaneLayoutProps {
  tabId: string
  defaultContent: PaneContent
  hidden?: boolean
}
```

2. Destructure and pass to PaneContainer:
```typescript
export default function PaneLayout({ tabId, defaultContent, hidden }: PaneLayoutProps) {
  // ... existing code ...

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <PaneContainer tabId={tabId} node={layout} hidden={hidden} />
      <FloatingActionButton
        onAddTerminal={handleAddTerminal}
        onAddBrowser={handleAddBrowser}
      />
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/panes/PaneLayout.test.tsx -t "passes hidden prop"`

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneLayout.tsx test/unit/client/components/panes/PaneLayout.test.tsx
git commit -m "$(cat <<'EOF'
feat(panes): add hidden prop to PaneLayout

Thread hidden prop from parent to PaneContainer to support
terminal resize on tab visibility changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `hidden` Prop to PaneContainer

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Step 1: Write the failing test**

Add to `test/unit/client/components/panes/PaneContainer.test.tsx`:

```typescript
describe('hidden prop propagation', () => {
  it('passes hidden prop to TerminalView', () => {
    const paneId = 'pane-1'
    const leafNode: PaneNode = {
      type: 'leaf',
      id: paneId,
      content: createTerminalContent(),
    }

    const store = createStore({
      layouts: { 'tab-1': leafNode },
      activePane: { 'tab-1': paneId },
    })

    renderWithStore(
      <PaneContainer tabId="tab-1" node={leafNode} hidden={true} />,
      store
    )

    // The mock TerminalView should have received hidden=true
    // We need to update the mock to capture props
    expect(mockTerminalView).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: true }),
      expect.anything()
    )
  })

  it('passes hidden=false to TerminalView when not hidden', () => {
    const paneId = 'pane-1'
    const leafNode: PaneNode = {
      type: 'leaf',
      id: paneId,
      content: createTerminalContent(),
    }

    const store = createStore({
      layouts: { 'tab-1': leafNode },
      activePane: { 'tab-1': paneId },
    })

    renderWithStore(
      <PaneContainer tabId="tab-1" node={leafNode} hidden={false} />,
      store
    )

    expect(mockTerminalView).toHaveBeenLastCalledWith(
      expect.objectContaining({ hidden: false }),
      expect.anything()
    )
  })

  it('propagates hidden through nested splits', () => {
    const rootNode: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'pane-1', content: createTerminalContent() },
        { type: 'leaf', id: 'pane-2', content: createTerminalContent() },
      ],
    }

    const store = createStore({
      layouts: { 'tab-1': rootNode },
      activePane: { 'tab-1': 'pane-1' },
    })

    renderWithStore(
      <PaneContainer tabId="tab-1" node={rootNode} hidden={true} />,
      store
    )

    // Both terminals should receive hidden=true
    const calls = mockTerminalView.mock.calls
    expect(calls.length).toBe(2)
    expect(calls[0][0]).toMatchObject({ hidden: true })
    expect(calls[1][0]).toMatchObject({ hidden: true })
  })
})
```

Note: Update the TerminalView mock at the top to capture props:

```typescript
const mockTerminalView = vi.fn(({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden?: boolean }) => (
  <div data-testid={`terminal-${paneId}`} data-hidden={hidden}>Terminal for {tabId}/{paneId}</div>
))
vi.mock('@/components/TerminalView', () => ({
  default: mockTerminalView,
}))
```

And add `mockTerminalView.mockClear()` to the `beforeEach`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t "hidden prop propagation"`

Expected: FAIL - `hidden` not passed to TerminalView

**Step 3: Write minimal implementation**

In `src/components/panes/PaneContainer.tsx`:

1. Add `hidden` to the interface:
```typescript
interface PaneContainerProps {
  tabId: string
  node: PaneNode
  hidden?: boolean
}
```

2. Destructure in the component:
```typescript
export default function PaneContainer({ tabId, node, hidden }: PaneContainerProps) {
```

3. Pass to recursive PaneContainer calls (in the split render):
```typescript
<div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size1}%` }} className="min-w-0 min-h-0">
  <PaneContainer tabId={tabId} node={node.children[0]} hidden={hidden} />
</div>

// ... divider ...

<div style={{ [node.direction === 'horizontal' ? 'width' : 'height']: `${size2}%` }} className="min-w-0 min-h-0">
  <PaneContainer tabId={tabId} node={node.children[1]} hidden={hidden} />
</div>
```

4. Update `renderContent` function to accept and pass hidden:
```typescript
function renderContent(tabId: string, paneId: string, content: PaneContent, hidden?: boolean) {
  if (content.kind === 'terminal') {
    return <TerminalView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
  }
  // ... rest unchanged
}
```

5. Update the leaf render to pass hidden:
```typescript
if (node.type === 'leaf') {
  return (
    <Pane
      isActive={activePane === node.id}
      isOnlyPane={isOnlyPane}
      onClose={() => handleClose(node.id, node.content)}
      onFocus={() => handleFocus(node.id)}
    >
      {renderContent(tabId, node.id, node.content, hidden)}
    </Pane>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t "hidden prop propagation"`

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "$(cat <<'EOF'
feat(panes): add hidden prop to PaneContainer

Thread hidden prop through split hierarchy to TerminalView
for proper resize behavior on tab visibility changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Update TabContent to Pass `hidden` to PaneLayout

**Files:**
- Modify: `src/components/TabContent.tsx`

**Step 1: Write the failing test**

This is a simple prop threading, but we can verify with an integration-style test.

Add test file `test/unit/client/components/TabContent.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'

// Mock PaneLayout to capture props
const mockPaneLayout = vi.fn(() => <div data-testid="pane-layout" />)
vi.mock('@/components/panes', () => ({
  PaneLayout: mockPaneLayout,
}))

// Mock ClaudeSessionView
vi.mock('@/components/ClaudeSessionView', () => ({
  default: () => <div data-testid="claude-session-view" />,
}))

function createStore(tabs: Array<{ id: string; mode: string; terminalId?: string }>) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: tabs.map((t) => ({
          id: t.id,
          mode: t.mode as 'shell' | 'claude',
          status: 'running' as const,
          title: 'Test',
          terminalId: t.terminalId,
          createRequestId: 'req-1',
        })),
        activeTabId: tabs[0]?.id,
      },
      panes: {
        layouts: {},
        activePane: {},
      },
      settings: {
        settings: defaultSettings,
        status: 'loaded' as const,
      },
    },
  })
}

describe('TabContent', () => {
  beforeEach(() => {
    mockPaneLayout.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true to PaneLayout when hidden prop is true', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={true} />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: true }),
        expect.anything()
      )
    })

    it('passes hidden=false to PaneLayout when hidden prop is false', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={false} />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: false }),
        expect.anything()
      )
    })

    it('passes hidden=undefined to PaneLayout when hidden prop is not provided', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: undefined }),
        expect.anything()
      )
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/TabContent.test.tsx`

Expected: FAIL - hidden prop not passed to PaneLayout

**Step 3: Write minimal implementation**

In `src/components/TabContent.tsx`, update line 33:

```typescript
return (
  <div className={hidden ? 'hidden' : 'h-full w-full'}>
    <PaneLayout tabId={tabId} defaultContent={defaultContent} hidden={hidden} />
  </div>
)
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/TabContent.test.tsx`

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/TabContent.tsx test/unit/client/components/TabContent.test.tsx
git commit -m "$(cat <<'EOF'
feat(tabs): pass hidden prop from TabContent to PaneLayout

Complete the hidden prop chain from App -> TabContent -> PaneLayout
to enable terminal resize on tab visibility changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Run Full Test Suite and Verify Fix

**Files:**
- No new files

**Step 1: Run the full test suite**

Run: `npx vitest run`

Expected: All tests pass

**Step 2: Manual verification**

1. Start the dev server: `npm run dev`
2. Open browser to http://localhost:5173
3. Create two terminal tabs
4. In one terminal, run a command that shows the terminal width (e.g., `echo $COLUMNS` on Unix or check with a TUI app)
5. Switch to the other tab
6. Switch back to the first tab
7. Verify the terminal width is correct immediately (not delayed or wrong)

**Step 3: Commit (if any adjustments were needed)**

Only if tests revealed issues that needed fixing.

---

### Task 5: Final Commit and PR

**Step 1: Verify all commits are clean**

Run: `git log --oneline -5`

Expected: See commits for Tasks 1-3

**Step 2: Run final verification**

Run: `npx vitest run && npx vitest run --config vitest.server.config.ts`

Expected: All tests pass

**Step 3: Create PR or prepare for merge**

The fix is complete when:
- [ ] All tests pass
- [ ] Manual verification confirms terminal resize works on tab switch
- [ ] Code is clean and follows existing patterns

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/components/panes/PaneLayout.tsx` | Add `hidden?: boolean` prop, pass to `PaneContainer` |
| `src/components/panes/PaneContainer.tsx` | Add `hidden?: boolean` prop, pass through splits and to `TerminalView` |
| `src/components/TabContent.tsx` | Pass `hidden` prop to `PaneLayout` |
| `test/unit/client/components/panes/PaneLayout.test.tsx` | Add tests for hidden prop propagation |
| `test/unit/client/components/panes/PaneContainer.test.tsx` | Add tests for hidden prop propagation |
| `test/unit/client/components/TabContent.test.tsx` | New test file for TabContent |

## Data Flow After Fix

```
App.tsx (hidden={t.id !== activeTabId})
  └── TabContent (hidden prop)
        └── PaneLayout (hidden prop)
              └── PaneContainer (hidden prop)
                    ├── [recursive PaneContainer for splits] (hidden prop)
                    └── TerminalView (hidden prop) ← visibility effect triggers correctly
```

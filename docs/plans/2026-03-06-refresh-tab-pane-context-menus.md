# Refresh Tab And Refresh Pane Context Menus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add `Refresh Tab` and `Refresh Pane` to the existing right-click context menus so browser panes reload in place and terminal panes recover by detaching and re-attaching to the existing PTY without recreating the session.

**Architecture:** Keep this entirely on the client. Reuse the existing pane action registries as the imperative boundary for pane-local behavior, add one new terminal refresh action that explicitly detaches and re-attaches through the current terminal stream broker, and wire tab/pane context-menu actions in `ContextMenuProvider` by traversing the pane tree and dispatching per-pane refresh callbacks. Do not add a new server API and do not duplicate the feature into the terminal/browser content menus for this issue; the acceptance surface is the tab menu plus the pane chrome menu.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, xterm.js, Vitest, Testing Library

---

## Scope Notes

- `Refresh Pane` should live on the pane chrome context menu (`ContextIds.Pane`), not the inner terminal/browser/editor content menus.
- `Refresh Tab` should be enabled only when the tab layout contains at least one refreshable leaf.
- Refreshable leaf kinds for this issue:
  - `terminal`: explicit detach + re-attach against the existing `terminalId`
  - `browser`: call the existing in-place iframe reload action
- Non-refreshable pane kinds for now:
  - `editor`
  - `picker`
  - `agent-chat`
  - `extension`
- No server files should change.
- No `docs/index.html` update is required; this is a small context-menu addition, not a major mock-UI change.

### Task 1: Add A Shared Leaf Traversal Helper

**Files:**
- Modify: `src/lib/pane-utils.ts:1-54`
- Test: `test/unit/client/lib/pane-utils.test.ts:1-45`

**Step 1: Write the failing test**

Add leaf-node tests to `test/unit/client/lib/pane-utils.test.ts`:

```ts
import { collectPaneContents, collectPaneLeaves } from '@/lib/pane-utils'

describe('collectPaneLeaves', () => {
  it('returns leaf ids and contents in tree order', () => {
    const tree = split([
      split([leaf('p1', shellContent), leaf('p2', claudeContent)]),
      leaf('p3', browserContent),
    ])

    expect(collectPaneLeaves(tree).map((leaf) => leaf.id)).toEqual(['p1', 'p2', 'p3'])
    expect(collectPaneLeaves(tree).map((leaf) => leaf.content.kind)).toEqual([
      'terminal',
      'terminal',
      'browser',
    ])
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: FAIL because `collectPaneLeaves` is not exported yet.

**Step 3: Write minimal implementation**

Add a shared helper to `src/lib/pane-utils.ts` by promoting the same traversal idea already used privately in `panesSlice`:

```ts
export function collectPaneLeaves(node: PaneNode): Array<Extract<PaneNode, { type: 'leaf' }>> {
  if (node.type === 'leaf') {
    return [node]
  }

  return [
    ...collectPaneLeaves(node.children[0]),
    ...collectPaneLeaves(node.children[1]),
  ]
}
```

Keep `collectPaneContents` and `findPaneContent` unchanged; this helper is just the shared traversal primitive the menu code needs.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/pane-utils.ts test/unit/client/lib/pane-utils.test.ts
git commit -m "test(panes): add shared leaf traversal helper"
```

### Task 2: Add Refresh Menu Contracts In `menu-defs`

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts:10-59`
- Modify: `src/components/context-menu/menu-defs.ts:188-249`
- Modify: `src/components/context-menu/menu-defs.ts:259-344`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts:5-140`

**Step 1: Write the failing test**

Extend `test/unit/client/components/context-menu/menu-defs.test.ts` so the contract is explicit before wiring real behavior:

```ts
it('tab context menu includes Refresh tab before rename', () => {
  const actions = createMockActions()
  const ctx = createMockContext(actions)
  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const ids = items.filter((item) => item.type === 'item').map((item) => item.id)

  expect(ids).toContain('refresh-tab')
  expect(ids.indexOf('refresh-tab')).toBeLessThan(ids.indexOf('rename-tab'))
})

it('pane context menu includes Refresh pane for terminal panes', () => {
  const actions = createMockActions()
  const ctx = createMockContext(actions)
  const items = buildMenuItems({ kind: 'pane', tabId: 'tab1', paneId: 'pane1' }, ctx)

  expect(items.filter((item) => item.type === 'item').map((item) => item.id)).toContain('refresh-pane')
})

it('disables Refresh pane for unsupported pane kinds', () => {
  const actions = createMockActions()
  const ctx = {
    ...createMockContext(actions),
    paneLayouts: {
      tab1: { type: 'leaf', id: 'pane1', content: { kind: 'editor', filePath: null, language: null, readOnly: false, content: '', viewMode: 'source' } },
    },
  }
  const items = buildMenuItems({ kind: 'pane', tabId: 'tab1', paneId: 'pane1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-pane')

  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : false).toBe(true)
})

it('selecting Refresh tab calls refreshTab', () => {
  const actions = createMockActions()
  const ctx = createMockContext(actions)
  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')

  expect(refreshItem).toBeDefined()
  if (refreshItem?.type === 'item') refreshItem.onSelect()
  expect(actions.refreshTab).toHaveBeenCalledWith('tab1')
})
```

Update `createMockActions()` with `refreshTab` and `refreshPane` spies.

For the enabled-path tests, also make the mock registry getters return a truthy action object:

```ts
mockActions.getTerminalActions.mockReturnValue({
  copySelection: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn(),
  clearScrollback: vi.fn(),
  reset: vi.fn(),
  scrollToBottom: vi.fn(),
  hasSelection: () => false,
  openSearch: vi.fn(),
} as any)
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: FAIL because the new action fields and menu items do not exist yet.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`:

```ts
export type MenuActions = {
  // existing fields...
  refreshTab: (tabId: string) => void
  refreshPane: (tabId: string, paneId: string) => void
}

function canRefreshPaneContent(
  content: PaneContent | null,
  paneId: string,
  actions: MenuActions,
): boolean {
  if (!content) return false
  if (content.kind === 'terminal') return !!actions.getTerminalActions(paneId)
  if (content.kind === 'browser') return !!actions.getBrowserActions(paneId)
  return false
}
```

Use `collectPaneLeaves(layout)` to compute whether a tab has any refreshable leaves, then insert the new items:

```ts
{ type: 'item', id: 'refresh-tab', label: 'Refresh tab', onSelect: () => actions.refreshTab(target.tabId), disabled: !canRefreshTab }
```

```ts
{ type: 'item', id: 'refresh-pane', label: 'Refresh pane', onSelect: () => actions.refreshPane(target.tabId, target.paneId), disabled: !canRefreshPane }
```

Placement:

- `Refresh tab` goes in the tab menu before `Rename tab`.
- `Refresh pane` goes in the pane menu before split actions.

Do not add `Refresh pane` to the `terminal` or `browser` content menus in this issue.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/components/context-menu/menu-defs.test.ts
git commit -m "feat(ui): add refresh tab and pane menu contracts"
```

### Task 3: Make The Pane Chrome A Keyboard Context Target

**Files:**
- Modify: `src/components/panes/Pane.tsx:61-104`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx:183-220`

**Step 1: Write the failing test**

Add a focused-pane keyboard test to `test/unit/client/components/ContextMenuProvider.test.tsx`:

```tsx
import Pane from '@/components/panes/Pane'

it('opens the pane context menu from the focused pane shell with Shift+F10', async () => {
  const user = userEvent.setup()
  renderWithProvider(
    <Pane
      tabId="tab-1"
      paneId="pane-1"
      isActive
      isOnlyPane={false}
      title="Shell"
      status="running"
      content={{ kind: 'terminal', mode: 'shell', shell: 'system', createRequestId: 'req-1', status: 'running' }}
      onClose={() => {}}
      onFocus={() => {}}
    >
      <div>Body</div>
    </Pane>,
  )

  const pane = screen.getByRole('group', { name: 'Pane: Shell' })
  pane.focus()
  await user.keyboard('{Shift>}{F10}{/Shift}')

  expect(screen.getByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL when the real `Pane` shell is focused, because `findContextElement()` walks upward from `document.activeElement` and the focusable pane root does not currently carry `data-context`.

**Step 3: Write minimal implementation**

Move the pane context metadata onto the already-focusable pane shell in `src/components/panes/Pane.tsx`:

```tsx
<div
  data-pane-shell="true"
  data-context={ContextIds.Pane}
  data-tab-id={tabId}
  data-pane-id={paneId}
  role="group"
  tabIndex={0}
  aria-label={`Pane: ${title || 'untitled'}`}
>
```

Keep nested terminal/browser/editor content context markers intact so right-clicking inside content still resolves to the more specific content menu.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS for the keyboard-open case, with no regressions in the existing tab context-key test.

**Step 5: Commit**

```bash
git add src/components/panes/Pane.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix(a11y): make pane context menu keyboard reachable"
```

### Task 4: Add A Real Terminal Refresh Action

**Files:**
- Modify: `src/lib/pane-action-registry.ts:1-63`
- Modify: `src/components/TerminalView.tsx:883-901`
- Modify: `src/components/TerminalView.tsx:1110-1161`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx:763-847`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx:1796-1865`

**Step 1: Write the failing test**

Add explicit refresh-action tests to `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
import { getTerminalActions } from '@/lib/pane-action-registry'

it('refresh action detaches and viewport-reattaches a visible terminal', async () => {
  const { tabId, paneId } = setupVisibleTerminalHarness()

  await waitFor(() => expect(getTerminalActions(paneId)).toBeDefined())
  wsMocks.send.mockClear()

  getTerminalActions(paneId)!.refresh()

  expect(wsMocks.send).toHaveBeenNthCalledWith(1, { type: 'terminal.detach', terminalId: 'term-existing' })
  expect(wsMocks.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
    type: 'terminal.attach',
    terminalId: 'term-existing',
    sinceSeq: 0,
    attachRequestId: expect.any(String),
  }))
})

it('refresh action keeps hidden terminals on the delta path until visible again', async () => {
  const { paneId } = setupHiddenTerminalHarnessWithOutputSeq(3)

  await waitFor(() => expect(getTerminalActions(paneId)).toBeDefined())
  wsMocks.send.mockClear()

  getTerminalActions(paneId)!.refresh()

  expect(wsMocks.send).toHaveBeenNthCalledWith(1, { type: 'terminal.detach', terminalId: 'term-hidden' })
  expect(wsMocks.send).toHaveBeenNthCalledWith(2, expect.objectContaining({
    type: 'terminal.attach',
    terminalId: 'term-hidden',
    sinceSeq: 3,
    attachRequestId: expect.any(String),
  }))
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because `TerminalActions` has no `refresh()` method yet.

**Step 3: Write minimal implementation**

First extend the registry contract in `src/lib/pane-action-registry.ts`:

```ts
export type TerminalActions = {
  copySelection: () => Promise<void> | void
  paste: () => Promise<void> | void
  selectAll: () => void
  clearScrollback: () => void
  reset: () => void
  scrollToBottom: () => void
  hasSelection: () => boolean
  openSearch: () => void
  refresh: () => void
}
```

Then add the refresh implementation in `src/components/TerminalView.tsx` and register it with the existing actions object:

```ts
const refreshTerminal = () => {
  const tid = terminalIdRef.current
  if (!tid) return

  ws.send({ type: 'terminal.detach', terminalId: tid })
  currentAttachRef.current = null

  if (hiddenRef.current) {
    needsViewportHydrationRef.current = true
    attachTerminal(tid, 'keepalive_delta')
    return
  }

  attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
}
```

Register it:

```ts
const unregisterActions = registerTerminalActions(paneId, {
  // existing actions...
  openSearch: () => setSearchOpen(true),
  refresh: refreshTerminal,
})
```

Important behavior notes:

- Use the existing `attachTerminal()` helper; do not invent a second attach code path.
- Visible panes should use `viewport_hydrate` so scrollback replays immediately.
- Hidden panes should use `keepalive_delta` after setting `needsViewportHydrationRef.current = true`; that preserves the existing deferred-hydration behavior when the tab becomes visible.
- Do not change the server protocol.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS for the new refresh cases and the existing attach/visibility regression coverage.

**Step 5: Commit**

```bash
git add src/lib/pane-action-registry.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat(terminals): add refresh action for PTY reattach"
```

### Task 5: Wire `refreshPane` And `refreshTab` In `ContextMenuProvider`

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:209-235`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:779-898`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx:1-220`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx:760-859`

**Step 1: Write the failing test**

Add provider-level tests that use the real registry boundary instead of mocking internals:

```tsx
import { registerBrowserActions, registerTerminalActions } from '@/lib/pane-action-registry'

it('refresh pane calls the terminal refresh action for a terminal leaf', async () => {
  const user = userEvent.setup()
  const refreshSpy = vi.fn()

  const unregister = registerTerminalActions('pane-1', {
    copySelection: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clearScrollback: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    hasSelection: () => false,
    openSearch: vi.fn(),
    refresh: refreshSpy,
  })

  const { store } = renderWithProvider(
    <div data-context={ContextIds.Pane} data-tab-id="tab-1" data-pane-id="pane-1">Pane One</div>,
  )

  await user.pointer({ target: screen.getByText('Pane One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

  expect(refreshSpy).toHaveBeenCalledTimes(1)
  unregister()
})

it('refresh tab refreshes every refreshable leaf in the layout tree', async () => {
  const user = userEvent.setup()
  const terminalRefresh = vi.fn()
  const browserReload = vi.fn()

  // Register actions for pane-term and pane-browser.
  // Build store with a split tab containing one terminal leaf and one browser leaf.

  await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

  expect(terminalRefresh).toHaveBeenCalledTimes(1)
  expect(browserReload).toHaveBeenCalledTimes(1)
})
```

Use a split layout in preloaded state so the tab-refresh test covers iteration through the real pane tree.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL because `ContextMenuProvider` does not expose `refreshPane` or `refreshTab` in its action map yet.

**Step 3: Write minimal implementation**

Add two provider callbacks in `src/components/context-menu/ContextMenuProvider.tsx`:

```ts
const refreshPaneAction = useCallback((tabId: string, paneId: string) => {
  const layout = panes[tabId]
  const content = layout ? findPaneContent(layout, paneId) : null
  if (!content) return

  if (content.kind === 'terminal') {
    getTerminalActions(paneId)?.refresh?.()
    return
  }

  if (content.kind === 'browser') {
    getBrowserActions(paneId)?.reload()
  }
}, [panes])

const refreshTabAction = useCallback((tabId: string) => {
  const layout = panes[tabId]
  if (!layout) return

  for (const leaf of collectPaneLeaves(layout)) {
    refreshPaneAction(tabId, leaf.id)
  }
}, [panes, refreshPaneAction])
```

Then wire them into the `actions` object passed to `buildMenuItems()`:

```ts
actions: {
  // existing actions...
  refreshTab: refreshTabAction,
  refreshPane: refreshPaneAction,
}
```

Do not dispatch Redux updates for refresh itself; the point is to preserve pane identity and let the pane-local action repair its own frontend connection.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS, including:

- right-click pane menu shows and invokes `Refresh pane`
- right-click tab menu shows and invokes `Refresh tab`
- keyboard-open on the focused pane shell still works

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "feat(ui): wire refresh tab and pane context menu actions"
```

### Task 6: Add An Integration Flow For Mixed-Pane Refresh

**Files:**
- Create: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing test**

Create `test/e2e/refresh-context-menu-flow.test.tsx` with an app-level flow that exercises the real provider/menu stack over a split layout:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import TabBar from '@/components/TabBar'
import { registerBrowserActions, registerTerminalActions } from '@/lib/pane-action-registry'

describe('refresh context menu flow', () => {
  it('refresh tab refreshes each refreshable pane exactly once', async () => {
    const user = userEvent.setup()
    const terminalRefresh = vi.fn()
    const browserReload = vi.fn()

    const unregisterTerminal = registerTerminalActions('pane-term', {
      copySelection: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      clearScrollback: vi.fn(),
      reset: vi.fn(),
      scrollToBottom: vi.fn(),
      hasSelection: () => false,
      openSearch: vi.fn(),
      refresh: terminalRefresh,
    })

    const unregisterBrowser = registerBrowserActions('pane-browser', {
      back: vi.fn(),
      forward: vi.fn(),
      reload: browserReload,
      stop: vi.fn(),
      copyUrl: vi.fn(),
      openExternal: vi.fn(),
      toggleDevTools: vi.fn(),
    })

    render(/* provider + TabBar + tab shell with split layout */)

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

    expect(terminalRefresh).toHaveBeenCalledTimes(1)
    expect(browserReload).toHaveBeenCalledTimes(1)

    unregisterTerminal()
    unregisterBrowser()
  })

  it('keyboard-opened pane menu can invoke Refresh pane', async () => {
    // Focus the pane shell, press Shift+F10, activate Refresh pane, assert only the target refresh spy fires.
  })
})
```

This file should use the same store shape the real app uses: one tab with a split layout containing `pane-term` and `pane-browser`.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: FAIL until the tab/pane refresh wiring is complete.

**Step 3: Write minimal implementation**

Finish the test by rendering the actual `ContextMenuProvider`, `TabBar`, and focusable pane shells. Keep the pane-local behavior mocked via the real registry, not via DOM hacks. This test is here to prove the end-to-end flow:

- tab menu renders `Refresh tab`
- pane menu renders `Refresh pane`
- mixed terminal/browser tabs call both refresh paths exactly once
- keyboard-open works through the real menu component and `role="menuitem"` controls

No production code should need to change in this task if Tasks 1-5 were done correctly.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "test(ui): add refresh context menu flow coverage"
```

## Final Validation

Run the smallest useful focused suite first:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Then run the accessibility and full regression gates:

```bash
npm run lint
npm test
```

Expected final state:

- Tab right-click menu includes `Refresh tab`
- Pane right-click menu includes `Refresh pane`
- `Refresh pane` reloads browser panes and detaches/re-attaches terminal panes without creating a new PTY
- `Refresh tab` refreshes every refreshable leaf in the tab layout tree and skips unsupported pane kinds
- Keyboard `Shift+F10` / context-menu-key access works from the pane shell and tab item
- No server-side changes

If `npm test` surfaces unrelated failures, stop and fix them before rebasing or merging, per repo policy.

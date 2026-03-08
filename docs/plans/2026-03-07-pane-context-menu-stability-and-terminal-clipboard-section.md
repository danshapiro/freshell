# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open reliably on inactive panes, and make the terminal context menu start with an iconized `copy` / `Paste` / `Select all` section.

**Architecture:** Right-click should not activate a pane. The context-menu pipeline already carries the clicked `tabId` and `paneId`, so secondary-button activation is unnecessary state churn and the cleanest place to remove the open-then-close race. Keep `ContextMenuProvider` and `ContextMenu` behavior intact unless the new integration test proves otherwise; implement the menu layout change in `buildMenuItems()` with a dedicated terminal clipboard-section helper so ordering, label casing, and icons are data-driven and easy to test.

**Tech Stack:** React 18, TypeScript, lucide-react, Vitest, Testing Library

---

## Scope Notes

- Only the terminal context menu gets the new top clipboard section.
- Preserve the existing terminal menu item ids (`terminal-copy`, `terminal-paste`, `terminal-select-all`) so callers and nearby tests do not churn unnecessarily.
- `copy` must be labeled exactly `copy`.
- Keep the existing enabled/disabled behavior for copy, paste, select all, search, refresh, split, resume, and terminal-maintenance actions.
- No server, WebSocket, persistence, or `docs/index.html` changes are required.

### Task 1: Stop Secondary Click From Activating Pane Shells

**Why:** The menu system already targets the clicked pane through `data-tab-id` / `data-pane-id`. Activating panes on right-click adds state churn without adding correctness, and it is the most direct cause to eliminate before touching menu-dismiss logic.

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Modify: `test/unit/client/components/panes/Pane.test.tsx`
- Create: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Write the failing tests**

Add this unit test to `test/unit/client/components/panes/Pane.test.tsx`:

```tsx
it('does not call onFocus on right mouse down', () => {
  const onFocus = vi.fn()

  const { container } = render(
    <Pane
      tabId="tab-1"
      paneId="pane-1"
      isActive={false}
      isOnlyPane={false}
      title="Terminal"
      status="running"
      content={makeTerminalContent()}
      onClose={vi.fn()}
      onFocus={onFocus}
    >
      <div>Content</div>
    </Pane>,
  )

  fireEvent.mouseDown(container.firstChild as HTMLElement, { button: 2 })

  expect(onFocus).not.toHaveBeenCalled()
})
```

Create `test/e2e/pane-context-menu-flow.test.tsx` with a provider-driven harness that uses real `Pane` shells and local active-pane state:

```tsx
import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import Pane from '@/components/panes/Pane'

function createContextMenuStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: 'linux',
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function makeTerminalContent(requestId: string) {
  return {
    kind: 'terminal' as const,
    mode: 'shell' as const,
    shell: 'system' as const,
    createRequestId: requestId,
    status: 'running' as const,
  }
}

function TerminalPaneHarness() {
  const [activePaneId, setActivePaneId] = useState('pane-1')

  return (
    <>
      <output aria-label="active pane">{activePaneId}</output>
      <Pane
        tabId="tab-1"
        paneId="pane-1"
        isActive={activePaneId === 'pane-1'}
        isOnlyPane={false}
        title="Left"
        status="running"
        content={makeTerminalContent('req-left')}
        onClose={() => {}}
        onFocus={() => setActivePaneId('pane-1')}
      >
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
          Left terminal body
        </div>
      </Pane>
      <Pane
        tabId="tab-1"
        paneId="pane-2"
        isActive={activePaneId === 'pane-2'}
        isOnlyPane={false}
        title="Right"
        status="running"
        content={makeTerminalContent('req-right')}
        onClose={() => {}}
        onFocus={() => setActivePaneId('pane-2')}
      >
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-2">
          Right terminal body
        </div>
      </Pane>
    </>
  )
}

function renderFlow() {
  return render(
    <Provider store={createContextMenuStore()}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <TerminalPaneHarness />
      </ContextMenuProvider>
    </Provider>,
  )
}

it('keeps the terminal context menu open when right-clicking an inactive pane', async () => {
  const user = userEvent.setup()

  renderFlow()

  await user.pointer({ target: screen.getByText('Right terminal body'), keys: '[MouseRight]' })

  expect(await screen.findByRole('menu')).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
  expect(screen.getByLabelText('active pane')).toHaveTextContent('pane-1')
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-flow.test.tsx
```

Expected: FAIL because `Pane` currently calls `onFocus` on every `mousedown`, including secondary-button right clicks, so the inactive pane becomes active during the opening gesture.

**Step 3: Write minimal implementation**

Update `src/components/panes/Pane.tsx` so only primary-button mouse presses activate the pane:

```tsx
onMouseDown={(event) => {
  // Right-click should target the pane without changing active-pane state.
  if (event.button !== 0) return
  onFocus()
}}
```

Do not change keyboard activation. Do not change `ContextMenuProvider` yet.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/panes/Pane.tsx test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-flow.test.tsx
git commit -m "fix(panes): ignore secondary-click pane activation"
```

### Task 2: Move Terminal Clipboard Actions Into An Iconized Top Section

**Why:** The terminal menu currently mixes pane-management actions with clipboard actions and labels `terminal-copy` as `Copy selection`. A dedicated helper makes the requested order, exact label, and icon requirements explicit and easy to maintain.

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Write the failing tests**

Add this unit coverage to `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('puts copy, Paste, and Select all first and separates them from the rest of the menu', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    expect(items.slice(0, 4).map((item) => item.type === 'item' ? item.id : item.type)).toEqual([
      'terminal-copy',
      'terminal-paste',
      'terminal-select-all',
      'separator',
    ])

    const labels = items.slice(0, 3).map((item) => item.type === 'item' ? item.label : '')
    expect(labels).toEqual(['copy', 'Paste', 'Select all'])
  })

  it('attaches icons to the terminal clipboard items', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    for (const id of ['terminal-copy', 'terminal-paste', 'terminal-select-all']) {
      const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
      expect(item?.type).toBe('item')
      if (item?.type === 'item') {
        expect(item.icon).toBeTruthy()
      }
    }
  })

  it('"Search" appears after the split section, not inside the clipboard section', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    const splitSeparatorIndex = items.findIndex((item) => item.type === 'separator' && item.id === 'terminal-split-sep')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(splitSeparatorIndex).toBeGreaterThan(0)
    expect(searchIndex).toBe(splitSeparatorIndex + 1)
  })
})
```

Extend `test/e2e/pane-context-menu-flow.test.tsx` with a rendering-level assertion:

```tsx
import { within } from '@testing-library/react'

it('renders copy, Paste, and Select all as the first iconized section of the terminal menu', async () => {
  const user = userEvent.setup()

  renderFlow()

  await user.pointer({ target: screen.getByText('Right terminal body'), keys: '[MouseRight]' })

  const menu = await screen.findByRole('menu')
  const firstThree = within(menu).getAllByRole('menuitem').slice(0, 3)

  expect(firstThree.map((item) => item.textContent?.trim())).toEqual([
    'copy',
    'Paste',
    'Select all',
  ])

  for (const item of firstThree) {
    expect(item.querySelector('svg')).not.toBeNull()
  }
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: FAIL because the terminal menu still starts with refresh/split items, `terminal-copy` is labeled `Copy selection`, and the clipboard items do not have icons.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`:

```tsx
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'
```

Add a small helper near the other menu helpers:

```tsx
function buildTerminalClipboardItems(
  terminalActions: TerminalActions | undefined,
  hasSelection: boolean,
): MenuItem[] {
  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: <Copy className="h-3.5 w-3.5" aria-hidden="true" />,
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />,
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: <TextSelect className="h-3.5 w-3.5" aria-hidden="true" />,
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Then rewrite the `target.kind === 'terminal'` return value so the terminal clipboard section is first and isolated:

```tsx
return [
  ...buildTerminalClipboardItems(terminalActions, hasSelection),
  { type: 'separator', id: 'terminal-clipboard-sep' },
  {
    type: 'item',
    id: 'refresh-pane',
    label: 'Refresh pane',
    onSelect: () => actions.refreshPane(target.tabId, target.paneId),
    disabled: !canRefreshPane,
  },
  { type: 'item', id: 'terminal-split-h', label: 'Split horizontally', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'horizontal') },
  { type: 'item', id: 'terminal-split-v', label: 'Split vertically', onSelect: () => actions.splitPane(target.tabId, target.paneId, 'vertical') },
  { type: 'separator', id: 'terminal-split-sep' },
  {
    type: 'item',
    id: 'terminal-search',
    label: 'Search',
    onSelect: () => terminalActions?.openSearch(),
    disabled: !terminalActions,
  },
  ...terminalResumeMenuItem,
  { type: 'separator', id: 'terminal-sep' },
  {
    type: 'item',
    id: 'terminal-scroll-bottom',
    label: 'Scroll to bottom',
    onSelect: () => terminalActions?.scrollToBottom(),
    disabled: !terminalActions,
  },
  {
    type: 'item',
    id: 'terminal-clear',
    label: 'Clear scrollback',
    onSelect: () => terminalActions?.clearScrollback(),
    disabled: !terminalActions,
  },
  {
    type: 'item',
    id: 'terminal-reset',
    label: 'Reset terminal',
    onSelect: () => terminalActions?.reset(),
    disabled: !terminalActions,
  },
  { type: 'separator', id: 'terminal-replace-sep' },
  { type: 'item', id: 'replace-pane', label: 'Replace pane', onSelect: () => actions.replacePane(target.tabId, target.paneId) },
]
```

Do not rename ids. Do not change non-terminal menus.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
git commit -m "feat(context-menu): group terminal clipboard actions"
```

### Task 3: Run Full Regression And Manual Smoke

**Why:** This change is small but highly interactive. The targeted unit and e2e tests should lock the intended behavior, and the full suite plus one manual browser check protects against regressions in nearby menu flows.

**Files:**
- Test: `test/unit/client/components/panes/Pane.test.tsx`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Run the focused regression lane**

Run:

```bash
npx vitest run test/unit/client/components/panes/Pane.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS. If anything fails, stop and fix it before any merge work.

**Step 3: Start a worktree dev server on a dedicated port**

Run:

```bash
PORT=3344 npm run dev > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid
```

Expected: the command prints a PID and the worktree server starts on port `3344`.

**Step 4: Manually verify the behavior in the browser**

- Open the worktree app on port `3344`.
- Right-click an inactive terminal pane body.
- Confirm the menu stays open instead of flashing closed.
- Confirm the first section is `copy`, `Paste`, `Select all`.
- Confirm each of those three rows shows an icon.
- Confirm the active pane did not change just because of the right-click.

**Step 5: Stop only that worktree server**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3344.pid)"
kill "$(cat /tmp/freshell-3344.pid)"
rm -f /tmp/freshell-3344.pid
```

Expected: `ps` shows the process belongs to `.worktrees/trycycle-pane-context-menu-fix`, and only that PID is terminated.

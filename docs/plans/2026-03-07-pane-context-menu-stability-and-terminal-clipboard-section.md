# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix the pane right-click menu so it does not immediately reclose, and make the terminal context menu start with an iconized `copy` / `Paste` / `Select all` section.

**Architecture:** Do not assume a new pane-activation or dismissal rule up front. Start with the shared pane-shell path the user described: inactive pane header / shell, real `Pane` -> `PaneContainer` -> Redux `activePane`, and the four `ContextMenuProvider` dismissal signals (`pointerdown`, `scroll`, `resize`, `blur`). Use a regression harness that wraps the actual dismiss listeners `ContextMenuProvider` registers after the menu opens, so the trace reflects the real close path instead of generic global events that happened before those listeners existed. Then fix only the traced dismissal path or the pane-activation/focus path that produces it. After the shared pane path is stable, add the terminal-body regression and the requested terminal-menu reorder. Keep `menu-defs.ts` as a `.ts` module by constructing icon nodes with `createElement(...)` instead of JSX.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, lucide-react, Vitest, Testing Library, xterm.js test mocks

---

## Scope Notes

- The requested label/order/icon change applies only to the terminal context menu.
- Preserve existing terminal item ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- `copy` must be labeled exactly `copy`.
- Keep current enable/disable behavior for copy, paste, select all, search, refresh, split, resume, and maintenance items.
- The bug fix must first be proven on the shared pane header / pane shell path, not only on terminal content.
- Add a terminal-body regression after the shared pane path is characterized, because terminal focus may introduce a second close signal.
- Any diagnostic trace used to choose the fix must observe `ContextMenuProvider`’s own post-open close path, not generic browser events that fired before the dismiss listeners were attached.
- Tests for the bug should assert only the user-visible requirement: the menu stays open on right-click. They should not lock in whether right-click changes the active pane unless that becomes unavoidable for the final fix.
- Keep `src/components/context-menu/menu-defs.ts` as `.ts`; do not insert JSX into it.
- No server, WebSocket protocol, persistence, or `docs/index.html` changes are required.

### Task 1: Characterize The Shared Pane-Shell Failure And Capture The Real Dismiss Signal

**Why:** The user reported right-clicking “a pane,” and the shared path is the pane shell in `Pane.tsx`, not terminal content. Before changing production behavior, prove the bug on that shared path and capture which dismissal signal actually fires.

**Files:**
- Create: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Write the failing shared-pane regression with a provider-dismiss trace**

Create `test/e2e/pane-context-menu-flow.test.tsx` with a real `PaneContainer` + `ContextMenuProvider` harness and two browser panes so the test goes through the shared pane shell / header path without introducing xterm focus yet:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import PaneContainer from '@/components/panes/PaneContainer'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode } from '@/store/paneTypes'

function PaneContainerFromStore({ tabId }: { tabId: string }) {
  const node = useAppSelector((state) => state.panes.layouts[tabId])
  if (!node) return null
  return <PaneContainer tabId={tabId} node={node} />
}

function createBrowserSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-root',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'browser',
          browserInstanceId: 'browser-1',
          url: 'https://left.example.com',
          devToolsOpen: false,
        },
      },
      {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'browser',
          browserInstanceId: 'browser-2',
          url: 'https://right.example.com',
          devToolsOpen: false,
        },
      },
    ],
  }
}

function createStore(layout: PaneNode) {
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
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
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

function createProviderDismissTrace() {
  const counts = {
    pointerdown: 0,
    scroll: 0,
    resize: 0,
    blur: 0,
  }
  const wrappedByOriginal = new WeakMap<EventListenerOrEventListenerObject, EventListener>()
  const originalDocumentAdd = document.addEventListener.bind(document)
  const originalDocumentRemove = document.removeEventListener.bind(document)
  const originalWindowAdd = window.addEventListener.bind(window)
  const originalWindowRemove = window.removeEventListener.bind(window)
  const docAddSpy = vi.spyOn(document, 'addEventListener')
  const docRemoveSpy = vi.spyOn(document, 'removeEventListener')
  const winAddSpy = vi.spyOn(window, 'addEventListener')
  const winRemoveSpy = vi.spyOn(window, 'removeEventListener')

  function wrap(type: keyof typeof counts, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return listener
    const wrapped: EventListener = (event) => {
      counts[type] += 1
      if (typeof listener === 'function') {
        listener(event)
        return
      }
      listener.handleEvent(event)
    }
    wrappedByOriginal.set(listener, wrapped)
    return wrapped
  }

  docAddSpy.mockImplementation((type, listener, options) => {
    if (type === 'pointerdown') {
      originalDocumentAdd(type, wrap('pointerdown', listener), options)
      return
    }
    originalDocumentAdd(type, listener as EventListener, options)
  })

  docRemoveSpy.mockImplementation((type, listener, options) => {
    if (type === 'pointerdown' && listener) {
      originalDocumentRemove(type, wrappedByOriginal.get(listener) ?? (listener as EventListener), options)
      return
    }
    originalDocumentRemove(type, listener as EventListener, options)
  })

  winAddSpy.mockImplementation((type, listener, options) => {
    if (type === 'scroll' || type === 'resize' || type === 'blur') {
      originalWindowAdd(type, wrap(type as keyof typeof counts, listener), options)
      return
    }
    originalWindowAdd(type, listener as EventListener, options)
  })

  winRemoveSpy.mockImplementation((type, listener, options) => {
    if ((type === 'scroll' || type === 'resize' || type === 'blur') && listener) {
      originalWindowRemove(type, wrappedByOriginal.get(listener) ?? (listener as EventListener), options)
      return
    }
    originalWindowRemove(type, listener as EventListener, options)
  })

  return {
    counts,
    cleanup() {
      docAddSpy.mockRestore()
      docRemoveSpy.mockRestore()
      winAddSpy.mockRestore()
      winRemoveSpy.mockRestore()
    },
  }
}

function renderBrowserFlow() {
  return render(
    <Provider store={createStore(createBrowserSplitLayout())}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <PaneContainerFromStore tabId="tab-1" />
      </ContextMenuProvider>
    </Provider>,
  )
}

it('keeps the pane header context menu open when right-clicking an inactive pane header', async () => {
  const user = userEvent.setup()
  const trace = createProviderDismissTrace()

  try {
    renderBrowserFlow()

    await user.pointer({ target: screen.getByText('right.example.com'), keys: '[MouseRight]' })

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(
      screen.queryByRole('menu'),
      `menu closed early; provider dismiss trace=${JSON.stringify(trace.counts)}`,
    ).toBeInTheDocument()
  } finally {
    trace.cleanup()
  }
})
```

**Step 2: Run the shared-pane regression and read the failing signal**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-flow.test.tsx --testNamePattern="pane header context menu"
```

Expected: FAIL if the shared pane-shell path reproduces the bug. Use the assertion message’s `provider dismiss trace=...` payload as the source of truth for the first dismissal path to investigate.

**Step 3: If the shared path already passes, add the terminal-body regression with the same probe**

Extend the same file with a second reproduction that mounts real `TerminalView` panes using the same xterm mocks from `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    selectAll = vi.fn()
    focus = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

function createTerminalSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-root',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'terminal',
          createRequestId: 'req-1',
          terminalId: 'term-1',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
      {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'terminal',
          createRequestId: 'req-2',
          terminalId: 'term-2',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
    ],
  }
}

function renderTerminalFlow() {
  return render(
    <Provider store={createStore(createTerminalSplitLayout())}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <PaneContainerFromStore tabId="tab-1" />
      </ContextMenuProvider>
    </Provider>,
  )
}

it('keeps the terminal body context menu open when right-clicking an inactive terminal pane', async () => {
  const user = userEvent.setup()
  const trace = createProviderDismissTrace()

  try {
    renderTerminalFlow()

    const terminalContainers = await screen.findAllByTestId('terminal-xterm-container')
    await user.pointer({ target: terminalContainers[1], keys: '[MouseRight]' })

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    expect(
      screen.queryByRole('menu'),
      `menu closed early; provider dismiss trace=${JSON.stringify(trace.counts)}`,
    ).toBeInTheDocument()
  } finally {
    trace.cleanup()
  }
})
```

Run:

```bash
npx vitest run test/e2e/pane-context-menu-flow.test.tsx
```

Expected:
- If the header test fails, treat the shared pane-shell path as the primary bug and fix that first.
- If the header test passes but the terminal-body test fails, treat the bug as terminal-specific and use that provider-trace payload to choose the fix.

**Step 4: Implement only the fix that matches the observed dismissal signal**

Use the failing test’s `provider dismiss trace=...` output to choose the production change before touching app code:

- If `pointerdown` fires on the shared pane-shell path, modify `ContextMenuProvider` to ignore only the opening secondary-click sequence or the specific opening target, not all dismissals for a frame.
- If `blur` fires on the shared pane-shell path, inspect whether pane activation or a focus transfer is producing it and fix that source before touching unrelated dismissals.
- If `blur` appears only on the terminal-body path, inspect `TerminalView`’s active-pane autofocus path and suppress only the context-menu-opening focus transfer or the matching blur it produces.
- If `scroll` or `resize` fires, track down the source of that layout change and fix or suppress only that opening-transition event.
- If the provider trace stays empty and the menu still closes, instrument the actual `closeMenu` call path next: inspect `ContextMenuProvider` cleanup/unmount effects and any non-dismiss-listener `closeMenu()` callers before editing dismissal listeners.

After the signal is known, add the narrowest possible unit coverage in `test/unit/client/components/ContextMenuProvider.test.tsx` or the relevant component test file. Examples:

- `pointerdown` fix: “opening right-click does not dismiss, but a later outside left-click still does”.
- shared `blur` fix: “pane-open transition blur does not dismiss, but a later real blur still does”.
- terminal-focus fix: “activating an inactive terminal while its menu opens does not dismiss the menu”.

Do not apply a global one-frame suppression to `pointerdown`, `scroll`, `resize`, and `blur` together.

**Step 5: Run the focused reproduction again and commit**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-flow.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS.

Commit:

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/e2e/pane-context-menu-flow.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix(context-menu): stop pane menu from reclosing"
```

### Task 2: Reorder Terminal Clipboard Actions And Add Icons

**Why:** The user asked for `copy`, `Paste`, and `Select all` to live in their own top section, and for those three items to render icons. This is a pure menu-definition change and should be driven by tests at both the data and rendered-DOM levels.

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

Extend `test/e2e/pane-context-menu-flow.test.tsx` with a rendered-menu assertion:

```tsx
import { within } from '@testing-library/react'

it('renders copy, Paste, and Select all as the first iconized section of the terminal menu', async () => {
  const user = userEvent.setup()

  renderTerminalFlow()

  const terminalContainers = await screen.findAllByTestId('terminal-xterm-container')
  await user.pointer({ target: terminalContainers[1], keys: '[MouseRight]' })

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

Expected: FAIL because the terminal menu still starts with refresh/split items, `terminal-copy` is labeled `Copy selection`, and no icons are attached.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`. Keep the file as `.ts` and use `createElement(...)` for icons:

```ts
import { createElement } from 'react'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'
```

Add a helper near the other menu helpers:

```ts
function buildTerminalClipboardItems(
  terminalActions: TerminalActions | undefined,
  hasSelection: boolean,
): MenuItem[] {
  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: createElement(Copy, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, { className: 'h-3.5 w-3.5', 'aria-hidden': true }),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Then reorder the `target.kind === 'terminal'` branch so the first section is:

```ts
...buildTerminalClipboardItems(terminalActions, hasSelection),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

and move `Refresh pane`, split items, and `Search` after that separator. Preserve the existing ids and existing actions for resume, scroll, clear, reset, and replace.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
git commit -m "feat(context-menu): reorder terminal clipboard actions"
```

### Task 3: Regression Sweep And Manual Validation

**Why:** This is a high-visibility interaction path. The focused regression lane should prove the bug fix and menu layout, and the full test suite plus one manual browser pass should catch integration issues before merge.

**Files:**
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/e2e/pane-context-menu-flow.test.tsx`

**Step 1: Run the focused regression lane**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/e2e/pane-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS. If anything fails, stop and fix it before merge or rebase work.

**Step 3: Start isolated worktree server and client processes on dedicated ports**

Run:

```bash
PORT=3344 VITE_PORT=5174 npm run dev:server > /tmp/freshell-server-3344.log 2>&1 & echo $! > /tmp/freshell-server-3344.pid
PORT=3344 VITE_PORT=5174 npm run dev:client -- --port 5174 > /tmp/freshell-client-5174.log 2>&1 & echo $! > /tmp/freshell-client-5174.pid
ps -fp "$(cat /tmp/freshell-server-3344.pid)"
ps -fp "$(cat /tmp/freshell-client-5174.pid)"
readlink -f "/proc/$(cat /tmp/freshell-server-3344.pid)/cwd"
readlink -f "/proc/$(cat /tmp/freshell-client-5174.pid)/cwd"
```

Expected:
- the server process is the worktree’s `dev:server` on port `3344`
- the client process is the worktree’s Vite dev server on port `5174`
- both cwd checks resolve into `.worktrees/trycycle-pane-context-menu-fix`
- the worktree app is reachable via the Vite URL on port `5174`

**Step 4: Manually verify the behavior**

- Right-click an inactive non-terminal pane header.
- Confirm the pane context menu stays open instead of flashing closed.
- Right-click an inactive terminal pane body.
- Confirm the menu stays open instead of flashing closed.
- Confirm the first section is `copy`, `Paste`, `Select all`.
- Confirm each of those three rows renders an icon.
- Confirm menu actions still target the clicked pane, not some other pane.

Do not treat active-pane changes on right-click as a required outcome one way or the other unless the final implementation explicitly chooses and tests that behavior.

**Step 5: Stop only that worktree server**

Run:

```bash
ps -fp "$(cat /tmp/freshell-server-3344.pid)"
ps -fp "$(cat /tmp/freshell-client-5174.pid)"
readlink -f "/proc/$(cat /tmp/freshell-server-3344.pid)/cwd"
readlink -f "/proc/$(cat /tmp/freshell-client-5174.pid)/cwd"
kill "$(cat /tmp/freshell-server-3344.pid)"
kill "$(cat /tmp/freshell-client-5174.pid)"
rm -f /tmp/freshell-server-3344.pid /tmp/freshell-client-5174.pid
```

Expected: both cwd checks confirm the processes belong to `.worktrees/trycycle-pane-context-menu-fix`, and only those recorded PIDs are terminated.

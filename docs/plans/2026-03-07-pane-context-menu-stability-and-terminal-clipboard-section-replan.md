# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open on inactive panes, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Do not assume the menu closes because pane activation changed. `ContextMenuProvider` is the code that actually dismisses menus, and it only does so from outside `pointerdown`, scroll, resize, window blur, or the explicit `view` cleanup path, so the red phase must first prove which of those closes is firing on a real custom-menu surface. Rebuild the terminal menu in `menu-defs.ts` with a dedicated clipboard section at the top, using Lucide icons via `createElement(...)` so the file stays `.ts`; for the reclose bug, characterize the early-dismiss signal on pane shell and real xterm body surfaces, then make the smallest provider-side dismissal fix that the trace supports.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket, persistence, or protocol changes.
- No `docs/index.html` update; this is localized menu polish and a regression fix, not a new user flow.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not change pane activation or terminal-focus semantics unless the traced dismissal path proves a provider-only fix cannot solve the bug.

### Task 1: Rebuild The Terminal Clipboard Section In The Menu Contract

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`

**Step 1: Write the failing tests**

Add terminal-menu contract coverage in `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('puts copy, paste, and select all in the first section with icons', () => {
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

    const copyItem = items[0]
    const pasteItem = items[1]
    const selectAllItem = items[2]
    expect(copyItem.type === 'item' ? copyItem.label : null).toBe('copy')
    expect(copyItem.type === 'item' ? copyItem.icon : null).toBeTruthy()
    expect(pasteItem.type === 'item' ? pasteItem.icon : null).toBeTruthy()
    expect(selectAllItem.type === 'item' ? selectAllItem.icon : null).toBeTruthy()
  })

  it('keeps Search outside the top clipboard section', () => {
    const items = buildMenuItems(
      { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
      makeCtx(createActions()),
    )

    const clipboardSeparatorIndex = items.findIndex((item) => item.id === 'terminal-clipboard-sep')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(clipboardSeparatorIndex).toBe(3)
    expect(searchIndex).toBeGreaterThan(clipboardSeparatorIndex)
  })
})
```

**Step 2: Run the targeted unit test and verify it fails**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts --reporter=dot
```

Expected: FAIL because the terminal menu still starts with `Refresh pane`, `terminal-copy` is labeled `Copy selection`, and the three clipboard items have no `icon`.

**Step 3: Write the minimal production change**

Update `src/components/context-menu/menu-defs.ts`:

```ts
import { createElement } from 'react'
import { ClipboardPaste, Copy, TextSelect } from 'lucide-react'

const terminalClipboardIconProps = { className: 'h-4 w-4', 'aria-hidden': true }

function buildTerminalClipboardItems(
  terminalActions: ReturnType<MenuActions['getTerminalActions']>,
  hasSelection: boolean,
): MenuItem[] {
  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: createElement(Copy, terminalClipboardIconProps),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, terminalClipboardIconProps),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, terminalClipboardIconProps),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Use that helper at the top of the `target.kind === 'terminal'` branch:

```ts
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
  { type: 'separator', id: 'terminal-tools-sep' },
  {
    type: 'item',
    id: 'terminal-search',
    label: 'Search',
    onSelect: () => terminalActions?.openSearch(),
    disabled: !terminalActions,
  },
  ...terminalResumeMenuItem,
  { type: 'separator', id: 'terminal-sep' },
  // existing scroll / clear / reset / replace items
]
```

Keep `menu-defs.ts` as `.ts`; do not introduce JSX.

**Step 4: Run the unit test and verify it passes**

Run:

```bash
npx vitest run test/unit/client/context-menu/menu-defs.test.ts --reporter=dot
```

Expected: PASS, with the new top-section order, exact `copy` label, and truthy `icon` fields locked down.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Characterize And Fix The Actual Early-Dismiss Path

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing regressions**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, add a dismiss-trace helper that wraps only the provider’s post-open dismissal listeners, then use it against a real pane-shell target:

```tsx
function createDismissTrace() {
  const counts = { pointerdown: 0, scroll: 0, resize: 0, blur: 0 }
  const wrappedByOriginal = new WeakMap<EventListenerOrEventListenerObject, EventListener>()
  const originalDocumentAdd = document.addEventListener.bind(document)
  const originalDocumentRemove = document.removeEventListener.bind(document)
  const originalWindowAdd = window.addEventListener.bind(window)
  const originalWindowRemove = window.removeEventListener.bind(window)
  const documentAddSpy = vi.spyOn(document, 'addEventListener')
  const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')
  const windowAddSpy = vi.spyOn(window, 'addEventListener')
  const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')

  function wrap(type: keyof typeof counts, listener: EventListenerOrEventListenerObject | null) {
    if (!listener) return listener
    const wrapped: EventListener = (event) => {
      counts[type] += 1
      if (typeof listener === 'function') return listener(event)
      listener.handleEvent(event)
    }
    wrappedByOriginal.set(listener, wrapped)
    return wrapped
  }

  documentAddSpy.mockImplementation((type, listener, options) => {
    if (type === 'pointerdown') {
      originalDocumentAdd(type, wrap('pointerdown', listener), options)
      return
    }
    originalDocumentAdd(type, listener as EventListener, options)
  })

  documentRemoveSpy.mockImplementation((type, listener, options) => {
    if (type === 'pointerdown' && listener) {
      originalDocumentRemove(type, wrappedByOriginal.get(listener) ?? (listener as EventListener), options)
      return
    }
    originalDocumentRemove(type, listener as EventListener, options)
  })

  windowAddSpy.mockImplementation((type, listener, options) => {
    if (type === 'scroll' || type === 'resize' || type === 'blur') {
      originalWindowAdd(type, wrap(type as keyof typeof counts, listener), options)
      return
    }
    originalWindowAdd(type, listener as EventListener, options)
  })

  windowRemoveSpy.mockImplementation((type, listener, options) => {
    if ((type === 'scroll' || type === 'resize' || type === 'blur') && listener) {
      originalWindowRemove(type, wrappedByOriginal.get(listener) ?? (listener as EventListener), options)
      return
    }
    originalWindowRemove(type, listener as EventListener, options)
  })

  return {
    counts,
    restore() {
      documentAddSpy.mockRestore()
      documentRemoveSpy.mockRestore()
      windowAddSpy.mockRestore()
      windowRemoveSpy.mockRestore()
    },
  }
}

it('keeps the pane menu open when right-clicking an inactive pane shell', async () => {
  const user = userEvent.setup()
  const trace = createDismissTrace()

  try {
    const { container } = renderSplitBrowserPaneLayout()
    const paneShells = container.querySelectorAll('[data-context="pane"]')
    await user.pointer({ target: paneShells[1] as HTMLElement, keys: '[MouseRight]' })

    await waitFor(() => {
      expect(
        screen.queryByRole('menu'),
        `menu closed early; dismiss trace=${JSON.stringify(trace.counts)}`,
      ).toBeInTheDocument()
    })
  } finally {
    trace.restore()
  }
})
```

This trace is only for callbacks registered after the menu opens. It is not meant to observe the opening secondary click itself; it is meant to tell you which provider dismiss path fired before the menu disappeared.

In `test/e2e/refresh-context-menu-flow.test.tsx`, add a real `PaneLayout` regression for the actual terminal body, not the outer terminal wrapper:

```tsx
it('keeps the terminal menu open when right-clicking an inactive terminal surface', async () => {
  const layout: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
  const store = createStore(layout)
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  await waitFor(() => {
    expect(container.querySelectorAll('[data-testid="terminal-xterm-container"]')).toHaveLength(2)
  })

  const terminalSurface = container.querySelector(
    '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-container"]',
  ) as HTMLElement
  expect(terminalSurface).not.toBeNull()

  await user.pointer({ target: terminalSurface, keys: '[MouseRight]' })

  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
```

These tests should assert the user-visible contract only: the custom menu stays open long enough to interact with it. Do not assert whether right-click changes the active pane or which downstream focus effects occurred; the trace should tell you which provider dismiss path fired.

**Step 2: Run the targeted regressions and verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: FAIL on at least one of the two new tests, ideally with a failing message that shows a non-zero dismiss trace for `pointerdown`, `scroll`, `resize`, or `blur`. If both tests stay green, stop and manually reproduce in the worktree before any production edit; do not ship a guess.

**Step 3: Write the minimal production fix**

Update `src/components/context-menu/ContextMenuProvider.tsx` based on the traced dismiss path, keeping the fix local to the actual closer:

```tsx
const menuOpenedAtRef = useRef(0)

const openedRecently = () => performance.now() - menuOpenedAtRef.current < 32

const openMenu = useCallback((state: MenuState) => {
  previousFocusRef.current = document.activeElement as HTMLElement | null
  menuOpenedAtRef.current = performance.now()
  setMenuState(state)
}, [])
```

Use that stamp only on the dismiss hook the trace proves is firing too early. For example:

```tsx
const handlePointerDown = (event: MouseEvent) => {
  const target = event.target as Node
  if (menuRef.current?.contains(target)) return
  if (openedRecently()) return
  closeMenu()
}

const handleScroll = () => {
  if (openedRecently()) return
  closeMenu()
}

const handleResize = () => {
  if (openedRecently()) return
  closeMenu()
}

const handleBlur = () => {
  requestAnimationFrame(() => {
    if (openedRecently()) return
    if (!document.hasFocus()) closeMenu()
  })
}
```

If the pane-shell test closes with all dismiss counters still at zero, treat the `view` cleanup effect as the next suspect and replace the cleanup-only close with an explicit view-change comparison:

```tsx
const previousViewRef = useRef(view)

useEffect(() => {
  if (menuState && previousViewRef.current !== view) {
    closeMenu()
  }
  previousViewRef.current = view
}, [view, menuState, closeMenu])
```

Do not start by changing `Pane.tsx` or `TerminalView.tsx`. If the dismiss trace points somewhere else after the provider guard, update the plan again instead of silently shipping a behavior change the tests did not prove.

**Step 4: Run the regression pack and verify it passes**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: PASS, with right-click on inactive pane shell and the real xterm body leaving the menu open.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "fix: stabilize pane context menu dismissal"
```

### Task 3: Run The Full Verification Gate And Manual Spot-Check

**Files:**
- None

**Step 1: Run the focused regression suite together**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  --reporter=dot
```

Expected: PASS. This is the fast confidence gate before slower repo-wide verification.

**Step 2: Run lint on the touched UI code**

Run:

```bash
npm run lint
```

Expected: PASS with no new JSX a11y or TypeScript lint failures from the menu icon markup or the provider dismissal guard.

**Step 3: Run the full required test suite**

Run:

```bash
npm test
```

Expected: PASS for both the client Vitest run and the server Vitest run. Do not proceed to any merge/integration step if this fails.

**Step 4: Manually validate in the worktree on non-default ports**

Do not use `npm run dev` or `npm run dev:server` here; those scripts hardcode `PORT=3002`. Start worktree-only processes explicitly:

```bash
PORT=3344 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=5174 npm run dev:client > /tmp/freshell-5174-client.log 2>&1 & echo $! > /tmp/freshell-5174-client.pid
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
readlink -f "/proc/$(cat /tmp/freshell-3344-server.pid)/cwd"
ps -fp "$(cat /tmp/freshell-5174-client.pid)"
readlink -f "/proc/$(cat /tmp/freshell-5174-client.pid)/cwd"
```

Open `http://127.0.0.1:5174` and verify all of the following:

- Right-clicking an inactive terminal pane header or pane shell leaves the custom menu open.
- Right-clicking inside the actual inactive terminal text area leaves the custom menu open.
- The first section of the terminal menu is `copy`, `Paste`, `Select all`, each with an icon.
- The rest of the terminal menu still exposes refresh, split, search, scroll, clear, reset, and replace actions.

**Step 5: Stop the worktree-only processes cleanly**

Run:

```bash
kill "$(cat /tmp/freshell-5174-client.pid)"
rm -f /tmp/freshell-5174-client.pid
kill "$(cat /tmp/freshell-3344-server.pid)"
rm -f /tmp/freshell-3344-server.pid
```

Expected: both recorded worktree processes exit cleanly, with no broad kill pattern and no impact on the main-branch server that owns this session.

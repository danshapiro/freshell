# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep the pane right-click menu from immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into their own iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat this as two separate contracts. The clipboard-section change is pure menu-definition work, so lock it down in `menu-defs.ts` with direct unit coverage plus one rendered DOM smoke. The reclose bug should be attacked on the narrowest real route the user described: right-clicking an inactive terminal pane shell. The current code already gives one concrete suspect for that route, `Pane`'s unconditional `onMouseDown={onFocus}`. Prove that route red first, prove the secondary-button seam red second, fix `Pane` minimally, then extend the same regression file to the inactive terminal body because that route bubbles through the same pane shell. Only if terminal-body coverage still fails after the `Pane` fix should execution widen into `TerminalView`.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, Vite dev server, xterm.js mocks

---

## Strategy Gate

- The user asked for one behavior fix and one menu-organization change, not a broader context-menu rewrite. Stay inside the existing custom menu system.
- Do not treat "right-click must never activate a pane" as a product requirement. The user-visible contract is only that the menu stays open long enough to use. The seam-level `Pane` guard is justified here because current code indiscriminately fires `onFocus` for button `2`, and that is the most direct, repo-grounded explanation for an inactive-pane right-click race.
- Start from one concrete red route, not a broad exploratory matrix. The primary red contract is: inactive terminal pane shell -> right click -> menu remains open after the first post-open settle window.
- Browser-pane shell coverage is not a primary automated requirement for this change. It uses the same `Pane` shell, so a manual sanity check is enough once the terminal-pane route is fixed. That keeps the plan aligned with the user request instead of over-expanding the surface area.
- `ContextMenuProvider`'s post-open `pointerdown` listener is not the opening-click bug unless a failing regression proves otherwise. Do not start there.
- The repo currently contains two `menu-defs` unit files. For this change, treat `test/unit/client/context-menu/menu-defs.test.ts` as the authoritative harness because it already exercises the current `MenuActions` surface and is the file with the stale `copyFreshclaude*` mocks. Leave `test/unit/client/components/context-menu/menu-defs.test.ts` untouched unless execution reveals an unrelated failure there.
- The accepted medium strategy requires one real browser spot-check after automated tests. That is mandatory, not optional.

## Scope Guards

- No server, WebSocket protocol, persistence, or data-model changes.
- No `docs/index.html` update; this is localized menu behavior plus menu-item polish.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Keep `ContextMenu` as the renderer. The icon change belongs in `src/components/context-menu/menu-defs.ts`, not in a renderer rewrite.
- The terminal-body regression must right-click a child appended inside `data-testid="terminal-xterm-container"` by the test xterm mock. Right-clicking only the wrapper div does not count as terminal-body coverage.

### Task 1: Lock Down The Terminal Clipboard Section

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Repair the authoritative `menu-defs` test harness and add failing clipboard-section assertions**

In `test/unit/client/context-menu/menu-defs.test.ts`, rename the stale `copyFreshclaude*` mocks in `createActions()` to the current `copyAgentChat*` names so the harness matches `MenuActions`.

Then add these helpers near `makeCtx(...)`:

```ts
function getTerminalItem(items: ReturnType<typeof buildMenuItems>, id: string) {
  const item = items.find((candidate) => candidate.type === 'item' && candidate.id === id)
  expect(item?.type).toBe('item')
  if (!item || item.type !== 'item') {
    throw new Error(`Missing terminal menu item: ${id}`)
  }
  return item
}

function createTerminalMenuHarness(options?: { hasSelection?: boolean; withActions?: boolean }) {
  const terminalActions = options?.withActions === false
    ? undefined
    : {
        copySelection: vi.fn(),
        paste: vi.fn(),
        selectAll: vi.fn(),
        clearScrollback: vi.fn(),
        reset: vi.fn(),
        scrollToBottom: vi.fn(),
        hasSelection: vi.fn(() => options?.hasSelection ?? false),
        openSearch: vi.fn(),
      }

  const actions = createActions()
  actions.getTerminalActions = vi.fn(() => terminalActions)

  const items = buildMenuItems(
    { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' },
    makeCtx(actions),
  )

  return { items, terminalActions }
}
```

Add these failing tests:

```ts
describe('buildMenuItems - terminal clipboard section', () => {
  it('places copy, Paste, and Select all in the first section with icons and keeps Search later', () => {
    const { items } = createTerminalMenuHarness()

    expect(
      items.slice(0, 4).map((item) => item.type === 'item' ? item.id : item.type),
    ).toEqual([
      'terminal-copy',
      'terminal-paste',
      'terminal-select-all',
      'separator',
    ])

    const copyItem = getTerminalItem(items, 'terminal-copy')
    const pasteItem = getTerminalItem(items, 'terminal-paste')
    const selectAllItem = getTerminalItem(items, 'terminal-select-all')
    const searchIndex = items.findIndex((item) => item.type === 'item' && item.id === 'terminal-search')

    expect(copyItem.label).toBe('copy')
    expect(copyItem.icon).toBeTruthy()
    expect(pasteItem.icon).toBeTruthy()
    expect(selectAllItem.icon).toBeTruthy()
    expect(searchIndex).toBeGreaterThan(3)
  })

  it('keeps copy wired to selection state and copySelection()', () => {
    const withoutSelection = createTerminalMenuHarness({ hasSelection: false })
    expect(getTerminalItem(withoutSelection.items, 'terminal-copy').disabled).toBe(true)

    const withSelection = createTerminalMenuHarness({ hasSelection: true })
    const copyItem = getTerminalItem(withSelection.items, 'terminal-copy')

    expect(copyItem.disabled).toBe(false)
    copyItem.onSelect()
    expect(withSelection.terminalActions?.copySelection).toHaveBeenCalledTimes(1)
  })

  it('keeps Paste and Select all wired to terminal action availability', () => {
    const unavailable = createTerminalMenuHarness({ withActions: false })
    expect(getTerminalItem(unavailable.items, 'terminal-paste').disabled).toBe(true)
    expect(getTerminalItem(unavailable.items, 'terminal-select-all').disabled).toBe(true)

    const available = createTerminalMenuHarness()
    const pasteItem = getTerminalItem(available.items, 'terminal-paste')
    const selectAllItem = getTerminalItem(available.items, 'terminal-select-all')

    expect(pasteItem.disabled).toBe(false)
    expect(selectAllItem.disabled).toBe(false)

    pasteItem.onSelect()
    selectAllItem.onSelect()

    expect(available.terminalActions?.paste).toHaveBeenCalledTimes(1)
    expect(available.terminalActions?.selectAll).toHaveBeenCalledTimes(1)
  })
})
```

**Step 2: Add one rendered-DOM smoke for the visible terminal menu**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, move `createStoreWithTerminalPane()` out of the nested `describe('Replace pane')` block so it can be reused here.

Then add:

```tsx
it('renders copy, Paste, and Select all as the first terminal menu section with icons', async () => {
  const user = userEvent.setup()
  const store = createStoreWithTerminalPane()

  render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
          Terminal Content
        </div>
      </ContextMenuProvider>
    </Provider>
  )

  await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })

  const menu = screen.getByRole('menu')
  const children = Array.from(menu.children)

  expect(
    children.slice(0, 4).map((node) => (
      node.getAttribute('role') === 'menuitem'
        ? node.textContent?.replace(/\s+/g, ' ').trim()
        : node.getAttribute('role')
    )),
  ).toEqual(['copy', 'Paste', 'Select all', 'separator'])

  for (const node of children.slice(0, 3)) {
    expect(node.querySelector('svg')).not.toBeNull()
  }
})
```

Keep behavior assertions in `menu-defs.test.ts`; this test is just the rendered smoke.

**Step 3: Run the clipboard tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: FAIL on ordering, icon presence, and the `copy` label.

**Step 4: Implement the minimal menu-definition change**

Update `src/components/context-menu/menu-defs.ts`:

- Import `createElement` from `react`.
- Import `Copy`, `ClipboardPaste`, and `TextSelect` from `lucide-react`.
- Add a helper that defines the clipboard items once and places them at the very top of the terminal menu.
- Label `terminal-copy` exactly `copy`.
- Keep `terminal-search` below the clipboard section.
- Preserve current action wiring and disabled rules.

Use this helper shape:

```ts
function buildTerminalClipboardItems(terminalActions: TerminalActions | undefined): MenuItem[] {
  const hasSelection = terminalActions?.hasSelection() ?? false

  return [
    {
      type: 'item',
      id: 'terminal-copy',
      label: 'copy',
      icon: createElement(Copy, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.copySelection(),
      disabled: !terminalActions || !hasSelection,
    },
    {
      type: 'item',
      id: 'terminal-paste',
      label: 'Paste',
      icon: createElement(ClipboardPaste, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.paste(),
      disabled: !terminalActions,
    },
    {
      type: 'item',
      id: 'terminal-select-all',
      label: 'Select all',
      icon: createElement(TextSelect, { className: 'h-4 w-4' }),
      onSelect: () => terminalActions?.selectAll(),
      disabled: !terminalActions,
    },
  ]
}
```

Then insert:

```ts
...buildTerminalClipboardItems(terminalActions),
{ type: 'separator', id: 'terminal-clipboard-sep' },
```

immediately before the existing refresh/split/search/scroll/reset items.

**Step 5: Re-run the clipboard tests and verify they pass**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: group terminal clipboard actions at top"
```

### Task 2: Reproduce The Reclose Bug On Inactive Terminal Pane Routes

**Files:**
- Create: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Create a dedicated e2e harness for inactive terminal pane routes**

Create `test/e2e/pane-context-menu-stability.test.tsx`. Reuse the `createStore(...)` and `renderFlow(...)` shape from `test/e2e/refresh-context-menu-flow.test.tsx`, but keep this file focused on context-menu stability only.

At the top of the file, add a local xterm mock that appends a child surface into the real `terminal-xterm-container` so the terminal-body route exercises a descendant, not the wrapper:

```tsx
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    openedSurface: HTMLElement | null = null
    focus = vi.fn()
    open = vi.fn((element: HTMLElement) => {
      const surface = document.createElement('div')
      surface.setAttribute('data-testid', 'terminal-xterm-surface')
      surface.tabIndex = -1
      element.appendChild(surface)
      this.openedSurface = surface
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn(() => {
      this.openedSurface?.remove()
      this.openedSurface = null
    })
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    paste = vi.fn()
    reset = vi.fn()
    selectAll = vi.fn()
    scrollLines = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    scrollToBottom = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
```

Add the same `MockResizeObserver` pattern used by the existing terminal e2e tests, plus:

```tsx
function createTerminalLeaf(id: string, terminalId: string): Extract<PaneNode, { type: 'leaf' }> {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      terminalId,
      createRequestId: `req-${terminalId}`,
      status: 'running',
      mode: 'shell',
      shell: 'system',
    },
  }
}

function createTerminalSplitLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-terminal',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
}

async function waitForMenuToSettle() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
```

**Step 2: Add two user-facing regressions in that file**

Add:

```tsx
it('keeps the pane menu open when right-clicking an inactive terminal pane shell', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')

  const paneShell = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"]',
  ) as HTMLElement | null
  expect(paneShell).not.toBeNull()

  await user.pointer({ target: paneShell as HTMLElement, keys: '[MouseRight]' })
  await waitForMenuToSettle()

  expect(screen.getByRole('menu')).toBeInTheDocument()
})

it('keeps the terminal menu open when right-clicking an inactive terminal body', async () => {
  const store = createStore(createTerminalSplitLayout())
  const user = userEvent.setup()
  const { container } = renderFlow(store)

  expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')

  const terminalSurface = await waitFor(() => {
    const node = container.querySelector(
      '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-surface"]',
    ) as HTMLElement | null
    expect(node).not.toBeNull()
    return node as HTMLElement
  })

  await user.pointer({ target: terminalSurface, keys: '[MouseRight]' })
  await waitForMenuToSettle()

  expect(screen.getByRole('menu')).toBeInTheDocument()
})
```

These are the only route-level contracts needed in automation for this bug.

**Step 3: Run the new stability file and verify the shell route is red on current code**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: FAIL at least on the inactive terminal pane-shell route. The terminal-body route may fail too, but it is not required to be the first red.

### Task 3: Prove And Fix The Shared Secondary-Button Pane Seam

**Files:**
- Modify: `test/unit/client/components/panes/Pane.test.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Re-run: `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: Add a focused failing seam regression to `Pane.test.tsx`**

Add:

```tsx
it('does not call onFocus on secondary-button mouse down', () => {
  const onFocus = vi.fn()

  const { container } = render(
    <Pane
      tabId="t1"
      paneId="p1"
      isActive={false}
      isOnlyPane={false}
      onClose={vi.fn()}
      onFocus={onFocus}
    >
      <div>Content</div>
    </Pane>
  )

  fireEvent.mouseDown(container.firstChild as HTMLElement, { button: 2 })

  expect(onFocus).not.toHaveBeenCalled()
})
```

Keep the existing primary-button focus test unchanged.

**Step 2: Run the seam test plus the new route file and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: FAIL on the new secondary-button seam test and on the inactive terminal pane-shell route.

**Step 3: Implement the smallest justified production fix in `Pane.tsx`**

Replace the unconditional pane focus hook with a primary-button-only handler:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

Do not touch keyboard focus handling. Do not add any menu-specific state to `Pane`.

**Step 4: Re-run the seam and route tests**

Run:

```bash
npx vitest run \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS for the secondary-button seam test and for the inactive terminal pane-shell route. The terminal-body route should also pass because it bubbles through the same pane shell; if it does, continue immediately to commit.

**Step 5: Commit**

```bash
git add src/components/panes/Pane.tsx test/unit/client/components/panes/Pane.test.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: keep inactive pane menus open"
```

### Task 4: Only If Needed, Add The Narrow Terminal-Body Follow-Up

**Files:**
- Modify only if the Task 3 rerun still shows a terminal-body failure:
  - `src/components/TerminalView.tsx`
  - `test/e2e/pane-context-menu-stability.test.tsx`

**Step 1: If Task 3 is already green, skip this task entirely**

The plan’s intended mainline is that the `Pane` secondary-button fix clears both terminal routes. Do not widen the fix surface if the current tests are already green.

**Step 2: If the inactive terminal body test is still red after the `Pane` fix, add one diagnostic assertion inside the same e2e file before touching production code**

Extend the local xterm mock to keep `focus` as a `vi.fn()`, then in the terminal-body test capture its call count before and after the right click. If the menu closes and the terminal `focus()` call count increases during the settle window, treat `TerminalView`'s auto-focus effect as the remaining cause.

**Step 3: Add the smallest local guard in `TerminalView.tsx` only for that proved case**

If Step 2 proves the post-activation auto-focus is what stomps the menu, add a tiny context-menu suppression ref inside `TerminalView.tsx`:

```ts
const suppressAutoFocusRef = useRef(false)
```

Mark it from the terminal root:

```tsx
onContextMenuCapture={() => {
  suppressAutoFocusRef.current = true
  requestAnimationFrame(() => {
    suppressAutoFocusRef.current = false
  })
}}
```

And guard the active-terminal focus effect:

```ts
requestAnimationFrame(() => {
  if (termRef.current !== term) return
  if (suppressAutoFocusRef.current) return
  term.focus()
})
```

Do not touch `ContextMenuProvider` in this follow-up unless the diagnostic disproves the `TerminalView` focus path.

**Step 4: Re-run the stability file**

Run:

```bash
npx vitest run test/e2e/pane-context-menu-stability.test.tsx --reporter=dot
```

Expected: PASS.

**Step 5: Commit the follow-up only if this task ran**

```bash
git add src/components/TerminalView.tsx test/e2e/pane-context-menu-stability.test.tsx
git commit -m "fix: avoid terminal refocus during context menu open"
```

### Task 5: Run The Full Verification Gate

**Files:**
- None

**Step 1: Run the focused regression pack**

Run:

```bash
npx vitest run \
  test/unit/client/context-menu/menu-defs.test.ts \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/panes/Pane.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx \
  --reporter=dot
```

Expected: PASS.

**Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

**Step 3: Run the repo typecheck plus test gate**

Run:

```bash
npm run check
```

Expected: PASS.

**Step 4: Run the build-inclusive gate from the worktree**

Run:

```bash
npm run verify
```

Expected: PASS.

### Task 6: Run The Required Browser Spot-Check

**Files:**
- None

**Step 1: Start the worktree app on isolated ports**

Do not use `npm run dev` or `npm run dev:server` with a custom backend port; both scripts hardcode `PORT=3002`. Start the worktree app with commands that actually honor `PORT` and `VITE_PORT`:

```bash
PORT=3344 VITE_PORT=3345 npx tsx watch server/index.ts > /tmp/freshell-3344-server.log 2>&1 & echo $! > /tmp/freshell-3344-server.pid
PORT=3344 VITE_PORT=3345 npm run dev:client -- --host 127.0.0.1 > /tmp/freshell-3345-client.log 2>&1 & echo $! > /tmp/freshell-3345-client.pid
```

**Step 2: Verify both PIDs belong to this worktree**

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
```

Confirm the command paths point at `/home/user/code/freshell/.worktrees/trycycle-pane-context-menu-fix`.

**Step 3: Open `http://127.0.0.1:3345` and check the real UX**

1. Create or use a split tab with two terminal panes.
2. Right-click the inactive terminal pane shell or header and confirm the menu stays open instead of flashing closed.
3. Right-click inside the inactive terminal body and confirm that menu also stays open.
4. In the terminal menu, confirm the first section is `copy`, `Paste`, `Select all`, in that order, with an icon on each item.
5. As a shared-shell sanity check, right-click an inactive browser pane shell once and confirm it also stays open.

If browser access is blocked in this environment, do not silently skip this step. Record the blocker explicitly in the execution report.

**Step 4: Stop only those verified worktree processes**

```bash
ps -fp "$(cat /tmp/freshell-3344-server.pid)"
ps -fp "$(cat /tmp/freshell-3345-client.pid)"
kill "$(cat /tmp/freshell-3344-server.pid)"
kill "$(cat /tmp/freshell-3345-client.pid)"
rm -f /tmp/freshell-3344-server.pid /tmp/freshell-3345-client.pid
```

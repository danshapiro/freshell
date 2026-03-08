# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open on inactive panes, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Treat the reclose bug as a pane-activation race, not as a context-menu rewrite. `Pane` currently calls `onFocus` on every mouse-down, so a secondary click on an inactive pane mutates active-pane state while the custom menu is opening; the clean steady-state fix is to limit mouse activation to the primary button and leave keyboard activation unchanged. Rebuild the terminal menu in `menu-defs.ts` with a dedicated clipboard section at the top, using Lucide icons via `createElement(...)` so the file stays `.ts`, and lock both behaviors down with unit + integration coverage before touching production code.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket, persistence, or protocol changes.
- No `docs/index.html` update; this is localized menu polish and a regression fix, not a new user flow.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not add a new "right click activates pane" rule elsewhere; the fix should remove secondary-click activation churn, not relocate it.

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

### Task 2: Regress The Inactive-Pane Right-Click Close On Real Menu Surfaces

**Files:**
- Modify: `src/components/panes/Pane.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing regressions**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, add a provider-level harness that reproduces the state churn without extra layout machinery:

```tsx
function PaneShellHarness() {
  const [activePaneId, setActivePaneId] = useState('pane-1')

  return (
    <div className="grid grid-cols-2 gap-2">
      {['pane-1', 'pane-2'].map((paneId) => (
        <Pane
          key={paneId}
          tabId="tab-1"
          paneId={paneId}
          isActive={activePaneId === paneId}
          isOnlyPane={false}
          title={paneId === 'pane-1' ? 'Left' : 'Right'}
          content={{ kind: 'browser', browserInstanceId: paneId, url: 'https://example.com', devToolsOpen: false }}
          onClose={() => {}}
          onFocus={() => setActivePaneId(paneId)}
        >
          <div>{paneId}</div>
        </Pane>
      ))}
    </div>
  )
}

it('keeps the pane menu open when right-clicking an inactive pane shell', async () => {
  const user = userEvent.setup()
  renderWithProvider(<PaneShellHarness />)

  const paneShells = screen.getAllByRole('group', { name: /Pane:/ })
  await user.pointer({ target: paneShells[1], keys: '[MouseRight]' })

  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
```

In `test/e2e/refresh-context-menu-flow.test.tsx`, add a real `PaneLayout` regression for terminal content:

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
    expect(
      wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-2'),
    ).toBe(true)
  })

  const terminalSurface = container.querySelector('[data-context="terminal"][data-pane-id="pane-2"]') as HTMLElement
  expect(terminalSurface).not.toBeNull()

  await user.pointer({ target: terminalSurface, keys: '[MouseRight]' })

  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
})
```

These tests should assert the user-visible contract only: the custom menu stays open long enough to interact with it. Do not assert whether right-click changes the active pane.

**Step 2: Run the targeted regressions and verify they fail**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: FAIL on at least one of the two new tests because right-clicking an inactive pane surface still triggers pane activation churn before the menu can settle.

**Step 3: Write the minimal production fix**

Update `src/components/panes/Pane.tsx` so only the primary mouse button activates the pane:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

Leave the existing keyboard activation logic alone:

```tsx
onKeyDown={(e) => {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onFocus()
  }
}}
```

Do not move this behavior into `ContextMenuProvider`; the bug originates in pane activation, and the fix should stay at that seam unless the new regressions prove otherwise.

**Step 4: Run the regression pack and verify it passes**

Run:

```bash
npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --reporter=dot
```

Expected: PASS, with right-click on inactive pane shell and inactive terminal body leaving the menu open.

**Step 5: Commit**

```bash
git add src/components/panes/Pane.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "fix: keep pane context menus open on right click"
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

Expected: PASS with no new JSX a11y or TypeScript lint failures from the menu icon markup or `Pane` mouse handler.

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
- Right-clicking inside an inactive terminal body leaves the custom menu open.
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

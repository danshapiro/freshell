# Pane Context Menu Stability And Terminal Clipboard Section Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Keep pane right-click menus open instead of immediately reclosing, and move terminal `copy` / `Paste` / `Select all` into an iconized top section with `copy` labeled exactly `copy`.

**Architecture:** Do not hard-anchor the bug in either `ContextMenuProvider` or pane activation, and do not narrow it to inactive panes. There are at least three distinct custom-menu paths here: generic pane shell, terminal pane header/shell, and the real xterm body, and each needs coverage on both already-active and inactive panes because that boundary was part of the accepted medium strategy. Rebuild the terminal menu in `menu-defs.ts` with a dedicated clipboard section at the top using Lucide icons via `createElement(...)`; for the reclose bug, first land a user-visible route matrix in the existing e2e harness, then use unit-level provider and terminal-focus traces only to explain whichever active or inactive route actually fails, so the final fix can land in `ContextMenuProvider.tsx`, `Pane.tsx`, `TerminalView.tsx`, or a minimal combination, depending on what the red tests prove.

**Tech Stack:** React 18, TypeScript, Redux Toolkit, lucide-react, Vitest, Testing Library, xterm.js test harnesses

---

## Scope Guards

- No server, WebSocket, persistence, or protocol changes.
- No `docs/index.html` update; this is localized menu polish and a regression fix, not a new user flow.
- Preserve existing terminal action ids: `terminal-copy`, `terminal-paste`, `terminal-select-all`, `terminal-search`.
- Do not constrain the fix to provider-side dismissal or to pane activation ahead of time; choose the smallest fix the failing traces justify on the failing surface.

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

### Task 2: Lock Down Active And Inactive Routes, Then Fix The Proven Cause

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Create: `test/unit/client/components/terminal-pane-context-menu-focus.test.tsx`
- Test: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing regressions**

In `test/e2e/refresh-context-menu-flow.test.tsx`, make the user-visible route matrix the primary regression harness. Reuse the existing `PaneLayout` helpers and add one shared assertion helper that right-clicks a target, waits two animation frames, and proves the menu is still present:

```tsx
async function expectMenuStaysOpenAfterRightClick(target: HTMLElement) {
  const user = userEvent.setup()
  await user.pointer({ target, keys: '[MouseRight]' })
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  expect(screen.queryByRole('menu')).toBeInTheDocument()
}
```

Add the active/inactive boundary cases the accepted medium strategy required:

```tsx
it('keeps the browser pane-shell menu open when right-clicking the already-active pane shell', async () => {
  const { container } = renderFlow(createStore(createTwoBrowserPaneLayout()))
  const activeShell = container.querySelector('[data-context="pane"][data-pane-id="pane-1"]') as HTMLElement
  expect(activeShell).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(activeShell)
})

it('keeps the browser pane-shell menu open when right-clicking an inactive pane shell', async () => {
  const { container } = renderFlow(createStore(createTwoBrowserPaneLayout()))
  const inactiveShell = container.querySelector('[data-context="pane"][data-pane-id="pane-2"]') as HTMLElement
  expect(inactiveShell).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(inactiveShell)
})

it('keeps the terminal pane-shell menu open when right-clicking the already-active terminal header', async () => {
  const { container } = renderFlow(createStore(createTwoTerminalPaneLayout()))
  const activeHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-1"] [role="banner"]',
  ) as HTMLElement
  expect(activeHeader).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(activeHeader)
})

it('keeps the terminal pane-shell menu open when right-clicking an inactive terminal header', async () => {
  const { container } = renderFlow(createStore(createTwoTerminalPaneLayout()))
  const inactiveHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
  ) as HTMLElement
  expect(inactiveHeader).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(inactiveHeader)
})

it('keeps the terminal menu open when right-clicking the already-active terminal body', async () => {
  const { container } = renderFlow(createStore(createTwoTerminalPaneLayout()))
  await waitFor(() => {
    expect(container.querySelectorAll('[data-testid="terminal-xterm-container"]')).toHaveLength(2)
  })
  const activeBody = container.querySelector(
    '[data-context="terminal"][data-pane-id="pane-1"] [data-testid="terminal-xterm-container"]',
  ) as HTMLElement
  expect(activeBody).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(activeBody)
})

it('keeps the terminal menu open when right-clicking an inactive terminal body', async () => {
  const { container } = renderFlow(createStore(createTwoTerminalPaneLayout()))
  await waitFor(() => {
    expect(container.querySelectorAll('[data-testid="terminal-xterm-container"]')).toHaveLength(2)
  })
  const inactiveBody = container.querySelector(
    '[data-context="terminal"][data-pane-id="pane-2"] [data-testid="terminal-xterm-container"]',
  ) as HTMLElement
  expect(inactiveBody).not.toBeNull()

  await expectMenuStaysOpenAfterRightClick(inactiveBody)
})
```

Do not introduce a new partial `@xterm/xterm` mock into this e2e file. Keep the existing integration fidelity here and use unit tests for diagnosis only.

In `test/unit/client/components/ContextMenuProvider.test.tsx`, keep a provider-dismiss trace as instrumentation, not as the primary proof. It should cover one pane-shell route and include dismiss counters in the failure message so you can tell whether a provider callback fired on the failing path:

```tsx
it('keeps the pane menu open when right-clicking a pane shell (provider dismiss trace)', async () => {
  const user = userEvent.setup()
  const trace = createDismissTrace()

  try {
    const { container } = renderSplitBrowserPaneLayout()
    const paneShell = container.querySelector('[data-context="pane"][data-pane-id="pane-2"]') as HTMLElement
    await user.pointer({ target: paneShell, keys: '[MouseRight]' })

    expect(
      screen.queryByRole('menu'),
      `menu closed early; dismiss trace=${JSON.stringify(trace.counts)}`,
    ).toBeInTheDocument()
  } finally {
    trace.restore()
  }
})
```

Create `test/unit/client/components/terminal-pane-context-menu-focus.test.tsx` as a focused terminal diagnostic harness using the same `@xterm/xterm` mock shape already used in `TerminalView.lifecycle.test.tsx`. Render a split two-terminal `PaneLayout` under `ContextMenuProvider`, right-click the active and inactive terminal headers, and include focus-count deltas in the failure messages. The inactive-header case below is the minimum diagnostic; mirror it for the already-active header if that is the failing e2e route:

```tsx
it('does not refocus the inactive terminal while its context menu is opening', async () => {
  const user = userEvent.setup()
  const { container } = renderTerminalPaneContextHarness()
  await waitFor(() => {
    expect(terminalInstances).toHaveLength(2)
  })

  const inactiveHeader = container.querySelector(
    '[data-context="pane"][data-pane-id="pane-2"] [role="banner"]',
  ) as HTMLElement
  const baselineFocusCalls = terminalInstances[1].focus.mock.calls.length

  await user.pointer({ target: inactiveHeader, keys: '[MouseRight]' })
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(
    screen.queryByRole('menu'),
    `menu closed early; terminalFocusDelta=${terminalInstances[1].focus.mock.calls.length - baselineFocusCalls}`,
  ).toBeInTheDocument()
})
```

This unit file is diagnostic coverage for the terminal header/shell path only. It must not replace the user-visible e2e route matrix.

**Step 2: Run the targeted regressions and verify they fail**

Run:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/terminal-pane-context-menu-focus.test.tsx \
  --reporter=dot
```

Expected: FAIL on at least one user-visible route in the e2e matrix. Use the unit traces to explain why:

- Non-zero dismiss counters on the matching provider trace: a provider dismissal path is firing too early.
- Terminal header/shell failure with `terminalFocusDelta > 0`: pane activation / terminal refocus is the leading suspect.
- Both signals present: fix the earliest proven cause first, rerun, and only layer a second fix if a red test remains.

If the full route matrix stays green:

1. Start the worktree server/client on isolated ports and reproduce the bug manually on both already-active and inactive pane routes.
2. Identify the exact failing subtarget: browser shell, terminal header/shell, or terminal body.
3. Add a new automated regression for that exact route before any production edit.
4. Prefer extending `test/e2e/refresh-context-menu-flow.test.tsx` if the exact route reproduces there once targeted precisely.
5. If the route depends on terminal focus timing that only appears in a controlled xterm mock, codify that trigger as a red unit test in `test/unit/client/components/terminal-pane-context-menu-focus.test.tsx`, then keep the matching e2e route in the matrix as the user-visible guard even if it remains green.
6. Re-run until at least one automated test is red. Do not edit production code before that.

**Step 3: Write the minimal production fix**

Change only the code the red tests justify:

- If a provider dismiss callback is the first proven cause, patch `src/components/context-menu/ContextMenuProvider.tsx` on that path only.
  Example: if `view` cleanup fires, replace cleanup-only close with explicit view-change comparison:

```tsx
const previousViewRef = useRef(view)

useEffect(() => {
  if (menuState && previousViewRef.current !== view) {
    closeMenu()
  }
  previousViewRef.current = view
}, [view, menuState, closeMenu])
```

  Example: if `blur` fires, re-check focus on the next animation frame before closing:

```tsx
const handleBlur = () => {
  requestAnimationFrame(() => {
    if (!document.hasFocus()) closeMenu()
  })
}
```

- If the terminal header/shell regression shows pane-activation / terminal-focus churn first, patch `src/components/panes/Pane.tsx` before touching `TerminalView.tsx`:

```tsx
onMouseDown={(event) => {
  if (event.button !== 0) return
  onFocus()
}}
```

  Then rerun the terminal shell/body regressions. Only if the shell/header path still closes because `TerminalView` refocuses the xterm after the menu opens should you add a narrower guard in `src/components/TerminalView.tsx` around the active-pane focus effect.

- If an already-active route fails while the inactive route stays green, do not reuse the inactive-pane explanation. Fix the specific active-route trigger the red tests identified.

- If both a provider dismiss path and terminal focus churn are still red after the first fix, apply the second smallest fix and rerun.

Do not default to a timestamp guard in `ContextMenuProvider.tsx`, and do not change both provider dismissal and pane activation in the same first patch. Let the traces decide the order.

**Step 4: Run the regression pack and verify it passes**

Run:

```bash
npx vitest run \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/terminal-pane-context-menu-focus.test.tsx \
  --reporter=dot
```

Expected: PASS for already-active and inactive browser pane shell, terminal pane header/shell, and terminal body routes, with the unit traces also green.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx src/components/TerminalView.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/terminal-pane-context-menu-focus.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
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
  test/unit/client/components/terminal-pane-context-menu-focus.test.tsx \
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

Expected: PASS with no new JSX a11y or TypeScript lint failures from the menu icon markup or whichever dismissal / activation fix path the traces required.

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

- Right-clicking the already-active and inactive browser pane shell leaves the custom menu open.
- Right-clicking the already-active and inactive terminal pane header or pane shell leaves the custom menu open.
- Right-clicking inside the already-active and inactive terminal text area leaves the custom menu open.
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

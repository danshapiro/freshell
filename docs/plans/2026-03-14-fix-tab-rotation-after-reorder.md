# Fix Tab Rotation After Reorder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make `Ctrl+Shift+[` and `Ctrl+Shift+]` move exactly one tab through the current reordered tab list, including while an xterm terminal is focused.

**Architecture:** Keep `state.tabs.tabs` as the only tab-order source. Fix the bug by giving tab-switch shortcuts a single owner per focus context: `TerminalView` consumes them while xterm has focus so the key never reaches the terminal, and `App` remains the fallback owner for non-terminal surfaces. Extract the bracket-shortcut matcher into a shared client utility so both call sites use the same rules, and teach `App` to honor already-consumed keyboard events instead of dispatching a second tab switch.

**Tech Stack:** React 18, Redux Toolkit, xterm.js, Vitest, Playwright.

---

## Strategy Gate

- Do **not** add a second “visual order” data structure. `state.tabs.tabs` already represents the live visible order, and the reducer-level next/previous logic already reads that array.
- The likely failure is input routing, not reorder persistence. `App` and `TerminalView` both handle the same shortcut today, so a focused terminal can dispatch two tab-switch actions for one physical keypress.
- Keep terminal-local handling. Removing the xterm-side handler would risk letting xterm translate the bracket shortcut into terminal input before the global listener runs.
- Make the global listener a fallback, not a competitor. The clean contract is: the focused surface calls `preventDefault()` when it owns the shortcut, and the window-level handler exits when `event.defaultPrevented` is already true.
- Reordered tabs are the user-visible proof, so add a real browser regression that drags tabs into a new order and then presses the shortcut from the focused terminal.
- Add one fast unit regression for the routing contract so the bug stays easy to diagnose locally without paying the Playwright startup cost every time.
- No `docs/index.html` update is needed. This is a bug fix to existing shortcut behavior, not a new user-facing workflow.

## Acceptance Mapping

- After drag reordering, pressing `Ctrl+Shift+]` from the focused terminal activates the tab immediately to the right in `state.tabs.tabs`.
- After drag reordering, pressing `Ctrl+Shift+[` from the focused terminal activates the tab immediately to the left in `state.tabs.tabs`.
- The same shortcut still works from non-terminal focused inputs, such as the FreshClaude composer, because `App` remains the fallback handler.
- One physical keypress results in one tab-switch dispatch, regardless of whether focus is in xterm or a normal DOM input.

### Task 1: Reproduce the User Bug in the Browser

**Files:**
- Modify: `test/e2e-browser/specs/tab-management.spec.ts`

**Step 1: Add a failing browser regression that reorders tabs and presses the shortcut from the terminal**

In `test/e2e-browser/specs/tab-management.spec.ts`, add:

```ts
  test('Ctrl+Shift+brackets follow reordered tab order from a focused terminal', async ({ freshellPage, page, harness }) => {
    const addButton = page.locator('[data-context="tab-add"]')
    await addButton.click()
    await addButton.click()
    await harness.waitForTabCount(3)
    await harness.waitForTerminalStatus('running')

    const stateBefore = await harness.getState()
    const orderedBefore = stateBefore.tabs.tabs.map((tab: { id: string }) => tab.id)

    const firstTab = page.locator('[data-context="tab"]').first()
    const lastTab = page.locator('[data-context="tab"]').last()
    const firstBox = await firstTab.boundingBox()
    const lastBox = await lastTab.boundingBox()
    expect(firstBox).toBeTruthy()
    expect(lastBox).toBeTruthy()

    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastBox!.x + lastBox!.width / 2, lastBox!.y + lastBox!.height / 2, { steps: 10 })
    await page.mouse.up()

    await page.waitForFunction((before: string[]) => {
      const state = window.__FRESHELL_TEST_HARNESS__?.getState()
      if (!state) return false
      const after = state.tabs.tabs.map((tab: { id: string }) => tab.id)
      return JSON.stringify(after) !== JSON.stringify(before)
    }, orderedBefore)

    const reordered = await harness.getState()
    const orderedIds = reordered.tabs.tabs.map((tab: { id: string }) => tab.id)
    const startingActiveId = reordered.tabs.activeTabId as string
    const startingIndex = orderedIds.indexOf(startingActiveId)
    const expectedNextId = orderedIds[(startingIndex + 1) % orderedIds.length]

    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Control+Shift+]')
    await expect.poll(() => harness.getActiveTabId()).toBe(expectedNextId)

    await page.locator('.xterm:visible').first().click()
    await page.keyboard.press('Control+Shift+[')
    await expect.poll(() => harness.getActiveTabId()).toBe(startingActiveId)
  })
```

**Step 2: Run the browser spec to verify the current bug**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts
```

Expected:
- FAIL in the new test because the focused terminal path currently double-handles the shortcut, so one keypress skips past the immediate reordered neighbor.

### Task 2: Lock the Routing Contract in a Fast Unit Test and Apply the Minimal Fix

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `src/App.tsx`

**Step 1: Add a failing App regression for already-consumed terminal shortcuts**

In `test/unit/client/components/App.test.tsx`, update the `tabsSlice` import to include `reorderTabs`, then add:

```ts
  it('does not re-handle a prevented tab-switch event from an xterm control', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    store.dispatch(reorderTabs({ fromIndex: 0, toIndex: 2 })) // tab order: 2, 3, 1
    renderApp(store)

    const xtermTarget = document.createElement('textarea')
    xtermTarget.className = 'xterm-helper-textarea'
    document.body.appendChild(xtermTarget)

    try {
      xtermTarget.focus()

      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'BracketRight',
        ctrlKey: true,
        shiftKey: true,
      })
      event.preventDefault()

      xtermTarget.dispatchEvent(event)

      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    } finally {
      xtermTarget.remove()
    }
  })
```

**Step 2: Run the focused App test and confirm it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.test.tsx -t "does not re-handle a prevented tab-switch event from an xterm control"
```

Expected:
- FAIL because `App` currently ignores `event.defaultPrevented` and still dispatches `switchToNextTab()`, changing the active tab to `tab-3`.

**Step 3: Apply the minimal bug fix in `src/App.tsx`**

In the window `onKeyDown` handler, add the consumed-event guard before shortcut matching:

```ts
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return

      const tabSwitchDirection = getTabSwitchShortcutDirection(e)
      if (tabSwitchDirection) {
        e.preventDefault()
        dispatch(tabSwitchDirection === 'prev' ? switchToPrevTab() : switchToNextTab())
        return
      }

      if (isTextInput(e.target)) return
    }
```

Important detail:
- Keep the text-input guard after the tab-switch branch so non-terminal inputs such as the FreshClaude composer still inherit the global shortcut behavior.

**Step 4: Re-run the focused unit test and the browser regression**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.test.tsx -t "does not re-handle a prevented tab-switch event from an xterm control"
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts
```

Expected:
- PASS for the new App unit test
- PASS for the reordered browser shortcut regression

**Step 5: Commit the minimal behavioral fix**

```bash
git add test/unit/client/components/App.test.tsx src/App.tsx test/e2e-browser/specs/tab-management.spec.ts
git commit -m "fix: avoid double-handling tab switch shortcuts"
```

### Task 3: Refactor the Shortcut Matcher into a Shared Utility

**Files:**
- Create: `src/lib/tab-switch-shortcuts.ts`
- Create: `test/unit/client/lib/tab-switch-shortcuts.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.keyboard.test.tsx`

**Step 1: Add a failing unit test for the shared shortcut matcher**

Create `test/unit/client/lib/tab-switch-shortcuts.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { getTabSwitchShortcutDirection } from '@/lib/tab-switch-shortcuts'

describe('getTabSwitchShortcutDirection', () => {
  it('maps Ctrl+Shift+[ and Ctrl+Shift+] to tab directions', () => {
    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      code: 'BracketLeft',
    })).toBe('prev')

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      code: 'BracketRight',
    })).toBe('next')
  })

  it('ignores other modifier combinations', () => {
    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      code: 'BracketRight',
    })).toBeNull()

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: false,
      code: 'BracketRight',
    })).toBeNull()

    expect(getTabSwitchShortcutDirection({
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: true,
      code: 'BracketLeft',
    })).toBeNull()
  })
})
```

**Step 2: Run the helper test to verify it fails before the utility exists**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/tab-switch-shortcuts.test.ts
```

Expected:
- FAIL with a module-resolution error because `@/lib/tab-switch-shortcuts` does not exist yet.

**Step 3: Create the shared matcher and move both call sites onto it**

Create `src/lib/tab-switch-shortcuts.ts`:

```ts
export type TabSwitchShortcutDirection = 'prev' | 'next'

type TabSwitchShortcutEvent = Pick<
  KeyboardEvent,
  'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'
>

export function getTabSwitchShortcutDirection(
  event: TabSwitchShortcutEvent,
): TabSwitchShortcutDirection | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null
  if (event.code === 'BracketLeft') return 'prev'
  if (event.code === 'BracketRight') return 'next'
  return null
}
```

Then:
- Remove the local `getTabSwitchShortcutDirection()` function from `src/App.tsx` and import the shared helper from `@/lib/tab-switch-shortcuts`
- In `src/components/TerminalView.tsx`, replace the inline bracket-branch with the shared helper:

```ts
      const tabSwitchDirection = getTabSwitchShortcutDirection(event)
      if (tabSwitchDirection && event.type === 'keydown' && !event.repeat) {
        event.preventDefault()
        dispatch(tabSwitchDirection === 'prev' ? switchToPrevTab() : switchToNextTab())
        return false
      }
```

Important detail:
- Keep `TerminalView` as the terminal-focused owner so the shortcut still returns `false` to xterm and never becomes terminal input.

**Step 4: Re-run the focused helper and client tests**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/tab-switch-shortcuts.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx
```

Expected:
- PASS for the new helper unit tests
- PASS for the App regression
- PASS for the existing TerminalView keyboard coverage

**Step 5: Commit the refactor**

```bash
git add src/lib/tab-switch-shortcuts.ts test/unit/client/lib/tab-switch-shortcuts.test.ts src/App.tsx src/components/TerminalView.tsx
git commit -m "refactor: share tab switch shortcut matcher"
```

### Task 4: Final Verification and Landing Gate

**Files:**
- None

**Step 1: Re-run the focused regression suite together**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.test.tsx test/unit/client/components/TerminalView.keyboard.test.tsx test/unit/client/lib/tab-switch-shortcuts.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts
```

Expected:
- PASS across the focused unit and browser coverage

**Step 2: If this execution turn includes landing to main, run the coordinated full suite before any merge**

Run:

```bash
FRESHELL_TEST_SUMMARY="tab rotation after reorder" npm test
```

Expected:
- PASS for the coordinated full suite

Important detail:
- If any unrelated failure appears here, stop and fix it before attempting to land, per repo policy.

**Step 3: If the user later authorizes landing, follow the repo merge safety rules exactly**

Run from the worktree first:

```bash
git fetch origin
git merge origin/main
```

Then re-run:

```bash
FRESHELL_TEST_SUMMARY="tab rotation after reorder" npm test
```

Only after the worktree is green, fast-forward `main` from the main checkout:

```bash
git merge --ff-only trycycle-tab-rotation-after-reorder
```

Important detail:
- Never run a normal `git merge` directly on `main`. The repo is serving this session from `main`, and conflict markers there would break the running server.

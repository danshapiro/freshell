# Mobile Context-Menu Dismissal Fixes Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Stop the mobile context menu from opening and instantly self-dismissing (especially with the on-screen keyboard visible), while keeping genuine user scrolls dismissing it, and stop Android text selection from competing with long-press on tab-bar tabs.

**Architecture:** Four small, orthogonal fixes to the existing context-menu system: (1) a robust dismissal policy in `ContextMenuProvider` (post-open grace window + ignore scrolls originating inside the menu, applied to the capture-phase `scroll` listener and the `resize` listener); (2) `focus({ preventScroll: true })` at every menu-item focus site in `ContextMenu` so opening the menu never triggers a native scroll-into-view; (3) keyboard-aware position clamping in `context-menu-utils` using `window.visualViewport` with a layout-viewport fallback; (4) `select-none` (+ `-webkit-touch-callout: none`) on the tab-bar tab and on the menu container. No new files, no new dependencies, no API changes.

**Tech Stack:** React 18 + TypeScript, Redux Toolkit, Tailwind (`cn()` from `@/lib/utils`), Vitest 3 + Testing Library (jsdom).

## Global Constraints

- Repo root (git worktree — all commands run here): `/home/dan/code/freshell/.worktrees/mobile-context-menu-dismissal`
- Test command form (ONLY this form; raw `npx vitest` is banned by AGENTS.md): `npm run test:vitest -- run <path> [<path> ...]` — you MUST include the `run` verb yourself or vitest enters watch mode.
- Any `console.error` during a test FAILS the test (trap in `test/setup/dom.ts`).
- Vitest runs with `sequence.shuffle: true` — tests must be order-independent; restore every overridden `window` property (`visualViewport`, spies) in `afterEach`/`finally`.
- jsdom defaults: `window.innerWidth = 1024`, `window.innerHeight = 768`; `document.elementFromPoint` does NOT exist (the long-press suite stubs it); `window.visualViewport` does NOT exist (tests must `Object.defineProperty` it and restore).
- Post-open grace window constant: `MENU_OPEN_GRACE_MS = 500` (milliseconds) — private module constant in `ContextMenuProvider.tsx`. (Validated: the keyboard-hide scroll/resize burst lands ~250–350ms after open on measured platforms, so 300ms would straddle the edge; genuine touch scrolls on mobile still dismiss instantly via the pointerdown-outside handler regardless of grace, so the only cost is slightly delayed wheel-scroll dismissal on desktop.)
- Do NOT store an open-timestamp inside `menuState`: the effect at `ContextMenuProvider.tsx:1191-1195` runs `closeMenu()` in its cleanup on every `menuState` identity change. Use a ref (`menuOpenedAtRef`), as this plan specifies.
- Preserve all PR #629 long-press behavior in `ContextMenuProvider.tsx` lines 997–1163 (suppressNextTouchEnd, 500ms timer, 10px move tolerance, touchcancel handling) — do not modify that effect.
- No new end-user markdown docs (README.md is the only end-user doc; this plan under `docs/plans/` is a working doc).
- No new dependencies. Keep commits focused and atomic (one per task).
- Line numbers cited below are from commit `f0c447b68` (current main); re-locate by content if drifted.

---

## File Structure

All changes are edits to existing files — the codebase's context-menu system is small and focused, so no new files or splits are needed.

**Production files modified:**

| File | Responsibility of the change |
|---|---|
| `src/components/context-menu/ContextMenuProvider.tsx` (1426 lines) | Dismissal policy: `menuOpenedAtRef` set in `openMenu`; grace window + menu-origin exclusion in the scroll/resize close handlers (effect at lines 1165–1189). |
| `src/components/context-menu/ContextMenu.tsx` (162 lines) | `focusItem` helper using `focus({ preventScroll: true })` at all 5 focus sites; `select-none` on the menu container. |
| `src/components/context-menu/context-menu-utils.ts` (105 lines) | New exported `getVisibleViewportRect()`; `clampToViewport` becomes keyboard-aware (visualViewport with layout fallback). Signature unchanged. |
| `src/components/TabItem.tsx` (251 lines) | `select-none [-webkit-touch-callout:none]` on the tab root div (the `data-context={ContextIds.Tab}` long-press target). |

**Test files modified (all exist today):**

| File | Added coverage |
|---|---|
| `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx` (655 lines, 17 tests, fake timers) | Dismissal policy (grace/scroll/resize/blur), preventScroll auto-focus, keyboard-aware clamping integration, menu-container select-none. |
| `test/unit/client/components/ContextMenuProvider.test.tsx` (2515 lines, 41 tests at run time, real timers + userEvent) | Desktop right-click regression: genuine scroll still dismisses; keyboard-nav focus uses preventScroll. |
| `test/unit/client/components/context-menu/context-menu-utils.test.ts` | `clampToViewport` visualViewport unit tests. |
| `test/unit/client/components/TabItem.test.tsx` (567 lines, 39 tests at run time, no providers needed) | select-none / touch-callout class assertions. |

---

## Background for implementers (read before Task 1)

**The bug funnel (code-verified):** `ContextMenuProvider.tsx:1165-1189` registers, while the menu is open, `window.addEventListener('scroll', handleScroll, true)` (capture phase — catches scrolls from ANY nested scrollable element), plus `resize` and `blur` — where all three handlers are today a bare `closeMenu()`. Current code verbatim:

```tsx
  useEffect(() => {
    if (!menuState) return

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current && menuRef.current.contains(target)) return
      closeMenu()
    }

    const handleScroll = () => closeMenu()
    const handleResize = () => closeMenu()
    const handleBlur = () => closeMenu()

    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleResize)
    window.addEventListener('blur', handleBlur)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('blur', handleBlur)
    }
  }, [menuState, closeMenu])
```

With the Android keyboard up: the menu clamps to the LAYOUT viewport (`window.innerHeight`) so it can open under the keyboard; one frame later `ContextMenu.tsx:52` focuses the first item WITHOUT `preventScroll`; the browser scrolls the focused item into view; the native scroll event hits the capture-phase listener; `closeMenu()` — "opens then instantly dismisses". Secondary mechanical events funnel into the same zero-tolerance close: the keyboard hiding as focus moves into the menu produces a scroll/resize burst ~250–350ms after open, plus finger drift/overscroll and tab-strip rubber-banding. (Correction from validation: xterm 6.0.0 uses synthetic scrolling — it registers no native scroll listeners and its refit produces NO native scroll events, so the terminal is not one of the producers; and modern Chrome ≥108 / iOS Safari never fire window `resize` for the keyboard — only legacy Android WebViews do.)

**Validated platform facts implementers must know:**
- `focus({ preventScroll: true })` is a NO-OP on Chrome Android / Android WebView (crbug.com/41453122); it works on desktop and iOS Safari 15.5+. Task 1's grace window is therefore the PRIMARY fix on Android; Task 2 is defense-in-depth.
- Known limitation (out of scope, pre-existing): the agent transcript's streaming auto-scroll (`FreshAgentTranscript.tsx:738-747`) fires native scrolls at arbitrary times and will still dismiss an open menu after the grace window — it does so on desktop today too.
- Known landmine (mitigated by Task 4; do not "fix" ad hoc): on Android WebView, long-press text selection fires `touchcancel`, which clears `suppressNextTouchEnd`; a late native `contextmenu` then double-opens the menu, and a double-open nets to CLOSED via the view-change effect's cleanup (lines 1191–1195; verified by jsdom repro). `select-none` (Task 4) removes the text-selection trigger at the root.

**Test harness facts** (see the two suites for the full patterns):
- `ContextMenu.longpress.test.tsx` uses `vi.useFakeTimers()` in `beforeEach`, stubs `document.elementFromPoint` into `elementFromPointMock`, opens menus via a local `simulateTouch()` helper + `act(() => vi.advanceTimersByTime(500))`, and asserts open/closed via `screen.getByRole('menu')` / `screen.queryByRole('menu')`. It deliberately does NOT use `userEvent`.
- `ContextMenuProvider.test.tsx` uses REAL timers and `userEvent.setup()` + `await user.pointer({ target, keys: '[MouseRight]' })`. Do NOT add fake timers to this file.

---

### Task 1: Robust dismissal policy (grace window + menu-origin scroll exclusion)

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (constant near line 76; `openMenu` at lines 208–211; handlers inside the effect at lines 1165–1189)
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Interfaces:**
- Consumes: existing `menuRef: React.RefObject<HTMLDivElement | null>` (line 184), `openMenu(state: MenuState): void` (lines 208–211), `closeMenu(): void` (lines 190–206). All unchanged in signature.
- Produces: private module constant `MENU_OPEN_GRACE_MS = 500` and private ref `menuOpenedAtRef: React.MutableRefObject<number>`. Behavior contract relied on by later tasks/tests: scroll or resize events within 500ms of `openMenu` do NOT close the menu; scroll events whose `target` is inside `menuRef.current` NEVER close the menu; scroll/resize after 500ms DO close it; window `blur` closes immediately (unchanged).

- [ ] **Step 1: Write the failing dismissal-policy tests**

Open `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`. Inside the existing top-level `describe('ContextMenuProvider long-press', ...)` block (so the existing `beforeEach`/`afterEach` with fake timers and the `elementFromPointMock` stub apply), add this nested describe just before the top-level describe's closing `})`:

```tsx
  describe('dismissal policy (scroll / resize / blur)', () => {
    // NOTE: the outer suite's beforeEach already installs vi.useFakeTimers().
    // Vitest's default toFake includes Date (verified by probe against this
    // repo's vitest 3.2.4), so vi.advanceTimersByTime() advances Date.now(),
    // which the grace-window implementation reads. Do NOT add a nested
    // vi.useFakeTimers({ toFake: [...] }) here: re-calling it while fake
    // timers are already installed is a verified silent no-op (the new
    // config is ignored). If Date faking ever regressed, these tests would
    // fail loudly rather than silently.

    function openMenuByLongPress() {
      renderWithProvider(
        <div data-context={ContextIds.Tab} data-tab-id="tab-1">
          Tab One
        </div>
      )
      const target = screen.getByText('Tab One')
      elementFromPointMock.mockReturnValue(target)
      act(() => {
        simulateTouch('touchstart', target, 100, 100)
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()
    }

    it('ignores scroll events during the post-open grace window, then closes on a later scroll', () => {
      openMenuByLongPress()

      // Mechanical scroll immediately after open (focus scroll-into-view,
      // xterm refit, keyboard viewport settling) must NOT dismiss.
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // Still inside the 500ms grace window.
      act(() => {
        vi.advanceTimersByTime(100)
      })
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // 600ms after open — past the 500ms grace window: a genuine user
      // scroll dismisses the menu (correct UX).
      act(() => {
        vi.advanceTimersByTime(500)
      })
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('never closes on scrolls that originate inside the menu itself', () => {
      openMenuByLongPress()

      // Get past the grace window so this test proves the target-origin
      // exclusion specifically, not the grace window.
      act(() => {
        vi.advanceTimersByTime(600)
      })

      // scroll does not bubble, but the provider's listener is registered
      // on window with capture: true, so it still sees this event during
      // the capture phase with e.target === the menu element.
      const menu = screen.getByRole('menu')
      act(() => {
        menu.dispatchEvent(new Event('scroll'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      // Sanity: a window-level scroll at the same moment DOES close.
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('ignores resize during the grace window but closes on a later resize', () => {
      openMenuByLongPress()

      // Keyboard show/hide can resize the window (older Android WebViews)
      // right as the menu opens — must not dismiss.
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(600)
      })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes on window blur immediately, even during the grace window', () => {
      openMenuByLongPress()

      act(() => {
        window.dispatchEvent(new Event('blur'))
      })
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/mobile-context-menu-dismissal
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx -t "dismissal policy"
```
Expected: FAIL. The three scroll/resize tests fail at the first post-dispatch assertion with `TestingLibraryElementError: Unable to find an accessible element with the role "menu"` (current code closes on ANY scroll/resize). The blur test PASSES (existing behavior we are preserving). If instead you see 0 tests matched, check the `-t` filter string matches the describe title.

- [ ] **Step 3: Implement the dismissal policy**

In `src/components/context-menu/ContextMenuProvider.tsx`:

3a. Add the constant next to the existing module constants (immediately after `const CONTEXT_MENU_KEYS = ['ContextMenu']` at line 76):

```tsx
// How long after the menu opens we ignore scroll/resize events. Opening the
// menu on mobile has mechanical side effects that fire native scroll/resize
// shortly after open: focus scroll-into-view (next frame) and the on-screen
// keyboard hiding as focus moves into the menu, whose scroll/resize burst
// lands ~250-350ms after open on measured platforms — 500ms covers it with
// margin. These are not user dismissal intent. Genuine user scrolls still
// close the menu: on touch devices a real scroll begins with a pointerdown
// outside the menu (which closes it instantly, grace or no grace); on
// desktop, wheel scrolls close it once the grace window has passed.
const MENU_OPEN_GRACE_MS = 500
```

3b. Add the ref next to the existing refs (after `const suppressNextFocusRestoreRef = useRef(false)` at line 186):

```tsx
  const menuOpenedAtRef = useRef(0)
```

3c. Stamp the open time in `openMenu` (lines 208–211). Replace:

```tsx
  const openMenu = useCallback((state: MenuState) => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    setMenuState(state)
  }, [])
```

with:

```tsx
  const openMenu = useCallback((state: MenuState) => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    // Kept in a ref (NOT in menuState): the view-change effect below runs
    // closeMenu() in its cleanup whenever menuState identity changes, so
    // writing a timestamp into state would self-dismiss the menu.
    menuOpenedAtRef.current = Date.now()
    setMenuState(state)
  }, [])
```

3d. In the effect at lines 1165–1189, replace the three one-liner handlers:

```tsx
    const handleScroll = () => closeMenu()
    const handleResize = () => closeMenu()
    const handleBlur = () => closeMenu()
```

with:

```tsx
    const handleScroll = (e: Event) => {
      // Scrolls that originate inside the menu (e.g. an overflowing item
      // list) are interactions with the menu, not dismissal intent.
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      // Mechanical scrolls right after open are side effects of opening
      // (see MENU_OPEN_GRACE_MS). Genuine user scrolls still dismiss.
      if (Date.now() - menuOpenedAtRef.current < MENU_OPEN_GRACE_MS) return
      closeMenu()
    }
    const handleResize = () => {
      // Keyboard show/hide can resize the window (older Android WebViews)
      // right as the menu opens; give resize the same post-open grace.
      if (Date.now() - menuOpenedAtRef.current < MENU_OPEN_GRACE_MS) return
      closeMenu()
    }
    const handleBlur = () => closeMenu()
```

Do NOT change the listener registration/cleanup lines or the effect deps (`[menuState, closeMenu]` — the new ref and module constant need no deps). Do NOT touch `handlePointerDown`. TypeScript note: `window.addEventListener('scroll', handleScroll, true)` accepts the `(e: Event) => void` signature as-is.

- [ ] **Step 4: Run the new tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
```
Expected: PASS — all 17 pre-existing tests plus the 4 new ones (21 total).

- [ ] **Step 5: Add the desktop regression test (real timers, right-click path)**

Open `test/unit/client/components/ContextMenuProvider.test.tsx`. Inside the top-level `describe('ContextMenuProvider', ...)` block, after the existing test `'closes menu on outside click'` (line ~702), add:

```tsx
  it('closes the menu when the user scrolls after the post-open grace period', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // Wait out the 500ms post-open grace window (this suite uses real
    // timers by design — do not add fake timers to this file).
    await new Promise((resolve) => setTimeout(resolve, 550))

    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
```

This is regression coverage proving desktop "genuine scroll dismisses" UX survives the new policy — it also passes on pre-Task-1 code; its job is to fail if anyone ever makes the grace window too aggressive. (`act`, `waitFor`, `screen`, `userEvent`, and `ContextIds` are already imported in this file.)

- [ ] **Step 6: Run the provider suite**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx
```
Expected: PASS — all 41 pre-existing tests plus the new one (42 total). (41 is the RUN-TIME baseline count, verified by executing the suite; static reading over-counts because of `it.each` expansion elsewhere in the repo's suites.)

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/mobile-context-menu-dismissal
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: add post-open grace and menu-origin exclusion to context menu dismissal"
```

---

### Task 2: Focus menu items with preventScroll

**Files:**
- Modify: `src/components/context-menu/ContextMenu.tsx` (imports line 1; new helper after line 36; focus sites at lines 52, 93, 99, 104, 109)
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Interfaces:**
- Consumes: existing `itemRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>` (line 29). `ContextMenuProps` unchanged.
- Produces: private `focusItem(index: number): void` inside the `ContextMenu` component — every menu-item focus goes through it with `{ preventScroll: true }`. No exported API changes. (The focus-restore in the provider's `closeMenu` at `ContextMenuProvider.tsx:204` intentionally keeps plain `.focus()` — it runs after the menu is closed, when scroll-into-view of the user's previous focus target is desirable and harmless.)
- Platform reality (validated): `preventScroll` is a NO-OP on Chrome Android / Android WebView (unsupported — crbug.com/41453122); it works on desktop browsers and iOS Safari 15.5+ (with open WebKit bug 238093 affecting freshly-mounted elements). This task is defense-in-depth: Task 1's grace window is the primary mechanism stopping focus-scroll self-dismissal on Android; this task removes the mechanical scroll at its source where the platform allows.

- [ ] **Step 1: Write the failing auto-focus test (mobile open path)**

In `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`, inside the top-level describe (NOT inside the Task 1 nested describe), add:

```tsx
  it('focuses the first menu item with preventScroll so opening never triggers scroll-into-view', () => {
    // The auto-focus effect schedules via requestAnimationFrame; run the
    // callback synchronously so the focus happens within this test.
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      })
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')

    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )
    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The only .focus() calls in this flow are the menu's item auto-focus;
    // every one of them must pass { preventScroll: true }.
    expect(focusSpy).toHaveBeenCalled()
    for (const call of focusSpy.mock.calls) {
      expect(call[0]).toEqual({ preventScroll: true })
    }

    rafSpy.mockRestore()
    focusSpy.mockRestore()
  })
```

- [ ] **Step 2: Write the failing keyboard-navigation test (desktop path)**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, inside the top-level describe, add:

```tsx
  it('keyboard navigation focuses menu items with preventScroll', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    const menu = screen.getByRole('menu')

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'End' })
    fireEvent.keyDown(menu, { key: 'Home' })
    fireEvent.keyDown(menu, { key: 'ArrowUp' })

    expect(focusSpy).toHaveBeenCalled()
    for (const call of focusSpy.mock.calls) {
      expect(call[0]).toEqual({ preventScroll: true })
    }
    focusSpy.mockRestore()
  })
```

(`fireEvent` is already imported in this file. The spy is installed AFTER the menu opens so unrelated open-path focus activity is not captured.)

- [ ] **Step 3: Run both new tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx -t "preventScroll"
npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx -t "preventScroll"
```
Expected: FAIL in both, with `AssertionError: expected undefined to deeply equal { preventScroll: true }` (current code calls `.focus()` with no arguments).

- [ ] **Step 4: Implement focusItem with preventScroll**

In `src/components/context-menu/ContextMenu.tsx`:

4a. Line 1 — add `useCallback` to the React import:

```tsx
import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
```

4b. After the `enabledIndices` memo (ends line 36), add:

```tsx
  const focusItem = useCallback((index: number) => {
    // preventScroll: focusing a menu item should never scroll it into view.
    // The resulting native scroll event would reach the provider's
    // capture-phase scroll listener and dismiss the menu the moment it
    // opens (visible with the on-screen keyboard up, where the menu could
    // mount outside the visual viewport). NOTE: preventScroll is a no-op
    // on Chrome Android (crbug.com/41453122) — there the provider's
    // post-open grace window absorbs the focus scroll; this option still
    // helps on desktop and iOS Safari 15.5+.
    itemRefs.current[index]?.focus({ preventScroll: true })
  }, [])
```

4c. Replace the auto-focus effect (lines 47–54):

```tsx
  useEffect(() => {
    if (!open) return
    const first = enabledIndices[0]
    if (typeof first === 'number') {
      setActiveIndex(first)
      requestAnimationFrame(() => focusItem(first))
    }
  }, [open, enabledIndices, focusItem])
```

4d. In the `onKeyDown` handler, replace all four `itemRefs.current[nextIndex]?.focus()` calls (lines 93, 99, 104, 109 — the ArrowDown, ArrowUp, Home, End branches) with:

```tsx
          focusItem(nextIndex)
```

(each branch keeps its `setActiveIndex(nextIndex)` line immediately before).

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
```
Expected: PASS — longpress suite 22 tests, provider suite 43 tests (the verified run-time baselines of 17 and 41, plus Tasks 1–2 additions).

- [ ] **Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenu.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix: focus context menu items with preventScroll to avoid self-dismissal"
```

---

### Task 3: Keyboard-aware menu position clamping (visualViewport)

**Files:**
- Modify: `src/components/context-menu/context-menu-utils.ts` (replace `clampToViewport`, lines 14–21)
- Test: `test/unit/client/components/context-menu/context-menu-utils.test.ts`
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`

**Interfaces:**
- Consumes: `window.visualViewport` (`VisualViewport | null` in lib.dom: `width`, `height`, `offsetLeft`, `offsetTop` — all numbers).
- Produces: exported `getVisibleViewportRect(): { left: number; top: number; width: number; height: number }` and `clampToViewport(x: number, y: number, menuW: number, menuH: number, padding = 8): { x: number; y: number }` — SIGNATURE UNCHANGED, so the caller in `ContextMenu.tsx:43` needs no edits. Fallback behavior (no visualViewport, e.g. jsdom or older browsers) is byte-for-byte equivalent to today's math, so all existing callers and tests stay green.
- Platform caveats (validated, accepted as residual risk — no extra code): Android WebView may not shrink `visualViewport` when the keyboard shows (Chrome's `resizes-visual` default explicitly does not apply to WebView) — there the clamp degrades to today's layout-viewport behavior and Task 1's grace window still prevents the instant dismissal. iOS 26 has a known quirk where vv values can briefly stay stale after keyboard dismissal (the menu may clamp against a slightly stale rect).

- [ ] **Step 1: Write the failing unit tests**

In `test/unit/client/components/context-menu/context-menu-utils.test.ts`, add a new top-level describe. Two import edits are required first (the vitest config does NOT enable `globals`, so nothing is auto-injected): (1) add `afterEach` to the file's existing vitest import — it currently reads `import { describe, it, expect } from 'vitest'` and must become `import { afterEach, describe, it, expect } from 'vitest'`; (2) reuse the file's existing import of `clampToViewport` if present, otherwise add `clampToViewport` to the existing import from `@/components/context-menu/context-menu-utils`:

```ts
describe('clampToViewport with visualViewport (mobile keyboard awareness)', () => {
  const originalVisualViewport = window.visualViewport

  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      configurable: true,
    })
  })

  function installVisualViewport(rect: {
    width: number
    height: number
    offsetLeft?: number
    offsetTop?: number
  }) {
    Object.defineProperty(window, 'visualViewport', {
      value: {
        width: rect.width,
        height: rect.height,
        offsetLeft: rect.offsetLeft ?? 0,
        offsetTop: rect.offsetTop ?? 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
    })
  }

  it('clamps to the visual viewport when the keyboard shrinks it below window.innerHeight', () => {
    // jsdom layout viewport is 1024x768; simulate a keyboard leaving 400px visible.
    installVisualViewport({ width: 1024, height: 400 })
    const result = clampToViewport(100, 700, 200, 150, 8)
    // maxY = 0 + 400 - 150 - 8 = 242 -- NOT the layout-viewport 768-150-8=610.
    expect(result).toEqual({ x: 100, y: 242 })
  })

  it('respects visualViewport offsets (pinch-zoom / scrolled visual viewport)', () => {
    installVisualViewport({ width: 500, height: 400, offsetLeft: 50, offsetTop: 100 })
    const result = clampToViewport(0, 0, 200, 150, 8)
    // minX = 50 + 8 = 58, minY = 100 + 8 = 108.
    expect(result).toEqual({ x: 58, y: 108 })
  })

  it('falls back to the layout viewport when visualViewport is unavailable', () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    // jsdom: innerWidth=1024, innerHeight=768.
    // maxX = 1024-200-8 = 816; maxY = 768-150-8 = 610 -- identical to the old math.
    const result = clampToViewport(2000, 2000, 200, 150, 8)
    expect(result).toEqual({ x: 816, y: 610 })
  })
})
```

- [ ] **Step 2: Write the failing integration test (menu never placed under the keyboard)**

In `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`, inside the top-level describe, add:

```tsx
  it('positions the menu inside the visual viewport when the on-screen keyboard is showing', () => {
    const originalVisualViewport = window.visualViewport
    // Keyboard visible: visual viewport is 400px tall while the layout
    // viewport (jsdom window.innerHeight) stays 768px.
    Object.defineProperty(window, 'visualViewport', {
      value: {
        width: 1024,
        height: 400,
        offsetLeft: 0,
        offsetTop: 0,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      configurable: true,
    })

    try {
      renderWithProvider(
        <div data-context={ContextIds.Tab} data-tab-id="tab-1">
          Tab One
        </div>
      )
      const target = screen.getByText('Tab One')
      elementFromPointMock.mockReturnValue(target)

      // Long-press at y=600 -- inside the keyboard-occluded region.
      act(() => {
        simulateTouch('touchstart', target, 100, 600)
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })

      const menu = screen.getByRole('menu')
      // jsdom reports a zero-size menu rect, so the clamp ceiling is
      // maxY = 400 - 0 - 8 = 392. The menu must NOT stay at y=600 (under
      // the keyboard, where focus-driven scroll would then dismiss it).
      expect(menu.style.top).toBe('392px')
      expect(menu.style.left).toBe('100px')
    } finally {
      Object.defineProperty(window, 'visualViewport', {
        value: originalVisualViewport,
        configurable: true,
      })
    }
  })
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx -t "visual"
```
Expected: FAIL. The keyboard-shrink unit test fails with `expected { x: 100, y: 610 } to deeply equal { x: 100, y: 242 }`; the offsets test fails similarly (min is `8`, not `58`/`108`); the integration test fails with `expected '600px' to be '392px'`. The fallback test PASSES (it locks in today's behavior).

- [ ] **Step 4: Implement keyboard-aware clamping**

In `src/components/context-menu/context-menu-utils.ts`, replace `clampToViewport` (lines 14–21):

```ts
export function clampToViewport(x: number, y: number, menuW: number, menuH: number, padding = 8) {
  const maxX = Math.max(padding, window.innerWidth - menuW - padding)
  const maxY = Math.max(padding, window.innerHeight - menuH - padding)
  return {
    x: Math.min(Math.max(x, padding), maxX),
    y: Math.min(Math.max(y, padding), maxY),
  }
}
```

with:

```ts
/**
 * The rectangle of the viewport actually visible to the user, in
 * layout-viewport (position: fixed) coordinates.
 *
 * On mobile, the on-screen keyboard shrinks `window.visualViewport` while
 * `window.innerHeight` (the layout viewport) usually stays unchanged, so
 * clamping against the layout viewport can place a fixed-position menu
 * underneath the keyboard. Prefer the visual viewport when the browser
 * provides it; fall back to the layout viewport otherwise (older browsers,
 * jsdom).
 */
export function getVisibleViewportRect(): {
  left: number
  top: number
  width: number
  height: number
} {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (vv) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

export function clampToViewport(x: number, y: number, menuW: number, menuH: number, padding = 8) {
  const viewport = getVisibleViewportRect()
  const minX = viewport.left + padding
  const minY = viewport.top + padding
  const maxX = Math.max(minX, viewport.left + viewport.width - menuW - padding)
  const maxY = Math.max(minY, viewport.top + viewport.height - menuH - padding)
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  }
}
```

(When `visualViewport` is absent, `left`/`top` are 0 and the math reduces exactly to the old implementation.)

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
```
Expected: PASS — all pre-existing utils tests (fallback path unchanged) plus 3 new unit tests, and the longpress suite now at 23 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/context-menu/context-menu-utils.ts test/unit/client/components/context-menu/context-menu-utils.test.ts test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
git commit -m "fix: clamp context menu position to the visual viewport (keyboard-aware)"
```

---

### Task 4: Suppress text selection on long-press targets (residual risk b)

**Files:**
- Modify: `src/components/TabItem.tsx` (base class string, line 161)
- Modify: `src/components/context-menu/ContextMenu.tsx` (menu container class, line 65)
- Test: `test/unit/client/components/TabItem.test.tsx`
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`

**Interfaces:**
- Consumes: `cn()` composition already in both files; `TabItem`'s root `<div>` carries both the class list (line 161) and `data-context={ContextIds.Tab}` (line 188), so one edit covers the whole long-press target including children.
- Produces: class contract asserted by tests — `TabItem` root contains `select-none` and `[-webkit-touch-callout:none]`; the `role="menu"` container contains `select-none`. (`TabsView.tsx:159` TabCard already has `select-none` — this brings `TabItem` and the menu itself to parity.)
- Side benefit (validated): on Android WebView, long-press text selection fires `touchcancel`, which clears `suppressNextTouchEnd` in the PR #629 handlers — after which a late native `contextmenu` can double-open the menu, and a double-open nets to CLOSED via the view-change effect's cleanup (`ContextMenuProvider.tsx:1191-1195`, verified by jsdom repro). `select-none` removes the text-selection trigger at the root, so this task also mitigates that secondary self-dismissal path. (Chrome Android itself fires touchstart→contextmenu→touchend with no touchcancel on long-press, and Tailwind's `select-none` emits `-webkit-user-select: none` too — verified against this repo's Tailwind build.)

- [ ] **Step 1: Write the failing TabItem test**

In `test/unit/client/components/TabItem.test.tsx`, inside the existing describe block, add a test that renders exactly the way the file's existing tests do (39 at run time) — `render(<TabItem {...defaultProps} />)` with the props object already defined near the top of the file (no store/context providers are needed; if the file's shared props object has a different name, use that name and pattern):

```tsx
  it('suppresses native text selection on the tab (mobile long-press target)', () => {
    const { container } = render(<TabItem {...defaultProps} />)
    const tabRoot = container.querySelector('[data-context]') as HTMLElement | null
    expect(tabRoot).not.toBeNull()
    // Android/iOS long-press must open OUR context menu, not the OS
    // text-selection UI (selection handles competing with the menu).
    expect(tabRoot!.className).toContain('select-none')
    expect(tabRoot!.className).toContain('[-webkit-touch-callout:none]')
  })
```

- [ ] **Step 2: Write the failing menu-container test**

In `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`, inside the top-level describe, add:

```tsx
  it('renders the menu itself with text selection suppressed', () => {
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )
    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)
    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // A long-press release drifting onto the menu must not start selecting
    // menu label text on mobile.
    expect(screen.getByRole('menu').className).toContain('select-none')
  })
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx -t "text selection"
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx -t "text selection"
```
Expected: FAIL in both with `AssertionError: expected '...' to contain 'select-none'`.

- [ ] **Step 4: Implement the class additions**

4a. In `src/components/TabItem.tsx`, line 161, the first string argument of the root `cn(...)`. Replace:

```tsx
        'group relative flex w-full min-w-0 items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors',
```

with:

```tsx
        'group relative flex w-full min-w-0 items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors select-none [-webkit-touch-callout:none]',
```

(`select-none` = `user-select: none`, matching TabCard at `TabsView.tsx:159`. `[-webkit-touch-callout:none]` is a Tailwind arbitrary property emitting `-webkit-touch-callout: none` — iOS long-press callout suppression; harmless elsewhere.)

4b. In `src/components/context-menu/ContextMenu.tsx`, line 65 (menu container `cn(...)` first string). Replace:

```tsx
        'fixed min-w-[200px] rounded-md border border-border bg-card shadow-lg py-1',
```

with:

```tsx
        'fixed min-w-[200px] rounded-md border border-border bg-card shadow-lg py-1 select-none',
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx test/unit/client/components/context-menu/ContextMenu.mobile.test.tsx
```
Expected: PASS — TabItem suite 40 tests (verified run-time baseline 39 + 1), longpress suite 24 tests, and `ContextMenu.mobile.test.tsx` (item padding assertions) unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/components/TabItem.tsx src/components/context-menu/ContextMenu.tsx test/unit/client/components/TabItem.test.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
git commit -m "fix: suppress text selection on tab items and context menu for mobile long-press"
```

---

### Task 5: Full regression sweep (keep every existing behavior green)

**Files:**
- Test only (no production edits expected). Fix-forward any fallout in the four files this plan touched.

**Interfaces:**
- Consumes: everything Tasks 1–4 produced.
- Produces: green verdict across every suite that exercises the behaviors the spec requires preserved: desktop right-click open/close, outside-pointerdown dismissal, Escape/Tab handling, item selection, iOS/Android long-press open paths (suppressNextTouchEnd, timer cancellation), move-tolerance cancellation, touchcancel handling, native-menu passthrough for inputs/links, view-change close.

- [ ] **Step 1: Run every context-menu-adjacent suite**

Run (allow several minutes; use a generous command timeout):
```bash
cd /home/dan/code/freshell/.worktrees/mobile-context-menu-dismissal
npm run test:vitest -- run \
  test/unit/client/components/context-menu \
  test/unit/client/components/ContextMenuProvider.test.tsx \
  test/unit/client/components/TabItem.test.tsx \
  test/unit/client/context-menu \
  test/unit/client/hooks/useKeyboardInset.test.ts \
  test/unit/client/components/TerminalView.mobile-viewport.test.tsx \
  test/e2e/terminal-url-context-menu.test.tsx \
  test/e2e/refresh-context-menu-flow.test.tsx \
  test/e2e/pane-context-menu-stability.test.tsx
```
Expected: all files PASS, 0 failures. If any pre-existing test fails, the fix belongs in the code Tasks 1–4 changed (most likely candidate: a test that relied on immediate scroll-close — adapt the PRODUCTION-preserving way: advance/wait past the 500ms grace in the test rather than weakening the policy).

- [ ] **Step 2: Typecheck and scoped lint**

Run:
```bash
npm run typecheck:client
npx eslint src/components/context-menu/ContextMenuProvider.tsx src/components/context-menu/ContextMenu.tsx src/components/context-menu/context-menu-utils.ts src/components/TabItem.tsx
```
Expected: both exit 0 with no errors on the touched files.

- [ ] **Step 3: Full client unit suite**

Run (takes minutes — set a long command timeout, e.g. 1800s):
```bash
npm run test:client:standard
```
Expected: PASS (same set of green files as on main before this work; no new failures attributable to these changes).

- [ ] **Step 4: Commit (only if fixes were needed)**

If Steps 1–3 required changes:
```bash
git add -A src/components src/components/context-menu test/unit test/e2e
git commit -m "test: regression fixes from full context-menu sweep"
```
If nothing changed, do not create an empty commit.

---

## Spec-requirement → coverage map (for the plan-review stage)

| Spec requirement | Task | Proof (production outcome, no stubs) |
|---|---|---|
| 1. `focus({ preventScroll: true })` at all 5 `ContextMenu.tsx` focus sites | Task 2 | Focus spy tests on both open paths assert every menu-item focus call passes `{ preventScroll: true }` against the real components. |
| 2. Keyboard-aware positioning via `window.visualViewport` with layout fallback | Task 3 | Unit tests on `clampToViewport` + integration test asserting the real rendered menu's `style.top` respects a shrunken visual viewport. |
| 3. Replace zero-tolerance close-on-any-scroll (residual risk a): grace window + menu-origin exclusion; genuine scrolls still dismiss; `resize` gets the same grace | Task 1 | Fake-timer timeline tests (ignore at 0ms/100ms, close at 600ms; menu-origin scroll never closes; resize graced; blur immediate) + real-timer desktop right-click regression test. |
| 4. Residual risk (b): `select-none` (+ touch-callout) on `TabItem`, consistent with TabCard | Task 4 | Class assertions on the rendered `TabItem` root (`data-context` element) and on the `role="menu"` container. |
| 5. TDD with the spec's named test cases (a)–(d), extending the two named suites | Tasks 1–4 | (a)=Task 1 Step 1, (b)=Task 2 Steps 1–2, (c)=Task 3 Steps 1–2, (d)=Task 4 Step 1 — each written first with an explicit expected-FAIL step. |
| 6. Keep all existing behaviors green (desktop right-click, outside-pointerdown, Escape/Tab, item selection, PR #629 long-press paths, move tolerance, touchcancel, native-menu passthrough, view-change close) | Task 5 (+ every task's full-suite runs) | The 17 longpress + 41 provider pre-existing tests cover these paths and are re-run in every task; Task 5 sweeps all adjacent suites, typecheck, lint, and the full client suite. |

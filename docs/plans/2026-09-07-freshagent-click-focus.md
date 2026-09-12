# Fresh-Agent Click-to-Defocus Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fresh-agent panes (the SDK-backed chat-composer pane type, `kind: 'fresh-agent'`) should let the user click the transcript (or other non-composer regions) without auto-refocusing the composer, so existing transcript-scroll keys (Home/End/PageUp/PageDown/arrows at FreshAgentView.tsx:513-557) actually work. Tab/pane activation (e.g. Ctrl+Shift+Tab) must still focus the composer. No defocus shortcut.

### Explicit constraints
- Clicking the transcript (or other non-composer regions) must allow focus to change — do NOT auto-refocus the composer on pointer-up in those regions.
- Tab/pane activation (e.g. Ctrl+Shift+Tab, clicking a tab, clicking into an inactive pane) must still focus the composer.
- Do NOT add a defocus shortcut (no Esc-to-defocus, no new keybinding to blur the composer). The fix is focus management on clicks, not a new shortcut.
- The existing transcript-scroll keys already exist (FreshAgentView.tsx:513-557) and must become usable once the composer is not auto-focused; no new key bindings.
- Red-Green-Refactor TDD with unit and e2e coverage.
- Work in the dedicated worktree `.worktrees/freshagent-click-focus` on branch `the-usual/freshagent-click-focus`, based on origin/main at b710d6ec8.
- The Node server is obsolete; do not modify it. Only client code changes are expected.

### Accepted tradeoffs and residuals
- The existing nav keys are already implemented but dead in practice because the composer always holds focus; this work revives them by fixing click/focus behavior, not by adding keys.
- No new keyboard shortcuts; only focus management changes.
- The "click pane background to focus the composer" convenience is removed; typing still routes to the composer via the existing plain-text funnel (`appendText` focuses the composer on the next animation frame), and pane activation re-focuses the composer.

**Goal:** Let a user click the transcript to read/scroll it with the existing keyboard nav keys, while keeping composer focus on tab/pane activation.

**Architecture:** Two coordinated client-only edits. (1) Make the transcript scroll container click-focusable by adding `tabIndex={-1}` — the browser then moves focus to it on click, the same way the pane root (already `tabIndex={-1}`) works. (2) Remove the `handlePanePointerUp` capture-phase handler that force-focused the composer on every pointer-up — this was the only thing yanking focus back after a transcript click. The existing `isActivePane` effect (FreshAgentView.tsx:2490-2504) is untouched and remains the sole mechanism that focuses the composer on tab/pane activation. Because `FreshAgentComposer.appendText` already calls `textareaRef.focus()` on the next animation frame (FreshAgentComposer.tsx:262), the plain-text funnel stays coherent: typing a printable char while the transcript has focus routes the char to the composer and re-focuses it automatically, so Enter still sends.

**Tech Stack:** React 18, Redux Toolkit, Vitest + React Testing Library (jsdom) for unit tests, Playwright (chromium) for e2e. No server changes.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions (existing code already follows this — new code must too).
- Path aliases: `@/` → `src/`, `@test/` → `test/`.
- No comments in production code unless asked.
- Follow existing test harness patterns: `createStore()` and `StoreBackedFreshAgentView`/direct render from `FreshAgentView.test.tsx`; e2e uses `window.__FRESHELL_TEST_HARNESS__` + `page.route` stubs.
- Do not modify the Node server (obsolete). No Rust server changes are required for this client-only focus change.
- The e2e spec must be cloud-legal (no real binary dependency). It stubs the freshclaude thread snapshot via `page.route` and suppresses sidecar network via `setFreshAgentNetworkEffectsSuppressed`, exactly like `fresh-agent.spec.ts` and `fresh-agent-mobile.spec.ts` (neither is in `CLOUD_SKIP_SPECS`).

## Load-bearing assumptions (verified during Stage 2)

1. **The `isActivePane` effect is the only activation-focus path and is independent of `handlePanePointerUp`.** Verified by inspection: FreshAgentView.tsx:2490-2504 is a `useEffect` keyed on `[isActivePane, composerDisabled]`; `handlePanePointerUp` (2702-2706) is a separate pointer handler bound via `onPointerUpCapture` (2763). Removing the pointer handler does not affect the effect.
2. **Clicking inside a pane dispatches `setActivePane`.** Verified: Pane.tsx:64-69 `handleMouseDown` calls `onFocus()`; PaneContainer.tsx:376-382 `handleFocus` dispatches `setActivePane({ tabId, paneId })`. So clicking an INACTIVE pane's transcript activates it → the `isActivePane` effect fires → composer focused (desired). Clicking the ALREADY-active pane's transcript dispatches `setActivePane` again but `isActivePane` is unchanged → effect does not re-fire → focus stays on the transcript (desired).
3. **`appendText` already re-focuses the composer.** Verified: FreshAgentComposer.tsx:259-263 `appendText` calls `setText(...)` then `requestAnimationFrame(() => textareaRef.current?.focus())`. So the plain-text funnel is self-coherent without any change.
4. **The transcript scroll container is the div at FreshAgentTranscript.tsx:1113-1122** with `ref={scrollerRef}`, `data-context="fresh-agent-transcript"`, and class `fresh-agent-transcript-scroll`. It has no `tabIndex` and no pointer handlers today. Adding `tabIndex={-1}` makes it click-focusable without entering the tab ring.
5. **jsdom focus behavior**: `element.focus()` moves `document.activeElement` to elements that have a `tabindex` attribute (including `-1`) or are natively focusable. A `<div>` without `tabindex` is NOT focusable — `focus()` is a no-op. This makes the `tabIndex` addition red-green testable: before, `scroller.focus()` is a no-op; after, it focuses.

---

### Task 1: Make the transcript click-focusable and remove the pointer-up composer refocus (unit tests)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:1113` (add `tabIndex={-1}` to the scroller div)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:2702-2706` (delete `handlePanePointerUp`)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:2763` (delete the `onPointerUpCapture={handlePanePointerUp}` binding)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (add a new `describe` block)

**Interfaces:**
- Consumes: existing `createStore()`, `setActivePane`, `FreshAgentView`, `screen`, `fireEvent`, `createEvent`, `act`, `waitFor` from the test file's existing imports (FreshAgentView.test.tsx:1-27).
- Produces: a transcript scroll container that is click-focusable (`tabindex="-1"`), and a pane root that no longer force-focuses the composer on pointer-up. No new exports or types.

- [ ] **Step 1: Write the failing behavioral tests**

Append this new `describe` block at the end of the top-level `describe` that contains the `faz3` and `0bc6` blocks (i.e., as a sibling of `describe('transcript keyboard scroll (faz3)', ...)` and `describe('composer focus on pane activation (0bc6)', ...)`). The closing of that outer `describe` is at FreshAgentView.test.tsx:6594 (`})`). Insert the new block immediately before that closing `})`.

```tsx
  describe('click-to-defocus transcript focus (c1fa)', () => {
    async function setupActivePane() {
      const store = createStore()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [
          { id: 'turn-c1fa-0', role: 'user', items: [{ id: 'item-c1fa-0', kind: 'text', text: 'User message c1fa' }] },
          { id: 'turn-c1fa-1', role: 'assistant', items: [{ id: 'item-c1fa-1', kind: 'text', text: 'Assistant reply c1fa' }] },
        ],
      })
      render(
        <Provider store={store}>
          <FreshAgentView
            tabId="tab-1"
            paneId="pane-1"
            paneContent={{
              kind: 'fresh-agent',
              sessionType: 'freshcodex',
              provider: 'codex',
              createRequestId: 'req-c1fa',
              sessionId: 'thread-c1fa',
              status: 'idle',
            }}
          />
        </Provider>,
      )
      await waitFor(() => expect(screen.getByText('Assistant reply c1fa')).toBeInTheDocument())
      const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
      const scroller = document.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      const textbox = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      // Activate the pane so the activation effect has fired and focused the composer.
      await act(async () => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      await waitFor(() => expect(document.activeElement).toBe(textbox))
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      return { store, root, scroller, textbox }
    }

    it('makes the transcript scroll container click-focusable (tabindex="-1")', async () => {
      const { scroller } = await setupActivePane()
      expect(scroller.getAttribute('tabindex')).toBe('-1')
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
    })

    it('does not force-focus the composer on pointer-up in the transcript region', async () => {
      const { root, textbox } = await setupActivePane()
      // Move focus to the pane root (already tabIndex={-1}) to simulate the user
      // having clicked a non-composer region.
      root.focus()
      expect(document.activeElement).toBe(root)
      const focusSpy = vi.spyOn(textbox, 'focus')
      fireEvent.pointerUp(root)
      // The removed handler deferred composerRef.focus() in a requestAnimationFrame;
      // flush the frame so a red run (handler still present) actually calls the
      // spy and fails, instead of passing vacuously before the rAF fires.
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(focusSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(root)
    })

    it('lets nav keys scroll the transcript once the transcript holds focus', async () => {
      const { scroller } = await setupActivePane()
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      const event = createEvent.keyDown(scroller, { key: 'PageDown' })
      fireEvent(scroller, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(660)
    })

    it('still funnels plain-text keys to the composer and re-focuses it', async () => {
      const { scroller, textbox } = await setupActivePane()
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      fireEvent(scroller, createEvent.keyDown(scroller, { key: 'h' }))
      expect(textbox.value).toBe('h')
      // appendText schedules textareaRef.focus() on the next animation frame;
      // flush it and assert focus returns to the composer (the load-bearing
      // refocus, assumption L3), so a regression that broke refocus would fail.
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(document.activeElement).toBe(textbox)
    })

    it('still focuses the composer when the pane is (re)activated after a transcript click', async () => {
      const { store, scroller, textbox } = await setupActivePane()
      // Simulate the user clicking the transcript (focus moves off the composer).
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      const focusSpy = vi.spyOn(textbox, 'focus')
      // Switch away and back — pane (re)activation must refocus the composer.
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-other' }))
      })
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(focusSpy).toHaveBeenCalled()
      expect(document.activeElement).toBe(textbox)
    })
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "click-to-defocus transcript focus" 2>&1`

Expected: FAIL because
- `makes the transcript scroll container click-focusable` fails: `scroller.getAttribute('tabindex')` is `null` (no tabindex attribute yet), and `scroller.focus()` is a no-op so `document.activeElement` is not the scroller.
- `does not force-focus the composer on pointer-up` fails: `fireEvent.pointerUp(root)` triggers the existing `handlePanePointerUp` capture handler which calls `composerRef.focus()`, so `focusSpy` is called.
- `lets nav keys scroll the transcript once the transcript holds focus` fails at `expect(document.activeElement).toBe(scroller)` because `scroller.focus()` is a no-op without `tabindex`.
- `still focuses the composer when the pane is (re)activated` fails at the first `expect(document.activeElement).toBe(scroller)` for the same reason.

The `still funnels plain-text keys` test may pass even before the change (the funnel fires on the keydown target regardless of focus) — that is acceptable; it is a regression guard, not the red discriminator.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, add `tabIndex={-1}` to the scroller div (currently at lines 1113-1122). The div already has `ref={scrollerRef}`, `className`, `data-context`, and `onScroll`. Add the attribute between `ref` and `className`:

```tsx
      <div
        ref={scrollerRef}
        tabIndex={-1}
        className="fresh-agent-transcript-scroll flex h-full flex-col gap-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3"
        data-context="fresh-agent-transcript"
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(computeAtBottom(node))
          recomputeGlom()
        }}
      >
```

In `src/components/fresh-agent/FreshAgentView.tsx`, delete the `handlePanePointerUp` handler (lines 2702-2706):

```tsx
    const handlePanePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
      if (isEditableTarget(event.target)) return
      if (window.getSelection()?.toString()) return
      requestAnimationFrame(() => composerRef.current?.focus())
    }
```

And delete the `onPointerUpCapture={handlePanePointerUp}` binding on the pane root div (line 2763), leaving `onKeyDownCapture={handlePaneKeyDown}` as the only remaining capture handler on that div:

```tsx
      <div
        ref={paneRootRef}
        tabIndex={-1}
        className={cn(
          'fresh-agent-pane relative flex h-full min-h-0 flex-col overflow-hidden',
          `fresh-agent-style-${activeStyle}`,
        )}
        data-context="fresh-agent"
        data-style={activeStyle}
        data-tab-id={tabId}
        data-pane-id={paneId}
        data-session-id={contextSessionId}
        data-provider={paneContent.provider}
        data-session-type={paneContent.sessionType}
        style={{ '--fresh-transcript-font-size': `${terminalFontSize}px` } as CSSProperties}
        onKeyDownCapture={handlePaneKeyDown}
      >
```

After deleting `handlePanePointerUp`, the `ReactPointerEvent` import (FreshAgentView.tsx:10, `type PointerEvent as ReactPointerEvent,`) becomes unused — it has no other references in the file (verified: only line 2702 used it). Remove that line from the React import block so the typecheck stays clean:

```tsx
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
```

`isEditableTarget` (FreshAgentView.tsx:494-497) stays — it is still used in `handlePaneKeyDown` (line 2713) and the activation effect (line 2496).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "click-to-defocus transcript focus" 2>&1`

Expected: PASS (all five tests green).

- [ ] **Step 5: Refactor while green**

The implementation already folds in the only cleanup the change needs (removing the now-unused `ReactPointerEvent` import). Confirm no dangling references to `handlePanePointerUp` remain anywhere in the repo:

Run: `rg -n "handlePanePointerUp" src/ test/ 2>&1`

Expected: no matches.

- [ ] **Step 6: Run impacted-test verification**

This change touches FreshAgentView focus/pointer behavior. The impacted set is the whole fresh-agent component test suite (callers of `FreshAgentView`, and tests that render it) plus the typecheck and the repo-required a11y lint (the `tabIndex={-1}` addition must not trip `eslint-plugin-jsx-a11y` — a `<div>` scroll container with `tabIndex={-1}` is a permitted non-interactive tabstop, but confirm via lint):

Run: `npm run typecheck 2>&1 && npm run lint 2>&1 && npm run test:vitest -- run test/unit/client/components/fresh-agent 2>&1`

Expected: PASS (typecheck clean; lint clean; all 440+ fresh-agent unit tests green, including the existing `faz3` keyboard-scroll tests and `0bc6` activation-focus tests which must not regress).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix(fresh-agent): let clicks move focus off the composer onto the transcript

Remove the pointer-up capture handler that force-focused the composer on
every click, and make the transcript scroll container click-focusable
(tabIndex=-1). The existing isActivePane effect still focuses the composer
on tab/pane activation (Ctrl+Shift+Tab, tab click, clicking an inactive
pane). Existing transcript nav keys (Home/End/PageUp/PageDown/arrows) now
work once the user clicks the transcript, because focus is no longer
yanked back to the composer. The plain-text funnel stays coherent because
FreshAgentComposer.appendText already re-focuses the composer on the next
animation frame."
```

---

### Task 2: E2e proof that clicking the transcript defocuses the composer and enables scroll keys (Playwright)

**Files:**
- Create: `test/e2e-browser/specs/freshagent-click-focus.spec.ts`
- Test: the same file (e2e spec is its own test)

**Interfaces:**
- Consumes: the `test`/`expect` fixtures from `../helpers/fixtures.js` (`{ freshellPage, page, harness, terminal }`), the `window.__FRESHELL_TEST_HARNESS__` dispatch/suppress API, and `page.route` for stubbing the freshclaude thread snapshot. These are the same primitives used by `fresh-agent.spec.ts` and `fresh-agent-mobile.spec.ts`.
- Produces: one new cloud-legal e2e spec (not added to `CLOUD_SKIP_SPECS`).

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e-browser/specs/freshagent-click-focus.spec.ts`:

```ts
import { test, expect } from '../helpers/fixtures.js'

test.describe('Fresh Agent click-to-defocus', () => {
  test('clicking the transcript moves focus off the composer so scroll keys work, and real pane re-activation refocuses the composer', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const terminalPaneId = layout.id as string
    const freshPaneId = 'pane-c1fa-e2e'

    const sessionId = '63333000-0000-4333-8333-00000000c1fa'

    await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshclaude',
          provider: 'claude',
          threadId: sessionId,
          sessionId,
          revision: 1,
          latestTurnId: 'turn-c1fa-agent',
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
          settings: { model: 'opus[1m]', permissionMode: 'default', plugins: [] },
          tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          turns: [
            {
              id: 'turn-c1fa-user',
              turnId: 'turn-c1fa-user',
              role: 'user',
              summary: 'Scroll me',
              items: [{ id: 'item-c1fa-user', kind: 'text', text: 'Scroll me.' }],
            },
            {
              id: 'turn-c1fa-agent',
              turnId: 'turn-c1fa-agent',
              role: 'assistant',
              summary: 'A tall transcript body',
              items: [{
                id: 'item-c1fa-agent',
                kind: 'text',
                text: 'A tall transcript body.\n\n' + Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog.`).join('\n\n'),
              }],
            },
          ],
          extensions: { claude: { liveSessionId: sessionId, cliSessionId: sessionId } },
        }),
      })
    })

    // Split the terminal pane: the original stays a terminal (a real second pane
    // to click away to), the new pane is the fresh-agent. This lets the
    // reactivation proof exercise a genuine click-to-activate path instead of a
    // direct Redux dispatch.
    await page.evaluate(({ currentTabId, currentTerminalPaneId, currentFreshPaneId, currentSessionId }) => {
      window.__FRESHELL_TEST_HARNESS__?.setFreshAgentNetworkEffectsSuppressed(currentFreshPaneId, true)
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId: currentTabId,
          paneId: currentTerminalPaneId,
          direction: 'horizontal',
          newPaneId: currentFreshPaneId,
          newContent: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-c1fa-e2e',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, { currentTabId: tabId, currentTerminalPaneId: terminalPaneId, currentFreshPaneId: freshPaneId, currentSessionId: sessionId })

    const freshPane = page.locator(`[data-context="fresh-agent"][data-pane-id="${freshPaneId}"]`)
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })
    const input = freshPane.getByRole('textbox', { name: 'Chat message input' })
    await expect(input).toBeEnabled({ timeout: 10_000 })

    // On activation the new fresh-agent pane's composer holds focus.
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 10_000 }).toBe('Chat message input')

    // Click the transcript body (not the composer). The browser moves focus
    // onto the now-focusable transcript scroller (tabindex="-1").
    await scroller.click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('data-context') : null
    }), { timeout: 5_000 }).toBe('fresh-agent-transcript')

    // With focus on the transcript, the existing nav-key handler now receives a
    // non-interactive target. The transcript loads at the BOTTOM (atBottom=true;
    // a layout effect pins scrollTop=scrollHeight on signature change), so first
    // jump to the TOP with Home, then prove PageDown scrolls DOWN from there.
    await page.keyboard.press('Home')
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBe(0)

    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    await page.keyboard.press('PageDown')
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(before)

    // End jumps back to the bottom. Browsers clamp scrollTop to scrollHeight -
    // clientHeight (the repo uses this exact formula in resume-button.spec.ts),
    // so assert against the real maximum, not scrollHeight itself.
    await page.keyboard.press('End')
    const maxScroll = await scroller.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight)
    await expect.poll(async () => scroller.evaluate((el: HTMLElement) => el.scrollTop), { timeout: 5_000 }).toBe(maxScroll)

    // Real pane re-activation: click the sibling terminal pane's xterm (the
    // repo's standard click-to-focus-a-terminal pattern, e.g.
    // page.locator('.xterm').first().click() in silent-input-loss-rust.spec.ts),
    // which focuses the terminal and deactivates + defocuses the fresh-agent
    // composer. Then click back into the fresh-agent transcript: the mousedown
    // dispatches setActivePane -> isActivePane flips true -> the activation
    // effect refocuses the composer, overriding the transcript's click-focus.
    // This is the genuine user-facing path the request requires, not a direct
    // Redux dispatch.
    const terminalPane = page.locator(`[data-context="pane"][data-pane-id="${terminalPaneId}"]`)
    await terminalPane.locator('.xterm').click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 5_000 }).not.toBe('Chat message input')

    await scroller.click()
    await expect.poll(async () => page.evaluate(() => {
      const el = document.activeElement
      return el ? el.getAttribute('aria-label') : null
    }), { timeout: 10_000 }).toBe('Chat message input')
  })
})
```

- [ ] **Step 2: Run the e2e test and verify the intended failure (before Task 1 lands, this fails; after Task 1, it passes)**

This task depends on Task 1's production change being committed. The repo-owned local e2e path is `npm run test:e2e:local`, which wraps `scripts/e2e-cloud.sh run --local` and passes positional spec paths and `--grep=`/`--project=` flags through to `npx playwright test --config test/e2e-browser/playwright.config.ts`. The new spec is not in `RUST_ONLY_SPECS` nor `MATRIX_SPECS`, so a file-scoped run executes it only under the default `chromium` project (fixture-default server kind), exactly like `fresh-agent.spec.ts` and `fresh-agent-mobile.spec.ts`.

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshagent-click-focus.spec.ts 2>&1`

Expected (before Task 1, or if run in isolation without Task 1): FAIL because clicking the transcript does not move focus to it (no `tabindex`), so `data-context` of `activeElement` is not `fresh-agent-transcript`, and the subsequent nav keys do nothing (the composer still has focus; the nav-key handler sees an interactive target and does not scroll).

Expected (after Task 1 is committed): PASS — the fresh-agent pane splits alongside a terminal pane; on activation its composer holds focus; clicking the transcript moves focus to the scroller; Home jumps to top (scrollTop=0); PageDown scrolls down (scrollTop>0); End jumps to bottom (scrollTop=scrollHeight-clientHeight); clicking the terminal pane deactivates and defocuses the composer; clicking the fresh-agent transcript re-activates the pane and the activation effect refocuses the composer.

- [ ] **Step 3: Add no production implementation (it already exists from Task 1)**

This task is pure e2e coverage; the production change landed in Task 1. No production code to add here. If the e2e fails after Task 1, the implementer must investigate whether the real-browser focus behavior differs from the jsdom model (e.g., whether clicking a scrollbar vs. transcript text matters, or whether `scroller.click()` lands on an inner article element instead of the scroller itself — in that case use `scroller.locator(':scope').click()` or click a transcript text node, and verify `activeElement` is the scroller or a non-interactive descendant) and fix the spec or, only if the production change is genuinely insufficient, amend Task 1's implementation — but do not add new keybindings or a defocus shortcut (that is out of scope per the User Request).

- [ ] **Step 4: Run the focused e2e test**

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshagent-click-focus.spec.ts 2>&1`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

No refactor needed — the spec is a single linear test. Confirm the spec file is NOT added to `CLOUD_SKIP_SPECS` in `test/e2e-browser/playwright.cloud.config.ts` (it is cloud-legal — it stubs the thread snapshot via `page.route` and suppresses sidecar network, mirroring `fresh-agent.spec.ts` which is also not skipped). Confirm the file is picked up by the default `chromium` project and not excluded by `grepInvert`.

- [ ] **Step 6: Run impacted-test verification**

The impacted set for an e2e-only addition is the new spec plus the existing `fresh-agent.spec.ts` (the closest neighbor that uses the same stubbed-thread + suppressed-sidecar pattern) to confirm no shared-fixture regression. The broader regression (full coordinated e2e + unit + server suite) is run once on the final `HEAD` by the usual workflow's execution stage (Stage 4) full-suite gate after all tasks complete; this task's Step 6 is the focused per-task gate, not that final gate.

Run: `npm run test:e2e:local -- test/e2e-browser/specs/freshagent-click-focus.spec.ts test/e2e-browser/specs/fresh-agent.spec.ts 2>&1`

Expected: PASS (both spec files green under the `chromium` project).

If the configured `FRESHELL_E2E_BACKEND` is `cloud`, also confirm the new spec is not skipped in cloud: run `npm run test:e2e:cloud -- test/e2e-browser/specs/freshagent-click-focus.spec.ts 2>&1` and expect PASS. If `FRESHELL_E2E_BACKEND` is unset, ask the user which backend to use before running cloud e2e (per AGENTS.md). The local run is the required gate; the cloud run is confirmation only.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshagent-click-focus.spec.ts
git commit -m "test(e2e): cover fresh-agent click-to-defocus and scroll-key reactivation

Add a cloud-legal Playwright spec proving that clicking the transcript
moves focus onto it (tabindex=-1), PageDown scrolls, Home jumps to top,
and switching away and back re-focuses the composer via the activation
effect. Stubs the freshclaude thread snapshot via page.route and suppresses
sidecar network, mirroring fresh-agent.spec.ts."
```

---

## Out of scope

- No new keyboard shortcuts (no Esc-to-defocus, no Ctrl+L, no search).
- No Node server changes (obsolete).
- No Rust server changes (this is a client-only focus change).
- No changes to the plain-text funnel logic (`handlePaneKeyDown`) — it already routes printable chars to the composer via `appendText`, which re-focuses it.
- No changes to the `isActivePane` activation effect — it remains the sole activation-focus mechanism.
- No changes to the existing transcript nav-key handler (`isTranscriptNavigationKey` / `scrollTranscriptByKey`) — it already works; it was just unreachable.

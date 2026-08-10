# Fix Android Long-Press Context-Menu Race Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** On touch devices (Android especially), press-and-hold must open the context menu and keep it open — today the menu opens and is instantly dismissed (and can silently fire the top menu item's action).

**Architecture:** Two unsynchronized paths open the shared context menu on touch long-press: the provider's own 500 ms JS timer (which arms `suppressNextTouchEnd`) and the native `contextmenu` DOM event Android fires mid-gesture (which does NOT arm it). Fix 1 unifies both open paths inside `ContextMenuProvider` so whichever path opens the menu, the touch release is suppressed and the loser path is cancelled. Fix 2 removes TabsView's duplicate, unguarded menu entirely by routing its card menu through the shared provider (new `tabs-card` context id), so cards get long-press, release suppression, keyboard access, and outside-click dismissal from the one guarded mechanism. Shared tab-open logic moves to a lib module so the provider, `menu-defs.ts`, and TabsView all reuse it without duplication or import cycles.

**Validated failure mechanism (load-bearing pass, 2026-08-09):** Chromium-Android source shows a recognized long-press forecloses tap-click synthesis (`GestureLongTap` is a no-op on Android), so the primary Android killer is NOT a browser-synthesized click landing on the menu. It is the un-cancelled 500 ms timer firing after the native `contextmenu` already opened the menu: the timer's `document.elementFromPoint` probe hits the just-opened menu, the `data-context` walk fails, and the `Global` fallback menu replaces the correct menu directly under the user's finger. Fix 1's timer cancellation cures exactly this. Release suppression stays load-bearing for the timer-first ordering (release before the browser's own long-press threshold — the already-shipped iOS-path contract, which Fix 1 must not regress) and for non-Chromium engines. A post-open finger-drift scroll can still close the menu via the provider's capture-scroll listener — a plausible co-cause only a real-device trace can size; see the residual-risks addendum in the Self-Review section. Full evidence ledger: `../../../.the-usual-logs/longpress-contextmenu-race/load-bearing-ledger.md`.

**Tech Stack:** React 18 + Redux Toolkit, TypeScript, Vitest + jsdom + React Testing Library (`test/setup/dom.ts`), lucide-react icons.

## Global Constraints

- Worktree root (all paths below are relative to it): `/home/dan/code/freshell/.worktrees/longpress-contextmenu-race` — run every command from this directory.
- **Line-number anchors are pre-plan.** Every `file:line` in this plan was verified against plan-authoring HEAD and is a hint, not an address: earlier tasks shift later anchors in the same files (Task 1 grows `ContextMenuProvider.tsx` ~+20 lines above the spans Task 5 cites; Task 3 removes ~250 lines from `TabsView.tsx` above everything Task 6 cites). Locate code by the named symbols and quoted snippets; treat line numbers as approximate once any earlier task has touched the file.
- TDD is mandatory (repo AGENTS.md): Red → Green → Refactor for every task; write the failing test first and run it to see it fail before implementing.
- Focused single-file test command (the ONLY sanctioned focused path):
  `npm run test:vitest -- run <test-file> --config config/vitest/vitest.config.ts`
- Broad runs go through the coordinator: `npm run test:unit`, `npm test`. Typecheck: `npm run typecheck:client`. Lint: `npm run lint`.
- A `console.error` during any test FAILS that test (global trap in `test/setup/dom.ts`). React `act()` warnings surface as `console.error`.
- Tests run shuffled and in parallel — no cross-test state; keep `cleanup()` in `afterEach`.
- Commit author must be `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (never `dan@danshapiro.com`). Do NOT create a PR (no `gh pr create`) — the workflow handles review. Never restart the live self-hosted server (port 3001).
- Behaviors that MUST stay green (existing tests cover them; run them in every task's verify step): desktop right-click menus (`test/unit/client/components/ContextMenuProvider.test.tsx`), iOS custom-timer long-press with release suppression (commit 9383c2fb8), >10 px move-tolerance cancellation, `touchcancel` handling, and native-menu passthrough for inputs/links/`data-native-context` (`test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`, 11 tests).
- README.md is the only end-user markdown doc — do not create new docs. `docs/index.html` does not need updating (bug fix, no new UI surface).
- Path aliases: `@/` → `src/`, `@test/` → `test/`. Client code (`src/`) uses extensionless imports.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/components/context-menu/ContextMenuProvider.tsx` | Modify | Fix 1: unify touch open paths; Fix 2: select registry state + tabs-card action callbacks |
| `src/components/context-menu/context-menu-constants.ts` | Modify | Add `ContextIds.TabsCard` |
| `src/components/context-menu/context-menu-types.ts` | Modify | Add `tabs-card` `ContextTarget` variant |
| `src/components/context-menu/context-menu-utils.ts` | Modify | Add `parseContextTarget` case for `tabs-card` |
| `src/components/context-menu/menu-defs.ts` | Modify | Build tabs-card menu items; new `MenuActions` entries + optional `MenuBuildContext` fields |
| `src/lib/tab-registry-open.ts` | Create | Shared, React-free tab-registry helpers: pane-kind presentation, record sanitization (moved from TabsView), open/jump actions, tabKey lookup |
| `src/components/TabsView.tsx` | Modify | Delete local menu; cards declare `data-context`; card actions call shared lib |
| `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx` | Modify | Race regression tests (Fix 1) + tabs-card long-press tests (Fix 2) |
| `test/unit/client/components/context-menu/context-menu-utils.test.ts` | Modify | `parseContextTarget` tabs-card cases |
| `test/unit/client/components/context-menu/menu-defs.test.ts` | Modify | tabs-card item-building cases; extend `createMockActions` |
| `test/unit/client/lib/tab-registry-open.test.ts` | Create | Unit tests for the shared open/jump/lookup functions |
| `test/unit/client/components/ContextMenuProvider.test.tsx` | Modify | Mouse-path tabs-card tests through the real provider |
| `test/unit/client/components/TabsView.test.tsx` | Modify | Rewrap the 2 menu tests in the real provider |
| `test/unit/client/components/TabsView.memo.test.tsx` | Modify | Replace the render-count probe (it counted `<ContextMenu>` renders) |

Scope check: both fixes serve one user story (touch long-press context menus work) and share the provider mechanism — one plan, one worktree, sequential tasks.

---

### Task 1: Unify the two touch open paths in ContextMenuProvider (the core race fix)

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx:978-1112` (the document-listener `useEffect`)
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`

**Interfaces:**
- Consumes: nothing new — internal to the provider's listener effect.
- Produces: behavioral guarantee later tasks rely on: *any* `contextmenu` event that arrives during an active touch gesture arms `suppressNextTouchEnd = true` and cancels the pending long-press timer; a `contextmenu` arriving after the timer already opened the menu is swallowed (no second `openMenu`); the race branch opens the menu at the touch-session start position (event coordinates only as fallback).

Background (verified file:line facts):
- `handleContextMenu` is at lines 979-997; it early-returns only on `shouldUseNativeMenu` (line 983) and never touches the long-press state.
- The long-press state is three effect-scoped `let`s at lines 1023-1026 (`longPressTimer`, `touchStartPos`, `suppressNextTouchEnd`), declared *after* `handleContextMenu`.
- `handleTouchStart` (1028-1067) arms `suppressNextTouchEnd = true` at line 1057 only inside its 500 ms timer callback.
- `handleTouchEnd` (1083-1094) calls `e.preventDefault()` only when `suppressNextTouchEnd && e.type === 'touchend'`.
- Listener registration at 1096-1101: `contextmenu` capture; `touchstart`/`touchmove` passive; `touchend`/`touchcancel` non-passive.

Mechanism note (validated 2026-08-09): on Chromium-Android an un-suppressed release after a native `contextmenu` does NOT synthesize a click (`GestureLongTap` is a no-op there) — the click-suppression tests below still matter because that contract protects the timer-first ordering (release before the browser's long-press threshold) and non-Chromium engines. The decisive Android cure in this task is cancelling the pending timer (test 2) and swallowing the duplicate open (test 3). `handleTouchStart`'s own arming at line 1057 must stay untouched. Post-open `touchmove` cannot disarm the flag on either path: the clear at line 1079 is gated on `touchStartPos && longPressTimer`, and both open paths null `touchStartPos` (verified — parity with the shipped iOS path).

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`, add a module-level helper next to the existing `simulateTouch` helper (after line ~123):

```tsx
function simulateNativeContextMenu(target: Element, clientX = 100, clientY = 100) {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  })
  target.dispatchEvent(event)
  return event
}
```

Then add these three tests inside the existing `describe('ContextMenuProvider long-press', ...)` block (they reuse the suite's `vi.useFakeTimers()` + `elementFromPointMock` setup):

```tsx
  it('keeps the menu open when a native contextmenu wins the long-press race (Android)', () => {
    const { store } = renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })

    // Android fires a real (trusted) contextmenu event mid-gesture,
    // BEFORE our 500ms JS timer fires.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()

    // Finger lifts. On click-synthesizing engines (iOS-like; Chromium-Android
    // does not synthesize one after a native contextmenu) an unsuppressed
    // release becomes a click at (100,100) -- exactly where the menu's
    // top-left (first item) now sits.
    const firstItem = screen.getAllByRole('menuitem')[0]
    act(() => {
      const release = simulateTouch('touchend', firstItem, 100, 100)
      if (!release.defaultPrevented) {
        firstItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    // Any menu-item click also closes the menu, so "menu still open" proves
    // no item action fired.
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(store.getState().tabs.tabs).toHaveLength(2)
  })

  it('cancels the pending long-press timer when a native contextmenu opens the menu mid-gesture', () => {
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
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // The custom long-press timer must have been cancelled: its callback is
    // the only code path that calls document.elementFromPoint.
    elementFromPointMock.mockClear()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(elementFromPointMock).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('ignores a native contextmenu that arrives after the long-press timer already opened the menu', () => {
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

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('100px')

    // Some Android browsers fire contextmenu AFTER the 500ms threshold --
    // i.e. after our timer already opened the menu for this same gesture.
    // Re-opening would jump the menu position and corrupt focus restore.
    act(() => {
      simulateNativeContextMenu(target, 300, 300)
    })

    const menuAfter = screen.getByRole('menu')
    expect(menuAfter).toBeInTheDocument()
    expect(menuAfter.style.left).toBe('100px')
  })

  it('opens the menu at the touch-session position when the native contextmenu reports drifted coords', () => {
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
      vi.advanceTimersByTime(100)
    })
    // Mid-gesture native contextmenu with coordinates that drifted away from
    // the touch start (some engines report offset/degenerate coords). The
    // unified handler must prefer the live touch-session position.
    act(() => {
      simulateNativeContextMenu(target, 300, 300)
    })

    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('100px')
  })
```

Note: `renderWithProvider` already returns `{ store, ...utils }` in this file — destructure `store` only where used.

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx --config config/vitest/vitest.config.ts
```
Expected: the 11 pre-existing tests PASS; the 4 new tests FAIL:
- test 1 fails at the final `getByRole('menu')` (menu was closed by the synthesized click),
- test 2 fails at `expect(elementFromPointMock).not.toHaveBeenCalled()`,
- test 3 fails at `expect(menuAfter.style.left).toBe('100px')` (it will be `300px`),
- test 4 fails at `expect(menu.style.left).toBe('100px')` (the un-unified handler opens at the event coords, `300px`).

- [ ] **Step 3: Implement the unified open path**

In `src/components/context-menu/ContextMenuProvider.tsx`, inside the `useEffect` that starts at line 978:

3a. MOVE the three state declarations currently at lines 1023-1026 (under the comment `// --- Long-press (touch hold) detection for mobile ---`) so they are the FIRST statements of the effect body, ABOVE `handleContextMenu`. Delete them from their old location. The moved block becomes:

```ts
    // --- Long-press (touch hold) state ---
    // Shared by BOTH open paths: the custom 500ms timer below AND the native
    // `contextmenu` event Android fires mid-gesture. Declared before the
    // handlers so handleContextMenu can coordinate with the touch session.
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    let touchStartPos: { x: number; y: number } | null = null
    let suppressNextTouchEnd = false
```

3b. Replace `handleContextMenu` (currently lines 979-997) with:

```ts
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const contextEl = findContextElement(target)
      const contextId = resolveContextId(contextEl?.dataset.context)
      if (shouldUseNativeMenu(target, contextId, contextEl, e)) return

      e.preventDefault()

      // Android race, case A: our long-press timer already opened the menu
      // for this gesture (suppressNextTouchEnd is armed until touchend).
      // Swallow the OS contextmenu -- re-opening would jump the menu and
      // corrupt focus restoration.
      if (suppressNextTouchEnd) return

      // Android race, case B: a touch gesture is still in flight and the
      // native contextmenu won the race. Cancel our timer so it cannot
      // re-fire into the just-opened menu (its elementFromPoint probe would
      // hit the menu and replace it with the Global fallback), and arm
      // release suppression for engines that DO synthesize a click from
      // this gesture (iOS-like; Chromium-Android does not). Prefer the
      // touch-session start position over the event coords — identical on
      // Chromium, and it hardens against engines reporting drifted or
      // degenerate contextmenu coordinates.
      let position = { x: e.clientX, y: e.clientY }
      if (touchStartPos !== null || longPressTimer !== null) {
        if (touchStartPos) {
          position = { x: touchStartPos.x, y: touchStartPos.y }
        }
        if (longPressTimer) {
          clearTimeout(longPressTimer)
          longPressTimer = null
        }
        touchStartPos = null
        suppressNextTouchEnd = true
      }

      const dataset = contextEl?.dataset ? copyDataset(contextEl.dataset) : {}
      const parsed = parseContextTarget(contextId as any, dataset)
      const targetObj = parsed || { kind: 'global' as const }

      openMenu({
        position,
        target: targetObj,
        contextElement: contextEl,
        clickTarget: target,
        dataset,
      })
    }
```

Nothing else in the effect changes: `handleTouchStart`/`handleTouchMove`/`handleTouchEnd` and the listener registrations (lines 1096-1111) stay exactly as they are. (Desktop is untouched: with no touch session both guards are no-ops. `suppressNextTouchEnd` is only ever `true` between the timer firing and the next `touchend`/`touchmove`-cancel, which cannot happen on a mouse-only flow.)

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx --config config/vitest/vitest.config.ts
```
Expected: 15/15 PASS.

Regression sweep for the sibling suites:
```bash
npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts
npm run typecheck:client
```
Expected: PASS (desktop right-click, keyboard, native passthrough all unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "fix(context-menu): suppress touch release when native contextmenu wins the long-press race"
```

---

### Task 2: Add the `tabs-card` context id, target variant, and parser case

**Files:**
- Modify: `src/components/context-menu/context-menu-constants.ts` (19-line file)
- Modify: `src/components/context-menu/context-menu-types.ts:4-26` (`ContextTarget` union)
- Modify: `src/components/context-menu/context-menu-utils.ts:31-101` (`parseContextTarget`)
- Test: `test/unit/client/components/context-menu/context-menu-utils.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ContextIds.TabsCard === 'tabs-card'`; `ContextTarget` variant `{ kind: 'tabs-card'; tabKey: string; status: 'open' | 'closed' }`; `parseContextTarget(ContextIds.TabsCard, { tabKey, tabStatus }) → { kind: 'tabs-card', tabKey, status }` with `status` defaulting to `'open'` unless `tabStatus === 'closed'` (or `null` when `tabKey` missing). `tabKey` is `${deviceId}:${tabId}` (`src/lib/tab-registry-snapshot.ts:111`) but is NOT unique across the four registry groups — validated 2026-08-09: `localOpen` is rebuilt live from `state.tabs` while `closed`/`remoteOpen` come from sync snapshots, so a same-device second window can put one `tabKey` in both `localOpen` and `closed` (no cross-group dedup exists in `selectTabsRegistryGroups` or TabsView). The `status` discriminator keeps a "Recently closed" card's menu resolving to the closed record it rendered.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/components/context-menu/context-menu-utils.test.ts`, append inside the single `describe('parseContextTarget', ...)` block (before the closing `})` at line 102):

```ts
  it('parseContextTarget for TabsCard returns tabs-card target with tabKey and status', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabKey: 'device-a:tab-1', tabStatus: 'closed' })
    expect(result).toEqual({ kind: 'tabs-card', tabKey: 'device-a:tab-1', status: 'closed' })
  })

  it('parseContextTarget for TabsCard defaults status to open', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabKey: 'device-a:tab-1' })
    expect(result).toEqual({ kind: 'tabs-card', tabKey: 'device-a:tab-1', status: 'open' })
  })

  it('parseContextTarget for TabsCard returns null without tabKey', () => {
    const result = parseContextTarget(ContextIds.TabsCard, { tabStatus: 'closed' })
    expect(result).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/client/components/context-menu/context-menu-utils.test.ts --config config/vitest/vitest.config.ts
```
Expected: the first two new tests FAIL (`ContextIds.TabsCard` is `undefined`, so `parseContextTarget` hits the `default:` branch and returns `null`). Existing tests pass.

- [ ] **Step 3: Implement**

3a. `src/components/context-menu/context-menu-constants.ts` — add one entry to `ContextIds` (after `FreshAgent: 'fresh-agent',` at line 16):

```ts
  TabsCard: 'tabs-card',
```

3b. `src/components/context-menu/context-menu-types.ts` — add one variant at the end of the `ContextTarget` union (after the `fresh-agent` member that ends at line 26):

```ts
  | { kind: 'tabs-card'; tabKey: string; status: 'open' | 'closed' }
```

3c. `src/components/context-menu/context-menu-utils.ts` — add a case to `parseContextTarget`, after the `ContextIds.FreshAgent` case (before `default:` at line 98):

```ts
    case ContextIds.TabsCard:
      return data.tabKey
        ? { kind: 'tabs-card', tabKey: data.tabKey, status: data.tabStatus === 'closed' ? 'closed' : 'open' }
        : null
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/context-menu/context-menu-utils.test.ts --config config/vitest/vitest.config.ts
npm run typecheck:client
```
Expected: PASS. (Typecheck confirms no exhaustiveness break: `buildMenuItems` uses an if-chain, not an exhaustive switch, so the new kind is tolerated until Task 4 handles it.)

- [ ] **Step 5: Commit**

```bash
git add src/components/context-menu/context-menu-constants.ts src/components/context-menu/context-menu-types.ts src/components/context-menu/context-menu-utils.ts test/unit/client/components/context-menu/context-menu-utils.test.ts
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "feat(context-menu): add tabs-card context id, target and parser"
```

---

### Task 3: Extract shared tab-registry open helpers into `src/lib/tab-registry-open.ts`

**Files:**
- Create: `src/lib/tab-registry-open.ts`
- Modify: `src/components/TabsView.tsx` (move helpers out; re-export `sanitizePaneSnapshot` for compatibility)
- Test: `test/unit/client/lib/tab-registry-open.test.ts` (create)

**Interfaces:**
- Consumes: existing Redux action creators `addTab`, `setActiveTab` (`@/store/tabsSlice`), `addPane`, `initLayout` (`@/store/panesSlice`); `AppDispatch` type from `@/store/store`.
- Produces (exact signatures later tasks use):

```ts
export type TabsRegistryGroups = {
  localOpen: RegistryTabRecord[]
  sameDeviceOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
}
export function findRecordByTabKey(groups: TabsRegistryGroups, tabKey: string, status?: RegistryTabRecord['status']): RegistryTabRecord | undefined
export type OpenTabRecordDeps = {
  dispatch: AppDispatch
  localServerInstanceId?: string
  onOpened?: () => void
}
export function openRecordAsUnlinkedCopy(record: RegistryTabRecord, deps: OpenTabRecordDeps): void
export function openPaneInNewTab(record: RegistryTabRecord, pane: RegistryPaneSnapshot, deps: OpenTabRecordDeps): void
export function jumpToRecord(record: RegistryTabRecord, deps: OpenTabRecordDeps & { hasLocalTab: (tabId: string) => boolean }): void
export function paneKindIcon(kind: RegistryPaneSnapshot['kind']): LucideIcon
export function paneKindColorClass(kind: RegistryPaneSnapshot['kind']): string
export function paneKindLabel(kind: RegistryPaneSnapshot['kind']): string
export function sanitizePaneSnapshot(record: RegistryTabRecord, rawSnapshot: RegistryPaneSnapshot, localServerInstanceId?: string): PaneContentInput
```

Rationale: TabsView's three card actions (`jumpToRecord`, `openRecordAsUnlinkedCopy`, `openPaneInNewTab`, currently `TabsView.tsx:603-654`) are needed by BOTH the provider (menu items, Task 5) and TabsView itself (card left-click `onAction` and the "Pull all" button). They must be shared, not duplicated. They depend on `sanitizePaneSnapshot` + `deriveModeFromRecord`, so those move too; `paneKind*` move because `menu-defs.ts` (Task 4) must not import a React component module. `test/unit/client/tab-registry-fresh-agent-migration.test.ts:3` imports `sanitizePaneSnapshot` from `@/components/TabsView`, so TabsView keeps a re-export.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/lib/tab-registry-open.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  findRecordByTabKey,
  jumpToRecord,
  openPaneInNewTab,
  openRecordAsUnlinkedCopy,
  type TabsRegistryGroups,
} from '@/lib/tab-registry-open'
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
import type { AppDispatch } from '@/store/store'

function makeRecord(overrides: Partial<RegistryTabRecord> = {}): RegistryTabRecord {
  return {
    tabKey: 'device-a:tab-9',
    tabId: 'tab-9',
    serverInstanceId: 'srv-1',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    tabName: 'My Tab',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makeGroups(overrides: Partial<TabsRegistryGroups> = {}): TabsRegistryGroups {
  return { localOpen: [], sameDeviceOpen: [], remoteOpen: [], closed: [], ...overrides }
}

describe('findRecordByTabKey', () => {
  it('finds a record in any group', () => {
    const record = makeRecord()
    expect(findRecordByTabKey(makeGroups({ remoteOpen: [record] }), 'device-a:tab-9')).toBe(record)
    expect(findRecordByTabKey(makeGroups({ closed: [record] }), 'device-a:tab-9')).toBe(record)
    expect(findRecordByTabKey(makeGroups({ localOpen: [record] }), 'device-a:tab-9')).toBe(record)
  })

  it('returns undefined for an unknown tabKey', () => {
    expect(findRecordByTabKey(makeGroups(), 'nope')).toBeUndefined()
  })

  it('prefers the record whose status matches when a tabKey exists in two groups', () => {
    // Same-device multi-window can put one tabKey in localOpen AND closed
    // (live-rebuilt localOpen vs. retained closed tombstone) — validated
    // 2026-08-09; the status discriminator resolves the card's own record.
    const open = makeRecord()
    const closed = makeRecord({ status: 'closed', closedAt: 3 })
    const groups = makeGroups({ localOpen: [open], closed: [closed] })
    expect(findRecordByTabKey(groups, 'device-a:tab-9', 'closed')).toBe(closed)
    expect(findRecordByTabKey(groups, 'device-a:tab-9', 'open')).toBe(open)
    expect(findRecordByTabKey(groups, 'device-a:tab-9')).toBe(open)
  })
})

describe('openRecordAsUnlinkedCopy', () => {
  it('creates a new tab with a terminal fallback layout when the record has no panes', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const onOpened = vi.fn()
    openRecordAsUnlinkedCopy(makeRecord(), { dispatch, onOpened })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
    expect(calls[0].payload).toMatchObject({
      title: 'My Tab',
      mode: 'shell',
      status: 'creating',
      serverInstanceId: 'srv-1',
    })
    expect(calls[1].type).toBe(initLayout.type)
    expect(calls[1].payload.content).toMatchObject({ kind: 'terminal', mode: 'shell' })
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('adds one pane per extra snapshot', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'sh', payload: {} },
        { paneId: 'p2', kind: 'browser', title: 'docs', payload: {} },
      ],
    })
    openRecordAsUnlinkedCopy(record, { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls.map((a) => a.type)).toEqual([addTab.type, initLayout.type, addPane.type])
    expect(calls[2].payload.newContent).toMatchObject({ kind: 'browser' })
  })
})

describe('openPaneInNewTab', () => {
  it('creates a single-pane tab titled after the record and pane', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const record = makeRecord({
      panes: [{ paneId: 'p2', kind: 'browser', title: 'docs', payload: {} }],
    })
    openPaneInNewTab(record, record.panes[0], { dispatch })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
    expect(calls[0].payload).toMatchObject({ title: 'My Tab · docs' })
    expect(calls[1].type).toBe(initLayout.type)
    expect(calls[1].payload.content).toMatchObject({ kind: 'browser' })
  })
})

describe('jumpToRecord', () => {
  it('activates the local tab when it exists', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    const onOpened = vi.fn()
    jumpToRecord(makeRecord(), { dispatch, onOpened, hasLocalTab: () => true })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe(setActiveTab.type)
    expect(calls[0].payload).toBe('tab-9')
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('falls back to opening an unlinked copy when the local tab is gone', () => {
    const dispatch = vi.fn() as unknown as AppDispatch
    jumpToRecord(makeRecord(), { dispatch, hasLocalTab: () => false })

    const calls = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(calls[0].type).toBe(addTab.type)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/client/lib/tab-registry-open.test.ts --config config/vitest/vitest.config.ts
```
Expected: FAIL — cannot resolve `@/lib/tab-registry-open` (module does not exist yet).

- [ ] **Step 3: Create the module and move the helpers**

3a. Create `src/lib/tab-registry-open.ts` with this import header and the code below. The functions marked **[MOVE UNCHANGED]** are cut verbatim from `src/components/TabsView.tsx` — do not retype them, cut and paste, then delete them from TabsView. They are, in current TabsView order: `resolveSessionRef` and `parseLiveTerminalHandle` (the module-level helpers between the imports and line 105 that `sanitizePaneSnapshot` calls), `normalizePaneSnapshot` (lines 106-109), `sanitizePaneSnapshot` (lines 111-207), `deriveModeFromRecord` (lines 209-222), `paneKindIcon` (224-230), `paneKindColorClass` (232-239), `paneKindLabel` (241-248). If any other tiny module-level helper in that region is referenced by the moved functions, move it too (typecheck in Step 4 is the arbiter).

```ts
// Shared tab-registry helpers: pane-kind presentation, registry-record
// sanitization, and the "open/jump" actions used by TabsView cards AND the
// shared context-menu (ContextMenuProvider / menu-defs). React-free except
// for lucide icon component references.
import { nanoid } from 'nanoid'
import {
  Bot,
  FileCode2,
  Globe,
  Square,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react'
import type { AppDispatch } from '@/store/store'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, initLayout } from '@/store/panesSlice'
import {
  RegistryPaneSnapshotSchema,
  type RegistryPaneSnapshot,
  type RegistryTabRecord,
} from '@/store/tabRegistryTypes'
import {
  normalizeFreshAgentEffortOverride,
  normalizeFreshAgentModelSelection,
  type PaneContentInput,
  type SessionLocator,
} from '@/store/paneTypes'
import type { TabMode } from '@/store/types'
import { isNonShellMode } from '@/lib/coding-cli-utils'
import { sanitizeRestoreError } from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { normalizeFreshAgentSessionType, resolveFreshAgentRuntimeProvider } from '@shared/fresh-agent'
import { normalizeFreshAgentStyleOverride } from '@shared/settings'

// [MOVE UNCHANGED from TabsView.tsx] resolveSessionRef(...)
// [MOVE UNCHANGED from TabsView.tsx] parseLiveTerminalHandle(...)
// [MOVE UNCHANGED from TabsView.tsx] normalizePaneSnapshot(...)
// [MOVE UNCHANGED from TabsView.tsx] export function sanitizePaneSnapshot(...)
// [MOVE UNCHANGED from TabsView.tsx] deriveModeFromRecord(...)  (stays module-private)
// [MOVE UNCHANGED from TabsView.tsx, add `export`] paneKindIcon(...)
// [MOVE UNCHANGED from TabsView.tsx, add `export`] paneKindColorClass(...)
// [MOVE UNCHANGED from TabsView.tsx, add `export`] paneKindLabel(...)

export type TabsRegistryGroups = {
  localOpen: RegistryTabRecord[]
  sameDeviceOpen: RegistryTabRecord[]
  remoteOpen: RegistryTabRecord[]
  closed: RegistryTabRecord[]
}

export function findRecordByTabKey(
  groups: TabsRegistryGroups,
  tabKey: string,
  status?: RegistryTabRecord['status'],
): RegistryTabRecord | undefined {
  const lists = [groups.localOpen, groups.sameDeviceOpen, groups.remoteOpen, groups.closed]
  if (status) {
    for (const list of lists) {
      const match = list.find((record) => record.tabKey === tabKey && record.status === status)
      if (match) return match
    }
  }
  for (const list of lists) {
    const match = list.find((record) => record.tabKey === tabKey)
    if (match) return match
  }
  return undefined
}

export type OpenTabRecordDeps = {
  dispatch: AppDispatch
  localServerInstanceId?: string
  onOpened?: () => void
}

export function openRecordAsUnlinkedCopy(record: RegistryTabRecord, deps: OpenTabRecordDeps): void {
  const { dispatch, localServerInstanceId, onOpened } = deps
  const tabId = nanoid()
  const paneSnapshots = record.panes || []
  const firstPane = paneSnapshots[0]
  const firstContent = firstPane
    ? sanitizePaneSnapshot(record, firstPane, localServerInstanceId)
    : ({ kind: 'terminal', mode: 'shell' } as const)
  dispatch(
    addTab({
      id: tabId,
      title: record.tabName,
      mode: deriveModeFromRecord(record),
      status: 'creating',
      serverInstanceId: record.serverInstanceId,
    }),
  )
  dispatch(initLayout({ tabId, content: firstContent }))
  for (const pane of paneSnapshots.slice(1)) {
    dispatch(addPane({ tabId, newContent: sanitizePaneSnapshot(record, pane, localServerInstanceId) }))
  }
  onOpened?.()
}

export function openPaneInNewTab(
  record: RegistryTabRecord,
  pane: RegistryPaneSnapshot,
  deps: OpenTabRecordDeps,
): void {
  const { dispatch, localServerInstanceId, onOpened } = deps
  const tabId = nanoid()
  dispatch(
    addTab({
      id: tabId,
      title: `${record.tabName} · ${pane.title || pane.kind}`,
      mode: deriveModeFromRecord(record),
      status: 'creating',
      serverInstanceId: record.serverInstanceId,
    }),
  )
  dispatch(
    initLayout({
      tabId,
      content: sanitizePaneSnapshot(record, pane, localServerInstanceId),
    }),
  )
  onOpened?.()
}

export function jumpToRecord(
  record: RegistryTabRecord,
  deps: OpenTabRecordDeps & { hasLocalTab: (tabId: string) => boolean },
): void {
  if (!deps.hasLocalTab(record.tabId)) {
    openRecordAsUnlinkedCopy(record, deps)
    return
  }
  deps.dispatch(setActiveTab(record.tabId))
  deps.onOpened?.()
}
```

The body of `openRecordAsUnlinkedCopy` / `openPaneInNewTab` / `jumpToRecord` above is the exact logic of TabsView.tsx:603-654 with the captured hooks (`dispatch`, `localServerInstanceId`, `store`, `onOpenTab`) replaced by explicit `deps` — keep the dispatch payloads byte-identical to the originals. Trim the import header to what the moved code actually uses (e.g. drop `SessionLocator` if only the moved helpers reference it and they carry it; typecheck+lint decide).

3b. In `src/components/TabsView.tsx`:
- Delete the moved functions (everything listed in 3a, including `sanitizePaneSnapshot`'s `export` copy).
- Add, next to the remaining imports:

```ts
import {
  jumpToRecord as jumpToRecordAction,
  openRecordAsUnlinkedCopy as openRecordAsUnlinkedCopyAction,
  paneKindColorClass,
  paneKindIcon,
  paneKindLabel,
} from '@/lib/tab-registry-open'

// Compatibility re-export: test/unit/client/tab-registry-fresh-agent-migration.test.ts
// (and any external caller) imports sanitizePaneSnapshot from this module.
export { sanitizePaneSnapshot } from '@/lib/tab-registry-open'
```

- Replace the three component-body closures at lines 603-654 with thin wrappers (SAME local names so `openCardContextMenu`, `pullAllFromDevice`, and the three `DeviceSection` call sites at lines ~798-848 compile unchanged). Add `openPaneInNewTab as openPaneInNewTabAction` to the static import block above, then:

```ts
  const openRecordAsUnlinkedCopy = (record: RegistryTabRecord) => {
    openRecordAsUnlinkedCopyAction(record, { dispatch, localServerInstanceId, onOpened: onOpenTab })
  }

  // Still used by openCardContextMenu until Task 6 removes the local menu.
  const openPaneInNewTab = (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => {
    openPaneInNewTabAction(record, pane, { dispatch, localServerInstanceId, onOpened: onOpenTab })
  }

  const jumpToRecord = (record: RegistryTabRecord) => {
    jumpToRecordAction(record, {
      dispatch,
      localServerInstanceId,
      onOpened: onOpenTab,
      hasLocalTab: (tabId) => store.getState().tabs.tabs.some((tab) => tab.id === tabId),
    })
  }
```

  (`pullAllFromDevice` at line 656 keeps calling `openRecordAsUnlinkedCopy` and needs no edit.)
- Remove imports that became unused in TabsView (`nanoid`, `addTab`, `setActiveTab`, `addPane`, `initLayout`, `RegistryPaneSnapshotSchema`, the `@shared/*` sanitizers, `isNonShellMode`, `normalizeFreshAgent*`, `PaneContentInput`, `SessionLocator`, `TabMode`, and the lucide icons only the moved helpers used: `Bot`, `FileCode2`, `Square`, `TerminalSquare`). Keep whatever is still referenced (`Globe` is used in the render at line ~800; `LucideIcon` is used by `DeviceSection` props). Let `npm run lint` + `npm run typecheck:client` flag the exact set — remove precisely what they flag, nothing more.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/lib/tab-registry-open.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/tab-registry-fresh-agent-migration.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabsView.test.tsx --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
```
Expected: all PASS — the migration test proves the re-export works; TabsView tests prove the behavior wrappers are equivalent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-registry-open.ts src/components/TabsView.tsx test/unit/client/lib/tab-registry-open.test.ts
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "refactor(tabs): extract shared tab-registry open helpers to lib"
```

---

### Task 4: Build tabs-card menu items in `menu-defs.ts`

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts` (`MenuActions` :18-77, `MenuBuildContext` :79-93, new branch after the `tab` branch which ends at :341)
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Interfaces:**
- Consumes: `{ kind: 'tabs-card', tabKey }` target (Task 2); `TabsRegistryGroups`, `findRecordByTabKey`, `paneKind*` (Task 3).
- Produces: `buildMenuItems({ kind: 'tabs-card', tabKey }, ctx)` returns the same items TabsView's `openCardContextMenu` built (ids `jump`, `open-copy`, `pane-<paneId>`, `copy-name`; separators `sep-panes`, `sep-copy`), driven by four NEW required `MenuActions` entries:

```ts
  jumpToTabRecord: (record: RegistryTabRecord) => void
  openTabRecordCopy: (record: RegistryTabRecord) => void
  openTabRecordPaneInNewTab: (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => void
  copyTabRecordName: (record: RegistryTabRecord) => void | Promise<void>
```

and two NEW optional `MenuBuildContext` fields:

```ts
  tabRegistryGroups?: TabsRegistryGroups
  registryDeviceId?: string
```

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/components/context-menu/menu-defs.test.ts`:

1a. Extend `createMockActions()` (lines 5-65) with four entries before the closing brace:

```ts
    jumpToTabRecord: vi.fn(),
    openTabRecordCopy: vi.fn(),
    openTabRecordPaneInNewTab: vi.fn(),
    copyTabRecordName: vi.fn(),
```

1b. Add at the top of the file (after the existing imports):

```ts
import type { RegistryTabRecord } from '@/store/tabRegistryTypes'
import type { TabsRegistryGroups } from '@/lib/tab-registry-open'

function makeRegistryRecord(overrides: Partial<RegistryTabRecord> = {}): RegistryTabRecord {
  return {
    tabKey: 'device-a:tab-9',
    tabId: 'tab-9',
    serverInstanceId: 'srv-1',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    tabName: 'My Tab',
    status: 'open',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    paneCount: 1,
    titleSetByUser: false,
    panes: [],
    ...overrides,
  }
}

function makeRegistryGroups(overrides: Partial<TabsRegistryGroups> = {}): TabsRegistryGroups {
  return { localOpen: [], sameDeviceOpen: [], remoteOpen: [], closed: [], ...overrides }
}
```

1c. Add a new top-level `describe` block:

```ts
describe('tabs-card menu', () => {
  function buildFor(record: RegistryTabRecord, registryDeviceId: string) {
    const actions = createMockActions()
    const ctx = {
      ...createMockContext(actions),
      tabRegistryGroups: makeRegistryGroups({ remoteOpen: [record] }),
      registryDeviceId,
    }
    const items = buildMenuItems({ kind: 'tabs-card', tabKey: record.tabKey, status: record.status }, ctx)
    return { actions, items }
  }

  it('local open record: Jump to tab first, then Open copy', () => {
    const record = makeRegistryRecord({ deviceId: 'this-device', tabKey: 'this-device:tab-9' })
    const { actions, items } = buildFor(record, 'this-device')

    expect(items[0]).toMatchObject({ type: 'item', id: 'jump', label: 'Jump to tab' })
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Open copy' })
    if (items[0].type === 'item') items[0].onSelect()
    expect(actions.jumpToTabRecord).toHaveBeenCalledWith(record)
  })

  it('remote open record: no Jump item, Pull to this device', () => {
    const record = makeRegistryRecord()
    const { actions, items } = buildFor(record, 'this-device')

    expect(items.find((i) => i.type === 'item' && i.id === 'jump')).toBeUndefined()
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Pull to this device' })
    if (openCopy?.type === 'item') openCopy.onSelect()
    expect(actions.openTabRecordCopy).toHaveBeenCalledWith(record)
  })

  it('closed record: Reopen label', () => {
    const record = makeRegistryRecord({ status: 'closed', closedAt: 3 })
    const { items } = buildFor(record, 'this-device')
    const openCopy = items.find((i) => i.type === 'item' && i.id === 'open-copy')
    expect(openCopy).toMatchObject({ label: 'Reopen' })
  })

  it('multi-pane record: one open-in-new-tab item per pane', () => {
    const record = makeRegistryRecord({
      paneCount: 2,
      panes: [
        { paneId: 'p1', kind: 'terminal', title: 'my-shell', payload: {} },
        { paneId: 'p2', kind: 'browser', title: 'docs', payload: {} },
      ],
    })
    const { actions, items } = buildFor(record, 'this-device')

    const paneItem = items.find((i) => i.type === 'item' && i.id === 'pane-p2')
    expect(paneItem).toMatchObject({ label: 'Open docs in new tab' })
    expect(items.find((i) => i.type === 'item' && i.id === 'pane-p1')).toMatchObject({
      label: 'Open my-shell in new tab',
    })
    if (paneItem?.type === 'item') paneItem.onSelect()
    expect(actions.openTabRecordPaneInNewTab).toHaveBeenCalledWith(record, record.panes[1])
  })

  it('single-pane record: no per-pane items', () => {
    const record = makeRegistryRecord({
      panes: [{ paneId: 'p1', kind: 'terminal', title: 'my-shell', payload: {} }],
    })
    const { items } = buildFor(record, 'this-device')
    expect(items.find((i) => i.type === 'item' && i.id === 'pane-p1')).toBeUndefined()
  })

  it('copy-name delegates to copyTabRecordName', () => {
    const record = makeRegistryRecord()
    const { actions, items } = buildFor(record, 'this-device')
    const copyName = items.find((i) => i.type === 'item' && i.id === 'copy-name')
    expect(copyName).toMatchObject({ label: 'Copy tab name' })
    if (copyName?.type === 'item') copyName.onSelect()
    expect(actions.copyTabRecordName).toHaveBeenCalledWith(record)
  })

  it('returns no items when the record or groups are missing', () => {
    const actions = createMockActions()
    const noGroups = buildMenuItems(
      { kind: 'tabs-card', tabKey: 'x:y', status: 'open' },
      { ...createMockContext(actions) },
    )
    expect(noGroups).toEqual([])

    const unknownKey = buildMenuItems(
      { kind: 'tabs-card', tabKey: 'x:y', status: 'open' },
      { ...createMockContext(actions), tabRegistryGroups: makeRegistryGroups(), registryDeviceId: 'd' },
    )
    expect(unknownKey).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- run test/unit/client/components/context-menu/menu-defs.test.ts --config config/vitest/vitest.config.ts
```
Expected: 5 of the 7 new `tabs-card menu` tests FAIL (branch not implemented → `buildMenuItems` falls through to its `return []` default for the unknown kind, so every test asserting the presence of an item fails). The two negative-space tests — `'single-pane record: no per-pane items'` and `'returns no items when the record or groups are missing'` — already PASS against that pre-existing `return []` fallback; keep them as pinned invariants (they must still pass after Step 3, now exercising the implemented branch's early-return paths). Pre-existing tests still pass. (`createMockActions` gained extra keys — harmless at runtime; the `MenuActions` type gains the fields in Step 3.)

- [ ] **Step 3: Implement the branch**

In `src/components/context-menu/menu-defs.ts`:

3a. Imports — extend the lucide import at line 2 and add three imports:

```ts
import { ClipboardPaste, Copy, ExternalLink, TextSelect } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  findRecordByTabKey,
  paneKindColorClass,
  paneKindIcon,
  paneKindLabel,
  type TabsRegistryGroups,
} from '@/lib/tab-registry-open'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'
```

3b. `MenuActions` (:18-77) — add before the closing brace:

```ts
  jumpToTabRecord: (record: RegistryTabRecord) => void
  openTabRecordCopy: (record: RegistryTabRecord) => void
  openTabRecordPaneInNewTab: (record: RegistryTabRecord, pane: RegistryPaneSnapshot) => void
  copyTabRecordName: (record: RegistryTabRecord) => void | Promise<void>
```

3c. `MenuBuildContext` (:79-93) — add before the closing brace:

```ts
  tabRegistryGroups?: TabsRegistryGroups
  registryDeviceId?: string
```

3d. New branch in `buildMenuItems`, inserted immediately after the `if (target.kind === 'tab') { ... }` branch closes (line 341). This mirrors TabsView's `openCardContextMenu` (TabsView.tsx:664-718) item-for-item:

```ts
  if (target.kind === 'tabs-card') {
    const groups = ctx.tabRegistryGroups
    if (!groups) return []
    const record = findRecordByTabKey(groups, target.tabKey, target.status)
    if (!record) return []

    const isLocal = record.deviceId === ctx.registryDeviceId
    const isOpen = record.status === 'open'
    const items: MenuItem[] = []

    if (isLocal && isOpen) {
      items.push({
        type: 'item',
        id: 'jump',
        label: 'Jump to tab',
        icon: createElement(ExternalLink, { className: 'h-3.5 w-3.5' }),
        onSelect: () => actions.jumpToTabRecord(record),
      })
    }

    items.push({
      type: 'item',
      id: 'open-copy',
      label: isLocal && isOpen ? 'Open copy' : record.status === 'closed' ? 'Reopen' : 'Pull to this device',
      icon: createElement(Copy, { className: 'h-3.5 w-3.5' }),
      onSelect: () => actions.openTabRecordCopy(record),
    })

    if (record.panes.length > 1) {
      items.push({ type: 'separator', id: 'sep-panes' })
      for (const pane of record.panes) {
        const PaneIcon = paneKindIcon(pane.kind)
        items.push({
          type: 'item',
          id: `pane-${pane.paneId}`,
          label: `Open ${pane.title || paneKindLabel(pane.kind)} in new tab`,
          icon: createElement(PaneIcon, {
            className: cn('h-3.5 w-3.5', paneKindColorClass(pane.kind)),
          }),
          onSelect: () => actions.openTabRecordPaneInNewTab(record, pane),
        })
      }
    }

    items.push({ type: 'separator', id: 'sep-copy' })
    items.push({
      type: 'item',
      id: 'copy-name',
      label: 'Copy tab name',
      icon: createElement(Copy, { className: 'h-3.5 w-3.5' }),
      onSelect: () => actions.copyTabRecordName(record),
    })

    return items
  }
```

(`menu-defs.ts` stays a pure builder — clipboard writing happens in the provider's `copyTabRecordName` action, Task 5, matching how `copyTabName` etc. work today.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/context-menu/menu-defs.test.ts --config config/vitest/vitest.config.ts
npm run typecheck:client
```
Expected: PASS. Typecheck will FAIL in `ContextMenuProvider.tsx` if the actions bag is now missing the four new required entries — if so, that is Task 5's work arriving early; add the four entries as described in Task 5 Step 3 within THIS task only if `npm run typecheck:client` demands it to stay green, and say so in the commit body. Otherwise proceed.

> Note: because `MenuActions` gained required fields, the provider's `actions: { ... }` literal (ContextMenuProvider.tsx:1184-1247) will not typecheck until Task 5 adds the entries. To keep every commit green, Tasks 4 and 5 may be committed together ONLY if typecheck cannot pass otherwise; prefer the split below: implement Task 5's provider callbacks + actions-bag entries as part of this task's Step 3 if `npm run typecheck:client` fails, then Task 5 reduces to selectors/ctx wiring + tests. The reviewer should treat a combined commit as acceptable when justified by typecheck integrity.

- [ ] **Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/components/context-menu/menu-defs.test.ts
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "feat(context-menu): build tabs-card menu items in menu-defs"
```
(Include any provider edits Step 4 forced, in the same commit, with a body line explaining the typecheck coupling.)

---

### Task 5: Wire tabs-card through ContextMenuProvider (selectors, actions, touch coverage)

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (module constants ~:68-80, hooks :142-161, action callbacks ~:217+, `menuItems` memo :1169-1308)
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx` (mouse path)
- Test: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx` (touch + race path)

**Interfaces:**
- Consumes: Task 2 (`ContextIds.TabsCard`, parser), Task 3 (`openRecordAsUnlinkedCopy`, `openPaneInNewTab`, `jumpToRecord`, `TabsRegistryGroups`), Task 4 (`MenuActions` entries + ctx fields), Task 1 (release suppression for whichever path opens).
- Produces: any element with `data-context="tabs-card"` + `data-tab-key="<tabKey>"` gets the full card menu on right-click, keyboard (Shift+F10), and touch long-press — with release suppression. Provider action callbacks: `jumpToTabRecord`, `openTabRecordCopy`, `openTabRecordPaneInNewTab` (each switches view via `onViewChange('terminal')` after opening — the provider-side equivalent of TabsView's `onOpenTab`, see `App.tsx:276-278`), and `copyTabRecordName` (clipboard via `copyText`).

- [ ] **Step 1: Write the failing mouse-path tests**

In `test/unit/client/components/ContextMenuProvider.test.tsx` add (near the other store factories; reuse this file's existing imports — `configureStore`, `Provider`, reducers, `userEvent`, `screen`, `render` are already imported; add the two new imports shown):

```tsx
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
```
(If `ContextIds` is already imported in this file, do not duplicate it.)

```tsx
function createStoreWithTabRegistry() {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      tabRegistry: tabRegistryReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          { id: 'tab-1', createRequestId: 'tab-1', title: 'Tab One', status: 'running', mode: 'shell', shell: 'system', createdAt: 1 },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
      sessions: { projects: [], expandedProjects: new Set<string>() },
      connection: { status: 'ready', platform: null },
    },
  })
  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open-1',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote-device',
      deviceLabel: 'Remote Device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [],
  }))
  return store
}
```

(If this file's existing `createTestStore` preloads a different-but-compatible shape, mirroring it is fine — the required elements are: the six reducers above, `serializableCheck: false`, and the dispatched registry snapshot.)

Then two tests inside the main `describe('ContextMenuProvider', ...)`:

```tsx
  it('opens the tabs-card menu on right click via data-context', async () => {
    const user = userEvent.setup()
    const store = createStoreWithTabRegistry()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1">
            remote open card
          </button>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('remote open card'), keys: '[MouseRight]' })

    expect(screen.getByRole('menuitem', { name: /Pull to this device/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Copy tab name/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Jump to tab/i })).toBeNull()
  })

  it('pull to this device creates a local tab and switches view', async () => {
    const user = userEvent.setup()
    const store = createStoreWithTabRegistry()
    const onViewChange = vi.fn()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={onViewChange}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1">
            remote open card
          </button>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('remote open card'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: /Pull to this device/i }))

    expect(store.getState().tabs.tabs.some((t) => t.title === 'remote open')).toBe(true)
    expect(onViewChange).toHaveBeenCalledWith('terminal')
  })
```

- [ ] **Step 2: Write the failing touch-path tests**

In `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`:

2a. Extend `createTestStore()` (lines 38-89): add to its imports
```tsx
import tabRegistryReducer, { setTabRegistrySnapshot } from '@/store/tabRegistrySlice'
```
and add `tabRegistry: tabRegistryReducer,` to the `reducer` map (no preloadedState entry needed — slice initial state is fine, and the existing 15 tests are unaffected). CAUTION (validated 2026-08-09): once `state.tabRegistry` exists the provider runs `selectTabsRegistryGroups`, whose input selectors read `state.tabs.tabs`, `state.panes.layouts`, `state.panes.paneTitles`, and `state.connection.serverInstanceId` UNGUARDED (`tabsRegistrySelectors.ts:31-37`) — verify `createTestStore` also provides the `tabs`, `panes`, and `connection` reducers (add any that are missing) or the selector throws.

2b. Add a fixture helper near `simulateTouch`:

```tsx
function seedRemoteCardRecord(store: ReturnType<typeof createTestStore>) {
  store.dispatch(setTabRegistrySnapshot({
    localOpen: [],
    remoteOpen: [{
      tabKey: 'remote:open-1',
      tabId: 'open-1',
      serverInstanceId: 'srv-remote',
      deviceId: 'remote-device',
      deviceLabel: 'Remote Device',
      tabName: 'remote open',
      status: 'open',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      paneCount: 1,
      titleSetByUser: false,
      panes: [],
    }],
    closed: [],
  }))
}
```

2c. Add two tests to the describe block:

```tsx
  it('long-press opens the tabs-card menu and suppresses the card click', () => {
    const onCardClick = vi.fn()
    const { store } = renderWithProvider(
      <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1" onClick={onCardClick}>
        remote card
      </button>
    )
    act(() => {
      seedRemoteCardRecord(store)
    })

    const target = screen.getByText('remote card')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Pull to this device/i })).toBeInTheDocument()

    act(() => {
      const release = simulateTouch('touchend', target, 100, 100)
      if (!release.defaultPrevented) {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    // The card is a <button> with onClick -- suppression must prevent the
    // synthetic click from both closing the menu AND pulling the tab.
    expect(onCardClick).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('keeps the tabs-card menu open when a native contextmenu wins the race (Android)', () => {
    const onCardClick = vi.fn()
    const { store } = renderWithProvider(
      <button type="button" data-context={ContextIds.TabsCard} data-tab-key="remote:open-1" onClick={onCardClick}>
        remote card
      </button>
    )
    act(() => {
      seedRemoteCardRecord(store)
    })

    const target = screen.getByText('remote card')
    elementFromPointMock.mockReturnValue(target)

    act(() => {
      simulateTouch('touchstart', target, 100, 100)
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    act(() => {
      simulateNativeContextMenu(target, 100, 100)
    })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    const firstItem = screen.getAllByRole('menuitem')[0]
    act(() => {
      const release = simulateTouch('touchend', firstItem, 100, 100)
      if (!release.defaultPrevented) {
        firstItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      }
    })

    expect(onCardClick).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })
```

- [ ] **Step 3: Run both files to verify the new tests fail**

```bash
npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx --config config/vitest/vitest.config.ts
```
Expected: the 4 new tests FAIL because the provider never passes `tabRegistryGroups` to `buildMenuItems` → the tabs-card branch returns `[]` → `open` stays false (provider renders the menu only when `menuItems.length > 0`, line 1315) → `getByRole('menu')`/menuitem queries throw. All pre-existing tests PASS.

- [ ] **Step 4: Implement the provider wiring**

In `src/components/context-menu/ContextMenuProvider.tsx`:

4a. Imports (top of file, alongside the existing `@/store` imports):

```ts
import { selectTabsRegistryGroups } from '@/store/selectors/tabsRegistrySelectors'
import {
  jumpToRecord,
  openPaneInNewTab as openRecordPaneInNewTab,
  openRecordAsUnlinkedCopy,
  type TabsRegistryGroups,
} from '@/lib/tab-registry-open'
import type { RegistryPaneSnapshot, RegistryTabRecord } from '@/store/tabRegistryTypes'
```

4b. Module constant, next to the other `EMPTY_*` constants (lines ~69-77):

```ts
const EMPTY_TAB_REGISTRY_GROUPS: TabsRegistryGroups = {
  localOpen: [],
  sameDeviceOpen: [],
  remoteOpen: [],
  closed: [],
}
```

4c. Selectors — add after the existing selector block (after line 161), following the house `?.`-guard style so the 11 existing provider-rendering test stores (which lack `tabRegistry`) stay green:

```ts
  const tabRegistryGroups = useAppSelector((s) =>
    s.tabRegistry ? selectTabsRegistryGroups(s) : EMPTY_TAB_REGISTRY_GROUPS
  )
  const registryDeviceId = useAppSelector((s) => s.tabRegistry?.deviceId ?? '')
  const localServerInstanceId = useAppSelector((s) => s.connection?.serverInstanceId)
```

4d. Action callbacks — add near the other tab actions (e.g. right after `newDefaultTab`, line ~234), matching the provider's `useCallback` convention:

```ts
  const openTabRecordCopy = useCallback((record: RegistryTabRecord) => {
    openRecordAsUnlinkedCopy(record, {
      dispatch,
      localServerInstanceId,
      onOpened: () => onViewChange('terminal'),
    })
  }, [dispatch, localServerInstanceId, onViewChange])

  const jumpToTabRecord = useCallback((record: RegistryTabRecord) => {
    jumpToRecord(record, {
      dispatch,
      localServerInstanceId,
      onOpened: () => onViewChange('terminal'),
      hasLocalTab: (tabId) => appStore.getState().tabs.tabs.some((tab) => tab.id === tabId),
    })
  }, [dispatch, localServerInstanceId, onViewChange, appStore])

  const openTabRecordPaneInNewTab = useCallback((record: RegistryTabRecord, pane: RegistryPaneSnapshot) => {
    openRecordPaneInNewTab(record, pane, {
      dispatch,
      localServerInstanceId,
      onOpened: () => onViewChange('terminal'),
    })
  }, [dispatch, localServerInstanceId, onViewChange])

  const copyTabRecordName = useCallback(async (record: RegistryTabRecord) => {
    await copyText(record.tabName)
  }, [])
```

(`localServerInstanceId` types as `string | undefined` to match `OpenTabRecordDeps`; if the connection slice types it `string | null`, coerce with `?? undefined` in the selector.)

4e. `menuItems` memo (:1169-1308) — add the two ctx fields right after `reopenActivityByPaneId,` (line 1183):

```ts
      tabRegistryGroups,
      registryDeviceId,
```

add the four action entries inside `actions: { ... }` (e.g. after `copyTabName,` at line 1192):

```ts
        jumpToTabRecord,
        openTabRecordCopy,
        openTabRecordPaneInNewTab,
        copyTabRecordName,
```

and append to the dependency array (before the closing `])` at line 1308):

```ts
    tabRegistryGroups,
    registryDeviceId,
    jumpToTabRecord,
    openTabRecordCopy,
    openTabRecordPaneInNewTab,
    copyTabRecordName,
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/context-menu/menu-defs.test.ts --config config/vitest/vitest.config.ts
npm run typecheck:client
```
Expected: all PASS (longpress file now 17 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "feat(context-menu): wire tabs-card menus through ContextMenuProvider"
```

---

### Task 6: Route TabsView cards through the provider; delete the duplicate local menu

**Files:**
- Modify: `src/components/TabsView.tsx`
- Modify: `test/unit/client/components/TabsView.test.tsx`
- Modify: `test/unit/client/components/TabsView.memo.test.tsx`

**Interfaces:**
- Consumes: `ContextIds.TabsCard` (Task 2); provider wiring (Task 5) — TabsView is always rendered inside `ContextMenuProvider` (`App.tsx:1648-1653` within `:1680-1685`).
- Produces: cards carry `data-context="tabs-card"` + `data-tab-key` + `data-tab-status`; TabsView renders NO menu of its own; `ContextMenu` becomes provider-private (its only remaining `src/` importer is `ContextMenuProvider.tsx`).

- [ ] **Step 1: Rewrite the two TabsView menu tests to go through the real provider (they must FAIL first)**

In `test/unit/client/components/TabsView.test.tsx`:

1a. Add imports:

```tsx
import sessionsReducer from '../../../../src/store/sessionsSlice'
import settingsReducer from '../../../../src/store/settingsSlice'
import { ContextMenuProvider } from '../../../../src/components/context-menu/ContextMenuProvider'
```

1b. Extend `wsMock` (lines 11-17) with the extra methods the provider's ws client may touch:

```tsx
const wsMock = {
  state: 'ready',
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  setHelloExtensionProvider: vi.fn(),
  sendTabsSyncQuery: vi.fn(),
  sendTabsSyncPush: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}
```

1c. Add an api mock next to the clipboard mock (the provider imports `@/lib/api`):

```tsx
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))
```

1d. In `createStore()` (lines 27-79) add the two reducers and disable the serializable check (sessions state holds a `Set`):

```tsx
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false }),
  })
```

1e. Add a render helper:

```tsx
function renderWithMenuProvider(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <ContextMenuProvider
        view="tabs"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <TabsView />
      </ContextMenuProvider>
    </Provider>,
  )
}
```

1f. Rewrite the test at lines 281-295 to use the helper (assertions unchanged):

```tsx
  it('shows context menu on right-click with appropriate items', () => {
    const store = createStore()
    renderWithMenuProvider(store)

    const remoteCard = screen.getByLabelText('remote-device: remote open')
    fireEvent.contextMenu(remoteCard)

    expect(screen.getByRole('menuitem', { name: /Pull to this device/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Copy tab name/i })).toBeInTheDocument()
  })
```

1g. Rewrite the test at lines 490-533 ('shows individual pane items in context menu for multi-pane tabs'): keep its inline store construction but add `sessions: sessionsReducer, settings: settingsReducer` to the reducer map and the `serializableCheck: false` middleware line, and replace its bare `render(<Provider store={store}><TabsView /></Provider>)` with the same `ContextMenuProvider` wrapper as 1e. Assertions unchanged.

- [ ] **Step 2: Run to verify the rewritten tests currently pass BOTH ways (pre-change) then pin the failure direction**

```bash
npm run test:vitest -- run test/unit/client/components/TabsView.test.tsx --config config/vitest/vitest.config.ts
```
Expected NOW (before Step 3): the two rewritten tests may pass ambiguously because TabsView's OWN menu still renders on `fireEvent.contextMenu`. Make them strict by adding one more assertion to the FIRST rewritten test, which fails until the local menu is gone (exactly one menu in the document — today the provider's `global` menu and TabsView's local menu can both mount):

```tsx
    expect(screen.getAllByRole('menu')).toHaveLength(1)
```
Re-run. Expected: `shows context menu on right-click` FAILS (two menus: the provider opens its `global`/tabs-card menu from the capture-phase document listener AND TabsView renders its local menu — or, if items differ, the `Pull to this device` lookup resolves ambiguously). If it does NOT fail, keep the assertion anyway — it pins the single-menu invariant for Step 3.

- [ ] **Step 3: Implement the TabsView swap**

In `src/components/TabsView.tsx`:

3a. Imports — remove `import { ContextMenu } from '@/components/context-menu/ContextMenu'` and `import type { MenuItem } from '@/components/context-menu/context-menu-types'`; add:

```ts
import { ContextIds } from '@/components/context-menu/context-menu-constants'
```

3b. `TabCard` (lines 338-370): remove the `onContextMenu` prop from its props type and destructuring, remove `onContextMenu={onContextMenu}` from the `<button>` (line 367), and add the two data attributes:

```tsx
    <button
      type="button"
      className={cn(
        'group relative w-full rounded-md border p-3 text-left transition-all cursor-default select-none',
        'hover:shadow-sm',
        isOpen
          ? 'border-border/60 border-l-2 border-l-emerald-500/70 hover:border-border hover:bg-muted/40'
          : 'border-border/40 border-l-2 border-l-muted-foreground/20 opacity-70 hover:opacity-90 hover:bg-muted/30',
      )}
      data-context={ContextIds.TabsCard}
      data-tab-key={record.tabKey}
      data-tab-status={record.status}
      aria-label={`${record.displayDeviceLabel}: ${record.tabName}`}
      onClick={onAction}
    >
```

3c. `DeviceSection` (lines 435-520): remove `onCardContextMenu` from the destructure and the props type, and remove `onContextMenu={(e) => onCardContextMenu(e, record)}` from the `<TabCard>` element (line 513).

3d. Component body: delete the `contextMenuState` `useState` (lines 541-544), delete `openCardContextMenu` entirely (lines 664-718), delete the `openPaneInNewTab` wrapper added in Task 3 if nothing else references it (it was only used by the menu), and delete the `<ContextMenu ... />` render block (lines 854-859). Remove `onCardContextMenu={openCardContextMenu}` from all three `DeviceSection` call sites (lines ~806, ~829, ~848).

3e. Clean imports: with the menu gone, `createElement`, `Copy`, `ExternalLink`, `copyText`, `paneKindLabel`/`paneKindColorClass`... — careful: `paneKindIcon`, `paneKindColorClass`, `paneKindLabel` are STILL used by the card body (lines 380-387); `copyText`?, `createElement`?, `Copy`/`ExternalLink`? were menu-only. Run `npm run lint` and `npm run typecheck:client` and remove exactly the imports they flag as unused.

- [ ] **Step 4: Run the TabsView tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/TabsView.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS, including the `getAllByRole('menu')).toHaveLength(1)` single-menu assertion. The pane-kind-icons test at :449-488 (`within(card).getByLabelText('Terminal')` etc.) must still pass — it exercises `paneKindLabel` via the card body, unrelated to the menu.

- [ ] **Step 5: Fix the memo-test probe**

`test/unit/client/components/TabsView.memo.test.tsx` counted `TabsView` renders by mocking `@/components/context-menu/ContextMenu` (lines 32-41) — TabsView no longer renders it, so both tests would fail at `expect(initialRenderCount).toBeGreaterThan(0)`.

Do NOT count selector invocations: it was proven by execution (load-bearing pass, 2026-08-09; probe in `.worktrees/.the-usual-logs/longpress-contextmenu-race/reports/validator-P-memo-probe.md`) that react-redux 9 SKIPS the `useSelector` selector when a re-render happens with no dispatch (store snapshot reference-equal — the with-selector shim returns the cached selection), so a counting wrapper around `selectTabsRegistryGroups` never sees the inline-prop re-render and the `toBeGreaterThan` assertion fails. Count RENDERS instead, via `paneKindLabel`: the fixture's local card (1 terminal pane) calls it during every real `TabsView` render (card body, plain non-memo `TabCard`/`DeviceSection` components), so the count strictly increases exactly when TabsView actually re-renders.

Replace lines 12-14 and 32-41 with:

```tsx
const renderCounters = vi.hoisted(() => ({
  paneKindLabelCalls: 0,
}))
```

```tsx
vi.mock('@/lib/tab-registry-open', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tab-registry-open')>()
  return {
    ...actual,
    paneKindLabel: (...args: Parameters<typeof actual.paneKindLabel>) => {
      renderCounters.paneKindLabelCalls += 1
      return actual.paneKindLabel(...args)
    },
  }
})
```

Then in both tests replace every `renderCounters.contextMenuCalls` with `renderCounters.paneKindLabelCalls`. Also reset the counter between tests — add inside the existing `afterEach` (or a `beforeEach`): `renderCounters.paneKindLabelCalls = 0`. The two assertions keep their exact semantics: stable `onOpenTab` → parent rerender does NOT re-render TabsView (memo blocked it) → count unchanged (`toBe(initialRenderCount)`); inline `onOpenTab` → TabsView re-renders → the local card re-renders → count increases (`toBeGreaterThan(initialRenderCount)`). Fixture dependency (keep it true): the memo test's store must continue to render at least one LOCAL card with at least one pane (`addTab` + `initLayout` seeding at lines 53-57) — the remote card has `panes: []` and contributes no calls.

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TabsView.memo.test.tsx --config config/vitest/vitest.config.ts
```
Expected: 2/2 PASS.

- [ ] **Step 6: Sweep the adjacent suites**

```bash
npm run test:vitest -- run test/unit/client/components/TabsView.fresh-agent.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabsView.ws-error.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/e2e/tabs-view-flow.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/e2e/tabs-view-search-range.test.tsx --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
```
Expected: all PASS (none of these opened the card menu — verified: repo-wide `fireEvent.contextMenu` hits only the two rewritten TabsView tests plus unrelated FreshAgent/pane suites).

- [ ] **Step 7: Commit**

```bash
git add src/components/TabsView.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/TabsView.memo.test.tsx
git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "refactor(tabs): route TabsView card menu through shared context-menu provider"
```

---

### Task 7: Full verification sweep

**Files:**
- No new files; fixes only if the sweep finds regressions.

**Interfaces:**
- Consumes: everything above.
- Produces: a green coordinated run proving the spec's "keep existing behaviors green" requirement.

- [ ] **Step 1: Typecheck + lint**

```bash
npm run typecheck:client
npm run lint
```
Expected: clean.

- [ ] **Step 2: Coordinated unit run**

```bash
npm run test:unit
```
Expected: PASS (this is the coordinated path — it may wait on the shared gate; do not bypass it with raw `npx vitest`). If any failure appears, fix it within the task that owns the file, re-run the owning task's focused command, then re-run `npm run test:unit`.

- [ ] **Step 3: Targeted behavior checklist (spec requirement 4)**

Confirm each is covered by a passing test and note the test name:
- Desktop right-click menus → `ContextMenuProvider.test.tsx` ('opens menu on right click and dispatches close tab', 'closes menu on outside click', 'allows native menu when Shift is held', + new tabs-card mouse tests)
- iOS custom-timer long-press + release suppression → `ContextMenu.longpress.test.tsx` ('opens context menu after 500ms touch hold...', 'keeps the menu open when the long-press release lands on a menu item')
- Move-tolerance cancellation → ('does NOT open context menu if touch moves >10px during hold', '...vertically', 'allows small touch movement (<=10px)...')
- touchcancel → ('cancels long-press on touchcancel')
- Native-menu passthrough for inputs/links → ('does NOT open custom menu on text inputs...', '...on links...', '...data-native-context')
- Android race (both orders, incl. drifted-coords position source) → the four Task 1 tests + two Task 5 tabs-card touch tests

- [ ] **Step 4: Commit any residual fixes**

```bash
git status --short
```
If clean, done. Otherwise commit fixes with a focused message:
```bash
git add -A && git commit --author="Dan Shapiro <3732858+danshapiro@users.noreply.github.com>" -m "test: stabilize suites after tabs-card context-menu routing"
```

---

## Self-Review Notes (performed at plan time)

- **Spec coverage:** (1) provider race unification incl. timer cancellation → Task 1; (2) TabsView equivalent protection via the shared provider (the spec's preferred route) → Tasks 2-6; (3) TDD-first failing tests simulating the Android sequence (touchstart → real contextmenu mid-gesture → uncancelled touchend → synthetic click at menu coordinates, asserting menu stays open and no action fires) → Task 1 Step 1 test 1 and Task 5 Step 2 test 2; (4) existing behaviors kept green → per-task regression runs + Task 7 checklist.
- **No silent deferrals:** no stubs or mocks stand in for production behavior; the provider tests dispatch real Redux actions through the real reducers (Task 5 Step 1 test 2 asserts an actual tab is created). The only mocks are the repo's established infrastructure mocks (ws-client/api/clipboard) and jsdom gap-fills (`elementFromPoint`).
- **Type consistency check:** `MenuActions` names (`jumpToTabRecord`, `openTabRecordCopy`, `openTabRecordPaneInNewTab`, `copyTabRecordName`) are identical in Task 4 (type + branch), Task 5 (provider callbacks + actions bag + dep array), and the menu-defs tests. Lib exports (`openRecordAsUnlinkedCopy(record, deps)`, `openPaneInNewTab(record, pane, deps)`, `jumpToRecord(record, deps)`, `findRecordByTabKey(groups, tabKey)`, `TabsRegistryGroups`, `OpenTabRecordDeps`) match across Task 3 (definition + tests), Task 4 (menu-defs imports), Task 5 (provider imports), Task 6 (TabsView wrappers). `ContextIds.TabsCard = 'tabs-card'` and `{ kind: 'tabs-card'; tabKey }` are consistent across Tasks 2, 4, 5, 6.
- **Known coupling:** Task 4 makes `MenuActions` fields required, which can force the provider's actions-bag additions into Task 4's commit to keep typecheck green — Task 4 Step 4 documents the resolution explicitly.

### Load-bearing validation addendum (2026-08-09)

A load-bearing assumption pass (ledger: `../../../.the-usual-logs/longpress-contextmenu-race/load-bearing-ledger.md`) verified 4 assumptions, falsified 3, and accepted 1 residual. Plan changes applied:

- **Mechanism reframed (A1 inconclusive/acceptable):** Chromium-Android synthesizes no click after a native `contextmenu` (`GestureLongTap` no-op); the best source-supported killer is the un-cancelled timer's `elementFromPoint` double-open replacing the menu with the `Global` fallback. Fix 1 (timer cancellation + duplicate-open swallow) cures it; suppression retained for timer-first ordering and non-Chromium engines. Architecture note + Task 1 mechanism note added.
- **Position source hardened (A7):** race branch prefers `touchStartPos` over event coords; Task 1 gained test 4 (drifted-coords). Test counts updated (Task 1: 15, longpress file after Task 5: 17).
- **`status` discriminator added (A5 falsified):** `tabKey` is NOT unique across registry groups (same-device multi-window puts one key in `localOpen` + `closed`). `ContextTarget` gained `status: 'open' | 'closed'`; cards emit `data-tab-status`; `findRecordByTabKey` gained a status-preference parameter. Consistency re-checked across Task 2 (type + parser + tests), Task 3 (signature + impl + test), Task 4 (`target.status` pass-through + test targets), Task 6 (card attribute).
- **Memo probe redesigned (A3 falsified by execution):** react-redux 9 skips selectors on no-dispatch re-renders; Task 6 Step 5 now counts `paneKindLabel` calls (renders), not selector invocations.
- **Anchors (A4 falsified):** line numbers are pre-plan hints; symbols authoritative (Global Constraints note).
- **Verified (relied on without change):** prevented mid-gesture `contextmenu` → cancelable `touchend` whose `preventDefault()` suppresses the synthetic click (spec + Chromium source); post-open `touchmove` cannot disarm suppression (parity with iOS path); continuous provider subscription to `selectTabsRegistryGroups` is memoized, bounded (60 s recency buckets, doubly gated) and warning-free — lazy `getState()` not required.
- **Residual risks (accepted, need a real-device trace):** post-open drift-scroll dismissal via the provider's capture-scroll listener is NOT addressed by Fix 1 (Chromium allows scroll after long-press); long-press on selectable `TabItem` labels (no `select-none`, unlike cards) can start text selection → `touchcancel`-shaped orderings. Optional hardening if devices confirm: `select-none` on `data-context` touch targets and/or a short post-open dismissal-immunity window. Samsung Internet/WebView behavior is source-inferred, not device-verified.

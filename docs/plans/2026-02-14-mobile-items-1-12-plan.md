# Mobile Items 1-12 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the first 12 items from the mobile responsive audit — foundation, touch targets, sidebar gestures, and tab navigation — to make Freshell usable and intuitive on mobile devices.

**Architecture:** Mobile-first Tailwind responsive utilities (`md:` prefix for desktop overrides), `@use-gesture/react` for swipe/long-press gestures, and a `useMobile()` hook for JS-level mobile detection. Touch targets raised to 44px minimum on mobile. New components for mobile tab strip and tab switcher overlay.

**Tech Stack:** React 18, Tailwind CSS responsive utilities, `@use-gesture/react`, Vitest + Testing Library

---

## Task 1: Install `@use-gesture/react`

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run:
```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && npm install @use-gesture/react
```

Expected: Package added to `dependencies` in `package.json`.

**Step 2: Verify the install**

Run:
```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && node -e "require('@use-gesture/react')" 2>&1 || echo "ESM module, checking..." && ls node_modules/@use-gesture/react/package.json
```

Expected: File exists, no errors.

**Step 3: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add package.json package-lock.json && git commit -m "chore: install @use-gesture/react for mobile gesture handling"
```

---

## Task 2: Create `useMobile` hook

**Files:**
- Create: `src/hooks/useMobile.ts`
- Create: `test/unit/client/hooks/useMobile.test.ts`

**Step 1: Write the failing test**

Create `test/unit/client/hooks/useMobile.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// We need to mock matchMedia before importing the hook
const listeners: Array<(e: { matches: boolean }) => void> = []
let currentMatches = false

beforeEach(() => {
  listeners.length = 0
  currentMatches = false
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: currentMatches,
    media: query,
    addEventListener: vi.fn((_event: string, cb: (e: { matches: boolean }) => void) => {
      listeners.push(cb)
    }),
    removeEventListener: vi.fn((_event: string, cb: (e: { matches: boolean }) => void) => {
      const idx = listeners.indexOf(cb)
      if (idx >= 0) listeners.splice(idx, 1)
    }),
  })))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMobile', () => {
  it('returns false when viewport is wider than 768px', async () => {
    currentMatches = false
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(false)
  })

  it('returns true when viewport is narrower than 768px', async () => {
    currentMatches = true
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(true)
  })

  it('updates when viewport crosses the breakpoint', async () => {
    currentMatches = false
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(false)

    act(() => {
      for (const cb of listeners) cb({ matches: true })
    })
    expect(result.current).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npx vitest run test/unit/client/hooks/useMobile.test.ts`

Expected: FAIL — module `@/hooks/useMobile` not found.

**Step 3: Write minimal implementation**

Create `src/hooks/useMobile.ts`:

```typescript
import { useSyncExternalStore } from 'react'

const MOBILE_QUERY = '(max-width: 767px)'

let mql: MediaQueryList | null = null

function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_QUERY)
  return mql
}

function subscribe(callback: () => void): () => void {
  const m = getMql()
  m.addEventListener('change', callback)
  return () => m.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return getMql().matches
}

function getServerSnapshot(): boolean {
  return false
}

export function useMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
```

**Step 4: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npx vitest run test/unit/client/hooks/useMobile.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/hooks/useMobile.ts test/unit/client/hooks/useMobile.test.ts && git commit -m "feat: add useMobile hook for responsive JS detection

Uses useSyncExternalStore with matchMedia('(max-width: 767px)') for
tear-free mobile viewport detection. No prop drilling needed — components
import the hook directly."
```

---

## Task 3: Touch targets — Tab close button and new tab button (#6 partial)

**Files:**
- Modify: `src/components/TabItem.tsx:172-186` (close button)
- Modify: `src/components/TabBar.tsx:323-331` (new tab button)
- Create: `test/unit/client/components/TabBar.mobile.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/TabBar.mobile.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'req-1',
            title: 'Tab 1',
            titleSetByUser: false,
            status: 'running' as const,
            mode: 'shell' as const,
            shell: 'system' as const,
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf' as const,
            id: 'pane-1',
            content: {
              kind: 'terminal' as const,
              mode: 'shell' as const,
              createRequestId: 'req-1',
              status: 'running' as const,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
      },
      connection: { status: 'ready', lastError: undefined, platform: 'linux', reconnectAttempts: 0, availableClis: {} } as any,
      settings: { settings: defaultSettings, loaded: true } as any,
    },
  })
}

afterEach(() => cleanup())

describe('TabBar mobile touch targets', () => {
  it('new tab button has min-h-11 min-w-11 class for mobile touch target', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    const newTabButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(newTabButton.className).toMatch(/min-h-11/)
    expect(newTabButton.className).toMatch(/min-w-11/)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npx vitest run test/unit/client/components/TabBar.mobile.test.tsx`

Expected: FAIL — class `min-h-11` not found on the button.

**Step 3: Implement the touch target changes**

In `src/components/TabItem.tsx`, change the close button (line 172-186):

Replace:
```tsx
      <button
        className={cn(
          'ml-0.5 p-0.5 rounded transition-opacity',
```

With:
```tsx
      <button
        className={cn(
          'ml-0.5 p-0.5 md:p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded transition-opacity',
```

In `src/components/TabBar.tsx`, change the new tab button (line 323-331):

Replace:
```tsx
            <button
              className="flex-shrink-0 ml-1 mb-1 p-1 rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
```

With:
```tsx
            <button
              className="flex-shrink-0 ml-1 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
```

**Step 4: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npx vitest run test/unit/client/components/TabBar.mobile.test.tsx`

Expected: PASS

**Step 5: Run full test suite**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

Expected: All tests pass.

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/TabItem.tsx src/components/TabBar.tsx test/unit/client/components/TabBar.mobile.test.tsx && git commit -m "feat(mobile): increase tab close and new-tab button touch targets to 44px

Add min-h-11 min-w-11 (44px) on mobile with md:min-h-0 md:min-w-0 to
restore desktop sizing. Close button was 16x16px, new tab was 22x22px —
both far below iOS 44px minimum."
```

---

## Task 4: Touch targets — Header buttons (#10)

**Files:**
- Modify: `src/App.tsx:470-531` (header bar buttons)
- Modify: `test/unit/client/components/TabBar.mobile.test.tsx` (add header tests) OR create new test

**Step 1: Write the failing test**

Add to `test/unit/client/components/TabBar.mobile.test.tsx` (or create `test/unit/client/components/App.mobile.test.tsx` — use whichever is cleaner given the existing App.test.tsx mock setup):

The test should render `App` and check that the sidebar toggle, theme toggle, and share button all have `min-h-11 min-w-11` classes.

Since App.test.tsx already exists with mocks, create a separate `test/unit/client/components/App.mobile.test.tsx` that imports from the existing test setup pattern.

**Step 2: Implement header button touch target changes**

In `src/App.tsx`, for each button in the header bar (lines 472-518), add `min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center` to the existing className.

Sidebar toggle button (line 474):
```tsx
className="p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
```

Theme toggle button (line 498):
```tsx
className="p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
```

Share button (line 509):
```tsx
className="p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md hover:bg-muted transition-colors"
```

Connection status indicator (line 520):
```tsx
className="p-1.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
```

**Step 3: Run tests and commit**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/App.tsx test/unit/client/components/App.mobile.test.tsx && git commit -m "feat(mobile): increase header button touch targets to 44px

Sidebar toggle, theme, share, and connection status indicators all get
min-h-11 min-w-11 on mobile. Previously 22x22px (p-1.5 + 14px icon)."
```

---

## Task 5: Tab bar height increase (#7)

**Files:**
- Modify: `src/components/TabBar.tsx:240` (container height)

**Step 1: Write the failing test**

Add to `test/unit/client/components/TabBar.mobile.test.tsx`:

```typescript
it('tab bar container has h-12 for mobile and md:h-10 for desktop', () => {
  const store = createStore()
  render(
    <Provider store={store}>
      <TabBar />
    </Provider>
  )
  // The tab bar is the outermost div with z-20
  const tabBar = screen.getByRole('button', { name: 'New shell tab' }).closest('.z-20')
  expect(tabBar?.className).toMatch(/h-12/)
  expect(tabBar?.className).toMatch(/md:h-10/)
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement**

In `src/components/TabBar.tsx` line 240, change:
```tsx
<div className="relative z-20 h-10 flex items-end px-2 bg-background" data-context={ContextIds.Global}>
```
To:
```tsx
<div className="relative z-20 h-12 md:h-10 flex items-end px-2 bg-background" data-context={ContextIds.Global}>
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/TabBar.tsx test/unit/client/components/TabBar.mobile.test.tsx && git commit -m "feat(mobile): increase tab bar height to 48px on mobile

h-10 (40px) → h-12 md:h-10 (48px mobile, 40px desktop) for better
touch target spacing between tabs."
```

---

## Task 6: Context menu item touch targets (#9)

**Files:**
- Modify: `src/components/context-menu/ContextMenu.tsx:135-136`
- Create: `test/unit/client/components/context-menu/ContextMenu.mobile.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/context-menu/ContextMenu.mobile.test.tsx`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ContextMenu } from '@/components/context-menu/ContextMenu'

afterEach(() => cleanup())

describe('ContextMenu mobile touch targets', () => {
  it('menu items have py-3 for mobile and md:py-2 for desktop', () => {
    render(
      <ContextMenu
        open={true}
        position={{ x: 100, y: 100 }}
        onClose={() => {}}
        items={[
          { type: 'item', id: 'test', label: 'Test Item', onSelect: () => {} },
        ]}
      />
    )

    const menuItem = screen.getByRole('menuitem', { name: 'Test Item' })
    expect(menuItem.className).toMatch(/py-3/)
    expect(menuItem.className).toMatch(/md:py-2/)
  })
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement**

In `src/components/context-menu/ContextMenu.tsx` line 135-136, change:

```tsx
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
```

To:

```tsx
            className={cn(
              'flex w-full items-center gap-2 px-4 py-3 md:px-3 md:py-2 text-left text-sm transition-colors',
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/context-menu/ContextMenu.tsx test/unit/client/components/context-menu/ContextMenu.mobile.test.tsx && git commit -m "feat(mobile): increase context menu item touch targets

px-3 py-2 → px-4 py-3 md:px-3 md:py-2. Menu items were ~32px tall,
now ~48px on mobile for comfortable tapping."
```

---

## Task 7: Sidebar session item touch targets (#8)

**Files:**
- Modify: `src/components/Sidebar.tsx:410-411` (SidebarItem button)

**Step 1: Write the failing test**

Add to `test/unit/client/components/Sidebar.test.tsx` (or create a new `Sidebar.mobile.test.tsx`):

```typescript
it('session items have py-3 on mobile and md:py-2 on desktop', () => {
  // Render sidebar with at least one session, then check the button className
  // ... (follow existing Sidebar.test.tsx pattern for store setup)
  const button = screen.getAllByRole('button').find(b => b.dataset.context === 'sidebar-session')
  expect(button?.className).toMatch(/py-3/)
  expect(button?.className).toMatch(/md:py-2/)
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement**

In `src/components/Sidebar.tsx`, the `SidebarItem` component (line 410-411), change:

```tsx
            'w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors group',
```

To:

```tsx
            'w-full flex items-center gap-2 px-2 py-3 md:py-2 rounded-md text-left transition-colors group',
```

Also in the sidebar navigation buttons (line 347), increase touch targets:

```tsx
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs transition-colors',
```

To:

```tsx
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 md:py-1.5 min-h-11 md:min-h-0 rounded-md text-xs transition-colors',
```

And the search clear button (line 314):

```tsx
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
```

To:

```tsx
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/Sidebar.tsx && git commit -m "feat(mobile): increase sidebar touch targets

Session items py-2 → py-3 md:py-2 (~48px mobile).
Nav buttons py-1.5 → py-2.5 md:py-1.5 + min-h-11.
Search clear button gets 44px touch target."
```

---

## Task 8: Terminal search bar touch targets (#6 partial)

**Files:**
- Modify: `src/components/terminal/TerminalSearchBar.tsx:46-69`

**Step 1: Write the failing test**

Add to `test/unit/client/components/TerminalView.search.test.tsx` (or create a new test file):

```typescript
it('search buttons have min-h-11 mobile touch targets', () => {
  render(
    <TerminalSearchBar
      query=""
      onQueryChange={() => {}}
      onFindNext={() => {}}
      onFindPrevious={() => {}}
      onClose={() => {}}
    />
  )
  const prevButton = screen.getByRole('button', { name: /prev/i })
  const nextButton = screen.getByRole('button', { name: /next/i })
  const closeButton = screen.getByRole('button', { name: /close/i })

  for (const btn of [prevButton, nextButton, closeButton]) {
    expect(btn.className).toMatch(/min-h-11/)
  }
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement**

In `src/components/terminal/TerminalSearchBar.tsx`, update the three buttons:

```tsx
      <button
        type="button"
        className="h-8 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md px-2 text-xs"
        onClick={onFindPrevious}
        aria-label="Previous match"
      >
        Prev
      </button>
      <button
        type="button"
        className="h-8 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md px-2 text-xs"
        onClick={onFindNext}
        aria-label="Next match"
      >
        Next
      </button>
      <button
        type="button"
        className="h-8 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md px-2 text-xs"
        onClick={onClose}
        aria-label="Close search"
      >
        Close
      </button>
```

Note: Add `aria-label` attributes to the buttons — they currently lack them, which violates the a11y requirements in AGENTS.md.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/terminal/TerminalSearchBar.tsx && git commit -m "feat(mobile): increase terminal search button touch targets

Add min-h-11 min-w-11 and aria-labels to Prev/Next/Close buttons.
Previously 28-32px, now 44px minimum on mobile."
```

---

## Task 9: Sidebar backdrop tap-to-close verification (#12)

**Files:**
- Modify: `src/App.tsx:536-546` (if needed)
- Test: `test/unit/client/components/App.test.tsx` (add or verify test)

**Step 1: Write the test**

Add to `test/unit/client/components/App.test.tsx` (or `App.mobile.test.tsx`):

```typescript
it('sidebar backdrop closes sidebar on touch/click', async () => {
  // Render App with sidebar open and isMobile = true
  // Mock window.innerWidth < 768
  // Verify backdrop element exists with role="presentation"
  // Fire click event on backdrop
  // Verify sidebar collapses
})
```

**Step 2: Verify the existing implementation**

The existing code at `App.tsx:536-546` already has:
- `role="presentation"`
- `onClick={toggleSidebarCollapse}`
- `onKeyDown` with Escape handler
- `tabIndex={-1}`

This looks correct. Verify with the test. If it passes, this task is mostly confirming existing behavior works and adding the `onTouchEnd` handler for iOS reliability:

```tsx
        {isMobile && !sidebarCollapsed && (
          <div
            className="absolute inset-0 bg-black/50 z-10"
            role="presentation"
            onClick={toggleSidebarCollapse}
            onTouchEnd={(e) => {
              e.preventDefault()
              toggleSidebarCollapse()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') toggleSidebarCollapse()
            }}
            tabIndex={-1}
          />
        )}
```

The `onTouchEnd` with `preventDefault()` ensures the touch event fires reliably on iOS Safari, which can sometimes delay click events by 300ms.

**Step 3: Run tests, commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/App.tsx && git commit -m "fix(mobile): add onTouchEnd to sidebar backdrop for iOS reliability

iOS Safari can delay click events by 300ms. onTouchEnd with
preventDefault() ensures the backdrop closes immediately on touch."
```

---

## Task 10: Swipe sidebar open/close (#11)

**Files:**
- Modify: `src/App.tsx` (add swipe gesture to main content area)
- Create: `test/unit/client/components/App.swipe-sidebar.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/App.swipe-sidebar.test.tsx`. This tests the swipe behavior in isolation. Since `@use-gesture/react` uses pointer events, we can simulate them:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
// ... (standard App test setup with mocks)

describe('Swipe sidebar', () => {
  it('right swipe from left edge opens sidebar', () => {
    // 1. Render App with sidebar collapsed, isMobile=true
    // 2. Find the main content area (data-testid="main-content-area")
    // 3. Simulate pointerdown near left edge (x=10), then pointermove (x=100), then pointerup
    // 4. Verify sidebar is now open
  })

  it('left swipe closes open sidebar', () => {
    // 1. Render App with sidebar open, isMobile=true
    // 2. Find the backdrop or main area
    // 3. Simulate left swipe
    // 4. Verify sidebar is now closed
  })
})
```

Note: Testing gesture libraries with synthetic events can be unreliable. Consider testing the callback function that the gesture triggers, rather than the gesture detection itself. Extract the swipe handler into a testable function.

**Step 2: Implement the swipe gesture**

In `src/App.tsx`:

1. Import at the top:
```typescript
import { useDrag } from '@use-gesture/react'
import { useMobile } from '@/hooks/useMobile'
```

2. Inside the `App` component, replace the existing `isMobile` state logic with the hook. Find the existing `isMobile` state (line 91) and related effect (lines 107-114), and replace with:
```typescript
const isMobile = useMobile()
```

Remove the `MOBILE_BREAKPOINT` constant (line 66), the `useState(false)` (line 91), and the resize event effect (lines 107-114) since `useMobile()` handles all of this.

3. Add the swipe gesture binding:
```typescript
  const bindSwipe = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last, xy: [startX] }) => {
      if (!isMobile) return
      if (!last) return // Only act on gesture end

      const isFromLeftEdge = first ? startX < 30 : true
      const swipedRight = dx > 0 && (mx > 50 || vx > 0.5)
      const swipedLeft = dx < 0 && (Math.abs(mx) > 50 || vx > 0.5)

      if (swipedRight && sidebarCollapsed && isFromLeftEdge) {
        toggleSidebarCollapse()
      } else if (swipedLeft && !sidebarCollapsed) {
        toggleSidebarCollapse()
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    }
  )
```

4. Apply the gesture binding to the main content area. On the `<div className="flex-1 min-h-0 flex relative" ref={mainContentRef}>` element (line 534), add `data-testid="main-content-area"` and spread `{...bindSwipe()}`:

```tsx
      <div
        className="flex-1 min-h-0 flex relative"
        ref={mainContentRef}
        data-testid="main-content-area"
        {...(isMobile ? bindSwipe() : {})}
      >
```

Note: The `@use-gesture/react` `useDrag` gesture needs `touch-action: pan-y` on the target to allow vertical scrolling while capturing horizontal swipes. Add this to the style or className. However, the terminal area handles its own touch events, so we need to be careful. The gesture should only trigger on the edges.

**Step 3: Refine — edge-only detection**

Actually, `@use-gesture/react` doesn't natively support "only start from left edge". We handle this by checking `startX` in the handler. The `first` flag tells us if this is the first event in the gesture, where `xy` contains the start position.

Revised handler:
```typescript
  const swipeStartXRef = useRef(0)

  const bindSwipe = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last, xy: [x] }) => {
      if (!isMobile) return
      if (first) {
        swipeStartXRef.current = x
        return
      }
      if (!last) return

      const startX = swipeStartXRef.current
      const swipedRight = dx > 0 && (mx > 50 || vx > 0.5)
      const swipedLeft = dx < 0 && (Math.abs(mx) > 50 || vx > 0.5)

      if (swipedRight && sidebarCollapsed && startX < 30) {
        toggleSidebarCollapse()
      } else if (swipedLeft && !sidebarCollapsed) {
        toggleSidebarCollapse()
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    }
  )
```

**Step 4: Run tests, verify pass**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/App.tsx test/unit/client/components/App.swipe-sidebar.test.tsx && git commit -m "feat(mobile): swipe to open/close sidebar (#11)

Right-swipe from left 30px edge opens sidebar. Left-swipe anywhere
closes it. Uses @use-gesture/react useDrag with velocity and distance
thresholds. Only active on mobile viewport.

Also replaces manual isMobile state + resize listener with useMobile()
hook for cleaner detection."
```

---

## Task 11: Swipe to switch tabs (#1)

**Files:**
- Modify: `src/App.tsx` (add horizontal swipe gesture to terminal work area)
- Create: `test/unit/client/components/App.swipe-tabs.test.tsx`

**Step 1: Write the failing test**

```typescript
describe('Swipe tabs', () => {
  it('left swipe dispatches switchToNextTab', () => {
    // Render App with 2+ tabs, mobile viewport
    // Simulate left swipe on terminal work area
    // Verify active tab changed
  })

  it('right swipe dispatches switchToPrevTab', () => {
    // Similar but opposite direction
  })

  it('right swipe on first tab opens sidebar instead', () => {
    // On first tab, right swipe opens sidebar
  })
})
```

**Step 2: Implement**

The swipe-tabs gesture must be on the terminal work area, not the main content area (which has the sidebar swipe). In `src/App.tsx`, in the content function that renders the terminal view (line 438-455):

```typescript
  // Inside the content function, wrap the terminal area:
  const tabSwipeBind = useDrag(
    ({ movement: [mx], velocity: [vx], direction: [dx], first, last }) => {
      if (!isMobile || !last) return

      const swipedLeft = dx < 0 && (Math.abs(mx) > 50 || vx > 0.5)
      const swipedRight = dx > 0 && (mx > 50 || vx > 0.5)

      if (swipedLeft) {
        dispatch(switchToNextTab())
      } else if (swipedRight) {
        // If on first tab, open sidebar instead
        const currentIndex = tabs.findIndex(t => t.id === activeTabId)
        if (currentIndex === 0) {
          if (sidebarCollapsed) toggleSidebarCollapse()
        } else {
          dispatch(switchToPrevTab())
        }
      }
    },
    {
      axis: 'x',
      filterTaps: true,
      pointer: { touch: true },
    }
  )
```

Apply to the terminal work area div:
```tsx
          <div
            className="flex-1 min-h-0 relative bg-background"
            data-testid="terminal-work-area"
            {...(isMobile ? tabSwipeBind() : {})}
          >
```

**Important:** The `touch-action` CSS needs to be set to `pan-y` so vertical scrolling (terminal scrollback) still works while horizontal swipes are captured. Add `style={{ touchAction: 'pan-y' }}` to the div or use a Tailwind class.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/App.tsx test/unit/client/components/App.swipe-tabs.test.tsx && git commit -m "feat(mobile): swipe left/right to switch tabs (#1)

Left swipe → next tab. Right swipe → previous tab. Right swipe on the
first tab opens the sidebar instead. Uses @use-gesture/react useDrag
with velocity thresholds. Only active on mobile viewport."
```

---

## Task 12: Mobile tab strip (#2)

**Files:**
- Create: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/TabBar.tsx` (conditional render)
- Create: `test/unit/client/components/MobileTabStrip.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/MobileTabStrip.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn(), close: vi.fn() }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

// Mock useMobile to return true
vi.mock('@/hooks/useMobile', () => ({
  useMobile: () => true,
}))

function createStore(tabs: Array<{ id: string; title: string }>, activeTabId: string) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: tabs.map(t => ({
          ...t,
          createRequestId: t.id,
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        })),
        activeTabId,
        renameRequestTabId: null,
      },
      panes: { layouts: {}, activePane: {} },
      connection: { status: 'ready', lastError: undefined, platform: 'linux', reconnectAttempts: 0, availableClis: {} } as any,
      settings: { settings: defaultSettings, loaded: true } as any,
    },
  })
}

afterEach(() => cleanup())

describe('MobileTabStrip', () => {
  it('shows active tab name with position indicator', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [
        { id: 'tab-1', title: 'Tab 1' },
        { id: 'tab-2', title: 'Tab 2' },
        { id: 'tab-3', title: 'Tab 3' },
      ],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByText('Tab 2')).toBeInTheDocument()
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })

  it('has previous and next navigation buttons', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [
        { id: 'tab-1', title: 'Tab 1' },
        { id: 'tab-2', title: 'Tab 2' },
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /previous tab/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next tab/i })).toBeInTheDocument()
  })
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement MobileTabStrip**

Create `src/components/MobileTabStrip.tsx`:

```tsx
import { ChevronLeft, ChevronRight, LayoutGrid } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { useCallback, useMemo, useState } from 'react'

export function MobileTabStrip({ onOpenSwitcher }: { onOpenSwitcher?: () => void }) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const paneLayouts = useAppSelector((s) => s.panes.layouts)

  const activeIndex = tabs.findIndex((t) => t.id === activeTabId)
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  const displayTitle = useMemo(() => {
    if (!activeTab) return ''
    return getTabDisplayTitle(activeTab, paneLayouts[activeTab.id])
  }, [activeTab, paneLayouts])

  const isFirst = activeIndex <= 0
  const isLast = activeIndex >= tabs.length - 1

  return (
    <div className="h-12 flex items-center px-2 bg-background border-b border-border/30">
      <button
        className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30"
        onClick={() => dispatch(switchToPrevTab())}
        disabled={isFirst}
        aria-label="Previous tab"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <button
        className="flex-1 flex items-center justify-center gap-2 min-h-11 rounded-md"
        onClick={onOpenSwitcher}
        aria-label="Open tab switcher"
      >
        <span className="text-sm font-medium truncate max-w-[200px]">
          {displayTitle || 'Untitled'}
        </span>
        <span className="text-xs text-muted-foreground">
          {activeIndex + 1} / {tabs.length}
        </span>
      </button>

      <button
        className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-30"
        onClick={() => dispatch(switchToNextTab())}
        disabled={isLast}
        aria-label="Next tab"
      >
        <ChevronRight className="h-5 w-5" />
      </button>

      {onOpenSwitcher && (
        <button
          className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          onClick={onOpenSwitcher}
          aria-label="Tab switcher"
        >
          <LayoutGrid className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
```

**Step 4: Integrate into TabBar**

In `src/components/TabBar.tsx`, conditionally render `MobileTabStrip` on mobile:

```tsx
import { useMobile } from '@/hooks/useMobile'
import { MobileTabStrip } from './MobileTabStrip'

// Inside TabBar component, before the return:
const isMobile = useMobile()

if (tabs.length === 0) return null

if (isMobile) {
  return <MobileTabStrip />
}

// ... existing desktop TabBar JSX
```

**Step 5: Run tests, verify pass**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/MobileTabStrip.tsx src/components/TabBar.tsx test/unit/client/components/MobileTabStrip.test.tsx && git commit -m "feat(mobile): add MobileTabStrip for simplified tab navigation (#2)

Shows active tab name centered with position indicator (e.g. '2 / 3').
Chevron buttons for prev/next. Tap center to open tab switcher (future).
Replaces the full scrollable tab bar on mobile viewports."
```

---

## Task 13: Tab switcher overlay (#4)

**Files:**
- Create: `src/components/TabSwitcher.tsx`
- Modify: `src/components/TabBar.tsx` (wire up switcher)
- Modify: `src/components/MobileTabStrip.tsx` (pass onOpenSwitcher)
- Create: `test/unit/client/components/TabSwitcher.test.tsx`

**Step 1: Write the failing test**

Create `test/unit/client/components/TabSwitcher.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn(), close: vi.fn() }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

function createStore(tabs: Array<{ id: string; title: string }>, activeTabId: string) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: tabs.map(t => ({
          ...t,
          createRequestId: t.id,
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        })),
        activeTabId,
        renameRequestTabId: null,
      },
      panes: { layouts: {}, activePane: {} },
      connection: { status: 'ready', lastError: undefined, platform: 'linux', reconnectAttempts: 0, availableClis: {} } as any,
      settings: { settings: defaultSettings, loaded: true } as any,
    },
  })
}

afterEach(() => cleanup())

describe('TabSwitcher', () => {
  it('renders all tabs as cards', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        { id: 'tab-1', title: 'Shell' },
        { id: 'tab-2', title: 'Claude' },
        { id: 'tab-3', title: 'Codex' },
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('highlights the active tab', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        { id: 'tab-1', title: 'Shell' },
        { id: 'tab-2', title: 'Claude' },
      ],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    const claudeCard = screen.getByText('Claude').closest('[role="button"]')
    expect(claudeCard?.className).toMatch(/ring-2|border-primary/)
  })

  it('switches tab and closes on card tap', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const onClose = vi.fn()
    const store = createStore(
      [
        { id: 'tab-1', title: 'Shell' },
        { id: 'tab-2', title: 'Claude' },
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={onClose} />
      </Provider>
    )

    fireEvent.click(screen.getByText('Claude'))
    expect(onClose).toHaveBeenCalled()
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })
})
```

**Step 2: Run test, verify failure**

**Step 3: Implement TabSwitcher**

Create `src/components/TabSwitcher.tsx`:

```tsx
import { X, Plus } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { setActiveTab, addTab } from '@/store/tabsSlice'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import PaneIcon from '@/components/icons/PaneIcon'
import { collectPaneContents } from '@/lib/pane-utils'

export function TabSwitcher({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const paneLayouts = useAppSelector((s) => s.panes.layouts)

  const handleSelect = (tabId: string) => {
    dispatch(setActiveTab(tabId))
    onClose()
  }

  const handleNewTab = () => {
    dispatch(addTab({ mode: 'shell' }))
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/95 flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-border/30">
        <h2 className="text-sm font-medium">{tabs.length} Tabs</h2>
        <button
          className="min-h-11 min-w-11 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Close tab switcher"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            const title = getTabDisplayTitle(tab, paneLayouts[tab.id])
            const paneContents = paneLayouts[tab.id]
              ? collectPaneContents(paneLayouts[tab.id])
              : undefined

            return (
              <div
                key={tab.id}
                role="button"
                tabIndex={0}
                aria-label={`Switch to ${title}`}
                className={cn(
                  'rounded-lg border p-3 flex flex-col gap-2 transition-colors',
                  isActive
                    ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                    : 'border-border hover:border-foreground/30 hover:bg-muted/50'
                )}
                onClick={() => handleSelect(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleSelect(tab.id)
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  {paneContents?.[0] && (
                    <PaneIcon
                      content={paneContents[0]}
                      className="h-4 w-4 text-muted-foreground"
                    />
                  )}
                  <span className="text-sm font-medium truncate">{title}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {tab.status === 'running' ? 'Running' : tab.status === 'exited' ? 'Exited' : 'Creating...'}
                </span>
              </div>
            )
          })}

          {/* New tab card */}
          <button
            className="rounded-lg border border-dashed border-muted-foreground/40 p-3 flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground hover:border-foreground/50 transition-colors min-h-[80px]"
            onClick={handleNewTab}
            aria-label="New tab"
          >
            <Plus className="h-5 w-5" />
            <span className="text-sm">New Tab</span>
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Step 4: Wire up in TabBar**

In `src/components/TabBar.tsx`, add state for the switcher and pass it to MobileTabStrip:

```tsx
const [showSwitcher, setShowSwitcher] = useState(false)

if (isMobile) {
  return (
    <>
      <MobileTabStrip onOpenSwitcher={() => setShowSwitcher(true)} />
      {showSwitcher && <TabSwitcher onClose={() => setShowSwitcher(false)} />}
    </>
  )
}
```

**Step 5: Run tests, verify pass**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/TabSwitcher.tsx src/components/TabBar.tsx src/components/MobileTabStrip.tsx test/unit/client/components/TabSwitcher.test.tsx && git commit -m "feat(mobile): add tab switcher overlay (#4)

Fullscreen grid of all open tabs as cards. Tap to switch, with active
tab highlighted. New Tab card at the end. Triggered from the tab name
or grid icon in MobileTabStrip."
```

---

## Task 14: Long-press on tab for context menu (#3)

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (add touch long-press detection)
- Create: `test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`

**Step 1: Write the failing test**

```typescript
describe('Long-press context menu', () => {
  it('opens context menu on 500ms touch hold without movement', () => {
    // Render a tab with context menu provider
    // Simulate touchstart on the tab
    // Wait 500ms (vi.advanceTimersByTime)
    // Verify context menu opens
  })

  it('does not open context menu if touch moves during hold', () => {
    // Simulate touchstart + touchmove
    // Wait 500ms
    // Verify context menu does NOT open
  })
})
```

**Step 2: Implement**

In `src/components/context-menu/ContextMenuProvider.tsx`, add a touch long-press handler alongside the existing contextmenu handler.

Add in the `useEffect` that sets up event listeners (around line 608):

```typescript
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    let touchStartPos: { x: number; y: number } | null = null

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (!touch) return
      touchStartPos = { x: touch.clientX, y: touch.clientY }

      longPressTimer = setTimeout(() => {
        if (!touchStartPos) return
        const target = document.elementFromPoint(touchStartPos.x, touchStartPos.y) as HTMLElement | null
        if (!target) return

        const contextEl = findContextElement(target)
        const contextId = resolveContextId(contextEl?.dataset.context)
        if (!contextId) return

        // Prevent the subsequent click/tap from firing
        e.preventDefault?.()

        openMenu({
          position: { x: touchStartPos.x, y: touchStartPos.y },
          target: parseContextTarget(contextId),
          contextElement: contextEl,
          clickTarget: target,
          dataset: copyDataset(contextEl),
        })
        touchStartPos = null
      }, 500)
    }

    const handleTouchMove = (e: TouchEvent) => {
      if (!touchStartPos || !longPressTimer) return
      const touch = e.touches[0]
      if (!touch) return
      const dx = Math.abs(touch.clientX - touchStartPos.x)
      const dy = Math.abs(touch.clientY - touchStartPos.y)
      if (dx > 10 || dy > 10) {
        clearTimeout(longPressTimer)
        longPressTimer = null
        touchStartPos = null
      }
    }

    const handleTouchEnd = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
      touchStartPos = null
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: false })
    document.addEventListener('touchmove', handleTouchMove, { passive: true })
    document.addEventListener('touchend', handleTouchEnd)
    document.addEventListener('touchcancel', handleTouchEnd)

    // In cleanup:
    return () => {
      // ... existing cleanup
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleTouchEnd)
      document.removeEventListener('touchcancel', handleTouchEnd)
      if (longPressTimer) clearTimeout(longPressTimer)
    }
```

**Step 3: Handle dnd-kit conflict**

The dnd-kit `TouchSensor` has a 250ms delay. Our long-press fires at 500ms. If dnd-kit starts a drag at 250ms+5px movement, our long-press timer should be cancelled (the touchmove handler already does this if movement > 10px). If the user holds still for 500ms, we show the context menu and need to cancel the dnd-kit drag. This should work naturally because dnd-kit requires 5px of movement to activate, while our long-press requires NO movement.

**Step 4: Run tests, verify pass**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx && git commit -m "feat(mobile): long-press to open context menu on touch (#3)

500ms touch hold without movement opens the context menu, matching the
standard mobile pattern. Movement > 10px cancels the timer, allowing
dnd-kit drag to take over. Works alongside the existing contextmenu
event handler."
```

---

## Task 15: Swipe down to reveal tab bar (#5) — Stub

**Files:**
- Modify: `src/App.tsx` (add comment/stub for future fullscreen mode)

This item depends on fullscreen mode (#29) which is not in this batch. For now, we document the intent and ensure the gesture infrastructure from Tasks 10-11 can be extended later.

**Step 1: Add a comment in App.tsx**

In the terminal content rendering area, add a TODO comment:

```tsx
// TODO(#5): When fullscreen mode (#29) is implemented, add a vertical swipe-down
// gesture here to reveal the hidden tab bar. The @use-gesture/react useDrag
// infrastructure from the sidebar swipe (Task 10) can be extended for this.
```

**Step 2: Commit**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add src/App.tsx && git commit -m "docs: add TODO for swipe-down tab bar reveal (#5)

Depends on fullscreen mode (#29). Gesture infrastructure is in place
from sidebar swipe implementation."
```

---

## Task 16: Full test suite verification and cleanup

**Step 1: Run full test suite**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm test`

Expected: All tests pass.

**Step 2: Run build**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm run build`

Expected: Build succeeds with no type errors.

**Step 3: Run lint**

Run: `cd /home/user/code/freshell/.worktrees/mobile-improvements && npm run lint`

Expected: No new a11y or lint violations.

**Step 4: Fix any issues found**

Address any test failures, type errors, or lint violations.

**Step 5: Final commit if cleanup was needed**

```bash
cd /home/user/code/freshell/.worktrees/mobile-improvements && git add -A && git commit -m "fix: address test/lint issues from mobile improvements batch"
```

---

## Summary

| Task | Item | Type | Complexity |
|------|------|------|------------|
| 1 | Foundation | Install dep | Trivial |
| 2 | `useMobile` hook | New hook + test | Low |
| 3 | Tab close/new-tab touch targets | CSS (#6) | Low |
| 4 | Header button touch targets | CSS (#10) | Low |
| 5 | Tab bar height | CSS (#7) | Trivial |
| 6 | Context menu touch targets | CSS (#9) | Low |
| 7 | Sidebar touch targets | CSS (#8) | Low |
| 8 | Search bar touch targets | CSS (#6) | Low |
| 9 | Sidebar backdrop (#12) | Fix/verify | Low |
| 10 | Swipe sidebar (#11) | Gesture | Medium |
| 11 | Swipe tabs (#1) | Gesture | Medium |
| 12 | Mobile tab strip (#2) | New component | Medium |
| 13 | Tab switcher (#4) | New component | Medium-High |
| 14 | Long-press context menu (#3) | Gesture | Medium |
| 15 | Swipe down stub (#5) | Comment | Trivial |
| 16 | Full verification | Testing | Low |

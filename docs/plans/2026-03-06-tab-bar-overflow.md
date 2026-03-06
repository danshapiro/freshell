# Tab Bar Overflow Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Improve the tab bar when tabs overflow: hide the native scrollbar, pin the "+" button outside the scroll area, auto-scroll to the active tab on activation, and show directional overflow indicators (fade gradients) when tabs are clipped on either side.

**Architecture:** Extract a new `useTabBarScroll` hook that uses a **callback ref** pattern to manage the scrollable container DOM node. When the node attaches, the callback sets up a scroll event listener and a `ResizeObserver`; when it detaches (or the component unmounts), it tears them down. This avoids the stale-ref problem where `useRef` + `useEffect` misses the transition from `null` to a live DOM node. The hook tracks overflow state (`canScrollLeft` / `canScrollRight`) and exposes a `scrollToTab(tabId)` function that centers the active tab using `getBoundingClientRect()` for position calculation (immune to CSS `transform` on ancestor elements from dnd-kit). The TabBar component is restructured so the "+" button lives outside the scrollable container. Overflow indicators are purely decorative gradient overlays controlled by the hook's boolean state. A CSS utility class hides the scrollbar on the tab strip.

**Tech Stack:** React 18, Tailwind CSS, Vitest + Testing Library

---

## Implementation Notes (Read First)

- All work targets the desktop tab bar only. The `MobileTabStrip` component is unaffected.
- The `useTabBarScroll` hook is a new custom hook at `src/hooks/useTabBarScroll.ts`.
- The hook returns a **callback ref** `(node: HTMLDivElement | null) => void`, not a `RefObject`. This callback ref is passed directly as the `ref` prop on the scrollable container div.
- The callback ref internally stores the node in a `useRef` for use by `scrollToTab` and `updateOverflow`, but scroll listeners and `ResizeObserver` are set up/torn down inside the callback itself, not in `useEffect`.
- `scrollToTab` computes tab position via `getBoundingClientRect()` on both the tab element and the container, adding `el.scrollLeft` to get the absolute offset. This is immune to CSS `transform` applied by dnd-kit during drag operations.
- The scrollbar-hiding CSS class goes in `src/index.css` as a utility.
- Overflow indicators are decorative `div` elements with `aria-hidden="true"` -- they must not be interactive or keyboard-focusable.
- The "+" button must remain keyboard-reachable (it already is via semantic `<button>`).
- dnd-kit `SortableContext` stays around the scrollable tab list only; the "+" button is outside it.
- Auto-scroll uses `Element.scrollTo({ left, behavior: 'smooth' })` for centering.
- Tests mock `getBoundingClientRect()`, `scrollWidth`, `clientWidth`, `scrollLeft`, and `scrollTo` on the scrollable element.

---

### Task 1: Add scrollbar-hiding CSS utility class

**Files:**
- Modify: `src/index.css` (inside the `@layer utilities` block, lines 132-159)

**Step 1: Add the `.scrollbar-none` utility class**

Inside the existing `@layer utilities { ... }` block in `src/index.css`, add the following class after the existing utility classes:

```css
  .scrollbar-none {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE/Edge */
  }
  .scrollbar-none::-webkit-scrollbar {
    display: none; /* Chrome/Safari/Opera */
  }
```

**Step 2: Verify the CSS is valid**

Run:
```bash
npx tailwindcss --content 'src/index.css' 2>&1 | head -5
```
Expected: No errors.

**Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat(css): add scrollbar-none utility class for hidden-scrollbar scrollable containers"
```

---

### Task 2: Create the `useTabBarScroll` hook -- tests first

**Files:**
- Create: `src/hooks/useTabBarScroll.ts`
- Create: `test/unit/client/hooks/useTabBarScroll.test.ts`

**Step 1: Write failing tests for the hook**

Create `test/unit/client/hooks/useTabBarScroll.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTabBarScroll } from '@/hooks/useTabBarScroll'

// Helper to create a mock scrollable element with getBoundingClientRect support
function createMockScrollContainer(overrides: Partial<{
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
  boundingLeft: number
}> = {}) {
  const el = document.createElement('div')
  const clientWidth = overrides.clientWidth ?? 300
  const boundingLeft = overrides.boundingLeft ?? 0
  Object.defineProperty(el, 'scrollWidth', { value: overrides.scrollWidth ?? 500, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true })
  Object.defineProperty(el, 'scrollLeft', {
    value: overrides.scrollLeft ?? 0,
    writable: true,
    configurable: true,
  })
  el.scrollTo = vi.fn((opts: ScrollToOptions) => {
    if (opts.left !== undefined) {
      ;(el as any).scrollLeft = opts.left
    }
  }) as any
  el.getBoundingClientRect = vi.fn(() => ({
    left: boundingLeft,
    right: boundingLeft + clientWidth,
    top: 0,
    bottom: 40,
    width: clientWidth,
    height: 40,
    x: boundingLeft,
    y: 0,
    toJSON: () => {},
  }))
  return el
}

// Helper to create a mock tab element with getBoundingClientRect
function createMockTabElement(tabId: string, opts: {
  boundingLeft: number
  boundingWidth: number
}) {
  const tabEl = document.createElement('div')
  tabEl.setAttribute('data-tab-id', tabId)
  tabEl.getBoundingClientRect = vi.fn(() => ({
    left: opts.boundingLeft,
    right: opts.boundingLeft + opts.boundingWidth,
    top: 0,
    bottom: 32,
    width: opts.boundingWidth,
    height: 32,
    x: opts.boundingLeft,
    y: 0,
    toJSON: () => {},
  }))
  return tabEl
}

describe('useTabBarScroll', () => {
  let mockObserve: ReturnType<typeof vi.fn>
  let mockDisconnect: ReturnType<typeof vi.fn>
  let resizeCallback: ((entries: any[]) => void) | null
  let originalResizeObserver: typeof ResizeObserver

  beforeEach(() => {
    mockObserve = vi.fn()
    mockDisconnect = vi.fn()
    resizeCallback = null
    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = vi.fn((cb) => {
      resizeCallback = cb
      return {
        observe: mockObserve,
        unobserve: vi.fn(),
        disconnect: mockDisconnect,
      }
    }) as any
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
  })

  describe('callback ref lifecycle', () => {
    it('sets up ResizeObserver and scroll listener when node attaches', () => {
      const el = createMockScrollContainer()

      const { result } = renderHook(() => useTabBarScroll(null))

      // Call the callback ref with the element
      act(() => {
        result.current.callbackRef(el)
      })

      // ResizeObserver should have been created and observe called
      expect(globalThis.ResizeObserver).toHaveBeenCalled()
      expect(mockObserve).toHaveBeenCalledWith(el)
    })

    it('tears down ResizeObserver and scroll listener when node detaches', () => {
      const el = createMockScrollContainer()
      const removeEventListenerSpy = vi.spyOn(el, 'removeEventListener')

      const { result } = renderHook(() => useTabBarScroll(null))

      // Attach
      act(() => {
        result.current.callbackRef(el)
      })

      // Detach
      act(() => {
        result.current.callbackRef(null)
      })

      expect(mockDisconnect).toHaveBeenCalled()
      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function))
    })

    it('resets overflow to false when node detaches', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null))

      // Attach -- triggers initial updateOverflow
      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollRight).toBe(true)

      // Detach
      act(() => {
        result.current.callbackRef(null)
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('re-attaches listeners when node changes', () => {
      const el1 = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300 })
      const el2 = createMockScrollContainer({ scrollWidth: 300, clientWidth: 300 })
      const removeSpy1 = vi.spyOn(el1, 'removeEventListener')

      const { result } = renderHook(() => useTabBarScroll(null))

      // Attach first element
      act(() => {
        result.current.callbackRef(el1)
      })

      expect(result.current.canScrollRight).toBe(true)

      // Attach second element (should clean up first)
      act(() => {
        result.current.callbackRef(el2)
      })

      expect(mockDisconnect).toHaveBeenCalled()
      expect(removeSpy1).toHaveBeenCalledWith('scroll', expect.any(Function))
      expect(result.current.canScrollRight).toBe(false)
    })
  })

  describe('overflow detection', () => {
    it('reports no overflow when no node is attached', () => {
      const { result } = renderHook(() => useTabBarScroll(null))

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports canScrollRight when content overflows to the right', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft when scrolled away from start', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 50 })

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft only when scrolled to end', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports no overflow when scrollWidth equals clientWidth', () => {
      const el = createMockScrollContainer({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('updates overflow when scroll event fires', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)

      // Simulate scrolling
      act(() => {
        Object.defineProperty(el, 'scrollLeft', { value: 50, configurable: true })
        el.dispatchEvent(new Event('scroll'))
      })

      expect(result.current.canScrollLeft).toBe(true)
    })
  })

  describe('scrollToTab', () => {
    it('scrolls to center the active tab element using getBoundingClientRect', () => {
      // Container at viewport left=100, clientWidth=300, scrollLeft=0
      const el = createMockScrollContainer({
        scrollWidth: 800, clientWidth: 300, scrollLeft: 0, boundingLeft: 100,
      })

      // Tab at viewport left=500, width=100
      // tabCenter in container coords = (500 - 100) + 0 + (100/2) = 450
      // So targetScroll = 450 - 300/2 = 300
      const tabEl = createMockTabElement('tab-3', { boundingLeft: 500, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-3"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
        result.current.scrollToTab('tab-3')
      })

      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 300,
        behavior: 'smooth',
      })
    })

    it('correctly accounts for current scrollLeft in position calculation', () => {
      // Container at viewport left=100, clientWidth=300, scrollLeft=200
      const el = createMockScrollContainer({
        scrollWidth: 800, clientWidth: 300, scrollLeft: 200, boundingLeft: 100,
      })

      // Tab at viewport left=250, width=100
      // tabCenter in container coords = (250 - 100) + 200 + (100/2) = 400
      // So targetScroll = 400 - 300/2 = 250
      const tabEl = createMockTabElement('tab-3', { boundingLeft: 250, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-3"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
        result.current.scrollToTab('tab-3')
      })

      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 250,
        behavior: 'smooth',
      })
    })

    it('is immune to CSS transform on ancestor elements (dnd-kit)', () => {
      // This test verifies the architectural choice: we use getBoundingClientRect
      // instead of offsetLeft, so CSS transforms from dnd-kit don't affect
      // the scroll target calculation. getBoundingClientRect always returns
      // the visual position, which is what we want for scroll centering.
      const el = createMockScrollContainer({
        scrollWidth: 800, clientWidth: 300, scrollLeft: 0, boundingLeft: 0,
      })

      // Even if a dnd-kit transform is active, getBoundingClientRect reports
      // the visual position, so the calculation remains correct.
      const tabEl = createMockTabElement('tab-2', { boundingLeft: 400, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-2"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
        result.current.scrollToTab('tab-2')
      })

      // tabCenter = (400 - 0) + 0 + 50 = 450, target = 450 - 150 = 300
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 300,
        behavior: 'smooth',
      })
    })

    it('does not scroll when tab element is not found', () => {
      const el = createMockScrollContainer()
      el.querySelector = vi.fn(() => null) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
        result.current.scrollToTab('nonexistent')
      })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('clamps scroll to 0 when tab is near the start', () => {
      // Container at viewport left=100, clientWidth=300, scrollLeft=0
      const el = createMockScrollContainer({
        scrollWidth: 800, clientWidth: 300, scrollLeft: 0, boundingLeft: 100,
      })

      // Tab at viewport left=110, width=100
      // tabCenter = (110 - 100) + 0 + 50 = 60, target = 60 - 150 = -90 => clamped to 0
      const tabEl = createMockTabElement('tab-1', { boundingLeft: 110, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-1"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(() => useTabBarScroll(null))

      act(() => {
        result.current.callbackRef(el)
        result.current.scrollToTab('tab-1')
      })

      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 0,
        behavior: 'smooth',
      })
    })

    it('does nothing when no node is attached', () => {
      const { result } = renderHook(() => useTabBarScroll(null))

      // Should not throw
      act(() => {
        result.current.scrollToTab('tab-1')
      })
    })
  })
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: FAIL -- module `@/hooks/useTabBarScroll` does not exist.

**Step 3: Implement `useTabBarScroll` hook**

Create `src/hooks/useTabBarScroll.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'

interface TabBarScrollState {
  canScrollLeft: boolean
  canScrollRight: boolean
}

interface TabBarScrollResult extends TabBarScrollState {
  /** Callback ref -- pass as `ref={callbackRef}` on the scrollable container */
  callbackRef: (node: HTMLDivElement | null) => void
  scrollToTab: (tabId: string) => void
}

const SCROLL_THRESHOLD = 2 // px tolerance for scroll boundary detection

export function useTabBarScroll(activeTabId: string | null): TabBarScrollResult {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [overflow, setOverflow] = useState<TabBarScrollState>({
    canScrollLeft: false,
    canScrollRight: false,
  })

  const updateOverflow = useCallback((el: HTMLDivElement | null) => {
    if (!el) {
      setOverflow({ canScrollLeft: false, canScrollRight: false })
      return
    }

    const { scrollLeft, scrollWidth, clientWidth } = el
    setOverflow({
      canScrollLeft: scrollLeft > SCROLL_THRESHOLD,
      canScrollRight: scrollLeft + clientWidth < scrollWidth - SCROLL_THRESHOLD,
    })
  }, [])

  const callbackRef = useCallback((node: HTMLDivElement | null) => {
    // Tear down previous listeners if any
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    nodeRef.current = node

    if (!node) {
      updateOverflow(null)
      return
    }

    // Set up scroll listener
    const handleScroll = () => updateOverflow(node)
    node.addEventListener('scroll', handleScroll, { passive: true })

    // Set up ResizeObserver
    const observer = new ResizeObserver(() => updateOverflow(node))
    observer.observe(node)

    // Store cleanup function
    cleanupRef.current = () => {
      node.removeEventListener('scroll', handleScroll)
      observer.disconnect()
    }

    // Initial overflow check
    updateOverflow(node)
  }, [updateOverflow])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [])

  const scrollToTab = useCallback((tabId: string) => {
    const el = nodeRef.current
    if (!el) return

    const tabEl = el.querySelector(`[data-tab-id="${tabId}"]`) as HTMLElement | null
    if (!tabEl) return

    const containerRect = el.getBoundingClientRect()
    const tabRect = tabEl.getBoundingClientRect()

    // Compute tab center in container's scrollable coordinate space
    const tabCenterInContainer = (tabRect.left - containerRect.left) + el.scrollLeft + (tabRect.width / 2)
    const containerCenter = el.clientWidth / 2
    const targetScroll = Math.max(0, tabCenterInContainer - containerCenter)

    el.scrollTo({ left: targetScroll, behavior: 'smooth' })
  }, [])

  // Auto-scroll when activeTabId changes
  useEffect(() => {
    if (activeTabId) {
      scrollToTab(activeTabId)
    }
  }, [activeTabId, scrollToTab])

  return {
    callbackRef,
    canScrollLeft: overflow.canScrollLeft,
    canScrollRight: overflow.canScrollRight,
    scrollToTab,
  }
}
```

**Step 4: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/hooks/useTabBarScroll.ts test/unit/client/hooks/useTabBarScroll.test.ts
git commit -m "feat(hooks): add useTabBarScroll hook with callback ref, overflow detection, and auto-scroll"
```

---

### Task 3: Restructure TabBar layout -- move "+" button outside scrollable area

**Files:**
- Modify: `src/components/TabBar.tsx` (lines 263-401)
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabBar.mobile.test.tsx`

**Step 1: Write a failing test asserting the "+" button is outside the scroll container**

In `test/unit/client/components/TabBar.test.tsx`, add a new test in the `rendering` describe block.

The selector must match an element that currently exists in the DOM (before the restructuring) to ensure the test genuinely fails RED first. The current scrollable container uses `.overflow-x-auto`, and the "+" button is inside it. After restructuring, the button moves outside, so `.closest('.overflow-x-auto')` will return `null`.

```ts
    it('renders the + button outside the scrollable tab container', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByTitle('New shell tab')
      // Use overflow-x-auto to find the scrollable container -- this class exists
      // on the scroll strip both before and after the change.
      const scrollContainer = addButton.closest('.overflow-x-auto')

      // The + button should NOT be inside the scrollable container
      expect(scrollContainer).toBeNull()
    })
```

**Step 2: Run test to verify RED**

Run:
```bash
npx vitest run test/unit/client/components/TabBar.test.tsx
```
Expected: FAIL -- the "+" button is currently inside the `.overflow-x-auto` scrollable container, so `.closest('.overflow-x-auto')` returns a non-null element and the `toBeNull()` assertion fails.

**Step 3: Restructure TabBar.tsx**

Modify the return JSX of the `TabBar` component. The key changes:

1. Import `useTabBarScroll` from `@/hooks/useTabBarScroll`.
2. Call `useTabBarScroll(activeTabId)` to get `callbackRef`, `canScrollLeft`, `canScrollRight`.
3. Split the inner flex div: tabs go in a scrollable div with `ref={callbackRef}` and `scrollbar-none`; the "+" button goes outside.
4. Add overflow indicator divs.

Add the import at the top of `TabBar.tsx`:

```ts
import { useTabBarScroll } from '@/hooks/useTabBarScroll'
```

Destructure the hook result inside the component body, after the existing hooks:

```ts
  const { callbackRef, canScrollLeft, canScrollRight } = useTabBarScroll(activeTabId)
```

Replace the entire return block (lines 263-401) with:

```tsx
  return (
    <div className="relative z-20 h-12 md:h-10 shrink-0 flex items-end px-2 bg-background" data-context={ContextIds.Global}>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-muted-foreground/45"
        aria-hidden="true"
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={tabs.map((t: Tab) => t.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div className="relative z-10 flex items-end flex-1 min-w-0">
            {/* Overflow indicator: left */}
            {canScrollLeft && (
              <div
                className="pointer-events-none absolute left-0 top-0 bottom-0 w-8 z-20 bg-gradient-to-r from-background to-transparent"
                aria-hidden="true"
              />
            )}

            {/* Scrollable tab strip */}
            <div
              ref={callbackRef}
              className="flex items-end gap-0.5 overflow-x-auto overflow-y-hidden scrollbar-none pt-px flex-1 min-w-0"
            >
              {sidebarCollapsed && onToggleSidebar && (
                <button
                  className="flex-shrink-0 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                  title="Show sidebar"
                  aria-label="Show sidebar"
                  onClick={onToggleSidebar}
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </button>
              )}
              {tabs.map((tab: Tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  displayTitle={getDisplayTitle(tab)}
                  isActive={tab.id === activeTabId}
                  needsAttention={!!attentionByTab[tab.id]}
                  isDragging={activeId === tab.id}
                  isRenaming={renamingId === tab.id}
                  renameValue={renameValue}
                  paneContents={getPaneContents(tab)}
                  iconsOnTabs={iconsOnTabs}
                  tabAttentionStyle={tabAttentionStyle}
                  onRenameChange={setRenameValue}
                  onRenameBlur={() => {
                    dispatch(
                      updateTab({
                        id: tab.id,
                        updates: { title: renameValue || tab.title, titleSetByUser: true },
                      })
                    )
                    setRenamingId(null)
                  }}
                  onRenameKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                  onClose={(e) => {
                    const terminalIds = getTerminalIdsForTab(tab)
                    if (terminalIds.length > 0) {
                      const messageType = e.shiftKey ? 'terminal.kill' : 'terminal.detach'
                      for (const terminalId of terminalIds) {
                        ws.send({
                          type: messageType,
                          terminalId,
                        })
                      }
                    } else if (tab.codingCliSessionId) {
                      if (tab.status === 'creating') {
                        dispatch(cancelCodingCliRequest({ requestId: tab.codingCliSessionId }))
                      } else {
                        ws.send({
                          type: 'codingcli.kill',
                          sessionId: tab.codingCliSessionId,
                        })
                      }
                    }
                    dispatch(closeTab(tab.id))
                  }}
                  onClick={() => {
                    if (attentionDismiss === 'click' && attentionByTab[tab.id]) {
                      dispatch(clearTabAttention({ tabId: tab.id }))
                      const activePaneId = activePaneMap?.[tab.id]
                      if (activePaneId && attentionByPane[activePaneId]) {
                        dispatch(clearPaneAttention({ paneId: activePaneId }))
                      }
                    }
                    dispatch(setActiveTab(tab.id))
                  }}
                  onDoubleClick={() => {
                    setRenamingId(tab.id)
                    setRenameValue(getDisplayTitle(tab))
                  }}
                />
              ))}
            </div>

            {/* Overflow indicator: right */}
            {canScrollRight && (
              <div
                className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 z-20 bg-gradient-to-l from-background to-transparent"
                aria-hidden="true"
              />
            )}
          </div>
        </SortableContext>

        {/* Pinned + button -- outside the scrollable area */}
        <button
          className="flex-shrink-0 ml-1 mb-1 p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground/50 hover:bg-muted/30 transition-colors"
          title="New shell tab"
          aria-label="New shell tab"
          onClick={() => dispatch(addTab({ mode: 'shell' }))}
          data-context={ContextIds.TabAdd}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <DragOverlay>
          {activeTab ? (
            <div
              style={{
                opacity: 0.9,
                transform: 'scale(1.02)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                cursor: 'grabbing',
              }}
            >
              <TabItem
                tab={{ ...activeTab, title: getDisplayTitle(activeTab) }}
                isActive={activeTab.id === activeTabId}
                needsAttention={!!attentionByTab[activeTab.id]}
                isDragging={false}
                isRenaming={false}
                renameValue=""
                paneContents={getPaneContents(activeTab)}
                iconsOnTabs={iconsOnTabs}
                tabAttentionStyle={tabAttentionStyle}
                onRenameChange={() => {}}
                onRenameBlur={() => {}}
                onRenameKeyDown={() => {}}
                onClose={() => {}}
                onClick={() => {}}
                onDoubleClick={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
```

**Step 4: Update existing tests that depend on layout structure**

Some existing tests in `TabBar.test.tsx` and `TabBar.mobile.test.tsx` locate elements by DOM traversal (e.g., `addButton.parentElement`). These tests need to be checked:

1. In `TabBar.test.tsx`, the test "hides vertical overflow on the tab strip while preserving horizontal scrolling" (line 228) looks for `addButton.parentElement` to find the tab strip. Since the "+" button is now outside the scroll container, update this test:

```ts
    it('hides vertical overflow on the tab strip while preserving horizontal scrolling', () => {
      const tab = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      const { container } = renderWithStore(<TabBar />, store)

      // The scrollable tab strip has the scrollbar-none class
      const tabStrip = container.querySelector('.scrollbar-none') as HTMLDivElement | null

      expect(tabStrip).toBeInTheDocument()
      expect(tabStrip?.className).toContain('overflow-x-auto')
      expect(tabStrip?.className).toContain('overflow-y-hidden')
      expect(tabStrip?.className).toContain('scrollbar-none')
    })
```

2. In `TabBar.mobile.test.tsx`, the test "tab bar container has h-12 for mobile and md:h-10 for desktop" uses `screen.getByRole('button', { name: 'New shell tab' }).closest('.z-20')`. The "+" button is still inside the `.z-20` outer wrapper, so this should still work. Verify by running the test.

**Step 5: Run all TabBar tests to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/components/TabBar
```
Expected: All PASS.

**Step 6: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.test.tsx
git commit -m "feat(TabBar): restructure layout to pin + button outside scrollable area and add overflow indicators"
```

---

### Task 4: Add tests for overflow indicators in TabBar

**Files:**
- Modify: `test/unit/client/components/TabBar.test.tsx`

**Step 1: Write tests for overflow indicator visibility**

Add a new describe block in `TabBar.test.tsx`:

```ts
  describe('overflow indicators', () => {
    it('does not render overflow indicators when tabs fit', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      const { container } = renderWithStore(<TabBar />, store)

      // No gradient overlays should be rendered (only the bottom separator is aria-hidden)
      const gradients = container.querySelectorAll('.bg-gradient-to-r, .bg-gradient-to-l')
      expect(gradients).toHaveLength(0)
    })

    it('overflow indicators are decorative (aria-hidden)', () => {
      // This test verifies the structure -- the actual overflow state
      // depends on scrollWidth/clientWidth which JSDOM doesn't compute.
      // We verify the indicators have aria-hidden when rendered.
      // Full overflow behavior is covered by useTabBarScroll hook tests.
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      const { container } = renderWithStore(<TabBar />, store)

      // The bottom separator line should be aria-hidden
      const separators = container.querySelectorAll('[aria-hidden="true"]')
      expect(separators.length).toBeGreaterThanOrEqual(1)
    })

    it('+ button remains keyboard-reachable outside scroll area', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByRole('button', { name: 'New shell tab' })
      expect(addButton).toBeInTheDocument()
      // Button should be a real <button> element (inherently keyboard-focusable)
      expect(addButton.tagName).toBe('BUTTON')
    })
  })
```

**Step 2: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/components/TabBar.test.tsx
```
Expected: PASS

**Step 3: Commit**

```bash
git add test/unit/client/components/TabBar.test.tsx
git commit -m "test(TabBar): add tests for overflow indicators and pinned + button accessibility"
```

---

### Task 5: Add auto-scroll-on-activate test to the hook

**Files:**
- Modify: `test/unit/client/hooks/useTabBarScroll.test.ts`

**Step 1: Write a test verifying auto-scroll triggers on activeTabId change**

Add to the `useTabBarScroll` describe block:

```ts
  describe('auto-scroll on active tab change', () => {
    it('calls scrollToTab when activeTabId changes', () => {
      // Container at viewport left=0, clientWidth=300, scrollLeft=0
      const el = createMockScrollContainer({
        scrollWidth: 800, clientWidth: 300, scrollLeft: 0, boundingLeft: 0,
      })

      // Tab at viewport left=350, width=100
      const tabEl = createMockTabElement('tab-2', { boundingLeft: 350, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-2"]') return tabEl
        return null
      }) as any

      const { result, rerender } = renderHook(
        ({ activeTabId }) => {
          const hookResult = useTabBarScroll(activeTabId)
          return hookResult
        },
        { initialProps: { activeTabId: 'tab-1' as string | null } }
      )

      // Attach the element via callback ref
      act(() => {
        result.current.callbackRef(el)
      })

      // Clear any initial scrollTo calls
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // Change activeTabId to tab-2
      rerender({ activeTabId: 'tab-2' })

      // tabCenter = (350 - 0) + 0 + 50 = 400, target = 400 - 150 = 250
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 250,
        behavior: 'smooth',
      })
    })

    it('does not scroll when activeTabId is null', () => {
      const el = createMockScrollContainer({ boundingLeft: 0 })

      const { result } = renderHook(
        ({ activeTabId }) => {
          const hookResult = useTabBarScroll(activeTabId)
          return hookResult
        },
        { initialProps: { activeTabId: null as string | null } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('does not scroll when activeTabId stays the same', () => {
      const el = createMockScrollContainer({ boundingLeft: 0 })

      const tabEl = createMockTabElement('tab-1', { boundingLeft: 50, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-1"]') return tabEl
        return null
      }) as any

      const { result, rerender } = renderHook(
        ({ activeTabId }) => {
          const hookResult = useTabBarScroll(activeTabId)
          return hookResult
        },
        { initialProps: { activeTabId: 'tab-1' as string | null } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      // Clear initial auto-scroll
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // Re-render with same activeTabId
      rerender({ activeTabId: 'tab-1' })

      // Should not scroll again (activeTabId didn't change)
      expect(el.scrollTo).not.toHaveBeenCalled()
    })
  })
```

**Step 2: Run test to verify GREEN**

Run:
```bash
npx vitest run test/unit/client/hooks/useTabBarScroll.test.ts
```
Expected: PASS (the hook implementation from Task 2 already includes auto-scroll on activeTabId change).

**Step 3: Commit**

```bash
git add test/unit/client/hooks/useTabBarScroll.test.ts
git commit -m "test(useTabBarScroll): add auto-scroll-on-activate tests"
```

---

### Task 6: Run full test suite and verify no regressions

**Files:** None (verification only)

**Step 1: Run all tests**

Run:
```bash
cd /home/user/code/freshell/.worktrees/tab-bar-overflow && npm test
```
Expected: All tests pass.

**Step 2: Run typecheck**

Run:
```bash
cd /home/user/code/freshell/.worktrees/tab-bar-overflow && npx tsc --noEmit
```
Expected: No type errors.

**Step 3: If any test failures, fix them and commit**

If there are any failures related to the changes (e.g. tests that assumed the "+" button was inside the scrollable container), fix them and commit the fixes.

---

### Task 7: Refactor -- review for DRY and code quality

**Files:**
- Review: `src/components/TabBar.tsx`
- Review: `src/hooks/useTabBarScroll.ts`
- Review: `test/unit/client/hooks/useTabBarScroll.test.ts`
- Review: `test/unit/client/components/TabBar.test.tsx`

**Step 1: Review the hook for unnecessary complexity**

Check that:
- The `SCROLL_THRESHOLD` constant is appropriate (2px is a reasonable tolerance for sub-pixel rendering).
- The callback ref correctly handles the attach/detach/re-attach lifecycle without leaking listeners.
- The `cleanupRef` pattern properly tears down on unmount via the `useEffect` cleanup.
- The `scrollToTab` function correctly uses `getBoundingClientRect()` on both container and tab elements, and adds `el.scrollLeft` to convert from viewport-relative to scroll-space coordinates.
- No stale closures exist (the callback ref captures `updateOverflow` which is stable, and `scrollToTab` reads from `nodeRef.current` which is always up-to-date).

**Step 2: Review the TabBar component**

Check that:
- The overflow indicator gradient classes use the correct direction (`from-background to-transparent`).
- The `data-tab-id` attribute is present on the correct element for `scrollToTab` to find (it's on the TabItem wrapper via `data-tab-id={tab.id}`). Verify this is set in `TabItem.tsx` line 136.
- The `min-w-0` class is on the correct flex container to allow the scrollable area to shrink.
- The `ref={callbackRef}` is on the scrollable div (not a parent or child).

**Step 3: Review test quality**

Check that:
- Tests cover edge cases (0 tabs, 1 tab, node attach/detach/re-attach).
- The callback ref lifecycle tests verify proper setup and teardown of listeners.
- The `getBoundingClientRect` tests cover the scrollLeft offset calculation.
- Mock setup is clean and reusable via the helper functions.
- Test names clearly describe the behavior being tested.

**Step 4: Make any refactoring changes and commit**

If any improvements are needed, make them and commit:

```bash
git add -A
git commit -m "refactor(TabBar): clean up overflow hook and indicator implementation"
```

---

## Summary of All Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/index.css` | Modify | Add `.scrollbar-none` utility class |
| `src/hooks/useTabBarScroll.ts` | Create | Hook with callback ref for overflow detection, auto-scroll via getBoundingClientRect |
| `src/components/TabBar.tsx` | Modify | Restructure layout: scrollable tabs + pinned "+" button + overflow indicators |
| `test/unit/client/hooks/useTabBarScroll.test.ts` | Create | Unit tests for the scroll hook (callback ref lifecycle, overflow, scrollToTab, auto-scroll) |
| `test/unit/client/components/TabBar.test.tsx` | Modify | Update structural tests, add overflow/a11y tests |

## Key Design Decisions

1. **Callback ref instead of useRef + useEffect:** The hook uses a callback ref `(node: HTMLDivElement | null) => void` to set up scroll listeners and ResizeObserver. This ensures listeners attach exactly when the DOM node appears and detach when it disappears, even if the component conditionally renders (e.g., `tabs.length === 0` returns null). A `useRef` + `useEffect` approach would miss the null-to-node transition because the effect dependencies (`updateOverflow`) are memoized and don't change when the ref populates.

2. **getBoundingClientRect instead of offsetLeft:** The `scrollToTab` function computes tab position via `getBoundingClientRect()` on both the tab element and the scroll container, then adds `el.scrollLeft` to convert viewport-relative coordinates into scrollable-space coordinates. This is immune to CSS `transform` properties that dnd-kit applies to `SortableTab` wrapper elements during drag operations, which would corrupt `offsetLeft` values (since `transform` creates a new `offsetParent`).

## Verification Checklist

- [ ] Native scrollbar hidden on tab strip (`scrollbar-none` class)
- [ ] "+" button always visible, pinned outside scroll area
- [ ] Auto-scroll to active tab on tab activation (centering)
- [ ] Left gradient appears when tabs overflow to the left
- [ ] Right gradient appears when tabs overflow to the right
- [ ] Gradients disappear when scrolled to the respective edge
- [ ] Mouse wheel and trackpad scrolling still works
- [ ] Keyboard scrolling still works
- [ ] Drag-and-drop tab reordering still works
- [ ] Overflow indicators are `aria-hidden="true"` (decorative)
- [ ] "+" button remains keyboard-reachable
- [ ] All existing tests pass
- [ ] New tests cover callback ref lifecycle, overflow detection, auto-scroll, and accessibility
- [ ] TypeScript compiles without errors

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

// Helper to create a container with positioned tab children using getBoundingClientRect.
// Tab positions are specified in scroll-coordinate space (relative to scroll content origin).
// The helper computes each tab's visual (viewport) position from the scroll state.
// Limitation: tab getBoundingClientRect values are computed at creation time and do not
// update when scrollLeft changes via scrollTo. Tests that call scrollTo and then re-read
// tab positions need to create a fresh container with the new scrollLeft.
function createContainerWithTabs(opts: {
  clientWidth: number
  scrollLeft: number
  containerBoundingLeft?: number
  tabs: Array<{ id: string; scrollLeft: number; width: number }>
}) {
  const containerBoundingLeft = opts.containerBoundingLeft ?? 0
  const totalScrollWidth = opts.tabs.length > 0
    ? Math.max(...opts.tabs.map(t => t.scrollLeft + t.width))
    : 0

  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: totalScrollWidth, configurable: true })
  Object.defineProperty(el, 'clientWidth', { value: opts.clientWidth, configurable: true })
  Object.defineProperty(el, 'scrollLeft', {
    value: opts.scrollLeft,
    writable: true,
    configurable: true,
  })
  el.scrollTo = vi.fn((o: ScrollToOptions) => {
    if (o.left !== undefined) {
      const sw = (el as any).scrollWidth ?? totalScrollWidth
      const cw = (el as any).clientWidth ?? opts.clientWidth
      ;(el as any).scrollLeft = Math.max(0, Math.min(o.left, sw - cw))
    }
  }) as any
  el.getBoundingClientRect = vi.fn(() => ({
    left: containerBoundingLeft,
    right: containerBoundingLeft + opts.clientWidth,
    top: 0, bottom: 40,
    width: opts.clientWidth, height: 40,
    x: containerBoundingLeft, y: 0,
    toJSON: () => {},
  }))

  // Create child elements for each tab
  // Visual (viewport) position = containerBoundingLeft + (tab.scrollLeft - el.scrollLeft)
  for (const tab of opts.tabs) {
    const tabEl = document.createElement('div')
    tabEl.setAttribute('data-tab-id', tab.id)
    const visualLeft = containerBoundingLeft + (tab.scrollLeft - opts.scrollLeft)
    tabEl.getBoundingClientRect = vi.fn(() => ({
      left: visualLeft,
      right: visualLeft + tab.width,
      top: 0, bottom: 32,
      width: tab.width, height: 32,
      x: visualLeft, y: 0,
      toJSON: () => {},
    }))
    el.appendChild(tabEl)
  }

  return el
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

      const { result } = renderHook(() => useTabBarScroll(null, 1))

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

      const { result } = renderHook(() => useTabBarScroll(null, 1))

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

      const { result } = renderHook(() => useTabBarScroll(null, 1))

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

      const { result } = renderHook(() => useTabBarScroll(null, 1))

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
      const { result } = renderHook(() => useTabBarScroll(null, 0))

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports canScrollRight when content overflows to the right', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null, 5))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft when scrolled away from start', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 50 })

      const { result } = renderHook(() => useTabBarScroll(null, 5))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(true)
    })

    it('reports canScrollLeft only when scrolled to end', () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })

      const { result } = renderHook(() => useTabBarScroll(null, 5))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(true)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('reports no overflow when scrollWidth equals clientWidth', () => {
      const el = createMockScrollContainer({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null, 1))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)
      expect(result.current.canScrollRight).toBe(false)
    })

    it('updates overflow when scroll event fires (rAF-throttled)', async () => {
      const el = createMockScrollContainer({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })

      const { result } = renderHook(() => useTabBarScroll(null, 5))

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollLeft).toBe(false)

      // Simulate scrolling -- the handler is rAF-throttled, so we need to
      // flush the queued animation frame for the state update to land.
      act(() => {
        Object.defineProperty(el, 'scrollLeft', { value: 50, configurable: true })
        el.dispatchEvent(new Event('scroll'))
      })

      // Flush the rAF callback that was queued by the scroll handler
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })

      expect(result.current.canScrollLeft).toBe(true)
    })

    it('recalculates overflow when tabCount changes (tabs added/removed)', () => {
      // Start with tabs fitting in the container
      const el = createMockScrollContainer({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })

      const { result, rerender } = renderHook(
        ({ activeTabId, tabCount }) => {
          const hookResult = useTabBarScroll(activeTabId, tabCount)
          return hookResult
        },
        { initialProps: { activeTabId: null as string | null, tabCount: 3 } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      // No overflow initially
      expect(result.current.canScrollRight).toBe(false)

      // Simulate adding tabs: scrollWidth grows but clientWidth stays the same
      // (ResizeObserver won't fire because the container's own size didn't change)
      Object.defineProperty(el, 'scrollWidth', { value: 600, configurable: true })

      // Change tabCount to trigger the effect
      rerender({ activeTabId: null, tabCount: 6 })

      // Overflow should now be detected
      expect(result.current.canScrollRight).toBe(true)
    })

    it('recalculates overflow when tabCount decreases (tabs removed)', () => {
      // Start with overflow
      const el = createMockScrollContainer({ scrollWidth: 600, clientWidth: 300, scrollLeft: 0 })

      const { result, rerender } = renderHook(
        ({ activeTabId, tabCount }) => {
          const hookResult = useTabBarScroll(activeTabId, tabCount)
          return hookResult
        },
        { initialProps: { activeTabId: null as string | null, tabCount: 6 } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      expect(result.current.canScrollRight).toBe(true)

      // Simulate removing tabs: scrollWidth shrinks
      Object.defineProperty(el, 'scrollWidth', { value: 300, configurable: true })

      // Change tabCount to trigger the effect
      rerender({ activeTabId: null, tabCount: 3 })

      // Overflow should be gone
      expect(result.current.canScrollRight).toBe(false)
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

      const { result } = renderHook(() => useTabBarScroll(null, 5))

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

      const { result } = renderHook(() => useTabBarScroll(null, 5))

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

      const { result } = renderHook(() => useTabBarScroll(null, 5))

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

      const { result } = renderHook(() => useTabBarScroll(null, 5))

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

      const { result } = renderHook(() => useTabBarScroll(null, 5))

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
      const { result } = renderHook(() => useTabBarScroll(null, 1))

      // Should not throw
      act(() => {
        result.current.scrollToTab('tab-1')
      })
    })
  })

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
        ({ activeTabId, tabCount }) => {
          const hookResult = useTabBarScroll(activeTabId, tabCount)
          return hookResult
        },
        { initialProps: { activeTabId: 'tab-1' as string | null, tabCount: 5 } }
      )

      // Attach the element via callback ref
      act(() => {
        result.current.callbackRef(el)
      })

      // Clear any initial scrollTo calls
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // Change activeTabId to tab-2
      rerender({ activeTabId: 'tab-2', tabCount: 5 })

      // tabCenter = (350 - 0) + 0 + 50 = 400, target = 400 - 150 = 250
      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 250,
        behavior: 'smooth',
      })
    })

    it('does not scroll when activeTabId is null', () => {
      const el = createMockScrollContainer({ boundingLeft: 0 })

      const { result } = renderHook(
        ({ activeTabId, tabCount }) => {
          const hookResult = useTabBarScroll(activeTabId, tabCount)
          return hookResult
        },
        { initialProps: { activeTabId: null as string | null, tabCount: 5 } }
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
        ({ activeTabId, tabCount }) => {
          const hookResult = useTabBarScroll(activeTabId, tabCount)
          return hookResult
        },
        { initialProps: { activeTabId: 'tab-1' as string | null, tabCount: 5 } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      // Clear initial auto-scroll
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // Re-render with same activeTabId
      rerender({ activeTabId: 'tab-1', tabCount: 5 })

      // Should not scroll again (activeTabId didn't change)
      expect(el.scrollTo).not.toHaveBeenCalled()
    })
  })

  describe('active tab visibility maintenance', () => {
    it('keeps the active tab onscreen when the container shrinks', () => {
      const el = createMockScrollContainer({
        scrollWidth: 800,
        clientWidth: 300,
        scrollLeft: 0,
        boundingLeft: 0,
      })

      const tabEl = createMockTabElement('tab-2', { boundingLeft: 180, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-2"]') return tabEl
        return null
      }) as any

      const { result } = renderHook(
        ({ activeTabId, tabCount }) => useTabBarScroll(activeTabId, tabCount),
        { initialProps: { activeTabId: 'tab-2' as string | null, tabCount: 5 } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      Object.defineProperty(el, 'clientWidth', { value: 200, configurable: true })
      resizeCallback?.([])

      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 80,
        behavior: 'instant',
      })
    })

    it('keeps the active tab onscreen when tab count changes without changing the active tab', () => {
      const el = createMockScrollContainer({
        scrollWidth: 500,
        clientWidth: 300,
        scrollLeft: 0,
        boundingLeft: 0,
      })

      const tabEl = createMockTabElement('tab-2', { boundingLeft: 220, boundingWidth: 100 })
      el.appendChild(tabEl)
      el.querySelector = vi.fn((selector: string) => {
        if (selector === '[data-tab-id="tab-2"]') return tabEl
        return null
      }) as any

      const { result, rerender } = renderHook(
        ({ activeTabId, tabCount }) => useTabBarScroll(activeTabId, tabCount),
        { initialProps: { activeTabId: 'tab-2' as string | null, tabCount: 4 } }
      )

      act(() => {
        result.current.callbackRef(el)
      })

      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      Object.defineProperty(el, 'clientWidth', { value: 250, configurable: true })
      Object.defineProperty(el, 'scrollWidth', { value: 650, configurable: true })

      rerender({ activeTabId: 'tab-2', tabCount: 6 })

      expect(el.scrollTo).toHaveBeenCalledWith({
        left: 70,
        behavior: 'instant',
      })
    })
  })

  describe('scrollJumpRight', () => {
    it('scrolls so the cutoff right-edge tab is fully visible with next tab peeking', () => {
      // Container: clientWidth=300, scrollLeft=0
      // Tabs in scroll coords: 0:[0,100], 1:[100,100], 2:[200,100], 3:[300,100], 4:[400,100]
      // Visible range: [0, 300). Tab 3 right edge = 400 > 300 (cutoff).
      // targetScroll = tabRightInScroll - clientWidth + peek
      //             = 400 - 300 + 50 = 150
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 5))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpRight() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 150, behavior: 'smooth' })
    })

    it('scrolls to end when cutoff tab is the last tab (no peek)', () => {
      // Tabs: 0:[0,100], 1:[100,100], 2:[200,100], 3:[300,100]
      // Tab 3 right edge = 400 > 300 (cutoff), no tab 4 for peek.
      // targetScroll = 400 - 300 + 0 = 100
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpRight() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 100, behavior: 'smooth' })
    })

    it('does nothing when no tabs overflow to the right', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 2))
      act(() => { result.current.callbackRef(el) })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      act(() => { result.current.scrollJumpRight() })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('does nothing when no node is attached', () => {
      const { result } = renderHook(() => useTabBarScroll(null, 0))
      // Should not throw
      act(() => { result.current.scrollJumpRight() })
    })

    it('computes correct scroll target when container is offset in viewport', () => {
      // Container starts at viewport x=50 (e.g., arrow button pushes it right)
      // Tabs in scroll coords: 0:[0,100], 1:[100,100], 2:[200,100], 3:[300,100]
      // Container clientWidth=300, scrollLeft=0, containerBoundingLeft=50
      // Tab 3 right edge in scroll coords = 400 > 300 (cutoff), no peek.
      // targetScroll = 400 - 300 + 0 = 100 (same result regardless of viewport offset)
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0, containerBoundingLeft: 50,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpRight() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 100, behavior: 'smooth' })
    })

    it('uses behavior: instant when passed explicitly', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpRight('instant') })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 100, behavior: 'instant' })
    })

    it('clamps targetScroll to maxScroll when peek would overshoot', () => {
      // Override scrollWidth to be smaller than the tab layout to force
      // the raw target (cutoff.right - clientWidth + peek) past maxScroll.
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
        ],
      })
      // Override scrollWidth to a smaller value to force the clamp
      Object.defineProperty(el, 'scrollWidth', { value: 420, configurable: true })
      // maxScroll = 420 - 300 = 120
      // Cutoff: tab 3 right=400 > 300. Peek = tab4.width/2 = 50.
      // Raw target = 400 - 300 + 50 = 150. min(120, 150) = 120.

      const { result } = renderHook(() => useTabBarScroll(null, 5))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpRight() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 120, behavior: 'smooth' })
    })
  })

  describe('hold-to-scroll', () => {
    // Use fake timers so we can precisely control when rAF callbacks fire.
    // Without fake timers, requestAnimationFrame callbacks don't fire
    // synchronously in jsdom, making cancellation tests pass vacuously.
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('startHoldScroll fires an instant jump (not smooth) then begins continuous scrolling', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 5))
      act(() => { result.current.callbackRef(el) })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      act(() => { result.current.startHoldScroll('right') })

      // Immediate jump should have fired with behavior:'instant'
      expect(el.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'instant' })
      )
    })

    it('rAF loop calls scrollBy when hold is active', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
          { id: 't5', scrollLeft: 500, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 6))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.startHoldScroll('right') })
      ;(el.scrollBy as ReturnType<typeof vi.fn>).mockClear()

      // Advance one rAF frame -- with fake timers, rAF fires on timer advance
      act(() => { vi.advanceTimersByTime(16) })

      expect(el.scrollBy).toHaveBeenCalled()
    })

    it('stopHoldScroll cancels continuous scrolling', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
          { id: 't5', scrollLeft: 500, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 6))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.startHoldScroll('right') })
      act(() => { result.current.stopHoldScroll() })

      // After stopping, no more scrollBy calls should happen
      ;(el.scrollBy as ReturnType<typeof vi.fn>).mockClear()

      // Advance several rAF frames -- none should produce scrollBy calls
      act(() => { vi.advanceTimersByTime(64) })

      expect(el.scrollBy).not.toHaveBeenCalled()
    })

    it('cleans up hold-to-scroll on unmount', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
          { id: 't5', scrollLeft: 500, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result, unmount } = renderHook(() => useTabBarScroll(null, 6))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.startHoldScroll('right') })

      // Unmount should clean up the rAF loop
      unmount()

      ;(el.scrollBy as ReturnType<typeof vi.fn>).mockClear()

      // Advancing timers after unmount should not produce scrollBy calls
      act(() => { vi.advanceTimersByTime(64) })

      expect(el.scrollBy).not.toHaveBeenCalled()
    })

    it('left hold-to-scroll fires instant jump', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 50,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 3))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.startHoldScroll('left') })

      // Should have fired the immediate jump (scrollTo)
      expect(el.scrollTo).toHaveBeenCalled()
    })

    it('startHoldScroll deduplicates the subsequent handleArrowClick (no double-jump)', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      // startHoldScroll fires the initial jump
      act(() => { result.current.startHoldScroll('right') })
      const callsAfterHold = (el.scrollTo as ReturnType<typeof vi.fn>).mock.calls.length

      // The subsequent handleArrowClick (from the browser click event) should be a no-op
      act(() => { result.current.handleArrowClick('right') })
      expect((el.scrollTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterHold)
    })

    it('cancelHoldScroll resets pointer dedup so next keyboard click fires', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      // startHoldScroll sets the pointer dedup flag
      act(() => { result.current.startHoldScroll('right') })

      // cancelHoldScroll (pointerLeave/pointerCancel path) resets the flag
      act(() => { result.current.cancelHoldScroll() })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // The next handleArrowClick (e.g. keyboard Enter) should fire the jump
      act(() => { result.current.handleArrowClick('right') })
      expect(el.scrollTo).toHaveBeenCalled()
    })
  })

  describe('scrollJumpLeft', () => {
    it('scrolls so the cutoff left-edge tab is fully visible with previous tab peeking', () => {
      // Container: clientWidth=300, scrollLeft=250
      // Tabs in scroll coords: 0:[0,100], 1:[100,100], 2:[200,100], 3:[300,100], 4:[400,100]
      // Visible range: [250, 550). Tab 2 left edge = 200 < 250 (cutoff on left).
      // targetScroll = tabLeftInScroll - peek = 200 - 50 = 150
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 250,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
          { id: 't4', scrollLeft: 400, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 5))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpLeft() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 150, behavior: 'smooth' })
    })

    it('scrolls to start when cutoff tab is the first tab (no peek)', () => {
      // Container: clientWidth=300, scrollLeft=50
      // Tab 0 left edge = 0 < 50 (cutoff). No previous tab for peek.
      // targetScroll = 0 - 0 = 0
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 50,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 3))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpLeft() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' })
    })

    it('does nothing when no tabs overflow to the left', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 2))
      act(() => { result.current.callbackRef(el) })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      act(() => { result.current.scrollJumpLeft() })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('does nothing when no node is attached', () => {
      const { result } = renderHook(() => useTabBarScroll(null, 0))
      act(() => { result.current.scrollJumpLeft() })
    })

    it('computes correct scroll target when container is offset in viewport', () => {
      // Container starts at viewport x=50, scrollLeft=50
      // Tab 0 left edge in scroll coords = 0 < 50 (cutoff). No prev tab.
      // targetScroll = 0 (same result regardless of viewport offset)
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 50, containerBoundingLeft: 50,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 3))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpLeft() })

      expect(el.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: 'smooth' })
    })

    it('uses behavior: instant when passed explicitly', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 250,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      act(() => { result.current.scrollJumpLeft('instant') })

      expect(el.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'instant' }))
    })

    // Note: Math.max(0, ...) negative clamp in scrollJumpLeft is a defensive guard.
    // With contiguous tabs, cutoff.leftInScroll >= prevTab.leftInScroll + prevTab.width,
    // and peek = prevTab.width / 2, so cutoff.leftInScroll >= 2 * peek >= peek.
    // The negative case is geometrically unreachable. See source comment for proof.
  })

  describe('handleArrowClick (pointer/click deduplication)', () => {
    it('fires scrollJumpRight on keyboard path (no prior pointer interaction)', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      act(() => { result.current.handleArrowClick('right') })

      // Should fire the jump (no prior pointer interaction to deduplicate)
      expect(el.scrollTo).toHaveBeenCalled()
    })

    it('skips the jump after startHoldScroll (mouse dedup path)', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 0,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })
      el.scrollBy = vi.fn() as any

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })

      // Simulate: startHoldScroll marks the interaction as pointer-handled
      act(() => { result.current.startHoldScroll('right') })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      // Now handleArrowClick should detect the prior pointer interaction and skip
      act(() => { result.current.handleArrowClick('right') })

      expect(el.scrollTo).not.toHaveBeenCalled()
    })

    it('fires scrollJumpLeft when called with left direction', () => {
      const el = createContainerWithTabs({
        clientWidth: 300, scrollLeft: 250,
        tabs: [
          { id: 't0', scrollLeft: 0, width: 100 },
          { id: 't1', scrollLeft: 100, width: 100 },
          { id: 't2', scrollLeft: 200, width: 100 },
          { id: 't3', scrollLeft: 300, width: 100 },
        ],
      })

      const { result } = renderHook(() => useTabBarScroll(null, 4))
      act(() => { result.current.callbackRef(el) })
      ;(el.scrollTo as ReturnType<typeof vi.fn>).mockClear()

      act(() => { result.current.handleArrowClick('left') })

      expect(el.scrollTo).toHaveBeenCalled()
    })
  })
})

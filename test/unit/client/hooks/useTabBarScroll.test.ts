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
})

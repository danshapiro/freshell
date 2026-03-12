import { useCallback, useEffect, useRef, useState } from 'react'

interface TabBarScrollState {
  canScrollLeft: boolean
  canScrollRight: boolean
}

interface TabBarScrollResult extends TabBarScrollState {
  /** Callback ref -- pass as `ref={callbackRef}` on the scrollable container */
  callbackRef: (node: HTMLDivElement | null) => void
  scrollToTab: (tabId: string) => void
  scrollJumpLeft: (behavior?: ScrollBehavior) => void
  scrollJumpRight: (behavior?: ScrollBehavior) => void
  /** Click handler for arrow buttons -- deduplicates pointer+click sequences */
  handleArrowClick: (direction: 'left' | 'right') => void
  startHoldScroll: (direction: 'left' | 'right') => void
  stopHoldScroll: () => void
  /** Stop hold scroll AND reset pointer dedup flag -- for pointerLeave/pointerCancel */
  cancelHoldScroll: () => void
}

const SCROLL_THRESHOLD = 2 // px tolerance for scroll boundary detection
const HOLD_SCROLL_SPEED = 4 // px per frame (~240px/s at 60fps)

export function useTabBarScroll(activeTabId: string | null, tabCount: number): TabBarScrollResult {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const holdRafRef = useRef<number | null>(null)
  const pointerHandledRef = useRef(false)
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

    // Set up rAF-throttled scroll listener so we update at most once per frame
    let rafId: number | null = null
    const handleScroll = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        updateOverflow(node)
      })
    }
    node.addEventListener('scroll', handleScroll, { passive: true })

    // Set up ResizeObserver
    const observer = new ResizeObserver(() => updateOverflow(node))
    observer.observe(node)

    // Store cleanup function
    cleanupRef.current = () => {
      node.removeEventListener('scroll', handleScroll)
      if (rafId !== null) cancelAnimationFrame(rafId)
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
      // Clean up hold-to-scroll on unmount
      if (holdRafRef.current !== null) {
        cancelAnimationFrame(holdRafRef.current)
        holdRafRef.current = null
      }
    }
  }, [])

  // Recalculate overflow when tab count changes.
  // ResizeObserver only fires when the container's own dimensions change,
  // but adding/removing tabs changes scrollWidth without affecting clientWidth
  // (the container is flex-1 min-w-0, sized by its parent). No scroll event
  // fires either. So we need an explicit trigger keyed on tabCount.
  useEffect(() => {
    updateOverflow(nodeRef.current)
  }, [tabCount, updateOverflow])

  const scrollToTab = useCallback((tabId: string) => {
    const el = nodeRef.current
    if (!el) return

    const tabEl = el.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`) as HTMLElement | null
    if (!tabEl) return

    const containerRect = el.getBoundingClientRect()
    const tabRect = tabEl.getBoundingClientRect()

    // Compute tab center in container's scrollable coordinate space
    const tabCenterInContainer = (tabRect.left - containerRect.left) + el.scrollLeft + (tabRect.width / 2)
    const containerCenter = el.clientWidth / 2
    const targetScroll = Math.max(0, tabCenterInContainer - containerCenter)

    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: targetScroll, behavior: 'smooth' })
    } else {
      el.scrollLeft = targetScroll
    }
  }, [])

  const scrollJumpRight = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = nodeRef.current
    if (!el) return

    const containerRect = el.getBoundingClientRect()
    const visibleRight = el.scrollLeft + el.clientWidth
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]'))

    // Find the first tab whose right edge extends past the visible area.
    // Convert each tab's visual position to scroll coordinates via getBoundingClientRect.
    const tabPositions = tabs.map((tab) => {
      const rect = tab.getBoundingClientRect()
      const leftInScroll = (rect.left - containerRect.left) + el.scrollLeft
      return { leftInScroll, rightInScroll: leftInScroll + rect.width, width: rect.width }
    })

    const cutoffIndex = tabPositions.findIndex(
      (pos) => pos.rightInScroll > visibleRight + SCROLL_THRESHOLD
    )
    if (cutoffIndex === -1) return

    const cutoff = tabPositions[cutoffIndex]
    const nextPos = tabPositions[cutoffIndex + 1] ?? null
    const peek = nextPos ? nextPos.width / 2 : 0

    // Scroll so cutoff tab's right edge is at container's right edge, plus peek.
    // Clamp to [0, maxScroll] for correctness -- browsers silently clamp, but
    // the explicit bounds match the stated contract.
    const maxScroll = el.scrollWidth - el.clientWidth
    const targetScroll = Math.min(maxScroll, Math.max(0, cutoff.rightInScroll - el.clientWidth + peek))

    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: targetScroll, behavior })
    } else {
      el.scrollLeft = targetScroll
    }
  }, [])

  const scrollJumpLeft = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = nodeRef.current
    if (!el) return

    const containerRect = el.getBoundingClientRect()
    const visibleLeft = el.scrollLeft
    const tabs = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]'))

    // Convert each tab's visual position to scroll coordinates via getBoundingClientRect.
    const tabPositions = tabs.map((tab) => {
      const rect = tab.getBoundingClientRect()
      const leftInScroll = (rect.left - containerRect.left) + el.scrollLeft
      return { leftInScroll, width: rect.width }
    })

    // Find the last tab whose left edge is before the visible area
    // (iterate backwards to find the rightmost such tab -- the one being cutoff)
    let cutoffIndex = -1
    for (let i = tabPositions.length - 1; i >= 0; i--) {
      if (tabPositions[i].leftInScroll < visibleLeft - SCROLL_THRESHOLD) {
        cutoffIndex = i
        break
      }
    }
    if (cutoffIndex === -1) return

    const cutoff = tabPositions[cutoffIndex]
    const prevPos = tabPositions[cutoffIndex - 1] ?? null
    const peek = prevPos ? prevPos.width / 2 : 0

    // Scroll so cutoff tab's left edge is at container's left edge, minus peek.
    // Only a lower-bound clamp is needed: the target is always <= visibleLeft
    // (which is the current scrollLeft, already <= maxScroll), so no upper clamp.
    // Math.max(0, ...) is a defensive lower-bound guard; with contiguous tabs
    // cutoff.leftInScroll >= 2 * peek, so the negative case is unreachable.
    const targetScroll = Math.max(0, cutoff.leftInScroll - peek)

    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ left: targetScroll, behavior })
    } else {
      el.scrollLeft = targetScroll
    }
  }, [])

  /** Click handler for arrow buttons. Checks pointerHandledRef to deduplicate
   *  pointer+click sequences: if startHoldScroll already fired the jump via
   *  pointerdown, the subsequent click is a no-op. Keyboard Enter/Space only
   *  fires click (no pointerdown), so the jump fires normally. */
  const handleArrowClick = useCallback((direction: 'left' | 'right') => {
    if (pointerHandledRef.current) {
      pointerHandledRef.current = false
      return
    }
    if (direction === 'right') {
      scrollJumpRight()
    } else {
      scrollJumpLeft()
    }
  }, [scrollJumpLeft, scrollJumpRight])

  const stopHoldScroll = useCallback(() => {
    if (holdRafRef.current !== null) {
      cancelAnimationFrame(holdRafRef.current)
      holdRafRef.current = null
    }
  }, [])

  /** Cancel hold scroll AND reset the pointer dedup flag. Used by
   *  pointerLeave and pointerCancel where click won't follow -- unlike
   *  pointerUp, where the browser fires click AFTER pointerup and the
   *  flag must stay true so handleArrowClick can deduplicate. */
  const cancelHoldScroll = useCallback(() => {
    stopHoldScroll()
    pointerHandledRef.current = false
  }, [stopHoldScroll])

  const startHoldScroll = useCallback((direction: 'left' | 'right') => {
    // Mark that pointer handled this interaction -- prevents onClick from double-jumping
    pointerHandledRef.current = true

    // Cancel any existing hold scroll before starting the new one
    // to prevent a one-frame overlap on rapid double-invocation
    stopHoldScroll()

    // Fire instant jump -- must be 'instant' (not 'smooth') because the rAF
    // continuous-scroll loop starts immediately after. A smooth scroll would
    // be aborted by the first scrollBy tick ~16ms later (per CSSOM View Module
    // spec: a new programmatic scroll aborts any in-progress smooth scroll).
    if (direction === 'right') {
      scrollJumpRight('instant')
    } else {
      scrollJumpLeft('instant')
    }

    const el = nodeRef.current
    if (!el) return

    const tick = () => {
      const container = nodeRef.current
      if (!container) return

      // Check boundary -- stop if at the edge
      if (direction === 'right') {
        const maxScroll = container.scrollWidth - container.clientWidth
        if (container.scrollLeft >= maxScroll - SCROLL_THRESHOLD) {
          holdRafRef.current = null
          return
        }
      } else {
        if (container.scrollLeft <= SCROLL_THRESHOLD) {
          holdRafRef.current = null
          return
        }
      }

      if (typeof container.scrollBy === 'function') {
        container.scrollBy({ left: direction === 'right' ? HOLD_SCROLL_SPEED : -HOLD_SCROLL_SPEED, behavior: 'instant' })
      } else {
        container.scrollLeft += direction === 'right' ? HOLD_SCROLL_SPEED : -HOLD_SCROLL_SPEED
      }
      holdRafRef.current = requestAnimationFrame(tick)
    }

    holdRafRef.current = requestAnimationFrame(tick)
  }, [scrollJumpLeft, scrollJumpRight, stopHoldScroll])

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
    scrollJumpLeft,
    scrollJumpRight,
    handleArrowClick,
    startHoldScroll,
    stopHoldScroll,
    cancelHoldScroll,
  }
}

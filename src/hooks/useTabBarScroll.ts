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

export function useTabBarScroll(activeTabId: string | null, tabCount: number): TabBarScrollResult {
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

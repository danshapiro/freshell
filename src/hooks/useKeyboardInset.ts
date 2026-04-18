import { useEffect, useState } from 'react'
import { useMobile } from './useMobile'

/**
 * Minimum viewport shrinkage (in px) before we consider the keyboard "open".
 * Small shrinkage (e.g. address-bar collapse) is ignored.
 */
const KEYBOARD_INSET_ACTIVATION_PX = 80

/**
 * Shared hook that detects the mobile virtual keyboard height using the
 * `visualViewport` API. Returns 0 on desktop or when no keyboard is visible.
 *
 * Extracted from TerminalView for reuse across any component that needs
 * keyboard-aware layout (agent chat, search bars, etc.).
 */
export function useKeyboardInset(): number {
  const isMobile = useMobile()
  const [insetPx, setInsetPx] = useState(0)

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || !window.visualViewport) {
      setInsetPx(0)
      return
    }

    const viewport = window.visualViewport
    let rafId: number | null = null

    const updateInset = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        const rawInset = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop))
        const nextInset = rawInset >= KEYBOARD_INSET_ACTIVATION_PX ? Math.round(rawInset) : 0
        setInsetPx((prev) => (prev === nextInset ? prev : nextInset))
      })
    }

    updateInset()
    viewport.addEventListener('resize', updateInset)
    viewport.addEventListener('scroll', updateInset)

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      viewport.removeEventListener('resize', updateInset)
      viewport.removeEventListener('scroll', updateInset)
    }
  }, [isMobile])

  return insetPx
}

import { useEffect, useState } from 'react'

const COARSE_QUERY = '(pointer: coarse)'

/**
 * True when the primary pointer is coarse (finger). Capability-based, not
 * width-based: an iPad with a trackpad reports fine; a narrow desktop window
 * reports fine; phones report coarse. Guarded for jsdom/SSR (no matchMedia →
 * fine pointer, so existing desktop-oriented tests are unaffected).
 */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(COARSE_QUERY).matches
  } catch {
    return false
  }
}

/** Reactive variant of isCoarsePointer — follows input-device changes
 * (e.g. attaching a mouse to a tablet). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let media: MediaQueryList
    try {
      media = window.matchMedia(COARSE_QUERY)
    } catch {
      return
    }
    const onChange = () => setCoarse(media.matches)
    onChange()
    // Older WebKit shipped addListener only.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [])

  return coarse
}

export const LONG_PRESS_MS = 450
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10

type LongPressHandlers<T extends HTMLElement> = {
  onTouchStart: (event: React.TouchEvent<T>) => void
  onTouchMove: (event: React.TouchEvent<T>) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
}

/**
 * Build long-press touch handlers (no hook state — timer lives in a closure
 * owned by the caller's ref object so one instance can serve many elements).
 * Cancels on scroll/drag: any movement beyond the tolerance aborts the press.
 */
export function buildLongPressHandlers<T extends HTMLElement>(
  callback: (event: { clientX: number; clientY: number }) => void,
): LongPressHandlers<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    onTouchStart: (event) => {
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      cancel()
      timer = setTimeout(() => {
        timer = null
        callback({ clientX: startX, clientY: startY })
      }, LONG_PRESS_MS)
    },
    onTouchMove: (event) => {
      if (timer === null) return
      const touch = event.touches[0]
      if (!touch) return
      const dx = Math.abs(touch.clientX - startX)
      const dy = Math.abs(touch.clientY - startY)
      if (dx > LONG_PRESS_MOVE_TOLERANCE_PX || dy > LONG_PRESS_MOVE_TOLERANCE_PX) cancel()
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  }
}

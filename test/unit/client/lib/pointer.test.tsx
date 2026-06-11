import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  buildLongPressHandlers,
  isCoarsePointer,
  LONG_PRESS_MS,
  useCoarsePointer,
} from '@/lib/pointer'

type MediaListener = (event: { matches: boolean }) => void

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<MediaListener>()
  const media = {
    matches,
    addEventListener: (_: string, listener: MediaListener) => listeners.add(listener),
    removeEventListener: (_: string, listener: MediaListener) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(media))
  return {
    flip(next: boolean) {
      media.matches = next
      listeners.forEach((listener) => listener({ matches: next }))
    },
  }
}

function touchEvent(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent<HTMLElement>
}

describe('isCoarsePointer / useCoarsePointer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('defaults to fine pointer when matchMedia is unavailable (jsdom)', () => {
    expect(isCoarsePointer()).toBe(false)
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(false)
  })

  it('reports coarse pointers and follows device changes', () => {
    const media = mockMatchMedia(true)
    const { result } = renderHook(() => useCoarsePointer())
    expect(result.current).toBe(true)
    act(() => media.flip(false))
    expect(result.current).toBe(false)
  })
})

describe('buildLongPressHandlers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after the long-press window at the start position', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const handlers = buildLongPressHandlers(callback)

    handlers.onTouchStart(touchEvent(40, 60))
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledWith({ clientX: 40, clientY: 60 })
  })

  it('cancels when the finger moves (scrolling) or lifts early', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const handlers = buildLongPressHandlers(callback)

    handlers.onTouchStart(touchEvent(40, 60))
    handlers.onTouchMove(touchEvent(40, 90))
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(callback).not.toHaveBeenCalled()

    handlers.onTouchStart(touchEvent(40, 60))
    handlers.onTouchEnd()
    vi.advanceTimersByTime(LONG_PRESS_MS + 50)
    expect(callback).not.toHaveBeenCalled()
  })

  it('tolerates sub-threshold jitter', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const handlers = buildLongPressHandlers(callback)

    handlers.onTouchStart(touchEvent(40, 60))
    handlers.onTouchMove(touchEvent(44, 64))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

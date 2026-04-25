import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboardInset } from '@/hooks/useKeyboardInset'

// Uses the test-setup `setMobileForTest()` infrastructure (test/setup/dom.ts)
// to control useMobile(), matching the pattern used across all existing tests.

describe('useKeyboardInset', () => {
  let originalVisualViewport: VisualViewport | null
  let originalInnerHeight: number
  let fakeViewport: {
    height: number
    offsetTop: number
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn>
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalVisualViewport = window.visualViewport
    originalInnerHeight = window.innerHeight
    fakeViewport = {
      height: 800,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true, configurable: true })
    Object.defineProperty(window, 'visualViewport', { value: fakeViewport, writable: true, configurable: true })
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    ;(globalThis as any).setMobileForTest(false)
  })

  afterEach(() => {
    ;(globalThis as any).setMobileForTest(false)
    Object.defineProperty(window, 'visualViewport', { value: originalVisualViewport, writable: true, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, writable: true, configurable: true })
    requestAnimationFrameSpy.mockRestore()
    cancelAnimationFrameSpy.mockRestore()
  })

  it('returns 0 on desktop', () => {
    ;(globalThis as any).setMobileForTest(false)
    const { result } = renderHook(() => useKeyboardInset())
    expect(result.current).toBe(0)
  })

  it('returns 0 on mobile when no keyboard is open', () => {
    ;(globalThis as any).setMobileForTest(true)
    const { result } = renderHook(() => useKeyboardInset())
    expect(result.current).toBe(0)
  })

  it('returns keyboard height on mobile when keyboard is open', () => {
    ;(globalThis as any).setMobileForTest(true)
    fakeViewport.height = 400 // keyboard takes 400px
    const { result } = renderHook(() => useKeyboardInset())

    // Simulate visualViewport resize event
    const resizeHandler = fakeViewport.addEventListener.mock.calls
      .find((c: unknown[]) => c[0] === 'resize')?.[1] as (() => void) | undefined
    expect(resizeHandler).toBeDefined()

    act(() => {
      resizeHandler!()
    })
    expect(result.current).toBe(400)
  })

  it('ignores small viewport changes below activation threshold', () => {
    ;(globalThis as any).setMobileForTest(true)
    fakeViewport.height = 750 // only 50px smaller, below 80px threshold
    const { result } = renderHook(() => useKeyboardInset())

    const resizeHandler = fakeViewport.addEventListener.mock.calls
      .find((c: unknown[]) => c[0] === 'resize')?.[1] as (() => void) | undefined

    act(() => {
      resizeHandler?.()
    })
    expect(result.current).toBe(0)
  })

  it('cleans up event listeners on unmount', () => {
    ;(globalThis as any).setMobileForTest(true)
    const { unmount } = renderHook(() => useKeyboardInset())
    unmount()
    expect(fakeViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(fakeViewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import { useOrientation, resetOrientationHookForTests } from '@/hooks/useOrientation'

function OrientationProbe() {
  const { isLandscape } = useOrientation()
  return <div data-testid="orientation-state">{isLandscape ? 'landscape' : 'portrait'}</div>
}

describe('useOrientation', () => {
  const originalMatchMedia = window.matchMedia
  const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

  beforeEach(() => {
    resetOrientationHookForTests()

    let matches = false
    let innerWidth = 390
    let innerHeight = 844
    const listeners = new Set<(e: MediaQueryListEvent) => void>()

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      get: () => innerWidth,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      get: () => innerHeight,
    })

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        get matches() {
          return query === '(orientation: landscape)' ? matches : false
        },
        media: query,
        onchange: null,
        addEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners.add(cb)
        },
        removeEventListener: (_event: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners.delete(cb)
        },
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    ;(globalThis as any).__setLandscapeForTest = (value: boolean) => {
      matches = value
      innerWidth = value ? 844 : 390
      innerHeight = value ? 390 : 844
      const event = { matches: value } as MediaQueryListEvent
      for (const cb of listeners) cb(event)
    }
  })

  afterEach(() => {
    cleanup()
    resetOrientationHookForTests()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    })
    if (originalInnerWidth) {
      Object.defineProperty(window, 'innerWidth', originalInnerWidth)
    }
    if (originalInnerHeight) {
      Object.defineProperty(window, 'innerHeight', originalInnerHeight)
    }
    delete (globalThis as any).__setLandscapeForTest
  })

  it('returns portrait by default', () => {
    render(<OrientationProbe />)
    expect(screen.getByTestId('orientation-state')).toHaveTextContent('portrait')
  })

  it('updates when orientation media query changes', () => {
    render(<OrientationProbe />)

    act(() => {
      ;(globalThis as any).__setLandscapeForTest(true)
    })

    expect(screen.getByTestId('orientation-state')).toHaveTextContent('landscape')

    act(() => {
      ;(globalThis as any).__setLandscapeForTest(false)
    })

    expect(screen.getByTestId('orientation-state')).toHaveTextContent('portrait')
  })

  it('re-evaluates on resize for split-screen style viewport changes', async () => {
    render(<OrientationProbe />)

    act(() => {
      ;(globalThis as any).__setLandscapeForTest(true)
    })
    await waitFor(() => {
      expect(screen.getByTestId('orientation-state')).toHaveTextContent('landscape')
    })

    act(() => {
      Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 640 })
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() => {
      expect(screen.getByTestId('orientation-state')).toHaveTextContent('portrait')
    })
  })
})

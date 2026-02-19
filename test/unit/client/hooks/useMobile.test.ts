import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// We need to mock matchMedia before importing the hook
const listeners: Array<(e: { matches: boolean }) => void> = []
let currentMatches = false

beforeEach(() => {
  vi.resetModules()
  listeners.length = 0
  currentMatches = false
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() { return currentMatches },
    media: query,
    addEventListener: vi.fn((_event: string, cb: (e: { matches: boolean }) => void) => {
      listeners.push(cb)
    }),
    removeEventListener: vi.fn((_event: string, cb: (e: { matches: boolean }) => void) => {
      const idx = listeners.indexOf(cb)
      if (idx >= 0) listeners.splice(idx, 1)
    }),
  })))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMobile', () => {
  it('returns false when viewport is wider than 768px', async () => {
    currentMatches = false
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(false)
  })

  it('returns true when viewport is narrower than 768px', async () => {
    currentMatches = true
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(true)
  })

  it('updates when viewport crosses the breakpoint', async () => {
    currentMatches = false
    const { useMobile } = await import('@/hooks/useMobile')
    const { result } = renderHook(() => useMobile())
    expect(result.current).toBe(false)

    act(() => {
      currentMatches = true
      for (const cb of listeners) cb({ matches: true })
    })
    expect(result.current).toBe(true)
  })
})

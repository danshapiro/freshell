import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkServerBuildId } from '@/lib/server-build-check'

const SENTINEL = 'freshell.server-build-reload'

function mapStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  }
}

describe('checkServerBuildId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reloads once, recording the attempted server build id in the sentinel BEFORE the reload fires', () => {
    const storage = mapStorage()
    const reload = vi.fn(() => {
      // Ordering proof: production must persist the sentinel BEFORE
      // calling reload — an implementation that reloads first and arms
      // second would lose the sentinel across the navigation.
      expect(storage._map.get(SENTINEL), 'sentinel must be armed BEFORE reload fires').toBe('b'.repeat(40))
    })
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('never reloads twice for the same server build id: a recorded sentinel suppresses the reload', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('re-arms for a DIFFERENT mismatched server build id: B attempts once, repeats of B suppress, C reloads again', () => {
    const storage = mapStorage()
    const reload = vi.fn()
    // Mismatch vs B: reload, sentinel records B.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
    // Mismatch vs B again (the half-deployed case): the same identity was
    // already attempted — suppressed, no reload.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
    // A corrected deployment (C): a different server build id re-arms the
    // guard — reloads again, sentinel now records C.
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'c'.repeat(40), reload, storage })
    expect(reload).toHaveBeenCalledTimes(2)
    expect(storage._map.get(SENTINEL)).toBe('c'.repeat(40))
  })

  it('a matching ready clears the recorded sentinel (self-re-arm)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'a'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBeUndefined()
  })

  it('is a no-op when either side is missing, empty, or "unknown"', () => {
    for (const opts of [
      { clientBuildId: 'a'.repeat(40), serverBuildId: undefined },
      { clientBuildId: undefined, serverBuildId: 'b'.repeat(40) },
      { clientBuildId: '', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'unknown', serverBuildId: 'b'.repeat(40) },
      { clientBuildId: 'a'.repeat(40), serverBuildId: 'unknown' },
      { clientBuildId: 'unknown', serverBuildId: 'unknown' },
    ] as const) {
      const storage = mapStorage()
      const reload = vi.fn()
      checkServerBuildId({ ...opts, reload, storage })
      expect(reload, JSON.stringify(opts)).not.toHaveBeenCalled()
      expect(storage._map.get(SENTINEL)).toBeUndefined()
    }
  })

  it('a recorded sentinel survives an "unknown"-vs-"unknown" ready (never treated as a match)', () => {
    const storage = mapStorage()
    storage._map.set(SENTINEL, 'b'.repeat(40))
    const reload = vi.fn()
    checkServerBuildId({ clientBuildId: 'unknown', serverBuildId: 'unknown', reload, storage })
    expect(reload).not.toHaveBeenCalled()
    expect(storage._map.get(SENTINEL)).toBe('b'.repeat(40))
  })

  it('does not reload when the sentinel cannot be persisted (fail-safe against reload loops)', () => {
    const reload = vi.fn()
    const storage = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('quota') },
    }
    checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload, storage })
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not throw or reload when the sessionStorage PROPERTY itself is inaccessible', () => {
    const reload = vi.fn()
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    // Harden contexts throw on PROPERTY ACCESS (SecurityError from a
    // denying getter), not merely on method calls — install a getter that
    // throws so the defaultStorage() fail-safe is actually exercised.
    Object.defineProperty(window, 'sessionStorage', {
      get() { throw new Error('SecurityError: storage denied') },
      configurable: true,
    })
    try {
      expect(() => checkServerBuildId({ clientBuildId: 'a'.repeat(40), serverBuildId: 'b'.repeat(40), reload }))
        .not.toThrow()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original)
    }
  })

  it('falls back to the __FRESHELL_BUILD_ID__ global and window defaults when options are omitted', () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'c'.repeat(40))
    const reload = vi.fn()
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // replace window-level with a spread copy.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()

    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(SENTINEL)).toBe('d'.repeat(40))

    // And with the global absent (Vitest has no define), it is a no-op.
    vi.unstubAllGlobals()
    sessionStorage.removeItem(SENTINEL)
    checkServerBuildId({ serverBuildId: 'd'.repeat(40) })
    expect(reload).toHaveBeenCalledTimes(1)

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })
})

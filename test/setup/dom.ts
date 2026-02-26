import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, vi } from 'vitest'
import { enableMapSet } from 'immer'
import { resetWsClientForTests } from '@/lib/ws-client'

enableMapSet()

if (typeof globalThis.window !== 'undefined') {
  const storage = (globalThis as { localStorage?: unknown }).localStorage as {
    getItem?: unknown
    setItem?: unknown
    removeItem?: unknown
    clear?: unknown
  } | undefined

  if (
    !storage ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function' ||
    typeof storage.clear !== 'function'
  ) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: window.localStorage,
    })
  }
}

if (typeof globalThis.HTMLCanvasElement !== 'undefined') {
  if (typeof globalThis.HTMLCanvasElement.prototype.getContext === 'function') {
    Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value() {
        // jsdom emits a console.error for every getContext call; return null so
        // callers follow their normal "context unavailable" fallback paths.
        return null
      },
    })
  }
}

// Provide a minimal ResizeObserver stub for jsdom environments
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
    constructor(_cb: ResizeObserverCallback) {}
  } as unknown as typeof globalThis.ResizeObserver
}

// ── matchMedia polyfill for useMobile() hook ────────────────────────
// The useMobile hook caches a module-level MediaQueryList singleton, so
// we need a single mock object whose `matches` getter is dynamically
// controlled.  Tests can set `(globalThis as any).__MOBILE_MATCHES__`
// and fire `setMobileForTest(true/false)` to trigger change listeners.
const _mqlChangeListeners: Set<(e: { matches: boolean }) => void> = new Set()
;(globalThis as any).__MOBILE_MATCHES__ = false
;(globalThis as any).__MQL_CHANGE_LISTENERS__ = _mqlChangeListeners

/**
 * Call from tests to simulate a viewport change detected by useMobile().
 * This updates the matches value AND fires change listeners so that
 * useSyncExternalStore re-renders.
 */
;(globalThis as any).setMobileForTest = (mobile: boolean) => {
  ;(globalThis as any).__MOBILE_MATCHES__ = mobile
  for (const cb of _mqlChangeListeners) {
    cb({ matches: mobile })
  }
}

if (typeof globalThis.window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((_query: string) => ({
      get matches() { return (globalThis as any).__MOBILE_MATCHES__ as boolean },
      media: _query,
      addEventListener: (_event: string, cb: (e: { matches: boolean }) => void) => {
        _mqlChangeListeners.add(cb)
      },
      removeEventListener: (_event: string, cb: (e: { matches: boolean }) => void) => {
        _mqlChangeListeners.delete(cb)
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  })
}

// Reset mobile state between tests
beforeEach(() => {
  ;(globalThis as any).__MOBILE_MATCHES__ = false
})
// ── end matchMedia polyfill ─────────────────────────────────────────

let errorSpy: ReturnType<typeof vi.spyOn> | null = null
let consoleErrorCalls: Array<{ args: unknown[]; stack?: string }> = []
let hasCapturedErrorStack = false

beforeEach(() => {
  consoleErrorCalls = []
  hasCapturedErrorStack = false
  const impl = (...args: unknown[]) => {
    // Capturing stacks for every console.error can be expensive; keep the first one for debugging.
    let stack: string | undefined
    if (!hasCapturedErrorStack) {
      hasCapturedErrorStack = true
      const err = new Error('console.error captured')
      // Exclude this helper from the captured stack for better signal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Error as any).captureStackTrace?.(err, impl)
      stack = err.stack
    }
    consoleErrorCalls.push({ args, stack })
  }
  errorSpy = vi.spyOn(console, 'error').mockImplementation(impl)
})

afterEach(() => {
  resetWsClientForTests()
  errorSpy?.mockRestore()
  errorSpy = null

  const allow = (globalThis as any).__ALLOW_CONSOLE_ERROR__ === true
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = false

  if (!allow && consoleErrorCalls.length > 0) {
    const first = consoleErrorCalls[0]
    const rendered = first?.args?.map(String).join(' ') ?? ''
    const stack = first?.stack ? `\n${first.stack}` : ''
    throw new Error(`Unexpected console.error: ${rendered}${stack}`)
  }
})

const clipboardMock = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}

Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: clipboardMock,
  configurable: true,
})

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

// A test that deliberately exercises an error/warning path must capture that
// output (spy on the console method and assert on it) rather than let it leak.
// Any console.error or console.warn a test does not capture fails that test —
// unexpected console noise is a bug. A test that legitimately cannot spy can
// opt out for a single test by setting __ALLOW_CONSOLE_ERROR__ /
// __ALLOW_CONSOLE_WARN__ to true; the flag resets after each test.
type ConsoleTrap = {
  method: 'error' | 'warn'
  allowFlag: '__ALLOW_CONSOLE_ERROR__' | '__ALLOW_CONSOLE_WARN__'
  spy: ReturnType<typeof vi.spyOn> | null
  calls: Array<{ args: unknown[]; stack?: string }>
  hasCapturedStack: boolean
}

const consoleTraps: ConsoleTrap[] = [
  { method: 'error', allowFlag: '__ALLOW_CONSOLE_ERROR__', spy: null, calls: [], hasCapturedStack: false },
  { method: 'warn', allowFlag: '__ALLOW_CONSOLE_WARN__', spy: null, calls: [], hasCapturedStack: false },
]

beforeEach(() => {
  for (const trap of consoleTraps) {
    trap.calls = []
    trap.hasCapturedStack = false
    const impl = (...args: unknown[]) => {
      // Capturing stacks for every call can be expensive; keep the first one for debugging.
      let stack: string | undefined
      if (!trap.hasCapturedStack) {
        trap.hasCapturedStack = true
        const err = new Error(`console.${trap.method} captured`)
        // Exclude this helper from the captured stack for better signal.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(Error as any).captureStackTrace?.(err, impl)
        stack = err.stack
      }
      trap.calls.push({ args, stack })
    }
    trap.spy = vi.spyOn(console, trap.method).mockImplementation(impl)
  }
})

afterEach(() => {
  resetWsClientForTests()

  const failures: string[] = []
  for (const trap of consoleTraps) {
    trap.spy?.mockRestore()
    trap.spy = null

    const allow = (globalThis as any)[trap.allowFlag] === true
    ;(globalThis as any)[trap.allowFlag] = false

    // Redux Toolkit's dev-only invariant middleware warns when a check exceeds a
    // wall-clock threshold ("<name> took <n>ms, which is more than the warning
    // threshold..."). That is machine-load-dependent perf noise, not app output,
    // and would flake the suite on any store-dispatching test. Ignore it.
    const relevant = trap.calls.filter(
      (call) => !/ took \d+ms, which is more than the warning threshold/.test(call.args.map(String).join(' ')),
    )

    if (!allow && relevant.length > 0) {
      const first = relevant[0]
      const rendered = first?.args?.map(String).join(' ') ?? ''
      const stack = first?.stack ? `\n${first.stack}` : ''
      failures.push(`Unexpected console.${trap.method}: ${rendered}${stack}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
})

const clipboardMock = {
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(''),
}

if (typeof globalThis.navigator !== 'undefined') {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: clipboardMock,
    configurable: true,
  })
}

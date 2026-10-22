import { describe, it, expect, beforeEach, vi } from 'vitest'

// Name reliability (Task 2, RC10) — a full browser storage must never block
// a layout save. The migration module's one-time capture runs at import
// time, so this file defines its localStorage mock and arms the failure
// BEFORE dynamically importing any store module: every write under
// `freshell.session-names.*` throws (quota), every other write succeeds.
//
// Import ORDER mirrors main.tsx: the capture module loads FIRST (its capture
// of the waiting genuine legacy key fails against the armed mock), then the
// persistence middleware and the tabs slice. The layout save that follows
// must land regardless, and the failed capture must be reported as a
// structured error.

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.status = status
      this.data = data
    }
  },
}))

vi.mock('@/lib/api', () => ({ api: { post: apiMocks.post }, ApiError: apiMocks.ApiError }))

const WINDOW_ID = 'persist-flush-capture-gate-tests'
const LAYOUT_KEY = `freshell.layout.v3.${WINDOW_ID}`
const SESSION_NAMES_PREFIX = 'freshell.session-names.'

const storageMap = new Map<string, string>()
let failSessionNamesWrites = false
const localStorageMock = {
  get length() { return storageMap.size },
  key(index: number) { return Array.from(storageMap.keys())[index] ?? null },
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem(key: string, value: string) {
    if (failSessionNamesWrites && key.startsWith(SESSION_NAMES_PREFIX)) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    storageMap.set(key, value)
  },
  removeItem: (key: string) => { storageMap.delete(key) },
  clear() { storageMap.clear() },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
})

/** A genuine pre-migration layout (the bare legacy key) with a scoped
 * claude pane carrying a user label: real legacy evidence waiting to be
 * captured. */
function legacyLayoutRaw(): string {
  return JSON.stringify({
    version: 4,
    persistedAt: 1234,
    tabs: {
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: 'Old Tab Title', titleSetByUser: true }],
    },
    panes: {
      version: 7,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-1',
            terminalId: 'term-1',
            sessionRef: { provider: 'claude', sessionId: 'sess-1' },
          },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Precious Legacy Alias' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    },
  })
}

beforeEach(() => {
  storageMap.clear()
  failSessionNamesWrites = false
  apiMocks.post.mockReset()
  sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure paths log
})

describe('the layout save is never blocked by legacy-name capture', () => {
  it('a quota-failing capture never blocks the layout flush', async () => {
    storageMap.set('freshell.layout.v3', legacyLayoutRaw())

    // Boot: the capture runs at import, and every session-names write
    // fails (quota) — for the whole test, not just at boot.
    failSessionNamesWrites = true
    await import('@/lib/session-name-migration')
    const envelopeKeys = Array.from(storageMap.keys()).filter((key) => key.startsWith(SESSION_NAMES_PREFIX))
    expect(envelopeKeys).toEqual([])

    const { persistMiddleware, resetPersistFlushListenersForTests } =
      await import('@/store/persistMiddleware')
    const { default: tabsReducer, addTab, updateTab } = await import('@/store/tabsSlice')
    const { configureStore } = await import('@reduxjs/toolkit')

    vi.useFakeTimers()
    try {
      resetPersistFlushListenersForTests()
      const store = configureStore({
        reducer: { tabs: tabsReducer },
        middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
      })

      // The user renames a shell tab; the debounced flush must save it even
      // though the capture keeps failing.
      store.dispatch(addTab({ id: 'tab-shell', mode: 'shell' }))
      store.dispatch(updateTab({ id: 'tab-shell', updates: { title: 'Renamed Shell Tab', titleSetByUser: true } }))
      vi.runAllTimers()

      const flushedRaw = storageMap.get(LAYOUT_KEY)
      expect(flushedRaw).toBeTruthy()
      const flushed = JSON.parse(flushedRaw!) as { tabs: { tabs: Array<{ id: string; title?: string }> } }
      expect(flushed.tabs.tabs.find((tab) => tab.id === 'tab-shell')?.title).toBe('Renamed Shell Tab')
    } finally {
      vi.useRealTimers()
    }

    // The failed capture was reported as a structured error naming the key
    // (never its bytes).
    const logged = vi.mocked(console.error).mock.calls.find((args) => args.includes('legacy_name_capture_failed'))
    expect(logged).toBeTruthy()
    expect(logged?.find((arg) => typeof arg === 'object' && arg !== null)).toEqual({
      storageKey: 'freshell.layout.v3',
      reason: 'QuotaExceededError',
    })
  })
})

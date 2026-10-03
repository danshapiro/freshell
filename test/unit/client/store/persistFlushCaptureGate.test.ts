import { describe, it, expect, beforeEach, vi } from 'vitest'

// Unified agent names (Task 7 review M2) — the capture-failure window: the
// migration module's side-effect capture runs at import time, so this file
// defines its localStorage mock and arms the envelope-write failure BEFORE
// dynamically importing any store module. The flush gate under test: a
// persistence flush must never rewrite a capture-source key while its
// current raw bytes are uncaptured — the legacy labels survive for retry.
//
// Import ORDER matters and mirrors main.tsx: the capture module loads FIRST
// (its init capture fails against the armed mock), and the fresh-agent
// commit marker is pre-pinned for the seeded raw so the storage migration
// (self-executing at import, pulled in through layout-health) treats it as
// already migrated and leaves the source bytes untouched — the persistence
// flush is then the ONLY writer of the layout key in this test.

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
const ENVELOPE_PREFIX = 'freshell.session-names.migration.v1.'

const storageMap = new Map<string, string>()
let failEnvelopeWrites = false
const localStorageMock = {
  get length() { return storageMap.size },
  key(index: number) { return Array.from(storageMap.keys())[index] ?? null },
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem(key: string, value: string) {
    if (failEnvelopeWrites && key.startsWith(ENVELOPE_PREFIX)) {
      throw new Error('quota exceeded')
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

/** A legacy layout raw with a scoped claude pane carrying a title alias. */
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
  failEnvelopeWrites = false
  apiMocks.post.mockReset()
  sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
  ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true // the failure paths log
})

describe('the persistence flush gate keeps uncaptured legacy labels alive', () => {
  it('defers the layout flush while the evidence capture keeps failing, then flushes after the retry captures', async () => {
    const legacyRaw = legacyLayoutRaw()
    storageMap.set(LAYOUT_KEY, legacyRaw)

    // Boot: the migration module's init capture runs, but every envelope
    // write fails (quota). The source key keeps its legacy bytes.
    failEnvelopeWrites = true
    const migration = await import('@/lib/session-name-migration')
    expect(migration.listCapturedMigrationEnvelopes(localStorageMock)).toHaveLength(0)
    expect(storageMap.get(LAYOUT_KEY)).toBe(legacyRaw)
    migration.resetLegacyNameCaptureFailureForTests()
    migration.captureLegacyLayoutEnvelope(LAYOUT_KEY, legacyRaw, localStorageMock)

    // Pre-pin the fresh-agent commit marker for the seeded raw so the
    // import-time storage migration classifies it already-migrated.
    const persisted = await import('@/store/persistedState')
    const wlk = await import('@/store/window-layout-keys')
    const hash = persisted.hashPersistedLayoutRaw(legacyRaw)
    storageMap.set(wlk.getWindowFreshAgentCommitMarkerKey(), JSON.stringify({
      version: 1,
      migration: persisted.LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: persisted.LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hash,
      migratedHash: hash,
      committedAt: 1234,
    }))

    const { persistMiddleware, resetPersistFlushListenersForTests } =
      await import('@/store/persistMiddleware')
    const { default: tabsReducer, addTab } = await import('@/store/tabsSlice')
    const { default: panesReducer } = await import('@/store/panesSlice')
    const { configureStore } = await import('@reduxjs/toolkit')

    // The storage migration (self-executing at import) must have left the
    // source bytes untouched — the flush is the only writer under test.
    expect(storageMap.get(LAYOUT_KEY)).toBe(legacyRaw)

    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // A flush fires (debounced) while the capture is STILL failing: the
    // gate must defer the layout write — the uncaptured legacy labels
    // survive untouched for the retry.
    store.dispatch(addTab({ mode: 'shell' }))
    vi.runAllTimers()
    expect(storageMap.get(LAYOUT_KEY)).toBe(legacyRaw)

    // Quota frees up: the next flush re-captures the source bytes FIRST,
    // then proceeds — the legacy label now lives in its immutable
    // recovery envelope.
    failEnvelopeWrites = false
    store.dispatch(addTab({ mode: 'shell' }))
    vi.runAllTimers()
    const flushedRaw = storageMap.get(LAYOUT_KEY)
    expect(flushedRaw).not.toBe(legacyRaw)
    const envelopes = migration.listCapturedMigrationEnvelopes(localStorageMock)
    expect(
      envelopes.some((envelope) => envelope.storageKey === LAYOUT_KEY && envelope.raw === legacyRaw),
    ).toBe(true)

    vi.useRealTimers()
  })

  it('keeps an immediate close dirty and armed when capture defers its flush, then retries after capture succeeds', async () => {
    vi.resetModules()
    storageMap.clear()
    const legacyRaw = legacyLayoutRaw()
    storageMap.set(LAYOUT_KEY, legacyRaw)
    failEnvelopeWrites = true
    sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)

    const migration = await import('@/lib/session-name-migration')
    migration.resetLegacyNameCaptureFailureForTests()
    migration.captureLegacyLayoutEnvelope(LAYOUT_KEY, legacyRaw, localStorageMock)
    const persisted = await import('@/store/persistedState')
    const wlk = await import('@/store/window-layout-keys')
    const hash = persisted.hashPersistedLayoutRaw(legacyRaw)
    storageMap.set(wlk.getWindowFreshAgentCommitMarkerKey(), JSON.stringify({
      version: 1,
      migration: persisted.LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: persisted.LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hash,
      migratedHash: hash,
      committedAt: 1234,
    }))

    const { persistMiddleware, resetPersistFlushListenersForTests } = await import('@/store/persistMiddleware')
    const { flushPersistedLayoutNow, isLocalClosePersistencePending, markLocalClosePersistencePending } =
      await import('@/store/persistControl')
    const { default: tabsReducer, addTab, removeTab } = await import('@/store/tabsSlice')
    const { default: panesReducer } = await import('@/store/panesSlice')
    const { configureStore } = await import('@reduxjs/toolkit')

    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Build the user close and force its immediate boundary flush while the
    // evidence envelope write is still failing.
    store.dispatch(addTab({ mode: 'shell' }))
    markLocalClosePersistencePending(store.getState)
    for (const tab of store.getState().tabs.tabs) store.dispatch(removeTab(tab.id))
    store.dispatch(flushPersistedLayoutNow())

    expect(storageMap.get(LAYOUT_KEY)).toBe(legacyRaw)
    expect(isLocalClosePersistencePending(store.getState)).toBe(true)

    // Once capture can persist its evidence, the same dirty close cycle is
    // retryable without another user action or unrelated state mutation.
    failEnvelopeWrites = false
    store.dispatch(flushPersistedLayoutNow())
    const closedRaw = storageMap.get(LAYOUT_KEY)
    expect(closedRaw).not.toBe(legacyRaw)
    expect(JSON.parse(closedRaw!).tabs.tabs).toEqual([])
    expect(isLocalClosePersistencePending(store.getState)).toBe(false)
    expect(migration.listCapturedMigrationEnvelopes(localStorageMock)).toContainEqual(
      expect.objectContaining({ storageKey: LAYOUT_KEY, raw: legacyRaw }),
    )
    vi.useRealTimers()
  })
})

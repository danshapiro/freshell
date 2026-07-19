// Regression coverage for the destructive persist-of-empty guard.
//
// Incident: a transient failure reading the persisted layout (corrupt JSON,
// a thrown exception, or sanitizeTabsAgainstLayouts pruning every tab because
// its pane layout was missing) causes loadInitialTabsState() to fall back to
// an empty tabs array. If ANY later action then triggers a flush (even a
// panes-only or activeTabId-only change that never touches the tabs array),
// persistMiddleware's combined layout write would overwrite the perfectly
// good, non-empty layout already on disk with an empty one -- permanently
// destroying the user's tab layout.
//
// The fix distrusts an empty in-memory tabs array for persistence purposes
// until either (a) real tab content is observed in this session, proving the
// emptiness is trustworthy, or (b) there was nothing on disk to protect in
// the first place. A genuine user action that empties tabs (removeTab) is
// still persisted normally -- this guard must never regress that behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { LAYOUT_STORAGE_KEY } from '@/store/storage-keys'

describe('persist middleware — destructive empty-tabs guard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not overwrite a non-empty persisted layout with empty tabs after a transient parse failure', async () => {
    // Simulate a transient failure: the raw layout key exists (something WAS
    // persisted) but is corrupt JSON, so parsePersistedLayoutRaw fails and
    // loadInitialTabsState() falls back to an empty tabs array. The bytes on
    // disk are still whatever they were -- that's the thing we must protect.
    const corruptRaw = '{not valid json, but not empty either'
    localStorage.setItem(LAYOUT_STORAGE_KEY, corruptRaw)

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, setActiveTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Loaded state should indeed be empty (the failure fell back to default).
    expect(store.getState().tabs.tabs).toEqual([])

    // An unrelated tabs-slice action fires (does not touch the tabs array,
    // e.g. activeTabId bookkeeping) — this is exactly the kind of action
    // that must NOT be treated as "the user emptied their tabs".
    store.dispatch(setActiveTab('some-tab-id'))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    // The original (corrupt) persisted value must be untouched — the guard
    // must refuse to destroy it with a freshly-serialized empty-tabs layout.
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(corruptRaw)
  })

  it('still persists a genuine close-all-tabs to an empty layout (no regression)', async () => {
    // A real, valid, non-empty persisted layout — the normal, successful load path.
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Real Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, removeTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    expect(store.getState().tabs.tabs).toHaveLength(1)

    // The user genuinely closes their only tab.
    store.dispatch(removeTab('tab-1'))
    expect(store.getState().tabs.tabs).toEqual([])

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs).toEqual([])
  })

  it('normal flush path is unaffected when tabs are non-empty throughout', async () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Real Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' } },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: tabsReducer, updateTab } = await import('@/store/tabsSlice')
    const { persistMiddleware, PERSIST_DEBOUNCE_MS, resetPersistFlushListenersForTests } = await import(
      '@/store/persistMiddleware'
    )
    resetPersistFlushListenersForTests()

    const store = freshConfigureStore({
      reducer: { tabs: tabsReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Renamed' } }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs).toHaveLength(1)
    expect(parsed.tabs.tabs[0].title).toBe('Renamed')
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

// Mock localStorage before importing slices (pattern used in panesPersistence.test.ts)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import tabsReducer, { updateTab } from '@/store/tabsSlice'
import panesReducer, { replacePane } from '@/store/panesSlice'
import tabRecencyReducer, {
  loadPersistedTabRecency,
  recordPaneTabActivity,
} from '@/store/tabRecencySlice'
import { tabRecencyPruneMiddleware } from '@/store/tabRecencyPruneMiddleware'
import {
  PERSIST_DEBOUNCE_MS,
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedLayoutCacheForTests,
} from '@/store/persistMiddleware'
import { onPersistBroadcast, resetPersistBroadcastForTests } from '@/store/persistBroadcast'
import { LAYOUT_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY } from '@/store/storage-keys'

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-1',
          title: 'Test',
          status: 'running',
          mode: 'shell',
          createdAt: 123,
          lastInputAt: 111,
        }],
        activeTabId: 'tab-1',
        tombstones: [],
      },
    },
  })
}

function makeRecencyStore(preloadedState?: any) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      tabRecency: tabRecencyReducer,
    },
    middleware: (getDefault) => getDefault().concat(
      tabRecencyPruneMiddleware as any,
      persistMiddleware as any,
    ),
    preloadedState: preloadedState ?? {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-tab-1',
          title: 'Test',
          status: 'running',
          mode: 'shell',
          createdAt: 123,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabRecency: {
        paneLastInputAt: {},
      },
    },
  })
}

describe('tabs persistence - skipPersist + strip volatile fields', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not schedule a new tabs write when meta.skipPersist is set', () => {
    const store = makeStore()
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    // Force one baseline flush so no pending timer remains
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'A' } }))
    vi.runAllTimers()
    setItemSpy.mockClear()

    store.dispatch({
      type: 'tabs/updateTab',
      payload: { id: 'tab-1', updates: { lastInputAt: 999 } },
      meta: { skipPersist: true },
    })

    vi.runAllTimers()
    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('strips lastInputAt from persisted tabs payload', () => {
    const store = makeStore()
    store.dispatch(updateTab({ id: 'tab-1', updates: { lastInputAt: 999 } }))
    vi.runAllTimers()

    const raw = localStorage.getItem('freshell.layout.v3')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs[0].lastInputAt).toBeUndefined()
  })

  it('persists recency-only activity to the sidecar without rewriting layout', () => {
    const store = makeRecencyStore()
    const broadcasts: Array<{ key: string; raw: string }> = []
    const unsubscribe = onPersistBroadcast((msg) => {
      broadcasts.push({ key: msg.key, raw: msg.raw })
    })
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    try {
      store.dispatch(recordPaneTabActivity({
        paneId: 'pane-1',
        at: 1_740_000_059_999,
      }))
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

      expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
        version: 1,
        paneLastInputAt: {
          'pane-1': 1_740_000_000_000,
        },
      })
      expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
      expect(setItemSpy).not.toHaveBeenCalledWith(LAYOUT_STORAGE_KEY, expect.any(String))
      expect(broadcasts.map((msg) => msg.key)).toEqual([TAB_RECENCY_STORAGE_KEY])
    } finally {
      unsubscribe()
    }
  })

  it('does not rewrite the recency sidecar when topology changes prune nothing', () => {
    const store = makeRecencyStore()
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    expect(setItemSpy).toHaveBeenCalledWith(LAYOUT_STORAGE_KEY, expect.any(String))
    expect(setItemSpy).not.toHaveBeenCalledWith(TAB_RECENCY_STORAGE_KEY, expect.any(String))
    expect(localStorage.getItem(TAB_RECENCY_STORAGE_KEY)).toBeNull()
  })

  it('prunes pane recency immediately when a terminal pane becomes non-terminal', () => {
    localStorage.setItem(TAB_RECENCY_STORAGE_KEY, JSON.stringify({
      version: 1,
      paneLastInputAt: {
        'pane-live': 1_740_000_000_000,
        'pane-stale': 1_740_000_060_000,
      },
    }))

    const store = makeRecencyStore({
      tabs: {
        tabs: [{
          id: 'tab-live',
          createRequestId: 'tab-live',
          title: 'Live',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
        activeTabId: 'tab-live',
        renameRequestTabId: null,
        tombstones: [],
      },
      panes: {
        layouts: {
          'tab-live': {
            type: 'split',
            id: 'root',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-live',
                content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-live', status: 'running' },
              },
              {
                type: 'leaf',
                id: 'pane-stale',
                content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-stale', status: 'running' },
              },
            ],
          },
        },
        activePane: { 'tab-live': 'pane-live' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabRecency: loadPersistedTabRecency(localStorage.getItem(TAB_RECENCY_STORAGE_KEY)),
    })

    store.dispatch(replacePane({ tabId: 'tab-live', paneId: 'pane-stale' }))

    expect(store.getState().tabRecency.paneLastInputAt).toEqual({
      'pane-live': 1_740_000_000_000,
    })

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      paneLastInputAt: {
        'pane-live': 1_740_000_000_000,
      },
    })
  })

  it('prunes persisted recency during real store startup before pane ids can be reused', async () => {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      version: 4,
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Picker Tab',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        version: 7,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-reused',
            content: { kind: 'picker' },
          },
        },
        activePane: { 'tab-1': 'pane-reused' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))
    localStorage.setItem(TAB_RECENCY_STORAGE_KEY, JSON.stringify({
      version: 1,
      paneLastInputAt: {
        'pane-reused': 1_740_000_060_000,
      },
    }))

    vi.resetModules()
    const [{ store }, { updatePaneContent }] = await Promise.all([
      import('@/store/store'),
      import('@/store/panesSlice'),
    ])

    expect(store.getState().tabRecency.paneLastInputAt).not.toHaveProperty('pane-reused')

    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      paneLastInputAt: {},
    })

    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-reused',
      content: { kind: 'terminal', mode: 'shell' },
    }))

    expect(store.getState().tabRecency.paneLastInputAt).not.toHaveProperty('pane-reused')
  })

  it('does not persist same-bucket no-op tab recency actions', () => {
    const store = makeRecencyStore({
      tabs: {
        tabs: [],
        activeTabId: null,
        renameRequestTabId: null,
        tombstones: [],
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabRecency: {
        paneLastInputAt: {
          'pane-1': 1_740_000_000_000,
        },
      },
    })
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    store.dispatch(recordPaneTabActivity({
      paneId: 'pane-1',
      at: 1_740_000_050_000,
    }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    expect(setItemSpy).not.toHaveBeenCalledWith(TAB_RECENCY_STORAGE_KEY, expect.any(String))
    expect(setItemSpy).not.toHaveBeenCalledWith(LAYOUT_STORAGE_KEY, expect.any(String))
  })

  it('merges recency-only persistence with the existing sidecar by per-pane max', () => {
    localStorage.setItem(TAB_RECENCY_STORAGE_KEY, JSON.stringify({
      version: 1,
      paneLastInputAt: {
        'pane-existing': 1_740_000_120_000,
        'pane-shared': 1_740_000_120_000,
      },
    }))
    const store = makeRecencyStore({
      tabs: {
        tabs: [],
        activeTabId: null,
        renameRequestTabId: null,
        tombstones: [],
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabRecency: {
        paneLastInputAt: {
          'pane-shared': 1_740_000_000_000,
        },
      },
    })

    store.dispatch(recordPaneTabActivity({
      paneId: 'pane-new',
      at: 1_740_000_060_000,
    }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      paneLastInputAt: {
        'pane-existing': 1_740_000_120_000,
        'pane-new': 1_740_000_060_000,
        'pane-shared': 1_740_000_120_000,
      },
    })
  })

  it('drops stale shared session identity on initial load when the persisted layout is split', async () => {
    localStorageMock.clear()
    resetPersistedLayoutCacheForTests()

    localStorage.setItem('freshell.layout.v3', JSON.stringify({
      version: 4,
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Split Claude Tab',
          mode: 'claude',
          status: 'running',
          createdAt: 1,
          sessionRef: {
            provider: 'claude',
            sessionId: '00000000-0000-4000-8000-000000000601',
          },
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-root',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                  createRequestId: 'req-1',
                  status: 'idle',
                  sessionRef: {
                    provider: 'claude',
                    sessionId: '00000000-0000-4000-8000-000000000602',
                  },
                },
              },
              {
                type: 'leaf',
                id: 'pane-2',
                content: {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                  createRequestId: 'req-2',
                  status: 'idle',
                  sessionRef: {
                    provider: 'claude',
                    sessionId: '00000000-0000-4000-8000-000000000603',
                  },
                },
              },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    vi.resetModules()
    const { default: freshTabsReducer } = await import('../../../../src/store/tabsSlice')
    const store = configureStore({ reducer: { tabs: freshTabsReducer } })

    const tab = store.getState().tabs.tabs[0]
    expect(tab?.sessionRef).toBeUndefined()
    expect(tab?.resumeSessionId).toBeUndefined()
  })
})

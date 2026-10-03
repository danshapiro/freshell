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

import tabsReducer, { closePaneWithCleanup, closeTab, replacePaneWithCleanup, updateTab, removeTab } from '@/store/tabsSlice'
import panesReducer, { replacePane, splitPane, updatePaneContent } from '@/store/panesSlice'
import machineIdentityReducer, { setMachineReady } from '@/store/machineIdentitySlice'
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
import {
  clearLocalClosePersistencePending,
  flushPersistedLayoutNow,
  isLocalClosePersistencePending,
  resetAuthoritativeLocalLayoutPersistedAtForTests,
} from '@/store/persistControl'
import { MACHINE_ID_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY } from '@/store/storage-keys'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { handleUiCommand } from '@/lib/ui-commands'

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

// Delta round 3, finding 1: the flush writes THIS window's per-window layout
// key (freshell.layout.v3.<layoutWindowId>).
const WINDOW_ID = 'client-tabs-persistence-tests'
sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`

describe('tabs persistence - skipPersist + strip volatile fields', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.useFakeTimers()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    clearLocalClosePersistencePending()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
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

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
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

    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
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
                  kind: 'fresh-agent',
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
                  kind: 'fresh-agent',
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

  it('survives reload when an MCP tab.create carries a malformed mode field, keeping other tabs intact', () => {
    localStorageMock.clear()
    resetPersistedLayoutCacheForTests()

    const store = makeStore() // preloaded with valid tab 'tab-1'

    // Simulate an external/extension caller (e.g. the agent-api tab.create command) sending
    // a payload whose `mode` field is not a string - a foreign or malformed value should not
    // be able to nuke the entire persisted layout on the next reload.
    handleUiCommand(
      {
        type: 'ui.command',
        command: 'tab.create',
        payload: { id: 'ext-tab', title: 'Extension Tab', mode: 42 },
      },
      store.dispatch,
    )

    vi.runAllTimers()

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()

    // This is exactly what happens on the next page load: the raw persisted string is
    // re-parsed. Before the fix, a single tab with a malformed `mode` value nuked the
    // whole layout (parsePersistedLayoutRaw returned null), wiping every tab - including
    // 'tab-1', which had nothing wrong with it.
    const parsed = parsePersistedLayoutRaw(raw!)
    expect(parsed).not.toBeNull()

    const ids = parsed!.tabs.tabs.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['tab-1', 'ext-tab']))

    const extTab = parsed!.tabs.tabs.find((t) => t.id === 'ext-tab')
    expect(extTab).toBeDefined()
    expect(extTab!.mode).toBeUndefined()
  })
})

describe('persisted layout machineId stamp', () => {
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

  function makeMachineStampStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, machineIdentity: machineIdentityReducer },
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

  it('stamps the flushed envelope with the machine identity slice current machine id', () => {
    const store = makeMachineStampStore()
    store.dispatch(setMachineReady({
      machine: { id: 'machine-stamp-1', label: 'Garage', createdAt: 1, lastSeenAt: 2 },
      mode: 'server-managed',
    }))
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Stamped' } }))
    vi.runAllTimers()

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).machineId).toBe('machine-stamp-1')
  })

  it('falls back to the remembered machine selection when the machine identity slice holds no machine yet', () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-remembered-1')
    const store = makeMachineStampStore()

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Stamped' } }))
    vi.runAllTimers()

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).machineId).toBe('machine-remembered-1')
  })

  it('omits the machineId field when no machine is known and no selection is remembered', () => {
    const store = makeMachineStampStore()

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Stamped' } }))
    vi.runAllTimers()

    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).not.toHaveProperty('machineId')
  })
})

// Task-008b review F1 (landed by task-010): a persist flush that throws
// (quota pressure, storage failure) must not permanently lose that dirty
// cycle. The dirty flags stay armed so the NEXT flush opportunity (a new
// action, a flushPersistedLayoutNow dispatch, or the visibility/pagehide
// flushNow) retries the same state, and the failure surfaces as one
// structured error line instead of being swallowed.
describe('persist flush failure retry', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.useFakeTimers()
    clearLocalClosePersistencePending()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()
    resetPersistedLayoutCacheForTests()
  })

  afterEach(() => {
    clearLocalClosePersistencePending()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Wrap localStorage.setItem so the FIRST write to the layout key throws
   * (a transient quota-pressure failure) and every other write — including
   * that key's retry — goes through to real storage.
   */
  function failFirstLayoutWrite() {
    const originalSetItem = localStorageMock.setItem.bind(localStorageMock)
    let thrown = false
    vi.spyOn(localStorageMock, 'setItem').mockImplementation((key: string, value: string) => {
      if (!thrown && key === LAYOUT_STORAGE_KEY) {
        thrown = true
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      originalSetItem(key, value)
    })
  }

  it('keeps the dirty state and retries the next flush when a persist flush fails once', () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    const consoleErrors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args)
    })
    failFirstLayoutWrite()
    const store = makeStore()

    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Retry Me' } }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    // The failed flush persisted nothing...
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBeNull()
    // ...and surfaced as ONE structured error line naming the failure
    // (not a silent swallow).
    expect(consoleErrors.length).toBe(1)
    const [prefix, message, context] = consoleErrors[0]
    expect(String(prefix)).toBe('[PanesPersist]')
    expect(String(message)).toContain('Failed to persist layout')
    expect((context as { reason?: string } | undefined)?.reason).toBe('persist_flush_failed')

    // The next flush opportunity retries the SAME dirty state and
    // succeeds — the transient failure lost nothing.
    store.dispatch(flushPersistedLayoutNow())
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).tabs.tabs[0].title).toBe('Retry Me')
  })

  it('a failed flush preserves the user-close authorization so the retry persists the closed layout instead of being refused by the empty-tabs guard', () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    const consoleErrors: unknown[][] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args)
    })
    // Seed a protected (unparseable-but-present) persisted layout — the
    // exact shape the destructive empty-tabs guard exists to defend.
    localStorage.setItem(LAYOUT_STORAGE_KEY, '{not valid json, but not empty either')
    failFirstLayoutWrite()
    const store = makeStore()

    // The user closes their last tab: the only write that may lawfully
    // replace the protected layout with an empty one.
    store.dispatch(removeTab('tab-1'))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    // The authorized close-flush failed transiently: the protected layout
    // was left untouched (still the seeded unparseable raw).
    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe('{not valid json, but not empty either')

    // The retry must still carry the user-close authorization — otherwise
    // the guard would refuse the retried write (the pending dirty state IS
    // the user's close) and permanently lose it.
    store.dispatch(flushPersistedLayoutNow())
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).tabs.tabs).toEqual([])
    expect(
      consoleErrors.map((args) => args.map(String).join(' ')).join('\n'),
    ).not.toContain('empty_tabs_write_refused')
  })

  it('persists a successful close immediately with a strictly newer timestamp', async () => {
    vi.setSystemTime(new Date(50_000))
    const store = makeRecencyStore()
    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'browser', url: 'https://close.example', devToolsOpen: false },
    }))
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Before close' } }))
    store.dispatch(flushPersistedLayoutNow())
    const beforeRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(beforeRaw).not.toBeNull()
    const beforePersistedAt = JSON.parse(beforeRaw!).persistedAt as number

    const closeResult = await store.dispatch(closeTab('tab-1') as any)
    expect(closeResult).toMatchObject({ meta: { requestStatus: 'fulfilled' } })

    const closedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(closedRaw).not.toBeNull()
    const closedLayout = JSON.parse(closedRaw!)
    expect(closedLayout.tabs.tabs).toEqual([])
    expect(closedLayout.panes.layouts).toEqual({})
    expect(closedLayout.persistedAt).toBeGreaterThan(beforePersistedAt)
    expect(isLocalClosePersistencePending(store.getState)).toBe(false)
  })

  it('keeps the close marker pending across a failed immediate flush until a retry succeeds', async () => {
    ;(globalThis as any).__ALLOW_CONSOLE_ERROR__ = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.setSystemTime(new Date(50_000))
    const store = makeRecencyStore()
    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'browser', url: 'https://close.example', devToolsOpen: false },
    }))
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Before close' } }))
    store.dispatch(flushPersistedLayoutNow())
    const beforeRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(beforeRaw).not.toBeNull()
    const beforePersistedAt = JSON.parse(beforeRaw!).persistedAt as number

    failFirstLayoutWrite()
    const closeResult = await store.dispatch(closeTab('tab-1') as any)
    expect(closeResult).toMatchObject({ meta: { requestStatus: 'fulfilled' } })

    expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe(beforeRaw)
    expect(isLocalClosePersistencePending(store.getState)).toBe(true)

    store.dispatch(flushPersistedLayoutNow())

    const closedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    expect(closedRaw).not.toBeNull()
    const closedLayout = JSON.parse(closedRaw!)
    expect(closedLayout.tabs.tabs).toEqual([])
    expect(closedLayout.panes.layouts).toEqual({})
    expect(closedLayout.persistedAt).toBeGreaterThan(beforePersistedAt)
    expect(isLocalClosePersistencePending(store.getState)).toBe(false)
  })

  it('persists a successful pane removal immediately', async () => {
    vi.setSystemTime(new Date(50_000))
    const store = makeRecencyStore()
    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'browser', url: 'https://close.example', devToolsOpen: false },
    }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newPaneId: 'pane-2',
      newContent: { kind: 'browser', url: 'https://sibling.example', devToolsOpen: false },
    }))
    store.dispatch(flushPersistedLayoutNow())

    await store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }) as any)

    const persistedLayout = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!).panes.layouts['tab-1']
    expect(persistedLayout).toMatchObject({ type: 'leaf', id: 'pane-2' })
    expect(isLocalClosePersistencePending(store.getState)).toBe(false)
  })

  it('persists a successful pane replacement immediately', async () => {
    vi.setSystemTime(new Date(50_000))
    const store = makeRecencyStore()
    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'browser', url: 'https://replace.example', devToolsOpen: false },
    }))
    store.dispatch(flushPersistedLayoutNow())

    await store.dispatch(replacePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }) as any)

    const persistedLayout = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)!).panes.layouts['tab-1']
    expect(persistedLayout).toMatchObject({
      type: 'leaf',
      id: 'pane-1',
      content: { kind: 'picker' },
    })
    expect(isLocalClosePersistencePending(store.getState)).toBe(false)
  })
})

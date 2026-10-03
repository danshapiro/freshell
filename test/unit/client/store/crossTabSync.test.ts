import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer, { closeTab, hydrateTabs } from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes, hydratePaneTitles } from '../../../../src/store/panesSlice'
import machineIdentityReducer, { setMachineReady } from '../../../../src/store/machineIdentitySlice'
import tabRecencyReducer from '../../../../src/store/tabRecencySlice'
import settingsReducer, { setLocalSettings, updateSettingsLocal } from '../../../../src/store/settingsSlice'
import tabRegistryReducer, { setTabRegistrySearchRangeDays } from '../../../../src/store/tabRegistrySlice'
import { installCrossTabSync } from '../../../../src/store/crossTabSync'
import {
  clearLocalClosePersistencePending,
  isLocalClosePersistencePending,
  resetAuthoritativeLocalLayoutPersistedAtForTests,
} from '../../../../src/store/persistControl'
import {
  persistMiddleware,
  PERSIST_DEBOUNCE_MS,
  resetPersistFlushListenersForTests,
} from '../../../../src/store/persistMiddleware'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '../../../../src/store/browserPreferencesPersistence'
import { broadcastPersistedRaw, resetPersistBroadcastForTests } from '../../../../src/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY, MACHINE_ID_STORAGE_KEY, TAB_RECENCY_STORAGE_KEY } from '../../../../src/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'
import { listCapturedMigrationEnvelopes } from '@/lib/session-name-migration'
import { sessionMetadataKey } from '@/lib/session-metadata'

// Delta round 3, finding 1 + e3r1 findings 3/4: layout envelopes are keyed
// per window by the mint-once layout-window-id
// (freshell.layout.v3.<layoutWindowId>; e3r2 finding 1: the registry
// lease-collision rotation is the only path that remints it). Storage
// events for OTHER windows' keys run the TITLE-ONLY reconciliation path
// (no hydrateTabs, no hydratePanes — another window's arrangement never
// replaces this window's); this window's OWN key events (duplicate tabs
// before their lease-collision rotation remints their id, and the
// install-time own-envelope replacement) keep the full hydrateTabs +
// hydratePanes path.
const LAYOUT_WINDOW_ID_STORAGE_KEY = 'freshell.layout-window-id.v1'
const OWN_WINDOW_ID = 'client-crosstab-own'
const OWN_LAYOUT_KEY = `freshell.layout.v3.${OWN_WINDOW_ID}`
const REMOTE_LAYOUT_KEY = 'freshell.layout.v3.layout-window-remote'

describe('crossTabSync', () => {
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, OWN_WINDOW_ID)
  })

  afterEach(() => {
    clearLocalClosePersistencePending()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    vi.useRealTimers()
    localStorage.clear()
    sessionStorage.removeItem(LAYOUT_WINDOW_ID_STORAGE_KEY)
    vi.restoreAllMocks()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistFlushListenersForTests()
    resetPersistBroadcastForTests()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('hydrates OWN-key tabs (duplicate-tab flush) but preserves the local active tab when it still exists', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 't2',
        tabs: [
          { id: 't1', title: 'T1', createdAt: 1 },
          { id: 't2', title: 'T2', createdAt: 2 },
          { id: 't3', title: 'T3', createdAt: 3 },
        ],
      },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
  })

  it('hydrates OWN-key panes (duplicate-tab flush) but preserves the local activePane when it still exists', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
            { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
          ],
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},

    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-remote',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
              { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-b' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    expect(store.getState().panes.layouts['tab-1']?.id).toBe('split-remote')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-a')
  })

  it('rejects a stale own-key layout during a close without advancing the recency floor', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(100))
    let injected = false
    let barrierWasPending = false
    let staleManagedPaneWasRestored = false
    let foreignTitleWasAccepted = false
    const injectCloseWindowEvents = () => (next: (action: any) => any) => (action: any) => {
      const result = next(action)
      if (!injected && action?.type === 'tabs/removeTab') {
        injected = true
        barrierWasPending = isLocalClosePersistencePending()
        window.dispatchEvent(new StorageEvent('storage', {
          key: OWN_LAYOUT_KEY,
          newValue: JSON.stringify({
            version: 3,
            persistedAt: 200,
            tabs: { activeTabId: 't1', tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', createdAt: 1 }] },
            panes: {
              version: 6,
              layouts: {
                t1: {
                  type: 'split',
                  id: 'stale-managed-split',
                  direction: 'horizontal',
                  sizes: [50, 50],
                  children: [
                    {
                      type: 'leaf',
                      id: 'pane-managed',
                      content: {
                        kind: 'terminal',
                        createRequestId: 'managed-create',
                        terminalId: 'managed-terminal',
                        status: 'running',
                        mode: 'opencode',
                        soulId: 'managed-soul',
                        viewIntentId: 'managed-view',
                      },
                    },
                    {
                      type: 'leaf',
                      id: 'pane-keep',
                      content: { kind: 'browser', url: 'https://keep.example', devToolsOpen: false },
                    },
                  ],
                },
              },
              activePane: { t1: 'pane-managed' },
              paneTitles: { t1: { 'pane-keep': 'Stale own-key title' } },
              paneTitleSetByUser: {},
            },
            tombstones: [],
          }),
        }))
        const afterOwnKey = store.getState().panes.layouts.t1 as any
        staleManagedPaneWasRestored = afterOwnKey?.type === 'split'
          && afterOwnKey.children.some((child: any) => child.id === 'pane-managed')

        window.dispatchEvent(new StorageEvent('storage', {
          key: REMOTE_LAYOUT_KEY,
          newValue: JSON.stringify({
            version: 3,
            persistedAt: 150,
            tabs: { activeTabId: 't1', tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', createdAt: 1 }] },
            panes: {
              version: 6,
              layouts: {
                t1: {
                  type: 'leaf',
                  id: 'pane-keep',
                  content: { kind: 'browser', url: 'https://keep.example', devToolsOpen: false },
                },
              },
              activePane: { t1: 'pane-keep' },
              paneTitles: { t1: { 'pane-keep': 'Newer than the local envelope' } },
              paneTitleSetByUser: {},
            },
            tombstones: [],
          }),
        }))
        foreignTitleWasAccepted = store.getState().panes.paneTitles.t1?.['pane-keep']
          === 'Newer than the local envelope'
      }
      return result
    }
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(
        persistMiddleware as any,
        injectCloseWindowEvents as any,
      ),
    })
    store.dispatch({
      ...hydrateTabs({
        tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', createdAt: 1 }],
        activeTabId: 't1',
        renameRequestTabId: null,
        tombstones: [],
      } as any),
      meta: { skipPersist: true },
    })
    store.dispatch({
      ...hydratePanes({
        layouts: {
          t1: {
            type: 'leaf',
            id: 'pane-keep',
            content: { kind: 'browser', url: 'https://keep.example', devToolsOpen: false },
          },
        } as any,
        activePane: { t1: 'pane-keep' },
        paneTitles: { t1: { 'pane-keep': 'Local title' } },
        paneTitleSetByUser: {},
      }),
      meta: { skipPersist: true },
    })
    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 100,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', createRequestId: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          t1: {
            type: 'leaf',
            id: 'pane-keep',
            content: { kind: 'browser', url: 'https://keep.example', devToolsOpen: false },
          },
        },
        activePane: { t1: 'pane-keep' },
        paneTitles: { t1: { 'pane-keep': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))
    cleanups.push(installCrossTabSync(store as any))

    await store.dispatch(closeTab('t1') as any)

    expect(injected).toBe(true)
    expect(barrierWasPending).toBe(true)
    expect(staleManagedPaneWasRestored).toBe(false)
    expect(foreignTitleWasAccepted).toBe(true)
    expect(store.getState().tabs.tabs).toEqual([])
    expect(store.getState().panes.layouts.t1).toBeUndefined()
    expect(isLocalClosePersistencePending()).toBe(false)
    const closedRaw = localStorage.getItem(OWN_LAYOUT_KEY)
    expect(closedRaw).not.toBeNull()
    const closedLayout = JSON.parse(closedRaw!)
    expect(closedLayout.tabs.tabs).toEqual([])
    expect(closedLayout.persistedAt).toBeGreaterThan(150)
  })

  it('preserves canonical resume identity when an OWN-key flush (duplicate tab) rehydrates a fresh-agent pane', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-a',
            status: 'idle',
            resumeSessionId: '123e4567-e89b-42d3-a456-426614174000',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-a',
              status: 'idle',
              resumeSessionId: 'not-a-canonical-id',
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.resumeSessionId).toBe('123e4567-e89b-42d3-a456-426614174000')
  })

  it('drops incoming Codex runtime fields when the local pane already has a canonical sessionRef (OWN-key flush)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-a',
            status: 'running',
            terminalId: 'term-local',
            serverInstanceId: 'srv-local',
            streamId: 'stream-local',
            sessionRef: {
              provider: 'codex',
              sessionId: 'thread-1',
            },
            codexDurability: {
              schemaVersion: 1,
              state: 'durable',
              durableThreadId: 'thread-1',
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-b',
              status: 'running',
              terminalId: 'term-remote',
              serverInstanceId: 'srv-remote',
              streamId: 'stream-remote',
              sessionRef: {
                provider: 'codex',
                sessionId: 'thread-old',
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content).toMatchObject({
      createRequestId: 'req-a',
      status: 'running',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-1',
      },
      terminalId: 'term-local',
      serverInstanceId: 'srv-local',
      streamId: 'stream-local',
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-1',
      },
    })
  })

  it('keeps a locally rebound sessionRef when a stale tab broadcast still carries the old sessionId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local pane was rebound (server-authoritative) to new-id.
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-a',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-a',
            status: 'running',
            terminalId: 'term-local',
            sessionRef: {
              provider: 'codex',
              sessionId: 'new-id',
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    // A stale tab flushes a layout that still carries the superseded old-id.
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-a',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-a',
              status: 'running',
              terminalId: 'term-local',
              sessionRef: {
                provider: 'codex',
                sessionId: 'old-id',
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-a' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout.content.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'new-id',
    })
  })

  it('dedupes identical title-only payloads delivered via both storage and BroadcastChannel', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      const cleanup = installCrossTabSync(storeLike as any)

      const raw = JSON.stringify({
        version: 3,
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      })
      window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))

      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: REMOTE_LAYOUT_KEY, raw, sourceId: 'other' } })

      const titleOnlyCalls = dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'panes/hydratePaneTitles')
      expect(titleOnlyCalls).toHaveLength(1)

      cleanup()
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  it('evicts the retained raw on a removal storage event — a removed-then-recreated key reprocesses instead of deduping forever', () => {
    // e3r2 finding 3: lastProcessedRawByKey retained one complete
    // serialized layout per observed window; removal events
    // (newValue === null — what the stale-envelope prune sweep's
    // cross-document key removals look like) fell through the string
    // check, so pruned blobs accumulated for the life of the window and a
    // removed-then-recreated key replaying identical bytes was deduped as
    // already-processed.
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }
    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    const titleOnlyDispatchCount = () =>
      dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'panes/hydratePaneTitles').length

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount()).toBe(1)

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount(), 'an identical replay is deduped').toBe(1)

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: null }))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw }))
    expect(titleOnlyDispatchCount(), 'the removal event evicted the retained blob — the re-created key reprocesses').toBe(2)
  })

  it('hydrates browser-preference changes from storage events', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: remoteRaw,
    }))

    expect(store.getState().settings.localSettings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('hydrates browser-preference changes from BroadcastChannel messages', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      cleanups.push(installCrossTabSync(store as any))

      MockBC.instance?.onmessage?.({
        data: {
          type: 'persist',
          key: BROWSER_PREFERENCES_STORAGE_KEY,
          raw: JSON.stringify({
            settings: {
              theme: 'dark',
            },
            tabs: {
              searchRangeDays: 90,
            },
          }),
          sourceId: 'other-tab',
        },
      })

      expect(store.getState().settings.settings.theme).toBe('dark')
      expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  it('preserves authoritative remote sidebar collapse through a later unrelated local write', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      settings: {
        sidebar: {
          collapsed: true,
        },
      },
    })

    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, remoteRaw)

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: remoteRaw,
    }))

    expect(store.getState().settings.settings.sidebar.collapsed).toBe(true)

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          collapsed: true,
        },
      },
    })
  })

  it('ignores empty browser-preference writes for Redux local settings and search range', () => {
    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))
    store.dispatch(setTabRegistrySearchRangeDays(365))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({}),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('applies sparse browser-preference resets when previously persisted settings or search range are removed', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
      },
      tabs: {
        searchRangeDays: 365,
      },
    }))

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
    })))
    store.dispatch(setTabRegistrySearchRangeDays(365))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({}),
    }))

    expect(store.getState().settings.settings.theme).toBe('system')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)
  })

  it('merges tab recency sidecar events without rewriting layout or echoing the sidecar', () => {
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, tabRecency: tabRecencyReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch({
      ...hydrateTabs({
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Tab 1',
          status: 'running',
          mode: 'shell',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      } as any),
      meta: { skipPersist: true },
    })
    store.dispatch({
      ...hydratePanes({
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
          } as any,
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      } as any),
      meta: { skipPersist: true },
    })

    cleanups.push(installCrossTabSync(store as any))
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    window.dispatchEvent(new StorageEvent('storage', {
      key: TAB_RECENCY_STORAGE_KEY,
      newValue: JSON.stringify({
        version: 1,
        paneLastInputAt: {
          'pane-1': 1_740_000_059_999,
        },
      }),
    }))

    expect(store.getState().tabRecency.paneLastInputAt['pane-1']).toBe(1_740_000_000_000)
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).not.toHaveBeenCalledWith(OWN_LAYOUT_KEY, expect.any(String))
    expect(setItemSpy).not.toHaveBeenCalledWith(TAB_RECENCY_STORAGE_KEY, expect.any(String))
  })

  it('merges tab recency sidecars by max and persists pruned local terminal panes', () => {
    vi.useFakeTimers()
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, tabRecency: tabRecencyReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
            status: 'running',
            mode: 'shell',
            createdAt: 1,
          }],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
          tombstones: [],
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'split',
              id: 'root',
              direction: 'horizontal',
              sizes: [50, 50],
              children: [
                {
                  type: 'leaf',
                  id: 'pane-local',
                  content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' },
                },
                {
                  type: 'split',
                  id: 'right',
                  direction: 'vertical',
                  sizes: [50, 50],
                  children: [
                    {
                      type: 'leaf',
                      id: 'pane-shared',
                      content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shared', status: 'running' },
                    },
                    {
                      type: 'leaf',
                      id: 'pane-remote',
                      content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-remote', status: 'running' },
                    },
                  ],
                },
              ],
            } as any,
          },
          activePane: { 'tab-1': 'pane-local' },
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
        tabRecency: {
          paneLastInputAt: {
            'pane-local': 1_740_000_120_000,
            'pane-shared': 1_740_000_120_000,
          },
        },
      } as any,
    })

    cleanups.push(installCrossTabSync(store as any))
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    window.dispatchEvent(new StorageEvent('storage', {
      key: TAB_RECENCY_STORAGE_KEY,
      newValue: JSON.stringify({
        version: 1,
        paneLastInputAt: {
          'pane-shared': 1_740_000_000_000,
          'pane-remote': 1_740_000_060_000,
          'pane-stale': 1_740_000_180_000,
        },
      }),
    }))

    expect(store.getState().tabRecency.paneLastInputAt).toEqual({
      'pane-local': 1_740_000_120_000,
      'pane-remote': 1_740_000_060_000,
      'pane-shared': 1_740_000_120_000,
    })
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).not.toHaveBeenCalledWith(OWN_LAYOUT_KEY, expect.any(String))
    expect(JSON.parse(localStorage.getItem(TAB_RECENCY_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      paneLastInputAt: {
        'pane-local': 1_740_000_120_000,
        'pane-remote': 1_740_000_060_000,
        'pane-shared': 1_740_000_120_000,
      },
    })
  })

  it('merges remote browser-preference writes without clobbering dirty local settings', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({
        settings: {
          theme: 'system',
          sidebar: {
            sortMode: 'project',
          },
        },
        tabs: {
          searchRangeDays: 365,
        },
      }),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('merges remote browser-preference writes without treating resolved defaults from setLocalSettings as dirty', () => {
    vi.useFakeTimers()

    const store = configureStore({
      reducer: { settings: settingsReducer, tabRegistry: tabRegistryReducer },
      middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
    })

    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
    }, { floatingActionButtonDefault: true })))

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: JSON.stringify({
        settings: {
          theme: 'system',
          sidebar: {
            sortMode: 'project',
          },
        },
        tabs: {
          searchRangeDays: 365,
        },
      }),
    }))

    expect(store.getState().settings.settings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(30)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('preserves local terminalId when remote layout lacks it', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal has been created (has terminalId)
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote state arrives WITHOUT terminalId (stale data from before creation)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'creating',
              // NO terminalId
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))

    // Local terminalId should be preserved
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.terminalId).toBe('local-terminal-123')
    expect(content.status).toBe('running')
  })

  it('preserves local reconnection state when remote has stale createRequestId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal just regenerated createRequestId after INVALID_TERMINAL_ID
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-new',
            status: 'creating',
            // No terminalId — reconnecting
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote: stale state with old createRequestId and old terminalId
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-old',
              status: 'running',
              terminalId: 'stale-terminal-id',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))

    // Local reconnection state must be preserved — stale remote must not overwrite
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.createRequestId).toBe('req-new')
    expect(content.status).toBe('creating')
    expect(content.terminalId).toBeUndefined()
  })

  it('propagates exit state from an OWN-key flush (duplicate tab) even when local has terminalId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: terminal is running with terminalId
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    // Remote: terminal has exited (no terminalId, status: exited)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'exited',
              // NO terminalId — terminal exited
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    // Exit state should propagate — local should NOT keep stale terminalId
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.status).toBe('exited')
    expect(content.terminalId).toBeUndefined()
  })

  it('does not crash on a malformed OTHER-window pane layout (corrupted localStorage) — the title-only path ignores it', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: valid terminal pane
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            createRequestId: 'req-1',
            status: 'running',
            terminalId: 'local-terminal-123',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Local shell title' } },
      paneTitleSetByUser: { 'tab-1': { 'pane-1': true } },
    }))

    // Remote state: malformed split with missing children
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-bad',
            direction: 'horizontal',
            sizes: [50, 50],
            // children is missing entirely — corrupted data
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Remote broken title' } },
        paneTitleSetByUser: { 'tab-1': { 'pane-1': false } },
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))

    // Should not throw — malformed remote data is ignored and local state wins.
    expect(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: remoteRaw }))
    }).not.toThrow()

    expect(store.getState().panes.layouts['tab-1']).toEqual({
      type: 'leaf',
      id: 'pane-1',
      content: expect.objectContaining({
        kind: 'terminal',
        terminalId: 'local-terminal-123',
        createRequestId: 'req-1',
        status: 'running',
      }),
    })
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')
    expect(store.getState().panes.paneTitles['tab-1']).toEqual({ 'pane-1': 'Local shell title' })
    expect(store.getState().panes.paneTitleSetByUser['tab-1']).toEqual({ 'pane-1': true })
  })

  it('preserves local resumeSessionId when an OWN-key flush has a different session for the same createRequestId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    // Local state: Claude pane creating with SESSION_A
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'claude',
            createRequestId: 'req-1',
            status: 'creating',
            resumeSessionId: 'session-A',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    // Remote: same createRequestId but different resumeSessionId (from another tab)
    const remoteRaw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              terminalId: 'remote-terminal-456',
              resumeSessionId: 'session-B',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      tombstones: [],
    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    // Local resumeSessionId must NOT be overwritten by the incoming flush
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.resumeSessionId).toBe('session-A')
    // Other incoming fields (lifecycle progress) should still be accepted
    expect(content.terminalId).toBe('remote-terminal-456')
    expect(content.status).toBe('running')
  })

  it('does not permanently dedupe: an identical payload hydrates again once the SAME key\u2019s raw changed in between', () => {
    // Delta round 3: with per-window keys the dedupe map is per storage
    // key. The pinned property survives in the per-key idiom — this
    // window's own flush (a different key) can no longer re-arm ANOTHER
    // window's dedupe entry; only that key's own raw change does.
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw1 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: { 't1': { 'p1': 'Title one' } }, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw1 }))

    const raw2 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1 changed remotely', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: { 't1': { 'p1': 'Title two' } }, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw2 }))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: raw1 }))

    const titleOnlyCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'panes/hydratePaneTitles')
    expect(titleOnlyCalls).toHaveLength(3)
  })

  it('marks this window\u2019s own-key broadcast as processed without hydrating (the local flush path)', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    // persistMiddleware broadcasts the window's own flush; the in-process
    // listener records the raw in the dedupe map (a later identical
    // STORAGE event for the same key is deduped) and never hydrates.
    broadcastPersistedRaw(OWN_LAYOUT_KEY, raw)

    let hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(0)

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: raw }))
    hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(0)
  })

  it('hydrates both tabs and panes from a single OWN-key combined layout event (duplicate-tab flush)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    cleanups.push(installCrossTabSync(store as any))

    const layoutRaw = JSON.stringify({
      version: 3,
      tabs: {
        activeTabId: 't1',
        tabs: [
          { id: 't1', title: 'T1', mode: 'shell' },
          { id: 't2', title: 'T2', mode: 'shell' },
        ],
      },
      panes: {
        version: 6,
        layouts: {
          't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } },
          't2': { type: 'leaf', id: 'p2', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r2', status: 'running' } },
        },
        activePane: { 't1': 'p1', 't2': 'p2' },
        paneTitles: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: layoutRaw }))

    // Both tabs and panes should be hydrated from the single combined event
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts).toHaveProperty('t1')
    expect(store.getState().panes.layouts).toHaveProperty('t2')
  })

  it('rejects a stale OWN-key rebroadcast that would overwrite a newer canonical durable id', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const staleSessionRefId = '00000000-0000-4000-8000-000000000111'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 100,
        resumeSessionId: canonicalSessionId,
        sessionMetadataByKey: {
          [sessionMetadataKey('claude', canonicalSessionId)]: {
            sessionType: 'freshclaude',
            firstUserMessage: 'Continue locally',
          },
        },
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
            resumeSessionId: canonicalSessionId,
            sessionRef: {
              provider: 'claude',
              sessionId: canonicalSessionId,
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 100,
          resumeSessionId: canonicalSessionId,
          sessionMetadataByKey: {
            [sessionMetadataKey('claude', canonicalSessionId)]: {
              sessionType: 'freshclaude',
              firstUserMessage: 'Continue locally',
            },
          },
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: canonicalSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: canonicalSessionId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 150,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Remote stale title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 999,
          resumeSessionId: 'named-resume',
          sessionMetadataByKey: {
            [sessionMetadataKey('claude', 'named-resume')]: {
              sessionType: 'freshclaude',
              firstUserMessage: 'Remote stale resume',
            },
          },
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: 'named-resume',
              sessionRef: {
                provider: 'claude',
                sessionId: staleSessionRefId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
    expect(paneContent.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    expect(tab?.sessionMetadataByKey).toEqual(expect.objectContaining({
      [sessionMetadataKey('claude', canonicalSessionId)]: expect.objectContaining({
        sessionType: 'freshclaude',
      }),
    }))
    expect(tab?.sessionMetadataByKey).not.toHaveProperty(sessionMetadataKey('claude', 'named-resume'))
  })

  it('keeps newer local FreshClaude pane state when a stale OWN-key rebroadcast is canonicalized during hydration', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000654'
    const staleSessionRefId = '00000000-0000-4000-8000-000000000222'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 200,
        resumeSessionId: canonicalSessionId,
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: 'sdk-local-current',
            createRequestId: 'req-local-current',
            status: 'running',
            resumeSessionId: canonicalSessionId,
            sessionRef: {
              provider: 'claude',
              sessionId: canonicalSessionId,
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 200,
          resumeSessionId: canonicalSessionId,
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-local-current',
              createRequestId: 'req-local-current',
              status: 'running',
              resumeSessionId: canonicalSessionId,
              sessionRef: {
                provider: 'claude',
                sessionId: canonicalSessionId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 150,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Remote stale title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 150,
          resumeSessionId: 'named-resume',
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              sessionId: 'sdk-remote-stale',
              createRequestId: 'req-remote-stale',
              status: 'starting',
              resumeSessionId: 'named-resume',
              sessionRef: {
                provider: 'claude',
                sessionId: staleSessionRefId,
              },
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: OWN_LAYOUT_KEY, newValue: remoteRaw }))

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
    expect(paneContent.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })
    expect(paneContent.sessionId).toBe('sdk-local-current')
    expect(paneContent.createRequestId).toBe('req-local-current')
    expect(paneContent.status).toBe('running')
  })

  it('keeps comparing OWN-key hydration against the current authoritative local timestamp after a stale payload was already processed', () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000321'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{
        id: 'tab-1',
        createRequestId: 'tab-1',
        title: 'Local canonical title',
        status: 'running',
        mode: 'claude',
        createdAt: 1,
        updatedAt: 100,
        resumeSessionId: canonicalSessionId,
        sessionMetadataByKey: {
          [sessionMetadataKey('claude', canonicalSessionId)]: {
            sessionType: 'freshclaude',
            firstUserMessage: 'Continue locally',
          },
        },
      }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
      tombstones: [],
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
            resumeSessionId: canonicalSessionId,
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 200,
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Local canonical title',
          status: 'running',
          mode: 'claude',
          createdAt: 1,
          updatedAt: 100,
          resumeSessionId: canonicalSessionId,
        }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-1',
              status: 'idle',
              resumeSessionId: canonicalSessionId,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', {
      key: OWN_LAYOUT_KEY,
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 150,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Remote stale title 1',
            status: 'running',
            mode: 'claude',
            createdAt: 1,
            updatedAt: 999,
            resumeSessionId: 'named-resume',
          }],
        },
        panes: {
          version: 6,
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'fresh-agent',
                sessionType: 'freshclaude',
                provider: 'claude',
                createRequestId: 'req-1',
                status: 'idle',
                resumeSessionId: 'named-resume',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    let tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.title).toBe('Local canonical title')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: OWN_LAYOUT_KEY,
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 175,
        tabs: {
          activeTabId: 'tab-1',
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Remote stale title 2',
            status: 'running',
            mode: 'claude',
            createdAt: 1,
            updatedAt: 1000,
            resumeSessionId: 'named-resume',
          }],
        },
        panes: {
          version: 6,
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'fresh-agent',
                sessionType: 'freshclaude',
                provider: 'claude',
                createRequestId: 'req-1',
                status: 'idle',
                resumeSessionId: 'named-resume',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.title).toBe('Local canonical title')
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId: canonicalSessionId,
    })

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)
  })

  // Machine-stamp guard (delta review round 1, finding 1): the layout
  // storage key and broadcast channel are origin-wide, so a window on
  // another machine can hydrate its stamped layout into this page unless
  // the receiving page compares the stamp against its OWN selected
  // machine (persistMiddleware's selectStampMachineId source: store
  // slice first, remembered-selection fallback).
  function seedLocalTabsAndPanes(store: ReturnType<typeof configureStore>) {
    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-local',
          content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' },
        } as any,
      },
      activePane: { 'tab-1': 'pane-local' },
      paneTitles: {},
    }))
  }

  function stampedRemoteRaw(machineId: string | undefined, tabIds: string[] = ['t1', 't2', 't3']): string {
    return JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      ...(machineId !== undefined ? { machineId } : {}),
      tabs: {
        activeTabId: tabIds[tabIds.length - 1],
        tabs: tabIds.map((id, index) => ({ id, title: id.toUpperCase(), createdAt: index + 1 })),
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-remote',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-local', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-local', status: 'running' } },
              { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-b' },
        paneTitles: { 'tab-1': { 'pane-local': 'Stamped remote title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  function machineReadyAction(machineId: string) {
    return setMachineReady({
      machine: { id: machineId, label: machineId, createdAt: 1, lastSeenAt: 1 },
      mode: 'server-managed',
    })
  }

  it('delivers a matching machine-stamped OTHER-window layout\u2019s pane TITLES only — no tabs, no trees, no active pane (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['tab-1']?.id, 'the local leaf tree is not replaced by the remote split').toBe('pane-local')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  it('ignores a machine-stamped incoming layout from a different machine — no title delivery at all', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-OTHER') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect((store.getState().panes.layouts['tab-1'] as any)?.content?.createRequestId).toBe('req-local')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBeUndefined()
  })

  it('delivers an unstamped (legacy) OTHER-window layout\u2019s pane titles — the stamp guard never counts unstamped foreign', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReadyAction('machine-1'))
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw() }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id, 'no tree adoption cross-window').toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  it('ignores a machine-stamped incoming layout when the receiving page has no selected machine id at all', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBeUndefined()
  })

  it('guards by the remembered machine selection when the store slice has not resolved yet (getSelectedMachineId fallback)', () => {
    localStorage.setItem(MACHINE_ID_STORAGE_KEY, 'machine-1')
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalTabsAndPanes(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-1') }))
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: stampedRemoteRaw('machine-OTHER', ['t1', 't2', 't4']) }))
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['tab-1']?.id).toBe('pane-local')
    expect(store.getState().panes.paneTitles['tab-1']?.['pane-local']).toBe('Stamped remote title')
  })

  // ── Delta round 3, finding 1: the per-window prefix subscription ──
  //
  // The storage-event/broadcast subscription must observe the layout-key
  // PREFIX (freshell.layout.v3.<layoutWindowId>), not one exact key: events
  // from OTHER windows' per-window keys run the TITLE-ONLY path with ALL
  // its guards (machine-stamp guard first, persistedAt recency, user-set
  // precedence).
  it('delivers pane TITLES from ANOTHER window\u2019s per-window key (prefix subscription) without adopting its tabs', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{ id: 't1', title: 'T1', createdAt: 1 }],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: { 't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } } as any },
      activePane: { 't1': 'p1' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      tabs: { activeTabId: 't2', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }, { id: 't2', title: 'T2', createdAt: 2 }] },
      panes: {
        version: 6,
        layouts: { 't1': { type: 'leaf', id: 'p1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'r1', status: 'running' } } },
        activePane: {},
        paneTitles: { 't1': { 'p1': 'Title from other window' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.layout-window-9', newValue: remoteRaw }))

    expect(store.getState().panes.paneTitles['t1']?.['p1']).toBe('Title from other window')
    expect(store.getState().tabs.tabs.map((t) => t.id), 'the other window\u2019s t2 is not adopted').toEqual(['t1'])
  })

  it('ignores storage events for reserved layout-family keys (the .bak and the fresh-agent centralization backup/marker keys)', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.bak', newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.backup-before-fresh-agent-centralization', newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: `freshell.layout.v3.${OWN_WINDOW_ID}.bak`, newValue: raw }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3', newValue: raw }))

    const layoutDispatches = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs' || a?.type === 'panes/hydratePanes' || a?.type === 'panes/hydratePaneTitles')
    expect(layoutDispatches).toHaveLength(0)
  })

  it('filters own-key writes on the broadcast channel path but keeps marking them processed', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    const original = (globalThis as any).BroadcastChannel
    class MockBC {
      static instance: MockBC | null = null
      onmessage: ((ev: any) => void) | null = null
      constructor(_name: string) {
        MockBC.instance = this
      }
      close() {}
    }
    ;(globalThis as any).BroadcastChannel = MockBC

    try {
      cleanups.push(installCrossTabSync(storeLike as any))

      const raw = JSON.stringify({
        version: 3,
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      })
      // A cross-source broadcast carrying OUR OWN key must not hydrate (the
      // own key is only ever this window's envelope; production never sees
      // this shape, the filter is defensive).
      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: OWN_LAYOUT_KEY, raw, sourceId: 'other-source' } })

      const hydrateCalls = dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'tabs/hydrateTabs' || a?.type === 'panes/hydratePaneTitles')
      expect(hydrateCalls).toHaveLength(0)
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
  })

  // Delta round 3, finding 2 (belt-and-braces): slices rehydrate at module
  // init; cross-tab sync installs only at machine-ready. If the window's OWN
  // envelope raw changed between module-load and install (possible only from
  // the migration or same-window writers — with per-window keys, cross-window
  // replacement is impossible), install must process the change as an
  // incoming hydrate event instead of silently marking it processed.
  it('hydrates at install when the own envelope was replaced between module-load and sync install', async () => {
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, 'client-stale-install')
    const ownKey = 'freshell.layout.v3.client-stale-install'
    // persistedAt must be real-clock-fresh: the fresh module realm below
    // re-runs the self-executing storage migration (pulled in through the
    // persistMiddleware import chain), whose stale-envelope prune sweep
    // (e3r1 finding 5) would remove a 1970-era fixture envelope before
    // the module-init loaders can read it.
    const stampBase = Date.now()
    const envelopeX = JSON.stringify({
      persistedAt: stampBase,
      version: 3,
      tabs: { activeTabId: 'tab-load-time', tabs: [{ id: 'tab-load-time', title: 'Loaded at module init', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    const envelopeY = JSON.stringify({
      persistedAt: stampBase + 1_000,
      version: 3,
      tabs: { activeTabId: 'tab-replacement', tabs: [{ id: 'tab-replacement', title: 'Replaced before install', createdAt: 2 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    localStorage.setItem(ownKey, envelopeX)
    // The module-init loaders of the pre-change code read the bare legacy
    // key — seed it too so the RED failure isolates the staleness behavior
    // (the loaders DID see X) rather than the key naming.
    localStorage.setItem('freshell.layout.v3', envelopeX)

    vi.resetModules()
    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: freshTabsReducer } = await import('@/store/tabsSlice')
    const { default: freshPanesReducer } = await import('@/store/panesSlice')
    const { installCrossTabSync: freshInstallCrossTabSync } = await import('@/store/crossTabSync')
    const { resetPersistFlushListenersForTests: freshResetFlushListeners } = await import('@/store/persistMiddleware')
    freshResetFlushListeners()

    const store = freshConfigureStore({
      reducer: { tabs: freshTabsReducer, panes: freshPanesReducer },
    })
    // The module-init rehydration loaded X (through whichever key the
    // CURRENT code reads).
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-load-time'])

    // The envelope is replaced AFTER module-load, BEFORE sync install.
    localStorage.setItem(ownKey, envelopeY)

    const cleanup = freshInstallCrossTabSync(store as any)
    cleanups.push(cleanup)

    // NOT silently marked processed: the replacement HYDRATED at install —
    // the incoming-hydrate path is the existing MERGE (hydrateTabs unions
    // by tab id with the recency/reconcile guards), so the replacement's
    // tab lands in state; a silent mark would have left ONLY the loaded X.
    const tabs = store.getState().tabs.tabs
    expect(tabs.map((t) => t.id)).toContain('tab-replacement')
    expect(tabs.find((t) => t.id === 'tab-replacement')?.title).toBe('Replaced before install')
  })

  // ── e3r1 finding 4: cross-window events are TITLE-ONLY ──
  //
  // Another window's normal flush must never add/reorder this window's
  // tabs, replace pane trees/content, move the active pane, or clear
  // ephemeral pane state (zoom) — the approved divergence tradeoff says
  // two windows on the same machine may keep divergent arrangements
  // indefinitely. Only the Task-7 pane-title reconciliation (recency +
  // user-set rules, hydrate-pane-metadata-merge.ts) applies, for panes
  // that exist in BOTH envelopes.

  function seedLocalWorkspace(store: ReturnType<typeof configureStore>): void {
    store.dispatch(hydrateTabs({
      tabs: [
        { id: 't1', title: 'T1', createdAt: 1 },
        { id: 't2', title: 'T2', createdAt: 2 },
      ],
      activeTabId: 't1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        't1': {
          type: 'split',
          id: 'split-local',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
            { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://local.example', devToolsOpen: false } },
          ],
        } as any,
      },
      activePane: { 't1': 'pane-a' },
      paneTitles: { 't1': { 'pane-a': 'Local title' } },
      paneTitleSetByUser: {},
    }))
    store.dispatch({ type: 'panes/toggleZoom', payload: { tabId: 't1', paneId: 'pane-b' } })
  }

  function newerRemoteFullLayoutRaw(persistedAt: number): string {
    return JSON.stringify({
      version: 3,
      persistedAt,
      tabs: {
        activeTabId: 't3',
        tabs: [
          { id: 't3', title: 'T3', createdAt: 3 },
          { id: 't1', title: 'T1 remote', createdAt: 1 },
        ],
      },
      panes: {
        version: 6,
        layouts: {
          't1': {
            type: 'split',
            id: 'split-remote',
            direction: 'vertical',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-remote', status: 'running', terminalId: 'term-remote' } },
              { type: 'leaf', id: 'pane-remote-only', content: { kind: 'browser', url: 'https://remote.example', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 't1': 'pane-remote-only' },
        paneTitles: { 't1': { 'pane-a': 'Remote newer title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  it('does NOT adopt another window\u2019s NEWER full-layout flush: no tabs added/reordered, no pane tree replaced, zoom and focus stay local', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))
    const zoomBefore = store.getState().panes.zoomedPane['t1']

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().tabs.tabs.map((t) => t.id), 'no remote tab added or reorder').toEqual(['t1', 't2'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
    expect(store.getState().panes.layouts['t1']?.id, 'the local tree is not replaced').toBe('split-local')
    expect((store.getState().panes.layouts['t1'] as any).children.map((c: any) => c.id)).toEqual(['pane-a', 'pane-b'])
    expect((store.getState().panes.layouts['t1'] as any).children[0].content.createRequestId, 'the local terminal content is not replaced').toBe('req-a')
    expect(store.getState().panes.activePane['t1']).toBe('pane-a')
    expect(store.getState().panes.zoomedPane['t1'], 'another window\u2019s flush does not clear this window\u2019s zoom').toBe(zoomBefore)
    expect(store.getState().panes.zoomedPane['t1']).toBe('pane-b')
  })

  it('applies another window\u2019s NEWER pane titles to matching panes per the Task-7 rules (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the newer remote title applies to the shared pane').toBe('Remote newer title')
    expect(store.getState().panes.paneTitleSetByUser['t1']?.['pane-a'] ?? false).toBeFalsy()
    expect(store.getState().panes.paneTitles['t1']?.['pane-b'], 'panes not carried by the remote envelope keep their local titles').toBeUndefined()
    expect(store.getState().panes.paneTitles['t1']?.['pane-remote-only'], 'titles for panes that do not exist locally never land').toBeUndefined()
  })

  it('does not apply another window\u2019s OLDER pane titles (recency guard on the title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    // The receiver's own envelope stamp (2_000) is what the recency
    // comparison uses as the local side; seed it BEFORE install so the
    // dedupe seeding captures it as currentLocalLayoutPersistedAt.
    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 2_000,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }, { id: 't2', title: 'T2', createdAt: 2 }] },
      panes: {
        version: 6,
        layouts: {},
        activePane: {},
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(1_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'an older remote title never overwrites').toBe('Local title')
  })

  it('e3r4 finding 3: a foreign no-op flush never raises the recency floor — a different window\u2019s strictly-newer title still applies (the reviewer\u2019s exact ordering)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    // The receiver's own durable envelope: persistedAt 100 is what install
    // seeds the recency floor from.
    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 100,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          't1': {
            type: 'leaf',
            id: 'pane-a',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' },
          },
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    // Window W1 (another window) flushes a NO-OP envelope at 300: it
    // shares no panes with the receiver and delivers no titles — but its
    // parse used to advance the recency floor to 300 anyway.
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w1',
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 300,
        tabs: { activeTabId: 't9', tabs: [{ id: 't9', title: 'T9', createdAt: 9 }] },
        panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
        tombstones: [],
      }),
    }))

    // Window W2 (a different window) delivers a title at 200 — not newer
    // than W1's 300, but strictly newer than the receiver's OWN envelope
    // (100), so it must apply. Deliveries from independent windows have no
    // cross-source total ordering, so only the receiver's own envelope may
    // set the floor.
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w2',
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 200,
        tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: {
          version: 6,
          layouts: {
            't1': {
              type: 'leaf',
              id: 'pane-a',
              content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' },
            },
          },
          activePane: { 't1': 'pane-a' },
          paneTitles: { 't1': { 'pane-a': 'Title from window two' } },
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the strictly-newer-than-local title applies — the foreign no-op never moved the floor').toBe('Title from window two')
  })

  it('delta r4 finding 2: an APPLIED foreign title-only event advances the recency floor immediately — another window\u2019s older pre-flush title is rejected (the reviewer\u2019s exact ordering)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    // The receiver's own durable envelope: persistedAt 100 is what install
    // seeds the recency floor from.
    localStorage.setItem(OWN_LAYOUT_KEY, JSON.stringify({
      version: 3,
      persistedAt: 100,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          't1': {
            type: 'leaf',
            id: 'pane-a',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' },
          },
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    cleanups.push(installCrossTabSync(store as any))

    // Window W1 delivers a title at 300 — strictly newer than the floor
    // (100) — and it APPLIES (the shared pane adopts W1's title). The
    // floor must advance to 300 IMMEDIATELY: the receiver's debounced
    // (~500ms) persistence flush is too late to guard the window where a
    // second window's OLDER title is still newer than the stale floor.
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w1',
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 300,
        tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: {
          version: 6,
          layouts: {
            't1': {
              type: 'leaf',
              id: 'pane-a',
              content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' },
            },
          },
          activePane: { 't1': 'pane-a' },
          paneTitles: { 't1': { 'pane-a': 'Title from window one' } },
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the strictly-newer title applies').toBe('Title from window one')

    // Window W2's OLDER title (200) arrives PRE-FLUSH: against the
    // unchanged floor (100) it would apply and overwrite W1's newer
    // title — the regression the reviewer found, which the flush then
    // makes durable. Against the advanced floor (300) it is rejected.
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w2',
      newValue: JSON.stringify({
        version: 3,
        persistedAt: 200,
        tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
        panes: {
          version: 6,
          layouts: {
            't1': {
              type: 'leaf',
              id: 'pane-a',
              content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' },
            },
          },
          activePane: { 't1': 'pane-a' },
          paneTitles: { 't1': { 'pane-a': 'Title from window two' } },
          paneTitleSetByUser: {},
        },
        tombstones: [],
      }),
    }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the older pre-flush title is rejected against the floor the APPLIED event advanced').toBe('Title from window one')
  })

  it('keeps user-set pane titles against another window\u2019s NEWER flush (title-only path)', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)
    store.dispatch({
      type: 'panes/updatePaneTitle',
      payload: { tabId: 't1', paneId: 'pane-a', title: 'User keeps this', setByUser: true },
    })

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('User keeps this')
    expect(store.getState().panes.paneTitleSetByUser['t1']?.['pane-a']).toBe(true)
  })

  it('the divergence pin: successive other-window flushes never move this window\u2019s arrangement', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)

    cleanups.push(installCrossTabSync(store as any))

    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(2_000) }))
    window.dispatchEvent(new StorageEvent('storage', { key: REMOTE_LAYOUT_KEY, newValue: newerRemoteFullLayoutRaw(3_000) }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts['t1']?.id).toBe('split-local')
    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('Remote newer title')
  })

  // ── e3r3 finding 1: DURABLE cross-window title reconciliation ──
  //
  // The title-only dispatch used to carry skipPersist: the receiver's
  // Redux state adopted the title, but its sovereign per-window envelope
  // kept the OLD one — a refresh before any unrelated mutation caused a
  // flush lost the received title (including a user-set one). The apply
  // must be durable (the receiver flushes its OWN envelope), and the
  // write must converge instead of echoing: the merge is a reducer-level
  // no-op when it produces exactly the titles the state already holds,
  // so a receiver that already has the title neither changes state nor
  // re-flushes, and the per-key raw dedupe drops repeat deliveries of
  // the same envelope bytes. One flush per real title change, zero for
  // equal ones.

  /** Another window's NEWER flush carrying a USER-SET title for the
   * shared pane (unstamped — legacy incoming never counts foreign). */
  function remoteUserSetTitleRaw(persistedAt: number): string {
    return JSON.stringify({
      version: 3,
      persistedAt,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          't1': {
            type: 'split',
            id: 'split-remote',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-remote', status: 'running' } },
              { type: 'leaf', id: 'pane-remote-only', content: { kind: 'browser', url: 'https://remote.example', devToolsOpen: false } },
            ],
          },
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: { 't1': { 'pane-a': 'User title from window A' } },
        paneTitleSetByUser: { 't1': { 'pane-a': true } },
      },
      tombstones: [],
    })
  }

  function configureDurableReceiverStore() {
    return configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })
  }

  it('e3r3 (a): a received cross-window pane title (and its user-set flag) lands in the receiver\u2019s OWN envelope through the debounce — durable before any unrelated mutation', async () => {
    vi.useFakeTimers()
    const store = configureDurableReceiverStore()
    seedLocalWorkspace(store)
    cleanups.push(installCrossTabSync(store as any))

    // Settle the seed's own flush FIRST: the reviewer's case is a
    // receiver with NO pending flush when the cross-window title arrives
    // (otherwise the seed's own flush would write the envelope and mask
    // the defect).
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    const seedRaw = localStorage.getItem(OWN_LAYOUT_KEY)
    expect(seedRaw, 'the seed flush wrote the receiver\u2019s envelope').toBeTruthy()

    window.dispatchEvent(new StorageEvent('storage', {
      key: REMOTE_LAYOUT_KEY,
      newValue: remoteUserSetTitleRaw(Date.now() + 1_000),
    }))

    // Positive control: the receiver's Redux state adopted title + flag.
    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('User title from window A')
    expect(store.getState().panes.paneTitleSetByUser['t1']?.['pane-a']).toBe(true)

    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)

    const raw = localStorage.getItem(OWN_LAYOUT_KEY)
    expect(raw, 'the reconciliation caused a NEW flush of the receiver\u2019s envelope').not.toBe(seedRaw)
    const env = JSON.parse(raw!)
    expect(env.panes.paneTitles['t1']?.['pane-a'], 'the received title is durable in the receiver\u2019s envelope').toBe('User title from window A')
    expect(env.panes.paneTitleSetByUser['t1']?.['pane-a'], 'the received user-set flag is durable too').toBe(true)
  })

  it('e3r3 (b): the reviewer\u2019s exact durability case — a receiver that reloads after the cross-window title arrives boots WITH the title (fresh boot from its own envelope)', async () => {
    vi.useFakeTimers()
    const store = configureDurableReceiverStore()
    seedLocalWorkspace(store)
    cleanups.push(installCrossTabSync(store as any))

    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    window.dispatchEvent(new StorageEvent('storage', {
      key: REMOTE_LAYOUT_KEY,
      newValue: remoteUserSetTitleRaw(Date.now() + 1_000),
    }))
    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('User title from window A')

    // The durable reconciliation flush (debounce), before ANY unrelated
    // mutation.
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    const durableRaw = localStorage.getItem(OWN_LAYOUT_KEY)
    expect(JSON.parse(durableRaw!).panes.paneTitles['t1']['pane-a']).toBe('User title from window A')

    // A fresh boot: the fresh module realm re-runs the module-init
    // loaders against the receiver's own envelope (sessionStorage still
    // holds the same layout-window id).
    vi.resetModules()
    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: freshTabsReducer } = await import('@/store/tabsSlice')
    const { default: freshPanesReducer } = await import('@/store/panesSlice')
    const reloaded = freshConfigureStore({
      reducer: { tabs: freshTabsReducer, panes: freshPanesReducer },
    })
    expect(reloaded.getState().panes.paneTitles['t1']?.['pane-a'], 'the received title survives the healthy reload').toBe('User title from window A')
    expect(reloaded.getState().panes.paneTitleSetByUser['t1']?.['pane-a'], 'the received user-set flag survives the healthy reload').toBe(true)
  })

  it('e3r3 (c): the convergence pin — a title flowing A→B flushes B\u2019s own envelope exactly once; B\u2019s flush reaching A applies NOTHING (equal-title guard) and flush counts settle', async () => {
    vi.useFakeTimers()
    const WIN_A_ID = 'client-crosstab-conv-a'
    const WIN_A_KEY = `freshell.layout.v3.${WIN_A_ID}`
    const WIN_B_ID = 'client-crosstab-conv-b'
    const WIN_B_KEY = `freshell.layout.v3.${WIN_B_ID}`

    const seedSharedPane = (store: ReturnType<typeof configureStore>, title?: string) => {
      store.dispatch(hydrateTabs({
        tabs: [{ id: 't1', title: 'T1', createdAt: 1 }],
        activeTabId: 't1',
        renameRequestTabId: null,
      }))
      store.dispatch(hydratePanes({
        layouts: {
          't1': {
            type: 'leaf',
            id: 'pane-a',
            content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shared', status: 'running' },
          } as any,
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: title ? { 't1': { 'pane-a': title } } : {},
      }))
    }

    // Window B first: same shared pane, NO title. Its seed flush happens
    // before any sync is installed (no dedupe marking anywhere).
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, WIN_B_ID)
    const storeB = configureDurableReceiverStore()
    seedSharedPane(storeB)
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    const rawB0 = localStorage.getItem(WIN_B_KEY)
    expect(JSON.parse(rawB0!).panes.paneTitles['t1']?.['pane-a']).toBeUndefined()

    // Window A: the shared pane WITH the title; flushes while no sync is
    // installed either, so its raw is not pre-marked on B.
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, WIN_A_ID)
    const storeA = configureDurableReceiverStore()
    seedSharedPane(storeA, 'Shared title')
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    const rawA0 = localStorage.getItem(WIN_A_KEY)
    expect(JSON.parse(rawA0!).panes.paneTitles['t1']['pane-a']).toBe('Shared title')

    // B boots its sync (marking only its OWN envelope raw), then receives
    // A's raw through a storage event on A's per-window key: title-only,
    // A's envelope is strictly newer than B's → the title applies.
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, WIN_B_ID)
    cleanups.push(installCrossTabSync(storeB as any))
    window.dispatchEvent(new StorageEvent('storage', { key: WIN_A_KEY, newValue: rawA0 }))
    expect(storeB.getState().panes.paneTitles['t1']?.['pane-a'], 'B adopted the title').toBe('Shared title')

    // The DURABLE reconciliation flush: B writes its OWN envelope exactly
    // once (the debounce, under B's window id).
    await vi.advanceTimersByTimeAsync(PERSIST_DEBOUNCE_MS + 100)
    const rawB1 = localStorage.getItem(WIN_B_KEY)
    expect(rawB1, 'B flushed its envelope over the received title').not.toBe(rawB0)
    expect(JSON.parse(rawB1!).panes.paneTitles['t1']['pane-a'], 'B\u2019s envelope now durably carries the title').toBe('Shared title')

    // A boots its sync and receives B's raw. A already has the title, so
    // the merge must be a NO-OP: same panes state reference (no persist
    // dirty flag, no flush scheduled) — the feedback loop's convergence.
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, WIN_A_ID)
    cleanups.push(installCrossTabSync(storeA as any))
    const panesABefore = storeA.getState().panes
    window.dispatchEvent(new StorageEvent('storage', { key: WIN_B_KEY, newValue: rawB1 }))
    expect(storeA.getState().panes.paneTitles['t1']['pane-a']).toBe('Shared title')
    expect(storeA.getState().panes).toBe(panesABefore)

    // Flush counts settle: a long quiet window produces NO further
    // envelope writes on either side (byte-identity — every flush stamps
    // a new persistedAt, so any flush would change the bytes).
    await vi.advanceTimersByTimeAsync(5 * PERSIST_DEBOUNCE_MS)
    expect(localStorage.getItem(WIN_A_KEY), 'A never re-flushes over an equal title').toBe(rawA0)
    expect(localStorage.getItem(WIN_B_KEY), 'B does not flush again').toBe(rawB1)

    // Per-key dedupe: re-delivering the SAME raw settles identically.
    window.dispatchEvent(new StorageEvent('storage', { key: WIN_B_KEY, newValue: rawB1 }))
    await vi.advanceTimersByTimeAsync(5 * PERSIST_DEBOUNCE_MS)
    expect(localStorage.getItem(WIN_A_KEY), 'the deduped repeat delivery flushes nothing').toBe(rawA0)
  })

  it('e3r3: hydratePaneTitles is a reducer-level no-op (same state reference) when the merged result equals the current titles — the churn guard the durable write\u2019s convergence relies on', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    seedLocalWorkspace(store)
    const before = store.getState().panes

    store.dispatch({
      ...hydratePaneTitles({
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
        layouts: {
          't1': {
            type: 'split',
            id: 'split-local',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
              { type: 'leaf', id: 'pane-b', content: { kind: 'browser', url: 'https://local.example', devToolsOpen: false } },
            ],
          } as any,
        },
      }),
      meta: { source: 'cross-tab', localLayoutPersistedAt: 1_000, remoteLayoutPersistedAt: 2_000 },
    })

    expect(store.getState().panes).toBe(before)
  })

  // ── delta r5 finding 2: post-remint own-key staleness ──
  //
  // installCrossTabSync captures its ownLayoutKey once at install, but the
  // tab-registry lease-collision rotation can remint the layout-window id
  // mid-session (tabRegistrySync.rotateClientInstanceIdAfterCollision →
  // window-layout-keys remintLayoutWindowId — a duplicated tab keeps the
  // OLD id, the duplicate remints to a fresh one). handleIncomingRaw
  // already resolves the key dynamically, so an OLD-key event after a
  // remint is title-only there — but the floor-advance/classification
  // lines used the captured key: a post-remint OLD-key event was still
  // classified as the receiver's own key, advancing the recency floor even
  // on a no-op and letting it reject another window's strictly-newer
  // title delivery. These tests use a fresh module realm because the
  // remint's in-memory id is sticky for the realm's lifetime and must not
  // leak into the shared module instances the other tests use.
  async function installRemintedSyncFixture(): Promise<{ store: any; oldKey: string }> {
    const OLD_WINDOW_ID = 'client-remint-routing'
    const OLD_KEY = `freshell.layout.v3.${OLD_WINDOW_ID}`
    sessionStorage.setItem(LAYOUT_WINDOW_ID_STORAGE_KEY, OLD_WINDOW_ID)
    localStorage.setItem(OLD_KEY, JSON.stringify({
      version: 3,
      persistedAt: 100,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          't1': { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: { 't1': { 'pane-a': 'Local title' } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    }))

    vi.resetModules()
    const { configureStore: freshConfigureStore } = await import('@reduxjs/toolkit')
    const { default: freshTabsReducer } = await import('@/store/tabsSlice')
    const { default: freshPanesReducer } = await import('@/store/panesSlice')
    const { installCrossTabSync: freshInstallCrossTabSync } = await import('@/store/crossTabSync')
    const { remintLayoutWindowId } = await import('@/store/window-layout-keys')

    const store = freshConfigureStore({
      reducer: { tabs: freshTabsReducer, panes: freshPanesReducer },
    })
    expect(store.getState().tabs.tabs.map((t: any) => t.id), 'the module-init loaders read the OLD-key envelope').toEqual(['t1'])
    cleanups.push(freshInstallCrossTabSync(store as any))
    remintLayoutWindowId()
    return { store, oldKey: OLD_KEY }
  }

  function oldKeyEventRaw(persistedAt: number, options: { sharedPaneTitle?: string } = {}): string {
    const layouts = options.sharedPaneTitle === undefined
      ? {}
      : {
        't1': { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
      }
    return JSON.stringify({
      version: 3,
      persistedAt,
      tabs: { activeTabId: 't9', tabs: [{ id: 't9', title: 'T9', createdAt: 9 }] },
      panes: {
        version: 6,
        layouts,
        activePane: {},
        paneTitles: options.sharedPaneTitle === undefined ? {} : { 't1': { 'pane-a': options.sharedPaneTitle } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  function windowTwoTitleRaw(persistedAt: number, title: string): string {
    return JSON.stringify({
      version: 3,
      persistedAt,
      tabs: { activeTabId: 't1', tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          't1': { type: 'leaf', id: 'pane-a', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-a', status: 'running' } },
        },
        activePane: { 't1': 'pane-a' },
        paneTitles: { 't1': { 'pane-a': title } },
        paneTitleSetByUser: {},
      },
      tombstones: [],
    })
  }

  it('delta r5 finding 2: after a remint, an OLD-key NO-OP event never advances the recency floor — a strictly-newer other-window title still applies', async () => {
    const { store, oldKey } = await installRemintedSyncFixture()

    // The OLD shared key's event shares no panes and delivers no titles —
    // a no-op at a HIGHER stamp (300). Post-remint it is a FOREIGN
    // window's event and must not move the floor.
    window.dispatchEvent(new StorageEvent('storage', { key: oldKey, newValue: oldKeyEventRaw(300) }))

    // Window W2's title at 200 is not newer than the no-op's 300, but it
    // IS strictly newer than the receiver's own envelope (100) — with the
    // floor unmoved it must apply.
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w2',
      newValue: windowTwoTitleRaw(200, 'Title from window two'),
    }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the old-key no-op never moved the floor').toBe('Title from window two')
  })

  it('delta r5 finding 2: after a remint, an APPLIED old-key title event advances the floor immediately — another window\u2019s older pre-flush title is rejected (the delta r4 rule travels with the foreign classification)', async () => {
    const { store, oldKey } = await installRemintedSyncFixture()

    window.dispatchEvent(new StorageEvent('storage', {
      key: oldKey,
      newValue: oldKeyEventRaw(300, { sharedPaneTitle: 'Title from old shared key' }),
    }))
    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the strictly-newer old-key title applies title-only').toBe('Title from old shared key')

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-w2',
      newValue: windowTwoTitleRaw(200, 'Title from window two'),
    }))

    expect(store.getState().panes.paneTitles['t1']?.['pane-a'], 'the older pre-flush title is rejected against the floor the APPLIED event advanced').toBe('Title from old shared key')
  })

  it('delta r5 finding 2: after a remint, an OLD-key event never full-hydrates — no tabs or pane trees are adopted from the pre-rotation shared key', async () => {
    const { store, oldKey } = await installRemintedSyncFixture()

    window.dispatchEvent(new StorageEvent('storage', {
      key: oldKey,
      newValue: oldKeyEventRaw(300, { sharedPaneTitle: 'Title from old shared key' }),
    }))

    expect(store.getState().tabs.tabs.map((t: any) => t.id), 'the old key no longer adopts the other window\u2019s tabs').toEqual(['t1'])
    expect((store.getState().panes.layouts['t1'] as any)?.id, 'the local pane tree is not replaced').toBe('pane-a')
    expect(store.getState().panes.paneTitles['t1']?.['pane-a']).toBe('Title from old shared key')
  })
})

describe('crossTabSync — unified agent names (Task 6)', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function machineReady(machineId: string) {
    return setMachineReady({
      machine: { id: machineId, label: machineId, createdAt: 1, lastSeenAt: 1 },
      mode: 'server-managed',
    })
  }

  // ── Unified agent names (Task 6): stable ownership across mirrors ──
  //
  // "Hydration/mirror accepts relationships and projections, never name
  // writes. An old mirror without nameSource cannot erase an initialized
  // server pointer" — the hydrateTabs merge keeps an established pointer
  // when the winning side's tab record predates the field.
  it('keeps a hydrated tab nameSource through the OWN-key hydrateTabs merge', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    cleanups.push(installCrossTabSync(store as any))

    store.dispatch(hydrateTabs({
      tabs: [
        {
          id: 't-owned',
          title: 'Owned',
          createdAt: 1,
          nameSource: { kind: 'session', paneId: 'p-agent' },
        },
      ],
      activeTabId: 't-owned',
      renameRequestTabId: null,
    }))

    expect(store.getState().tabs.tabs[0].nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })
  })

  it('an old mirror without nameSource cannot erase an initialized pointer', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })
    cleanups.push(installCrossTabSync(store as any))

    // The local tab already resolved ownership (server-initialized pointer).
    store.dispatch(hydrateTabs({
      tabs: [
        {
          id: 't-owned',
          title: 'Owned',
          createdAt: 1,
          updatedAt: 1,
          nameSource: { kind: 'session', paneId: 'p-agent' },
        },
      ],
      activeTabId: 't-owned',
      renameRequestTabId: null,
    }))

    // A NEWER mirror from a pre-Task-6 window wins on recency but carries no
    // pointer field at all.
    store.dispatch({
      ...hydrateTabs({
        tabs: [{ id: 't-owned', title: 'Owned newer', createdAt: 1, updatedAt: 99 }],
        activeTabId: 't-owned',
        renameRequestTabId: null,
      }),
      meta: {
        skipPersist: true,
        source: 'cross-tab',
        localLayoutPersistedAt: 1,
        remoteLayoutPersistedAt: 2,
      },
    })

    const merged = store.getState().tabs.tabs[0]
    expect(merged.title).toBe('Owned newer')
    expect(merged.nameSource).toEqual({ kind: 'session', paneId: 'p-agent' })
  })

  it('stale foreign-window title flags cannot freeze a scoped pane; legacy pane flags still work', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(machineReady('machine-1'))
    // Local layout: one scoped agent pane and one shell pane in tab-1.
    store.dispatch(hydrateTabs({
      tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-local',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'p-agent',
              content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' },
            },
            {
              type: 'leaf',
              id: 'p-shell',
              content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell', status: 'running' },
            },
          ],
        } as any,
      },
      activePane: { 'tab-1': 'p-agent' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    // A foreign window's envelope carries a stale user-set flag + old title
    // for the SCOPED pane (a pre-Task-5 rename) and a legitimate user-set
    // title for the shell pane.
    const foreignRaw = JSON.stringify({
      version: 3,
      persistedAt: 5_000,
      machineId: 'machine-1',
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }],
      },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-local',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              { type: 'leaf', id: 'p-agent', content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' } },
              { type: 'leaf', id: 'p-shell', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-shell', status: 'running' } },
            ],
          },
        },
        activePane: {},
        paneTitles: { 'tab-1': { 'p-agent': 'Stale scoped title', 'p-shell': 'Pinned shell' } },
        paneTitleSetByUser: { 'tab-1': { 'p-agent': true, 'p-shell': true } },
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', { key: 'freshell.layout.v3.layout-window-stale-flags', newValue: foreignRaw }))

    // The scoped pane did NOT adopt the stale user-set freeze…
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['p-agent']).toBeUndefined()
    expect(store.getState().panes.paneTitles['tab-1']?.['p-agent']).toBeUndefined()
    // …while the legacy shell pane's user-set flag still works verbatim.
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['p-shell']).toBe(true)
    expect(store.getState().panes.paneTitles['tab-1']?.['p-shell']).toBe('Pinned shell')
  })
})

// ── unified agent names (Task 7) ─────────────────────────────────────────────

describe('crossTabSync — unified agent names (Task 7)', () => {
  const task7Cleanups: Array<() => void> = []
  afterEach(() => {
    while (task7Cleanups.length > 0) {
      task7Cleanups.pop()!()
    }
  })

  it('captures an old foreign-window envelope as immutable legacy evidence BEFORE the sanitized hydrate runs', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(setMachineReady({
      machine: { id: 'machine-1', label: 'machine-1', createdAt: 1, lastSeenAt: 1 },
      mode: 'server-managed',
    }))
    store.dispatch(hydrateTabs({
      tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
    }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'p-agent',
          content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' },
        } as any,
      },
      activePane: { 'tab-1': 'p-agent' },
      paneTitles: {},
    }))

    task7Cleanups.push(installCrossTabSync(store as any))

    const foreignRaw = JSON.stringify({
      version: 3,
      persistedAt: 5_000,
      machineId: 'machine-1',
      tabs: { activeTabId: 'tab-1', tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'p-agent',
            content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' },
          },
        },
        activePane: {},
        paneTitles: { 'tab-1': { 'p-agent': 'Old Pre-Change Rename' } },
        paneTitleSetByUser: { 'tab-1': { 'p-agent': true } },
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-task7-capture',
      newValue: foreignRaw,
    }))

    // The sanitized hydrate dropped the scoped alias…
    expect(store.getState().panes.paneTitles['tab-1']?.['p-agent']).toBeUndefined()
    // …and the raw bytes were preserved as immutable legacy-name evidence
    // (captured BEFORE the dispatch — the capture is what keeps the label
    // recoverable for the consolidation import).
    const envelopes = listCapturedMigrationEnvelopes(localStorage)
    const captured = envelopes.find(
      (envelope) => envelope.storageKey === 'freshell.layout.v3.layout-window-task7-capture',
    )
    expect(captured).toBeTruthy()
    expect(captured?.raw).toBe(foreignRaw)
  })

  it('drops a LOCAL scoped pane alias on the title-only path — an unacknowledged old label never stays an active override', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer, machineIdentity: machineIdentityReducer },
    })
    store.dispatch(setMachineReady({
      machine: { id: 'machine-1', label: 'machine-1', createdAt: 1, lastSeenAt: 1 },
      mode: 'server-managed',
    }))
    store.dispatch(hydrateTabs({
      tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
    }))
    // The LOCAL state still carries a scoped pane's pre-Task-5 alias.
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'p-agent',
          content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' },
        } as any,
      },
      activePane: { 'tab-1': 'p-agent' },
      paneTitles: { 'tab-1': { 'p-agent': 'Local Scoped Alias' } },
      paneTitleSetByUser: { 'tab-1': { 'p-agent': true } },
    }))

    task7Cleanups.push(installCrossTabSync(store as any))

    const foreignRaw = JSON.stringify({
      version: 3,
      persistedAt: 9_000,
      machineId: 'machine-1',
      tabs: { activeTabId: 'tab-1', tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1 }] },
      panes: {
        version: 6,
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'p-agent',
            content: { kind: 'terminal', mode: 'claude', createRequestId: 'req-agent', status: 'running' },
          },
        },
        activePane: {},
        paneTitles: { 'tab-1': { 'p-agent': 'Foreign Scoped Alias' } },
        paneTitleSetByUser: { 'tab-1': { 'p-agent': true } },
      },
      tombstones: [],
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'freshell.layout.v3.layout-window-task7-local-drop',
      newValue: foreignRaw,
    }))

    // Neither the foreign alias nor the pre-existing LOCAL alias survives:
    // the canonical server record owns the scoped pane's name.
    expect(store.getState().panes.paneTitles['tab-1']?.['p-agent']).toBeUndefined()
    expect(store.getState().panes.paneTitleSetByUser['tab-1']?.['p-agent']).toBeUndefined()
  })
})

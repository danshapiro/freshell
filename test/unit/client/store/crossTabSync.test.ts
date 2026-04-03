import { describe, it, expect, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer, { hydrateTabs } from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes } from '../../../../src/store/panesSlice'
import settingsReducer, { setLocalSettings, updateSettingsLocal } from '../../../../src/store/settingsSlice'
import tabRegistryReducer, { setTabRegistrySearchRangeDays } from '../../../../src/store/tabRegistrySlice'
import { installCrossTabSync } from '../../../../src/store/crossTabSync'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '../../../../src/store/browserPreferencesPersistence'
import { broadcastPersistedRaw, resetPersistBroadcastForTests } from '../../../../src/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY, LAYOUT_STORAGE_KEY } from '../../../../src/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'
import { sessionMetadataKey } from '@/lib/session-metadata'

describe('crossTabSync', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistBroadcastForTests()
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('hydrates remote tabs but preserves the local active tab when it still exists', () => {
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

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
    expect(store.getState().tabs.activeTabId).toBe('t1')
  })

  it('hydrates remote panes but preserves the local activePane when it still exists', () => {
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

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    expect(store.getState().panes.layouts['tab-1']?.id).toBe('split-remote')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-a')
  })

  it('dedupes identical persisted payloads delivered via both storage and BroadcastChannel', () => {
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
      window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: raw }))

      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: LAYOUT_STORAGE_KEY, raw, sourceId: 'other' } })

      const hydrateCalls = dispatchSpy.mock.calls
        .map((c) => c[0])
        .filter((a: any) => a?.type === 'tabs/hydrateTabs')
      expect(hydrateCalls).toHaveLength(1)

      cleanup()
    } finally {
      ;(globalThis as any).BroadcastChannel = original
    }
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
      tabs: {
        searchRangeDays: 365,
      },
    })

    window.dispatchEvent(new StorageEvent('storage', {
      key: BROWSER_PREFERENCES_STORAGE_KEY,
      newValue: remoteRaw,
    }))

    expect(store.getState().settings.localSettings.theme).toBe('dark')
    expect(store.getState().settings.settings.sidebar.sortMode).toBe('project')
    expect(store.getState().tabRegistry.searchRangeDays).toBe(365)
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
      expect(store.getState().tabRegistry.searchRangeDays).toBe(90)
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
    expect(store.getState().tabRegistry.searchRangeDays).toBe(365)
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
    expect(store.getState().tabRegistry.searchRangeDays).toBe(365)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
      tabs: {
        searchRangeDays: 365,
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
    })))

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
    expect(store.getState().tabRegistry.searchRangeDays).toBe(365)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        sidebar: {
          sortMode: 'project',
        },
      },
      tabs: {
        searchRangeDays: 365,
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
    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

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
    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    // Local reconnection state must be preserved — stale remote must not overwrite
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.createRequestId).toBe('req-new')
    expect(content.status).toBe('creating')
    expect(content.terminalId).toBeUndefined()
  })

  it('propagates exit state from remote even when local has terminalId', () => {
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
    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    // Exit state should propagate — local should NOT keep stale terminalId
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.status).toBe('exited')
    expect(content.terminalId).toBeUndefined()
  })

  it('does not crash on malformed remote pane layout (corrupted localStorage)', () => {
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
      window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))
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

  it('preserves local resumeSessionId when remote has different session for same createRequestId', () => {
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
    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    // Local resumeSessionId must NOT be overwritten by remote
    const content = (store.getState().panes.layouts['tab-1'] as any).content
    expect(content.resumeSessionId).toBe('session-A')
    // Other incoming fields (lifecycle progress) should still be accepted
    expect(content.terminalId).toBe('remote-terminal-456')
    expect(content.status).toBe('running')
  })

  it('does not permanently dedupe: identical remote payload should hydrate again after a local persisted change', () => {
    const dispatchSpy = vi.fn()
    const storeLike = {
      dispatch: dispatchSpy,
      getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
    }

    cleanups.push(installCrossTabSync(storeLike as any))

    const raw1 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: raw1 }))

    const raw2 = JSON.stringify({
      version: 3,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1 local change', createdAt: 1 }] },
      panes: { version: 6, layouts: {}, activePane: {}, paneTitles: {}, paneTitleSetByUser: {} },
      tombstones: [],
    })
    broadcastPersistedRaw(LAYOUT_STORAGE_KEY, raw2)

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: raw1 }))

    const hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(2)
  })

  it('hydrates both tabs and panes from a single combined layout event', () => {
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

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: layoutRaw }))

    // Both tabs and panes should be hydrated from the single combined event
    expect(store.getState().tabs.tabs.map((t: any) => t.id)).toEqual(['t1', 't2'])
    expect(store.getState().panes.layouts).toHaveProperty('t1')
    expect(store.getState().panes.layouts).toHaveProperty('t2')
  })

  it('rejects stale rebroadcast layout that would overwrite a newer canonical durable id', () => {
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
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-1',
            status: 'idle',
            resumeSessionId: canonicalSessionId,
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: {},
    }))

    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
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
              kind: 'agent-chat',
              provider: 'freshclaude',
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
              kind: 'agent-chat',
              provider: 'freshclaude',
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
    })

    window.dispatchEvent(new StorageEvent('storage', { key: LAYOUT_STORAGE_KEY, newValue: remoteRaw }))

    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content
    expect(paneContent.resumeSessionId).toBe(canonicalSessionId)

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.resumeSessionId).toBe(canonicalSessionId)
    expect(tab?.sessionMetadataByKey).toEqual(expect.objectContaining({
      [sessionMetadataKey('claude', canonicalSessionId)]: expect.objectContaining({
        sessionType: 'freshclaude',
      }),
    }))
    expect(tab?.sessionMetadataByKey).not.toHaveProperty(sessionMetadataKey('claude', 'named-resume'))
  })
})

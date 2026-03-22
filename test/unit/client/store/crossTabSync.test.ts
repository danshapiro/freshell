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
import { BROWSER_PREFERENCES_STORAGE_KEY, PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '../../../../src/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'

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
      version: 1,
      tabs: {
        activeTabId: 't2',
        tabs: [
          { id: 't1', title: 'T1', createdAt: 1 },
          { id: 't2', title: 'T2', createdAt: 2 },
          { id: 't3', title: 'T3', createdAt: 3 },
        ],
      },
    })

    window.dispatchEvent(new StorageEvent('storage', { key: TABS_STORAGE_KEY, newValue: remoteRaw }))

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
      version: 4,
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

    })

    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

    expect(store.getState().panes.layouts['tab-1']?.id).toBe('split-remote')
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-a')
  })

  it('hydrates remote panes but preserves local authoritative coding identity for the same createRequestId', () => {
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
    })

    store.dispatch(hydrateTabs({
      tabs: [{ id: 'tab-1', title: 'T1', createdAt: 1, mode: 'codex' } as any],
      activeTabId: 'tab-1',
      renameRequestTabId: null,
    }))

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-live',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-live',
            status: 'running',
            terminalId: 'term-live',
            resumeSessionId: 'codex-local',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-local',
              serverInstanceId: 'srv-local',
            },
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-live' },
      paneTitles: {},
    }))

    cleanups.push(installCrossTabSync(store as any))

    const remoteRaw = JSON.stringify({
      version: 4,
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-live',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-live',
            status: 'creating',
            resumeSessionId: 'codex-foreign',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-foreign',
              serverInstanceId: 'srv-remote',
            },
          },
        },
      },
      activePane: { 'tab-1': 'pane-live' },
      paneTitles: {},
    })

    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

    const layout = store.getState().panes.layouts['tab-1'] as any
    expect(layout?.content?.terminalId).toBe('term-live')
    expect(layout?.content?.resumeSessionId).toBe('codex-local')
    expect(layout?.content?.sessionRef).toEqual({
      provider: 'codex',
      sessionId: 'codex-local',
      serverInstanceId: 'srv-local',
    })
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
        version: 1,
        tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
      })
      window.dispatchEvent(new StorageEvent('storage', { key: TABS_STORAGE_KEY, newValue: raw }))

      MockBC.instance!.onmessage?.({ data: { type: 'persist', key: TABS_STORAGE_KEY, raw, sourceId: 'other' } })

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

  it('ignores toolStrip-only browser-preference writes for Redux local settings and search range', () => {
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
      newValue: JSON.stringify({
        toolStrip: {
          expanded: true,
        },
      }),
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
      newValue: JSON.stringify({
        toolStrip: {
          expanded: true,
        },
      }),
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
      version: 4,
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

    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

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
      version: 4,
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

    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

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
      version: 4,
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

    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

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
      version: 4,
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

    })

    cleanups.push(installCrossTabSync(store as any))

    // Should not throw — malformed remote data is ignored and local state wins.
    expect(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))
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
      version: 4,
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

    })

    cleanups.push(installCrossTabSync(store as any))
    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

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
      version: 1,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] },
    })
    window.dispatchEvent(new StorageEvent('storage', { key: TABS_STORAGE_KEY, newValue: raw1 }))

    const raw2 = JSON.stringify({
      version: 1,
      tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1 local change', createdAt: 1 }] },
    })
    broadcastPersistedRaw(TABS_STORAGE_KEY, raw2)

    window.dispatchEvent(new StorageEvent('storage', { key: TABS_STORAGE_KEY, newValue: raw1 }))

    const hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(2)
  })
})

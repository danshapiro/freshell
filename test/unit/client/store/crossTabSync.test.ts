import { describe, it, expect, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import tabsReducer, { hydrateTabs } from '../../../../src/store/tabsSlice'
import panesReducer, { hydratePanes } from '../../../../src/store/panesSlice'
import { installCrossTabSync } from '../../../../src/store/crossTabSync'
import { broadcastPersistedRaw } from '../../../../src/store/persistBroadcast'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '../../../../src/store/persistedState'

describe('crossTabSync', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
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
      paneTitleSetByUser: {},
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
      paneTitleSetByUser: {},
    })

    window.dispatchEvent(new StorageEvent('storage', { key: PANES_STORAGE_KEY, newValue: remoteRaw }))

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


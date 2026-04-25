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
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedLayoutCacheForTests,
} from '@/store/persistMiddleware'

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

describe('tabs persistence - skipPersist + strip volatile fields', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
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

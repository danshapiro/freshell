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
import panesReducer from '@/store/panesSlice'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
} from '@/store/persistMiddleware'
import { parsePersistedTabsRaw } from '@/store/persistedState'

function makeStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
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

    const raw = localStorage.getItem('freshell.tabs.v2')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.tabs.tabs[0].lastInputAt).toBeUndefined()
  })

  it('rewrites unresolved legacy tab title sources using pane context before persisting', () => {
    const durableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'
    const store = configureStore({
      reducer: { tabs: tabsReducer, panes: panesReducer },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'shell-tab',
              createRequestId: 'shell-tab',
              title: 'Shell',
              titleSetByUser: false,
              status: 'running',
              mode: 'shell',
              shell: 'system',
              createdAt: 1,
            },
            {
              id: 'session-tab',
              createRequestId: 'session-tab',
              title: durableTitle,
              titleSetByUser: false,
              status: 'running',
              mode: 'codex',
              shell: 'system',
              createdAt: 2,
            },
          ],
          activeTabId: 'shell-tab',
        },
        panes: {
          layouts: {
            'shell-tab': {
              type: 'leaf',
              id: 'pane-shell',
              content: {
                kind: 'terminal',
                createRequestId: 'pane-shell',
                status: 'running',
                mode: 'shell',
                shell: 'system',
              },
            },
            'session-tab': {
              type: 'leaf',
              id: 'pane-session',
              content: {
                kind: 'terminal',
                createRequestId: 'pane-session',
                status: 'running',
                mode: 'codex',
                shell: 'system',
              },
            },
          },
          activePane: {
            'shell-tab': 'pane-shell',
            'session-tab': 'pane-session',
          },
          paneTitles: {
            'shell-tab': { 'pane-shell': 'Shell' },
            'session-tab': { 'pane-session': durableTitle },
          },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
      },
    })

    store.dispatch(updateTab({ id: 'shell-tab', updates: { description: 'persist rewrite' } }))
    vi.runAllTimers()

    const raw = localStorage.getItem('freshell.tabs.v2')
    expect(raw).not.toBeNull()

    const parsed = parsePersistedTabsRaw(raw!)
    expect(parsed).not.toBeNull()
    expect(parsed!.tabs.tabs.find((tab) => tab.id === 'shell-tab')?.titleSource).toBe('derived')
    expect(parsed!.tabs.tabs.find((tab) => tab.id === 'session-tab')?.titleSource).toBe('stable')
  })
})

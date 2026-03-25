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
})

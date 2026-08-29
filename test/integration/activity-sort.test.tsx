import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import settingsReducer from '@/store/settingsSlice'
import sessionActivityReducer, { SESSION_ACTIVITY_STORAGE_KEY } from '@/store/sessionActivitySlice'
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import {
  sessionActivityPersistMiddleware,
  SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS,
  resetSessionActivityFlushListenersForTests,
} from '@/store/sessionActivityPersistence'

describe('Activity sort integration', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSessionActivityFlushListenersForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists session activity across page reloads', async () => {
    const timestamp = Date.now()

    localStorage.setItem(SESSION_ACTIVITY_STORAGE_KEY, JSON.stringify({
      'session-123': timestamp,
    }))

    vi.resetModules()
    const { default: freshSessionActivityReducer } = await import('@/store/sessionActivitySlice')

    const store = configureStore({
      reducer: {
        settings: settingsReducer,
        sessionActivity: freshSessionActivityReducer,
      },
    })

    expect(store.getState().sessionActivity.sessions['session-123']).toBe(timestamp)
  }, 10000)

  it('persists the close-tab activity ratchet to localStorage after the debounce', async () => {
    const claudeSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionActivity: sessionActivityReducer,
      },
      middleware: (getDefault) => getDefault().concat(sessionActivityPersistMiddleware),
    })

    store.dispatch(addTab({ mode: 'claude' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: {
        kind: 'terminal',
        mode: 'claude',
        resumeSessionId: claudeSessionId,
        sessionRef: { provider: 'claude', sessionId: claudeSessionId },
      },
    }))

    const beforeClose = Date.now()
    await store.dispatch(closeTab(tabId))

    expect(store.getState().sessionActivity.sessions[`claude:${claudeSessionId}`])
      .toBeGreaterThanOrEqual(beforeClose)
    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY) || '{}')
    expect(persisted[`claude:${claudeSessionId}`]).toBeGreaterThanOrEqual(beforeClose)
  })
})

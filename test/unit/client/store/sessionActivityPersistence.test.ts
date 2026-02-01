import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import sessionActivityReducer, { updateSessionActivity, SESSION_ACTIVITY_STORAGE_KEY } from '@/store/sessionActivitySlice'
import {
  sessionActivityPersistMiddleware,
  SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS,
  resetSessionActivityFlushListenersForTests,
} from '@/store/sessionActivityPersistence'

describe('sessionActivity persistence middleware', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    resetSessionActivityFlushListenersForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createStore() {
    return configureStore({
      reducer: { sessionActivity: sessionActivityReducer },
      middleware: (getDefault) => getDefault().concat(sessionActivityPersistMiddleware),
    })
  }

  it('debounces localStorage writes', () => {
    const store = createStore()

    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: Date.now() } as any))

    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).not.toBeNull()
  })

  it('persists the pruned activity map', () => {
    const store = createStore()
    const now = Date.now()
    const oldTime = now - 1000 * 60 * 60 * 24 * 31

    store.dispatch(updateSessionActivity({ sessionId: 'old-session', provider: 'claude', lastInputAt: oldTime } as any))
    store.dispatch(updateSessionActivity({ sessionId: 'fresh-session', provider: 'claude', lastInputAt: now } as any))

    vi.runAllTimers()

    const stored = JSON.parse(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY) || '{}')
    expect(stored['claude:old-session']).toBeUndefined()
    expect(stored['claude:fresh-session']).toBe(now)
  })

  it('retries persistence when storage becomes available', () => {
    const originalStorage = globalThis.localStorage
    // @ts-expect-error - simulate unavailable storage
    globalThis.localStorage = undefined

    const store = createStore()
    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: 123 } as any))

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    // Restore storage and allow retry
    // @ts-expect-error - restore
    globalThis.localStorage = originalStorage

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).not.toBeNull()
  })

  it('flushes pending writes on visibility change', () => {
    const store = createStore()
    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: 123 } as any))

    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).toBeNull()

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).not.toBeNull()
  })
})

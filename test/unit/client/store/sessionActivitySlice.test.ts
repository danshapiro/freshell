import { describe, it, expect, beforeEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import sessionActivityReducer, {
  updateSessionActivity,
  selectSessionActivity,
} from '@/store/sessionActivitySlice'

describe('sessionActivitySlice - ratchet persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function createStore() {
    return configureStore({
      reducer: { sessionActivity: sessionActivityReducer },
    })
  }

  it('stores lastInputAt for a session', () => {
    const store = createStore()
    const timestamp = Date.now()

    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: timestamp } as any))

    const state = store.getState()
    expect(selectSessionActivity(state, 'claude:session-1')).toBe(timestamp)
  })

  it('does not downgrade lastInputAt (ratchet behavior)', () => {
    const store = createStore()
    const oldTime = Date.now() - 10000
    const newTime = Date.now()

    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: newTime } as any))
    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: oldTime } as any))

    const state = store.getState()
    expect(selectSessionActivity(state, 'claude:session-1')).toBe(newTime)
  })

  it('does not write to localStorage from the reducer', () => {
    const store = createStore()
    const timestamp = Date.now()
    const setItemSpy = vi.spyOn(localStorage, 'setItem')

    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: timestamp } as any))

    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('loads from localStorage on slice initialization', async () => {
    const timestamp = Date.now()
    localStorage.setItem('freshell.sessionActivity.v1', JSON.stringify({ 'claude:session-1': timestamp }))

    vi.resetModules()
    const {
      default: freshReducer,
      selectSessionActivity: freshSelectSessionActivity,
    } = await import('@/store/sessionActivitySlice')

    const store = configureStore({
      reducer: { sessionActivity: freshReducer },
    })

    const state = store.getState()
    expect(freshSelectSessionActivity(state, 'claude:session-1')).toBe(timestamp)
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('freshell.sessionActivity.v1', 'not-valid-json')

    const store = createStore()
    const state = store.getState()
    expect(state.sessionActivity.sessions).toEqual({})
  })

  it('drops non-numeric entries loaded from localStorage', async () => {
    const now = Date.now()
    localStorage.setItem(
      'freshell.sessionActivity.v1',
      JSON.stringify({ 'claude:session-1': 'bad-value', 'codex:session-2': now })
    )

    vi.resetModules()
    const {
      default: freshReducer,
      selectSessionActivity: freshSelectSessionActivity,
    } = await import('@/store/sessionActivitySlice')

    const store = configureStore({
      reducer: { sessionActivity: freshReducer },
    })

    const state = store.getState()
    expect(freshSelectSessionActivity(state, 'claude:session-1')).toBeUndefined()
    expect(freshSelectSessionActivity(state, 'codex:session-2')).toBe(now)
  })

  it('handles multiple sessions independently', () => {
    const store = createStore()
    const time1 = Date.now()
    const time2 = Date.now() + 1000

    store.dispatch(updateSessionActivity({ sessionId: 'session-1', provider: 'claude', lastInputAt: time1 } as any))
    store.dispatch(updateSessionActivity({ sessionId: 'session-2', provider: 'codex', lastInputAt: time2 } as any))

    const state = store.getState()
    expect(selectSessionActivity(state, 'claude:session-1')).toBe(time1)
    expect(selectSessionActivity(state, 'codex:session-2')).toBe(time2)
  })

  it('prunes sessions older than the retention window', () => {
    const store = createStore()
    const now = Date.now()
    const oldTime = now - 1000 * 60 * 60 * 24 * 31 // 31 days ago

    store.dispatch(updateSessionActivity({ sessionId: 'old-session', provider: 'claude', lastInputAt: oldTime } as any))
    store.dispatch(updateSessionActivity({ sessionId: 'fresh-session', provider: 'claude', lastInputAt: now } as any))

    const state = store.getState()
    expect(selectSessionActivity(state, 'claude:old-session')).toBeUndefined()
    expect(selectSessionActivity(state, 'claude:fresh-session')).toBe(now)
  })
})

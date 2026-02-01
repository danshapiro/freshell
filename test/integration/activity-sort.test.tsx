import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import settingsReducer, { defaultSettings, setSettings } from '@/store/settingsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'

describe('Activity sort integration', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists session activity across page reloads', async () => {
    const timestamp = Date.now()

    localStorage.setItem('freshell.sessionActivity.v1', JSON.stringify({
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

  it('migrates hybrid sortMode to activity on setSettings', () => {
    const store = configureStore({
      reducer: {
        settings: settingsReducer,
      },
    })

    store.dispatch(setSettings({
      ...defaultSettings,
      sidebar: {
        ...defaultSettings.sidebar,
        sortMode: 'hybrid' as any,
      },
    }))

    expect(store.getState().settings.settings.sidebar.sortMode).toBe('activity')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setServerSettings } from '@/store/settingsSlice'
import { saveServerSettingsPatch } from '@/store/settingsThunks'

const apiPatch = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      patch: (...args: unknown[]) => apiPatch(...args),
    },
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
    },
  })
}

describe('settingsThunks', () => {
  beforeEach(() => {
    apiPatch.mockReset()
    localStorage.clear()
  })

  it('previews the server patch before saving and marks the state saved on success', async () => {
    vi.useFakeTimers()
    try {
      const now = 1_700_000_100_000
      vi.setSystemTime(now)

      const store = makeStore()
      apiPatch.mockImplementation(async (path: string, body: unknown) => {
        expect(path).toBe('/api/settings')
        expect(body).toEqual({
          defaultCwd: '/workspace',
          terminal: {
            scrollback: 12000,
          },
        })
        expect(store.getState().settings.settings.defaultCwd).toBe('/workspace')
        expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
        return {}
      })

      const result = await store.dispatch(saveServerSettingsPatch({
        defaultCwd: '/workspace',
        terminal: {
          scrollback: 12000,
        },
      }))

      expect(result.type).toBe('settings/saveServerSettingsPatch/fulfilled')
      expect(apiPatch).toHaveBeenCalledTimes(1)
      expect(store.getState().settings.lastSavedAt).toBe(now)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves defaultCwd clear behavior by sending the empty-string sentinel to the API', async () => {
    const store = makeStore()
    const initialServerSettings = store.getState().settings.serverSettings
    store.dispatch(setServerSettings({
      ...initialServerSettings,
      defaultCwd: '/workspace',
    }))

    apiPatch.mockResolvedValue({})

    await store.dispatch(saveServerSettingsPatch({
      defaultCwd: undefined,
    }))

    expect(apiPatch).toHaveBeenCalledWith('/api/settings', { defaultCwd: '' })
    expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
  })
})

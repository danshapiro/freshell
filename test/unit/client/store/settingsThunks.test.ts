import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setServerSettings } from '@/store/settingsSlice'
import { resetServerSettingsSaveQueueForTests, saveServerSettingsPatch } from '@/store/settingsThunks'

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
    resetServerSettingsSaveQueueForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('serializes later saves behind earlier in-flight requests so newer patches cannot overtake older ones', async () => {
    const store = makeStore()
    let resolveFirst: ((value: unknown) => void) | null = null

    apiPatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))
    apiPatch.mockResolvedValueOnce({})

    const first = store.dispatch(saveServerSettingsPatch({
      editor: {
        customEditorCommand: 'vim +{line} {file}',
      },
    }))

    const second = store.dispatch(saveServerSettingsPatch({
      editor: {
        customEditorCommand: 'nvim +{line} {file}',
      },
    }))

    await Promise.resolve()

    expect(apiPatch).toHaveBeenCalledTimes(1)
    expect(apiPatch).toHaveBeenNthCalledWith(1, '/api/settings', {
      editor: {
        customEditorCommand: 'vim +{line} {file}',
      },
    })

    resolveFirst?.({})
    await first
    await Promise.resolve()

    expect(apiPatch).toHaveBeenCalledTimes(2)
    expect(apiPatch).toHaveBeenNthCalledWith(2, '/api/settings', {
      editor: {
        customEditorCommand: 'nvim +{line} {file}',
      },
    })

    await second
  })

  it('preserves nested coding CLI clears by converting them into API clear sentinels', async () => {
    const store = makeStore()
    const initialServerSettings = store.getState().settings.serverSettings
    store.dispatch(setServerSettings({
      ...initialServerSettings,
      codingCli: {
        ...initialServerSettings.codingCli,
        providers: {
          ...initialServerSettings.codingCli.providers,
          codex: {
            cwd: '/workspace',
            model: 'gpt-5-codex',
            sandbox: 'workspace-write',
          },
        },
      },
    }))

    apiPatch.mockResolvedValue({})

    await store.dispatch(saveServerSettingsPatch({
      codingCli: {
        providers: {
          codex: {
            cwd: undefined,
            model: undefined,
            sandbox: undefined,
          },
        },
      },
    }))

    expect(apiPatch).toHaveBeenCalledWith('/api/settings', {
      codingCli: {
        providers: {
          codex: {
            cwd: null,
            model: null,
            sandbox: null,
          },
        },
      },
    })
    expect(store.getState().settings.settings.codingCli.providers.codex?.cwd).toBeUndefined()
    expect(store.getState().settings.settings.codingCli.providers.codex?.model).toBeUndefined()
    expect(store.getState().settings.settings.codingCli.providers.codex?.sandbox).toBeUndefined()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setServerSettings } from '@/store/settingsSlice'
import {
  discardStagedServerSettingsPatch,
  resetServerSettingsSaveQueueForTests,
  saveServerSettingsPatch,
  serverSettingsSaveStateMiddleware,
  stageServerSettingsPatchPreview,
} from '@/store/settingsThunks'

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
    middleware: (getDefault) => getDefault().concat(serverSettingsSaveStateMiddleware),
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

  it('rolls back failed optimistic previews while preserving later queued saves and logs the failure', async () => {
    const store = makeStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectFirst: ((reason?: unknown) => void) | null = null
    let resolveSecond: ((value: unknown) => void) | null = null

    apiPatch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    }))
    apiPatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSecond = resolve
    }))

    const first = store.dispatch(saveServerSettingsPatch({
      defaultCwd: '/workspace',
    }))
    const second = store.dispatch(saveServerSettingsPatch({
      terminal: {
        scrollback: 12000,
      },
    }))

    expect(store.getState().settings.settings.defaultCwd).toBe('/workspace')
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)

    await Promise.resolve()
    expect(apiPatch).toHaveBeenCalledTimes(1)

    rejectFirst?.(new Error('save failed'))
    const firstResult = await first
    await Promise.resolve()

    expect(firstResult.type).toBe('settings/saveServerSettingsPatch/rejected')
    expect(apiPatch).toHaveBeenCalledTimes(2)
    expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
    expect(warnSpy).toHaveBeenCalledWith('[settingsThunks]', 'Failed to save server settings patch', expect.any(Error))

    resolveSecond?.(store.getState().settings.serverSettings)
    const secondResult = await second

    expect(secondResult.type).toBe('settings/saveServerSettingsPatch/fulfilled')
    expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)

    warnSpy.mockRestore()
  })

  it('rolls back a rejected save to the last confirmed server settings when the patch was previewed before dispatch', async () => {
    const store = makeStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    apiPatch.mockRejectedValue(new Error('save failed'))

    store.dispatch(setServerSettings({
      ...store.getState().settings.serverSettings,
      editor: {
        ...store.getState().settings.serverSettings.editor,
        externalEditor: 'custom',
      },
    }))
    const confirmedServerSettings = store.getState().settings.serverSettings

    store.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        editor: {
          customEditorCommand: 'vim +{line} {file}',
        },
      },
    })

    expect(store.getState().settings.settings.editor.customEditorCommand).toBe('vim +{line} {file}')

    const result = await store.dispatch(saveServerSettingsPatch({
      patch: {
        editor: {
          customEditorCommand: 'vim +{line} {file}',
        },
      },
      confirmedServerSettings,
    }))

    expect(result.type).toBe('settings/saveServerSettingsPatch/rejected')
    expect(store.getState().settings.settings.editor.customEditorCommand).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith('[settingsThunks]', 'Failed to save server settings patch', expect.any(Error))

    warnSpy.mockRestore()
  })

  it('reapplies staged debounced previews when an authoritative settings update arrives before save dispatch', () => {
    const store = makeStore()
    const authoritativeBaseline = store.getState().settings.serverSettings

    store.dispatch(stageServerSettingsPatchPreview({
      key: 'editor.customEditorCommand',
      patch: {
        editor: {
          customEditorCommand: 'vim +{line} {file}',
        },
      },
    }))

    store.dispatch(setServerSettings({
      ...authoritativeBaseline,
      terminal: {
        ...authoritativeBaseline.terminal,
        scrollback: 12000,
      },
    }))

    expect(store.getState().settings.settings.editor.customEditorCommand).toBe('vim +{line} {file}')
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
  })

  it('discarding a staged debounced preview preserves newer authoritative server settings', () => {
    const store = makeStore()
    const authoritativeBaseline = store.getState().settings.serverSettings

    store.dispatch(stageServerSettingsPatchPreview({
      key: 'editor.customEditorCommand',
      patch: {
        editor: {
          customEditorCommand: 'vim +{line} {file}',
        },
      },
    }))

    store.dispatch(setServerSettings({
      ...authoritativeBaseline,
      terminal: {
        ...authoritativeBaseline.terminal,
        scrollback: 12000,
      },
    }))

    store.dispatch(discardStagedServerSettingsPatch('editor.customEditorCommand'))

    expect(store.getState().settings.settings.editor.customEditorCommand).toBeUndefined()
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
  })

  it('preserves an intervening authoritative settings update when an in-flight save later rejects', async () => {
    const store = makeStore()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectFirst: ((reason?: unknown) => void) | null = null
    const authoritativeBaseline = store.getState().settings.serverSettings

    apiPatch.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectFirst = reject
    }))

    const pendingSave = store.dispatch(saveServerSettingsPatch({
      defaultCwd: '/workspace',
    }))

    await Promise.resolve()

    store.dispatch(setServerSettings({
      ...authoritativeBaseline,
      editor: {
        ...authoritativeBaseline.editor,
        externalEditor: 'code',
      },
    }))

    expect(store.getState().settings.settings.defaultCwd).toBe('/workspace')
    expect(store.getState().settings.settings.editor.externalEditor).toBe('code')

    rejectFirst?.(new Error('save failed'))
    const result = await pendingSave

    expect(result.type).toBe('settings/saveServerSettingsPatch/rejected')
    expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    expect(store.getState().settings.settings.editor.externalEditor).toBe('code')

    warnSpy.mockRestore()
  })

  it('preserves an intervening authoritative settings update when an in-flight save resolves without returning settings', async () => {
    const store = makeStore()
    let resolveFirst: ((value: unknown) => void) | null = null
    const authoritativeBaseline = store.getState().settings.serverSettings

    apiPatch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve
    }))

    const pendingSave = store.dispatch(saveServerSettingsPatch({
      defaultCwd: '/workspace',
    }))

    await Promise.resolve()

    store.dispatch(setServerSettings({
      ...authoritativeBaseline,
      editor: {
        ...authoritativeBaseline.editor,
        externalEditor: 'code',
      },
    }))

    expect(store.getState().settings.settings.defaultCwd).toBe('/workspace')
    expect(store.getState().settings.settings.editor.externalEditor).toBe('code')

    resolveFirst?.({})
    const result = await pendingSave

    expect(result.type).toBe('settings/saveServerSettingsPatch/fulfilled')
    expect(store.getState().settings.settings.defaultCwd).toBe('/workspace')
    expect(store.getState().settings.settings.editor.externalEditor).toBe('code')
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

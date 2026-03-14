import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings, setServerSettings } from '@/store/settingsSlice'
import { networkReducer } from '@/store/networkSlice'
import extensionsReducer from '@/store/extensionsSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
} from '@shared/settings'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ valid: true }),
  },
}))

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store/settingsThunks', async () => {
  const actual = await vi.importActual<typeof import('@/store/settingsThunks')>('@/store/settingsThunks')
  return {
    ...actual,
    saveServerSettingsPatch: (patch: unknown) => {
      saveServerSettingsPatchSpy(patch)
      return actual.saveServerSettingsPatch(patch as any)
    },
  }
})

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude',
    version: '1.0.0',
    label: 'Claude CLI',
    description: '',
    category: 'cli',
    cli: {
      supportsPermissionMode: true,
      supportsResume: true,
      resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'],
    },
  },
  {
    name: 'codex',
    version: '1.0.0',
    label: 'Codex CLI',
    description: '',
    category: 'cli',
    cli: {
      supportsModel: true,
      supportsSandbox: true,
      supportsResume: true,
      resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'],
    },
  },
]

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createTestStore() {
  const localSettings = resolveLocalSettings()
  return configureStore({
    reducer: {
      settings: settingsReducer,
      network: networkReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      settings: {
        serverSettings: defaultServerSettings,
        localSettings,
        settings: composeResolvedSettings(defaultServerSettings, localSettings),
        loaded: true,
        lastSavedAt: Date.now(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
    },
  })
}

describe('SettingsView coding CLI cwd', () => {
  beforeEach(() => {
    localStorage.clear()
    saveServerSettingsPatchSpy.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders starting directory inputs for configured providers', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    expect(screen.getByLabelText('Claude CLI starting directory')).toBeInTheDocument()
    expect(screen.getByLabelText('Codex CLI starting directory')).toBeInTheDocument()
  })

  it('starting directory inputs have correct placeholder', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    const claudeInput = screen.getByLabelText('Claude CLI starting directory')
    expect(claudeInput).toHaveAttribute('placeholder', 'e.g. ~/projects/my-app')
  })

  it('shows initial cwd value from settings', () => {
    const localSettings = resolveLocalSettings()
    const serverSettings = mergeServerSettings(defaultServerSettings, {
      codingCli: {
        enabledProviders: ['claude'],
        providers: {
          claude: { cwd: '/home/user/work' },
        },
      },
    })
    const store = configureStore({
      reducer: { settings: settingsReducer, network: networkReducer, extensions: extensionsReducer },
      preloadedState: {
        settings: {
          serverSettings,
          localSettings,
          settings: composeResolvedSettings(serverSettings, localSettings),
          loaded: true,
          lastSavedAt: Date.now(),
        },
        extensions: {
          entries: defaultCliExtensions,
        },
      },
    })

    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const claudeInput = screen.getByLabelText('Claude CLI starting directory') as HTMLInputElement
    expect(claudeInput.value).toBe('/home/user/work')
  })

  it('syncs cwd input when settings change externally', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const claudeInput = screen.getByLabelText('Claude CLI starting directory') as HTMLInputElement
    expect(claudeInput.value).toBe('')

    // Simulate external settings update (e.g. from WebSocket broadcast)
    act(() => {
      store.dispatch(setServerSettings(mergeServerSettings(store.getState().settings.serverSettings, {
        codingCli: { providers: { claude: { cwd: '/new/path' } } },
      })))
    })

    expect(claudeInput.value).toBe('/new/path')
  })

  it('validates cwd changes through saveServerSettingsPatch and updates state optimistically', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const claudeInput = screen.getByLabelText('Claude CLI starting directory')
    fireEvent.change(claudeInput, { target: { value: '/tmp/project' } })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      codingCli: { providers: { claude: { cwd: '/tmp/project' } } },
    })
    expect(store.getState().settings.settings.codingCli.providers.claude?.cwd).toBe('/tmp/project')
  })

  it('clears provider cwd overrides through the shared save path', async () => {
    const localSettings = resolveLocalSettings()
    const serverSettings = mergeServerSettings(defaultServerSettings, {
      codingCli: {
        providers: {
          claude: {
            cwd: '/home/user/work',
          },
        },
      },
    })
    const store = configureStore({
      reducer: {
        settings: settingsReducer,
        network: networkReducer,
        extensions: extensionsReducer,
      },
      preloadedState: {
        settings: {
          serverSettings,
          localSettings,
          settings: composeResolvedSettings(serverSettings, localSettings),
          loaded: true,
          lastSavedAt: Date.now(),
        },
        extensions: {
          entries: defaultCliExtensions,
        },
      },
    })

    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const claudeInput = screen.getByDisplayValue('/home/user/work')
    fireEvent.change(claudeInput, { target: { value: '' } })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      codingCli: { providers: { claude: { cwd: undefined } } },
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      codingCli: {
        providers: {
          claude: {
            cwd: null,
          },
        },
      },
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(store.getState().settings.settings.codingCli.providers.claude?.cwd).toBeUndefined()
  })
})

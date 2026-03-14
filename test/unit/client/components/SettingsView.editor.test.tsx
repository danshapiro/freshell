import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings, setServerSettings } from '@/store/settingsSlice'
import { networkReducer } from '@/store/networkSlice'
import type { AppSettings } from '@/store/types'
import type { DeepPartial } from '@/lib/type-utils'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  mergeServerSettings,
  resolveLocalSettings,
  stripLocalSettings,
  type ServerSettingsPatch,
} from '@shared/settings'

// Mock the API
vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/lib/api'
import { serverSettingsSaveStateMiddleware } from '@/store/settingsThunks'

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

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createTestStore(settingsOverrides?: DeepPartial<AppSettings>) {
  const settings = settingsOverrides
    ? {
        ...defaultSettings,
        ...settingsOverrides,
        editor: { ...defaultSettings.editor, ...(settingsOverrides.editor || {}) },
      }
    : defaultSettings
  const serverSettings = mergeServerSettings(
    defaultServerSettings,
    stripLocalSettings(settings as unknown as Record<string, unknown>) as ServerSettingsPatch,
  )
  const localSettings = resolveLocalSettings(
    extractLegacyLocalSettingsSeed(settings as unknown as Record<string, unknown>),
  )

  return configureStore({
    reducer: {
      settings: settingsReducer,
      network: networkReducer,
    },
    middleware: (getDefault) => getDefault().concat(serverSettingsSaveStateMiddleware),
    preloadedState: {
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: undefined,
      },
    },
  })
}

describe('SettingsView Editor section', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.clearAllMocks()
    saveServerSettingsPatchSpy.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders the Editor section with heading and description', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    // "Editor" also appears as a Panes dropdown option, so find the heading specifically
    const editorHeadings = screen.getAllByText('Editor')
    const sectionHeading = editorHeadings.find(
      (el) => el.tagName === 'H2'
    )
    expect(sectionHeading).toBeInTheDocument()
    expect(screen.getByText('External editor for file opening')).toBeInTheDocument()
  })

  it('renders the External editor dropdown', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.getByText('External editor')).toBeInTheDocument()
  })

  it('has all four options in the External editor dropdown', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const dropdown = screen.getByDisplayValue('Auto (system default)')
    const options = dropdown.querySelectorAll('option')

    expect(options).toHaveLength(4)
    expect(options[0]).toHaveValue('auto')
    expect(options[0]).toHaveTextContent('Auto (system default)')
    expect(options[1]).toHaveValue('cursor')
    expect(options[1]).toHaveTextContent('Cursor')
    expect(options[2]).toHaveValue('code')
    expect(options[2]).toHaveTextContent('VS Code')
    expect(options[3]).toHaveValue('custom')
    expect(options[3]).toHaveTextContent('Custom command')
  })

  it('shows current setting value in dropdown', () => {
    const store = createTestStore({ editor: { externalEditor: 'cursor' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const dropdown = screen.getByDisplayValue('Cursor')
    expect(dropdown).toHaveValue('cursor')
  })

  it('dispatches saveServerSettingsPatch when dropdown changes', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const dropdown = screen.getByDisplayValue('Auto (system default)')
    fireEvent.change(dropdown, { target: { value: 'code' } })

    expect(store.getState().settings.settings.editor?.externalEditor).toBe('code')

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      editor: { externalEditor: 'code' },
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      editor: { externalEditor: 'code' },
    })
  })

  it('does not show custom command input when "auto" is selected', () => {
    const store = createTestStore({ editor: { externalEditor: 'auto' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    // The custom command input (and its placeholder) should not be rendered
    expect(screen.queryByPlaceholderText('nvim +{line} {file}')).not.toBeInTheDocument()
  })

  it('does not show custom command input when "cursor" is selected', () => {
    const store = createTestStore({ editor: { externalEditor: 'cursor' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.queryByPlaceholderText('nvim +{line} {file}')).not.toBeInTheDocument()
  })

  it('does not show custom command input when "code" is selected', () => {
    const store = createTestStore({ editor: { externalEditor: 'code' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.queryByPlaceholderText('nvim +{line} {file}')).not.toBeInTheDocument()
  })

  it('shows custom command input when "custom" is selected', () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    // "Custom command" label appears both as a dropdown option and as the
    // settings row label; verify the input is present via its placeholder
    expect(screen.getByPlaceholderText('nvim +{line} {file}')).toBeInTheDocument()
    // The settings row label "Custom command" is rendered as a <span>
    const customLabels = screen.getAllByText('Custom command')
    const settingsLabel = customLabels.find((el) => el.tagName === 'SPAN')
    expect(settingsLabel).toBeInTheDocument()
  })

  it('shows custom command input after switching dropdown to "custom"', () => {
    const store = createTestStore({ editor: { externalEditor: 'auto' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.queryByPlaceholderText('nvim +{line} {file}')).not.toBeInTheDocument()

    const dropdown = screen.getByDisplayValue('Auto (system default)')
    fireEvent.change(dropdown, { target: { value: 'custom' } })

    expect(screen.getByPlaceholderText('nvim +{line} {file}')).toBeInTheDocument()
  })

  it('hides custom command input after switching away from "custom"', () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.getByPlaceholderText('nvim +{line} {file}')).toBeInTheDocument()

    const dropdown = screen.getByDisplayValue('Custom command')
    fireEvent.change(dropdown, { target: { value: 'auto' } })

    expect(screen.queryByPlaceholderText('nvim +{line} {file}')).not.toBeInTheDocument()
  })

  it('dispatches saveServerSettingsPatch when typing in the custom command input', async () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    fireEvent.change(input, { target: { value: 'vim +{line} {file}' } })

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBe(
      'vim +{line} {file}'
    )

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      patch: {
        editor: { customEditorCommand: 'vim +{line} {file}' },
      },
      stagedKey: 'editor.customEditorCommand',
    })
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      editor: { customEditorCommand: 'vim +{line} {file}' },
    })
  })

  it('debounces custom command saves and sends only the latest typed value', async () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    fireEvent.change(input, { target: { value: 'vim' } })
    fireEvent.change(input, { target: { value: 'vim +{line}' } })
    fireEvent.change(input, { target: { value: 'vim +{line} {file}' } })

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBe(
      'vim +{line} {file}'
    )
    expect(api.patch).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(1)
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      patch: {
        editor: { customEditorCommand: 'vim +{line} {file}' },
      },
      stagedKey: 'editor.customEditorCommand',
    })
    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      editor: { customEditorCommand: 'vim +{line} {file}' },
    })
  })

  it('rolls back debounced custom command previews when the save fails', async () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    vi.mocked(api.patch).mockRejectedValueOnce(new Error('save failed'))

    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    fireEvent.change(input, { target: { value: 'vim +{line} {file}' } })

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBe('vim +{line} {file}')

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBeUndefined()
  })

  it('rolls back pending debounced custom command previews on unmount before save dispatch', async () => {
    const store = createTestStore({ editor: { externalEditor: 'custom' } })
    const { unmount } = render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    fireEvent.change(input, { target: { value: 'vim +{line} {file}' } })

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBe('vim +{line} {file}')

    unmount()

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBeUndefined()

    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })

  it('preserves a pending debounced custom command through authoritative updates and discards only that preview on unmount', () => {
    const store = createTestStore({
      editor: { externalEditor: 'custom' },
      terminal: { scrollback: 1000 },
    })
    const authoritativeBaseline = store.getState().settings.serverSettings
    const { unmount } = render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    fireEvent.change(input, { target: { value: 'vim +{line} {file}' } })

    store.dispatch(setServerSettings({
      ...authoritativeBaseline,
      terminal: {
        ...authoritativeBaseline.terminal,
        scrollback: 12000,
      },
    }))

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBe('vim +{line} {file}')
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
    expect(screen.getByDisplayValue('vim +{line} {file}')).toBeInTheDocument()

    unmount()

    expect(store.getState().settings.settings.editor?.customEditorCommand).toBeUndefined()
    expect(store.getState().settings.settings.terminal.scrollback).toBe(12000)
    expect(saveServerSettingsPatchSpy).not.toHaveBeenCalled()
  })

  it('displays existing custom command value', () => {
    const store = createTestStore({
      editor: { externalEditor: 'custom', customEditorCommand: 'emacs +{line} {file}' },
    })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    const input = screen.getByPlaceholderText('nvim +{line} {file}')
    expect(input).toHaveValue('emacs +{line} {file}')
  })
})

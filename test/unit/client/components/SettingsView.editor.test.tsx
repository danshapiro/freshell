import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { networkReducer } from '@/store/networkSlice'
import type { AppSettings } from '@/store/types'
import type { DeepPartial } from '@/lib/type-utils'

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

function createTestStore(settingsOverrides?: DeepPartial<AppSettings>) {
  const settings = settingsOverrides
    ? {
        ...defaultSettings,
        ...settingsOverrides,
        editor: { ...defaultSettings.editor, ...(settingsOverrides.editor || {}) },
      }
    : defaultSettings

  return configureStore({
    reducer: {
      settings: settingsReducer,
      network: networkReducer,
    },
    preloadedState: {
      settings: {
        settings,
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

  it('dispatches settings update when dropdown changes', async () => {
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

  it('dispatches custom command update when typing in the input', async () => {
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

    expect(api.patch).toHaveBeenCalledWith('/api/settings', {
      editor: { customEditorCommand: 'vim +{line} {file}' },
    })
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

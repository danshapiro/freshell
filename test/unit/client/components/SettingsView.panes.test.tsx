import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import { networkReducer } from '@/store/networkSlice'
import { api } from '@/lib/api'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type LocalSettingsPatch,
} from '@shared/settings'
import { switchSettingsTab } from './settings-view-test-utils'

// Mock the API
vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
  },
}))

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createTestStore(
  defaultNewPane: 'ask' | 'shell' | 'browser' | 'editor' = 'ask',
  local?: LocalSettingsPatch,
) {
  const serverSettings = mergeServerSettings(defaultServerSettings, {
    panes: {
      defaultNewPane,
    },
  })
  const localSettings = resolveLocalSettings(local)

  return configureStore({
    reducer: {
      settings: settingsReducer,
      network: networkReducer,
    },
    preloadedState: {
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: Date.now(),
      },
    },
  })
}

describe('SettingsView Panes section', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders Panes section', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    expect(screen.getByText('Panes')).toBeInTheDocument()
  })

  it('renders Default new pane dropdown', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    expect(screen.getByText('Default new pane')).toBeInTheDocument()
  })

  it('shows current setting value in dropdown', () => {
    const store = createTestStore('shell')
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    const dropdown = screen.getByRole('combobox', { name: /default new pane/i })
    expect(dropdown).toHaveValue('shell')
  })

  it('has all four options in dropdown', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    const dropdown = screen.getByRole('combobox', { name: /default new pane/i })
    const options = dropdown.querySelectorAll('option')

    expect(options).toHaveLength(4)
    expect(options[0]).toHaveValue('ask')
    expect(options[1]).toHaveValue('shell')
    expect(options[2]).toHaveValue('browser')
    expect(options[3]).toHaveValue('editor')
  })

  it('renders Snap distance slider', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    expect(screen.getByText('Snap distance')).toBeInTheDocument()
  })

  it('shows snap distance slider with default value', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    // The slider should show "2%" for the default value
    expect(screen.getByText('2%')).toBeInTheDocument()
  })

  it('updates snap distance locally without calling /api/settings', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    const snapSlider = screen.getAllByRole('slider').find((slider) => {
      return slider.getAttribute('min') === '0' && slider.getAttribute('max') === '8'
    })!

    fireEvent.change(snapSlider, { target: { value: '4' } })
    fireEvent.pointerUp(snapSlider)

    expect(store.getState().settings.settings.panes.snapThreshold).toBe(4)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })

  it('renders sidebar agent open mode segmented control with default "New tab"', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    expect(screen.getByText('Open sidebar agent in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new tab/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /split pane/i })).toBeInTheDocument()
  })

  it('switches sidebar agent open mode to split pane locally', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    const splitButton = screen.getByRole('button', { name: /split pane/i })
    fireEvent.click(splitButton)

    expect(store.getState().settings.settings.panes.sessionOpenMode).toBe('split')

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })

  it('toggles icons on tabs locally without calling /api/settings', async () => {
    const store = createTestStore('ask', { panes: { iconsOnTabs: true } })
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )
    switchSettingsTab('Workspace')

    const row = screen.getByText('Icons on tabs').closest('div')!
    const toggle = row.querySelector('button')!
    fireEvent.click(toggle)

    expect(store.getState().settings.settings.panes.iconsOnTabs).toBe(false)

    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    expect(api.patch).not.toHaveBeenCalled()
  })
})

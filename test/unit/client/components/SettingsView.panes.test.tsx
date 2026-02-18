import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer from '@/store/settingsSlice'
import { networkReducer } from '@/store/networkSlice'

// Mock the API
vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
  },
}))

function createTestStore(defaultNewPane: 'ask' | 'shell' | 'browser' | 'editor' = 'ask') {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      network: networkReducer,
    },
    preloadedState: {
      settings: {
        settings: {
          theme: 'system',
          uiScale: 1,
          terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.2,
            cursorBlink: true,
            scrollback: 5000,
            theme: 'auto',
          },
          logging: {
            debug: false,
          },
          safety: {
            autoKillIdleMinutes: 180,
            warnBeforeKillMinutes: 5,
          },
          sidebar: {
            sortMode: 'activity',
            showProjectBadges: true,
            showSubagents: false,
            showNoninteractiveSessions: false,
            width: 288,
            collapsed: false,
          },
          panes: {
            defaultNewPane,
            snapThreshold: 2,
            iconsOnTabs: true,
          },
          codingCli: {
            enabledProviders: ['claude', 'codex'],
            providers: {},
          },
        },
        loaded: true,
        lastSavedAt: Date.now(),
      },
    },
  })
}

describe('SettingsView Panes section', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders Panes section', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.getByText('Panes')).toBeInTheDocument()
  })

  it('renders Default new pane dropdown', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    expect(screen.getByText('Default new pane')).toBeInTheDocument()
  })

  it('shows current setting value in dropdown', () => {
    const store = createTestStore('shell')
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

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

    expect(screen.getByText('Snap distance')).toBeInTheDocument()
  })

  it('shows snap distance slider with default value', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SettingsView />
      </Provider>
    )

    // The slider should show "2%" for the default value
    expect(screen.getByText('2%')).toBeInTheDocument()
  })
})

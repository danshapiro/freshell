import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '../../../../src/components/TabBar'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import connectionReducer from '../../../../src/store/connectionSlice'
import settingsReducer, { defaultSettings } from '../../../../src/store/settingsSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
  }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

function createStore(tabsState: any, panesState: any) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      tabs: tabsState,
      panes: panesState,
      connection: { status: 'connected', error: null, reconnectAttempts: 0 },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
    },
  })
}

describe('TabBar accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
  })

  afterEach(() => cleanup())

  it('exposes an accessible name for the new tab button', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
            titleSetByUser: false,
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
      },
      {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
      }
    )

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /new shell tab/i })).toBeInTheDocument()
  })
})


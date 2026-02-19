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

const defaultTabsState = {
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
}

const defaultPanesState = {
  layouts: {
    'tab-1': {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'shell',
        createRequestId: 'req-1',
        status: 'running',
      },
    },
  },
  activePane: { 'tab-1': 'pane-1' },
}

describe('TabBar mobile touch targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
  })

  afterEach(() => cleanup())

  it('new tab button has min-h-11 min-w-11 class for mobile touch target', () => {
    const store = createStore(defaultTabsState, defaultPanesState)

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    const newTabButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(newTabButton.className).toMatch(/min-h-11/)
    expect(newTabButton.className).toMatch(/min-w-11/)
  })

  it('tab bar container has h-12 for mobile and md:h-10 for desktop', () => {
    const store = createStore(defaultTabsState, defaultPanesState)
    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )
    // Find the tab bar - it's a div with the z-20 class
    const tabBar = screen.getByRole('button', { name: 'New shell tab' }).closest('.z-20')
    expect(tabBar?.className).toMatch(/h-12/)
    expect(tabBar?.className).toMatch(/md:h-10/)
  })

  it('tab close button has min-h-11 min-w-11 class for mobile touch target', () => {
    const store = createStore(defaultTabsState, defaultPanesState)

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
    expect(closeButton.className).toMatch(/min-h-11/)
    expect(closeButton.className).toMatch(/min-w-11/)
  })
})

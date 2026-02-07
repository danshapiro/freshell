import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '../../../../src/components/TabBar'
import tabsReducer from '../../../../src/store/tabsSlice'
import panesReducer from '../../../../src/store/panesSlice'
import connectionReducer from '../../../../src/store/connectionSlice'
import settingsReducer, { defaultSettings } from '../../../../src/store/settingsSlice'

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    close: vi.fn(),
  }),
}))

// Mock localStorage
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

describe('TabBar tab title derivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset localStorage mock
    vi.mocked(localStorage.getItem).mockReturnValue(null)
  })

  afterEach(() => {
    cleanup()
  })

  it('displays user-set title when titleSetByUser is true', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'My Custom Title',
            titleSetByUser: true,
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

    // Should show user's custom title, not derived "Claude"
    expect(screen.getByText('My Custom Title')).toBeInTheDocument()
    expect(screen.queryByText('Claude')).not.toBeInTheDocument()
  })

  it('derives title from CLI pane when titleSetByUser is false', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1', // Default title
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

    // Should derive "Claude" from pane content
    expect(screen.getByText('Claude')).toBeInTheDocument()
  })

  it('derives title from browser pane', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
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
              kind: 'browser',
              url: 'https://docs.example.com/api',
              devToolsOpen: false,
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

    expect(screen.getByText('docs.example.com')).toBeInTheDocument()
  })

  it('derives title from shell terminal using last directory segment', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
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
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
              initialCwd: '/home/user/projects/freshell',
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

    expect(screen.getByText('freshell')).toBeInTheDocument()
  })

  it('prefers CLI over browser when both exist', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab 1',
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
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-1',
                content: {
                  kind: 'browser',
                  url: 'https://example.com',
                  devToolsOpen: false,
                },
              },
              {
                type: 'leaf',
                id: 'pane-2',
                content: {
                  kind: 'terminal',
                  mode: 'codex',
                  createRequestId: 'req-1',
                  status: 'running',
                },
              },
            ],
          },
        },
        activePane: { 'tab-1': 'pane-2' },
      }
    )

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    // Should show "Codex" not "example.com"
    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.queryByText('example.com')).not.toBeInTheDocument()
  })

  it('falls back to stored title when no pane layout exists', () => {
    const store = createStore(
      {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'My Tab',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: Date.now(),
          },
        ],
        activeTabId: 'tab-1',
      },
      {
        layouts: {},
        activePane: {},
      }
    )

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    expect(screen.getByText('My Tab')).toBeInTheDocument()
  })
})

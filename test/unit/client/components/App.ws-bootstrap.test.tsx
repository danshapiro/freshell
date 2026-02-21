import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import idleWarningsReducer from '@/store/idleWarningsSlice'
import { networkReducer } from '@/store/networkSlice'

// Mock heavy child components to avoid xterm/canvas issues
vi.mock('@/components/TabContent', () => ({
  default: () => <div data-testid="mock-tab-content">Tab Content</div>,
}))
vi.mock('@/components/Sidebar', () => ({
  default: () => <div data-testid="mock-sidebar">Sidebar</div>,
  AppView: {} as any,
}))
vi.mock('@/components/HistoryView', () => ({
  default: () => <div data-testid="mock-history-view">History View</div>,
}))
vi.mock('@/components/SettingsView', () => ({
  default: () => <div data-testid="mock-settings-view">Settings View</div>,
}))
vi.mock('@/components/OverviewView', () => ({
  default: () => <div data-testid="mock-overview-view">Overview View</div>,
}))
vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))
vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

let messageHandler: ((msg: any) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
  }),
}))

const apiGet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

function createStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      idleWarnings: idleWarningsReducer,
      network: networkReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: { settings: defaultSettings, loaded: true, lastSavedAt: undefined },
      tabs: { tabs: [{ id: 'tab-1', mode: 'shell' }], activeTabId: 'tab-1' },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
      },
      sessions: { projects: [], expandedProjects: new Set<string>(), isLoading: false, error: null },
      panes: { layouts: {}, activePane: {} },
      idleWarnings: { warnings: {} },
      network: { status: null, loading: false, configuring: false, error: null },
    },
  })
}

describe('App WS bootstrap recovery', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    wsMocks.onReconnect.mockReturnValue(() => {})
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    // Keep API calls fast and deterministic.
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('marks connection as auth-required and skips websocket connect when bootstrap settings request returns 401', async () => {
    const store = createStore()
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.reject({ status: 401, message: 'Unauthorized' })
      }
      return Promise.resolve({})
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toBe('Authentication failed')
    })

    expect(wsMocks.connect).not.toHaveBeenCalled()
  })

  it('keeps the WS message handler registered after an initial connect failure, so a later ready can recover state', async () => {
    const store = createStore()

    wsMocks.connect.mockRejectedValueOnce(new Error('Handshake timeout'))

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toMatch(/Handshake timeout/i)
    })

    // Simulate a later successful auto-reconnect completing its handshake.
    expect(messageHandler).toBeTypeOf('function')
    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-test',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.lastError).toBeUndefined()
      expect(store.getState().connection.serverInstanceId).toBe('srv-test')
    })
  })

  it('dispatches wsCloseCode to lastErrorCode in Redux when connect rejects with close code', async () => {
    const store = createStore()

    const err = new Error('Server busy: max connections reached')
    ;(err as any).wsCloseCode = 4003
    wsMocks.connect.mockRejectedValueOnce(err)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toMatch(/max connections/)
      expect(store.getState().connection.lastErrorCode).toBe(4003)
    })
  })

  it('clears lastErrorCode when a ready message arrives after a failed connect', async () => {
    const store = createStore()

    // First connect fails with 4003
    const err = new Error('Server busy: max connections reached')
    ;(err as any).wsCloseCode = 4003
    wsMocks.connect.mockRejectedValueOnce(err)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.lastErrorCode).toBe(4003)
    })

    // Simulate a later reconnect succeeding: the WS message handler
    // (registered during bootstrap) receives a ready message, which
    // dispatches setStatus('ready') — the reducer clears lastErrorCode.
    expect(messageHandler).toBeTypeOf('function')
    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-reconnect',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.lastErrorCode).toBeUndefined()
      expect(store.getState().connection.lastError).toBeUndefined()
    })
  })

  it('includes current mobile state in hello extensions', async () => {
    const store = createStore()
    ;(globalThis as any).setMobileForTest(true)
    wsMocks.connect.mockResolvedValueOnce(undefined)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.setHelloExtensionProvider).toHaveBeenCalled()
    })

    const provider = wsMocks.setHelloExtensionProvider.mock.calls.at(-1)?.[0] as (() => any) | undefined
    expect(provider).toBeTypeOf('function')

    const extension = provider?.()
    expect(extension?.sessions).toBeDefined()
    expect(extension?.client?.mobile).toBe(true)
  })
})

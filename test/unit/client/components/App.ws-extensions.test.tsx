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
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import type { ClientExtensionEntry } from '@shared/extension-types'

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
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}))

let messageHandler: ((msg: any) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
    get isReady() {
      return wsMocks.isReady
    },
    get serverInstanceId() {
      return wsMocks.serverInstanceId
    },
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
      network: networkReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: { settings: defaultSettings, loaded: true, lastSavedAt: undefined },
      tabs: { tabs: [{ id: 'tab-1', mode: 'shell' as const }], activeTabId: 'tab-1' },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
      },
      sessions: { projects: [], expandedProjects: new Set<string>(), wsSnapshotReceived: false, isLoading: false, error: null },
      panes: { layouts: {}, activePane: {} },
      network: { status: null, loading: false, configuring: false, error: null },
      extensions: { entries: [] },
    },
  })
}

describe('App WS extension messages', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    wsMocks.connect.mockResolvedValue(undefined)

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

  it('dispatches setRegistry when receiving extensions.registry WS message', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    // Wait for bootstrap to register the message handler
    await waitFor(() => {
      expect(messageHandler).toBeTypeOf('function')
    })

    const extensions: ClientExtensionEntry[] = [
      {
        name: 'test-ext',
        version: '1.0.0',
        label: 'Test Extension',
        description: 'A test extension',
        category: 'client',
      },
      {
        name: 'server-ext',
        version: '2.0.0',
        label: 'Server Extension',
        description: 'A server extension',
        category: 'server',
        serverRunning: true,
        serverPort: 9100,
      },
    ]

    act(() => {
      messageHandler?.({ type: 'extensions.registry', extensions })
    })

    expect(store.getState().extensions.entries).toEqual(extensions)
  })

  it('dispatches updateServerStatus when receiving extension.server.ready WS message', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).toBeTypeOf('function')
    })

    // Pre-populate the registry so updateServerStatus has an entry to update
    const extensions: ClientExtensionEntry[] = [
      {
        name: 'my-ext',
        version: '1.0.0',
        label: 'My Extension',
        description: 'Testing server ready',
        category: 'server',
        serverRunning: false,
      },
    ]

    act(() => {
      messageHandler?.({ type: 'extensions.registry', extensions })
    })

    expect(store.getState().extensions.entries[0].serverRunning).toBe(false)

    act(() => {
      messageHandler?.({ type: 'extension.server.ready', name: 'my-ext', port: 9200 })
    })

    expect(store.getState().extensions.entries[0].serverRunning).toBe(true)
    expect(store.getState().extensions.entries[0].serverPort).toBe(9200)
  })

  it('dispatches updateServerStatus when receiving extension.server.stopped WS message', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).toBeTypeOf('function')
    })

    // Pre-populate with a running server extension
    const extensions: ClientExtensionEntry[] = [
      {
        name: 'my-ext',
        version: '1.0.0',
        label: 'My Extension',
        description: 'Testing server stopped',
        category: 'server',
        serverRunning: true,
        serverPort: 9200,
      },
    ]

    act(() => {
      messageHandler?.({ type: 'extensions.registry', extensions })
    })

    expect(store.getState().extensions.entries[0].serverRunning).toBe(true)
    expect(store.getState().extensions.entries[0].serverPort).toBe(9200)

    act(() => {
      messageHandler?.({ type: 'extension.server.stopped', name: 'my-ext' })
    })

    expect(store.getState().extensions.entries[0].serverRunning).toBe(false)
    expect(store.getState().extensions.entries[0].serverPort).toBeUndefined()
  })
})

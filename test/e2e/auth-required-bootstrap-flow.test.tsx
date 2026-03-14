import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockApiGet = vi.fn().mockResolvedValue({})
const fetchSidebarSessionsSnapshot = vi.fn()
const wsState = {
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    onReconnect: mockOnReconnect,
    connect: mockConnect,
    setHelloExtensionProvider: vi.fn(),
    get isReady() {
      return wsState.isReady
    },
    get serverInstanceId() {
      return wsState.serverInstanceId
    },
    get state() {
      return wsState.isReady ? 'ready' : 'connected'
    },
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => mockApiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

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

function createStore() {
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = resolveLocalSettings()

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      network: networkReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: [{ id: 'tab-1', mode: 'shell' }],
        activeTabId: 'tab-1',
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        isLoading: false,
        error: null,
      },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
        serverInstanceId: undefined,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      tabRegistry: {
        deviceId: 'device-test',
        deviceLabel: 'device-test',
        deviceAliases: {},
        localOpen: [],
        remoteOpen: [],
        closed: [],
        localClosed: {},
        searchRangeDays: 30,
        loading: false,
      },
      terminalMeta: { byTerminalId: {} },
      network: {
        status: null,
        loading: false,
        configuring: false,
        error: null,
      },
      extensions: { entries: [] },
    },
  })
}

describe('auth required bootstrap flow (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.reject({ status: 401, message: 'Unauthorized' })
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows a friendly token URL recovery message after bootstrap 401', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /authentication required/i })).toBeInTheDocument()
    })

    expect(screen.getByText(/Open Freshell using a token URL/i)).toBeInTheDocument()
    expect(screen.getByText(/\/\?token=YOUR_AUTH_TOKEN/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Token or token URL/i)).toBeInTheDocument()
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('shows the auth dialog immediately when no token is stored', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return new Promise(() => {})
      }
      return Promise.resolve({})
    })

    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /authentication required/i })).toBeInTheDocument()
    })

    expect(mockConnect).not.toHaveBeenCalled()
  })
})

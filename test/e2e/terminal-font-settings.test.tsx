import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
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
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type LocalSettingsPatch,
  type ServerSettingsPatch,
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

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createSettingsState(options: {
  server?: ServerSettingsPatch
  local?: LocalSettingsPatch
  loaded?: boolean
} = {}) {
  const serverSettings = mergeServerSettings(defaultServerSettings, options.server ?? {})
  const localSettings = resolveLocalSettings(options.local)

  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: options.loaded ?? true,
    lastSavedAt: undefined,
  }
}

function createTestStore() {
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
      settings: createSettingsState(),
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
        status: 'ready' as const,
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
      network: { status: null, loading: false, configuring: false, error: null },
      extensions: { entries: [] },
    },
  })
}

function renderApp(store = createTestStore()) {
  return render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}

describe('terminal font preference (e2e)', () => {
  const originalSessionStorage = global.sessionStorage

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined
    const sessionStorageMock: Record<string, string> = {
      'auth-token': 'test-token-abc123',
    }
    Object.defineProperty(global, 'sessionStorage', {
      value: {
        getItem: vi.fn((key: string) => sessionStorageMock[key] || null),
        setItem: vi.fn((key: string, value: string) => {
          sessionStorageMock[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          delete sessionStorageMock[key]
        }),
        clear: vi.fn(),
      },
      writable: true,
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
    })
  })

  it('keeps terminal font preference local to the browser', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
    }))

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'darwin' },
        })
      }
      return Promise.resolve({})
    })

    const store = configureStore({
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
        settings: createSettingsState({
          local: {
            terminal: {
              fontFamily: 'Fira Code',
            },
          },
        }),
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
          status: 'ready' as const,
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
        network: { status: null, loading: false, configuring: false, error: null },
        extensions: { entries: [] },
      },
    })
    renderApp(store)

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/bootstrap')
    })

    expect(store.getState().settings.settings.terminal.fontFamily).toBe('Fira Code')
  })

  it('hydrates a legacyLocalSettingsSeed terminal font into browser preferences when no local settings exist', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          legacyLocalSettingsSeed: {
            terminal: {
              fontFamily: 'Consolas',
            },
          },
          platform: { platform: 'darwin' },
        })
      }
      return Promise.resolve({})
    })

    const store = createTestStore()
    renderApp(store)

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/bootstrap')
    })

    expect(store.getState().settings.settings.terminal.fontFamily).toBe('Consolas')
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Consolas',
        },
      },
      legacyLocalSettingsSeedApplied: true,
    })
  })
})

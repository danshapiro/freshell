import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
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
import { networkReducer, setNetworkStatus, type NetworkStatusResponse } from '@/store/networkSlice'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
} from '@/store/browserPreferencesPersistence'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type LocalSettingsPatch,
  type ServerSettingsPatch,
} from '@shared/settings'

// Ensure DOM is clean even if another test file forgot cleanup.
beforeEach(() => {
  cleanup()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// Mock the WebSocket client
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
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

// Mock the api module
const mockApiGet = vi.fn().mockResolvedValue({})
const fetchSidebarSessionsSnapshot = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => mockApiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

const mockGenerateQr = vi.fn().mockReturnValue({ size: 21 })
const mockToSvgDataURL = vi.fn().mockReturnValue('data:image/svg+xml;base64,mock')
vi.mock('lean-qr', () => ({
  generate: (...args: any[]) => mockGenerateQr(...args),
}))
vi.mock('lean-qr/extras/svg', () => ({
  toSvgDataURL: (...args: any[]) => mockToSvgDataURL(...args),
}))

// Mock heavy child components to avoid xterm/canvas issues
vi.mock('@/components/TabContent', () => ({
  default: () => <div data-testid="mock-tab-content">Tab Content</div>,
}))

vi.mock('@/components/Sidebar', () => ({
  default: ({
    view,
    onNavigate,
    onToggleSidebar,
    currentVersion,
    updateAvailable,
    onBrandClick,
  }: {
    view: string
    onNavigate: (v: string) => void
    onToggleSidebar?: () => void
    currentVersion?: string | null
    updateAvailable?: boolean
    onBrandClick?: () => void
  }) => (
    <div data-testid="mock-sidebar" data-view={view}>
      <button type="button" title="Hide sidebar" onClick={() => onToggleSidebar?.()}>
        Hide sidebar
      </button>
      <button type="button" title="Go settings" onClick={() => onNavigate('settings')}>
        Go settings
      </button>
      {currentVersion ? (
        <button
          type="button"
          data-testid="app-brand-status"
          className={updateAvailable ? 'text-amber-700' : ''}
          onClick={() => onBrandClick?.()}
        >
          freshell
        </button>
      ) : null}
    </div>
  ),
  AppView: {} as any,
}))

vi.mock('@/components/HistoryView', () => ({
  default: () => <div data-testid="mock-history-view">History View</div>,
}))

vi.mock('@/components/SettingsView', () => ({
  default: ({ onSharePanel }: { onSharePanel?: () => void }) => (
    <div data-testid="mock-settings-view">
      Settings View
      <button type="button" aria-label="Open share panel" onClick={() => onSharePanel?.()}>
        Open share panel
      </button>
    </div>
  ),
}))

vi.mock('@/components/OverviewView', () => ({
  default: () => <div data-testid="mock-overview-view">Overview View</div>,
}))

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: ({ initialStep }: { initialStep?: number }) => (
    <div data-testid="mock-setup-wizard" data-initial-step={initialStep}>Setup Wizard (step {initialStep ?? 1})</div>
  ),
}))

// Mock the useThemeEffect hook to avoid errors from missing settings.terminal.fontSize
vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
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

function renderApp(store = createTestStore()) {
  return render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}

function makeNetworkStatus(overrides: Partial<NetworkStatusResponse> = {}): NetworkStatusResponse {
  const host = overrides.host ?? '0.0.0.0'
  return {
    configured: true,
    host,
    port: 3001,
    lanIps: ['192.168.1.100'],
    machineHostname: 'test-host',
    firewall: { platform: 'linux', active: false, portOpen: null, commands: [], configuring: false },
    remoteAccessEnabled: overrides.remoteAccessEnabled ?? (host === '0.0.0.0'),
    rebinding: false,
    devMode: false,
    accessUrl: 'http://192.168.1.100:3001',
    ...overrides,
  }
}

function makeVersionInfo(overrides: Partial<{
  currentVersion: string
  updateAvailable: boolean
  latestVersion: string | null
  releaseUrl: string | null
  error: string | null
}> = {}) {
  return {
    currentVersion: overrides.currentVersion ?? '0.4.5',
    updateCheck: {
      updateAvailable: overrides.updateAvailable ?? false,
      currentVersion: overrides.currentVersion ?? '0.4.5',
      latestVersion: overrides.latestVersion ?? '0.4.5',
      releaseUrl: overrides.releaseUrl ?? 'https://github.com/danshapiro/freshell/releases/latest',
      error: overrides.error ?? null,
    },
  }
}

describe('App Component - Share Button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      if (url === '/api/network/status') {
        return Promise.resolve(makeNetworkStatus())
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  async function openShareFromSettings() {
    fireEvent.click(screen.getByTitle('Go settings'))
    await waitFor(() => {
      expect(screen.queryByText('Loading settings…')).not.toBeInTheDocument()
    }, { timeout: 5000 })
    const openShareButton = await screen.findByRole('button', { name: 'Open share panel' }, { timeout: 5000 })
    fireEvent.click(openShareButton)
  }

  it('renders the share action in settings', async () => {
    renderApp()
    fireEvent.click(screen.getByTitle('Go settings'))
    expect(await screen.findByRole('button', { name: 'Open share panel' })).toBeInTheDocument()
  })

  it('renders the outlined terminal work area top border with a thin connector strip', () => {
    renderApp()

    const workArea = screen.getByTestId('terminal-work-area')
    const connector = screen.getByTestId('terminal-work-area-connector')

    expect(workArea.className).toContain('relative')
    expect(workArea.className).toContain('bg-background')
    expect(connector.className).toContain('h-[4px]')
    expect(connector.className).toContain('bg-background')
  })

  it('opens setup wizard when network not configured', async () => {
    const store = createTestStore()
    // Set network to unconfigured localhost
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: false,
        host: '127.0.0.1',
      })))
    })

    renderApp(store)
    await openShareFromSettings()

    // Should show the wizard at step 1
    expect(screen.getByTestId('mock-setup-wizard')).toBeInTheDocument()
    expect(screen.getByTestId('mock-setup-wizard').dataset.initialStep).toBe('1')
  })

  it('auto-opens setup wizard when WSL stays bound to 0.0.0.0 but remote access is disabled', async () => {
    const store = createTestStore()
    const wslLocalOnlyStatus = makeNetworkStatus({
      configured: false,
      host: '0.0.0.0',
      remoteAccessEnabled: false,
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      if (url === '/api/network/status') return Promise.resolve(wslLocalOnlyStatus)
      return Promise.resolve({})
    })

    act(() => {
      store.dispatch(setNetworkStatus(wslLocalOnlyStatus))
    })

    renderApp(store)

    expect(await screen.findByTestId('mock-setup-wizard')).toBeInTheDocument()
    expect(screen.getByTestId('mock-setup-wizard').dataset.initialStep).toBe('1')
  })

  it('opens setup wizard at step 2 when configured but localhost-only', async () => {
    const store = createTestStore()
    const localhostStatus = makeNetworkStatus({
      configured: true,
      host: '127.0.0.1',
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      if (url === '/api/network/status') return Promise.resolve(localhostStatus)
      return Promise.resolve({})
    })
    // Set network to configured but localhost
    act(() => {
      store.dispatch(setNetworkStatus(localhostStatus))
    })

    renderApp(store)

    // Close the auto-opened wizard first (auto-show only triggers for unconfigured)
    // In this case configured=true so no auto-show, we trigger share from settings
    await openShareFromSettings()

    expect(screen.getByTestId('mock-setup-wizard')).toBeInTheDocument()
    expect(screen.getByTestId('mock-setup-wizard').dataset.initialStep).toBe('2')
  })

  it('shows the share panel instead of the wizard when WSL remote access was requested but reachability is still unknown', async () => {
    const store = createTestStore()
    const wslReachabilityUnknownStatus = makeNetworkStatus({
      configured: true,
      host: '0.0.0.0',
      remoteAccessEnabled: false,
      remoteAccessRequested: true,
      accessUrl: 'http://192.168.1.100:3001',
      firewall: { platform: 'wsl2', active: true, portOpen: null, commands: [], configuring: false },
    } as any)
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      if (url === '/api/network/status') return Promise.resolve(wslReachabilityUnknownStatus)
      return Promise.resolve({})
    })
    act(() => {
      store.dispatch(setNetworkStatus(wslReachabilityUnknownStatus))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
      expect(screen.getByText('http://192.168.1.100:3001/?token=test-token-abc123')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('mock-setup-wizard')).not.toBeInTheDocument()
  })

  it('shows share panel with access URL when configured with remote access', async () => {
    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      })))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
      expect(screen.getByText('http://192.168.1.100:3001/?token=test-token-abc123')).toBeInTheDocument()
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })
  })

  it('renders share-panel QR with explicit dark-on-light colors', async () => {
    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      })))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByRole('img', { name: /qr code for access url/i })).toBeInTheDocument()
    })

    expect(mockToSvgDataURL).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ on: 'black', off: 'white' }),
    )
  })

  it('shows share panel for legacy HOST env override (configured=false, host=0.0.0.0)', async () => {
    const store = createTestStore()
    const legacyStatus = makeNetworkStatus({
      configured: false,
      host: '0.0.0.0',
      accessUrl: 'http://10.0.0.5:3001',
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      if (url === '/api/network/status') return Promise.resolve(legacyStatus)
      return Promise.resolve({})
    })
    act(() => {
      store.dispatch(setNetworkStatus(legacyStatus))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
      expect(screen.getByText('http://10.0.0.5:3001/?token=test-token-abc123')).toBeInTheDocument()
    })
  })

  it('share panel copy button copies access URL to clipboard', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    })

    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      })))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Copy link'))

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('http://192.168.1.100:3001/?token=test-token-abc123')
    })

    expect(screen.getByText('Copied!')).toBeInTheDocument()
  })

  it('clears the pending share copy reset timer on unmount', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    })

    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      })))
    })

    const view = renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Copy link'))

    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })

    view.unmount()

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })

  it('share panel can be closed by clicking X button', async () => {
    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '0.0.0.0',
        accessUrl: 'http://192.168.1.100:3001',
      })))
    })

    renderApp(store)
    await openShareFromSettings()

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
    })

    const closeButton = screen.getByLabelText('Close share panel')
    fireEvent.click(closeButton)

    await waitFor(() => {
      expect(screen.queryByText('Share Access')).not.toBeInTheDocument()
    })
  })

  it('retries network status fetch when clicked with null status', async () => {
    const store = createTestStore()
    // network.status starts as null (default)

    renderApp(store)
    await openShareFromSettings()

    // Should have dispatched fetchNetworkStatus (the loading case triggers a retry)
    // The mock API will be called for /api/network/status
    expect(mockApiGet).toHaveBeenCalledWith('/api/network/status')
  })
})

describe('App Component - Version Status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  it('does not render version text inline while the brand status control is present', async () => {
    renderApp()

    const brandStatus = await screen.findByTestId('app-brand-status')
    expect(brandStatus).toBeInTheDocument()
    expect(screen.queryByText('v0.4.5 (up to date)')).not.toBeInTheDocument()
  })

  it('highlights brand and opens update instructions when update is available', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') {
        return Promise.resolve(makeVersionInfo({
          currentVersion: '0.4.5',
          updateAvailable: true,
          latestVersion: '0.5.0',
          releaseUrl: 'https://github.com/danshapiro/freshell/releases/tag/v0.5.0',
        }))
      }
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })

    renderApp()

    const brandStatus = await screen.findByTestId('app-brand-status')
    expect(brandStatus.className).toContain('text-amber-700')

    fireEvent.click(brandStatus)

    await waitFor(() => {
      expect(screen.getByText('Update Available')).toBeInTheDocument()
      expect(screen.getByText(/You are running v0\.4\.5/)).toBeInTheDocument()
      expect(screen.getByText(/git pull/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
        'href',
        'https://github.com/danshapiro/freshell/releases/tag/v0.5.0'
      )
    })
  })
})

describe('App Component - WS Notifications', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    messageHandler = null
  })

  it('shows and dismisses config fallback warning when server reports corrupted config', async () => {
    renderApp()

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'config.fallback',
      reason: 'PARSE_ERROR',
      backupExists: true,
    })

    await waitFor(() => {
      expect(screen.getByText(/Config file was invalid/)).toBeInTheDocument()
      expect(screen.getByText(/Backup found at ~\/\.freshell\/config\.backup\.json\./)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Dismiss config fallback warning'))

    await waitFor(() => {
      expect(screen.queryByText(/Config file was invalid/)).not.toBeInTheDocument()
    })
  })
})

describe('App Component - Mobile Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    ;(globalThis as any).setMobileForTest(false)
  })

  it('auto-collapses on mobile but does not re-collapse after user opens it', async () => {
    ;(globalThis as any).setMobileForTest(true)

    renderApp()

    // After effects settle, it should be collapsed on mobile.
    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
      expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Show sidebar'))

    await waitFor(() => {
      expect(screen.getByTitle('Hide sidebar')).toBeInTheDocument()
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
    })

    // Give effects a chance to run; sidebar should remain open.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
  })

  it('does not persist responsive auto-collapse into browser preferences across a later desktop reload', async () => {
    ;(globalThis as any).setMobileForTest(true)

    const mobileStore = configureStore({
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
        }).concat(browserPreferencesPersistenceMiddleware),
      preloadedState: createTestStore().getState(),
    })

    const mobileView = renderApp(mobileStore)

    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS + 25)
      })
    })

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).not.toEqual(
      expect.objectContaining({
        settings: expect.objectContaining({
          sidebar: expect.objectContaining({
            collapsed: true,
          }),
        }),
      }),
    )

    mobileView.unmount()
    ;(globalThis as any).setMobileForTest(false)

    renderApp(configureStore({
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
        }).concat(browserPreferencesPersistenceMiddleware),
      preloadedState: createTestStore().getState(),
    }))

    await waitFor(() => {
      expect(screen.getByTitle('Hide sidebar')).toBeInTheDocument()
    })
  })
})
describe('App Bootstrap', () => {
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
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
    })
  })

  it('does not refetch bootstrap data or duplicate the eager sidebar hydration after websocket connect', async () => {
    let resolveConnect: () => void
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve
    })
    mockConnect.mockReturnValueOnce(connectPromise)

    renderApp()

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalled()
    })

    await waitFor(() => {
      const sessionsCalls = fetchSidebarSessionsSnapshot.mock.calls
      const bootstrapCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/bootstrap')
      const settingsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/settings')
      const platformCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/platform')
      expect(sessionsCalls.length).toBe(1)
      expect(bootstrapCalls.length).toBe(1)
      expect(settingsCalls.length).toBe(0)
      expect(platformCalls.length).toBe(0)
    })

    resolveConnect!()
    await Promise.resolve()
    await Promise.resolve()

    const sessionsCalls = fetchSidebarSessionsSnapshot.mock.calls
    const bootstrapCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/bootstrap')
    const settingsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/settings')
    const platformCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/platform')
    expect(sessionsCalls.length).toBe(1)
    expect(bootstrapCalls.length).toBe(1)
    expect(settingsCalls.length).toBe(0)
    expect(platformCalls.length).toBe(0)
  })

  it('writes legacyLocalSettingsSeed into browser preferences when no local settings payload exists', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          legacyLocalSettingsSeed: {
            terminal: {
              fontFamily: 'Fira Code',
            },
          },
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })

    const store = createTestStore()
    renderApp(store)

    await waitFor(() => {
      expect(store.getState().settings.settings.terminal.fontFamily).toBe('Fira Code')
    })

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('merges legacyLocalSettingsSeed into a partial browser-local payload without overwriting existing values', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        terminal: {
          fontFamily: 'JetBrains Mono',
        },
      },
    }))

    const store = createTestStore({
      settings: {
        local: {
          terminal: {
            fontFamily: 'JetBrains Mono',
          },
        },
      },
    })

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          legacyLocalSettingsSeed: {
            theme: 'light',
            sidebar: {
              showSubagents: true,
            },
            terminal: {
              fontFamily: 'Fira Code',
            },
          },
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })

    renderApp(store)

    await waitFor(() => {
      expect(store.getState().settings.settings.theme).toBe('light')
    })

    expect(store.getState().settings.settings.terminal.fontFamily).toBe('JetBrains Mono')
    expect(store.getState().settings.settings.sidebar.showSubagents).toBe(true)
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'light',
        sidebar: {
          showSubagents: true,
        },
        terminal: {
          fontFamily: 'JetBrains Mono',
        },
      },
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('keeps an existing browser-local settings payload instead of overwriting it with legacyLocalSettingsSeed', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
        terminal: {
          fontFamily: 'JetBrains Mono',
        },
      },
    }))

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
            theme: 'dark',
            terminal: {
              fontFamily: 'JetBrains Mono',
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
        network: {
          status: null,
          loading: false,
          configuring: false,
          error: null,
        },
        extensions: { entries: [] },
      },
    })

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          legacyLocalSettingsSeed: {
            terminal: {
              fontFamily: 'Fira Code',
            },
          },
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })

    renderApp(store)

    await waitFor(() => {
      expect(store.getState().settings.settings.terminal.fontFamily).toBe('JetBrains Mono')
    })

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        terminal: {
          fontFamily: 'JetBrains Mono',
        },
      },
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('does not reapply legacyLocalSettingsSeed after a seeded value is reset back to default', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      legacyLocalSettingsSeedApplied: true,
    }))

    const store = createTestStore()

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          legacyLocalSettingsSeed: {
            theme: 'light',
          },
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })

    renderApp(store)

    await waitFor(() => {
      expect(store.getState().settings.loaded).toBe(true)
    })

    expect(store.getState().settings.settings.theme).toBe('system')
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })
  })
})

describe('App WS message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('ignores legacy session bulk websocket messages because sidebar state is HTTP-owned', async () => {
    let handler: ((msg: any) => void) | null = null
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      handler = cb
      return () => { handler = null }
    })

    const store = createTestStore()
    renderApp(store)

    await vi.waitFor(() => expect(handler).not.toBeNull())

    act(() => {
      handler!({
        type: 'sessions.updated',
        projects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', lastActivityAt: 1 }] }],
      })
      handler!({
        type: 'sessions.patch',
        upsertProjects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', lastActivityAt: 2 }] }],
        removeProjectPaths: [],
      })
      handler!({
        type: 'sessions.page',
        projects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', lastActivityAt: 3 }] }],
        totalSessions: 1,
        oldestIncludedTimestamp: 3,
        oldestIncludedSessionId: 'claude:s3',
        hasMore: false,
      })
    })

    expect(store.getState().sessions.projects).toEqual([])
  })
})

describe('Tab Switching Keyboard Shortcuts', () => {
  const originalSessionStorage = global.sessionStorage

  function createStoreWithTabs(tabCount: number, activeIndex: number = 0) {
    const tabs = Array.from({ length: tabCount }, (_, i) => ({
      id: `tab-${i + 1}`,
      createRequestId: `req-${i + 1}`,
      title: `Tab ${i + 1}`,
      mode: 'shell' as const,
      shell: 'system' as const,
      status: 'running' as const,
      createdAt: Date.now(),
    }))
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
          tabs,
          activeTabId: tabs[activeIndex]?.id || null,
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

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined
    const sessionStorageMock: Record<string, string> = {
      'auth-token': 'test-token',
    }
    Object.defineProperty(global, 'sessionStorage', {
      value: {
        getItem: vi.fn((key: string) => sessionStorageMock[key] || null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      writable: true,
    })
    mockApiGet.mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
    })
  })

  it('Ctrl+Shift+[ switches to previous tab', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    renderApp(store)

    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, shiftKey: true })

    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('Ctrl+Shift+] switches to next tab', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    renderApp(store)

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true, shiftKey: true })

    expect(store.getState().tabs.activeTabId).toBe('tab-3')
  })

  it('wraps around when switching past the ends', () => {
    const store = createStoreWithTabs(3, 2) // active tab-3
    renderApp(store)

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true, shiftKey: true })
    expect(store.getState().tabs.activeTabId).toBe('tab-1')

    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    expect(store.getState().tabs.activeTabId).toBe('tab-3')
  })

  it('does nothing with a single tab', () => {
    const store = createStoreWithTabs(1, 0)
    renderApp(store)

    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true, shiftKey: true })
    expect(store.getState().tabs.activeTabId).toBe('tab-1')

    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, shiftKey: true })
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('switches tabs from a focused textarea', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    renderApp(store)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    try {
      textarea.focus()

      expect(document.activeElement).toBe(textarea)

      fireEvent.keyDown(textarea, { code: 'BracketRight', ctrlKey: true, shiftKey: true })
      expect(store.getState().tabs.activeTabId).toBe('tab-3')

      fireEvent.keyDown(textarea, { code: 'BracketLeft', ctrlKey: true, shiftKey: true })
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    } finally {
      textarea.remove()
    }
  })

  it('does not re-handle a prevented tab-switch event from an xterm control', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    renderApp(store)

    const xtermTarget = document.createElement('textarea')
    xtermTarget.className = 'xterm-helper-textarea'
    document.body.appendChild(xtermTarget)

    try {
      xtermTarget.focus()

      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'BracketRight',
        ctrlKey: true,
        shiftKey: true,
      })
      event.preventDefault()

      xtermTarget.dispatchEvent(event)

      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    } finally {
      xtermTarget.remove()
    }
  })

  it('ignores repeated tab-switch keydowns from an xterm control', () => {
    const store = createStoreWithTabs(3, 1) // active tab-2
    renderApp(store)

    const xtermTarget = document.createElement('textarea')
    xtermTarget.className = 'xterm-helper-textarea'
    document.body.appendChild(xtermTarget)

    try {
      xtermTarget.focus()

      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'BracketRight',
        ctrlKey: true,
        shiftKey: true,
        repeat: true,
      })

      xtermTarget.dispatchEvent(event)

      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    } finally {
      xtermTarget.remove()
    }
  })
})

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
import idleWarningsReducer from '@/store/idleWarningsSlice'
import { networkReducer, setNetworkStatus, type NetworkStatusResponse } from '@/store/networkSlice'

// Ensure DOM is clean even if another test file forgot cleanup.
beforeEach(() => {
  cleanup()
})

// Mock the WebSocket client
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    onReconnect: mockOnReconnect,
    connect: mockConnect,
    setHelloExtensionProvider: vi.fn(),
  }),
}))

// Mock the api module
const mockApiGet = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => mockApiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}))

// Mock heavy child components to avoid xterm/canvas issues
vi.mock('@/components/TabContent', () => ({
  default: () => <div data-testid="mock-tab-content">Tab Content</div>,
}))

vi.mock('@/components/Sidebar', () => ({
  default: ({ view, onNavigate }: { view: string; onNavigate: (v: string) => void }) => (
    <div data-testid="mock-sidebar" data-view={view}>
      Sidebar
    </div>
  ),
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

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: ({ initialStep }: { initialStep?: number }) => (
    <div data-testid="mock-setup-wizard" data-initial-step={initialStep}>Setup Wizard (step {initialStep ?? 1})</div>
  ),
}))

// Mock the useThemeEffect hook to avoid errors from missing settings.terminal.fontSize
vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

function createTestStore() {
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
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: defaultSettings,
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
        status: 'ready' as const,
        lastError: undefined,
      },
      panes: {
        layouts: {},
        activePane: {},
      },
      idleWarnings: {
        warnings: {},
      },
      network: {
        status: null,
        loading: false,
        configuring: false,
        error: null,
      },
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
  return {
    configured: true,
    host: '0.0.0.0',
    port: 3001,
    lanIps: ['192.168.1.100'],
    machineHostname: 'test-host',
    firewall: { platform: 'linux', active: false, portOpen: null, commands: [], configuring: false },
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
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
      if (url === '/api/network/status') {
        return Promise.resolve(makeNetworkStatus())
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the share button in the header', () => {
    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    expect(shareButton).toBeInTheDocument()
  })

  it('renders the outlined terminal work area top border with a thin connector strip', () => {
    renderApp()

    const workArea = screen.getByTestId('terminal-work-area')
    const connector = screen.getByTestId('terminal-work-area-connector')

    expect(workArea.className).toContain('relative')
    expect(workArea.className).toContain('bg-background')
    expect(connector.className).toContain('h-[3px]')
    expect(connector.className).toContain('bg-background')
  })

  it('opens setup wizard when network not configured', () => {
    const store = createTestStore()
    // Set network to unconfigured localhost
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: false,
        host: '127.0.0.1',
      })))
    })

    renderApp(store)

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    // Should show the wizard at step 1
    expect(screen.getByTestId('mock-setup-wizard')).toBeInTheDocument()
    expect(screen.getByTestId('mock-setup-wizard').dataset.initialStep).toBe('1')
  })

  it('opens setup wizard at step 2 when configured but localhost-only', () => {
    const store = createTestStore()
    // Set network to configured but localhost
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: true,
        host: '127.0.0.1',
      })))
    })

    renderApp(store)

    // Close the auto-opened wizard first (auto-show only triggers for unconfigured)
    // In this case configured=true so no auto-show, we just click Share
    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    expect(screen.getByTestId('mock-setup-wizard')).toBeInTheDocument()
    expect(screen.getByTestId('mock-setup-wizard').dataset.initialStep).toBe('2')
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

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
      expect(screen.getByText('http://192.168.1.100:3001')).toBeInTheDocument()
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })
  })

  it('shows share panel for legacy HOST env override (configured=false, host=0.0.0.0)', async () => {
    const store = createTestStore()
    act(() => {
      store.dispatch(setNetworkStatus(makeNetworkStatus({
        configured: false,
        host: '0.0.0.0',
        accessUrl: 'http://10.0.0.5:3001',
      })))
    })

    renderApp(store)

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
      expect(screen.getByText('http://10.0.0.5:3001')).toBeInTheDocument()
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

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Copy link'))

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith('http://192.168.1.100:3001')
    })
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

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Share Access')).toBeInTheDocument()
    })

    const closeButton = screen.getByLabelText('Close share panel')
    fireEvent.click(closeButton)

    await waitFor(() => {
      expect(screen.queryByText('Share Access')).not.toBeInTheDocument()
    })
  })

  it('retries network status fetch when clicked with null status', () => {
    const store = createTestStore()
    // network.status starts as null (default)

    renderApp(store)

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    // Should have dispatched fetchNetworkStatus (the loading case triggers a retry)
    // The mock API will be called for /api/network/status
    expect(mockApiGet).toHaveBeenCalledWith('/api/network/status')
  })
})

describe('App Component - Version Status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  it('shows version details in a tooltip instead of always rendering text in header', async () => {
    renderApp()

    const brandStatus = await screen.findByTestId('app-brand-status')
    expect(screen.queryByText('v0.4.5 (up to date)')).not.toBeInTheDocument()

    fireEvent.mouseEnter(brandStatus)
    await waitFor(() => {
      expect(screen.getByText('v0.4.5 (up to date)')).toBeInTheDocument()
    })
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
      if (url === '/api/sessions') return Promise.resolve([])
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

describe('App Component - Idle Warnings', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    messageHandler = null
  })

  it('shows an indicator when the server warns an idle terminal will auto-kill soon', async () => {
    renderApp()

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.idle.warning',
      terminalId: 'term-idle',
      killMinutes: 10,
      warnMinutes: 3,
      lastActivityAt: Date.now(),
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /auto-kill soon/i })).toBeInTheDocument()
    })
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
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
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
})
describe('App Bootstrap', () => {
  const originalSessionStorage = global.sessionStorage

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
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
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
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

  it('does not refetch settings or sessions after websocket connect', async () => {
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
      const sessionsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/sessions')
      const settingsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/settings')
      expect(sessionsCalls.length).toBe(1)
      expect(settingsCalls.length).toBe(1)
    })

    resolveConnect!()
    await Promise.resolve()
    await Promise.resolve()

    const sessionsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/sessions')
    const settingsCalls = mockApiGet.mock.calls.filter(([url]) => url === '/api/settings')
    expect(sessionsCalls.length).toBe(1)
    expect(settingsCalls.length).toBe(1)
  })
})

describe('App WS message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve(makeVersionInfo())
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('merges chunked sessions.updated messages (clear/append) instead of replacing', async () => {
    let handler: ((msg: any) => void) | null = null
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      handler = cb
      return () => { handler = null }
    })

    const store = createTestStore()
    renderApp(store)

    await waitFor(() => expect(handler).not.toBeNull())

    handler!({
      type: 'sessions.updated',
      clear: true,
      projects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] }],
    })
    handler!({
      type: 'sessions.updated',
      append: true,
      projects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] }],
    })

    await waitFor(() => {
      expect(store.getState().sessions.projects.map((p: any) => p.projectPath).sort()).toEqual(['/p1', '/p2'])
    })
  })

  it('ignores sessions.patch messages until a WS sessions.updated snapshot is received', async () => {
    let handler: ((msg: any) => void) | null = null
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      handler = cb
      return () => { handler = null }
    })

    const store = createTestStore()
    renderApp(store)
    await waitFor(() => expect(handler).not.toBeNull())

    handler!({
      type: 'sessions.patch',
      upsertProjects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] }],
      removeProjectPaths: [],
    })

    await waitFor(() => {
      expect(store.getState().sessions.projects).toEqual([])
    })

    handler!({
      type: 'sessions.updated',
      projects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] }],
    })

    handler!({
      type: 'sessions.patch',
      upsertProjects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 3 }] }],
      removeProjectPaths: [],
    })

    await waitFor(() => {
      expect(store.getState().sessions.projects.map((p: any) => p.projectPath).sort()).toEqual(['/p1', '/p2'])
    })
  })

  it('applies sessions.patch messages (upsert + remove) without clearing all sessions', async () => {
    let handler: ((msg: any) => void) | null = null
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      handler = cb
      return () => { handler = null }
    })

    const store = createTestStore()
    renderApp(store)
    await waitFor(() => expect(handler).not.toBeNull())

    // Seed state via a full snapshot (existing behavior).
    handler!({
      type: 'sessions.updated',
      projects: [
        { projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] },
        { projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] },
      ],
    })

    handler!({
      type: 'sessions.patch',
      upsertProjects: [{ projectPath: '/p3', sessions: [{ provider: 'claude', sessionId: 's3', updatedAt: 3 }] }],
      removeProjectPaths: ['/p1'],
    })

    await waitFor(() => {
      expect(store.getState().sessions.projects.map((p: any) => p.projectPath).sort()).toEqual(['/p2', '/p3'])
    })
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
        network: networkReducer,
      },
      middleware: (getDefault) =>
        getDefault({
          serializableCheck: {
            ignoredPaths: ['sessions.expandedProjects'],
          },
        }),
      preloadedState: {
        settings: {
          settings: defaultSettings,
          loaded: true,
          lastSavedAt: undefined,
        },
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
        },
        panes: {
          layouts: {},
          activePane: {},
        },
        network: {
          status: null,
          loading: false,
          configuring: false,
          error: null,
        },
      },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
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
})

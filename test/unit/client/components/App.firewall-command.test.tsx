// Pin for the firewall-command readiness deferral (kata dtfn, ledger A7).
//
// The App.tsx effect that sends the pending firewall command used to fire the
// terminal.input frame unconditionally and self-clear pendingFirewallCommand.
// WsClient.send can queue that frame un-ready or silently drop it, after which
// the self-clear has already destroyed the only retry state. The fix defers:
// the effect early-returns (leaving pendingFirewallCommand SET) unless
// connection.status is 'ready' AND the synchronous ws.isReady getter agrees;
// the reactive connection.status dependency re-runs the effect when readiness
// returns and the still-pending command sends then -- exactly once.
//
// This is a separate file from App.test.tsx because the pin needs its own
// SettingsView mock (one that forwards onFirewallTerminal) and vi.mock is
// file-scoped.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import type { PaneNode } from '@/store/paneTypes'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

beforeEach(() => {
  cleanup()
  sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// Mock the WebSocket client with a live synchronous `isReady` getter over
// mutable wsState (mirrors App.test.tsx; matches ws-client.ts `get isReady()`).
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
// Never resolves: keeps the bootstrap's `await ws.connect()` pending so the
// store's connection.status stays deterministically un-ready until THIS test
// flips it -- the deferral assertion must not race the bootstrap effect.
const mockConnect = vi.fn(() => new Promise<void>(() => {}))
const wsState = {
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    // Interest is transient and negotiated; this suite does not exercise it.
    sendTerminalInterest: vi.fn(() => false),
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

vi.mock('@/store/crossTabSync', () => ({
  installCrossTabSync: () => () => {},
}))

const mockApiGet = vi.fn().mockResolvedValue({})
const fetchSidebarSessionsSnapshot = vi.fn()
vi.mock('@/lib/api', () => ({
  getRecoveryInventory: async () => ({ recoverable: false, contentId: 'test', device: null, otherDevices: [], ledgerOnly: [] }),
  api: {
    get: (url: string) => mockApiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

vi.mock('lean-qr', () => ({
  generate: vi.fn().mockReturnValue({ size: 21 }),
}))
vi.mock('lean-qr/extras/svg', () => ({
  toSvgDataURL: vi.fn().mockReturnValue('data:image/svg+xml;base64,mock'),
}))

// Mock heavy child components to avoid xterm/canvas issues
vi.mock('@/components/TabContent', () => ({
  default: () => <div data-testid="mock-tab-content">Tab Content</div>,
}))

vi.mock('@/components/Sidebar', () => ({
  default: ({ view, onNavigate }: { view: string; onNavigate: (v: string) => void }) => (
    <div data-testid="mock-sidebar" data-view={view}>
      <button type="button" title="Go settings" onClick={() => onNavigate('settings')}>
        Go settings
      </button>
    </div>
  ),
  AppView: {} as any,
}))

vi.mock('@/components/HistoryView', () => ({
  default: () => <div data-testid="mock-history-view">History View</div>,
}))

// Unlike App.test.tsx's stub (which drops the prop), this SettingsView mock
// forwards onFirewallTerminal onto a button so the test can drive the flow.
vi.mock('@/components/SettingsView', () => ({
  default: ({ onFirewallTerminal }: { onFirewallTerminal?: (c: { tabId: string; command: string }) => void }) => (
    <button
      type="button"
      data-testid="fire-firewall"
      onClick={() => onFirewallTerminal?.({ tabId: 'tab-fw', command: 'sudo ufw allow 8022' })}
    >
      fire
    </button>
  ),
}))

vi.mock('@/components/OverviewView', () => ({
  default: () => <div data-testid="mock-overview-view">Overview View</div>,
}))

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createSettingsState() {
  const serverSettings = defaultServerSettings
  const localSettings = resolveLocalSettings()
  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

// The firewall effect reads only paneLayouts[tabId]: a ROOT LEAF with a
// terminalId is the "terminal is running" shape it sends against.
const firewallPaneLayout: PaneNode = {
  type: 'leaf',
  id: 'pane-fw',
  content: {
    kind: 'terminal',
    mode: 'shell',
    shell: 'system',
    createRequestId: 'req-fw',
    status: 'running',
    terminalId: 'term-fw',
  },
}

function createTestStore(connectionStatus: 'connecting' | 'ready') {
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
        tabs: [{ id: 'tab-fw', mode: 'shell' }],
        activeTabId: 'tab-fw',
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        isLoading: false,
        error: null,
      },
      connection: {
        status: connectionStatus,
        lastError: undefined,
        platform: null,
        availableClis: {},
        serverInstanceId: undefined,
      },
      panes: {
        layouts: { 'tab-fw': firewallPaneLayout },
        activePane: { 'tab-fw': 'pane-fw' },
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

function renderApp(store: ReturnType<typeof createTestStore>) {
  return render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}

describe('App firewall command readiness deferral (kata dtfn)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    wsState.isReady = false
    wsState.serverInstanceId = undefined
    mockConnect.mockImplementation(() => new Promise<void>(() => {}))
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
        })
      }
      if (typeof url === 'string' && url.startsWith('/api/sessions')) return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('defers the firewall command while un-ready and sends it exactly once after ready', async () => {
    // Preloaded 'connecting' (a real pre-ready production status) and
    // wsState.isReady = false; mockConnect never resolves, so the bootstrap
    // cannot flip the status to 'ready' behind the test's back.
    const store = createTestStore('connecting')
    renderApp(store)
    fireEvent.click(screen.getByTitle('Go settings'))
    // SettingsView is lazy -- findBy waits out the Suspense.
    fireEvent.click(await screen.findByTestId('fire-firewall'))

    // Guard: the harness must actually be un-ready here.
    expect(store.getState().connection.status).not.toBe('ready')
    // RED pre-fix: today the effect has already sent, un-ready.
    expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.input' }))

    act(() => {
      wsState.isReady = true
      store.dispatch(setStatus('ready'))
    })
    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'term-fw', data: 'sudo ufw allow 8022\n' })
    })
    expect(mockSend.mock.calls.filter((c) => c[0]?.type === 'terminal.input')).toHaveLength(1)
  })

  it('sends the firewall command immediately, exactly once, when already ready', async () => {
    wsState.isReady = true
    const store = createTestStore('ready')
    renderApp(store)
    fireEvent.click(screen.getByTitle('Go settings'))
    fireEvent.click(await screen.findByTestId('fire-firewall'))

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'term-fw', data: 'sudo ufw allow 8022\n' })
    })
    expect(mockSend.mock.calls.filter((c) => c[0]?.type === 'terminal.input')).toHaveLength(1)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer, { type TabsState } from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import { networkReducer, type NetworkState } from '@/store/networkSlice'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
  setHelloExtensionProvider: vi.fn(),
}))

const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

vi.mock('@/hooks/useTurnCompletionNotifications', () => ({
  useTurnCompletionNotifications: () => {},
}))

vi.mock('@/store/crossTabSync', () => ({
  installCrossTabSync: () => () => {},
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

vi.mock('@/components/AuthRequiredModal', () => ({
  AuthRequiredModal: () => null,
}))

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

vi.mock('@/components/TabContent', () => ({
  default: ({ tabId, hidden }: { tabId: string; hidden?: boolean }) => (
    <div data-testid={`tab-content-${tabId}`} data-hidden={hidden ? 'true' : 'false'}>
      {tabId === 'tab-fresh' && !hidden ? (
        <textarea aria-label="Chat message input" />
      ) : (
        <div>{tabId}</div>
      )}
    </div>
  ),
}))

type TestStore = ReturnType<typeof makeStore>

function makeStore(activeTabId: TabsState['activeTabId'] = 'tab-fresh') {
  const tabsState: TabsState = {
    tabs: [
      {
        id: 'tab-shell',
        createRequestId: 'req-shell',
        title: 'Shell Tab',
        mode: 'shell',
        shell: 'system',
        status: 'running',
        createdAt: Date.now(),
      },
      {
        id: 'tab-fresh',
        createRequestId: 'req-fresh',
        title: 'FreshClaude Tab',
        mode: 'claude',
        shell: 'system',
        status: 'running',
        createdAt: Date.now(),
      },
      {
        id: 'tab-other',
        createRequestId: 'req-other',
        title: 'Other Tab',
        mode: 'shell',
        shell: 'system',
        status: 'running',
        createdAt: Date.now(),
      },
    ],
    activeTabId,
    renameRequestTabId: null,
  }

  const networkState: NetworkState = {
    status: null,
    loading: false,
    configuring: false,
    error: null,
  }

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
        settings: {
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, collapsed: true },
        },
        loaded: true,
        lastSavedAt: null,
      },
      tabs: tabsState,
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
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      network: networkState,
    },
  })
}

function renderApp(store: TestStore) {
  return render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}

describe('agent chat tab shortcut focus (e2e)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token')
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, collapsed: true },
        })
      }
      if (url === '/api/platform') {
        return Promise.resolve({
          platform: 'linux',
          availableClis: { codex: true, claude: true },
        })
      }
      if (url === '/api/version') {
        return Promise.resolve({
          currentVersion: '0.4.5',
          updateCheck: {
            updateAvailable: false,
            currentVersion: '0.4.5',
            latestVersion: '0.4.5',
            releaseUrl: 'https://github.com/danshapiro/freshell/releases/latest',
            error: null,
          },
        })
      }
      if (url === '/api/network/status') {
        return Promise.resolve({
          configured: true,
          host: '0.0.0.0',
          port: 3001,
          lanIps: ['192.168.1.100'],
          machineHostname: 'test-host',
          firewall: { platform: 'linux', active: false, portOpen: null, commands: [], configuring: false },
          rebinding: false,
          devMode: false,
          accessUrl: 'http://192.168.1.100:3001',
        })
      }
      if (typeof url === 'string' && url.startsWith('/api/sessions')) {
        return Promise.resolve({ projects: [] })
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('switches to the next tab when the FreshClaude composer is focused', async () => {
    const store = makeStore('tab-fresh')
    renderApp(store)

    await waitFor(() => {
      expect(wsMocks.connect).toHaveBeenCalled()
    })

    const textarea = await screen.findByRole('textbox', { name: 'Chat message input' })
    textarea.focus()

    expect(document.activeElement).toBe(textarea)

    fireEvent.keyDown(textarea, { code: 'BracketRight', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-other')
    })
  })

  it('switches to the previous tab when the FreshClaude composer is focused', async () => {
    const store = makeStore('tab-fresh')
    renderApp(store)

    await waitFor(() => {
      expect(wsMocks.connect).toHaveBeenCalled()
    })

    const textarea = await screen.findByRole('textbox', { name: 'Chat message input' })
    textarea.focus()

    expect(document.activeElement).toBe(textarea)

    fireEvent.keyDown(textarea, { code: 'BracketLeft', ctrlKey: true, shiftKey: true })

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-shell')
    })
  })
})

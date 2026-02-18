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
import idleWarningsReducer from '@/store/idleWarningsSlice'
import { networkReducer } from '@/store/networkSlice'

const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockApiGet = vi.fn().mockResolvedValue({})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    onReconnect: mockOnReconnect,
    connect: mockConnect,
    setHelloExtensionProvider: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => mockApiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
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
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
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

describe('auth required bootstrap flow (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
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
})

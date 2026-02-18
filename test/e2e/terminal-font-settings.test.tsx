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
import { networkReducer } from '@/store/networkSlice'
import { LOCAL_TERMINAL_FONT_KEY } from '@/lib/terminal-fonts'

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

function createTestStore() {
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
        tabs: [{ id: 'tab-1', mode: 'shell' }],
        activeTabId: 'tab-1',
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
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
      network: { status: null, loading: false, configuring: false, error: null },
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
    localStorage.setItem(LOCAL_TERMINAL_FONT_KEY, 'Fira Code')

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'Consolas' },
        })
      }
      if (url === '/api/platform') {
        return Promise.resolve({ platform: 'darwin' })
      }
      if (url === '/api/sessions') {
        return Promise.resolve([])
      }
      return Promise.resolve({})
    })

    const store = createTestStore()
    renderApp(store)

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/settings')
    })

    expect(store.getState().settings.settings.terminal.fontFamily).toBe('Fira Code')
  })

  it('ignores server font when no local preference exists', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'Consolas' },
        })
      }
      if (url === '/api/platform') {
        return Promise.resolve({ platform: 'darwin' })
      }
      if (url === '/api/sessions') {
        return Promise.resolve([])
      }
      return Promise.resolve({})
    })

    const store = createTestStore()
    renderApp(store)

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/api/settings')
    })

    expect(store.getState().settings.settings.terminal.fontFamily).toBe('monospace')
    expect(localStorage.getItem(LOCAL_TERMINAL_FONT_KEY)).toBe('monospace')
  })
})

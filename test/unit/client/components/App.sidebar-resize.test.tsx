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
import { networkReducer } from '@/store/networkSlice'

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
const mockApiPatch = vi.fn().mockResolvedValue({})
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => mockApiGet(url),
    patch: (url: string, data: any) => mockApiPatch(url, data),
    post: vi.fn().mockResolvedValue({}),
  },
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
    width,
  }: {
    view: string
    onNavigate: (v: string) => void
    onToggleSidebar?: () => void
    width?: number
  }) => (
    <div data-testid="mock-sidebar" data-view={view} data-width={width} style={{ width: `${width}px` }}>
      <button title="Hide sidebar" onClick={() => onToggleSidebar?.()}>
        Hide sidebar
      </button>
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

// Mock the useThemeEffect hook
vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))
vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

function createTestStore(options?: {
  sidebarWidth?: number
  sidebarCollapsed?: boolean
}) {
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
          sidebar: {
            ...defaultSettings.sidebar,
            width: options?.sidebarWidth ?? 288,
            collapsed: options?.sidebarCollapsed ?? false,
          },
        },
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

describe('App Component - Sidebar Resize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // Default: desktop viewport (matchMedia matches=false is the default)

    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  describe('sidebar toggle button', () => {
    it('renders sidebar toggle button in header', () => {
      renderApp()
      const toggleButton = screen.getByTitle('Hide sidebar')
      expect(toggleButton).toBeInTheDocument()
    })

    it('shows "Show sidebar" title when sidebar is collapsed', () => {
      const store = createTestStore({ sidebarCollapsed: true })
      renderApp(store)
      const toggleButton = screen.getByTitle('Show sidebar')
      expect(toggleButton).toBeInTheDocument()
    })

    it('hides sidebar when toggle button is clicked', async () => {
      const store = createTestStore({ sidebarCollapsed: false })
      renderApp(store)

      // Sidebar should be visible initially
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()

      // Click toggle button
      const toggleButton = screen.getByTitle('Hide sidebar')
      fireEvent.click(toggleButton)

      // Sidebar should be hidden
      await waitFor(() => {
        expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
      })
    })

    it('shows sidebar when toggle button is clicked while collapsed', async () => {
      const store = createTestStore({ sidebarCollapsed: true })
      renderApp(store)

      // Sidebar should be hidden initially
      expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()

      // Click toggle button
      const toggleButton = screen.getByTitle('Show sidebar')
      fireEvent.click(toggleButton)

      // Sidebar should be visible
      await waitFor(() => {
        expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
      })
    })

    it('persists collapse state to settings API', async () => {
      renderApp()

      const toggleButton = screen.getByTitle('Hide sidebar')
      fireEvent.click(toggleButton)

      await waitFor(() => {
        expect(mockApiPatch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
          sidebar: expect.objectContaining({
            collapsed: true,
          }),
        }))
      })
    })
  })

  describe('sidebar width', () => {
    it('passes width to Sidebar component', () => {
      const store = createTestStore({ sidebarWidth: 350 })
      renderApp(store)

      const sidebar = screen.getByTestId('mock-sidebar')
      expect(sidebar.getAttribute('data-width')).toBe('350')
    })

    it('uses default width of 288 when not specified', () => {
      renderApp()

      const sidebar = screen.getByTestId('mock-sidebar')
      expect(sidebar.getAttribute('data-width')).toBe('288')
    })
  })

  describe('mobile responsive behavior', () => {
    afterEach(() => {
      ;(globalThis as any).setMobileForTest(false)
    })

    it('auto-collapses sidebar on mobile viewport', async () => {
      const store = createTestStore({ sidebarCollapsed: false })

      // Simulate mobile viewport via matchMedia mock
      act(() => {
        ;(globalThis as any).setMobileForTest(true)
      })

      renderApp(store)

      // Sidebar should auto-collapse on mobile
      await waitFor(() => {
        expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
      })
    })
  })
})

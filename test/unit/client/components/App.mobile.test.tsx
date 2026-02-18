import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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
  default: ({
    view,
    fullWidth,
    onToggleSidebar,
  }: {
    view: string
    fullWidth?: boolean
    onToggleSidebar?: () => void
  }) => (
    <div data-testid="mock-sidebar" data-view={view} data-full-width={fullWidth ? 'true' : 'false'}>
      <button
        title="Hide sidebar"
        onClick={() => onToggleSidebar?.()}
        className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
      >
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

describe('App Header - Mobile Touch Targets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
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

  it('sidebar toggle button has 44px mobile touch target classes', () => {
    renderApp()

    // Default state is sidebar not collapsed, so title is "Hide sidebar"
    const sidebarToggle = screen.getByTitle('Hide sidebar')
    expect(sidebarToggle.className).toContain('min-h-11')
    expect(sidebarToggle.className).toContain('min-w-11')
  })

  it('show-sidebar button has mobile touch target and centering classes when collapsed', async () => {
    ;(globalThis as any).setMobileForTest(true)
    renderApp()

    const showButton = await screen.findByTitle('Show sidebar')
    expect(showButton.className).toContain('min-h-11')
    expect(showButton.className).toContain('min-w-11')
    expect(showButton.className).toContain('flex')
    expect(showButton.className).toContain('items-center')
    expect(showButton.className).toContain('justify-center')
  })

  it('header buttons restore desktop sizing with md: breakpoint classes', () => {
    renderApp()

    const sidebarToggle = screen.getByTitle('Hide sidebar')
    expect(sidebarToggle.className).toContain('md:min-h-0')
    expect(sidebarToggle.className).toContain('md:min-w-0')
  })

  it('renders sidebar in non-full-width mode on desktop', () => {
    renderApp()
    expect(screen.getByTestId('mock-sidebar')).toHaveAttribute('data-full-width', 'false')
  })
})

describe('App Mobile - Sidebar Backdrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
    // Set mobile viewport via matchMedia mock
    ;(globalThis as any).setMobileForTest(true)
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('shows backdrop overlay when sidebar is open on mobile', async () => {
    renderApp()

    // Wait for auto-collapse on mobile
    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    // Open the sidebar
    fireEvent.click(screen.getByTitle('Show sidebar'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
    })

    // Backdrop should be present
    const backdrop = screen.getByRole('presentation')
    expect(backdrop.className).toContain('bg-black/50')
    expect(backdrop.className).toContain('absolute')
    expect(backdrop.className).toContain('inset-0')

    // On mobile, sidebar should be rendered in full-width mode.
    expect(screen.getByTestId('mock-sidebar')).toHaveAttribute('data-full-width', 'true')
  })

  it('closes sidebar when backdrop is clicked', async () => {
    renderApp()

    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Show sidebar'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
    })

    const backdrop = screen.getByRole('presentation')
    fireEvent.click(backdrop)

    await waitFor(() => {
      expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })
  })

  it('closes sidebar on touchEnd and calls preventDefault for iOS reliability', async () => {
    renderApp()

    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Show sidebar'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
    })

    const backdrop = screen.getByRole('presentation')

    // Fire touchEnd — React's fireEvent returns the event object, but to
    // check preventDefault we need to create it ourselves.
    const touchEndEvent = new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
    })
    const preventDefaultSpy = vi.spyOn(touchEndEvent, 'preventDefault')

    backdrop.dispatchEvent(touchEndEvent)

    expect(preventDefaultSpy).toHaveBeenCalled()

    await waitFor(() => {
      expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })
  })

  it('closes sidebar when Escape is pressed on backdrop', async () => {
    renderApp()

    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Show sidebar'))

    await waitFor(() => {
      expect(screen.getByTestId('mock-sidebar')).toBeInTheDocument()
    })

    const backdrop = screen.getByRole('presentation')
    fireEvent.keyDown(backdrop, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByTestId('mock-sidebar')).not.toBeInTheDocument()
    })
  })
})

describe('App Mobile - Header Pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
    ;(globalThis as any).setMobileForTest(true)
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('keeps header onscreen by making pane area shrinkable in mobile layout', async () => {
    renderApp()

    const terminalWorkArea = await screen.findByTestId('terminal-work-area')
    const paneColumn = screen.getByTestId('app-pane-column')

    expect(terminalWorkArea.className).toMatch(/\bmin-h-0\b/)
    expect(paneColumn.className).toMatch(/\bmin-h-0\b/)
    expect(paneColumn.className).toMatch(/\boverflow-hidden\b/)
  })
})

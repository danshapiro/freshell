import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'

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
  }),
}))

// Mock the api module
vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
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

describe('App Component - Share Button', () => {
  const originalNavigator = global.navigator
  const originalSessionStorage = global.sessionStorage

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset sessionStorage mock
    const sessionStorageMock: Record<string, string> = {
      authToken: 'test-token-abc123',
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
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    })
    Object.defineProperty(global, 'sessionStorage', {
      value: originalSessionStorage,
      writable: true,
    })
  })

  it('renders the share button in the header', () => {
    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    expect(shareButton).toBeInTheDocument()
  })

  it('uses Web Share API when available', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Freshell Terminal',
          text: 'Access my terminal session',
          url: expect.stringContaining('token=test-token-abc123'),
        })
      )
    })
  })

  it('falls back to clipboard when Web Share API is unavailable', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: undefined,
        clipboard: {
          writeText: mockWriteText,
        },
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringContaining('token=test-token-abc123'))
    })
  })

  it('includes auth token in shared URL', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      const callArgs = mockShare.mock.calls[0][0]
      const url = new URL(callArgs.url)
      expect(url.searchParams.get('token')).toBe('test-token-abc123')
    })
  })

  it('handles missing auth token gracefully', async () => {
    // Override sessionStorage to return null for authToken
    Object.defineProperty(global, 'sessionStorage', {
      value: {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      writable: true,
    })

    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      const callArgs = mockShare.mock.calls[0][0]
      // URL should not have token param when token is missing
      const url = new URL(callArgs.url)
      expect(url.searchParams.has('token')).toBe(false)
    })
  })

  it('handles Web Share API rejection gracefully', async () => {
    const mockShare = vi.fn().mockRejectedValue(new Error('User cancelled'))
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        clipboard: {
          writeText: mockWriteText,
        },
      },
      writable: true,
    })

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    // Should not throw, and should not fall back to clipboard on user cancel
    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
    })

    consoleSpy.mockRestore()
  })
})

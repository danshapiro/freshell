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
import idleWarningsReducer from '@/store/idleWarningsSlice'
import versionReducer from '@/store/versionSlice'

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
      version: versionReducer,
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

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    // Auth token is now stored in localStorage via @/lib/auth
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    // Mock API responses
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      if (url === '/api/lan-info') {
        return Promise.resolve({ ips: ['192.168.1.100'] })
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      writable: true,
    })
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

  it('uses Web Share API when available (non-Windows)', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel', // Non-Windows platform
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Welcome to your freshell!',
          text: expect.stringContaining('You need to use this on your local network or with a VPN.'),
        })
      )
      // URL is embedded in text with LAN IP and token
      const callArgs = mockShare.mock.calls[0][0]
      expect(callArgs.text).toContain('192.168.1.100')
      expect(callArgs.text).toContain('token=test-token-abc123')
    })
  })

  it('falls back to clipboard when Web Share API is unavailable (non-Windows)', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: undefined,
        platform: 'MacIntel',
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
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringContaining('You need to use this on your local network or with a VPN.'))
    })
  })

  it('includes auth token in shared URL (non-Windows)', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel',
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      const callArgs = mockShare.mock.calls[0][0]
      // Token is in the text (which contains the URL)
      expect(callArgs.text).toContain('token=test-token-abc123')
    })
  })

  it('handles missing auth token gracefully (non-Windows)', async () => {
    // Remove auth token from localStorage
    localStorage.removeItem('freshell.auth-token')

    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel',
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      const callArgs = mockShare.mock.calls[0][0]
      // Text should not contain token param when token is missing
      expect(callArgs.text).not.toContain('token=')
    })
  })

  it('handles Web Share API rejection gracefully (non-Windows)', async () => {
    const mockShare = vi.fn().mockRejectedValue(new Error('User cancelled'))
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel',
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

  it('shows modal instead of Web Share API on Windows', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'Win32',
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    // On Windows, should show modal instead of calling navigator.share
    await waitFor(() => {
      expect(screen.getByText('Welcome to your freshell!')).toBeInTheDocument()
      expect(screen.getByText('You need to use this on your local network or with a VPN.')).toBeInTheDocument()
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    // navigator.share should NOT have been called
    expect(mockShare).not.toHaveBeenCalled()
  })

  it('Windows modal displays URL with LAN IP and token', async () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        platform: 'Win32',
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      // Modal should contain URL with LAN IP and token
      const codeElement = screen.getByRole('code') || screen.getByText(/192\.168\.1\.100/)
      expect(codeElement.textContent).toContain('192.168.1.100')
      expect(codeElement.textContent).toContain('token=test-token-abc123')
    })
  })

  it('Windows modal copy button copies URL to clipboard', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        platform: 'Win32',
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
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    const copyButton = screen.getByText('Copy link')
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringContaining('192.168.1.100'))
      expect(mockWriteText).toHaveBeenCalledWith(expect.stringContaining('token=test-token-abc123'))
    })
  })

  it('Windows modal shows "Copied!" after copying', async () => {
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        platform: 'Win32',
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
      expect(screen.getByText('Copy link')).toBeInTheDocument()
    })

    const copyButton = screen.getByText('Copy link')
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument()
    })
  })

  it('Windows modal can be closed by clicking X button', async () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        platform: 'Win32',
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Welcome to your freshell!')).toBeInTheDocument()
    })

    // Find and click the close button (the X button in the header)
    const modalHeader = screen.getByText('Welcome to your freshell!').parentElement
    const xButton = modalHeader?.querySelector('button')
    if (xButton) {
      fireEvent.click(xButton)
    }

    await waitFor(() => {
      expect(screen.queryByText('Welcome to your freshell!')).not.toBeInTheDocument()
    })
  })

  it('Windows modal can be closed by clicking backdrop', async () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        platform: 'Win32',
        clipboard: {
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      },
      writable: true,
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(screen.getByText('Welcome to your freshell!')).toBeInTheDocument()
    })

    // Click the backdrop (the outer div with the dark overlay)
    const backdrop = screen.getByText('Welcome to your freshell!').closest('.fixed')
    if (backdrop) {
      fireEvent.click(backdrop)
    }

    await waitFor(() => {
      expect(screen.queryByText('Welcome to your freshell!')).not.toBeInTheDocument()
    })
  })

  it('uses LAN IP from server in share URL', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel',
      },
      writable: true,
    })

    // Mock specific LAN IP
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      if (url === '/api/lan-info') {
        return Promise.resolve({ ips: ['10.0.0.50'] })
      }
      return Promise.resolve({})
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      const callArgs = mockShare.mock.calls[0][0]
      expect(callArgs.text).toContain('10.0.0.50')
    })
  })

  it('falls back to current host if LAN info API fails', async () => {
    const mockShare = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        share: mockShare,
        platform: 'MacIntel',
      },
      writable: true,
    })

    // Mock API failure
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      if (url === '/api/lan-info') {
        return Promise.reject(new Error('Network error'))
      }
      return Promise.resolve({})
    })

    renderApp()

    const shareButton = screen.getByTitle('Share LAN access')
    fireEvent.click(shareButton)

    await waitFor(() => {
      expect(mockShare).toHaveBeenCalled()
      // Should still have called share (with localhost fallback)
      const callArgs = mockShare.mock.calls[0][0]
      expect(callArgs.text).toContain('token=test-token-abc123')
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
})

describe('App Component - Mobile Sidebar', () => {
  const originalInnerWidth = window.innerWidth

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      writable: true,
    })
  })

  it('auto-collapses on mobile but does not re-collapse after user opens it', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, writable: true })

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
        version: versionReducer,
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

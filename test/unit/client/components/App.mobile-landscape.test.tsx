import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    onReconnect: mockOnReconnect,
    connect: mockConnect,
    setHelloExtensionProvider: vi.fn(),
  }),
}))

const mockApiGet = vi.fn().mockResolvedValue({})
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

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

vi.mock('@use-gesture/react', () => ({
  useDrag: () => () => ({}),
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
      settings: { settings: defaultSettings, loaded: true, lastSavedAt: undefined },
      tabs: { tabs: [{ id: 'tab-1', mode: 'shell' }], activeTabId: 'tab-1' },
      sessions: { projects: [], expandedProjects: new Set<string>(), wsSnapshotReceived: false, isLoading: false, error: null },
      connection: { status: 'ready' as const, lastError: undefined },
      panes: { layouts: {}, activePane: {} },
      idleWarnings: { warnings: {} },
      network: { status: null, loading: false, configuring: false, error: null },
    },
  })
}

describe('App mobile landscape mode', () => {
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('freshell.auth-token', 'test-token-abc123')
    ;(globalThis as any).setMobileForTest(true)
    Object.defineProperty(window, 'innerHeight', { value: 420, configurable: true })
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
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
  })

  it('uses compact top status bar in mobile landscape terminal view', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    expect(screen.getByText('freshell')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument()
    expect(screen.queryByTitle('Hide sidebar')).not.toBeInTheDocument()
  })

  it('reveals the tab strip when swiping down from the top of terminal work area', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    expect(screen.queryByLabelText('Open tab switcher')).not.toBeInTheDocument()

    const terminalWorkArea = screen.getByTestId('terminal-work-area')
    fireEvent.touchStart(terminalWorkArea, {
      touches: [{ identifier: 1, clientX: 12, clientY: 8 }],
    })
    fireEvent.touchEnd(terminalWorkArea, {
      changedTouches: [{ identifier: 1, clientX: 12, clientY: 96 }],
    })

    expect(screen.getByLabelText('Open tab switcher')).toBeInTheDocument()
  })
})

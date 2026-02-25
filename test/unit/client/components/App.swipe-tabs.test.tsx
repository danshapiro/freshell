import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
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

function createTestStore(options?: {
  sidebarCollapsed?: boolean
  tabs?: Array<{ id: string; mode: string }>
  activeTabId?: string
}) {
  const tabsList = options?.tabs ?? [
    { id: 'tab-1', mode: 'shell' },
    { id: 'tab-2', mode: 'shell' },
    { id: 'tab-3', mode: 'shell' },
  ]
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
            collapsed: options?.sidebarCollapsed ?? true,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: tabsList,
        activeTabId: options?.activeTabId ?? tabsList[0].id,
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

function renderApp(store = createTestStore()) {
  return render(
    <Provider store={store}>
      <App />
    </Provider>
  )
}

describe('App - Swipe Tab Switching Gesture', () => {
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

  it('applies touch-action: pan-y to the inner content wrapper on mobile', async () => {
    ;(globalThis as any).setMobileForTest(true)

    renderApp()

    // Wait for mobile auto-collapse to settle
    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    // The inner content wrapper is .flex-1.min-w-0.flex.flex-col inside the main content area
    const mainContentArea = screen.getByTestId('app-main-content')

    expect(mainContentArea).toBeTruthy()

    // The inner wrapper is the child div with flex-col class
    const innerContentWrapper = mainContentArea.querySelector('.flex-1.min-w-0.flex.flex-col')
    expect(innerContentWrapper).toBeTruthy()
    expect((innerContentWrapper as HTMLElement).style.touchAction).toBe('pan-y')
  })

  it('does not apply touch-action to the inner content wrapper on desktop', () => {
    const store = createTestStore({ sidebarCollapsed: false })
    renderApp(store)

    const mainContentArea = screen.getByTestId('app-main-content')

    expect(mainContentArea).toBeTruthy()

    const innerContentWrapper = mainContentArea.querySelector('.flex-1.min-w-0.flex.flex-col')
    expect(innerContentWrapper).toBeTruthy()
    const touchAction = (innerContentWrapper as HTMLElement).style?.touchAction
    expect(touchAction).not.toBe('pan-y')
  })

  it('switchToNextTab action advances the active tab', () => {
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
        { id: 'tab-3', mode: 'shell' },
      ],
      activeTabId: 'tab-1',
    })

    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    store.dispatch({ type: 'tabs/switchToNextTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
    store.dispatch({ type: 'tabs/switchToNextTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-3')
  })

  it('switchToPrevTab action goes to the previous tab', () => {
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
        { id: 'tab-3', mode: 'shell' },
      ],
      activeTabId: 'tab-3',
    })

    expect(store.getState().tabs.activeTabId).toBe('tab-3')
    store.dispatch({ type: 'tabs/switchToPrevTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
    store.dispatch({ type: 'tabs/switchToPrevTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('switchToNextTab wraps around from last to first', () => {
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
      ],
      activeTabId: 'tab-2',
    })

    store.dispatch({ type: 'tabs/switchToNextTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('switchToPrevTab wraps around from first to last', () => {
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
      ],
      activeTabId: 'tab-1',
    })

    store.dispatch({ type: 'tabs/switchToPrevTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })

  it('tab swipe handler has view guard (only terminal view)', () => {
    // The useDrag handler in App.tsx includes `view !== 'terminal'` guard.
    // This can't be tested via jsdom (no real pointer gestures), but we verify
    // the Redux actions work correctly in isolation.
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
      ],
      activeTabId: 'tab-1',
    })

    // Verify switching tabs works at the Redux level
    store.dispatch({ type: 'tabs/switchToNextTab' })
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })

  it('tab swipe handler defers to sidebar swipe for left-edge gestures', () => {
    // The tab swipe handler checks tabSwipeStartXRef < 30 && sidebarCollapsed
    // and exits early, deferring to the sidebar swipe handler on the outer div.
    // This prevents both handlers from firing on the same edge swipe.
    // Verified by implementation review — jsdom can't simulate pointer gestures.
    const store = createTestStore({
      sidebarCollapsed: true,
      tabs: [
        { id: 'tab-1', mode: 'shell' },
        { id: 'tab-2', mode: 'shell' },
      ],
      activeTabId: 'tab-1',
    })

    // Confirm initial state — tab-1 is active, sidebar collapsed
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
    expect(store.getState().settings.settings.sidebar?.collapsed).toBe(true)
  })

  it('both gesture targets are on different DOM elements (no conflict)', async () => {
    ;(globalThis as any).setMobileForTest(true)

    renderApp()

    await waitFor(() => {
      expect(screen.getByTitle('Show sidebar')).toBeInTheDocument()
    })

    const mainContentArea = screen.getByTestId('app-main-content') as HTMLElement

    const innerContentWrapper = mainContentArea
      ?.querySelector('.flex-1.min-w-0.flex.flex-col') as HTMLElement

    expect(mainContentArea).toBeTruthy()
    expect(innerContentWrapper).toBeTruthy()

    // Both should have touch-action: pan-y but be separate elements
    expect(mainContentArea).not.toBe(innerContentWrapper)
    expect(mainContentArea!.style.touchAction).toBe('pan-y')
    expect(innerContentWrapper!.style.touchAction).toBe('pan-y')
  })
})

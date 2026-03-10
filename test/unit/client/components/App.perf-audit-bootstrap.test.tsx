import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import { networkReducer } from '@/store/networkSlice'

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
  isApiUnauthorizedError: (err: unknown) => !!err && typeof err === 'object' && (err as { status?: number }).status === 401,
}))

vi.mock('@/components/Sidebar', () => ({
  default: () => <div data-testid="mock-sidebar">Sidebar</div>,
  AppView: {} as never,
}))
vi.mock('@/components/TabContent', () => ({
  default: () => <div data-testid="mock-tab-content">Tab Content</div>,
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
  useThemeEffect: () => undefined,
}))

function createStore() {
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
        loaded: false,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: [{ id: 'tab-1', title: 'Tab 1', mode: 'shell', createRequestId: 'tab-1', status: 'creating' }],
        activeTabId: 'tab-1',
      },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        isLoading: false,
        error: null,
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

function readPerfAuditSnapshot() {
  return window.__FRESHELL_TEST_HARNESS__?.getPerfAuditSnapshot() ?? null
}

describe('App perf audit milestones', () => {
  beforeEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/?e2e=1&perfAudit=1')
    apiGet.mockReset()
    wsMocks.connect.mockClear()
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.reject({ status: 401, message: 'Unauthorized' })
      }
      if (url === '/api/platform') {
        return Promise.resolve({ platform: 'linux' })
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, '', '/')
  })

  it('marks auth-required visibility when the auth modal is shown in perf-audit mode', async () => {
    render(
      <Provider store={createStore()}>
        <App />
      </Provider>,
    )

    expect(await screen.findByText(/authentication required/i)).toBeVisible()

    await waitFor(() => {
      expect(readPerfAuditSnapshot()?.milestones['app.auth_required_visible']).toBeTypeOf('number')
    })
  })
})

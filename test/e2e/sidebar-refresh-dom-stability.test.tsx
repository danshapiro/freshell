import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import { layoutMirrorMiddleware } from '@/store/layoutMirrorMiddleware'
import * as sessionsThunks from '@/store/sessionsThunks'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type ServerSettingsPatch,
} from '@shared/settings'

const _resetSessionWindowThunkState = ((sessionsThunks as any)._resetSessionWindowThunkState ?? (() => {})) as () => void

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

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

const wsHandlers = vi.hoisted(() => new Set<(msg: any) => void>())
const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}))

const apiGet = vi.hoisted(() => vi.fn())
const fetchSidebarSessionsSnapshot = vi.hoisted(() => vi.fn())
const searchSessions = vi.hoisted(() => vi.fn().mockResolvedValue({ results: [] }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: (handler: (msg: any) => void) => {
      wsHandlers.add(handler)
      return () => wsHandlers.delete(handler)
    },
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
    get isReady() {
      return wsMocks.isReady
    },
    get serverInstanceId() {
      return wsMocks.serverInstanceId
    },
    get state() {
      return wsMocks.isReady ? 'ready' : 'connected'
    },
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  searchSessions: (...args: any[]) => searchSessions(...args),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

function broadcastWs(msg: any) {
  for (const handler of Array.from(wsHandlers)) {
    handler(msg)
  }
}

function createStore(options?: {
  tabs?: Array<Record<string, unknown>>
  panes?: {
    layouts: Record<string, unknown>
    activePane: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
    paneTitleSetByUser?: Record<string, Record<string, boolean>>
    renameRequestTabId?: string | null
    renameRequestPaneId?: string | null
    zoomedPane?: Record<string, string>
  }
  connection?: Partial<{
    status: 'disconnected' | 'connecting' | 'connected' | 'ready'
    serverInstanceId?: string
  }>
  sessions?: Record<string, unknown>
}) {
  const tabs = options?.tabs ?? [{ id: 'tab-1', mode: 'shell', title: 'Tab 1' }]
  const panes = {
    layouts: options?.panes?.layouts ?? {},
    activePane: options?.panes?.activePane ?? {},
    paneTitles: options?.panes?.paneTitles ?? {},
    paneTitleSetByUser: options?.panes?.paneTitleSetByUser ?? {},
    renameRequestTabId: options?.panes?.renameRequestTabId ?? null,
    renameRequestPaneId: options?.panes?.renameRequestPaneId ?? null,
    zoomedPane: options?.panes?.zoomedPane ?? {},
  }

  const defaultServerSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const serverSettings = mergeServerSettings(defaultServerSettings, {})
  const localSettings = resolveLocalSettings({
    sidebar: {
      collapsed: false,
      width: 288,
      sortMode: 'recency',
    },
  })

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      sessionActivity: sessionActivityReducer,
      network: networkReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }).concat(layoutMirrorMiddleware),
    preloadedState: {
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs,
        activeTabId: (tabs[0]?.id as string | undefined) ?? null,
      },
      connection: {
        status: options?.connection?.status ?? 'disconnected',
        lastError: undefined,
        platform: null,
        availableClis: {},
        serverInstanceId: options?.connection?.serverInstanceId,
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        isLoading: false,
        error: null,
        windows: {},
        ...options?.sessions,
      },
      panes,
      sessionActivity: {
        sessions: {},
      },
      network: {
        status: null,
        loading: false,
        configuring: false,
        error: null,
      },
      tabRegistry: {
        deviceId: 'device-test',
        deviceLabel: 'device-test',
        deviceAliases: {},
        localOpen: [],
        remoteOpen: [],
        closed: [],
        localClosed: {},
        searchRangeDays: 30,
        loading: false,
      },
      terminalMeta: { byTerminalId: {} },
      extensions: { entries: [] },
    },
  })
}

describe('sidebar refresh DOM stability (e2e)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    wsHandlers.clear()
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined

    fetchSidebarSessionsSnapshot.mockReset()
    searchSessions.mockClear()

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: createDefaultServerSettings({
            loggingDebug: defaultSettings.logging.debug,
          }),
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') {
        return Promise.resolve(createDefaultServerSettings({
          loggingDebug: defaultSettings.logging.debug,
        }) as ServerSettingsPatch)
      }
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve({})
      if (url === '/api/network/status') return Promise.resolve(null)
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    _resetSessionWindowThunkState()
    cleanup()
  })

  it('keeps unchanged sidebar rows mounted when sessions.changed triggers a background refresh', async () => {
    const initialProjects = [
      {
        projectPath: '/proj',
        sessions: [
          { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
          { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
        ],
      },
    ]

    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [
        {
          projectPath: '/proj',
          sessions: [
            { provider: 'codex', sessionId: 'new-top', projectPath: '/proj', lastActivityAt: 50, title: 'New Top' },
            { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
            { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
          ],
        },
      ],
      totalSessions: 3,
      oldestIncludedTimestamp: 30,
      oldestIncludedSessionId: 'codex:stable-b',
      hasMore: false,
    })

    const store = createStore({
      sessions: {
        projects: initialProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        totalSessions: 2,
        oldestLoadedTimestamp: 30,
        oldestLoadedSessionId: 'codex:stable-b',
        hasMore: false,
        windows: {
          sidebar: {
            projects: initialProjects,
            lastLoadedAt: Date.now(),
            totalSessions: 2,
            oldestLoadedTimestamp: 30,
            oldestLoadedSessionId: 'codex:stable-b',
            hasMore: false,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    act(() => {
      wsMocks.isReady = true
      wsMocks.serverInstanceId = 'srv-local'
      broadcastWs({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-local',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)
    })

    const stableAButton = screen.getByRole('button', { name: /Stable A/i })

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 7,
      })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: /New Top/i })).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: /Stable A/i })).toBe(stableAButton)
  })

  it('skips redundant session fetches when revision has not increased', async () => {
    const initialProjects = [
      {
        projectPath: '/proj',
        sessions: [
          { provider: 'codex', sessionId: 's-1', projectPath: '/proj', lastActivityAt: 10, title: 'S1' },
        ],
      },
    ]

    fetchSidebarSessionsSnapshot.mockResolvedValue({
      projects: initialProjects,
      totalSessions: 1,
      oldestIncludedTimestamp: 10,
      oldestIncludedSessionId: 'codex:s-1',
      hasMore: false,
    })

    const store = createStore({
      sessions: {
        projects: initialProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        totalSessions: 1,
        oldestLoadedTimestamp: 10,
        oldestLoadedSessionId: 'codex:s-1',
        hasMore: false,
        windows: {
          sidebar: {
            projects: initialProjects,
            lastLoadedAt: Date.now(),
            totalSessions: 1,
            oldestLoadedTimestamp: 10,
            oldestLoadedSessionId: 'codex:s-1',
            hasMore: false,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    act(() => {
      wsMocks.isReady = true
      wsMocks.serverInstanceId = 'srv-dedup'
      broadcastWs({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-dedup',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
    })

    // First broadcast with revision 5 — should trigger fetch
    act(() => {
      broadcastWs({ type: 'sessions.changed', revision: 5 })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    })

    // Same revision 5 again — should NOT trigger another fetch
    act(() => {
      broadcastWs({ type: 'sessions.changed', revision: 5 })
    })

    // Give time for any async dispatch
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    // Higher revision 6 — should trigger fetch
    act(() => {
      broadcastWs({ type: 'sessions.changed', revision: 6 })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
    })
  })
})

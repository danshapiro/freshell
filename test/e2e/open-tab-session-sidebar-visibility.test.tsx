import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer, { openSessionTab } from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import { layoutMirrorMiddleware } from '@/store/layoutMirrorMiddleware'

vi.mock('react-window', () => ({
  List: ({ rowCount, rowComponent: Row, rowProps, style }: {
    rowCount: number
    rowComponent: React.ComponentType<any>
    rowProps: any
    style: React.CSSProperties
  }) => {
    const items = []
    for (let i = 0; i < rowCount; i += 1) {
      items.push(
        <Row
          key={i}
          index={i}
          style={{ height: 56 }}
          ariaAttributes={{}}
          {...rowProps}
        />,
      )
    }
    return <div style={style}>{items}</div>
  },
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
        settings: {
          ...defaultSettings,
          sidebar: {
            ...defaultSettings.sidebar,
            collapsed: false,
            width: 288,
          },
        },
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

describe('open tab session sidebar visibility (e2e)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    wsHandlers.clear()
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined

    fetchSidebarSessionsSnapshot.mockReset()
    searchSessions.mockClear()

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/version') return Promise.resolve({})
      if (url === '/api/network/status') return Promise.resolve(null)
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows an older open local session in the sidebar during bootstrap', async () => {
    const olderOpenSessionId = 'older-open'
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [{
        projectPath: '/older',
        sessions: [{
          provider: 'codex',
          sessionId: olderOpenSessionId,
          projectPath: '/older',
          updatedAt: 1,
          title: 'Older Open Session',
        }],
      }],
      totalSessions: 101,
      oldestIncludedTimestamp: 55,
      oldestIncludedSessionId: 'codex:cursor',
      hasMore: true,
    })

    const store = createStore({
      tabs: [{
        id: 'tab-older',
        title: 'Codex CLI',
        mode: 'codex',
        resumeSessionId: olderOpenSessionId,
      }],
      panes: {
        layouts: {
          'tab-older': {
            type: 'leaf',
            id: 'pane-older',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-older',
              status: 'running',
              resumeSessionId: olderOpenSessionId,
              sessionRef: {
                provider: 'codex',
                sessionId: olderOpenSessionId,
                serverInstanceId: 'srv-local',
              },
            },
          },
        },
        activePane: {
          'tab-older': 'pane-older',
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Older Open Session')).toBeInTheDocument()
    })
  })

  it('ignores legacy sessions.updated websocket pushes because the sidebar window is HTTP-owned', async () => {
    fetchSidebarSessionsSnapshot.mockResolvedValue({
      projects: [{
        projectPath: '/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/recent',
          updatedAt: 10,
          title: 'Recent Session',
        }],
      }],
      totalSessions: 100,
      oldestIncludedTimestamp: 10,
      oldestIncludedSessionId: 'codex:recent-session',
      hasMore: true,
    })

    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.projects).toEqual([
        expect.objectContaining({
          projectPath: '/recent',
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionId: 'recent-session',
              title: 'Recent Session',
            }),
          ]),
        }),
      ])
    })

    act(() => {
      broadcastWs({
        type: 'sessions.updated',
        clear: true,
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-open',
            projectPath: '/older',
            updatedAt: 1,
            title: 'Older Open Session',
          }],
        }],
        totalSessions: 1,
        oldestIncludedTimestamp: 1,
        oldestIncludedSessionId: 'codex:older-open',
        hasMore: false,
      })
    })

    expect(store.getState().sessions.projects).toEqual([
      expect.objectContaining({
        projectPath: '/recent',
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'recent-session',
            title: 'Recent Session',
          }),
        ]),
      }),
    ])
  })

  it('refetches the active sidebar window over HTTP when sessions.changed arrives', async () => {
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [{
        projectPath: '/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/recent',
          updatedAt: 10,
          title: 'Recent Session',
        }],
      }],
      totalSessions: 100,
      oldestIncludedTimestamp: 10,
      oldestIncludedSessionId: 'codex:recent-session',
      hasMore: true,
    })
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [{
        projectPath: '/older',
        sessions: [{
          provider: 'codex',
          sessionId: 'older-open',
          projectPath: '/older',
          updatedAt: 1,
          title: 'Older Open Session',
        }],
      }],
      totalSessions: 1,
      oldestIncludedTimestamp: 1,
      oldestIncludedSessionId: 'codex:older-open',
      hasMore: false,
    })

    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().sessions.projects).toEqual([
        expect.objectContaining({
          projectPath: '/recent',
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionId: 'recent-session',
              title: 'Recent Session',
            }),
          ]),
        }),
      ])
    })

    act(() => {
      broadcastWs({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-local',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.serverInstanceId).toBe('srv-local')
    })

    await act(async () => {
      await store.dispatch(openSessionTab({ provider: 'codex', sessionId: 'older-open' }) as any)
    })

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ui.layout.sync',
        tabs: expect.arrayContaining([
          expect.objectContaining({
            fallbackSessionRef: {
              provider: 'codex',
              sessionId: 'older-open',
            },
          }),
        ]),
      }))
    })

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 7,
      })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(store.getState().sessions.projects).toEqual([
        expect.objectContaining({
          projectPath: '/older',
          sessions: expect.arrayContaining([
            expect.objectContaining({
              sessionId: 'older-open',
              title: 'Older Open Session',
            }),
          ]),
        }),
      ])
    })
  })
})

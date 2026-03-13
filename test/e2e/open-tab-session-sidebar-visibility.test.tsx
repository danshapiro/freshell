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
import * as sessionsThunks from '@/store/sessionsThunks'

const _resetSessionWindowThunkState = ((sessionsThunks as any)._resetSessionWindowThunkState ?? (() => {})) as () => void

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
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

  it('hydrates sidebar metadata and non-active sessions during bootstrap when only restored tab fallbacks exist', async () => {
    const olderOpenSessionId = 'older-open'
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [
        {
          projectPath: '/work/project-older',
          sessions: [{
            provider: 'codex',
            sessionId: olderOpenSessionId,
            projectPath: '/work/project-older',
            updatedAt: 10,
            title: 'Older Open Session',
          }],
        },
        {
          projectPath: '/work/project-teammate',
          sessions: [{
            provider: 'codex',
            sessionId: 'teammate-open',
            projectPath: '/work/project-teammate',
            updatedAt: 9,
            title: 'Teammate Session',
          }],
        },
      ],
      totalSessions: 2,
      oldestIncludedTimestamp: 9,
      oldestIncludedSessionId: 'codex:teammate-open',
      hasMore: false,
    })

    const store = createStore({
      tabs: [{
        id: 'tab-older',
        title: 'Older Open Session',
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
        paneTitles: {
          'tab-older': {
            'pane-older': 'Older Open Session',
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Older Open Session').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Teammate Session').length).toBeGreaterThan(0)
      expect(screen.getAllByText('project-older').length).toBeGreaterThan(0)
      expect(screen.getAllByText('project-teammate').length).toBeGreaterThan(0)
    })

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
  })

  it('ignores legacy sessions.updated websocket pushes because the sidebar window is HTTP-owned', async () => {
    const recentProjects = [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        updatedAt: 10,
        title: 'Recent Session',
      }],
    }]

    const store = createStore({
      sessions: {
        projects: recentProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        totalSessions: 100,
        oldestLoadedTimestamp: 10,
        oldestLoadedSessionId: 'codex:recent-session',
        hasMore: true,
        windows: {
          sidebar: {
            projects: recentProjects,
            lastLoadedAt: Date.now(),
            totalSessions: 100,
            oldestLoadedTimestamp: 10,
            oldestLoadedSessionId: 'codex:recent-session',
            hasMore: true,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    expect(store.getState().sessions.projects).toEqual(recentProjects)

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
    const recentProjects = [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        updatedAt: 10,
        title: 'Recent Session',
      }],
    }]
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

    const store = createStore({
      sessions: {
        projects: recentProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        totalSessions: 100,
        oldestLoadedTimestamp: 10,
        oldestLoadedSessionId: 'codex:recent-session',
        hasMore: true,
        windows: {
          sidebar: {
            projects: recentProjects,
            lastLoadedAt: Date.now(),
            totalSessions: 100,
            oldestLoadedTimestamp: 10,
            oldestLoadedSessionId: 'codex:recent-session',
            hasMore: true,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    expect(store.getState().sessions.projects).toEqual(recentProjects)

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
    }, { timeout: 2500 })

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 7,
      })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
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

  it('keeps the loaded sidebar visible during an invalidation burst and queues at most one follow-up refresh', async () => {
    const initialProjects = [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        updatedAt: 10,
        title: 'Recent Session',
      }],
    }]
    const deferred = createDeferred<any>()

    fetchSidebarSessionsSnapshot
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValue({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-open',
            projectPath: '/older',
            updatedAt: 11,
            title: 'Older Open Session',
          }],
        }],
        totalSessions: 1,
        oldestIncludedTimestamp: 11,
        oldestIncludedSessionId: 'codex:older-open',
        hasMore: false,
      })

    const store = createStore({
      sessions: {
        projects: initialProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        totalSessions: 1,
        oldestLoadedTimestamp: 10,
        oldestLoadedSessionId: 'codex:recent-session',
        hasMore: false,
        windows: {
          sidebar: {
            projects: initialProjects,
            lastLoadedAt: Date.now(),
            totalSessions: 1,
            oldestLoadedTimestamp: 10,
            oldestLoadedSessionId: 'codex:recent-session',
            hasMore: false,
            loading: false,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Recent Session').length).toBeGreaterThan(0)
    })

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 7,
      })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    })

    expect(screen.getAllByText('Recent Session').length).toBeGreaterThan(0)

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 8,
      })
    })

    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('Recent Session').length).toBeGreaterThan(0)

    await act(async () => {
      deferred.resolve({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-open',
            projectPath: '/older',
            updatedAt: 11,
            title: 'Older Open Session',
          }],
        }],
        totalSessions: 1,
        oldestIncludedTimestamp: 11,
        oldestIncludedSessionId: 'codex:older-open',
        hasMore: false,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getAllByText('Older Open Session').length).toBeGreaterThan(0)
    })

    expect(screen.queryByText('Recent Session')).not.toBeInTheDocument()
    expect(fetchSidebarSessionsSnapshot.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

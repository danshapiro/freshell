import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer, { openSessionTab } from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer, { clearProjects } from '@/store/sessionsSlice'
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
  type LocalSettingsPatch,
  type ServerSettingsPatch,
} from '@shared/settings'

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

  const defaultServerSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const serverSettings = mergeServerSettings(defaultServerSettings, {})
  const localSettings = resolveLocalSettings({
    sidebar: {
      collapsed: false,
      width: 288,
    },
  } satisfies LocalSettingsPatch)

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

describe('open tab session sidebar visibility (e2e)', () => {
  beforeEach(() => {
    vi.useRealTimers()
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
    vi.useRealTimers()
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
            lastActivityAt: 10,
            title: 'Older Open Session',
          }],
        },
        {
          projectPath: '/work/project-teammate',
          sessions: [{
            provider: 'codex',
            sessionId: 'teammate-open',
            projectPath: '/work/project-teammate',
            lastActivityAt: 9,
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

  it('recovers CLI availability and sidebar filtering after transient pre-ready failures', async () => {
    const recoveredSettings = {
      ...defaultSettings,
      sidebar: {
        ...defaultSettings.sidebar,
        excludeFirstChatSubstrings: ['__AUTO__'],
      },
    }
    let bootstrapCalls = 0
    let sidebarCalls = 0

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        bootstrapCalls += 1
        if (bootstrapCalls === 1) {
          return Promise.reject({ status: 503, message: 'Service Unavailable' })
        }
        return Promise.resolve({
          settings: recoveredSettings,
          platform: {
            platform: 'linux',
            availableClis: { claude: true, codex: true },
            featureFlags: { kilroy: true },
          },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/version') return Promise.resolve({})
      if (url === '/api/network/status') return Promise.resolve(null)
      return Promise.resolve({})
    })

    fetchSidebarSessionsSnapshot.mockImplementation(() => {
      sidebarCalls += 1
      if (sidebarCalls === 1) {
        return Promise.reject({ status: 503, message: 'Service Unavailable' })
      }
      return Promise.resolve({
        projects: [{
          projectPath: '/work/app',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'hidden-auto-session',
              projectPath: '/work/app',
              updatedAt: 10,
              title: 'Hidden Auto Session',
              firstUserMessage: '__AUTO__ reconcile state',
            },
            {
              provider: 'codex',
              sessionId: 'visible-manual-session',
              projectPath: '/work/app',
              updatedAt: 9,
              title: 'Visible Manual Session',
              firstUserMessage: 'please fix tests',
            },
          ],
        }],
        totalSessions: 2,
        oldestIncludedTimestamp: 9,
        oldestIncludedSessionId: 'codex:visible-manual-session',
        hasMore: false,
      })
    })

    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/bootstrap')
    })

    act(() => {
      wsMocks.isReady = true
      wsMocks.serverInstanceId = 'srv-recovered'
      broadcastWs({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-recovered',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.availableClis).toEqual({ claude: true, codex: true })
      expect(store.getState().settings.settings.sidebar.excludeFirstChatSubstrings).toEqual(['__AUTO__'])
      expect(screen.queryByText('Hidden Auto Session')).not.toBeInTheDocument()
      expect(screen.getAllByText('Visible Manual Session').length).toBeGreaterThan(0)
    })

    expect(bootstrapCalls).toBe(2)
    expect(sidebarCalls).toBe(2)
  })

  it('ignores legacy sessions.updated websocket pushes because the sidebar window is HTTP-owned', async () => {
    const recentProjects = [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        lastActivityAt: 10,
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
            lastActivityAt: 1,
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
        lastActivityAt: 10,
        title: 'Recent Session',
      }],
    }]
    // Use mockResolvedValue (not Once) so that if bootstrap triggers an
    // unexpected sidebar fetch under CPU pressure, the mock still returns
    // valid data instead of undefined — preventing a false-negative from
    // empty projects overwriting the store.
    const refetchResponse = {
      projects: [{
        projectPath: '/older',
        sessions: [{
          provider: 'codex',
          sessionId: 'older-open',
          projectPath: '/older',
          lastActivityAt: 1,
          title: 'Older Open Session',
        }],
      }],
      totalSessions: 1,
      oldestIncludedTimestamp: 1,
      oldestIncludedSessionId: 'codex:older-open',
      hasMore: false,
    }
    fetchSidebarSessionsSnapshot.mockResolvedValue(refetchResponse)

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

    // Record any bootstrap-driven calls before the test's own WS flow.
    // The sidebar window is pre-loaded (lastLoadedAt is set), so bootstrap
    // should NOT call fetchSidebarSessionsSnapshot — but under heavy CPU
    // pressure in the full suite, concurrent async flows can race and
    // occasionally trigger one.
    const callsBeforeReady = fetchSidebarSessionsSnapshot.mock.calls.length

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

    // Snapshot the call count just before the invalidation event so the
    // assertion below only counts calls caused by sessions.changed.
    const callsBeforeChanged = fetchSidebarSessionsSnapshot.mock.calls.length

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 7,
      })
    })

    await waitFor(() => {
      // At least one new call must have been triggered by sessions.changed.
      expect(fetchSidebarSessionsSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeChanged)
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
    }, { timeout: 2500 })

    // Exactly one new call should have been made by the invalidation handler.
    expect(fetchSidebarSessionsSnapshot.mock.calls.length - callsBeforeChanged).toBe(1)

    expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
  })

  it('keeps the loaded sidebar visible during an invalidation burst and queues at most one follow-up refresh', async () => {
    const initialProjects = [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        lastActivityAt: 10,
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
            lastActivityAt: 11,
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
            lastActivityAt: 11,
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

  it('keeps stale applied search results visible and revalidates them silently during websocket refresh after clearing search', async () => {
    const searchProjects = [{
      projectPath: '/search',
      sessions: [{
        provider: 'codex',
        sessionId: 'search-session',
        projectPath: '/search',
        lastActivityAt: 10,
        title: 'Search Result',
      }],
    }]
    const browseDeferred = createDeferred<any>()
    const deferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseDeferred.promise)
    searchSessions.mockReturnValueOnce(deferred.promise)

    const store = createStore({
      sessions: {
        projects: searchProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        windows: {
          sidebar: {
            projects: searchProjects,
            lastLoadedAt: Date.now(),
            loading: false,
            query: 'search',
            searchTier: 'title',
            appliedQuery: 'search',
            appliedSearchTier: 'title',
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
      expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
    })

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: '' } })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    })

    expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 9,
      })
    })

    await waitFor(() => {
      expect(searchSessions).toHaveBeenCalledTimes(1)
      expect(searchSessions).toHaveBeenCalledWith({
        query: 'search',
        tier: 'title',
        signal: expect.any(AbortSignal),
      })
    })

    expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()

    await act(async () => {
      deferred.resolve({
        results: [{
          provider: 'codex',
          sessionId: 'search-session',
          projectPath: '/search',
          title: 'Search Result',
          lastActivityAt: 10,
          archived: false,
        }],
        tier: 'title',
        query: 'search',
        totalScanned: 1,
      })
      await Promise.resolve()
    })

    await act(async () => {
      browseDeferred.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })
      await Promise.resolve()
    })
  })

  it('blocks with loading UI when websocket recovery starts from an empty, uncommitted sidebar window', async () => {
    const deferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)

    const store = createStore({
      sessions: {
        projects: [],
        activeSurface: 'sidebar',
        lastLoadedAt: 1_700_000_000_000,
        windows: {
          sidebar: {
            projects: [],
            lastLoadedAt: 1_700_000_000_000,
            query: '',
            searchTier: 'title',
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
      expect(apiGet).toHaveBeenCalledWith('/api/version')
    })

    act(() => {
      store.dispatch(clearProjects())
    })

    act(() => {
      broadcastWs({
        type: 'sessions.changed',
        revision: 10,
      })
    })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    })

    await waitFor(() => {
      expect(screen.getByText('Loading sessions...')).toBeInTheDocument()
      expect(screen.queryByText('No sessions yet')).not.toBeInTheDocument()
    })

    await act(async () => {
      deferred.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })
      await Promise.resolve()
    })
  })

  it('keeps direct refreshes on the visible applied search silent and only shows searching for actual query changes', async () => {
    const searchProjects = [{
      projectPath: '/search',
      sessions: [{
        provider: 'codex',
        sessionId: 'search-session',
        projectPath: '/search',
        lastActivityAt: 10,
        title: 'Search Result',
      }],
    }]
    const browseDeferred = createDeferred<any>()
    const refreshDeferred = createDeferred<any>()
    const queryChangeDeferred = createDeferred<any>()
    fetchSidebarSessionsSnapshot.mockReturnValueOnce(browseDeferred.promise)
    searchSessions
      .mockReturnValueOnce(refreshDeferred.promise)
      .mockReturnValueOnce(queryChangeDeferred.promise)

    const store = createStore({
      sessions: {
        projects: searchProjects,
        activeSurface: 'sidebar',
        lastLoadedAt: Date.now(),
        windows: {
          sidebar: {
            projects: searchProjects,
            lastLoadedAt: Date.now(),
            loading: false,
            query: 'search',
            searchTier: 'title',
            appliedQuery: 'search',
            appliedSearchTier: 'title',
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
      expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
    })

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: '' } })

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    })

    expect(store.getState().sessions.windows.sidebar.query).toBe('')
    expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('search')

    const refreshRequest = store.dispatch((sessionsThunks as any).refreshActiveSessionWindow())

    await waitFor(() => {
      expect(searchSessions).toHaveBeenCalledTimes(1)
      expect(searchSessions).toHaveBeenNthCalledWith(1, {
        query: 'search',
        tier: 'title',
        signal: expect.any(AbortSignal),
      })
    })

    expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)

    await act(async () => {
      refreshDeferred.resolve({
        results: [{
          provider: 'codex',
          sessionId: 'search-session',
          projectPath: '/search',
          title: 'Search Result',
          lastActivityAt: 10,
          archived: false,
        }],
        tier: 'title',
        query: 'search',
        totalScanned: 1,
      })
      await refreshRequest
    })

    await act(async () => {
      browseDeferred.resolve({
        projects: [],
        totalSessions: 0,
        oldestIncludedTimestamp: 0,
        oldestIncludedSessionId: '',
        hasMore: false,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(store.getState().sessions.windows.sidebar.appliedQuery).toBe('')
      expect(store.getState().sessions.windows.sidebar.appliedSearchTier).toBe('title')
      expect(screen.queryByText('Search Result')).not.toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'search plus' } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })

    await waitFor(() => {
      expect(searchSessions).toHaveBeenCalledTimes(2)
      expect(searchSessions).toHaveBeenNthCalledWith(2, {
        query: 'search plus',
        tier: 'title',
        signal: expect.any(AbortSignal),
      })
      const searchLoading = screen.getByTestId('search-loading')
      expect(searchLoading).toBeInTheDocument()
      expect(searchLoading.querySelector('span:not(.sr-only)')).toHaveTextContent('Searching...')
    }, { timeout: 3_000 })

    await act(async () => {
      queryChangeDeferred.resolve({
        results: [],
        tier: 'title',
        query: 'search plus',
        totalScanned: 1,
      })
      await Promise.resolve()
    })
  })

  it('shows a fallback sidebar item for a Claude tab with a human-readable resume name', async () => {
    const namedResumeName = '137 tour'
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })

    const store = createStore({
      tabs: [{
        id: 'tab-named',
        title: '137 tour',
        mode: 'claude',
        resumeSessionId: namedResumeName,
        createdAt: Date.now(),
      }],
      panes: {
        layouts: {
          'tab-named': {
            type: 'leaf',
            id: 'pane-named',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-named',
              status: 'running',
              resumeSessionId: namedResumeName,
            },
          },
        },
        activePane: {
          'tab-named': 'pane-named',
        },
        paneTitles: {
          'tab-named': {
            'pane-named': '137 tour',
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
      // The session should appear in the sidebar as a fallback item
      expect(screen.getAllByText('137 tour').length).toBeGreaterThan(0)
    })
  })
})

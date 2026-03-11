import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'

// Mock heavy child components to avoid xterm/canvas issues
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
vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))
vi.mock('@/components/SetupWizard', () => ({
  SetupWizard: () => <div data-testid="mock-setup-wizard">Setup Wizard</div>,
}))

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  onDisconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}))

let messageHandler: ((msg: any) => void) | null = null
let disconnectHandler: (() => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    onDisconnect: wsMocks.onDisconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
    get isReady() {
      return wsMocks.isReady
    },
    get serverInstanceId() {
      return wsMocks.serverInstanceId
    },
  }),
}))

const apiGet = vi.hoisted(() => vi.fn())
const fetchSidebarSessionsSnapshot = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
}))

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
  codexActivity?: Partial<CodexActivityState>
}) {
  const defaultCodexActivity: CodexActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
  const tabs = options?.tabs ?? [{ id: 'tab-1', mode: 'shell' }]
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
      network: networkReducer,
      codexActivity: codexActivityReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: { settings: defaultSettings, loaded: true, lastSavedAt: undefined },
      tabs: { tabs, activeTabId: (tabs[0]?.id as string | undefined) ?? null },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
      },
      sessions: { projects: [], expandedProjects: new Set<string>(), wsSnapshotReceived: false, isLoading: false, error: null },
      panes,
      network: { status: null, loading: false, configuring: false, error: null },
      codexActivity: {
        ...defaultCodexActivity,
        ...(options?.codexActivity ?? {}),
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

describe('App WS bootstrap recovery', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockImplementation((cb: () => void) => {
      disconnectHandler = cb
      return () => { disconnectHandler = null }
    })
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    messageHandler = null
    disconnectHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])

    // Keep API calls fast and deterministic.
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('marks connection as auth-required and skips websocket connect when bootstrap settings request returns 401', async () => {
    const store = createStore({
      codexActivity: {
        byTerminalId: {
          'term-stale': {
            terminalId: 'term-stale',
            sessionId: 'session-stale',
            phase: 'busy',
            updatedAt: 10,
          },
        },
        lastSnapshotSeq: 3,
        liveMutationSeqByTerminalId: { 'term-stale': 3 },
      },
    })
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.reject({ status: 401, message: 'Unauthorized' })
      }
      return Promise.resolve({})
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toBe('Authentication failed')
      expect(store.getState().codexActivity.byTerminalId).toEqual({})
    })

    expect(wsMocks.connect).not.toHaveBeenCalled()
  })

  it('owns websocket startup by connecting after a successful bootstrap when no socket is preconnected', async () => {
    const store = createStore()
    wsMocks.connect.mockResolvedValueOnce(undefined)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.connect).toHaveBeenCalledTimes(1)
    })
  })

  it('clears stale codex activity immediately when bootstrap attaches to an already-ready socket', async () => {
    const store = createStore({
      codexActivity: {
        byTerminalId: {
          'term-stale': {
            terminalId: 'term-stale',
            sessionId: 'session-stale',
            phase: 'busy',
            updatedAt: 10,
          },
        },
        lastSnapshotSeq: 4,
        liveMutationSeqByTerminalId: { 'term-stale': 4 },
      },
    })
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-preconnected-stale'

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.serverInstanceId).toBe('srv-preconnected-stale')
      expect(store.getState().codexActivity.byTerminalId).toEqual({})
    })

    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex.activity.list' }))
  })

  it('mounts with legacy ws clients that do not implement onDisconnect', async () => {
    const store = createStore()
    const originalOnDisconnect = wsMocks.onDisconnect
    ;(wsMocks as { onDisconnect?: unknown }).onDisconnect = undefined
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-legacy-ws'

    try {
      render(
        <Provider store={store}>
          <App />
        </Provider>
      )

      await waitFor(() => {
        expect(store.getState().connection.status).toBe('ready')
        expect(store.getState().connection.serverInstanceId).toBe('srv-legacy-ws')
      })
    } finally {
      wsMocks.onDisconnect = originalOnDisconnect
    }
  })

  it('clears codex activity promptly when the websocket disconnects after readiness', async () => {
    const store = createStore()
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-preconnected-disconnect'

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
    })

    act(() => {
      messageHandler?.({
        type: 'codex.activity.updated',
        upsert: [{
          terminalId: 'term-live',
          sessionId: 'session-live',
          phase: 'busy',
          updatedAt: 20,
        }],
        remove: [],
      })
    })

    await waitFor(() => {
      expect(store.getState().codexActivity.byTerminalId['term-live']?.phase).toBe('busy')
    })

    act(() => {
      disconnectHandler?.()
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().codexActivity.byTerminalId).toEqual({})
    })
  })

  it('keeps the WS message handler registered after an initial connect failure, so a later ready can recover state', async () => {
    const store = createStore()

    wsMocks.connect.mockRejectedValueOnce(new Error('Handshake timeout'))

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toMatch(/Handshake timeout/i)
    })

    // Simulate a later successful auto-reconnect completing its handshake.
    expect(messageHandler).toBeTypeOf('function')
    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-test',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.lastError).toBeUndefined()
      expect(store.getState().connection.serverInstanceId).toBe('srv-test')
    })

    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.meta.list' }))
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex.activity.list' }))
  })

  it('dispatches wsCloseCode to lastErrorCode in Redux when connect rejects with close code', async () => {
    const store = createStore()

    const err = new Error('Server busy: max connections reached')
    ;(err as any).wsCloseCode = 4003
    wsMocks.connect.mockRejectedValueOnce(err)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('disconnected')
      expect(store.getState().connection.lastError).toMatch(/max connections/)
      expect(store.getState().connection.lastErrorCode).toBe(4003)
    })
  })

  it('clears lastErrorCode when a ready message arrives after a failed connect', async () => {
    const store = createStore()

    // First connect fails with 4003
    const err = new Error('Server busy: max connections reached')
    ;(err as any).wsCloseCode = 4003
    wsMocks.connect.mockRejectedValueOnce(err)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.lastErrorCode).toBe(4003)
    })

    // Simulate a later reconnect succeeding: the WS message handler
    // (registered during bootstrap) receives a ready message, which
    // dispatches setStatus('ready') — the reducer clears lastErrorCode.
    expect(messageHandler).toBeTypeOf('function')
    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-reconnect',
      })
    })

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.lastErrorCode).toBeUndefined()
      expect(store.getState().connection.lastError).toBeUndefined()
    })
  })

  it('includes current mobile state in hello extensions', async () => {
    const store = createStore()
    ;(globalThis as any).setMobileForTest(true)
    wsMocks.connect.mockResolvedValueOnce(undefined)

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.setHelloExtensionProvider).toHaveBeenCalled()
    })

    const provider = wsMocks.setHelloExtensionProvider.mock.calls.at(-1)?.[0] as (() => any) | undefined
    expect(provider).toBeTypeOf('function')

    const extension = provider?.()
    expect(extension?.sessions).toBeDefined()
    expect(extension?.client?.mobile).toBe(true)
  })

  it('uses the sidebar snapshot helper with exact open-session locators during bootstrap', async () => {
    const olderOpenSessionId = 'older-open'
    fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
      projects: [
        {
          projectPath: '/older',
          sessions: [
            {
              provider: 'codex',
              sessionId: olderOpenSessionId,
              projectPath: '/older',
              updatedAt: 1,
              title: 'Older Open Session',
            },
          ],
        },
      ],
      totalSessions: 101,
      oldestIncludedTimestamp: 55,
      oldestIncludedSessionId: 'codex:cursor',
      hasMore: true,
    })

    const store = createStore({
      tabs: [{ id: 'tab-older', mode: 'codex', resumeSessionId: olderOpenSessionId }],
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
      </Provider>
    )

    await waitFor(() => {
      expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledWith({
        limit: 100,
        openSessions: [
          { provider: 'codex', sessionId: olderOpenSessionId, serverInstanceId: 'srv-local' },
          { provider: 'codex', sessionId: olderOpenSessionId },
        ],
      })
      expect(store.getState().sessions.projects.map((project: any) => project.projectPath)).toEqual(['/older'])
      expect(store.getState().sessions.oldestLoadedSessionId).toBe('codex:cursor')
      expect(store.getState().sessions.hasMore).toBe(true)
    })
  })

  it('promotes a recent HTTP sessions baseline when socket is already ready before App bootstrap connects', async () => {
    const store = createStore()
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-preconnected'

    fetchSidebarSessionsSnapshot.mockResolvedValueOnce([
      {
        projectPath: '/p1',
        sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/p1', updatedAt: 1 }],
      },
    ])

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.serverInstanceId).toBe('srv-preconnected')
      expect(store.getState().sessions.wsSnapshotReceived).toBe(true)
    })

    expect(wsMocks.connect).not.toHaveBeenCalled()
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.meta.list' }))
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex.activity.list' }))
    expect(store.getState().sessions.projects.map((p: any) => p.projectPath)).toEqual(['/p1'])

    act(() => {
      messageHandler?.({
        type: 'sessions.patch',
        upsertProjects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] }],
        removeProjectPaths: [],
      })
    })

    await waitFor(() => {
      expect(store.getState().sessions.projects.map((p: any) => p.projectPath).sort()).toEqual(['/p1', '/p2'])
    })
  })

  it('falls back to refetch sessions when pre-connected socket has no recent baseline', async () => {
    const olderOpenSessionId = 'older-open'
    const store = createStore({
      tabs: [{ id: 'tab-older', mode: 'codex', resumeSessionId: olderOpenSessionId }],
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
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-preconnected-fallback'

    fetchSidebarSessionsSnapshot
      .mockRejectedValueOnce(new Error('initial sessions load failed'))
      .mockResolvedValueOnce([
        {
          projectPath: '/p-fallback',
          sessions: [{ provider: 'codex', sessionId: 's-fallback', projectPath: '/p-fallback', updatedAt: 3 }],
        },
      ])

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(store.getState().connection.status).toBe('ready')
      expect(store.getState().connection.serverInstanceId).toBe('srv-preconnected-fallback')
      expect(store.getState().sessions.wsSnapshotReceived).toBe(true)
      expect(store.getState().sessions.projects.map((p: any) => p.projectPath)).toEqual(['/p-fallback'])
    })

    expect(fetchSidebarSessionsSnapshot).toHaveBeenNthCalledWith(1, {
      limit: 100,
      openSessions: [
        { provider: 'codex', sessionId: olderOpenSessionId, serverInstanceId: 'srv-local' },
        { provider: 'codex', sessionId: olderOpenSessionId },
      ],
    })
    expect(fetchSidebarSessionsSnapshot).toHaveBeenNthCalledWith(2, {
      limit: 100,
      openSessions: [
        { provider: 'codex', sessionId: olderOpenSessionId, serverInstanceId: 'srv-local' },
        { provider: 'codex', sessionId: olderOpenSessionId },
      ],
    })
    expect(wsMocks.connect).not.toHaveBeenCalled()
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.meta.list' }))
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex.activity.list' }))
  })

  it('ignores stale codex activity list responses that arrive after a newer snapshot', async () => {
    const store = createStore()
    wsMocks.isReady = true
    wsMocks.serverInstanceId = 'srv-preconnected-race'

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    expect(messageHandler).toBeTypeOf('function')
    act(() => {
      messageHandler?.({
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-preconnected-race',
      })
    })

    await waitFor(() => {
      const codexRequests = wsMocks.send.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload?.type === 'codex.activity.list')
      expect(codexRequests.length).toBeGreaterThanOrEqual(2)
    })

    const codexRequests = wsMocks.send.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'codex.activity.list')
    const olderRequestId = codexRequests[0]?.requestId as string
    const newerRequestId = codexRequests.at(-1)?.requestId as string

    act(() => {
      messageHandler?.({
        type: 'codex.activity.list.response',
        requestId: newerRequestId,
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'idle',
            updatedAt: 200,
          },
        ],
      })
      messageHandler?.({
        type: 'codex.activity.list.response',
        requestId: olderRequestId,
        terminals: [
          {
            terminalId: 'term-1',
            sessionId: 'session-1',
            phase: 'busy',
            updatedAt: 100,
          },
        ],
      })
    })

    expect(store.getState().codexActivity.byTerminalId['term-1']?.phase).toBe('idle')
  })
})

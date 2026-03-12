import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { vi } from 'vitest'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { networkReducer } from '@/store/networkSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import type { SlowNetworkLane } from './slow-network-controller'

type AppHydrationHarnessResponse = {
  lane?: SlowNetworkLane
  value?: unknown
  error?: unknown
}

type AppHydrationHarnessOptions = {
  responses?: Record<string, AppHydrationHarnessResponse>
  network?: {
    waitForLane: (lane: SlowNetworkLane, label: string) => Promise<void>
    waitForWsReady: () => Promise<void>
  }
  seedState?: {
    tabs?: Array<Record<string, unknown>>
    activeTabId?: string | null
    panes?: {
      layouts: Record<string, unknown>
      activePane: Record<string, string>
      paneTitles?: Record<string, Record<string, string>>
      paneTitleSetByUser?: Record<string, Record<string, boolean>>
      renameRequestTabId?: string | null
      renameRequestPaneId?: string | null
      zoomedPane?: Record<string, string>
    }
  }
}

type RequestLogEntry = {
  path: string
  lane: SlowNetworkLane
  at: number
}

type WsStub = {
  send: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  onMessage: ReturnType<typeof vi.fn>
  onReconnect: ReturnType<typeof vi.fn>
  onDisconnect: ReturnType<typeof vi.fn>
  setHelloExtensionProvider: ReturnType<typeof vi.fn>
  isReady: boolean
  serverInstanceId: string | undefined
}

function waitForCondition(predicate: () => boolean, timeoutMs: number, errorMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(errorMessage))
        return
      }
      setTimeout(tick, 5)
    }

    tick()
  })
}

function defaultResponseForPath(path: string): unknown {
  if (path === '/api/bootstrap') {
    return {
      settings: defaultSettings,
      platform: { platform: 'linux', availableClis: {}, featureFlags: {} },
    }
  }
  if (path === '/api/settings') return defaultSettings
  if (path === '/api/platform') return { platform: 'linux', availableClis: {}, featureFlags: {} }
  if (path === '/api/version') return { currentVersion: '0.0.0', updateCheck: null }
  if (path === '/api/network/status') {
    return {
      configured: false,
      host: '127.0.0.1',
      port: 3001,
      lanIps: [],
      machineHostname: 'visible-first-harness',
      firewall: {
        platform: 'linux',
        active: false,
        portOpen: null,
        commands: [],
        configuring: false,
      },
      rebinding: false,
      devMode: true,
      accessUrl: 'http://127.0.0.1:3001',
    }
  }
  return {}
}

function createHarnessStore(seedState: AppHydrationHarnessOptions['seedState']) {
  const tabs = seedState?.tabs ?? [{ id: 'tab-1', mode: 'shell', title: 'Shell' }]
  const panes = {
    layouts: seedState?.panes?.layouts ?? {},
    activePane: seedState?.panes?.activePane ?? {},
    paneTitles: seedState?.panes?.paneTitles ?? {},
    paneTitleSetByUser: seedState?.panes?.paneTitleSetByUser ?? {},
    renameRequestTabId: seedState?.panes?.renameRequestTabId ?? null,
    renameRequestPaneId: seedState?.panes?.renameRequestPaneId ?? null,
    zoomedPane: seedState?.panes?.zoomedPane ?? {},
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
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: { settings: defaultSettings, loaded: false, lastSavedAt: undefined },
      tabs: { tabs, activeTabId: seedState?.activeTabId ?? ((tabs[0]?.id as string | undefined) ?? null) },
      connection: {
        status: 'disconnected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: false,
        isLoading: false,
        error: null,
      },
      panes,
      network: { status: null, loading: false, configuring: false, error: null },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      tabRegistry: {
        deviceId: 'device-visible-first',
        deviceLabel: 'device-visible-first',
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

function createWsStub(options: AppHydrationHarnessOptions['network']) {
  const messageHandlers = new Set<(message: unknown) => void>()
  let connectCalls = 0
  let connectPromise: Promise<void> | null = null

  const ws: WsStub = {
    send: vi.fn(),
    connect: vi.fn(() => {
      connectCalls += 1
      if (!connectPromise) {
        connectPromise = (async () => {
          if (options) {
            await options.waitForWsReady()
          }
          ws.isReady = true
          ws.serverInstanceId = 'srv-visible-first-harness'
          const ready = {
            type: 'ready',
            timestamp: new Date().toISOString(),
            serverInstanceId: ws.serverInstanceId,
          }
          for (const handler of messageHandlers) {
            handler(ready)
          }
        })()
      }
      return connectPromise
    }),
    onMessage: vi.fn((handler: (message: unknown) => void) => {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    }),
    onReconnect: vi.fn(() => () => undefined),
    onDisconnect: vi.fn(() => () => undefined),
    setHelloExtensionProvider: vi.fn(),
    isReady: false,
    serverInstanceId: undefined,
  }

  return {
    ws,
    getConnectCalls: () => connectCalls,
  }
}

export async function createAppHydrationHarness(options: AppHydrationHarnessOptions = {}) {
  localStorage.setItem('freshell.auth-token', 'test-token')

  const requestLog: RequestLogEntry[] = []
  const resolvedRequests: RequestLogEntry[] = []
  const responseMap = options.responses ?? {}
  const wsState = createWsStub(options.network)

  const resolveResponse = async (path: string): Promise<unknown> => {
    const configured = responseMap[path]
    const lane = configured?.lane ?? 'visible'
    requestLog.push({ path, lane, at: Date.now() })

    if (options.network && configured?.lane) {
      await options.network.waitForLane(configured.lane, path)
    }

    if (configured?.error) {
      throw configured.error
    }

    resolvedRequests.push({ path, lane, at: Date.now() })
    return configured?.value ?? defaultResponseForPath(path)
  }

  await vi.resetModules()

  vi.doMock('@/components/TabContent', () => ({
    default: () => <div data-testid="visible-first-tab-content">Tab Content</div>,
  }))
  vi.doMock('@/components/Sidebar', () => ({
    default: () => <div data-testid="visible-first-sidebar">Sidebar</div>,
    AppView: {},
  }))
  vi.doMock('@/components/HistoryView', () => ({
    default: () => <div data-testid="visible-first-history">History</div>,
  }))
  vi.doMock('@/components/SettingsView', () => ({
    default: () => <div data-testid="visible-first-settings">Settings</div>,
  }))
  vi.doMock('@/components/OverviewView', () => ({
    default: () => <div data-testid="visible-first-overview">Overview</div>,
  }))
  vi.doMock('@/hooks/useTheme', () => ({
    useThemeEffect: () => undefined,
  }))
  vi.doMock('@/components/SetupWizard', () => ({
    SetupWizard: () => <div data-testid="visible-first-setup-wizard">Setup Wizard</div>,
  }))
  vi.doMock('@/lib/ws-client', () => ({
    getWsClient: () => wsState.ws,
  }))
  vi.doMock('@/lib/api', () => ({
    api: {
      get: (path: string) => resolveResponse(path),
      post: (path: string) => resolveResponse(path),
      patch: (path: string) => resolveResponse(path),
      put: (path: string) => resolveResponse(path),
      delete: (path: string) => resolveResponse(path),
    },
    fetchSidebarSessionsSnapshot: () => resolveResponse('/api/sidebar-sessions-snapshot'),
    isApiUnauthorizedError: (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as { status?: unknown }).status === 401,
  }))

  const { default: App } = await import('@/App')
  const store = createHarnessStore(options.seedState)
  const renderResult = render(
    <Provider store={store}>
      <App />
    </Provider>,
  )

  return {
    getStore() {
      return store
    },

    getRequestLog(): RequestLogEntry[] {
      return requestLog.slice()
    },

    getResolvedRequests(): RequestLogEntry[] {
      return resolvedRequests.slice()
    },

    getWsConnectCalls(): number {
      return wsState.getConnectCalls()
    },

    isWsReady(): boolean {
      return wsState.ws.isReady
    },

    waitForRequest(path: string, timeoutMs = 2_000): Promise<void> {
      return waitForCondition(
        () => requestLog.some((entry) => entry.path === path),
        timeoutMs,
        `Timed out waiting for ${path} request`,
      )
    },

    waitForConnect(timeoutMs = 2_000): Promise<void> {
      return waitForCondition(
        () => wsState.getConnectCalls() > 0,
        timeoutMs,
        'Timed out waiting for ws.connect()',
      )
    },

    async dispose(): Promise<void> {
      renderResult.unmount()
      cleanup()
      vi.doUnmock('@/components/TabContent')
      vi.doUnmock('@/components/Sidebar')
      vi.doUnmock('@/components/HistoryView')
      vi.doUnmock('@/components/SettingsView')
      vi.doUnmock('@/components/OverviewView')
      vi.doUnmock('@/hooks/useTheme')
      vi.doUnmock('@/components/SetupWizard')
      vi.doUnmock('@/lib/ws-client')
      vi.doUnmock('@/lib/api')
      await vi.resetModules()
    },
  }
}

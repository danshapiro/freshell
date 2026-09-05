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
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { networkReducer } from '@/store/networkSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import hostStatsReducer, {
  activateHostStats,
  requestHostStatsRefresh,
  _resetHostStatsThunkState,
} from '@/store/hostStatsSlice'
import type { HostStatsLive, HostStatsManual } from '@shared/ws-protocol'
import {
  createDefaultServerSettings,
  composeResolvedSettings,
  resolveLocalSettings,
} from '@shared/settings'

// Mock heavy child components to avoid xterm/canvas issues (same scaffold as
// App.reconcile-adoption.test.tsx).
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

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function stubAudio(): void {
  vi.stubGlobal('Audio', vi.fn(() => ({
    preload: '',
    volume: 1,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    currentTime: 0,
    src: '',
  }) as unknown as HTMLAudioElement))
}

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  onDisconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
  cancelCreate: vi.fn(),
  setReconcilePendingCreates: vi.fn(),
  clearReconcileCreateHold: vi.fn(),
  isReady: false,
  serverInstanceId: undefined as string | undefined,
}))

const terminalRestoreMocks = vi.hoisted(() => ({
  addTerminalRestoreRequestId: vi.fn(),
  addTerminalFreshRecoveryRequestId: vi.fn(),
  setPaneReconcileActive: vi.fn(),
}))

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId: terminalRestoreMocks.addTerminalRestoreRequestId,
  addTerminalFreshRecoveryRequestId: terminalRestoreMocks.addTerminalFreshRecoveryRequestId,
  setPaneReconcileActive: terminalRestoreMocks.setPaneReconcileActive,
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
    cancelCreate: wsMocks.cancelCreate,
    setReconcilePendingCreates: wsMocks.setReconcilePendingCreates,
    clearReconcileCreateHold: wsMocks.clearReconcileCreateHold,
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
const getTerminalDirectoryPage = vi.hoisted(() => vi.fn())
const searchTerminalView = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  getRecoveryInventory: async () => ({ recoverable: false, contentId: 'test', device: null, otherDevices: [], ledgerOnly: [] }),
  getTerminalDirectoryPage: (options?: unknown, init?: unknown) => getTerminalDirectoryPage(options, init),
  searchTerminalView: (terminalId: string, query: string, options?: unknown) => searchTerminalView(terminalId, query, options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
  isTransientRequestFailure: (err: any) =>
    !!err && (err.name === 'NetworkError' || err.name === 'AbortError' || [502, 503, 504].includes(err.status)),
}))

const sentFrames: any[] = []

function makeLive(): HostStatsLive {
  return {
    machine: {
      cores: 8, memTotalBytes: 34_000_000_000, platform: 'linux', wsl: false,
      kernel: '6.6', hostname: 'test', psi: true, cgroup: 'v2',
      thermalCount: 1, batteryPresent: false, gpu: 'none',
    },
    cpu: { available: true, usagePct: 10, stealPct: 0, perCorePct: [10], freqMHz: 3400 },
    load: { available: true, load1: 0.5, load5: 0.6, load15: 0.7, cores: 8 },
    memory: {
      available: true, source: 'host', totalBytes: 10_000, usedBytes: 1_000, availableBytes: 9_000,
      cgroupLimitBytes: null, swapTotalBytes: 0, swapUsedBytes: 0,
    },
    paging: { available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 },
    psi: { available: true, cpuSome10: 0.1, memSome10: 0.2, memFull10: 0, ioSome10: 0.1, ioFull10: 0 },
    diskIo: { available: true, readBps: 0, writeBps: 0, utilPct: 1, weightedAwaitMs: 5 },
    network: {
      available: true, rxBps: 0, txBps: 0,
      rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 0, txDroppedTotal: 0,
      rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0,
    },
    limits: { available: true, fdsUsed: 100, fdsMax: 1_048_576, pidsUsed: 100, pidsMax: 4_194_304, timeWait: 10, ephemeralPorts: 28_232 },
    freshell: {
      available: true, source: 'node', ptysRunning: 1, ptysMax: 50, wsClients: 1, wsClientsMax: 50,
      eventLoopLagP99Ms: 5, rssBytes: 1_000_000, uptimeSec: 60,
    },
  }
}

function makeManual(): HostStatsManual {
  return {
    topProcesses: { available: true, dwellMs: 300, list: [{ pid: 5, name: 'node', cpuPct: 12.3, rssBytes: 1e6, state: 'S' }] },
    processHealth: { available: true, zombies: 0, dState: 0, total: 900 },
    inotify: { available: true, instances: 3, watches: 420, maxUserWatches: 1_048_576, maxUserInstances: 128 },
    disks: { available: true, list: [{ mount: '/', totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 }] },
    thermals: { available: true, zones: [{ label: 'cpu', celsius: 51.5 }], battery: null },
    sectionErrors: {},
  }
}

function createSettingsState() {
  const localSettings = resolveLocalSettings()
  return {
    serverSettings: defaultServerSettings,
    localSettings,
    settings: composeResolvedSettings(defaultServerSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function createStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      network: networkReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      extensions: extensionsReducer,
      turnCompletion: turnCompletionReducer,
      hostStats: hostStatsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: createSettingsState(),
      tabs: { tabs: [{ id: 'tab-1', mode: 'shell' }] as any, activeTabId: 'tab-1' },
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
        windows: {},
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      network: { status: null, loading: false, configuring: false, error: null },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
      opencodeActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
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
      turnCompletion: {
        seq: 0,
        lastAtByTerminalId: {},
        lastIdleAtByTerminalId: {},
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    } as any,
  })
}

function readyFrame() {
  return {
    type: 'ready',
    timestamp: new Date().toISOString(),
    serverInstanceId: 'srv-1',
    bootId: 'boot-1',
  }
}

async function bootApp() {
  const store = createStore()
  render(
    <Provider store={store}>
      <App />
    </Provider>,
  )
  await waitFor(() => {
    expect(messageHandler).toBeTypeOf('function')
  })
  return store
}

async function receiveServerFrame(frame: Record<string, unknown>) {
  act(() => {
    messageHandler?.(frame)
  })
}

const hostStatsState = (store: { getState: () => any }) => store.getState().hostStats
const subscribeFrames = () => sentFrames.filter((f) => f.type === 'hoststats.subscribe')

describe('App hoststats.* ws folding', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    sentFrames.length = 0
    messageHandler = null
    disconnectHandler = null
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockImplementation((cb: () => void) => {
      disconnectHandler = cb
      return () => { disconnectHandler = null }
    })
    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })
    wsMocks.send.mockImplementation((frame: unknown) => {
      sentFrames.push(frame)
    })

    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    getTerminalDirectoryPage.mockResolvedValue({ items: [], revision: 1, nextCursor: null })
    searchTerminalView.mockResolvedValue({ matches: [] })
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    _resetHostStatsThunkState()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('folds hoststats.snapshot into the store, merging manual without clearing it', async () => {
    const store = await bootApp()
    const live = makeLive()
    // Realistic server wall-clock `at` — a fake-epoch timestamp trips the 10min
    // clock-offset garbage guard by design (that rejection is pinned in the slice tests).
    const now = Date.now()
    await receiveServerFrame({ type: 'hoststats.snapshot', at: now, live, manualAt: null, manual: null })
    expect(hostStatsState(store).live).toEqual(live)
    expect(hostStatsState(store).liveAt).toBe(now)
    expect(hostStatsState(store).clockOffsetMs).not.toBeNull()
    expect(hostStatsState(store).manual).toBeNull()

    const manual = makeManual()
    await receiveServerFrame({ type: 'hoststats.snapshot', at: now + 2_000, live, manualAt: now + 2_000, manual })
    expect(hostStatsState(store).manual).toEqual(manual)
    expect(hostStatsState(store).manualAt).toBe(now + 2_000)

    // A later manual-less snapshot must not clear the stored manual group.
    await receiveServerFrame({ type: 'hoststats.snapshot', at: now + 4_000, live, manualAt: null, manual: null })
    expect(hostStatsState(store).manual).toEqual(manual)
    expect(hostStatsState(store).manualAt).toBe(now + 2_000)
    expect(hostStatsState(store).liveAt).toBe(now + 4_000)
  })

  it('folds refresh responses by requestId; unknown ids are ignored without throwing', async () => {
    const store = await bootApp()
    act(() => {
      store.dispatch(requestHostStatsRefresh() as any)
    })
    const req = sentFrames.find((f) => f.type === 'hoststats.refresh')
    expect(req.requestId).toMatch(/^hsr-/)
    expect(hostStatsState(store).refresh.inFlight).toBe(true)

    await receiveServerFrame({ type: 'hoststats.refresh.response', requestId: 'hsr-unknown', ok: false, error: 'nope' })
    expect(hostStatsState(store).refresh.inFlight).toBe(true)

    const manual = makeManual()
    await receiveServerFrame({ type: 'hoststats.refresh.response', requestId: req.requestId, ok: true, at: 555_000, manual })
    expect(hostStatsState(store).refresh).toEqual({ inFlight: false, requestId: null, error: null })
    expect(hostStatsState(store).manual).toEqual(manual)
    expect(hostStatsState(store).manualAt).toBe(555_000)

    // Error path: failure keeps previous manual and records the error text.
    act(() => {
      store.dispatch(requestHostStatsRefresh() as any)
    })
    const req2 = sentFrames.filter((f) => f.type === 'hoststats.refresh').pop()
    await receiveServerFrame({ type: 'hoststats.refresh.response', requestId: req2.requestId, ok: false, error: 'deadline' })
    expect(hostStatsState(store).refresh.error).toBe('deadline')
    expect(hostStatsState(store).manual).toEqual(manual)
    expect(hostStatsState(store).manualAt).toBe(555_000)
  })

  it('on ready, resends hoststats.subscribe only when a pane is mounted', async () => {
    const store = await bootApp()
    await receiveServerFrame(readyFrame())
    expect(subscribeFrames()).toHaveLength(0)

    act(() => {
      store.dispatch(activateHostStats() as any)
    })
    expect(subscribeFrames()).toHaveLength(1)

    // Reconnect: the subscription died with the old socket and is re-sent.
    await receiveServerFrame(readyFrame())
    expect(subscribeFrames()).toHaveLength(2)
    expect(hostStatsState(store).subscribed).toBe(true)
    expect(hostStatsState(store).mountedPanes).toBe(1)
  })

  it('ws disconnect keeps last live/manual, clears subscribed; next ready resubscribes', async () => {
    const store = await bootApp()
    act(() => {
      store.dispatch(activateHostStats() as any)
    })
    const live = makeLive()
    const manual = makeManual()
    await receiveServerFrame({ type: 'hoststats.snapshot', at: 100_000, live, manualAt: 100_000, manual })
    expect(hostStatsState(store).subscribed).toBe(true)

    expect(disconnectHandler).toBeTypeOf('function')
    act(() => {
      disconnectHandler?.()
    })
    expect(hostStatsState(store).subscribed).toBe(false)
    expect(hostStatsState(store).live).toEqual(live)
    expect(hostStatsState(store).manual).toEqual(manual)

    await receiveServerFrame(readyFrame())
    expect(hostStatsState(store).subscribed).toBe(true)
    expect(subscribeFrames()).toHaveLength(2)
  })
})

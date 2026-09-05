import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer, { setLiveTerminalIds } from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer, { applyReconcileAttach, clearDeadTerminals, setDeadSessionAdjudication } from '@/store/panesSlice'
import { isFreshAgentReconcileActive, setFreshAgentReconcileActive } from '@/lib/pane-reconcile'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { networkReducer } from '@/store/networkSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import {
  createDefaultServerSettings,
  composeResolvedSettings,
  resolveLocalSettings,
} from '@shared/settings'

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
  // Interest is transient and negotiated; this suite does not exercise it.
  sendTerminalInterest: vi.fn(() => false),
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
    sendTerminalInterest: wsMocks.sendTerminalInterest,
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
const dispatchedTypes: string[] = []
const dispatched = { types: dispatchedTypes }

let seededPane: { createRequestId: string } | null = null
let seededFreshAgentPane: { createRequestId: string } | null = null

function seedPersistedTerminalPane(opts: { createRequestId: string }): void {
  seededPane = opts
}

function seedStoreWithTerminalAndFreshAgentLeaves(): void {
  seededPane = { createRequestId: 'cr-term-1' }
  seededFreshAgentPane = { createRequestId: 'cr-fa-1' }
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
  const terminalLeaf = seededPane
    ? {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'terminal',
          mode: 'shell',
          shell: 'system',
          status: 'running',
          createRequestId: seededPane.createRequestId,
          terminalId: 'term-old',
        },
      }
    : null
  const freshAgentLeaf = seededFreshAgentPane
    ? {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          status: 'running',
          createRequestId: seededFreshAgentPane.createRequestId,
          sessionRef: { provider: 'claude', sessionId: 'sess-old' },
        },
      }
    : null
  const layouts: Record<string, unknown> =
    terminalLeaf && freshAgentLeaf
      ? {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            children: [terminalLeaf, freshAgentLeaf],
            sizes: [50, 50],
          },
        }
      : terminalLeaf
        ? { 'tab-1': terminalLeaf }
        : {}
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
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }).concat(() => (next) => (action: any) => {
        if (typeof action?.type === 'string') dispatchedTypes.push(action.type)
        return next(action)
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
        layouts,
        activePane: seededPane ? { 'tab-1': 'pane-1' } : {},
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

function readyFrame(options: { capabilities?: Record<string, unknown> } = {}) {
  return {
    type: 'ready',
    timestamp: new Date().toISOString(),
    serverInstanceId: 'srv-1',
    bootId: 'boot-1',
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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

async function bootAppWithReady(options: { capabilities?: Record<string, unknown> } = {}) {
  const store = await bootApp()
  act(() => {
    messageHandler?.(readyFrame(options))
  })
  return { sentFrames, dispatched, store }
}

async function receiveInventory({ liveTerminalIds }: { liveTerminalIds: string[] }) {
  act(() => {
    messageHandler?.({
      type: 'terminal.inventory',
      terminals: liveTerminalIds.map((terminalId) => ({
        terminalId,
        title: 'Terminal',
        mode: 'shell',
        createdAt: 1_000,
        lastActivityAt: 1_700,
        status: 'running',
      })),
      terminalMeta: [],
    })
  })
}

async function receiveServerFrame(frame: Record<string, unknown>) {
  act(() => {
    messageHandler?.(frame)
  })
}

async function simulateReconnectWithReady(options: { capabilities?: Record<string, unknown> } = {}) {
  act(() => {
    messageHandler?.(readyFrame(options))
  })
}

function attachResultFor(req: any, terminalId: string) {
  return {
    type: 'pane.reconcile.result',
    reconcileId: req.reconcileId,
    bootId: 'boot-1',
    serverInstanceId: 'srv-1',
    verdicts: req.panes.map((pane: any) => ({
      paneKey: pane.paneKey,
      verdict: 'attach',
      terminalId,
    })),
  }
}

/** Kind-aware all-attach result: terminal panes get a terminalId, fresh-agent panes a sessionRef. */
function mixedAttachResultFor(req: any) {
  return {
    type: 'pane.reconcile.result',
    reconcileId: req.reconcileId,
    bootId: 'boot-1',
    serverInstanceId: 'srv-1',
    verdicts: req.panes.map((pane: any) =>
      pane.kind === 'fresh-agent'
        ? { paneKey: pane.paneKey, verdict: 'attach', sessionRef: { provider: 'claude', sessionId: 'sess-live' } }
        : { paneKey: pane.paneKey, verdict: 'attach', terminalId: 'term-live' }),
  }
}

function lastSent(type: string): any {
  return sentFrames.filter((f) => f.type === type).pop()
}

/** The seeded single terminal leaf's content (tab-1 is the bare leaf). */
function terminalPaneContentOf(store: { getState: () => any }) {
  return (store.getState().panes.layouts as any)['tab-1']?.content
}

describe('App pane.reconcile adoption', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    sentFrames.length = 0
    dispatchedTypes.length = 0
    seededPane = null
    seededFreshAgentPane = null
    setFreshAgentReconcileActive(false)
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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends pane.reconcile.request after ready-with-capability and does NOT run the census', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    await receiveInventory({ liveTerminalIds: [] })
    expect(sentFrames.some((f) => f.type === 'pane.reconcile.request')).toBe(true)
    expect(dispatched.types).not.toContain(clearDeadTerminals.type)
    expect(dispatched.types).toContain(setLiveTerminalIds.type) // non-destructive part stays
  })

  it('runs the legacy census when the server does not ack the capability', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames, dispatched } = await bootAppWithReady({ /* no capabilities */ })
    await receiveInventory({ liveTerminalIds: [] })
    expect(sentFrames.some((f) => f.type === 'pane.reconcile.request')).toBe(false)
    expect(dispatched.types).toContain(clearDeadTerminals.type)
  })

  it('folds a matching pane.reconcile.result', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req = sentFrames.find((f) => f.type === 'pane.reconcile.request')!
    await receiveServerFrame(attachResultFor(req, 'term-77'))
    expect(dispatched.types).toContain(applyReconcileAttach.type)
  })

  it('skips a pane.reconcile.result with a foreign reconcileId (fold-ownership rule)', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req = sentFrames.find((f) => f.type === 'pane.reconcile.request')!
    const foreign = { ...attachResultFor(req, 'term-88'), reconcileId: 'foreign-reconcile-id' }
    await receiveServerFrame(foreign)
    expect(dispatched.types).not.toContain(applyReconcileAttach.type)
    // ...and our own result still folds afterwards (the pending ref survived the foreign frame).
    await receiveServerFrame(attachResultFor(req, 'term-77'))
    expect(dispatched.types).toContain(applyReconcileAttach.type)
  })

  it('cardinality violation falls back to the census, loudly (real wire order: inventory BEFORE result)', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req = sentFrames.find((f) => f.type === 'pane.reconcile.request')!
    // Real handshake order (lib.rs:368-427): terminal.inventory ALWAYS precedes
    // any reconcile result — inject it FIRST; the fallback census must run from
    // the CACHED liveTerminalIds.
    await receiveInventory({ liveTerminalIds: [] })
    await receiveServerFrame({
      type: 'pane.reconcile.result',
      reconcileId: req.reconcileId,
      bootId: 'b',
      serverInstanceId: 's',
      verdicts: [],
    })
    expect(errSpy).toHaveBeenCalled()
    expect(dispatched.types).toContain(clearDeadTerminals.type)
  })

  it('a correlated error frame is TERMINAL for the reconcile — census fallback from cached inventory', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sentFrames, dispatched } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req = sentFrames.find((f) => f.type === 'pane.reconcile.request')!
    await receiveInventory({ liveTerminalIds: [] }) // inventory first — real wire order
    await receiveServerFrame({ type: 'error', code: 'RECONCILE_UNAVAILABLE', requestId: req.reconcileId })
    expect(errSpy).toHaveBeenCalled()
    expect(dispatched.types).toContain(clearDeadTerminals.type) // census ran from cached liveTerminalIds
  })

  it('a later clean App-level fold clears stale warming banner and dead-session adjudication', async () => {
    // Final-review finding 2: foldVerdicts only SETS the batched warming /
    // dead state (counts > 0) — App's fold site must clear it when its
    // all-pane round reports none, or a banner/dialog from an earlier
    // round survives forever.
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames, store } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req1 = sentFrames.find((f) => f.type === 'pane.reconcile.request')!
    // Warming round: banner state set.
    await receiveServerFrame({
      type: 'pane.reconcile.result',
      reconcileId: req1.reconcileId,
      bootId: 'boot-1',
      serverInstanceId: 'srv-1',
      verdicts: req1.panes.map((pane: any) => ({
        paneKey: pane.paneKey,
        verdict: 'error',
        reason: 'index_warming',
      })),
    })
    expect(store.getState().panes.reconcileWarming).not.toBeNull()
    // A dead-sessions dialog from an earlier round is also still up.
    act(() => {
      store.dispatch(setDeadSessionAdjudication([
        { tabId: 'tab-1', paneId: 'pane-1', title: 'Terminal', mode: 'shell' },
      ]))
    })
    // WS reconnect: ready re-sends the App-level request (covers every pane).
    await simulateReconnectWithReady({ capabilities: { paneReconcileV1: true } })
    const req2 = sentFrames.filter((f) => f.type === 'pane.reconcile.request')[1]
    // Clean all-attach round: authoritative — stale batched UI state clears.
    await receiveServerFrame(attachResultFor(req2, 'term-new'))
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(store.getState().panes.deadSessionAdjudication ?? []).toHaveLength(0)
  })

  it('re-sends the reconcile request on EVERY ready (reconnect covers loss windows)', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const { sentFrames } = await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    await simulateReconnectWithReady({ capabilities: { paneReconcileV1: true } })
    expect(sentFrames.filter((f) => f.type === 'pane.reconcile.request')).toHaveLength(2)
  })

  it('ready with both capabilities sends one request including fresh-agent panes and marks them pending', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    const { sentFrames, store } = await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    expect(sentFrames.filter((f) => f.type === 'pane.reconcile.request')).toHaveLength(1)
    const req = lastSent('pane.reconcile.request')
    expect(req.panes.some((p: any) => p.kind === 'fresh-agent')).toBe(true)
    expect(req.panes.some((p: any) => p.kind === 'terminal')).toBe(true)
    const pending = (store.getState().panes as any).reconcilePendingPanes!
    for (const p of req.panes) expect(pending[p.paneKey]).toBeGreaterThan(0)
  })

  it('ready with only paneReconcileV1 sends a terminal-only request', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    await bootAppWithReady({ capabilities: { paneReconcileV1: true } })
    const req = lastSent('pane.reconcile.request')
    expect(req.panes.length).toBeGreaterThan(0)
    expect(req.panes.every((p: any) => p.kind === 'terminal')).toBe(true)
  })

  it('folding the result clears all pending panes', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    const { store } = await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    const req = lastSent('pane.reconcile.request')
    expect(Object.keys((store.getState().panes as any).reconcilePendingPanes ?? {})).not.toHaveLength(0)
    await receiveServerFrame(mixedAttachResultFor(req))
    expect((store.getState().panes as any).reconcilePendingPanes ?? {}).toEqual({})
  })

  it('a correlated error frame clears all pending panes', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store } = await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    const req = lastSent('pane.reconcile.request')
    await receiveInventory({ liveTerminalIds: [] }) // inventory first — real wire order
    expect(Object.keys((store.getState().panes as any).reconcilePendingPanes ?? {})).not.toHaveLength(0)
    await receiveServerFrame({ type: 'error', code: 'RECONCILE_UNAVAILABLE', requestId: req.reconcileId })
    expect((store.getState().panes as any).reconcilePendingPanes ?? {}).toEqual({})
  })

  it('capability-less ready clears pending and deactivates the fresh-agent latch', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    const { store } = await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    expect(isFreshAgentReconcileActive()).toBe(true)
    expect(Object.keys((store.getState().panes as any).reconcilePendingPanes ?? {})).not.toHaveLength(0)
    // Frozen-client invariant: a downgraded server (no capabilities) must land
    // the client back on the legacy path with no stale pending state.
    await simulateReconnectWithReady({ /* no capabilities */ })
    expect(isFreshAgentReconcileActive()).toBe(false)
    expect((store.getState().panes as any).reconcilePendingPanes ?? {}).toEqual({})
  })

  it('ready narrows the ws-client hold to the requested createRequestIds', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    const req = lastSent('pane.reconcile.request')
    expect(wsMocks.setReconcilePendingCreates).toHaveBeenCalledWith(
      req.panes.map((p: any) => p.createRequestId),
    )
  })

  it('folding retracts each folded pane at the sender then clears the hold', async () => {
    seedStoreWithTerminalAndFreshAgentLeaves()
    await bootAppWithReady({
      capabilities: { paneReconcileV1: true, paneReconcileFreshAgentV1: true },
    })
    const req = lastSent('pane.reconcile.request')
    await receiveServerFrame(mixedAttachResultFor(req))
    const retracted = wsMocks.cancelCreate.mock.calls.map(([id]) => id).sort()
    expect(retracted).toEqual(req.panes.map((p: any) => p.createRequestId).sort())
    expect(wsMocks.cancelCreate).toHaveBeenCalledTimes(req.panes.length)
    expect(wsMocks.clearReconcileCreateHold).toHaveBeenCalled()
    // Retraction happens at the sender BEFORE the hold clears.
    const lastClearOrder = wsMocks.clearReconcileCreateHold.mock.invocationCallOrder.at(-1)!
    for (const order of wsMocks.cancelCreate.mock.invocationCallOrder) {
      expect(order).toBeLessThan(lastClearOrder)
    }
  })

  // --- bounded boot-result wait (reconnect-revive Task 2) -------------------
  // A pane.reconcile.result is unicast to THIS socket; if it dies with a
  // dying socket, without a bounded wait the pane wedges pending-verdict
  // forever (gray-and-dead). Fake timers ARE enabled only around the ready
  // delivery and afterward: bootApp's waitFor needs real timers.

  it('falls back to the legacy census when no reconcile result arrives within 10s', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const store = await bootApp()
    vi.useFakeTimers()
    try {
      await simulateReconnectWithReady({ capabilities: { paneReconcileV1: true } })
      // Real wire order: terminal.inventory ALWAYS precedes any reconcile
      // result — the fallback census runs from this CACHED list.
      await receiveInventory({ liveTerminalIds: [] })
      expect(sentFrames.some((f) => f.type === 'pane.reconcile.request')).toBe(true)
      expect(terminalPaneContentOf(store)?.terminalId).toBe('term-old')
      expect(Object.keys((store.getState().panes as any).reconcilePendingPanes ?? {})).not.toHaveLength(0)
      expect(dispatchedTypes).not.toContain(clearDeadTerminals.type)

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

      // The wait expired with the request still pending → the same teardown
      // the correlated-error path runs: pending panes are released and the
      // legacy census wipes the dead handle and re-arms the create path.
      expect((store.getState().panes as any).reconcilePendingPanes ?? {}).toEqual({})
      const paneContent = terminalPaneContentOf(store)
      expect(paneContent?.pendingReconcile).toBeUndefined()
      expect(paneContent?.terminalId).toBeUndefined() // census wiped the stale handle
      expect(paneContent?.status).toBe('creating')    // census re-armed the create path
      expect(dispatchedTypes).toContain(clearDeadTerminals.type)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT run the census when the result folds before the wait expires', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const store = await bootApp()
    vi.useFakeTimers()
    try {
      await simulateReconnectWithReady({ capabilities: { paneReconcileV1: true } })
      await receiveInventory({ liveTerminalIds: [] })
      const req = lastSent('pane.reconcile.request')
      // The server's single warming deferral is 2s — a fold at t=2s is a
      // legitimate deferral, not a lost result; the timer must be disarmed.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      await receiveServerFrame(attachResultFor(req, 'term-live'))
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

      expect(dispatchedTypes).not.toContain(clearDeadTerminals.type)
      const paneContent = terminalPaneContentOf(store)
      expect(paneContent?.terminalId).toBe('term-live') // verdict-written handle kept
      expect(paneContent?.status).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the result wait on disconnect (no offline census)', async () => {
    seedPersistedTerminalPane({ createRequestId: 'cr-1' })
    const store = await bootApp()
    vi.useFakeTimers()
    try {
      await simulateReconnectWithReady({ capabilities: { paneReconcileV1: true } })
      await receiveInventory({ liveTerminalIds: [] })
      expect(sentFrames.some((f) => f.type === 'pane.reconcile.request')).toBe(true)
      expect(disconnectHandler).toBeTypeOf('function')
      const before = { ...terminalPaneContentOf(store) }

      act(() => { disconnectHandler?.() })
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })

      // While disconnected there is no socket the result could still arrive
      // on — the timer must not fire a census from stale inventory; the next
      // ready re-sends the request instead.
      expect(dispatchedTypes).not.toContain(clearDeadTerminals.type)
      expect(terminalPaneContentOf(store)).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

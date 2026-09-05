import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer, { setLiveTerminalIds } from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import tabRegistryReducer from '@/store/tabRegistrySlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import extensionsReducer from '@/store/extensionsSlice'
import turnCompletionReducer, { recordTurnComplete } from '@/store/turnCompletionSlice'
import { networkReducer } from '@/store/networkSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import opencodeActivityReducer, { type OpencodeActivityState } from '@/store/opencodeActivitySlice'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  mergeServerSettings,
  resolveLocalSettings,
  type LocalSettingsPatch,
  type ServerSettingsPatch,
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

function createSettingsState(options: {
  server?: ServerSettingsPatch
  local?: LocalSettingsPatch
  loaded?: boolean
} = {}) {
  const serverSettings = mergeServerSettings(defaultServerSettings, options.server ?? {})
  const localSettings = resolveLocalSettings(options.local)

  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: options.loaded ?? true,
    lastSavedAt: undefined,
  }
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

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    sendTerminalInterest: wsMocks.sendTerminalInterest,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    onDisconnect: wsMocks.onDisconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
    cancelCreate: vi.fn(),
    setReconcilePendingCreates: vi.fn(),
    clearReconcileCreateHold: vi.fn(),
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
  getRecoveryInventory: async () => ({ recoverable: false, contentId: 'test', device: null, otherDevices: [], ledgerOnly: [] }),
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
  fetchSidebarSessionsSnapshot: (options?: unknown) => fetchSidebarSessionsSnapshot(options),
  getTerminalDirectoryPage: (options?: unknown, init?: unknown) => getTerminalDirectoryPage(options, init),
  searchTerminalView: (terminalId: string, query: string, options?: unknown) => searchTerminalView(terminalId, query, options),
  isApiUnauthorizedError: (err: any) => !!err && typeof err === 'object' && err.status === 401,
  isTransientRequestFailure: (err: any) =>
    !!err && (err.name === 'NetworkError' || err.name === 'AbortError' || [502, 503, 504].includes(err.status)),
}))

function createStore(options?: {
  settings?: {
    server?: ServerSettingsPatch
    local?: LocalSettingsPatch
    loaded?: boolean
  }
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
  codexActivity?: Partial<CodexActivityState>
  opencodeActivity?: Partial<OpencodeActivityState>
  sessions?: Record<string, unknown>
}) {
  const defaultCodexActivity: CodexActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
  const defaultOpencodeActivity: OpencodeActivityState = {
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
      opencodeActivity: opencodeActivityReducer,
      tabRegistry: tabRegistryReducer,
      terminalMeta: terminalMetaReducer,
      extensions: extensionsReducer,
      turnCompletion: turnCompletionReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: { ignoredPaths: ['sessions.expandedProjects'] },
      }),
    preloadedState: {
      settings: createSettingsState(options?.settings),
      tabs: { tabs, activeTabId: options?.activeTabId ?? ((tabs[0]?.id as string | undefined) ?? null) },
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
        ...options?.sessions,
      },
      panes,
      network: { status: null, loading: false, configuring: false, error: null },
      codexActivity: {
        ...defaultCodexActivity,
        ...(options?.codexActivity ?? {}),
      },
      opencodeActivity: {
        ...defaultOpencodeActivity,
        ...(options?.opencodeActivity ?? {}),
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
    },
  })
}

async function renderApp(store: ReturnType<typeof createStore>) {
  render(
    <Provider store={store}>
      <App />
    </Provider>
  )
  // Settle: the WS message handler is registered during async bootstrap.
  await waitFor(() => {
    expect(messageHandler).toBeTypeOf('function')
  })
}

const READY_BASE = { type: 'ready', timestamp: '2026-07-25T00:00:00.000Z' }

function sendReady(extra: Record<string, unknown>) {
  act(() => { messageHandler?.({ ...READY_BASE, ...extra }) })
}

function baselines(store: any) {
  return store.getState().turnCompletion.lastAtByTerminalId
}

describe('App restart signals (bootId + serverInstanceId fallback)', () => {
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockReturnValue(() => {})
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    terminalRestoreMocks.addTerminalRestoreRequestId.mockClear()
    terminalRestoreMocks.addTerminalFreshRecoveryRequestId.mockClear()
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    getTerminalDirectoryPage.mockReset()
    getTerminalDirectoryPage.mockResolvedValue({ items: [], revision: 1, nextCursor: null })
    searchTerminalView.mockReset()
    searchTerminalView.mockResolvedValue({ matches: [] })

    // Keep API calls fast and deterministic.
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('bootId change: flags restart, clears live terminals and dedupe baselines; a lower post-restart at is not swallowed', async () => {
    const store = createStore()
    await renderApp(store) // render(<Provider store={store}><App /></Provider>) + settle, per harness
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(setLiveTerminalIds(['term-old']))
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 10_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(10_000)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-2' })

    const conn = store.getState().connection
    expect(conn.serverRestarted).toBe(true)
    expect(conn.bootId).toBe('boot-2')
    expect(conn.liveTerminalIds).toEqual([])
    expect(baselines(store)).toEqual({})

    // THE regression pin (clamp-inflated-at swallow bug, App.tsx:930-933
    // comment): a resumed session's first completion after restart, stamped
    // with a LOWER wall-clock at, must be recorded — never deduped away.
    // (Plumbing note: App mounts useTurnCompletionNotifications, which consumes
    // pendingEvents inside act(), so assert the equivalent reducer-level
    // evidence — a recorded completion advances the dedupe baseline to its
    // `at`; a swallowed one leaves the baseline unset.)
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 2_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(2_000)
  })

  it('bootId absent: a serverInstanceId change is treated as an equivalent restart signal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore()
    await renderApp(store)
    sendReady({ serverInstanceId: 'srv-1' }) // no bootId
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 10_000 }))
    })
    sendReady({ serverInstanceId: 'srv-2' }) // no bootId, instance changed
    expect(store.getState().connection.serverRestarted).toBe(true)
    expect(baselines(store)).toEqual({})
    // Recorded, not swallowed (see plumbing note in the first test: the
    // notifications hook consumes pendingEvents, so check the baseline).
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 2_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(2_000)
    warnSpy.mockRestore()
  })

  it('logs loudly when a ready frame carries no bootId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore()
    await renderApp(store)
    sendReady({ serverInstanceId: 'srv-1' })
    expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('bootId'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('does NOT reset dedupe baselines on a repeat ready with unchanged identity (plain reconnect)', async () => {
    const store = createStore()
    await renderApp(store)
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 5_000 }))
    })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' }) // reconnect, same boot
    expect(baselines(store)['codex:ses-resumed']).toBe(5_000) // survived
    // Replay protection intact: an older at is still deduped.
    // (Plumbing note: App mounts useTurnCompletionNotifications, which consumes
    // pendingEvents inside act(), so assert the reducer-level baseline evidence
    // — a deduped completion leaves the baseline unadvanced.)
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 4_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(5_000)
  })

  it('resets baselines on the FIRST parsed ready (idempotent first-ready reset)', async () => {
    const store = createStore()
    await renderApp(store)
    // Simulate a stale/rehydrated baseline existing BEFORE the first ready
    // (the future-persistence hazard G11 names).
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 9_000 }))
    })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    expect(baselines(store)).toEqual({})
    // Recorded, not swallowed (see plumbing note in the first test: the
    // notifications hook consumes pendingEvents, so check the baseline).
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 1_000 }))
    })
    expect(baselines(store)['codex:ses-resumed']).toBe(1_000)
  })

  it('a malformed ready frame neither wipes identity nor fakes a restart', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createStore()
    await renderApp(store)
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    act(() => {
      store.dispatch(recordTurnComplete({ tabId: 't1', paneId: 'p1', terminalId: 'codex:ses-resumed', at: 5_000 }))
    })
    sendReady({}) // missing serverInstanceId -> safeParse fails
    const conn = store.getState().connection
    expect(conn.serverInstanceId).toBe('srv-1') // NOT wiped
    expect(conn.bootId).toBe('boot-1')          // NOT wiped
    expect(conn.serverRestarted).not.toBe(true) // no spurious restart
    expect(baselines(store)['codex:ses-resumed']).toBe(5_000) // preserved
    errorSpy.mockRestore()
  })
})

describe('App ready buildId → one-shot server-build reload', () => {
  let originalLocation: Location
  let reloadCalls: number
  beforeEach(() => {
    cleanup()
    vi.resetAllMocks()
    stubAudio()
    wsMocks.onReconnect.mockReturnValue(() => {})
    wsMocks.onDisconnect.mockReturnValue(() => {})
    wsMocks.isReady = false
    wsMocks.serverInstanceId = undefined
    terminalRestoreMocks.addTerminalRestoreRequestId.mockClear()
    terminalRestoreMocks.addTerminalFreshRecoveryRequestId.mockClear()
    messageHandler = null

    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })

    fetchSidebarSessionsSnapshot.mockReset()
    fetchSidebarSessionsSnapshot.mockResolvedValue([])
    getTerminalDirectoryPage.mockReset()
    getTerminalDirectoryPage.mockResolvedValue({ items: [], revision: 1, nextCursor: null })
    searchTerminalView.mockReset()
    searchTerminalView.mockResolvedValue({ matches: [] })

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/bootstrap') {
        return Promise.resolve({
          settings: defaultServerSettings,
          platform: { platform: 'linux' },
          shell: { authenticated: true, ready: true },
        })
      }
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      return Promise.resolve({})
    })

    sessionStorage.clear()
    reloadCalls = 0
    // jsdom 25's Location owns `reload` non-configurably — defineProperty on
    // window.location itself throws. Repo precedent (import-retry.test.ts):
    // window-level replacement with save/restore. The reload stub asserts
    // the sentinel is armed AT CALL TIME with the attempted server build id
    // (the ordering proof lives here too, against real jsdom sessionStorage)
    // and counts invocations.
    originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        reload: () => {
          expect(
            sessionStorage.getItem('freshell.server-build-reload'),
            'sentinel must be armed BEFORE reload fires',
          ).toBe('b'.repeat(40))
          reloadCalls++
        },
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    sessionStorage.clear()
  })

  it('mismatched ready buildId triggers exactly one reload, and the sentinel (real sessionStorage, persisting across the simulated reboot) suppresses the next mismatched ready', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(reloadCalls).toBe(1)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBe('b'.repeat(40))

    // The reload lands: the page reboots in the SAME tab (real jsdom
    // sessionStorage persists), the server is still stale, and the next
    // ready must NOT reload again.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'b'.repeat(40) })
    expect(reloadCalls).toBe(1)
  })

  it('a matching ready clears the sentinel and re-arms the guard', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    // A sentinel recorded by an earlier mismatched ready (the attempted
    // server build id), as the production code would have persisted it.
    sessionStorage.setItem('freshell.server-build-reload', 'b'.repeat(40))
    const store = createStore()
    await renderApp(store)

    // Server caught up to the client build (the post-reload convergence
    // case): match → sentinel cleared, no reload.
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'a'.repeat(40) })
    expect(reloadCalls).toBe(0)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })

  it('never reloads on missing or "unknown" buildIds', async () => {
    vi.stubGlobal('__FRESHELL_BUILD_ID__', 'a'.repeat(40))
    const store = createStore()
    await renderApp(store)

    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1' })
    sendReady({ serverInstanceId: 'srv-1', bootId: 'boot-1', buildId: 'unknown' })
    expect(reloadCalls).toBe(0)
    expect(sessionStorage.getItem('freshell.server-build-reload')).toBeNull()
  })
})

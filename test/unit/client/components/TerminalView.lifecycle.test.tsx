import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { act, render, cleanup, waitFor, screen, fireEvent, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer, {
  updatePaneContent,
  removeLayout,
  requestPaneRefresh,
  setPaneCloseError,
  applyReconcileAttach,
  setReconcilePendingPanes,
  clearAllReconcilePendingPanes,
} from '@/store/panesSlice'
import settingsReducer, { defaultSettings, updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setStatus as setConnectionStatus } from '@/store/connectionSlice'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'
import terminalLifecycleReducer from '@/store/terminalLifecycleSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import tabRecencyReducer from '@/store/tabRecencySlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { persistMiddleware, resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  __readTerminalSurfaceCheckpointForTests,
  __resetTerminalCursorCacheForTests,
  saveTerminalSurfaceCheckpoint,
} from '@/lib/terminal-cursor'
import { TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS } from '@/lib/terminal-recovery-accounting'
import { getHydrationQueue, resetHydrationQueueForTests } from '@/lib/hydration-queue'
import { getTerminalActions } from '@/lib/pane-action-registry'
import { createPerfAuditBridge, installPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  // Controllable synchronous transport-readiness seam, matching the real
  // WsClient `get isReady()` (ws-client.ts). Defaults true so the suite's
  // existing send assertions keep their pass-through behavior.
  isReady: true,
  // The per-connection server capability echo (`getServerCapabilities()`,
  // ws-client.ts). Empty by default = old server: every paced-replay branch
  // must fall back to today's wire behavior.
  capabilities: {} as Record<string, unknown>,
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
}))

const restoreMocks = vi.hoisted(() => ({
  consumeTerminalRestoreRequestId: vi.fn(() => false),
  addTerminalRestoreRequestId: vi.fn(),
  clearTerminalRestoreRequestId: vi.fn(),
  consumeTerminalFreshRecoveryRequest: vi.fn(() => undefined),
  addTerminalFreshRecoveryRequestId: vi.fn(),
  armRecoveredLiveTerminalTarget: vi.fn(),
  consumeRecoveredLiveTerminalTarget: vi.fn((): string | undefined => undefined),
}))

const runtimeMocks = vi.hoisted(() => ({
  instances: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}))

// Keep the REAL module exports (RECONCILE_VERDICT_WAIT_MS is defined ONCE in
// ws-client -- never redefined here) and stub only the client accessor.
vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>()
  return {
    ...actual,
    getWsClient: () => ({
      send: wsMocks.send,
      connect: wsMocks.connect,
      onMessage: wsMocks.onMessage,
      onReconnect: wsMocks.onReconnect,
      getServerCapabilities: () => wsMocks.capabilities,
      get isReady() {
        return wsMocks.isReady
      },
    }),
  }
})

function setWsIsReady(value: boolean) {
  wsMocks.isReady = value
}

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: terminalThemeMocks.getTerminalTheme,
}))

vi.mock('@/lib/terminal-restore', () => ({
  consumeTerminalRestoreRequestId: restoreMocks.consumeTerminalRestoreRequestId,
  addTerminalRestoreRequestId: restoreMocks.addTerminalRestoreRequestId,
  clearTerminalRestoreRequestId: restoreMocks.clearTerminalRestoreRequestId,
  consumeTerminalFreshRecoveryRequest: restoreMocks.consumeTerminalFreshRecoveryRequest,
  addTerminalFreshRecoveryRequestId: restoreMocks.addTerminalFreshRecoveryRequestId,
  armRecoveredLiveTerminalTarget: restoreMocks.armRecoveredLiveTerminalTarget,
  consumeRecoveredLiveTerminalTarget: restoreMocks.consumeRecoveredLiveTerminalTarget,
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

const terminalInstances: any[] = []
const latestAttachRequestIdByTerminal = new Map<string, string>()
const latestStreamIdByTerminal = new Map<string, string>()

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    /**
     * Honest-async test mode (round-4 F2): when `deferWrites` is set, a
     * write's completion callback is HELD until the test releases it —
     * modeling xterm's real asynchronous write completion. The default
     * (false) keeps the historical synchronous callback so the existing
     * suite's timing assumptions hold.
     */
    deferWrites = false
    pendingWriteCallbacks: Array<() => void> = []
    write = vi.fn((_data: string, onWritten?: () => void) => {
      if (this.deferWrites && onWritten) {
        this.pendingWriteCallbacks.push(onWritten)
        return
      }
      onWritten?.()
    })
    releasePendingWrites = () => {
      const pending = this.pendingWriteCallbacks.splice(0)
      for (const cb of pending) cb()
    }
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() { terminalInstances.push(this) }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() {
      runtimeMocks.instances.push(this)
    }
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView, {
  __getLastSentViewportCacheSizeForTests,
  __resetLastSentViewportCacheForTests,
  isEngagementInput,
  RESERVE_RETRY_FLOOR_MS,
} from '@/components/TerminalView'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

// Delta round 3, finding 1: the flush writes THIS window's per-window layout key.
const WINDOW_ID = 'client-tv-lifecycle-tests'
sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
const LAYOUT_STORAGE_KEY = `freshell.layout.v3.${WINDOW_ID}`

describe('isEngagementInput (real-keystroke detection)', () => {
  it('treats printable characters and Enter as engagement', () => {
    expect(isEngagementInput('x')).toBe(true)
    expect(isEngagementInput('hello')).toBe(true)
    expect(isEngagementInput('\r')).toBe(true)
    expect(isEngagementInput('\n')).toBe(true)
  })

  it('does NOT treat bare arrow / cursor escape sequences as engagement', () => {
    expect(isEngagementInput('\x1b[A')).toBe(false) // up
    expect(isEngagementInput('\x1b[B')).toBe(false) // down
    expect(isEngagementInput('\x1b[C')).toBe(false) // right
    expect(isEngagementInput('\x1b[D')).toBe(false) // left
    expect(isEngagementInput('\x1bOA')).toBe(false) // application cursor up
    expect(isEngagementInput('\x1b[1;5C')).toBe(false) // ctrl+right
  })

  it('treats a bracketed paste (printable content) as engagement', () => {
    expect(isEngagementInput('\x1b[200~pasted text\x1b[201~')).toBe(true)
  })

  it('does not treat lone control bytes as engagement', () => {
    expect(isEngagementInput('\x00')).toBe(false)
    expect(isEngagementInput('\x1b')).toBe(false)
  })
})

function TerminalViewFromStore({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden?: boolean }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf') return null
    return layout.content
  })
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
}

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function ensureLocalStorageApiForTest() {
  const storage = globalThis.localStorage as Partial<Storage> | undefined
  if (
    storage &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function' &&
    typeof storage.clear === 'function' &&
    typeof storage.key === 'function'
  ) {
    return
  }

  const backing = new Map<string, string>()
  const memoryStorage: Storage = {
    get length() {
      return backing.size
    },
    clear() {
      backing.clear()
    },
    getItem(key: string) {
      return backing.has(key) ? backing.get(key)! : null
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null
    },
    removeItem(key: string) {
      backing.delete(key)
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value))
    },
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  })
}

function clearLocalStorageForTest() {
  ensureLocalStorageApiForTest()
  const storage = globalThis.localStorage as Storage | undefined
  if (!storage) return
  storage.clear()
}

function setLocalStorageItemForTest(key: string, value: string) {
  ensureLocalStorageApiForTest()
  const storage = globalThis.localStorage as Storage | undefined
  if (!storage) return
  storage.setItem(key, value)
}

function latestAttachRequestIdForTerminal(terminalId: string | undefined): string | undefined {
  if (!terminalId) return undefined
  const remembered = latestAttachRequestIdByTerminal.get(terminalId)
  if (remembered) return remembered
  const attach = [...wsMocks.send.mock.calls]
    .map(([msg]) => msg)
    .reverse()
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  return typeof attach?.attachRequestId === 'string' ? attach.attachRequestId : undefined
}

function readPersistedLayoutSnapshotForTest() {
  ensureLocalStorageApiForTest()
  const raw = globalThis.localStorage?.getItem(LAYOUT_STORAGE_KEY)
  return raw ? parsePersistedLayoutRaw(raw) : null
}

function createSettingsState(overrides: Record<string, unknown> = {}) {
  const serverSettings = (overrides.serverSettings as Record<string, unknown> | undefined) ?? createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = (overrides.localSettings as Record<string, unknown> | undefined) ?? resolveLocalSettings()

  return {
    serverSettings,
    localSettings,
    settings: Object.prototype.hasOwnProperty.call(overrides, 'settings')
      ? overrides.settings
      : composeResolvedSettings(serverSettings as never, localSettings as never),
    loaded: true,
    lastSavedAt: undefined,
    ...overrides,
  }
}

function terminalWriteStrings(term: { write: { mock: { calls: Array<[unknown]> } } }): string[] {
  return term.write.mock.calls.map(([data]) => String(data))
}

const MOUNTED_RECONSTRUCTION = '\x18\x1bc\x1b[?25h'

function captureWriteFrames() {
  const callbacks: FrameRequestCallback[] = []
  vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
    callbacks.push(callback)
    return callbacks.length
  })
  return () => {
    while (callbacks.length) callbacks.shift()!(0)
  }
}

function reconstructionWrites(term: { write: { mock: { calls: Array<[unknown]> } } }) {
  return terminalWriteStrings(term).filter((data) => data === MOUNTED_RECONSTRUCTION)
}

function expectTerminalWriteContaining(term: { write: { mock: { calls: Array<[unknown]> } } }, text: string) {
  expect(terminalWriteStrings(term).some((entry) => entry.includes(text))).toBe(true)
}

function withCurrentAttachRequestId<T extends { type?: string; terminalId?: string; attachRequestId?: string }>(
  msg: T & { __preserveMissingAttachRequestId?: boolean; __preserveMissingStreamId?: boolean },
): T {
  const isStreamPayload = msg.type === 'terminal.attach.ready'
    || msg.type === 'terminal.stream.changed'
    || msg.type === 'terminal.modes.sync'
    || msg.type === 'terminal.output'
    || msg.type === 'terminal.output.batch'
    || msg.type === 'terminal.output.gap'
  if (!isStreamPayload || typeof msg.terminalId !== 'string') {
    return msg
  }

  let next: T & { __preserveMissingAttachRequestId?: boolean; __preserveMissingStreamId?: boolean } = msg
  if (!msg.__preserveMissingAttachRequestId && !msg.attachRequestId) {
    const attachRequestId = latestAttachRequestIdForTerminal(msg.terminalId)
    if (attachRequestId) {
      next = { ...next, attachRequestId }
    }
  }

  if (!msg.__preserveMissingStreamId) {
    if (msg.type === 'terminal.attach.ready') {
      const streamId = typeof (next as { streamId?: unknown }).streamId === 'string'
        ? (next as { streamId: string }).streamId
        : (latestStreamIdByTerminal.get(msg.terminalId) ?? `test-stream:${msg.terminalId}`)
      next = { ...next, streamId } as typeof next
      latestStreamIdByTerminal.set(msg.terminalId, streamId)
    } else if (msg.type === 'terminal.output' || msg.type === 'terminal.output.batch' || msg.type === 'terminal.output.gap' || msg.type === 'terminal.modes.sync') {
      const messageStreamId = (next as { streamId?: unknown }).streamId
      const streamId = typeof messageStreamId === 'string' && messageStreamId.length > 0
        ? messageStreamId
        : latestStreamIdByTerminal.get(msg.terminalId)
      if (streamId) {
        next = { ...next, streamId } as typeof next
      }
    }
  }

  if (msg.type === 'terminal.stream.changed') {
    const streamId = (next as { streamId?: unknown }).streamId
    if (typeof streamId === 'string' && streamId.length > 0) {
      latestStreamIdByTerminal.set(msg.terminalId, streamId)
    }
  }

  return next
}

function sentMessages() {
  return wsMocks.send.mock.calls.map(([msg]) => msg)
}

function fireData(term: any, data: string) {
  const handler = term.onData.mock.calls.at(-1)?.[0]
  expect(handler, 'xterm onData handler must be registered').toBeTruthy()
  act(() => handler(data))
}

describe('TerminalView lifecycle updates', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    resetHydrationQueueForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    latestAttachRequestIdByTerminal.clear()
    latestStreamIdByTerminal.clear()
    wsMocks.isReady = true
    wsMocks.capabilities = {}
    wsMocks.send.mockClear()
    wsMocks.send.mockImplementation((msg: any) => {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg.terminalId === 'string'
        && typeof msg.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    })
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
    restoreMocks.consumeTerminalRestoreRequestId.mockReset()
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    restoreMocks.armRecoveredLiveTerminalTarget.mockReset()
    restoreMocks.consumeRecoveredLiveTerminalTarget.mockReset()
    restoreMocks.consumeRecoveredLiveTerminalTarget.mockReturnValue(undefined)
    resetEnsureExtensionsRegistryCacheForTests()
    terminalInstances.length = 0
    runtimeMocks.instances.length = 0
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = (msg: any) => callback(withCurrentAttachRequestId(msg))
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) reconnectHandler = null
      }
    })
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    installPerfAuditBridge(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    resetHydrationQueueForTests()
    delete window.__FRESHELL_TEST_HARNESS__
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
    reconnectHandler = null
    installPerfAuditBridge(null)
  })

  function setupThemeTerminal(overrides: Partial<TerminalPaneContent> = {}) {
    const tabId = 'tab-theme'
    const paneId = 'pane-theme'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-theme',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
      ...overrides,
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: paneContent.mode,
            status: paneContent.status,
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-theme',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    return { store, tabId, paneId, paneContent }
  }

  function getLeafTerminalContent(
    store: ReturnType<typeof setupThemeTerminal>['store'],
    tabId: string,
  ): TerminalPaneContent {
    const layout = store.getState().panes.layouts[tabId]
    expect(layout.type).toBe('leaf')
    expect(layout.content.kind).toBe('terminal')
    return layout.content
  }

  it('enables minimum contrast ratio when terminal theme is light', async () => {
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ isDark: false })
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(4.5)
    })
  })

  it('ignores legacy recovery_failed terminal.status for durable Codex panes', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'thread-durable-1' },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => expect(messageHandler).not.toBeNull())

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: paneContent.createRequestId,
        terminalId: 'term-theme',
        createdAt: Date.now(),
      })
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-theme',
        status: 'running',
      })
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-theme',
        status: 'recovery_failed',
      } as any)
    })

    const content = getLeafTerminalContent(store, tabId)
    expect(content.terminalId).toBe('term-theme')
    expect(content.status).toBe('running')
  })

  it('skips terminal create when the e2e harness suppresses terminal network effects for the pane', () => {
    window.__FRESHELL_TEST_HARNESS__ = {
      getState: vi.fn(),
      dispatch: vi.fn(),
      getWsReadyState: vi.fn(),
      waitForConnection: vi.fn(),
      forceDisconnect: vi.fn(),
      sendWsMessage: vi.fn(),
      setFreshAgentNetworkEffectsSuppressed: vi.fn(),
      isFreshAgentNetworkEffectsSuppressed: vi.fn(() => false),
      setTerminalNetworkEffectsSuppressed: vi.fn(),
      isTerminalNetworkEffectsSuppressed: vi.fn((paneId: string) => paneId === 'pane-theme'),
      getTerminalBuffer: vi.fn(),
      registerTerminalBuffer: vi.fn(),
      unregisterTerminalBuffer: vi.fn(),
      getPerfAuditSnapshot: vi.fn(),
    }

    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    const createCalls = wsMocks.send.mock.calls.filter(
      ([msg]) => msg?.type === 'terminal.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('marks terminal.first_output when the focused terminal renders output', async () => {
    const bridge = createPerfAuditBridge()
    installPerfAuditBridge(bridge)
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-theme',
        terminalId: 'term-1',
        createdAt: Date.now(),
      })
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-1',
        attachRequestId: latestAttachRequestIdForTerminal('term-1'),
        seq: 0,
      })
      messageHandler!({
        type: 'terminal.output',
        terminalId: 'term-1',
        seqStart: 1,
        seqEnd: 1,
        data: 'hello from terminal',
      })
    })

    expect(bridge.snapshot().milestones['terminal.first_output']).toBeTypeOf('number')
  })

  it('keeps default contrast behavior when terminal theme is dark', async () => {
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ isDark: true })
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(1)
    })
  })

  it('updates minimum contrast ratio when switching from dark to light theme at runtime', async () => {
    terminalThemeMocks.getTerminalTheme.mockImplementation((_, appTheme: unknown) => (
      appTheme === 'light' ? { isDark: false } : { isDark: true }
    ))
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(1)
    })

    act(() => {
      store.dispatch(updateSettingsLocal({ theme: 'light' }))
    })

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(4.5)
    })
  })

  it('preserves terminalId across sequential status updates', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-1',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-1',
      terminalId: 'term-1',
      createdAt: Date.now(),
    })

    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId: 'term-1',
      headSeq: 0,
      replayFromSeq: 0,
      replayToSeq: 0,
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(layout.content.status).toBe('running')
  })

  it('keeps the terminal id when recoverable terminal.status messages arrive', async () => {
    const tabId = 'tab-status'
    const paneId = 'pane-status'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-status',
      terminalId: 'term-status',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(persistMiddleware),
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-status',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
        turnCompletion: { terminalStates: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    act(() => {
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-status',
        status: 'recovering',
        reason: 'codex_worker_failure',
      })
    })

    let layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
    expect(layout.content.terminalId).toBe('term-status')
    expect(layout.content.status).toBe('recovering')

    act(() => {
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-status',
        status: 'running',
      })
    })
    layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
    expect(layout.content.terminalId).toBe('term-status')
    expect(layout.content.status).toBe('running')

    act(() => {
      messageHandler!({
        type: 'terminal.exit',
        terminalId: 'term-status',
        exitCode: 0,
      })
    })
    layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
    expect(layout.content.terminalId).toBeUndefined()
    expect(layout.content.status).toBe('exited')
  })

  it('focuses the remembered active pane terminal when tab becomes active', async () => {
    const paneA: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-a',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }
    const paneB: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-b',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              mode: 'shell',
              status: 'running',
              title: 'Tab 1',
              createRequestId: 'tab-1',
            },
            {
              id: 'tab-2',
              mode: 'shell',
              status: 'running',
              title: 'Tab 2',
              createRequestId: 'tab-2',
            },
          ],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {
            'tab-2': 'pane-2b',
          },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    function Tab2TerminalViews() {
      const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
      const hidden = activeTabId !== 'tab-2'

      return (
        <>
          <TerminalView tabId="tab-2" paneId="pane-2a" paneContent={paneA} hidden={hidden} />
          <TerminalView tabId="tab-2" paneId="pane-2b" paneContent={paneB} hidden={hidden} />
        </>
      )
    }

    render(
      <Provider store={store}>
        <Tab2TerminalViews />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(2)
    })
    // Hidden-tab mounts are focus-neutral now: the mount flush must not focus
    // either terminal while the tab is hidden. (This phase previously pinned
    // the ungated mount focus — the exact background-mount steal removed in
    // this task.)
    await act(async () => { await new Promise((r) => setTimeout(r, 150)) })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
    expect(terminalInstances[1].focus).not.toHaveBeenCalled()

    terminalInstances[0].focus.mockClear()
    terminalInstances[1].focus.mockClear()

    act(() => {
      store.dispatch(setActiveTab('tab-2'))
    })

    await waitFor(() => {
      expect(terminalInstances[1].focus).toHaveBeenCalledTimes(1)
    })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('strips BEL from codex output but does not record a client-side turn completion (server-authoritative)', async () => {
    const tabId = 'tab-codex-bell'
    const paneId = 'pane-codex-bell'
    const terminalId = 'term-codex-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-bell',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-bell',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'hello\x07world',
    })

    // BEL is still stripped from the rendered output...
    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === 'helloworld')).toBe(true)
    // ...but codex turn completion is now server-owned (terminal.turn.complete broadcast),
    // so the client must NOT mint a turn-complete from the live BEL.
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('does not record a codex turn-complete from replayed scrollback BEL', async () => {
    const tabId = 'tab-codex-replay'
    const paneId = 'pane-codex-replay'
    const terminalId = 'term-codex-replay'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-replay',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-replay',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 1,
        replayFromSeq: 1,
        replayToSeq: 1,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // A replayed scrollback frame containing a completion BEL must NOT mint a turn-complete.
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: '\x07',
      })
    })

    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('preserves OSC title BEL terminators and does not record turn completion', async () => {
    const tabId = 'tab-codex-osc'
    const paneId = 'pane-codex-osc'
    const terminalId = 'term-codex-osc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-osc',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-osc',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: '\x1b]0;New title\x07',
    })

    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === '\x1b]0;New title\x07')).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('tracks claude terminal runtime activity from submit to output to turn completion', async () => {
    const tabId = 'tab-claude-activity'
    const paneId = 'pane-claude-activity'
    const terminalId = 'term-claude-activity'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-activity',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
            createRequestId: 'req-claude-activity',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Claude is working',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
    // Claude turn completion is now server-owned (terminal.turn.complete broadcast).
    // The client must NOT mint a turn-complete from a replayable scrollback BEL.
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('does not record a Claude turn-complete from replayed scrollback BEL', async () => {
    const tabId = 'tab-claude-replay-bel'
    const paneId = 'pane-claude-replay-bel'
    const terminalId = 'term-claude-replay-bel'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-replay-bel',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '44444444-4444-4444-8444-444444444444',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '44444444-4444-4444-8444-444444444444',
            createRequestId: 'req-claude-replay-bel',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    // Attach with a replay window so the following output frame is replayed scrollback.
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 1,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // A replayed scrollback BEL must NOT mint a client-side turn-complete.
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: '\x07',
      })
    })

    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('does not re-enter working state when claude output arrives after turn completion BEL', async () => {
    const tabId = 'tab-claude-post-bel'
    const paneId = 'pane-claude-post-bel'
    const terminalId = 'term-claude-post-bel'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-post-bel',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '22222222-2222-4222-8222-222222222222',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '22222222-2222-4222-8222-222222222222',
            createRequestId: 'req-claude-post-bel',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    // Step 1: User submits input -> pending
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Complete attach handshake
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // Step 2: Claude produces output -> working
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Claude is thinking...',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Step 3: Turn completion BEL -> cleared
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Step 4: Post-BEL output (Claude's next prompt) -> should STAY cleared
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 3,
        seqEnd: 3,
        data: '\r\n> ',
      })
    })

    // THIS IS THE KEY ASSERTION: activity should still be cleared, not re-set to working
    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('allows working state again after user submits new input following a completed turn', async () => {
    const tabId = 'tab-claude-second-turn'
    const paneId = 'pane-claude-second-turn'
    const terminalId = 'term-claude-second-turn'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-second-turn',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '33333333-3333-4333-8333-333333333333',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '33333333-3333-4333-8333-333333333333',
            createRequestId: 'req-claude-second-turn',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    // First turn: submit -> working -> BEL clear
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'First response',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Post-BEL prompt -- guard should prevent re-triggering
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 3,
        seqEnd: 3,
        data: '\r\n> ',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Second turn: user submits new input -> guard resets
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // New output after second submit -> should set working again
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 4,
        seqEnd: 4,
        data: 'Second response',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('does not show working state for initial prompt output before any user input', async () => {
    const tabId = 'tab-claude-initial'
    const paneId = 'pane-claude-initial'
    const terminalId = 'term-claude-initial'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-initial',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '44444444-4444-4444-8444-444444444444',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '44444444-4444-4444-8444-444444444444',
            createRequestId: 'req-claude-initial',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    // Complete attach handshake (no user input yet)
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // Initial prompt output before any user input
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Welcome to Claude\r\n> ',
      })
    })

    // Should NOT show as working -- no user input has been submitted yet
    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('does not record turn completion for shell mode output', async () => {
    const tabId = 'tab-shell-bell'
    const paneId = 'pane-shell-bell'
    const terminalId = 'term-shell-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-shell-bell',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId,
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-shell-bell',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'hello\x07world',
    })

    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === 'hello\x07world')).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('sends a viewport attach after terminal.created without issuing a second resize', async () => {
    const tabId = 'tab-no-double-attach'
    const paneId = 'pane-no-double-attach'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-double-attach',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'terminal.created',
      requestId: paneContent.createRequestId,
      terminalId: 'term-no-double-attach',
      createdAt: Date.now(),
    })

    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-no-double-attach',
      sinceSeq: 0,
      cols: expect.any(Number),
      rows: expect.any(Number),
    }))
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
      terminalId: 'term-no-double-attach',
    }))
  })

  it('does not send duplicate terminal.resize from attach (visibility effect handles it)', async () => {
    const tabId = 'tab-no-premature-resize'
    const paneId = 'pane-no-premature-resize'

    // Simulate a refresh scenario: pane already has a terminalId from localStorage.
    // The attach() function should NOT send its own terminal.resize. The only resize
    // should come from the visibility effect (which calls fit() first), preventing
    // a premature resize with xterm's default 80×24 that would cause TUI apps like
    // Codex to render at the wrong dimensions (text input at top of pane).
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-premature-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-existing',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-existing',
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // terminal.attach is sent from the attach function
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-existing',
      sinceSeq: 0,
      attachRequestId: expect.any(String),
    }))

    // terminal.resize should be sent before attach by layout effects. The attach() function
    // itself must not send an additional resize after attach is emitted.
    const resizeCalls = wsMocks.send.mock.calls.filter(
      ([msg]: [any]) => msg.type === 'terminal.resize'
    )
    expect(resizeCalls.length).toBeGreaterThan(0)

    // Every resize must occur before attach.
    const allCalls = wsMocks.send.mock.calls.map(([msg]: [any]) => msg.type)
    const attachIdx = allCalls.indexOf('terminal.attach')
    const resizeIndices = allCalls
      .map((type, idx) => ({ type, idx }))
      .filter((entry) => entry.type === 'terminal.resize')
      .map((entry) => entry.idx)
    expect(resizeIndices.every((idx) => idx < attachIdx)).toBe(true)
  })

  it('does not attach or resize hidden tabs until they become visible', async () => {
    const tabId = 'tab-hidden-resize'
    const paneId = 'pane-hidden-resize'

    // Hidden (background) tabs should not send any resize on attach.
    // The visibility effect skips hidden tabs, and attach() no longer sends resize.
    // The correct resize will be sent when the tab becomes visible.
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-hidden-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-hidden',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-hidden',
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: 'some-other-tab',
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-hidden',
    }))
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
    }))
  })

  it('ignores INVALID_TERMINAL_ID errors for other terminals', async () => {
    const tabId = 'tab-2'
    const paneId = 'pane-2'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-2',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-1',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-1',
            createRequestId: 'req-2',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-2',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
    }))
  })

  it('recreates terminal once after INVALID_TERMINAL_ID when canonical durable identity exists', async () => {
    const tabId = 'tab-3'
    const paneId = 'pane-3'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-3',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-3',
      sessionRef: {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-3',
            createRequestId: 'req-3',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()
    const onMessageCallsBefore = wsMocks.onMessage.mock.calls.length

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-3',
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.createRequestId).not.toBe('req-3')
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    const newPaneContent = layout.content as TerminalPaneContent
    const newRequestId = newPaneContent.createRequestId

    rerender(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={newPaneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage.mock.calls.length).toBeGreaterThan(onMessageCallsBefore)
    })

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThanOrEqual(1)
    })

    const createCalls = wsMocks.send.mock.calls.filter(([msg]) =>
      msg?.type === 'terminal.create' && msg.requestId === newRequestId
    )
    expect(createCalls).toHaveLength(1)
  })

  // Branch-5 / reconcile-verdict interaction (design invariant 7): once the
  // reconcile flow owns a pane's fate, the INVALID_TERMINAL_ID auto-recovery
  // must stand down. Without this guard, a post-restart attach error resumes
  // the very session a dead_session verdict just declared dead -- observed in
  // the Task 11 e2e wall as duplicate `claude --resume <deleted-session>`
  // PTYs that the adjudication panel never adopts.
  function setupReconcileOwnedPane(panesExtra: Record<string, unknown>) {
    const tabId = 'tab-reconcile-owned'
    const paneId = 'pane-reconcile-owned'
    const terminalId = 'term-reconcile-owned'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-reconcile-owned',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      sessionRef: {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440042',
      },
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
          ...panesExtra,
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    return { store, tabId, paneId, terminalId, paneContent }
  }

  it('does not auto-recover from INVALID_TERMINAL_ID while the pane awaits dead-session adjudication', async () => {
    const { store, tabId, paneId, terminalId, paneContent } = setupReconcileOwnedPane({
      deadSessionAdjudication: [{
        tabId: 'tab-reconcile-owned',
        paneId: 'pane-reconcile-owned',
        title: 'Claude',
        mode: 'claude',
        sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440042' },
      }],
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId,
      })
    })

    // The pane is untouched: no minted recovery createRequestId, no
    // resume-create sent -- the adjudication panel owns the next step.
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).toBe('req-reconcile-owned')
    expect(layout.content.terminalId).toBe(terminalId)
    expect(layout.content.status).toBe('running')
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)
  })

  it('does not auto-recover from INVALID_TERMINAL_ID during the bounded pre-verdict reconcile window', async () => {
    const { store, tabId, paneId, terminalId, paneContent } = setupReconcileOwnedPane({
      reconcilePendingPanes: { 'tab-reconcile-owned:pane-reconcile-owned': Date.now() },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId,
      })
    })

    // The in-flight verdict drives the pane; the error round must not race
    // it with an eager resume-create.
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).toBe('req-reconcile-owned')
    expect(layout.content.terminalId).toBe(terminalId)
    expect(layout.content.status).toBe('running')
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)
  })

  it('marks durable INVALID_TERMINAL_ID reconnects as restore regardless of wasRestore', async () => {
    // consumeTerminalRestoreRequestId returns false by default (non-restore terminal)
    // This is the common case: terminals created fresh, not from localStorage restore
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    const tabId = 'tab-reconnect-restore'
    const paneId = 'pane-reconnect-restore'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-reconnect-restore',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-reconnect-restore',
      sessionRef: {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
      },
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-reconnect-restore',
            createRequestId: 'req-reconnect-restore',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    restoreMocks.addTerminalRestoreRequestId.mockClear()

    // Wire the mocks together: when addTerminalRestoreRequestId is called,
    // subsequent consumeTerminalRestoreRequestId calls for that ID return true.
    const addedRestoreIds = new Set<string>()
    restoreMocks.addTerminalRestoreRequestId.mockImplementation((id: string) => {
      addedRestoreIds.add(id)
    })
    restoreMocks.consumeTerminalRestoreRequestId.mockImplementation((id: string) => {
      if (addedRestoreIds.has(id)) {
        addedRestoreIds.delete(id)
        return true
      }
      return false
    })

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-reconnect-restore',
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.createRequestId).not.toBe('req-reconnect-restore')
    })

    // The key assertion: addTerminalRestoreRequestId MUST be called even when
    // the original terminal was NOT a restore (wasRestore=false).
    expect(restoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledTimes(1)
    const newRequestId = (store.getState().panes.layouts[tabId] as any).content.createRequestId
    expect(restoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledWith(newRequestId)

    // Rerender with new content to trigger sendCreate
    const newPaneContent = (store.getState().panes.layouts[tabId] as any).content as TerminalPaneContent
    rerender(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={newPaneContent} />
      </Provider>
    )

    // Verify the terminal.create message includes restore: true
    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) =>
        msg?.type === 'terminal.create' && msg.requestId === newRequestId
      )
      expect(createCalls.length).toBeGreaterThanOrEqual(1)
      expect(createCalls[0][0].restore).toBe(true)
    })
  })

  it('uses sessionRef replayed by terminal.attach.ready for an immediate invalid-terminal reconnect', async () => {
    const tabId = 'tab-opencode-attach-ready-replay'
    const paneId = 'pane-opencode-attach-ready-replay'
    const sessionRef = {
      provider: 'opencode',
      sessionId: 'ses_root_attach_ready_replay',
    }

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-opencode-attach-ready-replay',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      terminalId: 'term-opencode-attach-ready-replay',
      serverInstanceId: 'srv-old',
      initialCwd: '/repo/project',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'opencode',
            status: 'running',
            title: 'OpenCode',
            titleSetByUser: false,
            terminalId: 'term-opencode-attach-ready-replay',
            createRequestId: 'req-opencode-attach-ready-replay',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-new' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => (
        msg?.type === 'terminal.attach'
        && msg.terminalId === 'term-opencode-attach-ready-replay'
      ))).toBe(true)
    })

    restoreMocks.addTerminalRestoreRequestId.mockClear()
    restoreMocks.addTerminalFreshRecoveryRequestId.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-opencode-attach-ready-replay',
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        sessionRef,
      })
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId: 'term-opencode-attach-ready-replay',
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId]
      if (layout?.type !== 'leaf') throw new Error('unexpected layout')
      if (layout.content.kind !== 'terminal') throw new Error('unexpected content')
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.status).toBe('creating')
      expect(layout.content.sessionRef).toEqual(sessionRef)
      expect(layout.content.createRequestId).not.toBe('req-opencode-attach-ready-replay')
      expect(restoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledWith(layout.content.createRequestId)
    })
    expect(restoreMocks.addTerminalFreshRecoveryRequestId).not.toHaveBeenCalled()
  })

  it('does not reconnect when a restored launch fails before the first attach completes', async () => {
    const tabId = 'tab-restore-startup-failure'
    const paneId = 'pane-restore-startup-failure'
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-startup-failure',
      status: 'creating',
      mode: 'opencode',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'opencode',
            status: 'creating',
            title: 'OpenCode',
            titleSetByUser: false,
            createRequestId: 'req-restore-startup-failure',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    const term = terminalInstances[0]
    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-restore-startup-failure',
        terminalId: 'term-restore-startup-failure',
        createdAt: Date.now(),
      })
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'OpenCode exited during startup (exit 1). Last output: execvp(3) failed.: No such file or directory',
        terminalId: 'term-restore-startup-failure',
        terminalExitCode: 1,
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.status).toBe('error')
      expect(layout.content.terminalId).toBeUndefined()
    })

    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
    expect(tab?.status).toBe('error')
    expectTerminalWriteContaining(term, '[Restore failed]')
    expectTerminalWriteContaining(term, 'execvp(3) failed.: No such file or directory')
  })

  it('writes the resume-validation notice into the terminal on terminal.created', async () => {
    const tabId = 'tab-resume-validation-notice'
    const paneId = 'pane-resume-validation-notice'
    const notice = 'Saved amplifier session 8dab420a-f76b-407c-bcbe-dfb2a971c2e1 could not be found on disk — started a fresh session instead.'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-resume-validation-notice',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'creating',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-resume-validation-notice',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    const term = terminalInstances[0]

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-resume-validation-notice',
        terminalId: 'term-resume-validation-notice',
        createdAt: Date.now(),
        notice,
      })
    })

    await waitFor(() => {
      expectTerminalWriteContaining(term, 'Saved amplifier session 8dab420a-f76b-407c-bcbe-dfb2a971c2e1')
    })
  })

  it('clears the persisted sessionRef/resumeSessionId when terminal.created carries a notice', async () => {
    const tabId = 'tab-resume-validation-clear'
    const paneId = 'pane-resume-validation-clear'
    const staleSessionRef = {
      provider: 'codex',
      sessionId: '8dab420a-f76b-407c-bcbe-dfb2a971c2e1',
    }

    // codex/opencode shape: the created frame carries a notice but NO
    // sessionRef — the gate's fallback for these modes is None, so no
    // sessionRef overwrite will heal the pane.
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-resume-validation-clear',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      sessionRef: staleSessionRef,
      resumeSessionId: staleSessionRef.sessionId,
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'creating',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-resume-validation-clear',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-resume-validation-clear',
        terminalId: 'term-resume-validation-clear',
        createdAt: Date.now(),
        notice: 'Saved codex session 8dab420a-f76b-407c-bcbe-dfb2a971c2e1 could not be found on disk — started a fresh session instead.',
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId]
      if (layout?.type !== 'leaf') throw new Error('unexpected layout')
      if (layout.content.kind !== 'terminal') throw new Error('unexpected content')
      expect(layout.content.terminalId).toBe('term-resume-validation-clear')
      expect(layout.content.sessionRef).toBeUndefined()
      expect(layout.content.resumeSessionId).toBeUndefined()
    })
  })

  it('settles a clean restored attach startup exit as exited', async () => {
    const tabId = 'tab-clean-restore-attach-exit'
    const paneId = 'pane-clean-restore-attach-exit'
    const sessionRef = {
      provider: 'opencode',
      sessionId: 'ses_clean_restore_attach_exit',
    }
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-clean-restore-attach-exit',
      status: 'creating',
      mode: 'opencode',
      shell: 'system',
      sessionRef,
      restoreError: { reason: 'dead_live_handle' },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'opencode',
            status: 'creating',
            title: 'OpenCode',
            titleSetByUser: false,
            createRequestId: 'req-clean-restore-attach-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    const term = terminalInstances[0]
    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-clean-restore-attach-exit',
        terminalId: 'term-clean-restore-attach-exit',
        createdAt: Date.now(),
      })
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'OpenCode exited during startup (exit 0). Last output: done',
        terminalId: 'term-clean-restore-attach-exit',
        terminalExitCode: 0,
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.status).toBe('exited')
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.streamId).toBeUndefined()
      expect(layout.content.restoreError).toBeUndefined()
    })

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
    expect(tab?.status).toBe('exited')
    expect(terminalWriteStrings(term).some((entry) => entry.includes('[Restore failed]'))).toBe(false)
    expectTerminalWriteContaining(term, '[Restored terminal exited cleanly')
  })

  it('settles a clean restored direct startup exit as exited', async () => {
    const tabId = 'tab-clean-restore-direct-exit'
    const paneId = 'pane-clean-restore-direct-exit'
    const sessionRef = {
      provider: 'opencode',
      sessionId: 'ses_clean_restore_direct_exit',
    }
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-clean-restore-direct-exit',
      status: 'creating',
      mode: 'opencode',
      shell: 'system',
      sessionRef,
      restoreError: { reason: 'dead_live_handle' },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'opencode',
            status: 'creating',
            title: 'OpenCode',
            titleSetByUser: false,
            createRequestId: 'req-clean-restore-direct-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    const term = terminalInstances[0]
    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-clean-restore-direct-exit',
        terminalId: 'term-clean-restore-direct-exit',
        createdAt: Date.now(),
      })
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.exit',
        terminalId: 'term-clean-restore-direct-exit',
        exitCode: 0,
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.status).toBe('exited')
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.streamId).toBeUndefined()
      expect(layout.content.restoreError).toBeUndefined()
    })

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
    expect(tab?.status).toBe('exited')
    expect(terminalWriteStrings(term).some((entry) => entry.includes('[Restore failed]'))).toBe(false)
    expectTerminalWriteContaining(term, '[Restored terminal exited cleanly')
  })

  it('marks startup exit before first attach as a launch failure', async () => {
    const tabId = 'tab-startup-exit'
    const paneId = 'pane-startup-exit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-startup-exit',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'creating',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-startup-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    const term = terminalInstances[0]
    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-startup-exit',
        terminalId: 'term-startup-exit',
        createdAt: Date.now(),
      })
    })

    wsMocks.send.mockClear()

    act(() => {
      messageHandler!({
        type: 'terminal.exit',
        terminalId: 'term-startup-exit',
        exitCode: 2,
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.status).toBe('error')
      expect(layout.content.terminalId).toBeUndefined()
    })

    expect(wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')).toHaveLength(0)
    expect(store.getState().tabs.tabs.find((entry) => entry.id === tabId)?.status).toBe('error')
    expectTerminalWriteContaining(term, '[Launch failed] The terminal exited before it finished starting (exit 2).')
  })

  it('marks restored terminal.create requests', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore'
    const paneId = 'pane-restore'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-restore',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThan(0)
      expect(createCalls[0][0].restore).toBe(true)
    })
  })

  it('retries terminal.create after RATE_LIMITED errors', async () => {
    vi.useFakeTimers()
    const tabId = 'tab-rate-limit'
    const paneId = 'pane-rate-limit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-rate-limit',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-rate-limit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(messageHandler).not.toBeNull()

    const createCallsBefore = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsBefore.length).toBeGreaterThan(0)

    messageHandler!({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many terminal.create requests',
      requestId: 'req-rate-limit',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('creating')

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    const createCallsAfter = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsAfter.length).toBe(createCallsBefore.length + 1)
  })

  describe('D7-refusal revival (close→reopen reattach)', () => {
    function setupRevivalPane() {
      const tabId = 'tab-revive'
      const paneId = 'pane-revive'

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-revive',
        status: 'creating',
        mode: 'shell',
        shell: 'system',
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: 'creating',
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: 'req-revive',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null },
        },
      })

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      return { store, tabId, paneId }
    }

    const d7Refusal = (requestId: string) => ({
      type: 'error' as const,
      code: 'RESTORE_UNAVAILABLE',
      message: 'Session sess-live is still running on the server.',
      requestId,
      liveTerminalId: 't-live-owner',
    })

    it('reattaches the pane to the live owner the enriched refusal names — never the dead-end write', async () => {
      const { store, tabId } = setupRevivalPane()

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(
          wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create'),
        ).toHaveLength(1)
      })

      // The D7 refusal lands carrying the STILL-RUNNING owner id (the
      // close→reopen fallback shape: open pane, live server-side owner).
      act(() => {
        messageHandler!(d7Refusal('req-revive'))
      })

      // The revival fold: store state gains the live handle via the new
      // reducer — never status:'error', and createRequestId stays put
      // (council rule 2: never re-minted).
      const revived = getLeafTerminalContent(store, tabId)
      expect(revived.terminalId).toBe('t-live-owner')
      expect(revived.status).toBe('running')
      expect(revived.restoreError).toBeUndefined()
      expect(revived.createRequestId).toBe('req-revive')

      // The epoch bump re-fires the lifecycle effect, so a terminal.attach for
      // the NAMED id leaves the client — and no second terminal.create is sent.
      await waitFor(() => {
        expect(
          wsMocks.send.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 't-live-owner'),
        ).toHaveLength(1)
      })
      expect(
        wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.create'),
      ).toHaveLength(1)

      // The pane announces the reconnection — never the dead-end write.
      const term = terminalInstances[0]
      expectTerminalWriteContaining(term, 'Reconnected to the still-running session.')
      expect(terminalWriteStrings(term).some((entry) => entry.includes('[Restore failed]'))).toBe(false)
      expect(terminalWriteStrings(term).some((entry) => entry.includes('[Launch failed]'))).toBe(false)
    })

    it('revives at most once per createRequestId — the second refusal lands the existing error write', async () => {
      const { store, tabId } = setupRevivalPane()

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(
          wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create'),
        ).toHaveLength(1)
      })

      // First refusal revives the pane onto the live owner…
      act(() => {
        messageHandler!(d7Refusal('req-revive'))
      })
      await waitFor(() => {
        expect(
          wsMocks.send.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 't-live-owner'),
        ).toHaveLength(1)
      })
      const attachesAfterRevival = wsMocks.send.mock.calls.map(([msg]) => msg).filter(
        (msg) => msg?.type === 'terminal.attach',
      ).length

      // …but if the live handle died in the race, the follow-on refusal for
      // the same createRequestId must NOT loop the revival — it falls through
      // to the existing dead-end error write.
      act(() => {
        messageHandler!(d7Refusal('req-revive'))
      })

      const fallen = getLeafTerminalContent(store, tabId)
      expect(fallen.status).toBe('error')
      expect(
        wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.attach'),
      ).toHaveLength(attachesAfterRevival)
      expect(
        wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.create'),
      ).toHaveLength(1)

      const term = terminalInstances[0]
      expectTerminalWriteContaining(term, 'Reconnected to the still-running session.')
      expectTerminalWriteContaining(term, 'Session sess-live is still running on the server.')
      expect(
        terminalWriteStrings(term).filter((entry) => entry.includes('Reconnected to the still-running session.')),
      ).toHaveLength(1)
    })
  })

  // ── kata b8ke Task 9: typed launch-failure cards + the fresh-owner
  // divergence recovery card ──
  describe('typed launch failures + fresh-owner divergence (kata b8ke)', () => {
    const TYPED_SESSION_ID = 'sid-b8ke-x'

    function runtimeOwnerFrame(overrides: Record<string, unknown> = {}) {
      return {
        type: 'session.runtimeOwner',
        provider: 'codex',
        sessionId: TYPED_SESSION_ID,
        epoch: 1,
        generation: 1,
        ownerKind: 'terminal',
        terminalId: 't-prev',
        operationId: 'handoff-b8ke',
        transition: 'handoff-committed',
        ...overrides,
      }
    }

    function setupTypedPane(options: {
      content?: Partial<TerminalPaneContent>
      tabMetadata?: Record<string, { sessionType?: string }>
      seed?: (store: ReturnType<typeof configureStore>) => void
    } = {}) {
      const tabId = 'tab-b8ke'
      const paneId = 'pane-b8ke'

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-b8ke',
        status: 'creating',
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        ...options.content,
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          freshAgent: freshAgentReducer,
          // The production store always mounts the ephemeral exit/notice
          // slice (store.ts); the focused-fix-2 killed-session test pins the
          // exit-record-driven recovery affordance, whose render conditions
          // read it (selectExitRecord).
          terminalLifecycle: terminalLifecycleReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'codex',
              status: 'creating',
              title: 'Codex',
              titleSetByUser: false,
              createRequestId: 'req-b8ke',
              ...(options.tabMetadata ? { sessionMetadataByKey: options.tabMetadata } : {}),
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null },
        },
      })

      options.seed?.(store)

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      return { store, tabId, paneId }
    }

    const createCalls = () => sentMessages().filter((msg) => msg?.type === 'terminal.create')

    it('typed fresh-owner refusal renders a recoverable card with retry and open-as-fresh-agent actions', async () => {
      const { store } = setupTypedPane()

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })

      // The session is owned by a FRESH-AGENT runtime (no liveTerminalId —
      // the D7 revival path does not apply).
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'RESTORE_UNAVAILABLE',
          message: `Session ${TYPED_SESSION_ID} is still running on the server.`,
          requestId: 'req-b8ke',
          ownerKind: 'fresh-agent',
          ownerGeneration: 4,
          ownerEpoch: 1,
          timestamp: new Date().toISOString(),
        })
      })

      const card = await screen.findByTestId('terminal-launch-failure-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(card).toHaveTextContent(/open as a fresh agent/i)
      expect(within(card).getByRole('button', { name: 'Retry launch' })).toBeInTheDocument()
      expect(within(card).getByRole('button', { name: 'Open as Fresh Agent' })).toBeInTheDocument()
      // No liveTerminalId on the refusal → no attach action.
      expect(within(card).queryByRole('button', { name: 'Attach to running session' })).toBeNull()

      // The frozen wire-text notice still lands in the terminal surface
      // (byte-frozen contract preserved alongside the typed card).
      const term = terminalInstances[0]
      expectTerminalWriteContaining(term, '[Launch failed]')

      // Retry launch re-sends terminal.create with the SAME sessionRef and
      // createRequestId (never re-minted), carrying the observed fence.
      fireEvent.click(within(card).getByRole('button', { name: 'Retry launch' }))
      await waitFor(() => {
        expect(createCalls()).toHaveLength(2)
      })
      expect(createCalls()[1]).toMatchObject({
        requestId: 'req-b8ke',
        sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
      })
      // The retry cleared the typed card.
      await waitFor(() => {
        expect(screen.queryByTestId('terminal-launch-failure-card')).toBeNull()
      })
      const leaf = store.getState().panes.layouts['tab-b8ke']
      if (leaf?.type === 'leaf' && leaf.content.kind === 'terminal') {
        expect(leaf.content.launchFailure).toBeUndefined()
      }
    })

    it('typed handoff-in-progress refusal renders a retryable card with no attach action', async () => {
      setupTypedPane()

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })

      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          message: 'Another terminal.create for this sessionRef is in flight',
          requestId: 'req-b8ke',
          retryAfterMs: 30_000,
          ownerKind: 'terminal',
          ownerGeneration: 2,
          ownerEpoch: 1,
          timestamp: new Date().toISOString(),
        })
      })

      const card = await screen.findByTestId('terminal-launch-failure-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(within(card).getByRole('button', { name: 'Retry launch' })).toBeInTheDocument()
      expect(within(card).queryByRole('button', { name: 'Open as Fresh Agent' })).toBeNull()
      expect(within(card).queryByRole('button', { name: 'Attach to running session' })).toBeNull()
    })

    // b8ke ext r35 F1: an AUTOMATIC re-drive of the same request carries
    // the request's ORIGINAL observed pair — never a refreshed one. Pre-r35
    // every sendCreate re-read the record at send time, so this scenario
    // (a gen-5 request refused after another device advanced the record to
    // gen 9) resent with the refreshed gen-9 pair — and since failed
    // creates leave the server's dedupe state and a gen-9 Vacant grants a
    // gen-9 claim, the OLD request recreated a terminal the newer
    // lifecycle had explicitly stopped. The honest automatic contract: the
    // original pair flows to the server, which refuses it typed (the
    // delayed-request safety net); the failure card's user-initiated
    // Retry (a NEW lifecycle decision) is what may capture a fresh fence.
    it('a stale-fence create refusal re-drives with the ORIGINAL observed pair, never a refreshed one', async () => {
      const { store } = setupTypedPane({
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({ generation: 5 })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })
      // The first create carried the observed fence (epoch 1, generation 5).
      expect(createCalls()[0]).toMatchObject({
        requestId: 'req-b8ke',
        observedEpoch: 1,
        observedGeneration: 5,
      })

      // Ownership moves on (generation 9) BEFORE the refusal lands.
      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({ generation: 9 })))
      })

      // The server's stale-fence refusal (the wire shape: SESSION_RESERVED
      // code, stale-generation message, no owner fields, no retry hint).
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          message: 'Session ownership moved on (stale observed generation); refresh and retry.',
          requestId: 'req-b8ke',
          timestamp: new Date().toISOString(),
        })
      })

      // The bounded re-drive re-sends the create carrying the ORIGINAL
      // (epoch 1, generation 5) pair — the request's own observation, so
      // the server's stale-generation safety net refuses it typed (the
      // automatic retry can never present the old request as current).
      await waitFor(() => {
        expect(createCalls()).toHaveLength(2)
      })
      expect(createCalls()[1]).toMatchObject({
        requestId: 'req-b8ke',
        sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        observedEpoch: 1,
        observedGeneration: 5,
      })
      // NEVER the refreshed pair: the gen-9 record did not license the old
      // request.
      expect(createCalls()[1].observedGeneration).not.toBe(9)
    })

    // b8ke fence-heal (fix c): the create's committed owner pair rides the
    // terminal.created frame — folding it BEFORE the queued attach fires
    // means a just-created pane's FIRST attach is born fresh even when the
    // store still holds a stale pre-create record (the attach re-selects
    // the fence from the store at send time).
    it('folds the created frame owner pair so the queued attach is born fresh over a stale record', async () => {
      // describe-scoped messageHandler capture (wsMocks.onMessage) + file-scoped sentMessages()
      const { store } = await setupTypedPane({
        // seed the STALE pre-create record via the seed CALLBACK (the proven
        // idiom from the r35 test at :3604-3608):
        seed: (seededStore) => {
          act(() => seededStore.dispatch(applyRuntimeOwner(
            runtimeOwnerFrame({ provider: 'codex', sessionId: TYPED_SESSION_ID, generation: 3 }),
          )))
        },
      })
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-b8ke',
        terminalId: 'tid-new-1',
        createdAt: Date.now(),
        sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID, startedAt: 0 },
        ownerKind: 'terminal',
        ownerEpoch: 9,
        ownerGeneration: 6,
      })
      const attach = sentMessages().find((m: any) => m.type === 'terminal.attach')!
      expect(attach.observedEpoch).toBe(9)
      expect(attach.observedGeneration).toBe(6) // the committed pair, NOT the stale 3
      // and the store record advanced:
      const rec = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(rec.generation).toBe(6)
    })

    // b8ke fence-heal (fix b): the typed create refusal's CURRENT pair
    // folds into the pane's runtimeOwners record (merge-only) — the
    // automatic re-drive keeps its captured per-request pair (the r35
    // contract), and the NEXT decision (the card's user Retry launch, a
    // reconcileEpoch bump) re-captures the FRESH pair from the folded store.
    it('a typed create refusal folds the fresh pair; the re-drive keeps the ORIGINAL pair and the user Retry re-captures fresh (fix b)', async () => {
      const { store } = setupTypedPane({
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({ generation: 5 })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })
      // The first create carried the observed fence (epoch 1, generation 5).
      expect(createCalls()[0]).toMatchObject({
        requestId: 'req-b8ke',
        observedEpoch: 1,
        observedGeneration: 5,
      })

      // The typed refusal carrying the coordinator's CURRENT pair (the
      // in-flight-lease shape: ownerKind present, no stale-generation
      // prefix — the bounded automatic re-drive still applies).
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          message: 'Another terminal.create for this sessionRef is in flight',
          requestId: 'req-b8ke',
          ownerKind: 'terminal',
          ownerEpoch: 1,
          ownerGeneration: 9,
          timestamp: new Date().toISOString(),
        })
      })

      // The fold landed on the pane's owner record (merge-only: the
      // refusal's current pair never clears the owner identity).
      const folded = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(folded.generation).toBe(9)
      expect(folded.ownerKind).toBe('terminal')

      // r35 intact: the automatic re-drive re-sends the SAME request
      // carrying the ORIGINAL (epoch 1, generation 5) pair.
      await waitFor(() => {
        expect(createCalls()).toHaveLength(2)
      })
      expect(createCalls()[1]).toMatchObject({
        requestId: 'req-b8ke',
        observedEpoch: 1,
        observedGeneration: 5,
      })
      expect(createCalls()[1].observedGeneration).not.toBe(9)

      // The user's Retry launch is a NEW lifecycle decision (the
      // reconcileEpoch bump is its only re-fire signal) — it re-captures
      // the FRESH (folded) pair.
      const card = await screen.findByTestId('terminal-launch-failure-card')
      fireEvent.click(within(card).getByRole('button', { name: 'Retry launch' }))

      await waitFor(() => {
        expect(createCalls()).toHaveLength(3)
      })
      expect(createCalls()[2]).toMatchObject({
        requestId: 'req-b8ke',
        observedEpoch: 1,
        observedGeneration: 9,
      })
    })

    // b8ke fence-heal (fix b): the pane-terminal-scoped typed refusal (no
    // requestId, the pane's own terminalId — a refused attach or a
    // fire-and-forget kill, identical frame shape) previously matched NO
    // branch: the pane silently never attached (the wedge). The fold
    // refreshes the fence so the NEXT attach — the reconnect path falls
    // through unconditionally to attachTerminal, and the send-time fence
    // read re-selects from the store — carries the fresh pair.
    it('a pane-terminal-scoped typed refusal folds the fresh pair and the next attach carries it (fix b)', async () => {
      const { store } = setupTypedPane({
        content: { status: 'running', terminalId: 't-attach-b8ke' },
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
              generation: 3,
              terminalId: 't-attach-b8ke',
            })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        const mountAttach = sentMessages().find((m: any) => m.type === 'terminal.attach')
        expect(mountAttach).toBeTruthy()
      })
      // The mount-time attach carried the observed fence (epoch 1, generation 3).
      const mountAttach = sentMessages().find((m: any) => m.type === 'terminal.attach')!
      expect(mountAttach).toMatchObject({
        terminalId: 't-attach-b8ke',
        observedEpoch: 1,
        observedGeneration: 3,
      })

      // The typed refusal: no requestId, the pane's own terminalId.
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          terminalId: 't-attach-b8ke',
          ownerEpoch: 1,
          ownerGeneration: 8,
          message: 'Session ownership moved on (stale observed generation); refresh and retry.',
          timestamp: new Date().toISOString(),
        })
      })

      // The fold landed on the pane's owner record.
      const folded = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(folded.generation).toBe(8)

      // The next attach (driven via the reconnect handler — it falls
      // through unconditionally to attachTerminal for visible panes with
      // a terminalId) carries the FRESH pair from the send-time fence read.
      act(() => {
        reconnectHandler?.()
      })
      const reattach = [...sentMessages()]
        .reverse()
        .find((m: any) => m.type === 'terminal.attach')!
      expect(reattach).toMatchObject({
        terminalId: 't-attach-b8ke',
        observedEpoch: 1,
        observedGeneration: 8,
      })
    })

    // b8ke fence-heal (Task 7 follow-up): the pane-terminal-scoped typed
    // refusal's fold has no automatic consumer — the pane's one-shot attach
    // can race the owner-frame fold (the cross-device kill's terminal.meta
    // retirement broadcast re-fires the pane's attach lifecycle BEFORE the
    // vacant frame folds) and then wedge "Recovering terminal output"
    // behind the single refused attach, because nothing re-drives it (the
    // recorded incident's cross-device shape). The branch must bump the
    // pane's reconcileEpoch — the lifecycle effect's ONLY re-fire signal on
    // an unchanged createRequestId — so the attach re-drives itself with
    // the healed pair (the r35 NEXT-decision re-capture): no user Retry,
    // no reconnect.
    it('a pane-terminal-scoped typed refusal auto-re-drives the attach with the healed pair (no user/reconnect actor)', async () => {
      const { store } = setupTypedPane({
        content: { status: 'running', terminalId: 't-attach-b8ke' },
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
              generation: 3,
              terminalId: 't-attach-b8ke',
            })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(sentMessages().filter((m: any) => m.type === 'terminal.attach').length).toBeGreaterThan(0)
      })
      const attachCountBefore = sentMessages().filter((m: any) => m.type === 'terminal.attach').length

      // The typed refusal: no requestId, the pane's own terminalId.
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          terminalId: 't-attach-b8ke',
          ownerEpoch: 1,
          ownerGeneration: 8,
          message: 'Session ownership moved on (stale observed generation); refresh and retry.',
          timestamp: new Date().toISOString(),
        })
      })

      // The fold landed on the pane's owner record.
      const folded = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(folded.generation).toBe(8)

      // THE CONTRACT: the refusal itself re-drives the attach — a NEW
      // terminal.attach arrives automatically carrying the healed pair.
      await waitFor(() => {
        expect(
          sentMessages().filter((m: any) => m.type === 'terminal.attach').length,
        ).toBe(attachCountBefore + 1)
      })
      const reattach = [...sentMessages()]
        .reverse()
        .find((m: any) => m.type === 'terminal.attach')!
      expect(reattach).toMatchObject({
        terminalId: 't-attach-b8ke',
        observedEpoch: 1,
        observedGeneration: 8,
      })
    })

    // b8ke fence-heal (Task 7 follow-up, focused review 1): the
    // refused/foreign-owner arm of the pane-terminal-scoped typed refusal
    // (the cross-device kill's vacant-key adopt refusal — "A lifecycle
    // operation is in flight for this session; retry after it settles.")
    // must NEVER auto-relaunch the killed session. Terminal-exit,
    // vacant-owner, and refusal frames use independently scheduled
    // delivery paths, so the vacant frame + the refused attach can land
    // while terminalIdRef still names the killed terminal — the pre-fix
    // arm read the folded VACANT record and routed to the recovery-create,
    // relaunching the killed session automatically. The NEW contract: the
    // refusal folds the fresh pair (merge-only) and does NOTHING else
    // automatically; the exit fold lands the honest exited state with the
    // user-driven recovery affordance (the preserved sessionRef keeps the
    // sidebar reopen available), and the user's own reopen converges
    // without a reload (the folds make the attempt born fresh). The
    // stale-arm re-drive stays pinned by its own test above (it re-attaches
    // a LIVE terminal under a newer generation — the sanctioned
    // next-attempt self-heal, never a relaunch).
    it('a pane-terminal-scoped refused-arm refusal with a vacant record never auto-creates — the pane converges to exited (focused review 1)', async () => {
      const { store } = setupTypedPane({
        content: { status: 'running', terminalId: 't-attach-b8ke' },
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
              generation: 2,
              ownerKind: 'vacant',
              terminalId: undefined,
              transition: 'released',
            })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(sentMessages().filter((m: any) => m.type === 'terminal.attach').length).toBeGreaterThan(0)
      })
      const attachesBefore = sentMessages().filter((m: any) => m.type === 'terminal.attach').length

      // The refused-arm typed refusal: no requestId, the pane's own
      // terminalId, the pair, the in-flight copy. This lands BEFORE the
      // exit fan — terminalIdRef still names the killed terminal (the
      // review's exact hazardous ordering; the pre-fix arm auto-created
      // right here).
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          terminalId: 't-attach-b8ke',
          ownerEpoch: 1,
          ownerGeneration: 2,
          message: 'A lifecycle operation is in flight for this session; retry after it settles.',
          timestamp: new Date().toISOString(),
        })
      })

      // The fold landed on the pane's owner record (merge-only: the vacant
      // owner identity is preserved) — the fresh pair is folded into
      // runtimeOwners for the user's NEXT attempt.
      const folded = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(folded.generation).toBe(2)
      expect(folded.ownerKind).toBe('vacant')

      // THE CONTRACT (bounded negative): NO terminal.create fires — the
      // killed session never relaunches automatically. Let any wrong-side
      // re-drive flush inside the bounded window, then pin the zero.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, RESERVE_RETRY_FLOOR_MS + 100))
      })
      expect(sentMessages().filter((m: any) => m.type === 'terminal.create')).toHaveLength(0)

      // The exit fan lands AFTER the refusal (the kill's independently
      // scheduled delivery) — the pane converges to its honest exited
      // state; the recovery affordance is the user's path.
      act(() => {
        messageHandler!({ type: 'terminal.exit', terminalId: 't-attach-b8ke', exitCode: 0 })
      })
      await waitFor(() => {
        const leaf = store.getState().panes.layouts['tab-b8ke']
        expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
          ? leaf.content.status : undefined).toBe('exited')
      })
      const leaf = store.getState().panes.layouts['tab-b8ke']
      expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
        ? leaf.content.terminalId : undefined).toBeUndefined()
      // The pane KEEPS its durable sessionRef — the sidebar reopen (the
      // user's recovery path) stays available without a reload.
      expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
        ? leaf.content.sessionRef : undefined)
        .toEqual({ provider: 'codex', sessionId: TYPED_SESSION_ID })

      // Still nothing relaunched — the pane stays honestly exited until the
      // user acts (no attach storm either: the refused arm re-drives
      // nothing).
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, RESERVE_RETRY_FLOOR_MS + 100))
      })
      expect(sentMessages().filter((m: any) => m.type === 'terminal.create')).toHaveLength(0)
      expect(sentMessages().filter((m: any) => m.type === 'terminal.attach').length).toBe(attachesBefore)
    })

    // b8ke fence-heal fast path (plan-review round 1, finding 4): a
    // stale-observed-generation refusal carrying the pair PROVES the
    // request's own pair can never win a re-drive — the branch folds the
    // pair and abandons the request to the reconcile flow instead of
    // looping the bounded re-drive. Refusals WITHOUT the pair (legacy
    // servers; the r35-pinned frame models no owner fields) keep the
    // bounded re-drive — that test stays green unchanged.
    it('a stale-prefix create refusal carrying the pair abandons the re-drive for the reconcile flow (fix b fast path)', async () => {
      const { store } = setupTypedPane({
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({ generation: 5 })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })
      expect(createCalls()[0]).toMatchObject({
        requestId: 'req-b8ke',
        observedEpoch: 1,
        observedGeneration: 5,
      })

      // The stale-prefix refusal carrying the CURRENT pair.
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_RESERVED',
          message: 'Session ownership moved on (stale observed generation); refresh and retry.',
          requestId: 'req-b8ke',
          ownerEpoch: 1,
          ownerGeneration: 9,
          timestamp: new Date().toISOString(),
        })
      })

      // The store holds the folded pair…
      const folded = store.getState().freshAgent.runtimeOwners[`codex:${TYPED_SESSION_ID}`]
      expect(folded.generation).toBe(9)

      // …and the request is abandoned to the reconcile flow: exactly one
      // pane.reconcile.request naming this pane's createRequestId…
      const reconcile = sentMessages().find((m: any) => m.type === 'pane.reconcile.request')
      expect(reconcile).toBeTruthy()
      expect(JSON.stringify(reconcile)).toContain('req-b8ke')

      // …with NO further same-requestId terminal.create inside the
      // re-drive window (the re-drive cannot win with the proven-stale
      // pair).
      await new Promise((resolve) => setTimeout(resolve, RESERVE_RETRY_FLOOR_MS + 100))
      expect(createCalls()).toHaveLength(1)
    })

    it('b8ke ext r7: a terminal pane holding the PRE-REKEY id resolves the alias chain to the canonical owner', async () => {
      // The pane's sessionRef names the OLD durable id; the runtime-owners
      // map carries the multi-hop rekey mirror chain (old → mid →
      // canonical) and the CANONICAL key holds a fresh-agent owner. The
      // terminal pane must observe the CANONICAL record through the chain
      // (pre-r7 it selected the old key raw — no divergence, no recovery
      // card).
      const { store } = setupTypedPane({
        content: {
          status: 'running',
          terminalId: 't-dead',
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      act(() => {
        // The multi-hop chain: old → mid → canonical.
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: TYPED_SESSION_ID,
          epoch: 1,
          generation: 2,
          ownerKind: 'fresh-agent',
          operationId: 'rekey-1',
          transition: 'handoff-committed',
          aliasOf: 'mid-key',
        }))
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: 'mid-key',
          epoch: 1,
          generation: 2,
          ownerKind: 'fresh-agent',
          operationId: 'rekey-1',
          transition: 'handoff-committed',
          aliasOf: 'canonical-key',
        }))
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: 'canonical-key',
          epoch: 1,
          generation: 2,
          ownerKind: 'fresh-agent',
          operationId: 'handoff-to-fresh',
          transition: 'handoff-committed',
        }))
      })

      // A LATER canonical-only transition: the canonical key moves to
      // handoff-STARTED (in progress) while the old-key mirror stays the
      // frozen handoff-committed record. The pane must observe the
      // CANONICAL state through the chain — the in-progress transition
      // card (pre-r7 the raw old-key selection rendered the stale
      // committed mirror with its open action).
      act(() => {
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: 'canonical-key',
          epoch: 1,
          generation: 3,
          ownerKind: 'fresh-agent',
          operationId: 'handoff-back-2',
          transition: 'handoff-started',
        }))
      })

      // THE CONTRACT: the pane follows the CANONICAL record's
      // handoff-started state — the in-progress (non-committed) divergence
      // card with NO open action (the raw old-key selection would render
      // the stale committed mirror's "open as a Fresh Agent pane on
      // another device" text WITH the Open-as-Fresh-Agent button).
      const card = await screen.findByTestId('terminal-owner-divergence-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(card).toHaveTextContent(/being reopened as a Fresh Agent pane elsewhere/i)
      expect(
        screen.queryByRole('button', { name: 'Open as Fresh Agent here' }),
      ).toBeNull()
    })

    it('b8ke ext r16 F5: the open-as-fresh-agent action resolves the retired pre-rekey key to the canonical key', async () => {
      const CANONICAL_ID = '77777777-8888-4999-aaaa-bbbbbbbbbbbb'
      const { store } = setupTypedPane()
      // The pane holds the RETIRED pre-rekey reference; the runtime-owners
      // map carries the alias mirror (the server's rekey mirror frame —
      // the same chain the owner selection resolves through).
      act(() => {
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: TYPED_SESSION_ID,
          epoch: 3,
          generation: 2,
          ownerKind: 'fresh-agent',
          operationId: 'rekey-16-f5',
          transition: 'handoff-committed',
          aliasOf: CANONICAL_ID,
        }))
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'codex',
          sessionId: CANONICAL_ID,
          epoch: 3,
          generation: 2,
          ownerKind: 'fresh-agent',
          operationId: 'rekey-16-f5',
          transition: 'handoff-committed',
        }))
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // The fresh-agent owner on the pane's canonical chain surfaces the
      // CROSS-KIND DIVERGENCE card — the "opened as CLI elsewhere" state
      // whose direct-attach action is THIS finding's target.
      const card = await screen.findByTestId('terminal-owner-divergence-card')
      expect(card).toHaveAttribute('role', 'alert')
      fireEvent.click(within(card).getByRole('button', { name: 'Open as Fresh Agent here' }))

      // THE CONTRACT: the pane's content converts to the fresh-agent
      // pane under the CANONICAL key — the lifecycle start carries the
      // resolved canonical sessionId (pre-r16 the raw retired key went
      // to the start and the coordinator refused REKEYED_ALIAS_KEY).
      await waitFor(() => {
        const leaf = store.getState().panes.layouts['tab-b8ke']
        expect(leaf?.type === 'leaf' ? leaf.content.kind : undefined).toBe('fresh-agent')
      })
      const leaf = store.getState().panes.layouts['tab-b8ke']
      if (leaf?.type === 'leaf' && leaf.content.kind === 'fresh-agent') {
        // The converted pane's sessionRef carries the CANONICAL key (the
        // retired pre-rekey key must never reach the lifecycle start).
        expect(leaf.content.sessionRef?.sessionId).toBe(CANONICAL_ID)
      } else {
        throw new Error('the pane did not convert')
      }
    })

    it('b8ke ext r16 F3: a SESSION_MISSING refusal renders the typed missing state with the explicit start-fresh action', async () => {
      const { store } = setupTypedPane()

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(createCalls()).toHaveLength(1)
      })

      // The typed missing refusal: the durable session is definitively
      // gone — nothing was started (pre-r16 the server auto-substituted a
      // replacement session).
      act(() => {
        messageHandler!({
          type: 'error',
          code: 'SESSION_MISSING',
          message: `The durable session ${TYPED_SESSION_ID} is gone. No replacement was started — start a fresh conversation explicitly if you want a new session.`,
          requestId: 'req-b8ke',
          timestamp: new Date().toISOString(),
        })
      })

      // THE TYPED MISSING CARD: the recoverable missing state + the
      // explicit start-fresh action (the ONLY new-session path) + NO
      // retry action (retrying the resume cannot bring the session back).
      const card = await screen.findByTestId('terminal-launch-failure-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(card).toHaveTextContent(/is gone/i)
      expect(
        within(card).queryByRole('button', { name: 'Retry launch' }),
      ).toBeNull()
      const startFresh = within(card).getByRole('button', {
        name: 'Start a fresh conversation (a new session — the old one is gone)',
      })
      expect(startFresh).toBeInTheDocument()

      // THE OPERATOR-INITIATED FRESH START: the click clears the stale
      // sessionRef (a genuinely new identity-less conversation) and
      // re-fires the lifecycle into a fresh create.
      fireEvent.click(startFresh)
      await waitFor(() => {
        expect(createCalls()).toHaveLength(2)
      })
      const retiredRequestId = createCalls()[0].requestId
      expect(createCalls()[1].requestId).toEqual(expect.any(String))
      expect(createCalls()[1].requestId).not.toBe(retiredRequestId)
      expect(createCalls()[1].sessionRef).toBeUndefined()
      const leaf = store.getState().panes.layouts['tab-b8ke']
      expect(
        leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
          ? leaf.content.sessionRef
          : undefined,
      ).toBeUndefined()
    })

    it('b8ke ext r11 F2: a dead terminal pane converges onto a committed same-kind terminal owner', async () => {
      // The pane's own runtime is DEAD (the Fresh Agent → CLI handoff's
      // prior-reap exited it; the exit cleared the stored terminal id) —
      // a terminal pane on ANOTHER device holding the same sessionRef.
      // Pre-r11 the committed-owner broadcast produced NOTHING: the
      // same-kind early-return is null and the lifecycle effect had no
      // owner-generation/owner-terminal deps, so the pane stayed exited.
      const { store } = setupTypedPane({
        content: {
          status: 'exited',
          terminalId: undefined,
          sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // THE COMMITTED OWNER BROADCAST: a NEW terminal owns the canonical
      // session (generation 12, a terminal id this pane never held).
      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          generation: 12,
          terminalId: 't-new-authoritative',
          ownerKind: 'terminal',
          transition: 'handoff-committed',
        })))
      })

      // THE CONVERGENCE: the pane adopts the authoritative terminal id and
      // re-fires into the attach branch (the fold sets terminalId +
      // status running + the reconcileEpoch bump).
      await waitFor(() => {
        const leaf = store.getState().panes.layouts['tab-b8ke']
        expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
          ? leaf.content.terminalId : undefined).toBe('t-new-authoritative')
      })
      await waitFor(() => {
        const leaf = store.getState().panes.layouts['tab-b8ke']
        expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
          ? leaf.content.status : undefined).toBe('running')
      })
      // The attach was DRIVEN onto the new runtime (the same-mode
      // multi-device attachment the convergence requires).
      await waitFor(() => {
        const attach = sentMessages().find((msg) => msg?.type === 'terminal.attach'
          && msg.terminalId === 't-new-authoritative')
        expect(attach).toBeTruthy()
      })
    })

    it('b8ke ext r11 F2: a still-RUNNING pane is never stolen off its own terminal by a committed same-kind owner', async () => {
      const { store } = setupTypedPane({
        content: {
          status: 'running',
          terminalId: 't-mine-still-live',
          sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          generation: 12,
          terminalId: 't-other-device',
          ownerKind: 'terminal',
          transition: 'handoff-committed',
        })))
      })

      // No adoption: the pane keeps its own live terminal.
      const leaf = store.getState().panes.layouts['tab-b8ke']
      const content = leaf?.type === 'leaf' ? leaf.content : undefined
      expect(content?.kind === 'terminal' ? content.terminalId : undefined)
        .toBe('t-mine-still-live')
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach'
        && msg?.terminalId === 't-other-device')).toBe(false)
    })

    it('b8ke delta F1: an exited pane never converges onto its OWN dead terminal (the kill exit-vs-vacant race)', async () => {
      // The kill's wire order: terminal.exit (code 0 — the kill contract)
      // folds FIRST; the stop commit's VACANT owner frame folds moments
      // later. Between the two, the canonical record still names the pane's
      // OWN (dead) terminal as the terminal-Live owner. The convergence
      // lane must not adopt it: the exit fold CLEARED the stored terminal
      // id, so the own-terminal gate (record.terminalId === paneTerminalId)
      // cannot see the pane's dead terminal — the pane re-attached the dead
      // handle, drew INVALID_TERMINAL_ID, and the reconnect recovery
      // AUTO-RESUMED the killed session (the exact delta F1 hazard, racy on
      // the render between the exit fold and the vacant fold — observed
      // under multi-spec e2e load in the reworked Test B). The pane must
      // stay honestly exited until the user acts.
      const { store } = setupTypedPane({
        content: { status: 'running', terminalId: 't-own-dead' },
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
              generation: 1,
              terminalId: 't-own-dead',
            })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(sentMessages().filter((m: any) => m.type === 'terminal.attach' && m.terminalId === 't-own-dead').length).toBeGreaterThan(0)
      })
      const attachesToDeadBeforeExit = sentMessages().filter(
        (m: any) => m.type === 'terminal.attach' && m.terminalId === 't-own-dead',
      ).length

      // THE KILL's exit fold (code 0) — the vacant frame NOT yet folded.
      act(() => {
        messageHandler!({ type: 'terminal.exit', terminalId: 't-own-dead', exitCode: 0 })
      })

      // THE CONTRACT: the pane stays honestly exited — no adoption of its
      // own dead terminal, no attach to it, no auto-resume create. Let any
      // wrong-side adoption flush first.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      const leaf = store.getState().panes.layouts['tab-b8ke']
      expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
        ? leaf.content.status : undefined).toBe('exited')
      expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
        ? leaf.content.terminalId : undefined).toBeUndefined()
      expect(sentMessages().filter((m: any) => m.type === 'terminal.attach' && m.terminalId === 't-own-dead').length)
        .toBe(attachesToDeadBeforeExit)
      expect(sentMessages().filter((m: any) => m.type === 'terminal.create')).toHaveLength(0)

      // The vacant frame folds AFTER (the stop commit) — the record has no
      // terminal to adopt and the pane STILL stays exited.
      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          generation: 2,
          ownerKind: 'vacant',
          terminalId: undefined,
          transition: 'released',
        })))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      const leafAfterVacant = store.getState().panes.layouts['tab-b8ke']
      expect(leafAfterVacant?.type === 'leaf' && leafAfterVacant.content.kind === 'terminal'
        ? leafAfterVacant.content.status : undefined).toBe('exited')
      expect(sentMessages().filter((m: any) => m.type === 'terminal.create')).toHaveLength(0)
    })

    // the-usual ownership-fence-fix focused review 2 (Major): the killed
    // session pane must SURFACE its recovery affordance. The cross-device
    // kill shape — a clean exit (code 0, the terminal.kill wire contract)
    // whose stop-commit owner frame folds the canonical record VACANT —
    // shows the in-pane reopen action (never an automatic relaunch).
    // Pre-fix, code 0 fell through every settledDead rule and the pane was
    // a quiet, actionless exited terminal (the reviewer's e2e workaround:
    // closeTab + sidebar reopen).
    it('a clean-exit killed session (vacant record) surfaces the reopen affordance; the click drives the recovery create', async () => {
      const { store } = setupTypedPane({
        content: { status: 'running', terminalId: 't-killed-vacant' },
        seed: (seededStore) => {
          act(() => {
            seededStore.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
              generation: 1,
              terminalId: 't-killed-vacant',
            })))
          })
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
        expect(sentMessages().filter((m: any) => m.type === 'terminal.attach' && m.terminalId === 't-killed-vacant').length).toBeGreaterThan(0)
      })

      // The kill's exit fold (code 0). The record is still terminal-Live in
      // the exit-vs-vacant race window — the pane is honestly exited and
      // the affordance must NOT render yet (no false "reopen" while the
      // owner state is unsettled).
      act(() => {
        messageHandler!({ type: 'terminal.exit', terminalId: 't-killed-vacant', exitCode: 0 })
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      expect(screen.queryByTestId('terminal-vacant-recovery-bar')).toBeNull()

      // The stop commit's VACANT frame folds after — the killed-session
      // shape: the recovery affordance surfaces in the pane.
      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          generation: 2,
          ownerKind: 'vacant',
          terminalId: undefined,
          transition: 'released',
        })))
      })
      const bar = await screen.findByTestId('terminal-vacant-recovery-bar')
      expect(bar).toHaveTextContent('codex session was stopped (code 0)')

      // THE CONTRACT (bounded negative): nothing relaunched automatically —
      // the affordance is the user's path, the pane stays exited until the
      // user acts.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      expect(sentMessages().filter((m: any) => m.type === 'terminal.create')).toHaveLength(0)

      // The USER-DRIVEN reopen: click the surfaced affordance. It dispatches
      // the recovery-create flow (the respawn create keeping the durable
      // sessionRef), which re-fires the lifecycle effect. Pinned by the
      // flow's observable output — the create frame — rather than a
      // dispatch spy: swapping store.dispatch mid-test changes the identity
      // react-redux hands the component and alone re-fires the lifecycle
      // effect once (a test-only artifact that would auto-create here).
      fireEvent.click(within(bar).getByRole('button', { name: 'Reopen codex session' }))
      await waitFor(() => {
        expect(createCalls()).toHaveLength(1)
      })
      expect(createCalls()[0]).toMatchObject({
        requestId: 'req-b8ke',
        sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        // The respawn lane's rate-limit exemption (resetPaneForReconcileCreate
        // marks the create restore — the resumeRecoveryCreate-equivalent).
        restore: true,
        // The FRESH observed pair (the vacant record's generation 2 — the
        // fence re-captured at send time after the reconcileEpoch bump).
        observedEpoch: 1,
        observedGeneration: 2,
      })
      // The pane left its exited state — the reopen is in flight.
      const leaf = store.getState().panes.layouts['tab-b8ke']
      expect(leaf?.type === 'leaf' && leaf.content.kind === 'terminal'
        ? leaf.content.status : undefined).toBe('creating')
    })

    it('a terminal pane whose session is fresh-agent-owned renders the recovery card with a direct open action', async () => {
      const { store } = setupTypedPane({
        content: {
          status: 'running',
          terminalId: 't-dead',
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      // The mount attach to the (now reaped) terminal id happened.
      const attachesToDead = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 't-dead',
      )
      await waitFor(() => expect(attachesToDead().length).toBeGreaterThan(0))
      const attachesAtDivergence = attachesToDead().length

      // Install the spy BEFORE the divergence fold re-renders: the click
      // closure captures `dispatch` at render time (react-redux).
      const dispatchSpy = vi.spyOn(store, 'dispatch')

      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          ownerKind: 'fresh-agent',
          terminalId: undefined,
          generation: 3,
          operationId: 'handoff-to-fresh',
        })))
      })

      const card = await screen.findByTestId('terminal-owner-divergence-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(card).toHaveTextContent(/open as a fresh agent pane on another device/i)
      const openButton = within(card).getByRole('button', { name: 'Open as Fresh Agent here' })

      // While divergent, no re-attach attempt is made to the dead id.
      await act(async () => { await Promise.resolve() })
      expect(attachesToDead()).toHaveLength(attachesAtDivergence)
      expect(restoreMocks.consumeRecoveredLiveTerminalTarget).not.toHaveBeenCalled()

      fireEvent.click(openButton)
      const swap = dispatchSpy.mock.calls
        .map(([action]) => action as { type?: string; payload?: { tabId?: string; paneId?: string; content?: { kind?: string } } })
        .find((action) => action?.type === 'panes/updatePaneContent' && action.payload?.content?.kind === 'fresh-agent')
      expect(swap?.payload).toMatchObject({
        tabId: 'tab-b8ke',
        paneId: 'pane-b8ke',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          sessionRef: { provider: 'codex', sessionId: TYPED_SESSION_ID },
        },
      })
    })

    // b8ke focused round-5 R5-3: a SAME-KIND in-progress lifecycle
    // transition (the ready-replay fold of starting/handoff/stopping
    // naming THIS pane's kind — here a terminal-kind record mid-handoff)
    // is transition-blocked: the pane shows the transition card (never a
    // silent same-kind "all clear") and suspends reattach/polling until
    // the transition settles.
    it('a same-kind in-progress owner record renders the transition card and blocks reattach', async () => {
      const { store } = setupTypedPane({
        content: {
          status: 'running',
          terminalId: 't-live-own',
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      const attachCalls = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 't-live-own',
      )
      await waitFor(() => expect(attachCalls().length).toBeGreaterThan(0))
      const attachesAtTransition = attachCalls().length

      // SAME-KIND: the pane is a terminal and the record's ownerKind is
      // terminal with an in-progress transition — pre-fix this folded as
      // no divergence at all (the pane resumed normal attach/polling
      // mid-lifecycle).
      act(() => {
        store.dispatch(applyRuntimeOwner(runtimeOwnerFrame({
          ownerKind: 'terminal',
          terminalId: 't-live-own',
          transition: 'handoff-started',
          generation: 6,
          operationId: 'handoff-r53',
        })))
      })

      const card = await screen.findByTestId('terminal-owner-transition-card')
      expect(card).toHaveAttribute('role', 'alert')
      expect(card).toHaveTextContent(/being reopened/i)
      expect(within(card).queryByRole('button')).toBeNull()
      // Transition-blocked: no further attach attempts while the
      // in-progress record holds.
      await act(async () => { await Promise.resolve() })
      expect(attachCalls()).toHaveLength(attachesAtTransition)
      // Not the cross-kind divergence card.
      expect(screen.queryByTestId('terminal-owner-divergence-card')).toBeNull()
    })

    it('the open action swaps a kilroy-flavored Claude pane to a KILROY pane, never freshclaude', async () => {
      const { store } = setupTypedPane({
        content: {
          mode: 'claude',
          status: 'running',
          terminalId: 't-dead-kilroy',
          sessionRef: { provider: 'claude', sessionId: '550e8400-e29b-41d4-a716-446655440099' },
        },
        tabMetadata: {
          'claude:550e8400-e29b-41d4-a716-446655440099': { sessionType: 'kilroy' },
        },
      })

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // Install the spy BEFORE the divergence fold re-renders: the click
      // closure captures `dispatch` at render time (react-redux).
      const dispatchSpy = vi.spyOn(store, 'dispatch')

      act(() => {
        store.dispatch(applyRuntimeOwner({
          type: 'session.runtimeOwner',
          provider: 'claude',
          sessionId: '550e8400-e29b-41d4-a716-446655440099',
          epoch: 1,
          generation: 3,
          ownerKind: 'fresh-agent',
          operationId: 'handoff-to-kilroy',
          transition: 'handoff-committed',
        }))
      })

      const card = await screen.findByTestId('terminal-owner-divergence-card')
      const openButton = within(card).getByRole('button', { name: 'Open as Fresh Agent here' })

      fireEvent.click(openButton)
      const swap = dispatchSpy.mock.calls
        .map(([action]) => action as { type?: string; payload?: { content?: { kind?: string; sessionType?: string } } })
        .find((action) => action?.type === 'panes/updatePaneContent' && action.payload?.content?.kind === 'fresh-agent')
      expect(swap?.payload?.content).toMatchObject({
        kind: 'fresh-agent',
        sessionType: 'kilroy',
        provider: 'claude',
      })
    })
  })

  // Focused-episode-6 round 5 (Finding F1): the restore offer's LIVE terminal
  // panes reattach to the still-running server terminal — the plan arms a
  // one-shot createRequestId→terminalId target, and the lifecycle consults it
  // BEFORE it would dispatch terminal.create (a live pane is never recreated
  // as a second process; the same fold the D7-refusal revival uses,
  // `applyReattachToLiveTerminal`, points the pane at its original terminal).
  describe('recovered live-terminal reattach (restore-offer arming, round 5 F1)', () => {
    function setupRecoveredLivePane() {
      const tabId = 'tab-recovered-live'
      const paneId = 'pane-recovered-live'

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-recovered-live',
        status: 'creating',
        mode: 'shell',
        shell: 'system',
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: 'creating',
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: 'req-recovered-live',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null },
        },
      })

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      return { store, tabId, paneId }
    }

    it('reattaches to the armed live terminal and NEVER dispatches a create', async () => {
      restoreMocks.consumeRecoveredLiveTerminalTarget.mockReturnValue('t-still-running')

      const { store, tabId } = setupRecoveredLivePane()

      // The reattach fold lands instead of any create: the pane gains the
      // still-running terminal handle with status running, createRequestId
      // preserved (council rule 2).
      const reattached = getLeafTerminalContent(store, tabId)
      expect(reattached.terminalId).toBe('t-still-running')
      expect(reattached.status).toBe('running')
      expect(reattached.createRequestId).toBe('req-recovered-live')
      expect(
        wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.create'),
        'a recovered live pane must never dispatch terminal.create (that would spawn a duplicate)',
      ).toHaveLength(0)

      // The epoch bump re-fires the lifecycle effect into the attach path.
      await waitFor(() => {
        expect(
          wsMocks.send.mock.calls
            .map(([msg]) => msg)
            .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 't-still-running'),
        ).toHaveLength(1)
      })

      const term = terminalInstances[0]
      expectTerminalWriteContaining(term, 'Reconnected to the still-running session.')

      // One-shot arming: exactly one consult — the fold's epoch bump re-fires
      // the effect, but by then the pane owns a terminal handle and the
      // create branch (and its consult) never runs again.
      expect(restoreMocks.consumeRecoveredLiveTerminalTarget).toHaveBeenCalledTimes(1)
    })

    it('a pane with no armed target sends its create exactly as before (the fallback is untouched)', async () => {
      const { store, tabId, paneId } = setupRecoveredLivePane()

      await waitFor(() => {
        expect(
          wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create'),
        ).toHaveLength(1)
      })
      // The consult ran (before the create) and found nothing armed.
      expect(restoreMocks.consumeRecoveredLiveTerminalTarget).toHaveBeenCalledWith(tabId, paneId)
      expect(getLeafTerminalContent(store, tabId).terminalId).toBeUndefined()
    })
  })

  it('does not reconnect after terminal.exit when INVALID_TERMINAL_ID is received', async () => {
    // This test verifies the fix for the runaway terminal creation loop:
    // 1. Terminal exits normally (e.g., Claude fails to resume)
    // 2. Some operation (resize) triggers INVALID_TERMINAL_ID for the dead terminal
    // 3. The INVALID_TERMINAL_ID handler should NOT trigger reconnection because
    //    the terminal was already marked as exited (terminalIdRef was cleared)
    const tabId = 'tab-exit'
    const paneId = 'pane-exit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-exit',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-exit',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-exit',
            createRequestId: 'req-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Terminal exits (simulates Claude failing to resume due to invalid path)
    messageHandler!({
      type: 'terminal.exit',
      terminalId: 'term-exit',
      exitCode: 1,
    })

    // Verify status is 'exited'
    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.status).toBe('exited')
    })

    // Clear send mock to track only new calls
    wsMocks.send.mockClear()

    // Now simulate INVALID_TERMINAL_ID (as if a resize was sent to the dead terminal)
    // This should NOT trigger reconnection because terminal already exited
    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-exit',
    })

    // Give any async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify NO terminal.create was sent (this is the key assertion)
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)

    // Verify the pane content still shows exited status with original terminalId preserved in Redux
    // (but the ref should have been cleared, which we can't directly test here)
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('exited')

    // Verify user-facing feedback was shown
    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Terminal exited')
  })

  it('writes an in-pane notice when the correlated terminal close reports a durable-close failure', async () => {
    // Focused-episode-6 round 2 (Findings 6+7): a terminal.killed answer
    // with success:false means the server could NOT record the close durably
    // and left the terminal running — the close flow kept the pane for
    // exactly this case, and the pane's own surface (the xterm notice, the
    // input.blocked convention) explains why the close did not happen.
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-close-fail',
      status: 'running',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.killed',
        requestId: 'req-kill-close-fail',
        terminalId: 'term-close-fail',
        success: false,
        error: 'the terminal close could not be recorded durably; the terminal was left running',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, '[Close failed] the terminal close could not be recorded durably')
  })

  it('renders a close-gate failure (closeError) as the in-pane [Close failed] notice and clears it (delta-r7-r3, F2)', async () => {
    // Focused-episode-7 round 2 (Finding F2): when the close gate leaves the
    // pane standing (unacknowledged/failed durable close), the pane's own
    // error chrome — the xterm notice, the input.blocked convention —
    // explains why the close did not happen.
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-close-gate',
      status: 'running',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      store.dispatch(setPaneCloseError({
        tabId,
        paneId,
        error: 'the pane close could not be recorded durably; the pane was left open',
      }))
    })

    const term = terminalInstances[0]
    await waitFor(() => {
      expectTerminalWriteContaining(term, '[Close failed] the pane close could not be recorded durably')
    })
    expect(getLeafTerminalContent(store, tabId).closeError).toBeUndefined()
  })

  it('shows feedback when Codex input is blocked by the restore identity gate', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-codex',
      status: 'running',
      mode: 'codex',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-codex',
        reason: 'codex_identity_pending',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Input not sent: Codex is still saving restore state. Try again in a moment.')
  })

  it('shows feedback when Codex input is blocked by lifecycle-loss proof', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-codex',
      status: 'running',
      mode: 'codex',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-codex',
        reason: 'codex_lifecycle_loss_pending',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Input not sent: Codex is resolving a worker disconnect. Try again in a moment.')
  })

  it('shows feedback when Codex input is blocked by clean-exit state resolution', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-codex',
      status: 'running',
      mode: 'codex',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-codex',
        reason: 'codex_clean_exit_decision_pending',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Input not sent: Codex is checking whether the session is still active. Try again in a moment.')
  })

  it('shows feedback when input is blocked because the terminal no longer exists', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-gone',
      status: 'running',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-gone',
        reason: 'unknown_terminal',
      })
    })

    const term = terminalInstances[0]
    expectTerminalWriteContaining(term, 'Input not sent: the terminal no longer exists on the server.')
  })

  it('shows generic notice for unrecognized terminal.input.blocked reason (future-proofing)', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-test',
      status: 'running',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    act(() => {
      messageHandler!({
        type: 'terminal.input.blocked',
        terminalId: 'term-test',
        reason: 'some_future_reason' as any,
      })
    })

    const term = terminalInstances[0]
    // Verify the generic notice is written
    expectTerminalWriteContaining(term, 'Input not sent.')
    // Verify [undefined] is NOT written
    expect(term.write).not.toHaveBeenCalledWith(expect.stringContaining('undefined'))
  })

  it('buffers keystrokes typed while un-anchored and flushes them byte-exact after terminal.created', async () => {
    // Pane mid-recreate: no terminalId yet (the old silent-drop window).
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    fireData(term, 'echo dtfn-')
    fireData(term, 'marker')
    fireData(term, '\r')

    // Nothing sent yet -- buffered, not dropped, not fired at a stale id.
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])

    // The pane anchors: terminal.created with this pane's createRequestId.
    const createMsg = sentMessages().find((m) => m?.type === 'terminal.create')
    expect(createMsg).toBeTruthy()
    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: createMsg.requestId,
        terminalId: 'term-new',
      })
    })

    const inputs = sentMessages().filter(
      (m) => m?.type === 'terminal.input' && m.terminalId === 'term-new',
    )
    expect(inputs.map((m) => m.data)).toEqual(['echo dtfn-', 'marker', '\r'])
  })

  it('surfaces a visible notice when the pending-input buffer overflows', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    for (let i = 0; i < 257; i++) fireData(term, 'x') // cap is 256 chunks

    expectTerminalWriteContaining(term, 'too much was typed while the terminal was reconnecting')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })

  it('surfaces a visible notice when buffered input times out un-anchored', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    vi.useFakeTimers()
    try {
      fireData(term, 'doomed keystrokes')
      act(() => {
        vi.advanceTimersByTime(30_001)
        vi.advanceTimersByTime(17) // Vitest 5 schedules the queued xterm write on the next frame.
      })
      expectTerminalWriteContaining(term, 'the terminal did not reconnect in time')
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards buffered input with a visible notice when the terminal exits', async () => {
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-exiting',
      status: 'running',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Force the send gate to BUFFER while terminalIdRef is STILL SET: drop
    // the mock's synchronous `isReady` (the same controllable seam the
    // close-race test below adds to the suite's ws mock). Buffering before
    // the exit is what makes the exit-discard path observable -- an exit
    // sent first would clear the tid and a later duplicate exit is swallowed
    // by the handler's `msg.terminalId === tid` gate.
    setWsIsReady(false)
    fireData(term, 'typed at a corpse')
    // RED pre-fix on THIS assertion too: pre-fix sendInput sends whenever
    // tid is set, so a terminal.input frame appears here before the fix.
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])

    // terminal.exit for the still-set tid passes the handler's
    // `msg.terminalId === tid` gate and hits the discard site:
    // discardPendingInput('terminal_gone') drops the buffer and
    // writes the visible notice (design invariant 3).
    act(() => {
      messageHandler!({ type: 'terminal.exit', terminalId: 'term-exiting', exitCode: 0 })
    })
    expectTerminalWriteContaining(term, 'Input not sent')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })

  it('buffers keystrokes when the socket is already closed but the status ref still says ready (close race)', async () => {
    // Ledger A8: onclose flips WsClient._state synchronously; Redux/refs lag a
    // task. A keystroke in that gap must BUFFER, not enter ws-client's
    // pendingMessages (where the Task 6 filter would silently discard it).
    // Seam: the suite's ws mock exposes a controllable synchronous
    // `isReady` (defaulting true, matching ws-client.ts `get isReady()`).
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: 'term-live',
      status: 'running',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Socket dead (the race window). Construction makes the isReady arm the
    // ONLY arm that can buffer here: terminalIdRef is set (so `!tid` is cold)
    // and the store's preloaded status is STATIC -- it never transitions, so
    // the sync effect never latches awaitingAnchorRef. Delete the
    // `ws.isReady === false` arm from the gate and this test fails (the frame
    // is sent). That is the pin for design invariant 9 / ledger A8.
    setWsIsReady(false)

    fireData(term, 'echo raced\r')
    expect(sentMessages().filter((m) => m?.type === 'terminal.input')).toEqual([])
  })

  it('re-writes the loss notice after the pane re-anchors (term.clear survival)', async () => {
    // Ledger A15: the anchor's term.clear()/re-hydrate wipes notices written
    // while un-anchored; the deferred re-write must land AFTER the anchor.
    const { store, tabId, paneId, paneContent } = setupThemeTerminal({
      terminalId: undefined,
      status: 'creating',
      mode: 'shell',
    })
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    vi.useFakeTimers()
    try {
      fireData(term, 'doomed')
      act(() => {
        vi.advanceTimersByTime(30_001) // timeout -> immediate notice write
        vi.advanceTimersByTime(17) // Flush the queued notice before anchoring.
      })
      const writesBeforeAnchor = term.write.mock.calls.length

      const createMsg = sentMessages().find((m) => m?.type === 'terminal.create')
      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: createMsg.requestId,
          terminalId: 'term-new',
        })
      })
      act(() => { vi.advanceTimersByTime(34) })
      const attach = sentMessages().find((m) => m?.type === 'terminal.attach' && m.terminalId === 'term-new')
      expect(attach?.surfaceReset).toBe(true)
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId: 'term-new', attachRequestId: attach.attachRequestId, headSeq: 0, replayFromSeq: 1, replayToSeq: 0 })
        vi.advanceTimersByTime(17)
      })
      // The notice is written AGAIN after the anchor (post-clear), so it
      // survives the hydrate wipe.
      const noticeWritesAfterAnchor = term.write.mock.calls
        .slice(writesBeforeAnchor)
        .filter((c: any[]) => String(c[0]).includes('did not reconnect in time'))
      expect(noticeWritesAfterAnchor.length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('mirrors canonical durable identity to pane and tab on terminal.session.associated', async () => {
    const tabId = 'tab-session-assoc'
    const paneId = 'pane-session-assoc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-assoc',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-assoc',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Simulate terminal creation first to set terminalId
    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-assoc',
      terminalId: 'term-assoc',
      createdAt: Date.now(),
    })

    // Simulate session association
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'

    messageHandler!({
      type: 'terminal.session.associated',
      terminalId: 'term-assoc',
      sessionRef: {
        provider: 'claude',
        sessionId,
      },
    })

    // Verify pane content keeps only the canonical sessionRef
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.resumeSessionId).toBeUndefined()
    expect(layout.content.sessionRef).toEqual({
      provider: 'claude',
      sessionId,
    })

    // Verify tab also keeps only the canonical sessionRef
    const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
    expect(tab?.resumeSessionId).toBeUndefined()
    expect(tab?.sessionRef).toEqual({
      provider: 'claude',
      sessionId,
    })
  })

  it('keeps canonical durable identity scoped to the pane when the tab has multiple panes', async () => {
    const tabId = 'tab-session-assoc-split'
    const paneId = 'pane-session-assoc-split'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-assoc-split',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const siblingPaneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-assoc-sibling',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: paneId, content: paneContent },
        { type: 'leaf', id: 'pane-session-assoc-sibling', content: siblingPaneContent },
      ],
    }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude Split',
            titleSetByUser: false,
            createRequestId: 'req-assoc-split',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-assoc-split',
      terminalId: 'term-assoc-split',
      createdAt: Date.now(),
    })

    const sessionId = '550e8400-e29b-41d4-a716-446655440099'
    messageHandler!({
      type: 'terminal.session.associated',
      terminalId: 'term-assoc-split',
      sessionRef: {
        provider: 'claude',
        sessionId,
      },
    })

    const layout = store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'split' }>
    const primaryPane = layout.children[0]
    expect(primaryPane.type).toBe('leaf')
    if (primaryPane.type !== 'leaf') {
      throw new Error('Expected primary split child to be a leaf pane')
    }
    expect(primaryPane.content.kind).toBe('terminal')
    if (primaryPane.content.kind !== 'terminal') {
      throw new Error('Expected primary split child to be a terminal pane')
    }
    expect(primaryPane.content.sessionRef).toEqual({
      provider: 'claude',
      sessionId,
    })

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
    expect(tab?.sessionRef).toBeUndefined()
    expect(tab?.resumeSessionId).toBeUndefined()
  })

  it('persists canonical codex identity only after terminal.session.associated', async () => {
    const tabId = 'tab-codex-durable'
    const paneId = 'pane-codex-durable'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-durable',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(persistMiddleware),
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-codex-durable',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-codex-durable',
      terminalId: 'term-codex-durable',
      createdAt: 123,
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.resumeSessionId).toBeUndefined()

      const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
      expect(tab?.resumeSessionId).toBeUndefined()
      expect(dispatchSpy.mock.calls.some(([action]) => action?.type === flushPersistedLayoutNow.type)).toBe(false)

      const persisted = readPersistedLayoutSnapshotForTest()
      expect(persisted?.tabs.tabs.find((entry) => entry.id === tabId)?.resumeSessionId).toBeUndefined()
      expect((persisted?.panes.layouts[tabId] as any)?.content?.resumeSessionId).toBeUndefined()
    })

    const sessionId = 'codex-session-1'
    messageHandler!({
      type: 'terminal.session.associated',
      terminalId: 'term-codex-durable',
      sessionRef: {
        provider: 'codex',
        sessionId,
      },
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.sessionRef).toEqual({
        provider: 'codex',
        sessionId,
      })

      const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
      expect(tab?.sessionRef).toEqual({
        provider: 'codex',
        sessionId,
      })
      expect(dispatchSpy.mock.calls.some(([action]) => action?.type === flushPersistedLayoutNow.type)).toBe(true)

      const persisted = readPersistedLayoutSnapshotForTest()
      expect(persisted?.tabs.tabs.find((entry) => entry.id === tabId)?.sessionRef).toEqual({
        provider: 'codex',
        sessionId,
      })
      expect((persisted?.panes.layouts[tabId] as any)?.content?.sessionRef).toEqual({
        provider: 'codex',
        sessionId,
      })
    })
  })

  it('starts explicit fresh recovery for a live-only INVALID_TERMINAL_ID reconnect', async () => {
    const tabId = 'tab-clear-tid'
    const paneId = 'pane-clear-tid'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-clear',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-clear',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-clear',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // Trigger INVALID_TERMINAL_ID for the current terminal
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId: 'term-clear',
      })

      // Wait for state update - pane content terminalId should be cleared
      await waitFor(() => {
        const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
        expect(layout.content.terminalId).toBeUndefined()
      })

      // Verify tab status moved into explicit fresh recovery rather than a permanent restore error
      const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
      expect(tab?.status).toBe('creating')

      // Verify pane content was also updated
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.serverInstanceId).toBeUndefined()
      expect(layout.content.status).toBe('creating')
      expect(layout.content.restoreError).toBeUndefined()
      expect(layout.content.createRequestId).not.toBe('req-clear')
      expect(restoreMocks.addTerminalFreshRecoveryRequestId).toHaveBeenCalledWith(
        layout.content.createRequestId,
        'fresh_after_restore_unavailable',
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[TerminalView]'),
        'restore_unavailable',
        expect.objectContaining({
          event: 'restore_unavailable',
          reason: 'dead_live_handle',
          terminalId: 'term-clear',
          tabId,
          paneId,
          mode: 'claude',
          hasSessionRef: false,
        }),
      )
      expect(wsMocks.send.mock.calls.map(([msg]) => msg)).toContainEqual({
        type: 'client.diagnostic',
        event: 'restore_unavailable',
        reason: 'dead_live_handle',
        terminalId: 'term-clear',
        tabId,
        paneId,
        mode: 'claude',
        hasSessionRef: false,
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('recovers from a post-restart attach error and delivers buffered keystrokes to the recreated terminal', async () => {
    const { store, tabId, paneId } = setupThemeTerminal({
      terminalId: 'term-pre-restart',
      status: 'running',
      mode: 'shell',
    })
    // Use TerminalViewFromStore: the real PaneContainer passes store-derived
    // pane content, so branch-5 recovery's new createRequestId re-fires the
    // create effect. A static paneContent prop would never deliver it.
    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(reconnectHandler).not.toBeNull()
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const term = terminalInstances[0]

    // Server restarted; transport reconnects; the pane re-attaches its OLD id.
    act(() => {
      reconnectHandler!()
    })
    const attach = sentMessages()
      .filter((m) => m?.type === 'terminal.attach' && m.terminalId === 'term-pre-restart')
      .at(-1)
    expect(attach).toBeTruthy()

    // The restarted Rust server now answers loudly (kata dtfn, Task 5).
    act(() => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Terminal not running',
        requestId: attach.attachRequestId,
        terminalId: 'term-pre-restart',
        timestamp: new Date().toISOString(),
      })
    })

    // Branch-5 recovery: pane re-creates (a fresh terminal.create goes out).
    const create = sentMessages().filter((m) => m?.type === 'terminal.create').at(-1)
    expect(create).toBeTruthy()

    // Keystrokes typed in the recovery window buffer (tid is cleared)...
    fireData(term, 'echo survived\\r')
    expect(
      sentMessages().filter((m) => m?.type === 'terminal.input' && m.terminalId === 'term-pre-restart'),
    ).toEqual([])

    // ...and flush, in order, to the recreated terminal.
    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: create.requestId,
        terminalId: 'term-post-restart',
      })
    })
    const flushed = sentMessages().filter(
      (m) => m?.type === 'terminal.input' && m.terminalId === 'term-post-restart',
    )
    expect(flushed.map((m) => m.data)).toEqual(['echo survived\\r'])
  })

  describe('non-blocking reconnect', () => {
    function setupNonBlockingTerminal(connectionStatus: 'ready' | 'disconnected') {
      const tabId = 'tab-non-blocking'
      const paneId = 'pane-non-blocking'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-non-blocking',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        terminalId: 'term-non-blocking',
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: 'running',
              title: 'Shell',
              titleSetByUser: false,
              terminalId: 'term-non-blocking',
              createRequestId: 'req-non-blocking',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: {
            status: connectionStatus,
            error: null,
          },
          turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        },
      })

      return { tabId, paneId, paneContent, store }
    }

    it('does not render a blocking reconnect spinner during attach replay', async () => {
      const { tabId, paneId, paneContent, store } = setupNonBlockingTerminal('ready')

      const { queryByText, queryByTestId } = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-non-blocking',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      expect(queryByTestId('loader')).toBeNull()
      expect(queryByText('Reconnecting...')).toBeNull()
      expect(queryByText('Recovering terminal output...')).not.toBeNull()
    })

    it('keeps managed output attachment invisible while actually requesting retained output', async () => {
      const { tabId, paneId, paneContent, store } = setupNonBlockingTerminal('ready')
      const managedContent: TerminalPaneContent = { ...paneContent, soulId: 'managed-soul', recoverySummary: {
        desiredState: 'running', recoveryState: 'recovering', reason: 'provider_unavailable',
        durabilityState: 'resume_captured', allocationState: 'verified_durable',
      } }
      store.dispatch(updatePaneContent({ tabId, paneId, content: managedContent }))
      render(<Provider store={store}><TerminalView tabId={tabId} paneId={paneId} paneContent={managedContent} /></Provider>)
      await waitFor(() => expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach', terminalId: 'term-non-blocking', sinceSeq: 0,
      })))
      expect(screen.queryByText('Recovering terminal output...')).toBeNull()
      expect(screen.queryByTestId('loader')).toBeNull()
    })

    it('does not show recovering banner on fresh terminal creation', async () => {
      const tabId = 'tab-fresh'
      const paneId = 'pane-fresh'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-fresh',
        status: 'creating',
        mode: 'shell',
        shell: 'system',
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: 'creating',
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: 'req-fresh',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: {
            status: 'ready',
            error: null,
          },
          turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        },
      })

      // Use TerminalViewFromStore so paneContent updates from Redux reach the component
      const { queryByText } = render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      // Wait for create request to be sent
      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.create',
          requestId: 'req-fresh',
        }))
      })

      // Simulate server responding with terminal.created
      // This triggers: updateContent({ status: 'running' }) then attachTerminal(viewport_hydrate)
      act(() => {
        messageHandler!({ type: 'terminal.created', requestId: 'req-fresh', terminalId: 'term-fresh-1', createdAt: Date.now() })
      })

      // After terminal.created, status is 'running' and isAttaching is true
      // but the banner should NOT show because this is a fresh terminal
      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-fresh-1',
        }))
      })

      expect(queryByText('Recovering terminal output...')).toBeNull()
    })

    it('shows inline offline status while disconnected without blocking overlay', async () => {
      const { tabId, paneId, paneContent, store } = setupNonBlockingTerminal('disconnected')

      const { queryByText, queryByTestId } = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-non-blocking',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      expect(queryByTestId('loader')).toBeNull()
      expect(queryByText('Reconnecting...')).toBeNull()
      expect(queryByText('Offline: input will queue until reconnected.')).not.toBeNull()
    })
  })

  describe('v2 stream lifecycle', () => {
    async function renderTerminalHarness(opts?: {
      status?: 'creating' | 'running'
      terminalId?: string
      mode?: TerminalPaneContent['mode']
      recoverySummary?: TerminalPaneContent['recoverySummary']
      soulId?: string
      hidden?: boolean
      clearSends?: boolean
      requestId?: string
      ackInitialAttach?: boolean
      refreshOnMount?: boolean
      sessionRef?: TerminalPaneContent['sessionRef']
      serverInstanceId?: string
      /** Pane CONTENT's serverInstanceId (the fold-identity field the
       * checkpoint identity uses first; distinct from the connection-level
       * `serverInstanceId` opt). */
      contentServerInstanceId?: string
      streamId?: string
      waitForMessageHandler?: boolean
      waitForTerminalInstance?: boolean
      /** Render through the store-connected wrapper (the real
       * PaneContainer's wiring) so store-only content folds — reconcile
       * verdicts — re-render the pane and re-fire the lifecycle effect. */
      fromStore?: boolean
    }) {
      const tabId = 'tab-v2-stream'
      const paneId = 'pane-v2-stream'
      const requestId = opts?.requestId ?? 'req-v2-stream'
      const initialStatus = opts?.status ?? 'running'
      const terminalId = opts?.terminalId
      const mode = opts?.mode ?? 'shell'
      if (terminalId && opts?.streamId) {
        latestStreamIdByTerminal.set(terminalId, opts.streamId)
      }

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: requestId,
        status: initialStatus,
        mode,
        shell: 'system',
        ...(terminalId ? { terminalId } : {}),
        ...(opts?.sessionRef ? { sessionRef: opts.sessionRef } : {}),
        ...(opts?.streamId ? { streamId: opts.streamId } : {}),
        ...(opts?.recoverySummary ? { recoverySummary: opts.recoverySummary } : {}),
        ...(opts?.soulId ? { soulId: opts.soulId } : {}),
        ...(opts?.contentServerInstanceId ? { serverInstanceId: opts.contentServerInstanceId } : {}),
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
          freshAgent: freshAgentReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode,
              status: initialStatus,
              title: mode === 'opencode' ? 'OpenCode' : 'Shell',
              titleSetByUser: false,
              createRequestId: requestId,
              ...(terminalId ? { terminalId } : {}),
              ...(opts?.sessionRef ? { sessionRef: opts.sessionRef } : {}),
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: opts?.refreshOnMount
              ? {
                [tabId]: {
                  [paneId]: {
                    requestId: 'refresh-v2-stream',
                    target: { kind: 'terminal', createRequestId: requestId },
                  },
                },
              }
              : {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null, serverInstanceId: opts?.serverInstanceId ?? 'srv-v2-stream' },
        },
      })

      const view = render(
        <Provider store={store}>
          {opts?.fromStore
            ? <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={opts?.hidden} />
            : <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={opts?.hidden} />}
        </Provider>,
      )

      if (opts?.waitForMessageHandler !== false) {
        await waitFor(() => {
          expect(messageHandler).not.toBeNull()
        })
      }
      if (opts?.waitForTerminalInstance !== false) {
        await waitFor(() => {
          expect(terminalInstances.length).toBeGreaterThan(0)
        })
      }

      if (opts?.ackInitialAttach !== false && initialStatus === 'running' && terminalId && !opts?.hidden) {
        const initialAttach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        if (initialAttach?.attachRequestId) {
          act(() => {
            messageHandler!({
              type: 'terminal.attach.ready',
              terminalId,
              headSeq: initialAttach.sinceSeq ?? 0,
              replayFromSeq: (initialAttach.sinceSeq ?? 0) + 1,
              replayToSeq: initialAttach.sinceSeq ?? 0,
              attachRequestId: initialAttach.attachRequestId,
            })
          })
        }
      }

      if (opts?.clearSends !== false) {
        wsMocks.send.mockClear()
      }

      return {
        ...view,
        store,
        tabId,
        paneId,
        term: terminalInstances[terminalInstances.length - 1],
        requestId,
        terminalId: terminalId || 'term-v2-stream',
      }
    }

    it.each([false, true].flatMap((savedIdentity) => (['running', 'creating'] as const).map((status) => ({ savedIdentity, status }))))('preserves a recovering managed terminal on a rejected attach (saved identity $savedIdentity, stale $status)', async ({ savedIdentity, status }) => {
      const recoverySummary = { desiredState: 'running' as const, recoveryState: 'recovering' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const }
      const { store, term, tabId, paneId, terminalId } = await renderTerminalHarness({
        mode: 'codex', status, terminalId: 'automatic-invalid-terminal', clearSends: false, ackInitialAttach: false, fromStore: true,
        soulId: 'automatic-terminal-soul', recoverySummary,
        ...(savedIdentity ? { sessionRef: { provider: 'codex', sessionId: 'saved-automatic-thread' } } : {}),
      })
      const root = store.getState().panes.layouts[tabId]
      if (root.type !== 'leaf') throw new Error('Expected one pane')
      const before = root.content
      const attach = sentMessages().find((frame) => frame.type === 'terminal.attach' && frame.terminalId === terminalId)
      expect(attach).toMatchObject({ attachRequestId: expect.any(String) })
      act(() => messageHandler!({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId,
        requestId: attach.attachRequestId, message: 'Terminal not running' }))
      await act(async () => {})
      expect(store.getState().panes.layouts[tabId].content).toEqual(before)
      expect(sentMessages().filter((frame) => frame.type === 'terminal.create')).toEqual([])
      expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).not.toMatch(/Reconnecting|Starting a new terminal/)
      expect(screen.queryByTestId('managed-runtime-recovery-card')).not.toBeInTheDocument()
      expect(screen.queryByText('Starting terminal...')).not.toBeInTheDocument()
      // The managed replacement still folds and its real mounted attachment renders output.
      act(() => messageHandler!({ type: 'terminal.replaced', oldTerminalId: terminalId,
        newTerminalId: 'automatic-replacement-terminal', exitCode: 137, attempt: 1, maxAttempts: 3 }))
      const replacementAttach = sentMessages().filter((frame) => frame.type === 'terminal.attach'
        && frame.terminalId === 'automatic-replacement-terminal').at(-1)
      expect(replacementAttach).toMatchObject({ attachRequestId: expect.any(String) })
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId: 'automatic-replacement-terminal',
          attachRequestId: replacementAttach.attachRequestId, headSeq: 1, replayFromSeq: 1, replayToSeq: 1 })
        messageHandler!({ type: 'terminal.output', terminalId: 'automatic-replacement-terminal',
          attachRequestId: replacementAttach.attachRequestId, seqStart: 1, seqEnd: 1, data: 'Recovered conversation output' })
      })
      expect(term.write).toHaveBeenCalledWith('Recovered conversation output', expect.any(Function))
      expect(store.getState().panes.layouts[tabId].content).toMatchObject({
        terminalId: 'automatic-replacement-terminal', createRequestId: before.createRequestId, soulId: 'automatic-terminal-soul',
      })
      expect(store.getState().panes.layouts[tabId].content.sessionRef).toEqual(before.sessionRef)
    })

    it('retains an attach target rejected after live to recovering and reattaches after live authority returns', async () => {
      const { store, term, tabId, paneId, terminalId } = await renderTerminalHarness({
        mode: 'codex', terminalId: 'automatic-transition-terminal', clearSends: false, ackInitialAttach: false, fromStore: true,
        soulId: 'automatic-transition-soul', sessionRef: { provider: 'codex', sessionId: 'transition-saved-thread' },
      })
      const attach = sentMessages().filter((frame) => frame.type === 'terminal.attach').at(-1)
      const root = store.getState().panes.layouts[tabId]
      if (root.type !== 'leaf') throw new Error('Expected one pane')
      const recovering = { ...root.content, recoverySummary: { desiredState: 'running' as const, recoveryState: 'recovering' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
      act(() => store.dispatch(updatePaneContent({ tabId, paneId, content: recovering })))
      const currentAttach = sentMessages().filter((frame) => frame.type === 'terminal.attach').at(-1) ?? attach
      act(() => messageHandler!({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId,
        requestId: currentAttach.attachRequestId, message: 'Terminal not running' }))
      expect(store.getState().panes.layouts[tabId].content).toEqual(recovering)
      expect(sentMessages().filter((frame) => frame.type === 'terminal.create')).toEqual([])
      expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).not.toMatch(/Reconnecting|Starting a new terminal/)
      const beforeLive = sentMessages().filter((frame) => frame.type === 'terminal.attach').length
      act(() => store.dispatch(updatePaneContent({ tabId, paneId, content: { ...recovering,
        recoverySummary: { ...recovering.recoverySummary, recoveryState: 'live' } } })))
      expect(sentMessages().filter((frame) => frame.type === 'terminal.attach')).toHaveLength(beforeLive + 1)
      expect(sentMessages().filter((frame) => frame.type === 'terminal.attach').at(-1).terminalId).toBe(terminalId)
    })

    function replayReconstructedSurface(terminalId: string, probeAttachId: string, headSeq: number, data: string) {
      const attach = sentMessages().filter(msg => msg?.type === 'terminal.attach' && msg.terminalId === terminalId).at(-1)!
      expect(attach.attachRequestId).not.toBe(probeAttachId)
      expect(attach).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, attachRequestId: attach.attachRequestId, headSeq, replayFromSeq: 1, replayToSeq: headSeq })
        messageHandler!({ type: 'terminal.output', terminalId, attachRequestId: attach.attachRequestId, seqStart: 1, seqEnd: headSeq, data, source: 'replay' })
      })
      return attach
    }

    async function seedHeldSurface(suffix: string, bridge?: ReturnType<typeof createPerfAuditBridge>, fromStore = false) {
      if (bridge) installPerfAuditBridge(bridge)
      const lane = await renderTerminalHarness({
        status: 'running', terminalId: `term-held-${suffix}`,
        serverInstanceId: 'server-held', streamId: `stream-held-${suffix}`, clearSends: false,
        fromStore,
      })
      const { terminalId, term } = lane
      const firstAttach = sentMessages().find((msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId)!
      act(() => { messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'TRUSTED', attachRequestId: firstAttach.attachRequestId }) })
      const checkpoint = () => __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: `stream-held-${suffix}`, serverInstanceId: 'server-held',
      }, { paneId: lane.paneId })
      expect(checkpoint()).toMatchObject({ parserAppliedSeq: 1, surfaceCoverageSeq: 1 })
      const pump = captureWriteFrames()
      const held: Array<{ data: string; callback: () => void }> = []
      term.write.mockClear()
      term.write.mockImplementation((data: string, callback?: () => void) => {
        if (callback) held.push({ data, callback })
      })
      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 2, data: 'OLD-IN-FLIGHT', attachRequestId: firstAttach.attachRequestId })
        pump()
      })
      expect(held.map(item => item.data)).toEqual(['OLD-IN-FLIGHT'])
      wsMocks.send.mockClear()
      return {
        ...lane, firstAttach, checkpoint, pump, held,
        attaches: () => sentMessages().filter(msg => msg?.type === 'terminal.attach' && msg.terminalId === terminalId),
        release: () => act(() => { const item = held.shift()!; item.callback(); pump() }),
      }
    }

    it('create path sends terminal.create then explicit attach with viewport', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-split-create',
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId,
      }))

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-split-1', createdAt: Date.now() })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-split-1',
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
      }))
    })

    it('does not attach when the pane was removed before terminal.created arrives', async () => {
      const { requestId, store, tabId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-close-race',
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId,
      }))

      // Pane closed after the create was sent but before terminal.created arrives:
      // the tab's layout is removed, so the layouts never reference the new id.
      act(() => {
        store.dispatch(removeLayout({ tabId }))
      })

      wsMocks.send.mockClear()
      const newId = 'term-close-race-1'
      act(() => {
        messageHandler!({ type: 'terminal.created', requestId, terminalId: newId, createdAt: Date.now() })
      })

      const attachMessages = wsMocks.send.mock.calls
        .map(([msg]) => msg as { type?: string; terminalId?: string })
        .filter((msg) => msg?.type === 'terminal.attach' && msg.terminalId === newId)
      expect(attachMessages).toHaveLength(0)
    })

    it('terminal.created always triggers explicit attach with viewport', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-legacy-create',
      })

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-legacy-1', createdAt: Date.now() })

      const attachCalls = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-legacy-1')
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]).toMatchObject({
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
      })
    })

    it('hidden create path defers attach until visible and measured', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-create',
      })

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-hidden-create', createdAt: Date.now() })

      let attachCalls = wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.attach')
      expect(attachCalls).toHaveLength(0)

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      await waitFor(() => {
        attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-hidden-create')
        expect(attachCalls).toHaveLength(1)
      })
      expect(attachCalls[0]).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
        intent: 'viewport_hydrate',
      })
    })

    it('hidden split create keeps viewport_hydrate intent when reconnect fires before reveal', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-reconnect-intent',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-hidden-reconnect-intent',
        createdAt: Date.now(),
      })

      // Reconnect while hidden should not downgrade pending viewport hydration to delta attach.
      reconnectHandler?.()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      let attachCalls: Array<Record<string, unknown>> = []
      await waitFor(() => {
        attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-hidden-reconnect-intent')
        expect(attachCalls.length).toBeGreaterThan(0)
      })

      expect(attachCalls[0]).toMatchObject({
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        intent: 'viewport_hydrate',
      })
    })

    it('ignores duplicate terminal.created for a handled split request', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-duplicate-created',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-duplicate-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-duplicate-created')
        expect(attachCalls).toHaveLength(1)
      })

      const countByType = (type: string) => wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === type && msg?.terminalId === 'term-v2-duplicate-created')
        .length

      const attachCountAfterFirst = countByType('terminal.attach')
      const resizeCountAfterFirst = countByType('terminal.resize')

      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-duplicate-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        expect(countByType('terminal.attach')).toBe(attachCountAfterFirst)
        expect(countByType('terminal.resize')).toBe(resizeCountAfterFirst)
      })
    })

    it('handles same requestId terminal.created when terminalId changes', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-replaced-created',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-first-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const firstAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-first-created')
        expect(firstAttachCalls).toHaveLength(1)
      })

      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-replaced-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const firstAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-first-created')
        const replacedAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-replaced-created')
        expect(firstAttachCalls).toHaveLength(1)
        expect(replacedAttachCalls).toHaveLength(1)
      })
    })

    it('reconnect without a parser-applied checkpoint stays on the explicit hydrate lifecycle', async () => {
      const first = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-latched-first',
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: first.requestId,
      }))

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId: first.requestId,
        terminalId: 'term-latched-1',
        createdAt: Date.now(),
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-latched-1',
        cols: expect.any(Number),
        rows: expect.any(Number),
        intent: 'viewport_hydrate',
      }))

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-latched-1',
        cols: expect.any(Number),
        rows: expect.any(Number),
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      }))

      first.unmount()
      wsMocks.send.mockClear()

      const second = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-latched-second',
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: second.requestId,
      }))
    })

    it('claims a pending refresh request on mount by detaching and reattaching once', async () => {
      const { store, tabId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-refresh-mount',
        refreshOnMount: true,
        clearSends: false,
      })

      const sends = wsMocks.send.mock.calls.map(([msg]) => msg)
      const detachIdx = sends.findIndex((msg) => msg?.type === 'terminal.detach' && msg?.terminalId === terminalId)
      const attachCalls = sends.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

      expect(detachIdx).toBeGreaterThanOrEqual(0)
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
      })
      expect(store.getState().panes.refreshRequestsByPane[tabId]).toBeUndefined()
    })

    it('refreshes an attached terminal when a matching request arrives after mount', async () => {
      const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-refresh-late',
      })

      wsMocks.send.mockClear()

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })

      await waitFor(() => {
        const sends = wsMocks.send.mock.calls.map(([msg]) => msg)
        const detachIdx = sends.findIndex((msg) => msg?.type === 'terminal.detach' && msg?.terminalId === terminalId)
        const attachIdx = sends.findIndex((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

        expect(detachIdx).toBeGreaterThanOrEqual(0)
        expect(attachIdx).toBeGreaterThan(detachIdx)
        expect(sends[attachIdx]).toMatchObject({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
        })
      })

      expect(store.getState().panes.refreshRequestsByPane[tabId]).toBeUndefined()
    })

    it('sends sinceSeq=0 when attaching without previously rendered output', async () => {
      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-attach' })
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('drops stale and untagged terminal.output from non-current attach generations', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-attach-gen',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      wsMocks.send.mockClear()
      reconnectHandler?.()

      const secondAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

      expect(secondAttach?.attachRequestId).toBeTruthy()
      expect(secondAttach?.attachRequestId).not.toBe(firstAttach?.attachRequestId)

      let now = 200
      const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
        now += 0.01
        return now
      })
      try {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'STALE',
          attachRequestId: firstAttach!.attachRequestId,
        } as any)
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'FRESH',
          attachRequestId: secondAttach!.attachRequestId,
        } as any)
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 3,
          seqEnd: 3,
          data: 'UNTAGGED',
          __preserveMissingAttachRequestId: true,
        } as any)
      } finally {
        performanceNowSpy.mockRestore()
      }

      const writes = term.write.mock.calls.map(([d]) => String(d)).join('')
      expect(writes).toContain('FRESH')
      expect(writes).not.toContain('STALE')
      expect(writes).not.toContain('UNTAGGED')
      const staleRejectedEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.attach_generation_stale_rejected')
      expect(staleRejectedEvents).toHaveLength(2)
      expect(staleRejectedEvents[0]).toEqual(expect.objectContaining({
        event: 'terminal.attach_generation_stale_rejected',
        timestamp: expect.any(Number),
        terminalId,
        messageType: 'terminal.output',
        attachRequestId: firstAttach!.attachRequestId,
        activeAttachRequestId: secondAttach!.attachRequestId,
        reason: 'stale_attach_request_id',
      }))
      expect(staleRejectedEvents[1]).toEqual(expect.objectContaining({
        event: 'terminal.attach_generation_stale_rejected',
        timestamp: expect.any(Number),
        terminalId,
        messageType: 'terminal.output',
        activeAttachRequestId: secondAttach!.attachRequestId,
        reason: 'missing_attach_request_id',
      }))
      expect(staleRejectedEvents[1]).not.toHaveProperty('attachRequestId')
      expect(Number(staleRejectedEvents[0].timestamp)).toBeLessThan(Number(staleRejectedEvents[1].timestamp))
      expect(bridge.snapshot().metadata['terminal.attach_generation_stale_rejected']).toBeUndefined()
      expect(bridge.snapshot().milestones['terminal.attach_generation_stale_rejected']).toBeUndefined()
    })

    it('persists attach-ready stream id into pane content and checkpoint identity', async () => {
      const { store, tabId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-attach-stream-checkpoint',
        serverInstanceId: 'server-attach-stream',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-from-ready',
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-from-ready',
          seqStart: 1,
          seqEnd: 1,
          data: 'checkpointed on stream',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const layout = store.getState().panes.layouts[tabId]
      expect(layout.type).toBe('leaf')
      expect(layout.content.kind).toBe('terminal')
      expect(layout.content.streamId).toBe('stream-from-ready')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-from-ready',
        serverInstanceId: 'server-attach-stream',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: null,
        serverInstanceId: 'server-attach-stream',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
    })

    it.each([1, 206])('restarts a recovered managed output epoch at sequence one after old cursor %s', async (oldHead) => {
      const { terminalId, paneId, term } = await renderTerminalHarness({
        status: 'running', terminalId: `term-managed-epoch-${oldHead}`,
        serverInstanceId: 'server-managed-epoch', ackInitialAttach: false, clearSends: false,
      })
      const attach = sentMessages().find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)!
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, streamId: 'old-host-epoch',
          headSeq: oldHead, replayFromSeq: oldHead, replayToSeq: oldHead, attachRequestId: attach.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, streamId: 'old-host-epoch',
          seqStart: oldHead, seqEnd: oldHead, data: 'OLD HOST HISTORY', attachRequestId: attach.attachRequestId })
        messageHandler!({ type: 'terminal.stream.changed', terminalId, streamId: 'new-host-epoch',
          reason: 'new_pty_session', attachRequestId: attach.attachRequestId })
      })
      // Reuse the existing safe hydration handshake to retire queued writes
      // and parser callbacks from the old source before accepting lower seqs.
      const replacementAttach = sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId).at(-1)!
      expect(replacementAttach.attachRequestId).not.toBe(attach.attachRequestId)
      expect(replacementAttach.sinceSeq).toBe(0)
      expect(sentMessages().filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, streamId: 'new-host-epoch',
          headSeq: 2, replayFromSeq: 1, replayToSeq: 2, attachRequestId: replacementAttach.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, streamId: 'new-host-epoch',
          seqStart: 1, seqEnd: 1, data: 'RECOVERED PROVIDER PROMPT', attachRequestId: replacementAttach.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, streamId: 'old-host-epoch',
          seqStart: oldHead + 1, seqEnd: oldHead + 1, data: 'STALE OLD HOST', attachRequestId: attach.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, streamId: 'new-host-epoch',
          seqStart: 2, seqEnd: 2, data: 'NEW NATIVE RESPONSE', attachRequestId: replacementAttach.attachRequestId })
      })
      const writes = terminalWriteStrings(term).join('')
      expect(writes).toContain('RECOVERED PROVIDER PROMPT')
      expect(writes).toContain('NEW NATIVE RESPONSE')
      expect(writes).not.toContain('STALE OLD HOST')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'new-host-epoch', serverInstanceId: 'server-managed-epoch',
      }, { paneId })?.parserAppliedSeq).toBe(2)
    })

    it('does not rewind a managed epoch on a duplicate stream-change notification', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running', terminalId: 'term-managed-epoch-idempotent',
        ackInitialAttach: false, clearSends: false,
      })
      const attach = sentMessages().find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)!
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, streamId: 'old-managed-epoch',
          headSeq: 0, replayFromSeq: 1, replayToSeq: 0, attachRequestId: attach.attachRequestId })
        messageHandler!({ type: 'terminal.stream.changed', terminalId, streamId: 'new-managed-epoch',
          reason: 'new_pty_session', attachRequestId: attach.attachRequestId })
      })
      const replacementAttach = sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId).at(-1)!
      expect(replacementAttach.attachRequestId).not.toBe(attach.attachRequestId)
      const frame = { type: 'terminal.output', terminalId, streamId: 'new-managed-epoch',
        seqStart: 1, seqEnd: 1, data: 'EXACTLY_ONCE_NEW_EPOCH', attachRequestId: replacementAttach.attachRequestId }
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, streamId: 'new-managed-epoch',
          headSeq: 1, replayFromSeq: 1, replayToSeq: 1, attachRequestId: replacementAttach.attachRequestId })
        messageHandler!(frame)
        messageHandler!({ type: 'terminal.stream.changed', terminalId, streamId: 'new-managed-epoch',
          reason: 'new_pty_session', attachRequestId: replacementAttach.attachRequestId })
        messageHandler!(frame)
      })
      expect(terminalWriteStrings(term).join('').split('EXACTLY_ONCE_NEW_EPOCH')).toHaveLength(2)
      expect(sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(2)
    })

    it('accepts live output after a terminal.stream.changed control message without trusting the old stream', async () => {
      const { store, tabId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-active-stream-change-client',
        serverInstanceId: 'server-active-stream-change',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-before-change',
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-before-change',
          seqStart: 1,
          seqEnd: 1,
          data: 'BEFORE STREAM CHANGE',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-before-change',
        serverInstanceId: 'server-active-stream-change',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      act(() => {
        messageHandler!({
          type: 'terminal.stream.changed',
          terminalId,
          streamId: 'stream-after-change',
          reason: 'codex_pty_recovery',
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-after-change',
          seqStart: 2,
          seqEnd: 2,
          data: 'AFTER STREAM CHANGE',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const writes = terminalWriteStrings(term).join('')
      expect(writes).toContain('BEFORE STREAM CHANGE')
      expect(writes).toContain('AFTER STREAM CHANGE')

      const layout = store.getState().panes.layouts[tabId]
      expect(layout.type).toBe('leaf')
      expect(layout.content.kind).toBe('terminal')
      expect(layout.content.streamId).toBe('stream-after-change')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-before-change',
        serverInstanceId: 'server-active-stream-change',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-after-change',
        serverInstanceId: 'server-active-stream-change',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(2)
    })

    it('treats mismatched replay after a stream change as a completing lost range', async () => {
      const { store, terminalId, term, queryByText } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-stale-replay-stream-change-client',
        serverInstanceId: 'server-stale-replay-stream-change',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-before-change',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: attach!.attachRequestId,
        })
      })

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })
      const replayAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(replayAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-before-change',
          headSeq: 2,
          replayFromSeq: 1,
          replayToSeq: 2,
          attachRequestId: replayAttach!.attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      act(() => {
        messageHandler!({
          type: 'terminal.stream.changed',
          terminalId,
          streamId: 'stream-after-change',
          reason: 'codex_pty_recovery',
          attachRequestId: replayAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-before-change',
          seqStart: 1,
          seqEnd: 2,
          data: 'STALE REPLAY SHOULD NOT RENDER',
          attachRequestId: replayAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-after-change',
          seqStart: 3,
          seqEnd: 3,
          data: 'LIVE AFTER STREAM CHANGE',
          attachRequestId: replayAttach!.attachRequestId,
        })
      })

      const writes = terminalWriteStrings(term).join('')
      expect(writes).not.toContain('STALE REPLAY SHOULD NOT RENDER')
      expect(writes).toContain('LIVE AFTER STREAM CHANGE')
      expect(queryByText('Recovering terminal output...')).toBeNull()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-after-change',
        serverInstanceId: 'server-stale-replay-stream-change',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
    })

    it('rejects a warm-delta attach when attach-ready reports a different stream id', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { store, tabId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-stream-rotation-client',
        serverInstanceId: 'server-stream-rotation',
        ackInitialAttach: false,
        clearSends: false,
      })

      const initialAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(initialAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-before-rotation',
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: initialAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-before-rotation',
          seqStart: 1,
          seqEnd: 1,
          data: 'before rotation',
          attachRequestId: initialAttach!.attachRequestId,
        })
      })

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-before-rotation',
        serverInstanceId: 'server-stream-rotation',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })
      const warmDeltaAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(warmDeltaAttach).toMatchObject({
        intent: 'transport_reconnect',
        sinceSeq: 1,
      })

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-after-rotation',
          headSeq: 1,
          replayFromSeq: 2,
          replayToSeq: 1,
          attachRequestId: warmDeltaAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-after-rotation',
          seqStart: 2,
          seqEnd: 2,
          data: 'STREAM B SHOULD NOT RENDER ON STREAM A SURFACE',
          attachRequestId: warmDeltaAttach!.attachRequestId,
        })
      })

      const layout = store.getState().panes.layouts[tabId]
      expect(layout.type).toBe('leaf')
      expect(layout.content.kind).toBe('terminal')
      expect(layout.content.streamId).toBeUndefined()
      expect(terminalWriteStrings(term).join('')).not.toContain('STREAM B SHOULD NOT RENDER')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-after-rotation',
        serverInstanceId: 'server-stream-rotation',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
      const repairAttach = sentMessages()
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        .at(-1)
      expect(repairAttach?.attachRequestId).not.toBe(warmDeltaAttach!.attachRequestId)
      const fallbackEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.catchup.full_hydrate_fallback')
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          event: 'terminal.catchup.full_hydrate_fallback',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: warmDeltaAttach!.attachRequestId,
          reason: 'stream_identity_changed',
          expectedStreamId: 'stream-before-rotation',
          streamId: 'stream-after-rotation',
          sinceSeq: 1,
        }),
      ])
      expect(bridge.snapshot().milestones['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
      expect(bridge.snapshot().metadata['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
    })

    it('rejects a warm-delta attach when attach-ready reports unknown geometry authority', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-geometry-authority-client',
        serverInstanceId: 'server-geometry-authority',
        ackInitialAttach: false,
        clearSends: false,
      })

      const initialAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(initialAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-geometry',
          geometryEpoch: 1,
          geometryAuthority: 'single_client',
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: initialAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-geometry',
          seqStart: 1,
          seqEnd: 1,
          data: 'before geometry conflict',
          attachRequestId: initialAttach!.attachRequestId,
        })
      })

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-geometry',
        serverInstanceId: 'server-geometry-authority',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })
      const warmDeltaAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(warmDeltaAttach).toMatchObject({
        intent: 'transport_reconnect',
        sinceSeq: 1,
      })

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-geometry',
          geometryEpoch: 2,
          geometryAuthority: 'multi_client_unknown',
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: warmDeltaAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-geometry',
          seqStart: 2,
          seqEnd: 2,
          data: 'GEOMETRY DELTA SHOULD NOT RENDER',
          attachRequestId: warmDeltaAttach!.attachRequestId,
        })
      })

      expect(terminalWriteStrings(term).join('')).not.toContain('GEOMETRY DELTA SHOULD NOT RENDER')
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
      const repairAttach = sentMessages()
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        .at(-1)
      expect(repairAttach?.attachRequestId).not.toBe(warmDeltaAttach!.attachRequestId)
      const fallbackEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.catchup.full_hydrate_fallback')
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          event: 'terminal.catchup.full_hydrate_fallback',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: warmDeltaAttach!.attachRequestId,
          reason: 'geometry_authority_unknown',
          geometryAuthority: 'multi_client_unknown',
          geometryEpoch: 2,
          expectedGeometryAuthority: 'single_client',
          expectedGeometryEpoch: 1,
          sinceSeq: 1,
        }),
      ])
      expect(bridge.snapshot().milestones['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
      expect(bridge.snapshot().metadata['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
    })

    it('does not render or checkpoint terminal.output from a mismatched stream id', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-stream-mismatch-client',
        serverInstanceId: 'server-stream-mismatch',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-active',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-stale',
          seqStart: 1,
          seqEnd: 1,
          data: 'STALE STREAM',
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-active',
          seqStart: 2,
          seqEnd: 2,
          data: 'ACTIVE STREAM',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const writes = term.write.mock.calls.map(([data]) => String(data)).join('')
      expect(writes).not.toContain('STALE STREAM')
      expect(writes).toContain('ACTIVE STREAM')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-stream-mismatch',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('writes a homogeneous terminal.output.batch once and advances the parser-applied cursor after acknowledgement', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-combined',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 3,
          data: 'abc',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1 },
            { seqStart: 3, seqEnd: 3, endOffset: 3, rawFrameCount: 1 },
          ],
        })
      })

      expect(terminalWriteStrings(term)).toContain('abc')

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 3,
      }))
      const parserAppliedEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.parser_applied')
      expect(parserAppliedEvents).toEqual([
        expect.objectContaining({
          event: 'terminal.parser_applied',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId,
          parserAppliedSeq: 3,
          previousParserAppliedSeq: 0,
          surfaceQuarantined: false,
        }),
      ])
      expect(bridge.snapshot().milestones['terminal.parser_applied']).toBeUndefined()
    })

    it('records each parser-applied acknowledgement as a separate audit event', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-parser-applied-events',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      let now = 100
      const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
        now += 0.01
        return now
      })
      try {
        act(() => {
          messageHandler!({
            type: 'terminal.output',
            terminalId,
            streamId,
            attachRequestId,
            seqStart: 1,
            seqEnd: 1,
            data: 'first parser applied',
          })
          messageHandler!({
            type: 'terminal.output',
            terminalId,
            streamId,
            attachRequestId,
            seqStart: 2,
            seqEnd: 2,
            data: 'second parser applied',
          })
        })

        const parserAppliedEvents = bridge.snapshot().perfEvents
          .filter((event) => event.event === 'terminal.parser_applied')
        expect(parserAppliedEvents).toHaveLength(2)
        expect(parserAppliedEvents[0]).toEqual(expect.objectContaining({
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId,
          streamId,
          parserAppliedSeq: 1,
          previousParserAppliedSeq: 0,
        }))
        expect(parserAppliedEvents[1]).toEqual(expect.objectContaining({
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId,
          streamId,
          parserAppliedSeq: 2,
          previousParserAppliedSeq: 1,
        }))
        expect(Number(parserAppliedEvents[0].timestamp)).toBeLessThan(Number(parserAppliedEvents[1].timestamp))
        expect(bridge.snapshot().metadata['terminal.parser_applied']).toBeUndefined()
      } finally {
        performanceNowSpy.mockRestore()
      }
    })

    it('rejects an overlapping terminal.output.batch before writing partial bytes', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-overlap',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 1,
          data: 'already-rendered',
        })
      })
      expect(terminalWriteStrings(term)).toContain('already-rendered')

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 2,
          data: 'ab',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1 },
          ],
        })
      })

      expect(term.write).not.toHaveBeenCalled()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 2,
          seqEnd: 2,
          data: 'accepted-after-reject',
        })
      })
      expect(terminalWriteStrings(term)).toContain('accepted-after-reject')
    })

    it('rejects terminal.output.batch with non-contiguous segment ranges before writing', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-hole',
        serverInstanceId: 'server-output-batch-hole',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 3,
          data: 'ac',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 3, seqEnd: 3, endOffset: 2, rawFrameCount: 1 },
          ],
        })
      })

      expect(term.write).not.toHaveBeenCalled()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 4,
          seqEnd: 4,
          data: 'accepted-after-hole',
        })
      })
      expect(terminalWriteStrings(term)).toContain('accepted-after-hole')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-hole',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      }))
    })

    it('rejects terminal.output.batch with malformed fields before writing or checkpointing', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-malformed-numbers',
        serverInstanceId: 'server-output-batch-malformed-numbers',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      const validSegment = { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 }
      const malformedBatches: Array<Record<string, unknown>> = [
        { seqStart: '1', seqEnd: 1, segments: [validSegment] },
        { seqStart: 1, seqEnd: null, segments: [validSegment] },
        { seqStart: 1, seqEnd: 1, serializedBytes: '128', segments: [validSegment] },
        { seqStart: 1, seqEnd: 1, serializedBytes: null, segments: [validSegment] },
        { seqStart: 1, seqEnd: 1, serializedBytes: -1, segments: [validSegment] },
        { seqStart: 1, seqEnd: 1, serializedBytes: 128.5, segments: [validSegment] },
        { seqStart: 1, seqEnd: 1, data: null, segments: [{ seqStart: 1, seqEnd: 1, endOffset: 0, rawFrameCount: 1 }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, seqStart: '1' }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, seqEnd: null }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, endOffset: true }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, endOffset: Number.POSITIVE_INFINITY }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: '1' }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: null }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: 0 }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: -1 }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: 1.5 }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, rawFrameCount: 2 }] },
        { seqStart: 1, seqEnd: 2, segments: [{ seqStart: 1, seqEnd: 2, endOffset: 1, rawFrameCount: 1 }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, barrier: null }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, barrier: '' }] },
        { seqStart: 1, seqEnd: 1, segments: [{ ...validSegment, barrier: 'unknown' }] },
      ]

      term.write.mockClear()
      act(() => {
        for (const malformed of malformedBatches) {
          messageHandler!({
            type: 'terminal.output.batch',
            terminalId,
            streamId,
            attachRequestId,
            source: 'live',
            data: 'x',
            serializedBytes: 128,
            ...malformed,
          })
        }
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-malformed-numbers',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 3,
          seqEnd: 3,
          data: 'accepted-after-malformed-batch',
        })
      })
      expect(terminalWriteStrings(term)).toContain('accepted-after-malformed-batch')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-malformed-numbers',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      }))
    })

    it('rejects terminal.output.batch when an endOffset splits a UTF-16 surrogate pair', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-surrogate-split',
        serverInstanceId: 'server-output-batch-surrogate-split',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 2,
          data: '\ud83d\ude00',
          serializedBytes: 128,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, data: '\ud83d', rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, data: '\ude00', rawFrameCount: 1 },
          ],
        })
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-surrogate-split',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
    })

    it('rejects terminal.output.batch when segment data disagrees with offsets', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-data-mismatch',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 2,
          data: 'ab',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, data: 'a', rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, data: 'not-b', rawFrameCount: 1 },
          ],
        })
      })

      expect(term.write).not.toHaveBeenCalled()
    })

    it('fails closed after an invalid terminal.output.batch instead of checkpointing later output across the lost range', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-invalid-fail-closed',
        serverInstanceId: 'server-output-batch-invalid-fail-closed',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 2,
          data: 'ab',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, data: 'a', rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, data: 'not-b', rawFrameCount: 1 },
          ],
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 3,
          seqEnd: 3,
          data: 'c',
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['c'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-fail-closed',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
      expect(bridge.snapshot().perfEvents).toContainEqual(expect.objectContaining({
        event: 'terminal.catchup.surface_quarantined',
        terminalId,
        reason: 'invalid_terminal_output_batch',
        invalidReason: 'segment_data_mismatch',
        fromSeq: 1,
        toSeq: 2,
      }))

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      }))
    })

    it('does not checkpoint through the unapplied tail of an invalid terminal.output.batch that overlaps the current cursor', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-invalid-overlap-tail',
        serverInstanceId: 'server-output-batch-invalid-overlap-tail',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 10,
          data: 'abcdefghij',
        })
      })

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-overlap-tail',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(10)

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 9,
          seqEnd: 11,
          data: 'ijk',
          serializedBytes: 256,
          segments: [
            { seqStart: 9, seqEnd: 9, endOffset: 1, data: 'i', rawFrameCount: 1 },
            { seqStart: 10, seqEnd: 10, endOffset: 2, data: 'j', rawFrameCount: 1 },
            { seqStart: 11, seqEnd: 11, endOffset: 3, data: 'not-k', rawFrameCount: 1 },
          ],
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 12,
          seqEnd: 12,
          data: 'l',
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['l'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-overlap-tail',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(10)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      }))
    })

    it('preserves parser barrier checkpoints while allowing terminal.output.batch writes to coalesce', async () => {
      const rafCallbacks: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      })

      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-barrier',
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockClear()
      term.write.mockImplementation((chunk: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data: chunk, callback: onWritten })
      })

      rafCallbacks.length = 0
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'replay',
          seqStart: 1,
          seqEnd: 3,
          data: 'aBc',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'control' },
            { seqStart: 3, seqEnd: 3, endOffset: 3, rawFrameCount: 1 },
          ],
        })
      })

      expect(delayedCallbacks).toEqual([])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['aBc'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(3)
    })

    it('keeps strict application before a stripped middle batch segment while ordered coverage advances', async () => {
      const rafCallbacks: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      })

      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-stripped-middle-coalesced',
        mode: 'codex',
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockClear()
      term.write.mockImplementation((chunk: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data: chunk, callback: onWritten })
      })

      rafCallbacks.length = 0
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'replay',
          seqStart: 1,
          seqEnd: 3,
          data: 'A\x07B',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'turn_complete' },
            { seqStart: 3, seqEnd: 3, endOffset: 3, rawFrameCount: 1 },
          ],
        })
      })

      expect(delayedCallbacks).toEqual([])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['A'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
        while (rafCallbacks.length) rafCallbacks.shift()!(16)
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['A', 'B'])
      act(() => { delayedCallbacks[1].callback() })
      expect(delayedCallbacks.map(({ data }) => data).join('')).toBe('AB')

      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 3,
      }))
    })

    it('replays barrier-heavy OpenCode batches as bounded writes while holding checkpoints until xterm applies them', async () => {
      const rafCallbacks: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      })

      const { terminalId, term, queryByText, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-opencode-heavy-replay',
        mode: 'opencode',
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      const attachRequestId = attach?.attachRequestId
      const streamId = 'stream-output-batch-opencode-heavy-replay'
      expect(attachRequestId).toBeTruthy()

      const chunks = Array.from({ length: 96 }, (_unused, index) => (
        index % 2 === 0
          ? `\x1b[${30 + (index % 8)}m`
          : `tok${index.toString().padStart(2, '0')}`
      ))
      const data = chunks.join('')
      const segments = chunks.map((chunk, index) => ({
        seqStart: index + 1,
        seqEnd: index + 1,
        endOffset: chunks.slice(0, index + 1).join('').length,
        rawFrameCount: 1,
        barrier: 'control',
      }))

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId,
          headSeq: chunks.length,
          replayFromSeq: 1,
          replayToSeq: chunks.length,
          attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      rafCallbacks.length = 0
      term.write.mockClear()
      term.write.mockImplementation((chunk: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data: chunk, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'replay',
          seqStart: 1,
          seqEnd: chunks.length,
          data,
          serializedBytes: data.length + 512,
          segments,
        })
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      const submittedReplay = delayedCallbacks.map(({ data: chunk }) => chunk).join('')
      expect(submittedReplay).toBe(data)
      expect(delayedCallbacks.length).toBeLessThanOrEqual(2)
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      act(() => {
        delayedCallbacks.forEach(({ callback }) => callback())
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(chunks.length)
    })

    it('does not checkpoint a stripped terminal.output.batch BEL segment as parser-applied', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-stripped-bel',
        mode: 'codex',
        serverInstanceId: 'server-output-batch-stripped-bel',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 2,
          data: 'A\x07',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'turn_complete' },
          ],
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['A'])
      // The strict APPLIED position never crosses the stripped BEL segment;
      // the COVERAGE cursor does (a null-screen-effect completion signal) and
      // is the resume position (responsive-terminal-restore WS2).
      const strippedBelCheckpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-bel',
      }, { paneId: 'pane-v2-stream' })
      expect(strippedBelCheckpoint?.parserAppliedSeq).toBe(1)
      expect(strippedBelCheckpoint?.surfaceCoverageSeq).toBe(2)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 2,
      }))
    })

    it('completes attach when replay ends in a stripped terminal.output.batch BEL segment without checkpointing it', async () => {
      const { terminalId, term, queryByText, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-replay-stripped-complete',
        mode: 'codex',
        serverInstanceId: 'server-output-batch-replay-stripped-complete',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })
      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      const attachRequestId = attach?.attachRequestId
      const streamId = 'stream-output-batch-replay-stripped-complete'
      expect(attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'replay',
          seqStart: 1,
          seqEnd: 1,
          data: '\x07',
          serializedBytes: 128,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1, barrier: 'turn_complete' },
          ],
        })
      })

      expect(term.write).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      // No false APPLIED record (nothing rendered), but the completion
      // signal IS consumed coverage: the resume position is 1, not a
      // full-baseline rebuild (responsive-terminal-restore WS2).
      const belOnlyCheckpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-complete',
      }, { paneId: 'pane-v2-stream' })
      expect(belOnlyCheckpoint?.parserAppliedSeq).toBe(0)
      expect(belOnlyCheckpoint?.surfaceCoverageSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 1,
      }))
    })

    it('queues stripped terminal.output.batch replay completion behind earlier replay write callbacks', async () => {
      const { terminalId, term, queryByText, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-replay-stripped-tail',
        mode: 'codex',
        serverInstanceId: 'server-output-batch-replay-stripped-tail',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })
      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      const attachRequestId = attach?.attachRequestId
      const streamId = 'stream-output-batch-replay-stripped-tail'
      expect(attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId,
          headSeq: 2,
          replayFromSeq: 1,
          replayToSeq: 2,
          attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockClear()
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'replay',
          seqStart: 1,
          seqEnd: 2,
          data: 'A\x07',
          serializedBytes: 128,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
            { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'turn_complete' },
          ],
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['A'])
      expect(queryByText('Recovering terminal output...')).not.toBeNull()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-tail',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-tail',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 2,
      }))
    })

    it('does not checkpoint a mixed renderable and stripped terminal.output.batch segment as parser-applied', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-batch-mixed-stripped-bel',
        mode: 'codex',
        serverInstanceId: 'server-output-batch-mixed-stripped-bel',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output.batch',
          terminalId,
          streamId,
          attachRequestId,
          source: 'live',
          seqStart: 1,
          seqEnd: 1,
          data: 'A\x07',
          serializedBytes: 256,
          segments: [
            { seqStart: 1, seqEnd: 1, endOffset: 2, rawFrameCount: 1, barrier: 'turn_complete' },
          ],
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['A'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-mixed-stripped-bel',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
      }))
    })

    it('does not checkpoint a stripped legacy terminal.output BEL frame as parser-applied', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-legacy-stripped-bel',
        mode: 'codex',
        serverInstanceId: 'server-output-legacy-stripped-bel',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 1,
          data: '\x07',
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 2,
          seqEnd: 2,
          data: 'B',
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['B'])
      // No false APPLIED record (the BEL blocks the strict cursor at zero);
      // the coverage cursor spans the filtered BEL and the applied tail.
      const legacyStrippedCheckpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-stripped-bel',
      }, { paneId: 'pane-v2-stream' })
      expect(legacyStrippedCheckpoint?.parserAppliedSeq).toBe(0)
      expect(legacyStrippedCheckpoint?.surfaceCoverageSeq).toBe(2)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 2,
      }))
    })

    it('completes attach when replay ends in a stripped legacy terminal.output BEL frame without checkpointing it', async () => {
      const { terminalId, term, queryByText, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-legacy-replay-stripped-complete',
        mode: 'codex',
        serverInstanceId: 'server-output-legacy-replay-stripped-complete',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })
      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      const attachRequestId = attach?.attachRequestId
      const streamId = 'stream-output-legacy-replay-stripped-complete'
      expect(attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 1,
          data: '\x07',
        })
      })

      expect(term.write).not.toHaveBeenCalled()
      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      const legacyBelOnlyCheckpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-complete',
      }, { paneId: 'pane-v2-stream' })
      expect(legacyBelOnlyCheckpoint?.parserAppliedSeq).toBe(0)
      expect(legacyBelOnlyCheckpoint?.surfaceCoverageSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 1,
      }))
    })

    it('queues stripped legacy terminal.output replay completion behind earlier replay write callbacks', async () => {
      const { terminalId, term, queryByText, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-legacy-replay-stripped-tail',
        mode: 'codex',
        serverInstanceId: 'server-output-legacy-replay-stripped-tail',
        ackInitialAttach: false,
        clearSends: false,
      })
      act(() => {
        store.dispatch(setConnectionStatus('ready'))
      })
      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      const attachRequestId = attach?.attachRequestId
      const streamId = 'stream-output-legacy-replay-stripped-tail'
      expect(attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId,
          headSeq: 2,
          replayFromSeq: 1,
          replayToSeq: 2,
          attachRequestId,
        })
      })
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockClear()
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 1,
          data: 'A',
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 2,
          seqEnd: 2,
          data: '\x07',
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['A'])
      expect(queryByText('Recovering terminal output...')).not.toBeNull()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-tail',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-tail',
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 2,
      }))
    })

    it('does not checkpoint a mixed renderable and stripped legacy terminal.output frame as parser-applied', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-output-legacy-mixed-stripped-bel',
        mode: 'codex',
        serverInstanceId: 'server-output-legacy-mixed-stripped-bel',
      })
      const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
      const streamId = latestStreamIdByTerminal.get(terminalId)
      expect(attachRequestId).toBeTruthy()
      expect(streamId).toBeTruthy()

      term.write.mockClear()
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId,
          attachRequestId,
          seqStart: 1,
          seqEnd: 1,
          data: 'A\x07',
        })
      })

      expect(terminalWriteStrings(term)).toEqual(['A'])
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-mixed-stripped-bel',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
      }))
    })

    it('does not render or checkpoint terminal.output missing stream id after attach-ready', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-missing-output-stream-client',
        serverInstanceId: 'server-missing-output-stream',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-active',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'MISSING STREAM',
          attachRequestId: attach!.attachRequestId,
          __preserveMissingStreamId: true,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-active',
          seqStart: 2,
          seqEnd: 2,
          data: 'ACTIVE AFTER MISSING',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const writes = term.write.mock.calls.map(([data]) => String(data)).join('')
      expect(writes).not.toContain('MISSING STREAM')
      expect(writes).toContain('ACTIVE AFTER MISSING')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-missing-output-stream',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('does not render or checkpoint terminal.output.gap missing stream id after attach-ready', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-missing-gap-stream-client',
        serverInstanceId: 'server-missing-gap-stream',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          streamId: 'stream-active',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 5,
          reason: 'queue_overflow',
          attachRequestId: attach!.attachRequestId,
          __preserveMissingStreamId: true,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          streamId: 'stream-active',
          seqStart: 6,
          seqEnd: 6,
          data: 'ACTIVE AFTER MISSING GAP',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const writes = term.write.mock.calls.map(([data]) => String(data)).join('')
      expect(writes).not.toContain('Output gap 1-5')
      expect(writes).toContain('ACTIVE AFTER MISSING GAP')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-missing-gap-stream',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('keeps the legacy missing-stream output path only before attach-ready establishes stream identity', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-legacy-pre-ready-stream',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'LEGACY BEFORE READY',
          attachRequestId: attach!.attachRequestId,
        })
      })

      const writes = term.write.mock.calls.map(([data]) => String(data)).join('')
      expect(writes).toContain('LEGACY BEFORE READY')
    })

    it('clears stale stored stream id when attach-ready omits stream id and rejects untagged output and gaps', async () => {
      const { store, tabId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-legacy-ready-without-stream',
        serverInstanceId: 'server-missing-ready-stream',
        streamId: 'stored-stale-stream',
        ackInitialAttach: false,
        clearSends: false,
      })

      const attach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: attach!.attachRequestId,
          __preserveMissingStreamId: true,
        } as any)
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'UNTAGGED AFTER BAD READY',
          attachRequestId: attach!.attachRequestId,
          __preserveMissingStreamId: true,
        } as any)
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 3,
          reason: 'queue_overflow',
          attachRequestId: attach!.attachRequestId,
          __preserveMissingStreamId: true,
        } as any)
      })

      const layout = store.getState().panes.layouts[tabId]
      expect(layout.type).toBe('leaf')
      expect(layout.content.kind).toBe('terminal')
      expect(layout.content.streamId).toBeUndefined()

      const writes = terminalWriteStrings(term).join('')
      expect(writes).not.toContain('UNTAGGED AFTER BAD READY')
      expect(writes).not.toContain('Output gap 2-3')
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stored-stale-stream',
        serverInstanceId: 'server-missing-ready-stream',
      }, { paneId: 'pane-v2-stream' })).toBeNull()
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: null,
        serverInstanceId: 'server-missing-ready-stream',
      }, { paneId: 'pane-v2-stream' })).toBeNull()

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('does not use a null-stream checkpoint for warm delta after attach-ready omits stream id', async () => {
      const terminalId = 'term-null-stream-checkpoint'
      const serverInstanceId = 'server-null-stream-checkpoint'
      saveTerminalSurfaceCheckpoint({
        terminalId,
        streamId: null,
        serverInstanceId,
        surfaceEpoch: 0,
        attachRequestId: 'seed-null-stream-checkpoint',
        parserAppliedSeq: 17,
        cols: 80,
        rows: 24,
        geometryEpoch: 1,
        geometryAuthority: 'single_client',
        scrollback: 10000,
        xtermVersion: '6.0.0',
        bufferType: 'unknown',
        parserIdle: true,
      }, { paneId: 'pane-v2-stream' })
      expect(__readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: null,
        serverInstanceId,
      }, { paneId: 'pane-v2-stream' })?.parserAppliedSeq).toBe(17)

      await renderTerminalHarness({
        status: 'running',
        terminalId,
        serverInstanceId,
        ackInitialAttach: false,
        clearSends: false,
      })

      const initialAttach = sentMessages()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(initialAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: initialAttach!.attachRequestId,
          __preserveMissingStreamId: true,
        } as any)
      })

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('ignores xterm title callbacks fired while replay writes are scoped', async () => {
      const { terminalId, term, store, tabId, paneId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-replay-title',
        ackInitialAttach: false,
        clearSends: false,
      })

      await waitFor(() => {
        expect(term.onTitleChange).toHaveBeenCalled()
      })
      const titleHandler = term.onTitleChange.mock.calls[0]?.[0]
      expect(typeof titleHandler).toBe('function')

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'replay title frame',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['replay title frame'])

      act(() => {
        titleHandler('Replay Title')
      })

      expect(store.getState().tabs.tabs.find((tab) => tab.id === tabId)?.title).toBe('Shell')
      expect(store.getState().panes.paneTitles[tabId]?.[paneId]).not.toBe('Replay Title')

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'live title frame',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual([
        'replay title frame',
        'live title frame',
      ])

      act(() => {
        titleHandler('Live Title')
      })

      expect(store.getState().tabs.tabs.find((tab) => tab.id === tabId)?.title).toBe('Live Title')
      expect(store.getState().panes.paneTitles[tabId]?.[paneId]).toBe('Live Title')
    })

    it('does not let stale write callbacks advance the current parser-applied cursor', async () => {
      const lane = await seedHeldSurface('stale-callback')
      const { terminalId, term, held, pump, firstAttach, checkpoint, attaches, release } = lane
      const staleCallback = held[0].callback
      act(() => { reconnectHandler!(); pump() })
      expect(attaches()).toEqual([])
      expect(checkpoint()).toMatchObject({ attachRequestId: firstAttach.attachRequestId, parserAppliedSeq: 1 })
      release()
      expect(held.map(item => item.data)).toEqual([MOUNTED_RECONSTRUCTION])
      expect(attaches()).toEqual([])
      expect(checkpoint()).toMatchObject({ parserAppliedSeq: 1 })
      release()
      const current = attaches().at(-1)!
      expect(current).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      expect(current.attachRequestId).not.toBe(firstAttach.attachRequestId)
      expect(checkpoint()).toBeNull()
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 4, replayFromSeq: 1, replayToSeq: 4, attachRequestId: current.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'CURRENT-FULL-REPLAY', attachRequestId: current.attachRequestId })
        pump()
        staleCallback()
      })
      expect(checkpoint()).toBeNull()
      expect(held.map(item => item.data)).toEqual(['CURRENT-FULL-REPLAY'])
      release()
      expect(checkpoint()).toMatchObject({ attachRequestId: current.attachRequestId, parserAppliedSeq: 4, surfaceCoverageSeq: 4 })
      act(() => { reconnectHandler!() })
      expect(attaches().at(-1)).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.clear).not.toHaveBeenCalled()
    })

    it('fails closed from delta attach when writes are in flight and repairs quarantine after drain', async () => {
      const bridge = createPerfAuditBridge()
      const lane = await seedHeldSurface('delta', bridge)
      const { terminalId, term, pump, firstAttach, checkpoint, attaches, held, release } = lane
      act(() => { reconnectHandler!(); pump() })
      expect(attaches()).toEqual([])
      const fallback = bridge.snapshot().perfEvents.filter(event => event.event === 'terminal.catchup.full_hydrate_fallback')
      const quarantines = bridge.snapshot().perfEvents.filter(event => event.event === 'terminal.catchup.surface_quarantined')
      expect(fallback).toEqual([expect.objectContaining({ terminalId, timestamp: expect.any(Number), requestedIntent: 'transport_reconnect', intent: 'viewport_hydrate', reason: 'in_flight_writes', hasInFlightWrites: true, phase: 'reconstruction_pending' })])
      expect(quarantines).toEqual([expect.objectContaining({ terminalId, timestamp: expect.any(Number), requestedIntent: 'transport_reconnect', intent: 'viewport_hydrate', reason: 'in_flight_writes', phase: 'reconstruction_pending' })])
      act(() => {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 3, replayFromSeq: 2, replayToSeq: 3, attachRequestId: firstAttach.attachRequestId })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 3, data: 'QUARANTINED-OLD-REPLAY', attachRequestId: firstAttach.attachRequestId })
        pump()
      })
      expect(held.map(item => item.data)).toEqual(['OLD-IN-FLIGHT'])
      release()
      expect(held.map(item => item.data)).toEqual([MOUNTED_RECONSTRUCTION])
      expect(attaches()).toEqual([])
      expect(checkpoint()).toMatchObject({ parserAppliedSeq: 1 })
      release()
      expect(attaches()).toHaveLength(1)
      expect(attaches()[0]).toMatchObject({ attachRequestId: fallback[0].attachRequestId, intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      expect(bridge.snapshot().perfEvents.filter(event => event.event === 'terminal.catchup.surface_quarantine_repair')).toEqual([expect.objectContaining({ terminalId, resumable: false, completedWritesDuringQuarantine: 1 })])
      expect(checkpoint()).toBeNull()
      expect(terminalWriteStrings(term)).not.toContain('QUARANTINED-OLD-REPLAY')
      for (const event of ['terminal.catchup.full_hydrate_fallback', 'terminal.catchup.surface_quarantined']) {
        expect(bridge.snapshot().metadata[event]).toBeUndefined()
        expect(bridge.snapshot().milestones[event]).toBeUndefined()
      }
      act(() => { reconnectHandler!(); pump() })
      expect(attaches().at(-1)).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      expect(term.clear).not.toHaveBeenCalled()
    })

    it('drops quarantined replay and reconstructs after timed-out old writes drain', async () => {
      const bridge = createPerfAuditBridge()
      const { terminalId, term, pump, held, firstAttach, attaches, release } = await seedHeldSurface('timeout', bridge)
      // The fixture owns RAF ordering; fake only the quarantine clock/poll.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        act(() => { reconnectHandler!(); pump() })
        const firstTicket = bridge.snapshot().perfEvents.find(event => event.event === 'terminal.catchup.surface_quarantined')!
        expect(attaches()).toEqual([])
        act(() => {
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 3, data: 'QUARANTINED-TIMEOUT', attachRequestId: firstAttach.attachRequestId })
          vi.advanceTimersByTime(2_100)
          pump()
        })
        expect(reconstructionWrites(term)).toEqual([])
        expect(bridge.snapshot().perfEvents.some(event => event.event === 'terminal.catchup.surface_quarantine_timeout')).toBe(true)
        release()
        expect(held).toEqual([])
        expect(attaches()).toEqual([])
        act(() => { vi.advanceTimersByTime(100); pump() })
        expect(held.map(item => item.data)).toEqual([MOUNTED_RECONSTRUCTION])
        expect(attaches()).toEqual([])
        release()
        expect(attaches()).toHaveLength(1)
        expect(attaches()[0]).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
        expect(attaches()[0].attachRequestId).not.toBe(firstTicket.attachRequestId)
        expect(terminalWriteStrings(term)).not.toContain('QUARANTINED-TIMEOUT')
        expect(reconstructionWrites(term)).toHaveLength(1)
        expect(term.clear).not.toHaveBeenCalled()
      } finally { vi.useRealTimers() }
    })

    it('records repeated in-flight full-hydrate fallback and quarantine audit events separately', async () => {
      const bridge = createPerfAuditBridge()
      const { terminalId, pump, attaches, held, release } = await seedHeldSurface('repeat', bridge)
      let now = 200
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now += 0.01)
      try {
        act(() => { reconnectHandler!(); reconnectHandler!(); pump() })
        expect(attaches()).toEqual([])
        const fallbacks = bridge.snapshot().perfEvents.filter(event => event.event === 'terminal.catchup.full_hydrate_fallback')
        const quarantines = bridge.snapshot().perfEvents.filter(event => event.event === 'terminal.catchup.surface_quarantined')
        for (const events of [fallbacks, quarantines]) {
          expect(events).toHaveLength(2)
          expect(events[0].attachRequestId).not.toBe(events[1].attachRequestId)
          expect(events[0].localGeneration).not.toBe(events[1].localGeneration)
          expect(Number(events[0].timestamp)).toBeLessThan(Number(events[1].timestamp))
          for (const event of events) expect(event).toMatchObject({ terminalId, requestedIntent: 'transport_reconnect', intent: 'viewport_hydrate', reason: 'in_flight_writes', phase: 'reconstruction_pending' })
        }
        expect(fallbacks.every(event => event.hasInFlightWrites === true)).toBe(true)
        release()
        expect(held.map(item => item.data)).toEqual([MOUNTED_RECONSTRUCTION])
        release()
        expect(attaches()).toHaveLength(1)
        expect(attaches()[0].attachRequestId).toBe(fallbacks[1].attachRequestId)
        for (const event of ['terminal.catchup.full_hydrate_fallback', 'terminal.catchup.surface_quarantined']) {
          expect(bridge.snapshot().metadata[event]).toBeUndefined()
          expect(bridge.snapshot().milestones[event]).toBeUndefined()
        }
      } finally { clock.mockRestore() }
    })

    it('does not clear the old surface when full hydrate starts with in-flight writes', async () => {
      const { store, tabId, paneId, term, pump, held, attaches, release } = await seedHeldSurface('refresh')
      act(() => { store.dispatch(requestPaneRefresh({ tabId, paneId })) })
      act(() => pump())
      expect(attaches()).toEqual([])
      expect(reconstructionWrites(term)).toEqual([])
      act(() => { reconnectHandler!(); pump() })
      expect(attaches()).toEqual([])
      expect(held.map(item => item.data)).toEqual(['OLD-IN-FLIGHT'])
      release()
      expect(held.map(item => item.data)).toEqual([MOUNTED_RECONSTRUCTION])
      expect(attaches()).toEqual([])
      release()
      expect(attaches()).toHaveLength(1)
      expect(attaches()[0]).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.clear).not.toHaveBeenCalled()
    })

    it('cancels quarantined repair after invalid-terminal replacement before writes drain', async () => {
      const { terminalId, store, tabId, term, pump, held, attaches, release } = await seedHeldSurface('invalid', undefined, true)
      act(() => { reconnectHandler!(); pump() })
      expect(attaches()).toEqual([])
      // No newer attach has reached the wire. A terminal-scoped legacy error
      // reports the terminal gone; an old attach-tagged error is obsolete.
      act(() => { messageHandler!({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId, message: 'gone' }) })
      expect((store.getState().panes.layouts[tabId] as { content: any }).content.terminalId).toBeUndefined()
      wsMocks.send.mockClear()
      release()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); pump() })
      expect(attaches()).toEqual([])
      expect(held.map(item => item.data)).not.toContain(MOUNTED_RECONSTRUCTION)
      expect(reconstructionWrites(term)).toEqual([])
    })

    it('handles tagged invalid-terminal errors from quarantine repair attaches', async () => {
      const { terminalId, store, tabId, requestId, pump, firstAttach, attaches, release } = await seedHeldSurface('repair-invalid')
      act(() => { reconnectHandler!(); pump() })
      expect(attaches()).toEqual([])
      release()
      expect(attaches()).toEqual([])
      release()
      const repairAttach = attaches()[0]!
      expect(repairAttach).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true })
      expect(repairAttach.attachRequestId).not.toBe(firstAttach.attachRequestId)
      act(() => { messageHandler!({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId, requestId: repairAttach.attachRequestId, message: 'Terminal not running' }) })
      await waitFor(() => {
        const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
        expect(layout.content.terminalId).toBeUndefined()
        expect(layout.content.status).toBe('creating')
        expect(layout.content.createRequestId).not.toBe(requestId)
      })
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(restoreMocks.addTerminalFreshRecoveryRequestId).toHaveBeenCalledWith(layout.content.createRequestId, 'fresh_after_restore_unavailable')
      wsMocks.send.mockClear()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); pump() })
      expect(attaches()).toEqual([])
    })

    it('keeps queued viewport_hydrate intent when reconnect fires before the first hidden attach completes', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-created-before-reconnect',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-hidden-created-before-reconnect',
        createdAt: Date.now(),
      })

      reconnectHandler?.()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-hidden-created-before-reconnect',
          sinceSeq: 0,
          cols: expect.any(Number),
          rows: expect.any(Number),
        }))
      })
    })

    it('pumps the hydration queue for a hidden pane on reconnect even without a usable parser checkpoint', async () => {
      // The active tab hydrated first: the background pump is already started
      // (onActiveTabReady is one-shot) before this hidden pane ever mounts.
      act(() => {
        getHydrationQueue().onActiveTabReady('tab-active-first', ['tab-active-first'])
      })

      const { terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hidden-reconnect-pump',
        hidden: true,
        ackInitialAttach: false,
      })

      // A hidden pane mounted post-startup registers WITHOUT queueIfStarted by
      // design -- it waits for reveal. Nothing may attach while it stays hidden.
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)

      // No parser-applied checkpoint exists for this terminal in the harness,
      // so the reconnect hidden branch takes the checkpoint-missing path --
      // exactly the branch that registered with queueIfStarted:false and wedged
      // behind the consumed registration guard.
      act(() => {
        reconnectHandler?.()
      })

      // The pane must be re-queued AND pumped with no reveal: a full replay
      // attach leaves the client through the background hydration slot.
      // (Hidden viewport hydration uses the keepalive_delta wire token per the
      // attach policy's geometry swap; sinceSeq 0 = full replay.)
      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'keepalive_delta',
          sinceSeq: 0,
          priority: 'background',
          attachRequestId: expect.any(String),
        }))
      })

      // The queue stays one-at-a-time: a second hidden pane registered behind
      // this one must hold until this pane's hydration completes -- proof the
      // reconnect re-register took the pump slot and the queue then advanced
      // past it.
      const trailingTrigger = vi.fn()
      act(() => {
        getHydrationQueue().register(
          { tabId: 'tab-trailing', paneId: 'pane-trailing', trigger: trailingTrigger },
          { queueIfStarted: true },
        )
      })
      expect(trailingTrigger).not.toHaveBeenCalled()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
        })
      })
      await waitFor(() => {
        expect(trailingTrigger).toHaveBeenCalledTimes(1)
      })
    })

    it('uses the highest rendered sequence in reconnect attach requests', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-reconnect' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'ab' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 3, data: 'c' })

      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('ab')
      expect(writes).toContain('c')

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 3,
        attachRequestId: expect.any(String),
      }))
    })

    it('reattaches with latest rendered sequence after terminal view remount', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-remount' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
    })

    it('does not attach a remounted hidden pane until it becomes visible', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-hidden-remount' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
      }))
    })

    it('performs one deferred viewport hydration attach when a remounted hidden pane becomes visible', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-deferred-hydrate' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      const view = render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
      }))

      wsMocks.send.mockClear()
      view.rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          intent: 'viewport_hydrate',
          attachRequestId: expect.any(String),
        }))
      })
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)
    })

    it('arms hidden OpenCode viewport hydration after provider registry readiness', async () => {
      localStorage.setItem('freshell.auth-token', 'test-token')
      let resolveExtensionsFetch: (response: Response) => void = () => {}
      const extensionsFetch = new Promise<Response>((resolve) => {
        resolveExtensionsFetch = resolve
      })
      const fetchMock = vi.fn(() => extensionsFetch)
      vi.stubGlobal('fetch', fetchMock)

      const sessionRef = { provider: 'opencode', sessionId: 'ses_delayed_registry' } as const
      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-opencode-delayed-registry',
        mode: 'opencode',
        hidden: true,
        clearSends: false,
        ackInitialAttach: false,
        sessionRef,
        waitForMessageHandler: false,
        waitForTerminalInstance: false,
      })

      expect(terminalInstances).toHaveLength(0)
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled()
      })
      expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/extensions$/)

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }
      const renderVisibility = (isHidden: boolean) => (
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()!} hidden={isHidden} />
        </Provider>
      )

      wsMocks.send.mockClear()
      await act(async () => {
        resolveExtensionsFetch(new Response(JSON.stringify([]), { status: 200 }))
      })

      await waitFor(() => {
        expect(terminalInstances.length).toBeGreaterThan(0)
      })
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)

      wsMocks.send.mockClear()
      await act(async () => {
        rerender(renderVisibility(false))
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'viewport_hydrate',
          priority: 'foreground',
          attachRequestId: expect.any(String),
        }))
      })
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)
    })

    it('uses keepalive_delta when a live terminal re-runs the attach effect above the rendered high-water mark', async () => {
      const { rerender, store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-keepalive-intent',
        clearSends: false,
      })

      const initialAttachRequestId = latestAttachRequestIdForTerminal(terminalId)
      expect(initialAttachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: initialAttachRequestId,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      })

      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('abc')

      wsMocks.send.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={{
                ...readPaneContent()!,
                createRequestId: 'req-v2-keepalive-intent-rerun',
              }}
            />
          </Provider>,
        )
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 3,
          intent: 'keepalive_delta',
          attachRequestId: expect.any(String),
        }))
      })
    })

    it('uses max(persisted cursor, in-memory sequence) for reconnect attach requests', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-max-cursor': {
          seq: 8,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-max-cursor' })

      // Contiguous frames up to the in-memory high-water mark: an
      // unexplained forward sequence jump is an implicit gap under the
      // restore contract (the applied cursor pins below the hole and the
      // reconnect correctly falls back to a full hydrate), so the
      // in-memory sequence must be reached honestly.
      for (let seq = 1; seq <= 8; seq += 1) {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: seq, seqEnd: seq, data: 'x' })
      }
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 9, seqEnd: 10, data: 'ij' })
      wsMocks.send.mockClear()

      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 10,
        attachRequestId: expect.any(String),
      }))
    })

    it('keeps reconnect attach at zero during remount hydration until a rendered surface is trusted', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-reconnect-during-hydration': {
          seq: 11,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-reconnect-during-hydration',
      })

      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('does not trust persisted high-water when reconnect starts before viewport replay renders', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-overlapping-attach-ready': {
          seq: 12,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-overlapping-attach-ready',
      })

      // Simulate a reconnect attach racing ahead of the first viewport replay.
      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
      const reconnectAttachRequestId = latestAttachRequestIdForTerminal(terminalId)

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 12,
          replayFromSeq: 1,
          replayToSeq: 12,
          attachRequestId: reconnectAttachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'history-1',
          attachRequestId: reconnectAttachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 6,
          seqEnd: 6,
          data: 'history-6',
          attachRequestId: reconnectAttachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 12,
          seqEnd: 12,
          data: 'history-12',
          attachRequestId: reconnectAttachRequestId,
        })
      })

      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('history-1')
      expect(writes).toContain('history-6')
      expect(writes).toContain('history-12')
    })

    it('uses rendered replay high-water when persisted cursor is ahead of a fresh hydrate', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-seq-reset': {
          seq: 12,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-seq-reset' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('abc')

      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 3,
        attachRequestId: expect.any(String),
      }))
    })

    it('ignores overlapping output ranges and keeps forward-only rendering', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-overlap' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'first' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'overlap' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 2, data: 'second' })

      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('first')
      expect(writes).toContain('second')
      expect(writes).not.toContain('overlap')
    })

    it('renders replay_window_exceeded banner during viewport_hydrate attach generation', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hydrate-gap',
        clearSends: false,
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      term.write.mockClear()
      messageHandler!({
        type: 'terminal.output.gap',
        terminalId,
        fromSeq: 1,
        toSeq: 50,
        reason: 'replay_window_exceeded',
        attachRequestId: attach!.attachRequestId,
      } as any)

      expectTerminalWriteContaining(term, 'Output gap 1-50: reconnect window exceeded')

      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('does not cap OpenCode viewport hydration replay for restored running terminals', async () => {
      const { terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-opencode-restored',
        mode: 'opencode',
        clearSends: false,
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

      expect(attach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })
      expect(attach).not.toHaveProperty('maxReplayBytes')
    })

    it('revealing an untrusted hidden running pane sends a viewport attach with sinceSeq=0', async () => {
      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-bootstrap-gap',
        hidden: true,
        clearSends: false,
      })

      wsMocks.send.mockClear()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      let attach: any
      await waitFor(() => {
        attach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(attach).toBeTruthy()
      })
      expect(attach?.sinceSeq).toBe(0)
      expect(attach?.attachRequestId).toBeTruthy()
    })

    it('revealing a trusted hidden running pane reconnects from rendered high-water without clearing', async () => {
      const { store, tabId, paneId, terminalId, rerender, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-warm-reveal-rendered',
        clearSends: false,
      })

      const initialAttachRequestId = latestAttachRequestIdForTerminal(terminalId)
      expect(initialAttachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: initialAttachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 3,
          data: 'rendered-before-hide',
          attachRequestId: initialAttachRequestId,
        })
      })

      expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).toContain('rendered-before-hide')
      wsMocks.send.mockClear()
      term.clear.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }
      const renderVisibility = (isHidden: boolean) => (
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()!} hidden={isHidden} />
        </Provider>
      )

      rerender(
        renderVisibility(true),
      )
      reconnectHandler?.()

      rerender(
        renderVisibility(false),
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'transport_reconnect',
          sinceSeq: 3,
          priority: 'foreground',
          attachRequestId: expect.any(String),
        }))
      })
      expect(term.clear).not.toHaveBeenCalled()
    })

    it('background hydrates a trusted hidden reconnect from rendered high-water with background priority', async () => {
      const { store, tabId, paneId, terminalId, rerender, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-background-rendered',
        clearSends: false,
      })

      const initialAttachRequestId = latestAttachRequestIdForTerminal(terminalId)
      expect(initialAttachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: initialAttachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 3,
          data: 'rendered-before-background',
          attachRequestId: initialAttachRequestId,
        })
      })

      expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).toContain('rendered-before-background')
      wsMocks.send.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }
      rerender(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()!} hidden />
        </Provider>,
      )

      act(() => {
        reconnectHandler?.()
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'keepalive_delta',
          sinceSeq: 3,
          priority: 'background',
          attachRequestId: expect.any(String),
        }))
      })
    })

    it('keeps a restored OpenCode pane alive when visible viewport hydration cannot replay startup output (no auto-kill)', async () => {
      const sessionRef = { provider: 'opencode', sessionId: 'ses_focus_replay_gap' } as const

      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-opencode-focus-gap',
        mode: 'opencode',
        hidden: true,
        clearSends: false,
        requestId: 'req-opencode-focus-gap',
        sessionRef,
      })

      wsMocks.send.mockClear()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )
      // The hidden→visible rerender recreates the xterm surface — assert on
      // the live instance.
      const term = terminalInstances[terminalInstances.length - 1]
      term.write.mockClear()

      let attach: any
      await waitFor(() => {
        attach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(attach?.attachRequestId).toBeTruthy()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 120,
          replayFromSeq: 42,
          replayToSeq: 120,
          attachRequestId: attach.attachRequestId,
        })
      })
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 41,
          reason: 'replay_window_exceeded',
          attachRequestId: attach.attachRequestId,
        } as any)
      })

      // Retention loss NEVER kills or replaces a healthy process
      // (responsive-terminal-restore WS2): the old auto-kill path is removed
      // entirely — honest notice, unchanged identity, live output continues.
      expect(wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.kill')).toBe(false)
      expect(wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.create')).toBe(false)
      expect(terminalWriteStrings(term).some((entry) => entry.includes('Restarting OpenCode'))).toBe(false)

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 42,
          seqEnd: 45,
          data: 'LIVE TAIL',
          attachRequestId: attach.attachRequestId,
        })
      })
      expectTerminalWriteContaining(term, 'LIVE TAIL')

      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.terminalId).toBe(terminalId)
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.status).toBe('running')
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.sessionRef).toEqual(sessionRef)
    })

    it('keeps a hidden restored OpenCode pane alive when background hydration cannot replay startup output (no auto-kill)', async () => {
      const sessionRef = { provider: 'opencode', sessionId: 'ses_hidden_replay_gap' } as const

      const { store, tabId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-opencode-hidden-gap',
        mode: 'opencode',
        hidden: true,
        clearSends: false,
        requestId: 'req-opencode-hidden-gap',
        sessionRef,
      })

      wsMocks.send.mockClear()
      term.write.mockClear()
      act(() => {
        getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
      })

      let attach: any
      await waitFor(() => {
        attach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) =>
            msg?.type === 'terminal.attach'
            && msg?.terminalId === terminalId
            && msg?.intent === 'keepalive_delta'
            && msg?.priority === 'background'
          )
        expect(attach?.attachRequestId).toBeTruthy()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 120,
          replayFromSeq: 42,
          replayToSeq: 120,
          attachRequestId: attach.attachRequestId,
        })
      })
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 41,
          reason: 'replay_window_exceeded',
          attachRequestId: attach.attachRequestId,
        } as any)
      })

      // The hidden background hydrate gets the same honest treatment: no
      // kill, no replacement spawn, identity intact, live output continues.
      expect(wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.kill')).toBe(false)
      expect(wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.create')).toBe(false)
      expectTerminalWriteContaining(term, 'Output gap 1-41: reconnect window exceeded')

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 42,
          seqEnd: 45,
          data: 'HIDDEN LIVE TAIL',
          attachRequestId: attach.attachRequestId,
        })
      })
      expectTerminalWriteContaining(term, 'HIDDEN LIVE TAIL')

      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.terminalId).toBe(terminalId)
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.status).toBe('running')
    })

    it('a pane hidden at mount hydrates in background with a geometry-neutral keepalive attach', async () => {
      const { terminalId, tabId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hidden-mount-geo-neutral',
        hidden: true,
        clearSends: false,
        requestId: 'req-hidden-mount-geo-neutral',
      })

      wsMocks.send.mockClear()
      act(() => {
        getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
      })

      await waitFor(() => {
        const attach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(attach, 'background hydration must send an attach').toBeTruthy()
        expect(attach.intent).toBe('keepalive_delta')
        expect(attach.priority).toBe('background')
        expect(attach.sinceSeq).toBe(0)
        expect(attach.cols).toBeGreaterThan(0)
        expect(attach.rows).toBeGreaterThan(0)
      })
      expect(
        wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.intent === 'viewport_hydrate'),
      ).toBe(false)
    })

    it('reveal after a clamped hidden attach emits terminal.resize even when fitted dims are unchanged', async () => {
      // Mounting hidden + hydration trigger produces, PRE-FIX, a wire
      // viewport_hydrate attach whose dims are the never-fitted xterm defaults —
      // the same numeric dims the reveal-fit will compute in jsdom (stable
      // fixture) — so the reveal resize is swallowed by matchesLastSentViewport
      // pre-fix. Post-fix the clamped attach invalidates the suppression record
      // and the resize is emitted. This is the RED witness for the heal path.
      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hidden-heal-suppression',
        hidden: true,
        clearSends: false,
        requestId: 'req-hidden-heal-suppression',
      })

      wsMocks.send.mockClear()
      act(() => {
        getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
      })
      let hydrationAttach: any
      await waitFor(() => {
        hydrationAttach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.intent === 'keepalive_delta')
        expect(hydrationAttach, 'clamped background attach must be geometry-neutral').toBeTruthy()
      })

      // Complete the clamped hydration so the pane is live before the reveal;
      // reveal must then heal via resize alone (no new attach generation).
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: hydrationAttach.attachRequestId,
        })
      })

      wsMocks.send.mockClear()
      // Flip visibility on the SAME mounted component: rerendering with
      // TerminalViewFromStore would swap the component type at the same JSX
      // position, remounting the pane and legitimately producing a fresh
      // foreground hydrate attach instead of the heal resize this test pins.
      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }
      rerender(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()!} hidden={false} />
        </Provider>,
      )

      await waitFor(() => {
        expect(
          wsMocks.send.mock.calls
            .map(([msg]) => msg)
            .some((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId),
        ).toBe(true)
      })
      // No NEW attach on reveal (deferred mode is 'live'); the resize is the heal.
      expect(
        wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach'),
      ).toHaveLength(0)
    })

    it('clamped hidden attaches keep viewport_hydrate surface-reset bookkeeping across replay generations', async () => {
      // Both hidden attach generations must reset the mocked surface
      // (term.clear) and replay only their own seq window — proof that client
      // bookkeeping kept viewport_hydrate semantics under the wire keepalive
      // token. A bookkeeping-degraded implementation (deriving clear/replay
      // from the wire intent) skips the clear branch and FAILS this test.
      //
      // The second generation is forced via a pane refresh — the production
      // re-arm path for a hidden pane (runRefreshAttach ->
      // registerForBackgroundHydration({ queueIfStarted: true })) — because
      // the hydration queue's onActiveTabReady is one-shot per queue
      // instance, so calling it again cannot pump a second attach. The
      // surface checkpoint saved by generation 1's parser-applied replay is
      // reset so generation 2 takes the same full-hydrate branch a fresh
      // profile takes, matching the plan's clamped-full-replay shape.
      const { store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hidden-clamped-replay',
        hidden: true,
        clearSends: false,
        requestId: 'req-hidden-clamped-replay',
      })

      term.write.mockClear()
      term.clear.mockClear()
      wsMocks.send.mockClear()

      act(() => {
        getHydrationQueue().onActiveTabReady('tab-visible-neighbor', ['tab-visible-neighbor', tabId])
      })

      let firstAttach: any
      await waitFor(() => {
        firstAttach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(firstAttach?.attachRequestId, 'background hydration must send a first attach').toBeTruthy()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 2,
          replayFromSeq: 1,
          replayToSeq: 2,
          attachRequestId: firstAttach.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 2,
          data: 'PRIOR-SURFACE-MARKER',
          attachRequestId: firstAttach.attachRequestId,
        })
      })

      await waitFor(() => {
        expect(terminalWriteStrings(term).some((data) => data.includes('PRIOR-SURFACE-MARKER'))).toBe(true)
      })
      // First generation's clearViewportFirst viewport bookkeeping fired.
      expect(term.clear).not.toHaveBeenCalled()
      expect(reconstructionWrites(term)).toHaveLength(0)
      expect(firstAttach.surfaceReset).toBe(true)

      // Drop the checkpoint generation 1 recorded so generation 2's delta
      // decision is missing_checkpoint again (the same full-hydrate branch a
      // fresh profile takes for this shape).
      clearLocalStorageForTest()
      __resetTerminalCursorCacheForTests()

      wsMocks.send.mockClear()
      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })

      let secondAttach: any
      await waitFor(() => {
        const attaches = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        secondAttach = attaches.find((msg) => msg?.attachRequestId !== firstAttach.attachRequestId)
        expect(secondAttach?.attachRequestId, 'refresh must force a second hidden attach generation').toBeTruthy()
      })
      expect(secondAttach.priority).toBe('background')
      expect(secondAttach.sinceSeq).toBe(0)

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 3,
          replayToSeq: 6,
          attachRequestId: secondAttach.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 3,
          seqEnd: 6,
          data: 'CLAMPED-REPLAY-MARKER',
          attachRequestId: secondAttach.attachRequestId,
        })
      })

      // (a) BOTH generations cleared the surface — the second attach did not
      // degrade into keepalive bookkeeping (which skips the clear branch).
      expect(term.clear).not.toHaveBeenCalled()
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(secondAttach).toMatchObject({ intent: 'keepalive_delta', surfaceReset: true })
      // (b) Each generation replayed only its own seq window, exactly once.
      const writes = terminalWriteStrings(term)
      expect(writes.filter((data) => data.includes('PRIOR-SURFACE-MARKER'))).toHaveLength(1)
      expect(writes.filter((data) => data.includes('CLAMPED-REPLAY-MARKER'))).toHaveLength(1)
    })

    it('does not send terminal.resize when an already-live terminal is hidden and revealed with unchanged geometry', async () => {
      const { rerender, store, tabId, paneId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-no-resize',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      wsMocks.send.mockClear()
      runtime!.fit.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        expect(runtime!.fit).toHaveBeenCalled()
      })

      const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
      expect(sent.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
      expect(sent.filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)
    })

    it('does not send terminal.resize when a create-path terminal is already-live before a same-geometry reveal', async () => {
      const { rerender, store, tabId, paneId, requestId } = await renderTerminalHarness({
        status: 'creating',
        requestId: 'req-live-reveal-created',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId,
          terminalId: 'term-live-reveal-created',
          createdAt: Date.now(),
        })
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .reverse()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-live-reveal-created')
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-live-reveal-created',
          headSeq: attach?.sinceSeq ?? 0,
          replayFromSeq: (attach?.sinceSeq ?? 0) + 1,
          replayToSeq: attach?.sinceSeq ?? 0,
          attachRequestId: attach.attachRequestId,
        })
      })

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      wsMocks.send.mockClear()
      runtime!.fit.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        expect(runtime!.fit).toHaveBeenCalled()
      })

      const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
      expect(sent.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-live-reveal-created')).toHaveLength(0)
      expect(sent.filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === 'term-live-reveal-created')).toHaveLength(0)
    })

    it('sends exactly one terminal.resize when an already-live terminal is revealed after geometry changes', async () => {
      const { rerender, store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-real-resize',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      runtime!.fit.mockImplementation(() => {
        term.cols = 132
        term.rows = 40
      })

      wsMocks.send.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        const resizeCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)
        expect(resizeCalls).toHaveLength(1)
      })
    })

    it('evicts cached viewport entries when a terminal exits', async () => {
      const { terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-cache-evict',
        clearSends: false,
      })

      expect(__getLastSentViewportCacheSizeForTests()).toBe(1)

      act(() => {
        messageHandler!({
          type: 'terminal.exit',
          terminalId,
          exitCode: 0,
        })
      })

      expect(__getLastSentViewportCacheSizeForTests()).toBe(0)
    })

    it('bounds cached viewport entries to the most recent terminals', async () => {
      for (let index = 0; index < 205; index += 1) {
        const { unmount } = await renderTerminalHarness({
          status: 'running',
          terminalId: `term-live-reveal-cache-bound-${index}`,
          clearSends: false,
        })
        unmount()
      }

      expect(__getLastSentViewportCacheSizeForTests()).toBe(200)
    })

    it('renders terminal.output.gap marker and fails closed for subsequent attach', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-gap' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      wsMocks.send.mockClear()

      messageHandler!({
        type: 'terminal.output.gap',
        terminalId,
        fromSeq: 2,
        toSeq: 5,
        reason: 'queue_overflow',
      })

      expectTerminalWriteContaining(term, 'Output gap 2-5: slow link backlog')

      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('treats an unexplained forward sequence jump as an implicit gap, never a silent cursor advance', async () => {
      // Restore contract (responsive-terminal-restore): an incoming frame
      // beyond the expected next sequence, with NO gap frame received,
      // must not silently advance the applied cursor across the missing
      // instructions. The hole is an implicit gap: the surface is
      // quarantined (observable, applied cursor pinned below the hole) and
      // an honest local notice names the exact lost range. The jumped
      // frame's real data still renders.
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-implicit-gap',
      })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()

      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 6, seqEnd: 8, data: 'JUMPED' })
      })

      expectTerminalWriteContaining(term, 'Output gap 2-5: unexplained sequence jump')
      expectTerminalWriteContaining(term, 'JUMPED')
      expect(bridge.snapshot().perfEvents).toContainEqual(expect.objectContaining({
        event: 'terminal.catchup.surface_quarantined',
        terminalId,
        fromSeq: 2,
        toSeq: 5,
        reason: 'implicit_sequence_jump',
      }))
    })

    it('does not flag a session start at attach.ready’s effective from-seq as an implicit gap', async () => {
      // A ready whose replay window starts beyond the cursor is a
      // legitimate session start (a retention-adjusted resume): the first
      // frame AT the window's from-seq is the server-declared baseline —
      // no implicit-gap notice, no quarantine.
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-implicit-gap-exempt',
      })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 30,
          replayFromSeq: 20,
          replayToSeq: 30,
          attachRequestId: latestAttachRequestIdForTerminal(terminalId),
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 20, seqEnd: 22, data: 'RESUMED' })
      })

      const writes = term.write.mock.calls.map(([data]) => String(data)).join('')
      expect(writes).not.toContain('unexplained sequence jump')
      expect(writes).toContain('RESUMED')
    })

    it('a negotiated queue_overflow gap repairs from the surface checkpoint cursor without destroying the surface', async () => {
      // The negotiated lane (pacedTerminalReplayV1): the spill gap is
      // repairable delivery loss — the shared restore contract requires
      // "repair from retained output", initiated on the SAME connection
      // (no transport flap). The ring retained the spilled range, so the
      // repair RESUMES from the surface checkpoint cursor (the
      // checkpoint-aware delta resume): a delta attach refills the
      // visible surface without clearing it — never a sinceSeq:0
      // viewport wipe that would destroy the pre-gap surface before a
      // replacement baseline exists. The old-server lane (no capability)
      // keeps its local-notice-only behavior — pinned by the test above.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair',
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A contiguous applied prefix establishes a valid surface
      // checkpoint (streamId stamped by the ready).
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      term.clear.mockClear()
      wsMocks.send.mockClear()
      expect(repairAttaches()).toEqual([])

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })

      // No reconnect handler is invoked anywhere in this test: the repair
      // attach must be emitted by the gap arm itself, on the open socket.
      expect(reconnectHandler).not.toBeNull()
      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'transport_reconnect',
        sinceSeq: 1,
        attachRequestId: expect.any(String),
      })
      // The pre-gap surface is PRESERVED: the repair never clears the
      // viewport before its content establishes the refilled surface.
      expect(term.clear).not.toHaveBeenCalled()
      // The honest notice still shows alongside the repair — in CHROME
      // (round-5 finding 2): the surface never receives notice bytes.
      const notice = screen.getByTestId('restore-delivery-gap-notice')
      expect(notice.textContent).toContain('output gap 2-5')
      expect(notice.textContent).toContain('slow link backlog')
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap')),
        'the notice is chrome, never surface bytes',
      ).toBe(false)

      // The repair completes: the new generation's ready + frames refill
      // the hole and converge the screen on the SAME connection, with no
      // retry strip.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 2,
          replayToSeq: 8,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 8,
          data: 'REPAIRED',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      expectTerminalWriteContaining(term, 'REPAIRED')
      expect(term.clear).not.toHaveBeenCalled()
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('a queue_overflow repair answered by expired retention takes the honest-loss path, never a destructive rebuild', async () => {
      // The retained ring may have expired past the checkpoint cursor by
      // the time the repair's delta attach lands. The server answers with
      // the bounds-carrying retention gap: the EXISTING honest-loss UX
      // applies (the accessible retention notice, live output continuing)
      // — the pre-gap surface is never destroyed, and the retention gap
      // never re-triggers the queue_overflow repair loop.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-expired',
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      for (let seq = 1; seq <= 8; seq += 1) {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: seq, seqEnd: seq, data: `row${seq}` })
      }
      term.write.mockClear()
      term.clear.mockClear()
      wsMocks.send.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 9,
          toSeq: 12,
          reason: 'queue_overflow',
        })
      })

      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'transport_reconnect',
        sinceSeq: 8,
        attachRequestId: expect.any(String),
      })

      // The server's answer: retention expired past the cursor — the
      // bounds-carrying retention gap, then live frames from the
      // retained front.
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 9,
          toSeq: 20,
          reason: 'replay_window_exceeded',
          headSeq: 24,
          oldestRetainedSeq: 21,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 21,
          seqEnd: 24,
          data: 'FROMFRONT',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })

      // The honest-loss UX: the accessible retention notice shows, live
      // output continues, and the surface is NEVER destroyed.
      expect(screen.getByTestId('restore-retention-loss-notice')).toBeTruthy()
      expectTerminalWriteContaining(term, 'FROMFRONT')
      expect(term.clear).not.toHaveBeenCalled()
      // The retention gap does NOT initiate another repair (its reason is
      // replay_window_exceeded, not queue_overflow): no repair loop.
      expect(repairAttaches().length).toBe(1)
    })

    it.each([false, true])('a queue_overflow gap with no valid checkpoint falls back to a full hydrate that never clears before content (replacement retention loss=%s)', async (retentionLost) => {
      // No valid checkpoint exists (no streamId was ever established):
      // the repair may fall back to a full hydrate — but the viewport is
      // NOT cleared before the new baseline is actually established by
      // attach content. If the repair dies before content, the pre-gap
      // surface stays visible; when the hydrate's content arrives, it
      // replaces the surface at that moment.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-no-checkpoint',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      term.clear.mockClear()
      wsMocks.send.mockClear()
      // Honest-async frames (round-4): the flush timing is REAL from here
      // on — the clear and the content apply at flush time, never
      // synchronously inside the message handler.
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      await flushFrames()

      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      })
      // The pre-gap surface is PRESERVED at attach time: the fallback
      // hydrate must not clear the viewport before its content arrives.
      expect(term.clear).not.toHaveBeenCalled()
      // The honest notice shows in CHROME (round-5 finding 2): no notice
      // bytes may touch the surface ahead of the replacement content.
      const notice = screen.getByTestId('restore-delivery-gap-notice')
      expect(notice.textContent).toContain('output gap 2-5')
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap')),
        'the notice is chrome, never surface bytes',
      ).toBe(false)

      // Hold the actual reset completion: authorizing a reconstruction is
      // separate from completing it and receiving the replacement replay.
      term.deferWrites = true

      // Accepted probe content authorizes the ordered reset. The replacement
      // attach requests that content again after the reset completes.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 1,
          replayToSeq: 8,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 8,
          data: 'REBUILT',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      // Before the ordered reconstruction flush, the pre-gap surface remains
      // intact and no replacement content has been applied.
      expect(term.clear).not.toHaveBeenCalled()
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('REBUILT')),
      ).toBe(false)
      await flushFrames()
      await flushFrames()
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.pendingWriteCallbacks).toHaveLength(1)
      expect(repairAttaches()).toHaveLength(1)
      expect(screen.getByTestId('restore-delivery-gap-notice').textContent).toContain('output gap 2-5')
      expect(term.clear).not.toHaveBeenCalled()
      expect(terminalWriteStrings(term)).not.toContain('REBUILT')
      act(() => { term.releasePendingWrites() })
      await flushFrames()
      expect(repairAttaches()).toHaveLength(2)
      // The second attach belongs to the same repair. Its empty reset surface
      // must retain the honest notice while the server replay is outstanding.
      expect(screen.getByTestId('restore-delivery-gap-notice').textContent).toContain('output gap 2-5')
      const replacement = repairAttaches().at(-1)!
      if (retentionLost) {
        // Retention can expire between the probe and replacement attach.
        // Its authoritative notice must replace the preserved delivery notice.
        act(() => {
          messageHandler!({ type: 'terminal.attach.ready', terminalId, attachRequestId: replacement.attachRequestId, headSeq: 8, replayFromSeq: 1, replayToSeq: 8 })
          messageHandler!({ type: 'terminal.output.gap', terminalId, attachRequestId: replacement.attachRequestId, fromSeq: 1, toSeq: 3, reason: 'replay_window_exceeded', headSeq: 8, oldestRetainedSeq: 4 })
          messageHandler!({ type: 'terminal.output', terminalId, attachRequestId: replacement.attachRequestId, seqStart: 4, seqEnd: 8, data: 'RETAINED', source: 'replay' })
        })
      } else {
        replayReconstructedSurface(terminalId, repair[0]!.attachRequestId, 8, 'REBUILT')
      }
      await flushFrames()
      expectTerminalWriteContaining(term, retentionLost ? 'RETAINED' : 'REBUILT')
      expect(term.pendingWriteCallbacks).toHaveLength(1)
      act(() => { term.releasePendingWrites() })
      await flushFrames()
      expect(sentMessages().filter(msg => msg?.type === 'terminal.replay.credit').at(-1)).toMatchObject({ terminalId, attachRequestId: replacement.attachRequestId, consumedSeq: 8 })
      if (retentionLost) {
        expect(screen.queryByTestId('restore-delivery-gap-notice')).toBeNull()
        expect(screen.getByTestId('restore-retention-loss-notice')).toHaveAttribute('role', 'status')
      } else {
        expect(screen.getByTestId('restore-delivery-gap-notice').textContent).toContain('output gap 2-5')
      }
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(terminalWriteStrings(term).some((entry) => entry.includes('Output gap'))).toBe(false)
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('a no-checkpoint repair answered by expired retention disarms the deferred clear — the pre-gap surface is preserved', async () => {
      // Round-2 fix: the deferred content reset must NOT survive a
      // server-declared unreconstructible prefix. When the no-checkpoint
      // repair hydrate is answered by a replay_window_exceeded gap (the
      // retained history expired past the requested baseline), the
      // server has just declared that the missing prefix CANNOT be
      // rebuilt — the pre-gap screen is the best available surface and
      // the pending clear must be DISARMED, so the retained suffix
      // appends after the honest-loss UX instead of wiping the screen
      // mid-restore.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-disarm',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A usable pre-gap surface: real content on screen, no streamId —
      // no valid checkpoint exists for the repair decision.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'PRE-GAP-VISIBLE' })
      term.clear.mockClear()
      wsMocks.send.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })

      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      })

      // The server's answer: retention expired past the requested
      // baseline. The ready declares the retention reset (the baseline
      // adjusted to the ring front), the bounds-carrying gap declares
      // the prefix unreconstructible, and the retained suffix follows.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 24,
          replayFromSeq: 21,
          replayToSeq: 24,
          attachRequestId: repair[0]!.attachRequestId,
          effectiveSinceSeq: 20,
          requestedSinceSeq: 0,
          oldestRetainedSeq: 21,
          replayResetReason: 'retention_lost',
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 20,
          reason: 'replay_window_exceeded',
          headSeq: 24,
          oldestRetainedSeq: 21,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 21,
          seqEnd: 24,
          data: 'RETAINED-SUFFIX',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })

      // THE DISARM: the pending deferred clear was consumed by the
      // retention gap, so the arriving suffix content does NOT wipe the
      // screen — the pre-gap content survives on the surface and the
      // suffix appends after the honest-loss UX.
      expect(term.clear).not.toHaveBeenCalled()
      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('PRE-GAP-VISIBLE')
      expect(writes).toContain('RETAINED-SUFFIX')
      expect(
        writes.indexOf('PRE-GAP-VISIBLE'),
        'the pre-gap content precedes the retained suffix on the surface',
      ).toBeLessThan(writes.lastIndexOf('RETAINED-SUFFIX'))
      expect(screen.getByTestId('restore-retention-loss-notice')).toBeTruthy()
      // The retention gap does NOT initiate another repair (its reason is
      // replay_window_exceeded, not queue_overflow): no repair loop.
      expect(repairAttaches().length).toBe(1)
    })

    it('a fully filtered first repair frame does not consume the deferred clear — the next writing frame clears-then-writes', async () => {
      // Round-3 fix: the deferred viewport clear must consume ONLY when
      // replacement content ACTUALLY renders — after sequence acceptance
      // AND when the frame's write path will write bytes to xterm. A first
      // frame consisting ENTIRELY of an OSC52 clipboard sequence is
      // accepted by sequence validation but fully consumed by the OSC52
      // pre-parser: no byte reaches xterm, so it must NOT consume the
      // clear. The pre-gap surface survives, the clear stays armed, and
      // the NEXT frame that will write bytes clears-then-writes.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-filtered-first',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A usable pre-gap surface: real content on screen, no streamId —
      // no valid checkpoint exists for the repair decision.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'PRE-GAP-VISIBLE' })
      term.clear.mockClear()
      wsMocks.send.mockClear()
      // Honest-async frames (round-4): real flush timing from here on.
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      await flushFrames()

      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })
      expect(term.clear).not.toHaveBeenCalled()

      // The hydrate answers: a replay window, then a first frame that is
      // ENTIRELY an OSC52 sequence (fully filtered — no xterm write).
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 1,
          replayToSeq: 8,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 8,
          data: '\x1b]52;c;RklMVEVSLU9OTFk=\x07',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      await flushFrames()

      // The filtered frame rendered NOTHING: the clear must NOT have been
      // consumed, and the pre-gap surface is still the last thing written.
      expect(term.clear).not.toHaveBeenCalled()
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('52;c;')),
        'the OSC52-only frame wrote no bytes to xterm',
      ).toBe(false)
      expectTerminalWriteContaining(term, 'PRE-GAP-VISIBLE')

      // The next accepted rendering frame authorizes the ordered reset.
      // Replacement content comes from the new full attach after that boundary.
      const clearCallsBefore = term.clear.mock.calls.length
      expect(clearCallsBefore).toBe(0)
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 9,
          seqEnd: 12,
          data: 'REBUILT-LATE',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      // BEFORE the flush: the clear+write is queued, nothing applied.
      expect(term.clear).not.toHaveBeenCalled()
      await flushFrames()
      await flushFrames()
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.clear).not.toHaveBeenCalled()
      expect(terminalWriteStrings(term)).not.toContain('REBUILT-LATE')
      replayReconstructedSurface(terminalId, repair[0]!.attachRequestId, 12, 'REBUILT-LATE')
      await flushFrames()
      expectTerminalWriteContaining(term, 'REBUILT-LATE')
      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(
        writes.indexOf('REBUILT-LATE'),
        'the replacement content renders after the clear',
      ).toBeGreaterThan(writes.lastIndexOf('PRE-GAP-VISIBLE'))
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('a rejected duplicate first repair frame does not consume the deferred clear', async () => {
      // Round-3 fix: a frame the sequence validator REJECTS (duplicate /
      // overlap) must not consume the deferred clear either — the surface
      // is preserved until a frame that actually renders replaces it.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-dup-first',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'PRE-GAP-VISIBLE' })
      term.clear.mockClear()
      wsMocks.send.mockClear()
      // Honest-async frames (round-4): real flush timing from here on.
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      await flushFrames()

      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })

      // The hydrate answers with an EMPTY replay window already covered
      // up to head 8 (the ready folds the high-water cursor), so a first
      // frame re-covering 1..8 is a REJECTED duplicate/overlap.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 0,
          replayToSeq: 0,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 8,
          data: 'STALE-DUPLICATE',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      await flushFrames()

      // The duplicate was rejected: nothing rendered, nothing consumed.
      expect(term.clear).not.toHaveBeenCalled()
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('STALE-DUPLICATE')),
        'the rejected duplicate never reaches xterm',
      ).toBe(false)
      expectTerminalWriteContaining(term, 'PRE-GAP-VISIBLE')

      // The clear is still armed: the next accepted writing frame
      // clears-then-writes (applied at flush time as ONE atomic unit).
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 9,
          seqEnd: 10,
          data: 'REBUILT-LATE',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      // BEFORE the flush: the clear+write is queued, nothing applied.
      expect(term.clear).not.toHaveBeenCalled()
      await flushFrames()
      await flushFrames()
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.clear).not.toHaveBeenCalled()
      expect(terminalWriteStrings(term)).not.toContain('REBUILT-LATE')
      replayReconstructedSurface(terminalId, repair[0]!.attachRequestId, 10, 'REBUILT-LATE')
      await flushFrames()
      expectTerminalWriteContaining(term, 'REBUILT-LATE')
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('a repair abandoned before reset submission preserves the OLD surface and drops replacement content', async () => {
      // Round-4 F2 race (a), REAL async scheduling: the deferred clear is
      // armed and the first replacement content enqueued, then a
      // superseding attach lands BEFORE the animation-frame flush runs.
      // The clear and the queued replacement write must drop TOGETHER
      // (one generation-guarded queue item): a synchronous clear ahead
      // of the write queue wipes the surface and the supersede then
      // discards the replacement — the pre-gap content is gone forever.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term, store } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-clear-atomic-supersede',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A usable pre-gap surface (flushed under the default synchronous
      // frame scheduling), then the frames go DEFERRED: the rest of the
      // test runs with real flush timing under the test's control.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'PRE-GAP-VISIBLE' })
      term.clear.mockClear()
      wsMocks.send.mockClear()
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      // The gap arms the deferred clear (the no-checkpoint fallback) and
      // the first replacement content ENQUEUES the clear+write — nothing
      // has flushed yet.
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 5,
          data: 'REPLACEMENT-BASE',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      // The clear+write is QUEUED, not applied: with honest async
      // scheduling NOTHING has hit xterm yet.
      expect(term.clear).not.toHaveBeenCalled()
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('REPLACEMENT-BASE')),
      ).toBe(false)

      // THE SUPERSEDE: a further gap starts a NEW repair generation
      // before the flush runs — the queued generation is dropped
      // wholesale.
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 6,
          toSeq: 8,
          reason: 'queue_overflow',
        })
      })
      expect(repairAttaches().length).toBe(1)
      // The old gap cannot create an attach through the local-ticket fence.
      // Losing transport eligibility abandons the queued reset before it runs.
      act(() => { store.dispatch(setConnectionStatus('disconnected')) })

      // Now the flush runs: the dropped generation's clear AND write are
      // gone together — the OLD surface survives intact.
      await flushFrames()
      expect(term.clear).not.toHaveBeenCalled()
      expect(reconstructionWrites(term)).toHaveLength(0)
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('REPLACEMENT-BASE')),
        'the abandoned replacement never mutates the surface',
      ).toBe(false)
      expectTerminalWriteContaining(term, 'PRE-GAP-VISIBLE')
    })

    it('the queue-overflow gap notice rides chrome across the repair attach and never mutates the surface', async () => {
      // Round-4 F4 + round-5 finding 2 (Major): the delivery-loss gap's
      // honest notice must SURVIVE the repair attach that fires in the
      // same message handler — and it must do so WITHOUT writing to the
      // xterm surface: during a checkpoint-based delta repair NOTHING may
      // mutate the surface before the replayed bytes apply (the notice's
      // local bytes would shift the cursor/parser state the checkpoint
      // captured, corrupting the repaired screen). The notice therefore
      // rides UI chrome (React state is immune to the repair attach's
      // generation change, which drops queued stale WRITES, not state).
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term, getByTestId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-notice-survives-repair',
      })

      // A contiguous applied prefix establishes a valid checkpoint, so
      // the repair is a DELTA resume.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      wsMocks.send.mockClear()
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      // The gap and its repair attach fire in ONE synchronous handler
      // run; the flush happens only afterwards.
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      const repairAttaches = sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )
      expect(repairAttaches.length).toBe(1)

      // Nothing has rendered yet (real async): the surface is untouched.
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap 2-5')),
        'the notice must never be surface bytes',
      ).toBe(false)

      // THE ASSERTION: the notice is honestly shown DESPITE the repair
      // attach's generation change — in chrome, visible and accessible.
      await flushFrames()
      const notice = getByTestId('restore-delivery-gap-notice')
      expect(notice).toHaveAttribute('role', 'status')
      expect(notice.textContent).toContain('output gap 2-5')
      expect(notice.textContent).toContain('slow link backlog')
      // And the surface STILL has no notice bytes — only the stream.
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap')),
        'the notice lives in chrome, never in the surface',
      ).toBe(false)
    })

    it('a checkpoint delivery-gap repair with an in-flight escape sequence replays the exact uninterrupted byte stream', async () => {
      // Round-5 finding 2 (Major), the reviewer's required shape: frame 2
      // ends MID truecolor-SGR escape sequence (the sequence's first half
      // is held by the client's probe parser, bridged to the completing
      // bytes of the NEXT frame); the queue_overflow gap folds exactly the
      // frames that complete it; the checkpoint delta repair replays them
      // onto the surface. The repaired surface's byte stream must EQUAL
      // the uninterrupted reference byte stream exactly (a content
      // comparison against an uninterrupted lane driven through the same
      // production code) — the pre-fix notice bytes, written to the
      // surface between the checkpoint state and the replayed bytes,
      // shifted the cursor the replayed instructions were addressed to and
      // corrupted the repaired screen.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }

      // The deterministic fixture: frame 2 is a truecolor SGR's first
      // half split at the frame boundary (the probe parser holds it until
      // frame 3 completes it), so the escape is IN FLIGHT exactly at the
      // checkpoint cursor when the gap lands, and the repair replays both
      // halves. Both lanes' surfaces must receive the identical byte
      // stream.
      const frame1Data = 'ok'
      const frame2Data = '\x1b[38;2;'
      const frame3Data = '255;0;0mREPAIRED-TAIL'

      const pendingFrames: FrameRequestCallback[] = []
      const deferFlushes = () => {
        requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
          pendingFrames.push(cb)
          return pendingFrames.length
        })
      }
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      // LANE A — the uninterrupted reference: frames 1..3 applied
      // contiguously, no gap, no repair.
      const laneA = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-repair-reference-lane',
      })
      deferFlushes()
      messageHandler!({ type: 'terminal.output', terminalId: laneA.terminalId, seqStart: 1, seqEnd: 1, data: frame1Data })
      messageHandler!({ type: 'terminal.output', terminalId: laneA.terminalId, seqStart: 2, seqEnd: 2, data: frame2Data })
      await flushFrames()
      expect(terminalWriteStrings(laneA.term).join('')).toBe(frame1Data)
      // Align the comparison point: from here on, both lanes' write
      // mocks observe only the bytes that follow the in-flight escape's
      // first half.
      laneA.term.write.mockClear()
      messageHandler!({ type: 'terminal.output', terminalId: laneA.terminalId, seqStart: 3, seqEnd: 3, data: frame3Data })
      await flushFrames()
      const referenceStream = frame1Data + terminalWriteStrings(laneA.term).join('')
      expect(referenceStream).toBe(frame1Data + frame2Data + frame3Data)

      // LANE B — the gapped repair: frames 1..2 applied live (frame 2
      // submits nothing — its partial escape is held in flight), the gap
      // folds 3, the checkpoint repair replays exactly the completing
      // bytes.
      const laneB = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-repair-escape-lane',
      })
      const termB = laneB.term
      deferFlushes()
      messageHandler!({ type: 'terminal.output', terminalId: laneB.terminalId, seqStart: 1, seqEnd: 1, data: frame1Data })
      messageHandler!({ type: 'terminal.output', terminalId: laneB.terminalId, seqStart: 2, seqEnd: 2, data: frame2Data })
      // Flush BEFORE the gap: frame 1's write completes and pins the
      // checkpoint at the cursor where the escape is in flight.
      await flushFrames()
      expect(terminalWriteStrings(termB).join('')).toBe(frame1Data)
      termB.write.mockClear()
      wsMocks.send.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId: laneB.terminalId,
          fromSeq: 3,
          toSeq: 3,
          reason: 'queue_overflow',
        })
      })
      const repair = sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === laneB.terminalId,
      )
      expect(repair.length).toBe(1)
      // The repair is the CHECKPOINT DELTA resume (pinned at the applied
      // cursor — INSIDE the in-flight escape's span — NOT a viewport
      // rebuild): the server replays the frames that complete the escape.
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId: laneB.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      })

      // The repair converges: the retained range replays under the NEW
      // generation, completing the in-flight escape sequence.
      const repairArid = repair[0]!.attachRequestId
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: laneB.terminalId,
          headSeq: 3,
          replayFromSeq: 2,
          replayToSeq: 3,
          attachRequestId: repairArid,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId: laneB.terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: frame2Data,
          attachRequestId: repairArid,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId: laneB.terminalId,
          seqStart: 3,
          seqEnd: 3,
          data: frame3Data,
          attachRequestId: repairArid,
        })
      })
      await flushFrames()

      await flushFrames()
      expect(reconstructionWrites(termB)).toHaveLength(1)
      const resetIndex = terminalWriteStrings(termB).indexOf(MOUNTED_RECONSTRUCTION)
      replayReconstructedSurface(laneB.terminalId, repairArid, 3, frame1Data + frame2Data + frame3Data)
      await flushFrames()

      // THE CONTENT COMPARISON (not notice-presence): the repaired
      // surface received EXACTLY the uninterrupted reference byte stream —
      // byte-for-byte, in order, with the escape sequence completed
      // exactly as the uninterrupted lane parsed it. Any surface-written
      // notice (the pre-fix behavior) breaks the equality.
      const repairedStream = terminalWriteStrings(termB).slice(resetIndex + 1).join('')
      expect(repairedStream).toBe(referenceStream)
      expect(
        terminalWriteStrings(termB).some((entry) => entry.includes('Output gap')),
        'no notice bytes may ever reach the surface mid-repair',
      ).toBe(false)
    })

    it('the delivery-gap chrome notice stays visible after the repair converges despite the generation change', async () => {
      // Round-5 finding 2, the notice-survival requirement in its full
      // cycle: the honest notice becomes visible (and STAYS visible)
      // post-repair — the repair attach minted a new generation, but the
      // chrome notice is React state, so the generation change cannot
      // discard it, and the converged repair keeps the notice honestly on
      // screen next to the complete terminal content.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term, getByTestId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-notice-post-repair',
      })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      wsMocks.send.mockClear()
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
        })
      })
      const repair = sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )
      expect(repair.length).toBe(1)
      await flushFrames()

      // The repair CONVERGES: replay the declared range under the new
      // generation and flush.
      const repairArid = repair[0]!.attachRequestId
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 5,
          replayFromSeq: 2,
          replayToSeq: 5,
          attachRequestId: repairArid,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 5,
          data: 'REPAIRED-CONTENT',
          attachRequestId: repairArid,
        })
      })
      await flushFrames()
      expectTerminalWriteContaining(term, 'REPAIRED-CONTENT')

      // POST-REPAIR: the notice is still honestly shown (chrome) with the
      // exact gap range and reason, and the surface carries only stream
      // bytes.
      const notice = getByTestId('restore-delivery-gap-notice')
      expect(notice.textContent).toContain('output gap 2-5')
      expect(notice.textContent).toContain('slow link backlog')
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap')),
        'the converged surface is pure stream content',
      ).toBe(false)
    })

    it('a stale in-flight write completes BEFORE the clear applies — no post-clear mutation', async () => {
      // Round-4 F2 race (b), REAL async scheduling: a write is still in
      // flight (its xterm completion callback has not run) when the
      // deferred clear+replacement flush applies. The queue's serial
      // flush must apply the in-flight bytes BEFORE the clear — a
      // synchronous clear ahead of the queue wipes the surface first and
      // the in-flight bytes then mutate the blank surface AFTER the
      // clear. Round-5 finding 2: the in-flight item is now a REAL
      // stream write (the pre-fix fixture leaned on the notice write the
      // chrome fix removed) — a live frame delivered under deferred
      // writes ahead of the delivery-loss gap, so the fixture pins the
      // same atomicity contract with stream bytes only.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-clear-atomic-inflight',
        ackInitialAttach: false,
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A usable pre-gap surface, flushed under the default synchronous
      // scheduling; then BOTH the frames and the xterm write completions
      // go deferred — real async from here on.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'PRE-GAP-VISIBLE' })
      term.clear.mockClear()
      term.write.mockClear()
      wsMocks.send.mockClear()
      term.deferWrites = true
      const pendingFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb: FrameRequestCallback) => {
        pendingFrames.push(cb)
        return pendingFrames.length
      })
      const flushFrames = async () => {
        const frames = pendingFrames.splice(0)
        await act(async () => {
          for (const cb of frames) cb(0)
        })
      }

      // A contiguous live frame goes IN FLIGHT: its write was flushed to
      // xterm but the completion callback is held by the deferred-write
      // mock.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 2, data: 'IN-FLIGHT-LIVE' })
      await flushFrames()
      const inFlightWriteOrder = term.write.mock.invocationCallOrder[
        term.write.mock.calls.findIndex(([data]: [string]) => String(data).includes('IN-FLIGHT-LIVE'))
      ]
      expect(inFlightWriteOrder).toBeGreaterThan(0)
      expect(term.pendingWriteCallbacks.length).toBe(1)
      expect(term.clear).not.toHaveBeenCalled()

      // The gap arms the deferred clear (the no-checkpoint fallback) and
      // the repair attach mints the NEW generation (the delivery-gap
      // notice rides chrome — no surface write, no queue item).
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 3,
          toSeq: 4,
          reason: 'queue_overflow',
        })
      })
      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(
        terminalWriteStrings(term).some((entry) => entry.includes('Output gap')),
        'the chrome notice never enqueue a surface write',
      ).toBe(false)

      // The repair's first replacement content ENQUEUES the clear+write
      // behind the in-flight stream write.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 4,
          replayToSeq: 6,
          attachRequestId: repair[0]!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 4,
          seqEnd: 6,
          data: 'REPLACEMENT-AFTER-CLEAR',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      expect(term.clear).not.toHaveBeenCalled()

      // The in-flight stream write completes, THEN the queue applies the
      // clear+write item: the live bytes land BEFORE the clear — no
      // post-clear mutation.
      const resetCountBefore = reconstructionWrites(term).length
      term.releasePendingWrites()
      await flushFrames()
      expect(reconstructionWrites(term)).toHaveLength(resetCountBefore + 1)
      expect(term.clear).not.toHaveBeenCalled()
      const resetIndex = term.write.mock.calls.findIndex(([data]: [string]) => data === MOUNTED_RECONSTRUCTION)
      const resetOrder = term.write.mock.invocationCallOrder[resetIndex]
      expect(inFlightWriteOrder, 'the stale write is submitted and completed before reconstruction').toBeLessThan(resetOrder)
      expect(term.pendingWriteCallbacks).toHaveLength(1)
      expect(repairAttaches()).toHaveLength(1)
      term.releasePendingWrites()
      await flushFrames()
      replayReconstructedSurface(terminalId, repair[0]!.attachRequestId, 6, 'REPLACEMENT-AFTER-CLEAR')
      await flushFrames()
      expectTerminalWriteContaining(term, 'REPLACEMENT-AFTER-CLEAR')
      const replacementOrder = term.write.mock.invocationCallOrder[term.write.mock.calls.findIndex(([data]: [string]) => data === 'REPLACEMENT-AFTER-CLEAR')]
      expect(resetOrder).toBeLessThan(replacementOrder)
      term.releasePendingWrites()
    })

    it('repeated negotiated queue_overflow gaps exhaust to the visible retry strip', async () => {
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-repair-exhaust',
      })

      const repairAttachCount = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      ).length

      wsMocks.send.mockClear()
      for (let round = 1; round <= 4; round += 1) {
        act(() => {
          messageHandler!({
            type: 'terminal.output.gap',
            terminalId,
            fromSeq: round * 10 + 1,
            toSeq: round * 10 + 5,
            reason: 'queue_overflow',
          })
        })
      }

      // The recovery bound (TERMINAL_RECOVERY_MAX_ATTEMPTS = 3): exactly
      // three gap-initiated repair attaches went out, the fourth gap is
      // declined, and the visible retry state shows.
      expect(repairAttachCount()).toBe(3)
      const retryStrip = screen.getByTestId('restore-recovery-retry')
      expect(retryStrip).toHaveAttribute('role', 'alert')
    })

    it('a handoff_boundary_reached gap repairs from the surface checkpoint cursor — the fixed boundary exit is fetchable delivery loss', async () => {
      // Round-4 server contract (plan:146): the paced session's FIXED
      // delivery boundary completed with output staged past it, and the
      // server declared the exact retained interval as the
      // `handoff_boundary_reached` delivery gap. The frames are RETAINED
      // and fetchable — the client's bounded baseline recovery (the SAME
      // checkpoint-cursor delta repair as queue_overflow) must fetch them
      // on the open connection: never a viewport wipe, never silent
      // advancement.
      wsMocks.capabilities = { pacedTerminalReplayV1: true }
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-boundary-gap-repair',
      })

      const repairAttaches = () => sentMessages().filter(
        (msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId,
      )

      // A contiguous applied prefix establishes a valid surface checkpoint.
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.write.mockClear()
      term.clear.mockClear()
      wsMocks.send.mockClear()
      expect(repairAttaches()).toEqual([])

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 9,
          reason: 'handoff_boundary_reached',
          headSeq: 9,
          oldestRetainedSeq: 1,
        })
      })

      // THE REPAIR: the boundary gap is fetchable delivery loss — the
      // checkpoint-cursor delta attach goes out on the SAME connection
      // (no transport flap), with the viewport never cleared before the
      // refilled content.
      const repair = repairAttaches()
      expect(repair.length).toBe(1)
      expect(repair[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'transport_reconnect',
        sinceSeq: 1,
        attachRequestId: expect.any(String),
      })
      expect(term.clear).not.toHaveBeenCalled()

      // The repair completes: the declared interval refills the surface on
      // the SAME connection, no retry strip.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 9,
          replayFromSeq: 2,
          replayToSeq: 9,
          attachRequestId: repair[0]!.attachRequestId,
          effectiveSinceSeq: 1,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 9,
          data: 'REFILLED',
          attachRequestId: repair[0]!.attachRequestId,
        })
      })
      expectTerminalWriteContaining(term, 'REFILLED')
      expect(term.clear).not.toHaveBeenCalled()
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('queues local gap notices behind a pending replay write', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-gap-notice-queued',
        ackInitialAttach: false,
        clearSends: false,
      })

      const submittedWrites: Array<{ data: string; onWritten?: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        submittedWrites.push({ data, onWritten })
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'REPLAY',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(submittedWrites.map((entry) => entry.data)).toEqual(['REPLAY'])

      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'queue_overflow',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(term.writeln).not.toHaveBeenCalled()
      expect(submittedWrites.map((entry) => entry.data)).toEqual(['REPLAY'])

      act(() => {
        submittedWrites[0].onWritten?.()
      })

      await waitFor(() => {
        expect(submittedWrites.map((entry) => entry.data)).toContainEqual(
          expect.stringContaining('Output gap 2-5: slow link backlog'),
        )
      })
    })

    it('invalidates warm delta eligibility only after a queued local notice applies', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-local-notice-invalidates',
        mode: 'codex',
        serverInstanceId: 'server-local-notice',
        streamId: 'stream-local-notice',
        ackInitialAttach: false,
        clearSends: false,
      })

      const submittedWrites: Array<{ data: string; onWritten?: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        submittedWrites.push({ data, onWritten })
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: attach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'REPLAY',
          attachRequestId: attach!.attachRequestId,
        })
      })

      expect(submittedWrites.map((entry) => entry.data)).toEqual(['REPLAY'])

      act(() => {
        messageHandler!({
          type: 'terminal.input.blocked',
          terminalId,
          reason: 'codex_identity_pending',
        })
      })

      expect(submittedWrites.map((entry) => entry.data)).toEqual(['REPLAY'])

      act(() => {
        submittedWrites[0].onWritten?.()
      })

      await waitFor(() => {
        expect(submittedWrites.map((entry) => entry.data)).toContainEqual(
          expect.stringContaining('Input not sent: Codex is still saving restore state.'),
        )
      })

      const checkpointAfterReplay = __readTerminalSurfaceCheckpointForTests(terminalId, {
        streamId: 'stream-local-notice',
        serverInstanceId: 'server-local-notice',
      }, { paneId: 'pane-v2-stream' })
      expect(checkpointAfterReplay?.attachRequestId).toBe(attach?.attachRequestId)
      expect(checkpointAfterReplay?.parserAppliedSeq).toBe(1)

      const noticeWrite = submittedWrites.find((entry) => entry.data.includes('Input not sent'))
      expect(noticeWrite?.onWritten).toBeTypeOf('function')

      wsMocks.send.mockClear()
      act(() => {
        noticeWrite?.onWritten?.()
      })
      act(() => {
        reconnectHandler?.()
      })

      expect(sentMessages().filter(msg => msg?.type === 'terminal.attach')).toEqual([])
      const resetWrite = submittedWrites.find(entry => entry.data === MOUNTED_RECONSTRUCTION)
      expect(resetWrite?.onWritten).toBeTypeOf('function')
      act(() => { resetWrite!.onWritten!() })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('renders replay frames after attach.ready when replay starts above 1', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-ready-then-replay' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 6,
          replayToSeq: 8,
        })
      })

      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 6, seqEnd: 6, data: 'R6' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 7, seqEnd: 7, data: 'R7' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 8, seqEnd: 8, data: 'R8' })
      })

      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('R6')
      expect(writes).toContain('R7')
      expect(writes).toContain('R8')
    })

    it('keeps continuity through gap + replay tail + live output', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-gap-tail' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 12,
          replayFromSeq: 9,
          replayToSeq: 12,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 8,
          reason: 'replay_window_exceeded',
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 9, seqEnd: 12, data: 'TAIL' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 13, seqEnd: 13, data: 'LIVE' })
      })

      expectTerminalWriteContaining(term, 'Output gap 1-8: reconnect window exceeded')
      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('TAIL')
      expect(writes).toContain('LIVE')
    })

    it('does not trust terminal.attach.ready head sequence until output renders', async () => {
      const { requestId, term } = await renderTerminalHarness({ status: 'creating' })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId,
          terminalId: 'term-v2-created',
          createdAt: Date.now(),
          // legacy payload should be ignored in v2 create handling
          snapshot: 'legacy snapshot payload',
        } as any)
      })

      expect(term.write).not.toHaveBeenCalled()
      wsMocks.send.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-v2-created',
          // Broker emits replayFrom=head+1 and replayTo=head when no replay frames exist.
          headSeq: 7,
          replayFromSeq: 8,
          replayToSeq: 7,
        })
      })

      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-v2-created',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

      describe('interrupted terminal restore resumes instead of restarting (responsive-terminal-restore WS2)', () => {
      const OSC52_FRAME = '\u001b]52;c;aGVsbG8=\u0007'

      function attachMessagesFor(terminalId: string) {
        return sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      }

      function terminalWrites(term: { write: { mock: { calls: Array<[unknown]> } } }): string {
        return term.write.mock.calls.map(([data]) => String(data)).join('')
      }

      async function renderResumablePane(suffix: string) {
        const terminalId = `term-resume-${suffix}`
        const harness = await renderTerminalHarness({
          status: 'running',
          terminalId,
          streamId: `stream-resume-${suffix}`,
          ackInitialAttach: false,
          clearSends: false,
        })
        return { ...harness, terminalId }
      }

      it('an interrupt after some applied callbacks resumes ONLY the remainder on the same surface (no clear, no surfaceReset re-claim)', async () => {
        const { terminalId, term } = await renderResumablePane('partial')
        term.clear.mockClear()
        term.write.mockClear()
        wsMocks.send.mockClear()

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'HE' })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 4, data: 'LLO' })
        })
        expect(terminalWrites(term)).toBe('HELLO')

        // Interrupt: the transport drops before frames 5-10 arrive.
        act(() => { reconnectHandler?.() })

        const resumeAttach = attachMessagesFor(terminalId).at(-1)
        expect(resumeAttach).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })
        expect(resumeAttach).not.toHaveProperty('surfaceReset')
        expect(term.clear).not.toHaveBeenCalled()

        // The remainder converges to the uninterrupted reference with no
        // duplicate writes.
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 5,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 10, data: ' WORLD' })
        })
        expect(terminalWrites(term)).toBe('HELLO WORLD')
      })

      it('disconnect-and-resume across a MIXED page resumes from the coverage cursor with no duplicate writes', async () => {
        const { terminalId, term } = await renderResumablePane('mixed')
        term.clear.mockClear()
        term.write.mockClear()
        wsMocks.send.mockClear()

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 8,
            replayFromSeq: 1,
            replayToSeq: 8,
          })
          // Filtered prefix: fully consumed by the OSC52 pre-parser, nothing
          // renders, and the strict applied position stays pinned at zero.
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: OSC52_FRAME })
          // Applied tail.
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 8, data: 'hello' })
        })
        expect(terminalWrites(term)).toBe('hello')

        act(() => { reconnectHandler?.() })

        // The coverage cursor carries the resume position PAST the filtered
        // range — never the applied position the filter pinned at zero, never
        // a full-baseline rebuild.
        const resumeAttach = attachMessagesFor(terminalId).at(-1)
        expect(resumeAttach).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 8 })
        expect(resumeAttach).not.toHaveProperty('surfaceReset')
        expect(term.clear).not.toHaveBeenCalled()

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 12,
            replayFromSeq: 9,
            replayToSeq: 12,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 9, seqEnd: 12, data: ' tail' })
        })
        // No duplicate writes: 'hello' renders exactly once, no re-filtered
        // OSC52 side effects, convergence to the reference.
        expect(terminalWrites(term)).toBe('hello tail')
      })

      it('disconnect-and-resume across a FILTERED-ONLY page resumes the claimed hydrate from coverage (partial-hydrate exemption)', async () => {
        const { terminalId, term } = await renderResumablePane('filtered-only')
        term.clear.mockClear()
        term.write.mockClear()
        wsMocks.send.mockClear()

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 5,
            replayFromSeq: 1,
            replayToSeq: 5,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 5, data: OSC52_FRAME })
        })
        // A page with ONLY null-screen-effect frames renders nothing — but it
        // was consumed: the fresh-claimed surface is partially hydrated, not
        // blank.
        expect(terminalWrites(term)).toBe('')

        act(() => { reconnectHandler?.() })

        // The exemption: the marker-armed surface with coverage > 0 and a
        // valid checkpoint resumes via transport_reconnect — no
        // viewport_hydrate, no surfaceReset re-claim, no mode-preamble resend.
        const resumeAttach = attachMessagesFor(terminalId).at(-1)
        expect(resumeAttach).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 5 })
        expect(resumeAttach).not.toHaveProperty('surfaceReset')
        expect(term.clear).not.toHaveBeenCalled()

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 8,
            replayFromSeq: 6,
            replayToSeq: 8,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 6, seqEnd: 8, data: 'live' })
        })
        expect(terminalWrites(term)).toBe('live')
      })

      it('an interrupt BEFORE any callback takes the full-hydrate path and delayed old callbacks never write stale content', async () => {
        const { terminalId, term } = await renderResumablePane('pre-callback')

        // Withhold the frame flush: frames are accepted and enqueued but no
        // write callback has fired — nothing consumed.
        const rafCallbacks: FrameRequestCallback[] = []
        requestAnimationFrameSpy!.mockImplementation((cb) => {
          rafCallbacks.push(cb)
          return rafCallbacks.length
        })
        const pumpRaf = () => {
          while (rafCallbacks.length > 0) {
            rafCallbacks.shift()!(0)
          }
        }

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'OLD' })
        })
        expect(rafCallbacks.length).toBeGreaterThan(0)

        wsMocks.send.mockClear()
        act(() => { reconnectHandler?.() })

        // Nothing to resume from: the full-hydrate path (fresh override,
        // surfaceReset re-claimed, sinceSeq 0).
        const secondAttach = attachMessagesFor(terminalId).at(-1)
        expect(secondAttach).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0 })
        expect(secondAttach).toHaveProperty('surfaceReset', true)

        // The delayed old-generation callbacks flush AFTER recovery: the
        // superseded generation's queued writes are dropped — no stale
        // content, no false progress.
        act(() => { pumpRaf() })
        expect(terminalWrites(term)).toBe('')

        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'NEW' })
        })
        act(() => { pumpRaf() })
        expect(terminalWrites(term)).toBe('NEW')

        // The checkpoint reflects only the new generation's applied frames —
        // the dropped OLD range contributed no false progress.
        const checkpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
          streamId: 'stream-resume-pre-callback',
          serverInstanceId: 'srv-v2-stream',
        }, { paneId: 'pane-v2-stream' })
        expect(checkpoint?.parserAppliedSeq).toBe(2)
        expect(checkpoint?.surfaceCoverageSeq).toBe(2)
      })

      it('sibling panes rendering the same terminal cannot borrow each other\u2019s checkpoint progress', async () => {
        const terminalId = 'term-sibling-shared'
        const streamId = 'stream-sibling-shared'

        // Pane A: fully hydrates through seq 10. Capture its handler AND its
        // mount attach BEFORE pane B's render re-registers (the shared mock
        // reassigns `messageHandler` on every registration).
        await renderTerminalHarness({
          status: 'running',
          terminalId,
          streamId,
          ackInitialAttach: false,
          clearSends: false,
        })
        const deliverA = messageHandler!
        const attachA = [...wsMocks.send.mock.calls]
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(attachA?.attachRequestId).toBeTruthy()
        wsMocks.send.mockClear()

        // Pane B: a second pane rendering the SAME terminal (its own xterm
        // surface), currently only through seq 2.
        const tabB = 'tab-sibling-b'
        const paneBId = 'pane-sibling-b'
        const paneContentB: TerminalPaneContent = {
          kind: 'terminal',
          createRequestId: 'req-sibling-b',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          terminalId,
          streamId,
        }
        const rootB: PaneNode = { type: 'leaf', id: paneBId, content: paneContentB }
        const storeB = configureStore({
          reducer: {
            tabs: tabsReducer,
            panes: panesReducer,
            settings: settingsReducer,
            connection: connectionReducer,
            turnCompletion: turnCompletionReducer,
          },
          preloadedState: {
            tabs: {
              tabs: [{
                id: tabB,
                mode: 'shell',
                status: 'running',
                title: 'Shell',
                titleSetByUser: false,
                createRequestId: 'req-sibling-b',
                terminalId,
              }],
              activeTabId: tabB,
            },
            panes: {
              layouts: { [tabB]: rootB },
              activePane: { [tabB]: paneBId },
              paneTitles: {},
            },
            settings: createSettingsState(),
            connection: { status: 'connected', error: null, serverInstanceId: 'srv-v2-stream' },
          },
        })
        render(
          <Provider store={storeB}>
            <TerminalView tabId={tabB} paneId={paneBId} paneContent={paneContentB} />
          </Provider>,
        )
        await waitFor(() => {
          expect(terminalInstances.length).toBeGreaterThanOrEqual(2)
        })
        const deliverB = messageHandler!
        expect(deliverB).not.toBe(deliverA)
        const termB = terminalInstances[terminalInstances.length - 1]

        const attachForPane = (paneIdPrefix: string) => [...wsMocks.send.mock.calls]
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
          .find((msg) => typeof msg?.attachRequestId === 'string' && msg.attachRequestId.startsWith(`${paneIdPrefix}:`))

        // Drive pane A's hydration through seq 10.
        act(() => {
          deliverA(withCurrentAttachRequestId({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
            attachRequestId: attachA!.attachRequestId,
          }))
          deliverA(withCurrentAttachRequestId({
            type: 'terminal.output',
            terminalId,
            seqStart: 1,
            seqEnd: 10,
            data: 'A'.repeat(10),
            attachRequestId: attachA!.attachRequestId,
          }))
        })

        // Drive pane B's hydration through seq 2 only.
        await waitFor(() => {
          expect(attachForPane(paneBId)).toBeTruthy()
        })
        const attachB = attachForPane(paneBId)
        act(() => {
          deliverB(withCurrentAttachRequestId({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 2,
            replayFromSeq: 1,
            replayToSeq: 2,
            attachRequestId: attachB!.attachRequestId,
          }))
          deliverB(withCurrentAttachRequestId({
            type: 'terminal.output',
            terminalId,
            seqStart: 1,
            seqEnd: 2,
            data: 'B2',
            attachRequestId: attachB!.attachRequestId,
          }))
        })
        expect(terminalWriteStrings(termB).join('')).toContain('B2')

        // Pane B reconnects: it must resume from ITS OWN surface's progress
        // (seq 2), never from pane A's further-ahead checkpoint (seq 10) —
        // resuming past its own rendered content would leave a data hole.
        wsMocks.send.mockClear()
        act(() => { reconnectHandler?.() })

        const resumeB = attachForPane(paneBId)
        expect(resumeB).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 2 })

        // Both panes keep their own scoped progress.
        const checkpointA = __readTerminalSurfaceCheckpointForTests(terminalId, {
          streamId,
          serverInstanceId: 'srv-v2-stream',
        }, { paneId: 'pane-v2-stream' })
        expect(checkpointA?.parserAppliedSeq).toBe(10)
        const checkpointB = __readTerminalSurfaceCheckpointForTests(terminalId, {
          streamId,
          serverInstanceId: 'srv-v2-stream',
        }, { paneId: paneBId })
        expect(checkpointB?.parserAppliedSeq).toBe(2)
      })

      it('a remount of the same pane never reuses the previous mount\u2019s checkpoint — the resume never exceeds the new surface\u2019s rendered position (reload contract)', async () => {
        const { terminalId, ...first } = await renderResumablePane('remount-stale')
        const storeKey = `pane-v2-stream::${terminalId}`

        // Mount 1: a full hydrate renders through seq 10 — its scoped
        // checkpoint claims coverage 10 under this pane's store key.
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 10, data: 'FULL-PAGE' })
        })
        let previousSurfaceInstanceId = ''
        await waitFor(() => {
          const raw = (globalThis.localStorage as Storage).getItem(TERMINAL_CURSOR_STORAGE_KEY)
          expect(raw).toBeTruthy()
          const entry = JSON.parse(raw!)[storeKey]
          expect(entry?.checkpoint?.surfaceCoverageSeq).toBe(10)
          expect(typeof entry?.checkpoint?.surfaceInstanceId).toBe('string')
          previousSurfaceInstanceId = entry.checkpoint.surfaceInstanceId
        })

        // Remount (page reload / layout remount): the SAME pane id, so the
        // same store key and a colliding per-mount surface epoch (both
        // mounts start their epoch at 0 → 1 after the first forced
        // hydrate). The hydrate is interrupted after seq 2.
        first.unmount()
        wsMocks.send.mockClear()
        render(
          <Provider store={first.store}>
            <TerminalViewFromStore tabId={first.tabId} paneId={first.paneId} />
          </Provider>,
        )
        await waitFor(() => {
          expect(messageHandler).not.toBeNull()
          expect(attachMessagesFor(terminalId).length).toBeGreaterThan(0)
        })
        const remountedTerm = terminalInstances[terminalInstances.length - 1]
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'NE' })
        })
        expect(remountedTerm.write.mock.calls.map(([data]: [string]) => String(data)).join('')).toBe('NE')

        wsMocks.send.mockClear()
        act(() => { reconnectHandler?.() })

        // The resume must never exceed the new surface's OWN rendered
        // position (2) — the stale previous-mount entry claims 10, and a
        // delta resume from it would permanently skip frames 3-10.
        const resumeAttach = attachMessagesFor(terminalId).at(-1)
        expect(resumeAttach).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 2 })

        // And the store now reflects the new surface instance's honest
        // progress — the stale higher-coverage entry was replaced, not kept.
        await waitFor(() => {
          const raw = (globalThis.localStorage as Storage).getItem(TERMINAL_CURSOR_STORAGE_KEY)
          expect(raw).toBeTruthy()
          const entry = JSON.parse(raw!)[storeKey]
          expect(entry?.checkpoint?.surfaceCoverageSeq).toBe(2)
          expect(typeof entry?.checkpoint?.surfaceInstanceId).toBe('string')
          // The entry belongs to the NEW mount's surface instance.
          expect(entry.checkpoint.surfaceInstanceId).not.toBe(previousSurfaceInstanceId)
        })
      })

    it('recovery bounding: repeated progressless attaches stop at the bound, show the accessible retry state, preserve content, and explicit retry resumes', async () => {
      const { terminalId, term } = await renderResumablePane('recovery')

      const attachCount = () => attachMessagesFor(terminalId).length
      // The mount attach is the pane's INITIAL hydration (never counted);
      // the recovery bound counts progressless RE-attaches after it.
      expect(attachCount()).toBe(1)

      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(2)
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(3)
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(4)

      term.clear.mockClear()
      // The 4th progressless recovery attempt exceeds the bound: automatic
      // cycling STOPS and the visible, accessible retry state shows.
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(4)

      const retryStrip = screen.getByTestId('restore-recovery-retry')
      expect(retryStrip).toHaveAttribute('role', 'alert')
      const retryButton = screen.getByRole('button', { name: 'Retry terminal restore' })
      expect(retryButton).toBeTruthy()
      // The visible content is preserved: no wipe, no kill, no replacement.
      expect(term.clear).not.toHaveBeenCalled()
      expect(sentMessages().some((msg) => msg?.type === 'terminal.kill')).toBe(false)
      expect(sentMessages().some((msg) => msg?.type === 'terminal.create')).toBe(false)

      // Explicit retry re-arms: the attach goes out again.
      act(() => {
        fireEvent.click(retryButton)
      })
      expect(attachCount()).toBe(5)
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
    })

    it('recovery bounding: newly consumed stream positions reset the progressless counter', async () => {
      const { terminalId } = await renderResumablePane('recovery-progress')

      const attachCount = () => attachMessagesFor(terminalId).length
      expect(attachCount()).toBe(1)
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(2)

      // Genuine progress: frames actually consume on the surface.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 1,
          replayToSeq: 4,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'PROGRESS' })
      })

      // The progress reset the streak: three more reconnects are allowed
      // (a fresh streak of recovery attempts 1-3), and the strip never shows.
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(3)
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(4)
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(5)
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()

      // The next progressless one exceeds the fresh streak's bound.
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(5)
      expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
    })

    it('recovery bounding: a converged idle pane’s cursor-confirmed flap cycle is not parser progress — it exhausts to the retry strip with the content preserved', async () => {
      // Round-4 REVERSAL to plan:166's literal rule: the streak resets
      // ONLY on genuine parser progress (an ADVANCE of the applied
      // surface) or an explicit user retry — "not merely on receiving
      // attach.ready or another reconnect". A converged idle pane's
      // reconnect flap completes cleanly and the server CONFIRMS the
      // cursor (effectiveSinceSeq == requested) — but the empty window
      // delivered no bytes, nothing applied, NO parser surface advanced:
      // per the plan that is NOT progress, and the flap cycle EXHAUSTS
      // to the visible retry strip with the content preserved and an
      // accessible retry state (plan:166's explicit design). The prior
      // never-strand disposition (delta-R1-F5 / 40afe39b7) contradicted
      // the plan's sentence and is superseded.
      const { terminalId, term } = await renderResumablePane('recovery-clean')

      const attachCount = () => attachMessagesFor(terminalId).length
      // The mount attach is the pane's INITIAL hydration (never counted).
      expect(attachCount()).toBe(1)

      // A converged surface with a real cursor: frames applied to the
      // mount attach establish coverage 4, so every reconnect resume
      // requests sinceSeq 4 (the checkpoint cursor).
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 1,
          replayToSeq: 4,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'CONVERGED' })
      })
      term.clear.mockClear()

      // Each flap's reconnect attach completes CLEANLY and with the
      // cursor CONFIRMED (effectiveSinceSeq == the requested sinceSeq,
      // an empty window, no gap) — the ordinary shape of an idle
      // converged pane's reconnect. Under plan:166 it is still NOT
      // progress: no bytes delivered, nothing applied.
      let convergedCursor = 4
      const ackCleanRestore = () => {
        const attach = attachMessagesFor(terminalId).at(-1)
        expect(attach?.attachRequestId).toBeTruthy()
        expect(attach?.sinceSeq).toBe(convergedCursor)
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: convergedCursor,
            replayFromSeq: convergedCursor + 1,
            replayToSeq: convergedCursor,
            attachRequestId: attach!.attachRequestId,
            effectiveSinceSeq: convergedCursor,
            requestedSinceSeq: convergedCursor,
          })
        })
      }

      // Three progressless flaps consume the bound (the mount attach is
      // exempt); the FOURTH is declined and the accessible retry state
      // shows — the converged pane's flap cycle is bounded exactly like
      // any other progressless cycle.
      for (let flap = 0; flap < 3; flap += 1) {
        act(() => { reconnectHandler?.() })
        expect(attachCount(), `flap ${flap} attaches`).toBe(2 + flap)
        ackCleanRestore()
      }
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(4)
      const retryStrip = screen.getByTestId('restore-recovery-retry')
      expect(retryStrip).toHaveAttribute('role', 'alert')
      const retryButton = screen.getByRole('button', { name: 'Retry terminal restore' })
      expect(retryButton).toBeTruthy()

      // The visible content is PRESERVED at the strip (plan:166):
      // no wipe, no kill, no replacement.
      expect(term.clear).not.toHaveBeenCalled()
      expect(sentMessages().some((msg) => msg?.type === 'terminal.kill')).toBe(false)
      expect(sentMessages().some((msg) => msg?.type === 'terminal.create')).toBe(false)

      // GENUINE parser progress un-exhausts the pane: real frames apply
      // (the applied surface ADVANCES past 4), the streak resets, and
      // automatic re-attach resumes — the pane is never stranded.
      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 6, data: 'PROGRESS' })
      })
      convergedCursor = 6
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(5)

      // The explicit retry also re-arms (the user's control). The re-armed
      // streak covers the post-progress reconnect plus two more flaps; the
      // THIRD flap's reconnect is already declined — cursor-confirmed clean
      // restores are NOT progress toward the re-armed bound either.
      for (let flap = 0; flap < 2; flap += 1) {
        act(() => { reconnectHandler?.() })
        expect(attachCount(), `flap ${flap} attaches`).toBe(6 + flap)
        ackCleanRestore()
      }
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(7)
      expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      act(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry terminal restore' }))
      })
      expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
      expect(attachCount()).toBe(8)
    })

    it('recovery bounding: an empty-window ready that never confirms the surface cursor is not a clean restore — the cycle still exhausts', async () => {
      // Round-4 plan:166 literal rule: NO attach.ready — confirmed or not —
      // resets the progressless streak. Without an advance of the applied
      // surface and without an explicit retry, the cycle is exactly the
      // flapping reconnect-loop the recovery bound exists to stop: the
      // pane may reach attach.ready forever while never converging.
      const { terminalId } = await renderResumablePane('recovery-unconfirmed')

      const attachCount = () => attachMessagesFor(terminalId).length
      expect(attachCount()).toBe(1)

      // A real surface cursor first: frames applied to the mount attach.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 1,
          replayToSeq: 4,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'SEEDED' })
      })
      const baseCount = attachCount()
      expect(baseCount).toBe(1)

      // Each flap's reconnect resumes from the cursor (sinceSeq 4) and the
      // server answers with an EMPTY window — but the ready carries NO
      // effectiveSinceSeq: the server never confirmed the client's
      // surface cursor, and no coverage advanced. NOT a clean restore.
      const ackUnconfirmedReady = () => {
        const attach = attachMessagesFor(terminalId).at(-1)
        expect(attach?.attachRequestId).toBeTruthy()
        expect(attach?.sinceSeq).toBe(4)
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 4,
            replayFromSeq: 5,
            replayToSeq: 4,
            attachRequestId: attach!.attachRequestId,
          })
        })
      }

      for (let flap = 1; flap <= 3; flap += 1) {
        act(() => { reconnectHandler?.() })
        expect(attachCount(), `flap ${flap} attaches`).toBe(baseCount + flap)
        ackUnconfirmedReady()
      }

      // The bound trips: unconfirmed empty reconnects are progressless
      // attempts, and the pane reaches the visible retry state with the
      // surface preserved (no wipe, no kill, no replacement).
      act(() => { reconnectHandler?.() })
      expect(
        attachCount(),
        'unconfirmed empty reconnects still exhaust to the bound',
      ).toBe(baseCount + 3)
      expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
    })

    it('recovery bounding: an empty-window ready whose effectiveSinceSeq is not the requested cursor is not a clean restore', async () => {
      // The second non-progress shape: the server DID answer with the
      // contract fields but adjusted the baseline (retention loss or a
      // stream swap rewound the head below the client's cursor). Under
      // the round-4 plan:166 rule NO ready resets the streak at all;
      // this shape stays pinned so a future ready-keyed reset cannot
      // sneak back in through the retention-adjusted arm either.
      const { terminalId } = await renderResumablePane('recovery-adjusted')

      const attachCount = () => attachMessagesFor(terminalId).length
      expect(attachCount()).toBe(1)

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 1,
          replayToSeq: 4,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'SEEDED' })
      })
      const baseCount = attachCount()

      const ackAdjustedReady = () => {
        const attach = attachMessagesFor(terminalId).at(-1)
        expect(attach?.attachRequestId).toBeTruthy()
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            // The server's head sits BELOW the client's cursor and the
            // baseline was adjusted to the head: an empty window whose
            // effectiveSinceSeq (2) != the requested cursor (4).
            headSeq: 2,
            replayFromSeq: 3,
            replayToSeq: 2,
            attachRequestId: attach!.attachRequestId,
            effectiveSinceSeq: 2,
            requestedSinceSeq: 4,
          })
        })
      }

      for (let flap = 1; flap <= 3; flap += 1) {
        act(() => { reconnectHandler?.() })
        expect(attachCount(), `flap ${flap} attaches`).toBe(baseCount + flap)
        ackAdjustedReady()
      }

      act(() => { reconnectHandler?.() })
      expect(
        attachCount(),
        'cursor-adjusted empty reconnects still exhaust to the bound',
      ).toBe(baseCount + 3)
      expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
    })

    it('recovery bounding: fresh retained output refunds once after a gap, while completion alone does not', async () => {
      const { terminalId } = await renderResumablePane('recovery-gap-taint')

      const attachCount = () => attachMessagesFor(terminalId).length
      expect(attachCount()).toBe(1)

      // Flap 1: the reconnect attach's ready arrives, then a retention gap
      // breaks the generation mid-window — the completion that follows is
      // NOT a clean success and must not reset the streak.
      act(() => { reconnectHandler?.() })
      expect(attachCount()).toBe(2)
      const gapped = attachMessagesFor(terminalId).at(-1)
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 1,
          replayToSeq: 8,
          attachRequestId: gapped!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 2,
          toSeq: 5,
          reason: 'replay_window_exceeded',
          attachRequestId: gapped!.attachRequestId,
        })
        // The post-gap retained range completes the attach via frames.
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 6,
          seqEnd: 8,
          data: 'TAIL',
          attachRequestId: gapped!.attachRequestId,
        })
      })

      // Flaps 2 and 3: the gap-poisoned pane's further progressless
      // reconnects accumulate to the bound; the 4th is declined.
      for (let flap = 1; flap <= 3; flap += 1) {
        act(() => { reconnectHandler?.() })
        expect(attachCount()).toBe(2 + flap)
      }
      act(() => { reconnectHandler?.() })
      expect(attachCount(), 'the bound still trips for gap-poisoned cycles').toBe(5)
      expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
    })

    it('recovery bounding: the no-progress deadline reaches the retry state through the wired timer path (M-4)', async () => {
      const { terminalId } = await renderResumablePane('deadline')

      const attachCount = () => attachMessagesFor(terminalId).length
      // The mount attach is the pane's initial hydration (never counted).
      expect(attachCount()).toBe(1)

      const base = Date.now()
      vi.useFakeTimers()
      try {
        vi.setSystemTime(base)
        // Two counted progressless attempts open the streak (the deadline
        // requires both).
        act(() => { reconnectHandler?.() })
        expect(attachCount()).toBe(2)
        act(() => { reconnectHandler?.() })
        expect(attachCount()).toBe(3)

        // 30s of no progress with only TWO attempts sent: the next
        // automatic attempt must be stopped by the DEADLINE alone (the
        // attempt bound is 3 and has not fired) and show the retry state.
        act(() => { vi.advanceTimersByTime(TERMINAL_RECOVERY_NO_PROGRESS_DEADLINE_MS + 1) })
        act(() => { reconnectHandler?.() })
        expect(attachCount()).toBe(3)
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      } finally {
        vi.useRealTimers()
      }
    })

      it('quarantine freeze: an in-flight-write reconnect defers the decision and the drained repair rebuilds honestly when the surface moved', async () => {
        const bridge = createPerfAuditBridge()
        installPerfAuditBridge(bridge)
        const { terminalId, term } = await renderResumablePane('quarantine')

        // Frames 1-2 apply and checkpoint NORMALLY — the pane enters the
        // quarantine with a VALID resumable checkpoint (applied/coverage 2).
        // The drained repair must rebuild anyway: the frozen window's
        // completed write moved the surface beyond it (M-2 — the repair
        // never resumes a checkpoint the window provably outgrew).
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 10,
            replayFromSeq: 1,
            replayToSeq: 10,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'OK' })
        })
        const preQuarantineCheckpoint = __readTerminalSurfaceCheckpointForTests(terminalId, {
          streamId: 'stream-resume-quarantine',
          serverInstanceId: 'srv-v2-stream',
        }, { paneId: 'pane-v2-stream' })
        expect(preQuarantineCheckpoint?.parserAppliedSeq).toBe(2)
        expect(preQuarantineCheckpoint?.surfaceCoverageSeq).toBe(2)

        // Frames 3-4 go in flight and STAY in flight across the reconnect.
        const withheldWriteCallbacks: Array<() => void> = []
        term.write.mockImplementation((_data: string, onWritten?: () => void) => {
          if (onWritten) withheldWriteCallbacks.push(onWritten)
        })
        act(() => {
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 4, data: 'PRE' })
        })
        expect(withheldWriteCallbacks.length).toBeGreaterThan(0)

        wsMocks.send.mockClear()
        term.clear.mockClear()
        // Reconnect lands while the first hydrate's write is still in flight:
        // the surface decision is FROZEN (quarantined hydrate, no wipe yet).
        act(() => { reconnectHandler?.() })
        const quarantinedAttach = attachMessagesFor(terminalId).at(-1)
        expect(quarantinedAttach).toBeUndefined()
        expect(reconstructionWrites(term)).toHaveLength(0)
        expect(term.clear).not.toHaveBeenCalled()

        // The stale in-flight write completes during the frozen window — its
        // bytes reached the surface, so the drained repair must rebuild from
        // a full hydrate rather than resume a checkpoint that under-describes
        // the surface.
      act(() => {
        withheldWriteCallbacks.splice(0).forEach((cb) => cb())
      })

      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(attachMessagesFor(terminalId)).toEqual([])
      expect(withheldWriteCallbacks).toHaveLength(1)
      act(() => { withheldWriteCallbacks.splice(0).forEach(cb => cb()) })

      // The reset completion publishes the guarded boundary: it must
      // REBUILD from a full hydrate (the stale completion's bytes are on
      // the surface beyond the checkpoint) and record the honest decision.
      const repairEvent = await waitFor(() => {
        const event = bridge.snapshot().perfEvents.find(
          (e) => e.event === 'terminal.catchup.surface_quarantine_repair',
        )
        expect(event).toBeTruthy()
        return event
      })
      expect(repairEvent).toMatchObject({
        terminalId,
        resumable: false,
        completedWritesDuringQuarantine: 1,
      })
      const repairAttach = attachMessagesFor(terminalId).at(-1)
      expect(repairAttach).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0 })
      // Never a delta resume out of the drained repair — the surface
      // provably moved during the frozen window.
      expect(repairAttach).not.toMatchObject({ intent: 'transport_reconnect' })
      })
    })

    // Task-009b (goal 4 — "reconnect resumes from applied progress"): the
    // reconnect's reconcile round (App re-sends pane.reconcile on EVERY
    // ready) must never supersede the checkpoint delta resume with a full
    // viewport_hydrate refetch. The wire blueprint is the e2e trace
    // `transport_reconnect sinceSeq: 254` followed by a superseding
    // `viewport_hydrate sinceSeq: 0`.
    describe('reconcile re-drives stay resume-aware across a healthy-checkpoint flap', () => {
      // The resume-aware re-drive contract is negotiated-lane
      // (pacedTerminalReplayV1): production flaps re-attach on a ready,
      // capability-echoed connection, so the current attach generation is a
      // paced one. The old-server lane is pinned separately below.
      beforeEach(() => {
        wsMocks.capabilities = { pacedTerminalReplayV1: true }
      })

      function attachMessagesFor(terminalId: string) {
        return sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg.terminalId === terminalId)
      }

      function terminalWrites(term: { write: { mock: { calls: Array<[unknown]> } } }): string {
        return term.write.mock.calls.map(([data]) => String(data)).join('')
      }

      async function renderReconcileFlapPane(suffix: string) {
        const terminalId = `term-9b-${suffix}`
        const harness = await renderTerminalHarness({
          status: 'running',
          terminalId,
          streamId: `stream-9b-${suffix}`,
          sessionRef: { provider: 'claude', sessionId: `s-9b-${suffix}` },
          contentServerInstanceId: 'srv-9b',
          ackInitialAttach: false,
          clearSends: false,
          fromStore: true,
        })
        return { ...harness, terminalId, tabId: 'tab-v2-stream', paneId: 'pane-v2-stream' }
      }

      // Apply frames 1..4 through the real attach pipeline: the coverage
      // cursor advances and the surface checkpoint saves — the healthy
      // baseline the flap's delta resume (and any re-drive) consults.
      async function applyCheckpointBaseline(terminalId: string, term: { write: { mock: { calls: Array<[unknown]> } } }) {
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 4,
            replayFromSeq: 1,
            replayToSeq: 4,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'SEED' })
        })
        expect(terminalWrites(term)).toBe('SEED')
      }

      it('a healthy-checkpoint flap never supersedes the checkpoint delta resume with a viewport_hydrate refetch', async () => {
        const { store, terminalId, term } = await renderReconcileFlapPane('flap')
        await applyCheckpointBaseline(terminalId, term)
        term.clear.mockClear()
        wsMocks.send.mockClear()

        // The transport flap: onReconnect fires the checkpoint delta resume
        // (transport_reconnect, sinceSeq>0 from the coverage cursor) and the
        // attach stays IN FLIGHT — no attach.ready — so the pane's deferred
        // mode is 'attaching' for everything that follows.
        act(() => { reconnectHandler?.() })
        const deltaAttach = attachMessagesFor(terminalId).at(-1)
        expect(deltaAttach).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })

        // The reconnect's ready round, exactly as App sends it: the pending
        // window opens (setReconcilePendingPanes), then the server's attach
        // verdict CONFIRMS the pane's exact current identity — same
        // terminalId, same server instance, same sessionRef, no
        // corrected/duplicate flags.
        act(() => {
          store.dispatch(setReconcilePendingPanes({
            paneKeys: ['tab-v2-stream:pane-v2-stream'],
            startedAt: Date.now(),
          }))
        })
        act(() => {
          store.dispatch(applyReconcileAttach({
            tabId: 'tab-v2-stream',
            paneId: 'pane-v2-stream',
            terminalId,
            serverInstanceId: 'srv-9b',
            sessionRef: { provider: 'claude', sessionId: 's-9b-flap' },
          }))
        })

        // Goal 4: the checkpoint delta resume stays authoritative. No
        // superseding viewport_hydrate (sinceSeq 0 full refetch) follows it
        // — neither from the pending-window re-drive nor from the verdict
        // fold — and the delta is the flap's only attach.
        const attaches = attachMessagesFor(terminalId)
        expect(
          attaches.filter((m) => m.intent === 'viewport_hydrate'),
          'no superseding full refetch after the delta resume',
        ).toEqual([])
        expect(attaches, 'the delta resume is the flap’s only attach').toHaveLength(1)

        // The delta completes on the SAME surface: content preserved (no
        // wipe) and the remainder applies with no duplicate writes.
        act(() => {
          messageHandler!({
            type: 'terminal.attach.ready',
            terminalId,
            headSeq: 8,
            replayFromSeq: 5,
            replayToSeq: 8,
          })
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 8, data: ' TAIL' })
        })
        expect(terminalWrites(term)).toBe('SEED TAIL')
        expect(term.clear).not.toHaveBeenCalled()
      })

      it.each(['deferred', 'confirmed'] as const)(
        'retries a rejected attach when the reconcile window closes with a %s verdict',
        async (verdict) => {
          const { store, terminalId, term } = await renderReconcileFlapPane('rejected')
          await applyCheckpointBaseline(terminalId, term)
          act(() => {
            store.dispatch(setReconcilePendingPanes({
              paneKeys: ['tab-v2-stream:pane-v2-stream'],
              startedAt: Date.now(),
            }))
          })
          wsMocks.send.mockClear()

          act(() => { reconnectHandler?.() })
          const rejectedAttach = attachMessagesFor(terminalId).at(-1)
          expect(rejectedAttach).toMatchObject({ type: 'terminal.attach', terminalId })

          act(() => {
            messageHandler!({
              type: 'error',
              code: 'INVALID_TERMINAL_ID',
              message: 'Terminal not running',
              terminalId,
              requestId: rejectedAttach!.attachRequestId,
            })
          })
          expect(sentMessages().filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)

          // A managed runtime can defer its verdict or confirm the same
          // persisted identity. Either result must re-drive the attach that
          // the server rejected, preserving the terminal ID.
          act(() => {
            if (verdict === 'confirmed') {
              store.dispatch(applyReconcileAttach({
                tabId: 'tab-v2-stream',
                paneId: 'pane-v2-stream',
                terminalId,
                serverInstanceId: 'srv-9b',
                sessionRef: { provider: 'claude', sessionId: 's-9b-rejected' },
              }))
            } else {
              store.dispatch(clearAllReconcilePendingPanes())
            }
          })
          const attaches = attachMessagesFor(terminalId)
          expect(attaches).toHaveLength(2)
          expect(attaches[1].attachRequestId).not.toBe(rejectedAttach!.attachRequestId)
        },
      )

      it('a corrective duplicate verdict re-drives as a checkpoint delta, never a full refetch', async () => {
        const { store, terminalId } = await renderReconcileFlapPane('dup')
        const term = terminalInstances[terminalInstances.length - 1]
        await applyCheckpointBaseline(terminalId, term)
        wsMocks.send.mockClear()

        act(() => { reconnectHandler?.() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })

        // A corrective verdict (duplicate flag) still bumps the epoch and
        // re-drives the pane — but the re-drive must RESUME the same
        // healthy surface instead of refetching it whole.
        act(() => {
          store.dispatch(applyReconcileAttach({
            tabId: 'tab-v2-stream',
            paneId: 'pane-v2-stream',
            terminalId,
            serverInstanceId: 'srv-9b',
            sessionRef: { provider: 'claude', sessionId: 's-9b-dup' },
            duplicate: true,
          }))
        })

        const reDrive = attachMessagesFor(terminalId).at(-1)
        expect(reDrive, 'the corrective re-drive resumes from the checkpoint').toMatchObject({ intent: 'keepalive_delta' })
        expect(
          attachMessagesFor(terminalId).filter((m) => m.intent === 'viewport_hydrate'),
          'a same-surface corrective verdict never refetches',
        ).toEqual([])
      })

      it('a foreign-identity corrective verdict still re-drives with the honest full hydrate', async () => {
        const { store, terminalId } = await renderReconcileFlapPane('foreign')
        const term = terminalInstances[terminalInstances.length - 1]
        await applyCheckpointBaseline(terminalId, term)
        wsMocks.send.mockClear()

        act(() => { reconnectHandler?.() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })

        // The verdict corrects the pane onto a DIFFERENT live terminal: the
        // repair must still re-drive, and this pane holds no checkpoint for
        // the foreign terminal's surface — the honest full hydrate.
        act(() => {
          store.dispatch(applyReconcileAttach({
            tabId: 'tab-v2-stream',
            paneId: 'pane-v2-stream',
            terminalId: 'term-9b-other',
            serverInstanceId: 'srv-9b',
          }))
        })

        const repairAttaches = sentMessages().filter(
          (m) => m?.type === 'terminal.attach' && m.terminalId === 'term-9b-other',
        )
        expect(repairAttaches.at(-1)).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0 })
      })

      it('a non-negotiated (old-server) pane keeps today’s full re-drive chain, bounded at the recovery accounting', async () => {
        wsMocks.capabilities = {} // no paced replay: byte-identical legacy lane
        const { store, terminalId, term } = await renderReconcileFlapPane('legacy')
        await applyCheckpointBaseline(terminalId, term)
        wsMocks.send.mockClear()

        act(() => { reconnectHandler?.() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 4 })

        act(() => {
          store.dispatch(setReconcilePendingPanes({
            paneKeys: ['tab-v2-stream:pane-v2-stream'],
            startedAt: Date.now(),
          }))
        })
        act(() => {
          store.dispatch(applyReconcileAttach({
            tabId: 'tab-v2-stream',
            paneId: 'pane-v2-stream',
            terminalId,
            serverInstanceId: 'srv-9b',
            sessionRef: { provider: 'claude', sessionId: 's-9b-legacy' },
          }))
        })

        // Old-server contract (unchanged by task-009b): the reconcile round
        // still re-drives the pane — the mode-heuristic viewport_hydrates
        // today's code sends, one per pending-window transition, bounded by
        // the recovery accounting — exactly today's wire shape.
        const hydrates = attachMessagesFor(terminalId).filter((m) => m.intent === 'viewport_hydrate')
        expect(hydrates).toHaveLength(2)
        expect(hydrates.every((m) => m.sinceSeq === 0)).toBe(true)
      })
    })

  })

  describe('paced terminal replay consumption (pacedTerminalReplayV1)', () => {
    const PACED_CAPABILITIES = { pacedTerminalReplayV1: true }
    const OSC52_ONLY_FRAME = '\u001b]52;c;aGVsbG8=\u0007'
    const PACED_PAGE_BYTES = 128 * 1024

    async function setupPacedPane(opts?: {
      suffix?: string
      mode?: TerminalPaneContent['mode']
      sessionRef?: TerminalPaneContent['sessionRef']
      negotiated?: boolean
      hidden?: boolean
      skipInitialAttachWait?: boolean
    }) {
      const suffix = opts?.suffix ?? `t${Math.floor(Math.random() * 1e9)}`
      const tabId = `tab-paced-${suffix}`
      const paneId = `pane-paced-${suffix}`
      const requestId = `req-paced-${suffix}`
      const terminalId = `term-paced-${suffix}`
      wsMocks.capabilities = opts?.negotiated === false ? {} : PACED_CAPABILITIES

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: requestId,
        status: 'running',
        mode: opts?.mode ?? 'shell',
        shell: 'system',
        terminalId,
        ...(opts?.sessionRef ? { sessionRef: opts.sessionRef } : {}),
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: paneContent.mode,
              status: 'running',
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: requestId,
              terminalId,
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null, serverInstanceId: 'srv-paced' },
        },
      })

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal'
          ? layout.content
          : paneContent
      }
      const renderAt = (isHidden: boolean) => (
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={readPaneContent()} hidden={isHidden} />
        </Provider>
      )
      const view = render(renderAt(opts?.hidden === true))

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      await waitFor(() => {
        expect(terminalInstances.length).toBeGreaterThan(0)
      })
      if (opts?.skipInitialAttachWait !== true) {
        await waitFor(() => {
          expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toBe(true)
        })
      }

      const term = terminalInstances[terminalInstances.length - 1]
      return {
        store,
        tabId,
        paneId,
        terminalId,
        term,
        rerenderAt: (isHidden: boolean) => act(() => { view.rerender(renderAt(isHidden)) }),
      }
    }

    function creditMessages() {
      return sentMessages().filter((msg) => msg?.type === 'terminal.replay.credit')
    }

    function attachMessagesFor(terminalId: string) {
      return sentMessages().filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    }

    function captureRaf() {
      const callbacks: FrameRequestCallback[] = []
      requestAnimationFrameSpy!.mockImplementation((cb) => {
        callbacks.push(cb)
        return callbacks.length
      })
      return () => {
        while (callbacks.length > 0) {
          callbacks.shift()!(0)
        }
      }
    }

    describe('replay credit regression', () => {
      const INCOMPLETE_SGR = '\x1b[38;5;2;48;2;33;58'
      const CONTINUATION = ';255mAFTER\r\n'
      const PREFIX = 'BEFORE\r\n'
      const RESET = '\x18\x1bc\x1b[?25h'
      const ENVELOPES = ['single', 'batch', 'barrier-batch'] as const

      function deliverOutput(envelope: typeof ENVELOPES[number], terminalId: string, seq: number, data: string, source: 'replay' | 'live' = 'replay') {
        if (envelope === 'single') {
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: seq, seqEnd: seq, data, source })
        } else {
          messageHandler!({
            type: 'terminal.output.batch', terminalId, source,
            seqStart: seq, seqEnd: seq, serializedBytes: data.length + 256, data,
            segments: [{ seqStart: seq, seqEnd: seq, endOffset: data.length, rawFrameCount: 1,
              ...(envelope === 'barrier-batch' ? { barrier: 'control' } : {}) }],
          })
        }
      }

      function ready(terminalId: string, target: number) {
        messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: target, replayFromSeq: 1, replayToSeq: target })
      }

      function readPacedCheckpoint(terminalId: string, paneId: string) {
        return __readTerminalSurfaceCheckpointForTests(terminalId, {
          streamId: latestStreamIdByTerminal.get(terminalId), serverInstanceId: 'srv-paced',
        }, { paneId })
      }

      function holdWrites(term: typeof terminalInstances[number]) {
        const held: Array<() => void> = []
        term.write.mockImplementation((_data: string, callback?: () => void) => { if (callback) held.push(callback) })
        return held
      }

      it('projects a deferred delivery-gap reconstruction as keepalive when hidden before content arrives', async () => {
        const { terminalId, paneId, tabId, store, term, rerenderAt } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf()
        act(() => { ready(terminalId, 1); deliverOutput('single', terminalId, 1, PREFIX + '\x07'); pump() })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
        term.write.mockClear()
        wsMocks.send.mockClear()
        const held = holdWrites(term)

        act(() => { messageHandler!({ type: 'terminal.output.gap', terminalId, fromSeq: 2, toSeq: 5, reason: 'queue_overflow' }); pump() })
        const probe = attachMessagesFor(terminalId)[0]!
        expect(probe).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0 })
        expect(term.write).not.toHaveBeenCalled()
        rerenderAt(true)
        expect(term.write).not.toHaveBeenCalled()
        expect(attachMessagesFor(terminalId)).toHaveLength(1)

        act(() => { ready(terminalId, 8); deliverOutput('single', terminalId, 1, 'REBUILT\r\n'); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([RESET])
        expect(held).toHaveLength(1)
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        const replacement = attachMessagesFor(terminalId).at(-1)!
        expect(replacement.attachRequestId).not.toBe(probe.attachRequestId)
        expect(replacement).toMatchObject({ terminalId, intent: 'keepalive_delta', sinceSeq: 0, surfaceReset: true })
        expect(attachMessagesFor(terminalId)).toHaveLength(2)

        act(() => { ready(terminalId, 1); deliverOutput('single', terminalId, 1, 'REBUILT\r\n'); pump(); held.shift()!(); pump() })
        expect(creditMessages().at(-1)).toMatchObject({ attachRequestId: replacement.attachRequestId, consumedSeq: 1 })
        expect(store.getState().panes.layouts[tabId]).toMatchObject({ content: { terminalId } })
        expect(terminalInstances.at(-1)).toBe(term)
        expect(sentMessages().some(msg => msg?.type === 'terminal.kill')).toBe(false)
        expect(term.clear).not.toHaveBeenCalled()
        expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
        // The replacement send consumes no additional recovery admission.
        // Reconnect while visible so this checks admission, independent of
        // the hidden-pane lifetime/background scheduling contract.
        rerenderAt(false)
        const before = attachMessagesFor(terminalId).length
        for (let attempt = 0; attempt < 3; attempt++) act(() => { reconnectHandler!(); pump(); while (held.length) { held.shift()!(); pump() } })
        expect(attachMessagesFor(terminalId)).toHaveLength(before + 2)
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      })

      it.each(ENVELOPES)('credits a page-ending incomplete SGR after the real %s write completes', async (envelope) => {
        const { terminalId, paneId, term } = await setupPacedPane({ suffix: `sgr-${envelope}`, mode: 'codex' })
        const pump = captureRaf()
        const held = holdWrites(term)
        act(() => { ready(terminalId, 2); deliverOutput(envelope, terminalId, 1, PREFIX + INCOMPLETE_SGR); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([PREFIX])
        expect(creditMessages()).toEqual([])
        expect(held).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        expect(creditMessages()).toEqual([expect.objectContaining({ terminalId, consumedSeq: 1, attachRequestId: latestAttachRequestIdForTerminal(terminalId) })])
        act(() => { deliverOutput(envelope, terminalId, 2, CONTINUATION); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([PREFIX, INCOMPLETE_SGR + CONTINUATION])
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
        act(() => { held.shift()!(); pump() })
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 2 })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
      })

      it.each([
        { label: 'OSC52', data: PREFIX + OSC52_ONLY_FRAME },
        { label: 'Codex BEL', data: PREFIX + '\x07' },
      ])('credits a mixed $label frame without claiming strict applied progress', async ({ data }) => {
        const { terminalId, paneId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf(), held = holdWrites(term)
        act(() => { ready(terminalId, 1); deliverOutput('single', terminalId, 1, data); pump() })
        expect(term.write.mock.calls.map(([value]: [string]) => value)).toEqual([PREFIX])
        expect(creditMessages()).toEqual([])
        act(() => { held.shift()!(); pump() })
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
      })

      it('orders fully filtered acknowledgement behind a held visible write', async () => {
        const { terminalId, paneId, term } = await setupPacedPane()
        const pump = captureRaf(), held = holdWrites(term)
        act(() => { ready(terminalId, 2); deliverOutput('single', terminalId, 1, PREFIX); deliverOutput('single', terminalId, 2, OSC52_ONLY_FRAME); pump() })
        expect(creditMessages()).toEqual([])
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
        expect(term.write).toHaveBeenCalledTimes(1)
        act(() => { held.shift()!(); pump() })
        expect(creditMessages()).toEqual([expect.objectContaining({ consumedSeq: 2 })])
        expect(readPacedCheckpoint(terminalId, paneId)).toMatchObject({ parserAppliedSeq: 1, surfaceCoverageSeq: 2 })
      })

      it.each([
        { label: 'CSI', fragment: INCOMPLETE_SGR, continuation: CONTINUATION },
        { label: 'OSC', fragment: '\x1b]0;title', continuation: '\x07AFTER\r\n' },
      ])('buffered-only $label can credit but cannot save reconstructable coverage', async ({ fragment, continuation }) => {
        const { terminalId, paneId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf()
        act(() => { ready(terminalId, 2); deliverOutput('single', terminalId, 1, fragment) })
        expect(creditMessages()).toEqual([])
        expect(term.write).not.toHaveBeenCalled()
        act(() => pump())
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
        act(() => { deliverOutput('single', terminalId, 2, continuation); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([fragment + continuation])
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 2 })
      })

      const finalCases = ENVELOPES.flatMap(envelope => ['SGR', 'OSC'].flatMap(kind => [false, true].flatMap(bufferedOnly => ['before', 'after'].map(timing => ({ envelope, kind, bufferedOnly, timing })))))
      it.each(finalCases)('retains final replay $kind into live ($envelope, buffered=$bufferedOnly, continuation=$timing completion)', async ({ envelope, kind, bufferedOnly, timing }) => {
        const { terminalId, paneId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf(), held = holdWrites(term)
        const fragment = kind === 'SGR' ? INCOMPLETE_SGR : '\x1b]0;title'
        const continuation = kind === 'SGR' ? CONTINUATION : '\x07AFTER\r\n'
        const prefix = bufferedOnly ? '' : PREFIX
        act(() => { ready(terminalId, 1); deliverOutput(envelope, terminalId, 1, prefix + fragment); pump() })
        expect(creditMessages()).toEqual(bufferedOnly ? [expect.objectContaining({ consumedSeq: 1 })] : [])
        if (timing === 'after') act(() => { held.splice(0).forEach(cb => cb()); pump() })
        act(() => { deliverOutput(envelope, terminalId, 2, continuation, 'live'); pump() })
        act(() => { while (held.length) { held.shift()!(); pump() } })
        expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).toBe(prefix + fragment + continuation)
        expect(creditMessages().every(msg => msg.consumedSeq <= 1)).toBe(true)
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
      })

      it('orders buffered ownership behind earlier real output and suppresses a known old startup query remainder', async () => {
        const { terminalId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf(), held = holdWrites(term)
        act(() => { ready(terminalId, 2); deliverOutput('single', terminalId, 1, PREFIX); pump(); deliverOutput('single', terminalId, 2, '\x1b]11;?'); pump() })
        expect(creditMessages()).toEqual([])
        act(() => { held.shift()!(); pump(); deliverOutput('single', terminalId, 3, '\x07AFTER\r\n', 'live'); pump(); held.splice(0).forEach(cb => cb()); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data).join('')).toBe(PREFIX + 'AFTER\r\n')
        expect(sentMessages().filter(msg => msg.type === 'terminal.input')).toEqual([])
      })

      it('ignores an unmounted late mixed-write completion', async () => {
        const { terminalId, paneId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf(), held = holdWrites(term)
        act(() => { ready(terminalId, 1); deliverOutput('single', terminalId, 1, PREFIX + INCOMPLETE_SGR); pump() })
        const deliver = messageHandler!
        cleanup()
        act(() => { held.splice(0).forEach(cb => cb()); pump(); deliver({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 2, data: CONTINUATION }) })
        expect(creditMessages()).toEqual([])
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
      })

      async function dirtyPane() {
        const pane = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf()
        act(() => { ready(pane.terminalId, 1); deliverOutput('single', pane.terminalId, 1, 'SAFE\r\n'); pump() })
        expect(readPacedCheckpoint(pane.terminalId, pane.paneId)).toMatchObject({ surfaceCoverageSeq: 1 })
        act(() => { deliverOutput('single', pane.terminalId, 2, 'PARTIAL' + INCOMPLETE_SGR, 'live'); pump() })
        return { ...pane, pump }
      }

      it.each(['before completion', 'pending at completion'] as const)('uses the resized viewport and checkpoint after a held reconstruction callback completes (layout %s)', async (layoutTiming) => {
        let notifyResize: (() => void) | undefined
        vi.stubGlobal('ResizeObserver', class extends MockResizeObserver {
          constructor(callback: () => void) { super(); notifyResize = callback }
        })
        const { terminalId, paneId, term, pump } = await dirtyPane()
        const originalEpoch = readPacedCheckpoint(terminalId, paneId)!.geometryEpoch
        const held = holdWrites(term)
        wsMocks.send.mockClear()
        act(() => { reconnectHandler!(); pump() })
        expect(term.write.mock.calls.at(-1)?.[0]).toBe(RESET)
        expect(held).toHaveLength(1)
        expect(attachMessagesFor(terminalId)).toEqual([])

        const runtime = runtimeMocks.instances.at(-1)!
        runtime.fit.mockImplementation(() => { term.cols = 132; term.rows = 40 })
        const resizeMessages = () => sentMessages().filter(msg => msg?.type === 'terminal.resize' && msg.terminalId === terminalId)
        if (layoutTiming === 'before completion') {
          act(() => { notifyResize!(); pump() })
          expect(resizeMessages().at(-1)).toMatchObject({ cols: 132, rows: 40 })
          expect(attachMessagesFor(terminalId)).toEqual([])
          act(() => { held.shift()!(); pump() })
        } else {
          // The post-hook task precedes the requested layout flush. The
          // replacement boundary must fit rather than read the old size.
          act(() => { held.shift()!() })
          act(() => { notifyResize!(); pump() })
          expect(resizeMessages()).toEqual([])
        }
        const replacement = attachMessagesFor(terminalId).at(-1)!
        expect(replacement).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0, surfaceReset: true, cols: 132, rows: 40 })
        act(() => { ready(terminalId, 3); deliverOutput('single', terminalId, 1, 'RESIZED-BASELINE\r\n'); deliverOutput('single', terminalId, 2, 'MORE\r\n'); deliverOutput('single', terminalId, 3, 'DONE\r\n'); pump(); while (held.length) { held.shift()!(); pump() } })
        expect(readPacedCheckpoint(terminalId, paneId)).toMatchObject({ cols: 132, rows: 40, parserAppliedSeq: 3, surfaceCoverageSeq: 3 })
        expect(readPacedCheckpoint(terminalId, paneId)!.geometryEpoch).toBe(originalEpoch + 1)
        const resizeCount = resizeMessages().length
        act(() => { notifyResize!(); pump() })
        expect(resizeMessages()).toHaveLength(resizeCount)
        act(() => { reconnectHandler!(); pump() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ intent: 'transport_reconnect', sinceSeq: 3, cols: 132, rows: 40 })
        expect(terminalInstances.at(-1)).toBe(term)
        expect(sentMessages().some(msg => msg?.type === 'terminal.kill')).toBe(false)
      })

      it('waits for reset success and the post-hook task before advertising a full hydrate', async () => {
        const { terminalId, paneId, term, pump } = await dirtyPane()
        const held = holdWrites(term), old = latestAttachRequestIdForTerminal(terminalId)
        act(() => { reconnectHandler!(); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        expect(term.write.mock.calls.at(-1)?.[0]).toBe(RESET)
        expect(creditMessages().every(msg => msg.consumedSeq <= 1)).toBe(true)
        act(() => held.shift()!())
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => pump())
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, surfaceReset: true })
        expect(latestAttachRequestIdForTerminal(terminalId)).not.toBe(old)
        act(() => { ready(terminalId, 1); messageHandler!({ type: 'terminal.modes.sync', terminalId, data: '\x1b[?25h' }); deliverOutput('single', terminalId, 1, 'NEW' + INCOMPLETE_SGR); pump() })
        act(() => { while (held.length) { held.shift()!(); pump() } })
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
        act(() => reconnectHandler!())
        expect(attachMessagesFor(terminalId)).toHaveLength(2)
      })

      it.each(['tagged', 'untagged'])('fences old %s ready/output/batch/gap/modes before preprocessing during local reconstruction', async (tagged) => {
        const { terminalId, term, pump } = await dirtyPane()
        const held = holdWrites(term)
        const old = latestAttachRequestIdForTerminal(terminalId)
        const streamId = latestStreamIdByTerminal.get(terminalId)
        const direct = wsMocks.onMessage.mock.calls.at(-1)![0]
        act(() => { reconnectHandler!(); pump() })
        const writes = term.write.mock.calls.length, credits = creditMessages().length
        const tags = tagged === 'tagged' ? { attachRequestId: old, streamId } : {}
        act(() => {
          direct({ type: 'terminal.attach.ready', terminalId, headSeq: 500, replayFromSeq: 1, replayToSeq: 500, ...tags })
          direct({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 3, data: 'OLD\x1b]0;POLLUTION', ...tags })
          direct({ type: 'terminal.output.batch', terminalId, source: 'live', seqStart: 4, seqEnd: 4, serializedBytes: 300, data: 'OLD', segments: [{ seqStart: 4, seqEnd: 4, endOffset: 3, rawFrameCount: 1 }], ...tags })
          direct({ type: 'terminal.output.gap', terminalId, fromSeq: 1, toSeq: 4, reason: 'queue_overflow', ...tags })
          direct({ type: 'terminal.modes.sync', terminalId, data: '\x1b[?1049h', ...tags })
          pump()
        })
        expect(term.write.mock.calls).toHaveLength(writes)
        expect(creditMessages()).toHaveLength(credits)
        expect(screen.queryByText(/output was lost/i)).toBeNull()
        act(() => { held.shift()!(); pump(); ready(terminalId, 1); deliverOutput('single', terminalId, 1, 'CURRENT'); pump(); held.splice(0).forEach(cb => cb()); pump() })
        expect(term.write.mock.calls.at(-1)?.[0]).toBe('CURRENT')
        expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
      })

      it('settles an actual reset throw without attach or success and permits later recovery', async () => {
        const { terminalId, paneId, term, pump } = await dirtyPane()
        term.write.mockImplementation((data: string, cb?: () => void) => { if (data === RESET) throw new Error('reset rejected'); cb?.() })
        act(() => { reconnectHandler!(); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        expect(readPacedCheckpoint(terminalId, paneId)).toMatchObject({ surfaceCoverageSeq: 1 })
        term.write.mockImplementation((_data: string, cb?: () => void) => cb?.())
        act(() => { reconnectHandler!(); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(2)
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, surfaceReset: true })
      })

      it.each(['before', 'after'])('supersedes a reset %s submission without authorizing the old ticket', async timing => {
        const { store, tabId, paneId, terminalId, term, pump } = await dirtyPane()
        const held = holdWrites(term)
        act(() => { reconnectHandler!(); if (timing === 'after') pump() })
        // Let React execute the refresh effect before flushing the queue;
        // otherwise the purported "before" case submits the old reset.
        act(() => { store.dispatch(requestPaneRefresh({ tabId, paneId })) })
        act(() => pump())
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        if (timing === 'after') {
          expect(attachMessagesFor(terminalId)).toHaveLength(1)
          act(() => { held.shift()!(); pump() })
        }
        expect(attachMessagesFor(terminalId)).toHaveLength(2)
      })

      it.each(['unmount', 'connection', 'hidden'])('abandons an in-flight reset on %s and rejects its late success', async change => {
        const { store, terminalId, term, rerenderAt, pump } = await dirtyPane()
        const held = holdWrites(term)
        act(() => { reconnectHandler!(); pump() })
        if (change === 'unmount') cleanup()
        else if (change === 'connection') act(() => { setWsIsReady(false); store.dispatch(setConnectionStatus('disconnected')) })
        else rerenderAt(true)
        act(() => { held.splice(0).forEach(cb => cb()); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
      })

      it('keeps the new transport ticket when React commits ready after the reconnect callback', async () => {
        const { store, terminalId, term, pump } = await dirtyPane()
        act(() => { store.dispatch(setConnectionStatus('disconnected')) })
        const held = holdWrites(term)
        act(() => { reconnectHandler!(); store.dispatch(setConnectionStatus('ready')) })
        act(() => pump())
        expect(held).toHaveLength(1)
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, surfaceReset: true })
        expect(attachMessagesFor(terminalId)).toHaveLength(2)
      })

      it.each(['queued', 'submitted'] as const)('preserves the admitted reset when a newer automatic attempt is refused ($0)', async phase => {
        const { terminalId, term, pump } = await dirtyPane()
        const held = holdWrites(term)
        act(() => {
          for (let attempt = 0; attempt < 3; attempt++) reconnectHandler!()
          if (phase === 'submitted') pump()
        })
        expect(held).toHaveLength(phase === 'submitted' ? 1 : 0)
        act(() => { reconnectHandler!() })
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
        act(() => pump())
        expect(held).toHaveLength(1)
        expect(reconstructionWrites(term)).toHaveLength(1)
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(2)
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, surfaceReset: true })
        // The last admitted operation already owns its budget. Its genuine
        // success must request and finish the replacement content, even when
        // a later request was refused; the surface cannot remain reset-only.
        act(() => {
          ready(terminalId, 2)
          messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, source: 'replay', data: 'REBUILT-AFTER-ADMITTED-RESET\r\n' })
          pump()
        })
        expect(held).toHaveLength(1)
        expect(creditMessages().at(-1)).not.toMatchObject({ consumedSeq: 2 })
        act(() => { held.shift()!(); pump() })
        expect(creditMessages().at(-1)).toMatchObject({ attachRequestId: latestAttachRequestIdForTerminal(terminalId), consumedSeq: 2 })
        expectTerminalWriteContaining(term, 'REBUILT-AFTER-ADMITTED-RESET')
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      })

      it.each(['refresh', 'retry'] as const)('keeps consumed high-water after explicit %s while replaying the same bytes', async action => {
        const { store, tabId, paneId, terminalId, pump } = await dirtyPane()
        act(() => {
          deliverOutput('single', terminalId, 3, CONTINUATION, 'live')
          deliverOutput('single', terminalId, 4, 'NEW-LIVE\r\n', 'live')
          pump()
        })
        if (action === 'retry') {
          for (let attempt = 0; attempt < 4; attempt++) act(() => { reconnectHandler!(); pump() })
          expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
          fireEvent.click(screen.getByRole('button', { name: 'Retry terminal restore' }))
        } else {
          act(() => { store.dispatch(requestPaneRefresh({ tabId, paneId })) })
        }
        act(() => pump())
        const afterExplicit = attachMessagesFor(terminalId).length
        act(() => {
          ready(terminalId, 4)
          deliverOutput('single', terminalId, 1, 'SAFE\r\n')
          deliverOutput('single', terminalId, 2, 'PARTIAL' + INCOMPLETE_SGR)
          deliverOutput('single', terminalId, 3, CONTINUATION)
          deliverOutput('single', terminalId, 4, 'NEW-LIVE\r\n')
          pump()
        })
        // Explicit user intent resets the streak, with one attempt charged
        // for its attach. Re-consuming positions 1..4 refunds nothing.
        for (let attempt = 0; attempt < 3; attempt++) act(() => { reconnectHandler!(); pump() })
        expect(attachMessagesFor(terminalId)).toHaveLength(afterExplicit + 2)
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      })

      it('waits for an old in-flight mutation before reset and excludes its late credit', async () => {
        const { terminalId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf(), held = holdWrites(term)
        act(() => { ready(terminalId, 1); deliverOutput('single', terminalId, 1, 'OLD' + INCOMPLETE_SGR); pump(); reconnectHandler!(); pump() })
        expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual(['OLD'])
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        act(() => { held.shift()!(); pump() })
        expect(term.write.mock.calls.at(-1)?.[0]).toBe(RESET)
        expect(creditMessages()).toEqual([])
        act(() => { held.shift()!(); pump() })
        expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, surfaceReset: true })
      })

      it.each([true, false])('counts genuinely newer mixed/live consumption independently of pinned coverage (fresh=$fresh)', async fresh => {
        const { terminalId, term, pump } = await dirtyPane()
        act(() => { deliverOutput('single', terminalId, 3, CONTINUATION, 'live'); deliverOutput('single', terminalId, 4, 'FRESH\r\n', 'live'); pump() })
        for (let attempt = 0; attempt < 5; attempt++) {
          const before = attachMessagesFor(terminalId).length
          act(() => { reconnectHandler!(); pump() })
          if (!fresh && attempt >= 3) { expect(attachMessagesFor(terminalId)).toHaveLength(before); break }
          expect(attachMessagesFor(terminalId)).toHaveLength(before + 1)
          act(() => { ready(terminalId, 3); deliverOutput('single', terminalId, 1, 'SAFE\r\n'); deliverOutput('single', terminalId, 2, 'PARTIAL' + INCOMPLETE_SGR); deliverOutput('single', terminalId, 3, CONTINUATION); pump() })
          if (fresh) act(() => { deliverOutput('single', terminalId, 5 + attempt, 'NEW' + OSC52_ONLY_FRAME, 'live'); pump() })
        }
        expect(term.write).toHaveBeenCalled()
        expect(screen.queryByTestId('restore-recovery-retry') !== null).toBe(!fresh)
      })

      it.each(['success', 'throw', 'supersede'] as const)('only genuine newer completion refunds a progressless attempt ($0)', async outcome => {
        const { terminalId, term, pump } = await dirtyPane()
        act(() => { reconnectHandler!(); pump(); ready(terminalId, 1); deliverOutput('single', terminalId, 1, 'SAFE\r\n'); pump() })
        const held = holdWrites(term)
        if (outcome === 'throw') term.write.mockImplementation(() => { throw new Error('newer range rejected') })
        act(() => { deliverOutput('single', terminalId, 3, 'NEW' + OSC52_ONLY_FRAME, 'live'); pump() })
        // Reception/submission alone must not clear the progressless budget.
        const before = attachMessagesFor(terminalId).length
        if (outcome === 'supersede') act(() => { reconnectHandler!(); while (held.length) { held.shift()!(); pump() } })
        else if (outcome === 'success') act(() => { held.shift()!(); pump() })
        term.write.mockImplementation((_data: string, done?: () => void) => done?.())
        for (let i = 0; i < 4; i++) act(() => { reconnectHandler!(); pump(); ready(terminalId, 1) })
        // Success resets to three fresh attempts; failure and stale completion
        // leave the earlier progressless attempt(s) charged.
        expect(attachMessagesFor(terminalId).length - before).toBe(outcome === 'success' ? 3 : 2)
        expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
      })

      it.each(
        (['malformed batch', 'stream mismatch', 'single jump', 'batch jump'] as const).flatMap(loss =>
          (['matching', 'split matching', 'split divergent'] as const).map(suffix => ({ loss, suffix })),
        ),
      )('preserves recognized obsolete query suffix ownership through $loss with $suffix live bytes', async ({ loss, suffix }) => {
        terminalThemeMocks.getTerminalTheme.mockReturnValue({ background: '#112233' })
        const { store, terminalId, paneId, term } = await setupPacedPane({ mode: 'opencode' })
        const pump = captureRaf()
        const emulatorCount = terminalInstances.length
        act(() => { store.dispatch(setConnectionStatus('ready')); ready(terminalId, 2); deliverOutput('single', terminalId, 1, '\x1b]11;'); pump() })
        expect(terminalWriteStrings(term)).toEqual([])
        expect(sentMessages().filter(msg => msg?.type === 'terminal.input')).toEqual([])
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()

        act(() => {
          if (loss === 'malformed batch') {
            messageHandler!({
              type: 'terminal.output.batch', terminalId, source: 'replay',
              seqStart: 2, seqEnd: 2, data: 'REJECTED', serializedBytes: -1,
              segments: [{ seqStart: 2, seqEnd: 2, endOffset: 8, rawFrameCount: 1 }],
            })
          } else if (loss === 'stream mismatch') {
            messageHandler!({ type: 'terminal.output', terminalId, streamId: 'other-stream', seqStart: 2, seqEnd: 2, data: 'REJECTED' })
          }
          pump()
        })

        const held = holdWrites(term)
        const envelope = loss === 'batch jump' ? 'batch' : 'single'
        const notices = loss === 'single jump' || loss === 'batch jump'
          ? ['\r\n[Output gap 2-2: unexplained sequence jump]\r\n']
          : []
        const creditsBeforeMatching = creditMessages().slice()
        act(() => { deliverOutput(envelope, terminalId, 3, suffix === 'matching' ? '?\x07AFTER\r\n' : '?', 'live'); pump() })
        if (notices.length && suffix !== 'matching') {
          expect(terminalWriteStrings(term).join('')).toBe(notices.join(''))
          act(() => { held.shift()!(); pump() })
        }

        let creditsBeforeCompletion = creditsBeforeMatching
        if (suffix !== 'matching') {
          // A possibly obsolete first byte belongs to the boundary until the
          // next frame either matches the rest or proves it is fresh content.
          expect(terminalWriteStrings(term).join('')).toBe(notices.join(''))
          expect(held).toHaveLength(0)
          expect(sentMessages().filter(msg => msg?.type === 'terminal.input')).toEqual([])
          creditsBeforeCompletion = creditMessages().slice()
          act(() => { deliverOutput(envelope, terminalId, 4, suffix === 'split matching' ? '\x07AFTER\r\n' : 'xAFTER\r\n', 'live'); pump() })
        }

        const fresh = suffix === 'split divergent' ? '?xAFTER\r\n' : 'AFTER\r\n'
        expect(terminalWriteStrings(term).join('')).toBe(notices.join('') + fresh)
        expect(held).toHaveLength(1)
        expect(creditMessages()).toEqual(creditsBeforeCompletion)
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
        expect(sentMessages().filter(msg => msg?.type === 'terminal.input')).toEqual([])
        act(() => { held.shift()!(); pump() })
        expect(creditMessages().at(-1)).toMatchObject({ attachRequestId: latestAttachRequestIdForTerminal(terminalId), consumedSeq: 2 })
        expect(screen.queryByText('Recovering terminal output...')).toBeNull()
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()

        act(() => { deliverOutput(envelope, terminalId, suffix === 'matching' ? 4 : 5, 'FRESH\r\n', 'live'); pump(); held.shift()!(); pump() })
        expect(terminalWriteStrings(term).join('')).toBe(notices.join('') + fresh + 'FRESH\r\n')
        expect(sentMessages().filter(msg => msg?.type === 'terminal.input' || msg?.type === 'terminal.create' || msg?.type === 'terminal.kill')).toEqual([])
        expect(attachMessagesFor(terminalId)).toHaveLength(1)
        expect(terminalInstances).toHaveLength(emulatorCount)
      })

      it.each(['generation', 'gap'] as const)('retires an ordinary pending fragment across a $0 discontinuity', async discontinuity => {
        const { terminalId, term } = await setupPacedPane({ mode: 'codex' })
        const pump = captureRaf()
        act(() => { ready(terminalId, 2); deliverOutput('single', terminalId, 1, INCOMPLETE_SGR); pump() })
        if (discontinuity === 'generation') act(() => { reconnectHandler!(); pump(); ready(terminalId, 1) })
        else act(() => messageHandler!({ type: 'terminal.output.gap', terminalId, fromSeq: 2, toSeq: 2, reason: 'replay_window_exceeded' }))
        const before = term.write.mock.calls.length
        act(() => { deliverOutput('single', terminalId, discontinuity === 'generation' ? 1 : 3, CONTINUATION, 'live'); pump() })
        expect(term.write.mock.calls.slice(before).map(([data]: [string]) => data).join('')).toBe(CONTINUATION)
      })

      it('a failed stream write pins later same-generation filtered credit and recovery', async () => {
        const { terminalId, paneId, term } = await setupPacedPane()
        const pump = captureRaf()
        term.write.mockImplementation(() => { throw new Error('surface rejected') })
        act(() => { ready(terminalId, 2); deliverOutput('single', terminalId, 1, PREFIX); pump(); deliverOutput('single', terminalId, 2, OSC52_ONLY_FRAME); pump() })
        expect(creditMessages()).toEqual([])
        expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
      })

      it.each(['explicit gap', 'malformed batch', 'stream mismatch'] as const)(
        'a failed stream write pins target-reaching loss completion until fresh reconstruction (%s)',
        async loss => {
          const { store, terminalId, paneId, term } = await setupPacedPane({ mode: 'codex' })
          const pump = captureRaf()
          const emulatorCount = terminalInstances.length
          act(() => { store.dispatch(setConnectionStatus('ready')) })
          // Charge a recovery attempt before the failure so later successful
          // same-generation writes cannot silently refund that attempt.
          act(() => { reconnectHandler!(); pump(); ready(terminalId, 2) })
          expect(attachMessagesFor(terminalId)).toHaveLength(2)
          term.write.mockImplementationOnce(() => { throw new Error('accepted surface write rejected') })
          act(() => { deliverOutput('single', terminalId, 1, PREFIX); pump() })
          expect(terminalWriteStrings(term).at(-1)).toBe(PREFIX)
          expect(screen.queryByText('Recovering terminal output...')).not.toBeNull()

          act(() => {
            if (loss === 'explicit gap') {
              messageHandler!({ type: 'terminal.output.gap', terminalId, fromSeq: 2, toSeq: 2, reason: 'replay_window_exceeded' })
            } else if (loss === 'malformed batch') {
              messageHandler!({
                type: 'terminal.output.batch', terminalId, source: 'replay',
                seqStart: 2, seqEnd: 2, data: 'REJECTED', serializedBytes: -1,
                segments: [{ seqStart: 2, seqEnd: 2, endOffset: 8, rawFrameCount: 1 }],
              })
            } else {
              messageHandler!({ type: 'terminal.output', terminalId, streamId: 'other-stream', seqStart: 2, seqEnd: 2, data: 'REJECTED' })
            }
            pump()
          })
          // Reporting seq 2 lost does not report or repair seq 1's failed
          // accepted write, even though the gap reaches the replay target.
          expect(screen.queryByText('Recovering terminal output...')).not.toBeNull()
          expect(creditMessages()).toEqual([])
          expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
          act(() => { deliverOutput('single', terminalId, 3, 'LATER-LIVE\r\n', 'live'); pump() })
          expectTerminalWriteContaining(term, 'LATER-LIVE')
          expect(creditMessages()).toEqual([])
          expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()

          const held = holdWrites(term)
          act(() => { reconnectHandler!(); pump() })
          expect(reconstructionWrites(term)).toHaveLength(1)
          expect(held).toHaveLength(1)
          expect(attachMessagesFor(terminalId)).toHaveLength(2)
          // Two further admissions consume the remaining budget. The next
          // attempt is refused while the latest admitted reset still owns
          // its callback and must be allowed to finish the reconstruction.
          act(() => { reconnectHandler!(); pump(); reconnectHandler!(); pump() })
          expect(screen.getByTestId('restore-recovery-retry')).toBeTruthy()
          expect(attachMessagesFor(terminalId)).toHaveLength(2)
          act(() => { held.shift()!(); pump() })
          expect(reconstructionWrites(term)).toHaveLength(2)
          expect(held).toHaveLength(1)
          expect(attachMessagesFor(terminalId)).toHaveLength(2)
          expect(creditMessages()).toEqual([])
          act(() => { held.shift()!(); pump() })
          const freshAttach = attachMessagesFor(terminalId).at(-1)
          expect(attachMessagesFor(terminalId)).toHaveLength(3)
          expect(freshAttach).toMatchObject({ terminalId, sinceSeq: 0, surfaceReset: true })
          act(() => {
            ready(terminalId, 3)
            messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, source: 'replay', data: 'REBUILT\r\n' })
            pump()
          })
          expect(held).toHaveLength(1)
          expect(screen.queryByText('Recovering terminal output...')).not.toBeNull()
          expect(creditMessages()).toEqual([])
          expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
          act(() => { held.shift()!(); pump() })
          expect(creditMessages().at(-1)).toMatchObject({ attachRequestId: freshAttach.attachRequestId, consumedSeq: 3 })
          expect(readPacedCheckpoint(terminalId, paneId)?.surfaceCoverageSeq).toBe(3)
          expect(screen.queryByText('Recovering terminal output...')).toBeNull()
          expect(screen.queryByTestId('restore-recovery-retry')).toBeNull()
          expect(terminalInstances).toHaveLength(emulatorCount)
          expect(sentMessages().filter(msg => msg?.type === 'terminal.create' || msg?.type === 'terminal.kill')).toEqual([])
        },
      )

      const projections = [
        { name: 'f01-opencode-startup', buffer: 'alternate', mouse: 'any', paste: true, wrap: true, hidden: false },
        { name: 'f04-alt-fold', buffer: 'alternate', mouse: 'none', paste: false, wrap: true, hidden: false },
        { name: 'f06-ris', buffer: 'normal', mouse: 'none', paste: false, wrap: true, hidden: true },
        { name: 'f13-cursor-visibility-restore', buffer: 'normal', mouse: 'none', paste: false, wrap: true, hidden: false },
        { name: 'f15-empty-tracker', buffer: 'normal', mouse: 'none', paste: false, wrap: true, hidden: false },
        { name: 'f16-wraparound-disable', buffer: 'normal', mouse: 'vt200', paste: false, wrap: false, hidden: false },
      ]
      it.each(projections)('reconstructs the actual emulator before supported $name projection and replay', async projection => {
        const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
        const emulator = new actual.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
        const { terminalId, term, pump } = await dirtyPane()
        const data: string[] = [], titles: string[] = []
        emulator.onData(value => data.push(value)); emulator.onTitleChange(value => titles.push(value))
        const realWrite = (bytes: string) => new Promise<void>(done => emulator.write(bytes, done))
        try {
          await realWrite('\x1b[?25lOLD\x1b]0;OBSOLETE')
          term.write.mockImplementation((bytes: string, done?: () => void) => emulator.write(bytes, done))
          const attachCount = attachMessagesFor(terminalId).length
          act(() => { reconnectHandler!(); pump() })
          await waitFor(() => { act(() => pump()); expect(attachMessagesFor(terminalId)).toHaveLength(attachCount + 1) })
          expect(emulator.buffer.active.cursorX).toBe(0)
          expect(emulator.buffer.active.cursorY).toBe(0)
          expect(emulator.buffer.normal.getLine(0)?.translateToString(true)).toBe('')
          expect(data).toEqual([]); expect(titles).toEqual([])
          const fixture = JSON.parse(readFileSync(`port/oracle/baselines/mode-preamble/${projection.name}.json`, 'utf8'))
          act(() => { ready(terminalId, 1); if (fixture.expectedSyncData) messageHandler!({ type: 'terminal.modes.sync', terminalId, data: fixture.expectedSyncData }); deliverOutput('single', terminalId, 1, 'PUBLIC-REPLAY'); pump() })
          await waitFor(() => { act(() => pump()); expect(creditMessages().at(-1)).toMatchObject({ attachRequestId: latestAttachRequestIdForTerminal(terminalId), consumedSeq: 1 }) })
          expect(emulator.buffer.active.type).toBe(projection.buffer)
          expect(emulator.buffer.active.getLine(0)?.translateToString(true)).toBe('PUBLIC-REPLAY')
          expect(emulator.modes.mouseTrackingMode).toBe(projection.mouse)
          expect(emulator.modes.bracketedPasteMode).toBe(projection.paste)
          expect(emulator.modes.wraparoundMode).toBe(projection.wrap)
          expect(emulator.modes.sendFocusMode).toBe(false)
          expect(emulator.modes.synchronizedOutputMode).toBe(false)
          await realWrite('\x1b[?25$p')
          expect(data.at(-1)).toBe(projection.hidden ? '\x1b[?25;2$y' : '\x1b[?25;1$y')
        } finally { emulator.dispose() }
      })

      it('cancels an obsolete DCS payload without emitting its reply during reconstruction', async () => {
        const actual = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm')
        const emulator = new actual.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
        const { terminalId, term, pump } = await dirtyPane()
        const data: string[] = []
        emulator.onData(value => data.push(value))
        try {
          await new Promise<void>(done => emulator.write('OLD\x1bP$qm', done))
          term.write.mockImplementation((bytes: string, done?: () => void) => emulator.write(bytes, done))
          act(() => { reconnectHandler!(); pump() })
          await waitFor(() => { act(() => pump()); expect(attachMessagesFor(terminalId)).toHaveLength(2) })
          expect(data).toEqual([])
          expect(emulator.buffer.active.cursorX).toBe(0)
        } finally { emulator.dispose() }
      })
    })

    it('negotiated attaches send replayPageBytes and omit maxReplayBytes (fresh, refresh, and reconnect attaches)', async () => {
      const { store, tabId, paneId, terminalId } = await setupPacedPane({ suffix: 'params' })

      const mountAttach = attachMessagesFor(terminalId).at(-1)
      expect(mountAttach).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES })
      expect(mountAttach).not.toHaveProperty('maxReplayBytes')

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })
      await waitFor(() => {
        expect(attachMessagesFor(terminalId).length).toBeGreaterThan(1)
      })
      const refreshAttach = attachMessagesFor(terminalId).at(-1)
      expect(refreshAttach).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES, sinceSeq: 0 })
      expect(refreshAttach).not.toHaveProperty('maxReplayBytes')

      wsMocks.send.mockClear()
      reconnectHandler?.()
      await waitFor(() => {
        expect(attachMessagesFor(terminalId).length).toBeGreaterThan(0)
      })
      const reconnectAttach = attachMessagesFor(terminalId).at(-1)
      expect(reconnectAttach).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES })
      expect(reconnectAttach).not.toHaveProperty('maxReplayBytes')
    })

    it('negotiated opencode hydrates carry replayPageBytes too (the legacy opencode budget omission is paced-path moot)', async () => {
      const { terminalId } = await setupPacedPane({
        suffix: 'oc-params',
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses-paced-oc' },
      })

      const mountAttach = attachMessagesFor(terminalId).at(-1)
      expect(mountAttach).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES })
      expect(mountAttach).not.toHaveProperty('maxReplayBytes')
    })

    it('old server (no echo): attach payloads are byte-identical to today and no credit is ever sent', async () => {
      const { terminalId, term } = await setupPacedPane({ suffix: 'legacy-shell', negotiated: false })

      // M1 (task-4 review): pin the COMPLETE legacy attach payload — every
      // field, no toMatchObject partial. Old-server wire behavior must stay
      // byte-identical, so any added/removed/reshaped field fails here.
      const mountAttach = attachMessagesFor(terminalId).at(-1)
      expect(mountAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
        sinceSeq: 0,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-shell:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        maxReplayBytes: PACED_PAGE_BYTES,
        surfaceReset: true,
        createRequestId: 'req-paced-legacy-shell',
        tabId: 'tab-paced-legacy-shell',
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 1,
          replayToSeq: 4,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'AB' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 4, data: 'CD' })
      })

      expectTerminalWriteContaining(term, 'AB')
      expectTerminalWriteContaining(term, 'CD')
      expect(creditMessages()).toEqual([])
    })

    it('old server opencode hydrates keep the budgetless legacy shape (full-shape pin)', async () => {
      const { terminalId } = await setupPacedPane({
        suffix: 'legacy-oc',
        negotiated: false,
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses-paced-legacy-oc' },
      })

      const mountAttach = attachMessagesFor(terminalId).at(-1)
      expect(mountAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
        sinceSeq: 0,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-oc:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        surfaceReset: true,
        expectedSessionRef: { provider: 'opencode', sessionId: 'ses-paced-legacy-oc' },
        createRequestId: 'req-paced-legacy-oc',
        tabId: 'tab-paced-legacy-oc',
      })
      expect(mountAttach).not.toHaveProperty('maxReplayBytes')
      expect(mountAttach).not.toHaveProperty('replayPageBytes')
    })

    it('falls back to legacy wire behavior after the capability echo disappears (negotiation lifecycle)', async () => {
      const { store, tabId, paneId, terminalId } = await setupPacedPane({ suffix: 'lifecycle' })

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })
      await waitFor(() => {
        expect(attachMessagesFor(terminalId).length).toBeGreaterThan(1)
      })
      expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES })

      // The capability is per-connection and resets on disconnect: the next
      // ready arrives WITHOUT the echo (a downgraded server).
      wsMocks.capabilities = {}
      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })
      await waitFor(() => {
        const latest = attachMessagesFor(terminalId).at(-1)
        expect(latest).toMatchObject({ maxReplayBytes: PACED_PAGE_BYTES })
      })
      expect(attachMessagesFor(terminalId).at(-1)).not.toHaveProperty('replayPageBytes')
    })

    it('withheld write consumption sends no credit; release sends exactly one coalesced credit at the correct frontier', async () => {
      const { terminalId, term } = await setupPacedPane({ suffix: 'withhold' })

      const withheldWriteCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) withheldWriteCallbacks.push(onWritten)
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 1,
          replayToSeq: 6,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 4, seqEnd: 6, data: 'def' })
      })

      expect(creditMessages()).toEqual([])
      expect(withheldWriteCallbacks.length).toBeGreaterThan(0)

      act(() => {
        while (withheldWriteCallbacks.length > 0) {
          withheldWriteCallbacks.splice(0).forEach((cb) => cb())
        }
      })

      const credits = creditMessages()
      expect(credits).toHaveLength(1)
      expect(credits[0]).toMatchObject({
        type: 'terminal.replay.credit',
        terminalId,
        attachRequestId: latestAttachRequestIdForTerminal(terminalId),
        streamId: expect.any(String),
        consumedSeq: 6,
      })
    })

    it('fully pre-filtered frames advance consumption without an xterm write and still credit', async () => {
      const { terminalId, term } = await setupPacedPane({ suffix: 'filtered-only' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 5,
          replayFromSeq: 1,
          replayToSeq: 5,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 5, data: OSC52_ONLY_FRAME })
      })

      expect(term.write).not.toHaveBeenCalled()

      const credits = creditMessages()
      expect(credits).toHaveLength(1)
      expect(credits[0]).toMatchObject({
        terminalId,
        attachRequestId: latestAttachRequestIdForTerminal(terminalId),
        consumedSeq: 5,
      })
    })

    it('M2: a non-empty frame that failed to enqueue (disposed surface) never advances the frontier or credits', async () => {
      const { terminalId } = await setupPacedPane({ suffix: 'enqueue-failure' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 1,
          replayToSeq: 6,
        })
      })
      expect(creditMessages()).toEqual([])

      // Dispose the surface (write queue and xterm gone) while the component's
      // message callback still runs — the exact enqueue-failure shape M2 must
      // distinguish from a fully pre-filtered frame. Capture the raw handler
      // first: teardown unregisters it from the ws mock.
      const deliver = messageHandler!
      cleanup()

      act(() => {
        deliver({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 6, data: 'NEVER RENDERED' })
      })

      // The bytes never reached any surface: crediting them would let the
      // server advance its retention cursor past unconsumed output.
      expect(creditMessages()).toEqual([])
    })

    it('mixed page: filtered + applied frames coalesce into one credit at the page frontier with no duplicate output', async () => {
      const { terminalId, term } = await setupPacedPane({ suffix: 'mixed' })
      const pumpRaf = captureRaf()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 1,
          replayToSeq: 8,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: OSC52_ONLY_FRAME })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 8, data: 'hello' })
      })
      pumpRaf()

      const writes = term.write.mock.calls.map(([data]: [string]) => String(data))
      expect(writes).toEqual(['hello'])

      const credits = creditMessages()
      expect(credits).toHaveLength(1)
      expect(credits[0]).toMatchObject({
        terminalId,
        attachRequestId: latestAttachRequestIdForTerminal(terminalId),
        consumedSeq: 8,
      })
    })

    it('negotiated retention gap renders the accessible notice, never the opencode replacement kill, and live output continues', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { store, tabId, terminalId, term } = await setupPacedPane({
        suffix: 'gap-notice',
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses-paced-gap' },
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 100,
          replayFromSeq: 1,
          replayToSeq: 100,
          requestedSinceSeq: 0,
          effectiveSinceSeq: 0,
          oldestRetainedSeq: 1,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 90,
          reason: 'replay_window_exceeded',
          headSeq: 100,
          oldestRetainedSeq: 91,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 91, seqEnd: 95, data: 'LIVE TAIL' })
      })

      const notice = screen.getByTestId('restore-retention-loss-notice')
      expect(notice).toHaveAttribute('role', 'status')
      expect(notice).toHaveAttribute('aria-live', 'polite')
      expect(notice.textContent).toContain('no longer available')

      expect(sentMessages().some((msg) => msg?.type === 'terminal.kill')).toBe(false)
      expectTerminalWriteContaining(term, 'LIVE TAIL')

      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.status).toBe('running')

      const readyEvent = bridge.snapshot().perfEvents.find((event) => event.event === 'terminal.restore.paced_ready')
      expect(readyEvent).toMatchObject({
        terminalId,
        requestedSinceSeq: 0,
        effectiveSinceSeq: 0,
        oldestRetainedSeq: 1,
        headSeq: 100,
      })
      expect(readyEvent?.replayResetReason).toBeUndefined()

      const gapEvent = bridge.snapshot().perfEvents.find((event) => event.event === 'terminal.restore.retention_gap')
      expect(gapEvent).toMatchObject({
        terminalId,
        fromSeq: 1,
        toSeq: 90,
        headSeq: 100,
        oldestRetainedSeq: 91,
      })
    })

    it('negotiated retention gap without bounds fields records unknown bounds and keeps the pane live', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await setupPacedPane({ suffix: 'gap-unknown' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 60,
          replayFromSeq: 1,
          replayToSeq: 60,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 50,
          reason: 'replay_window_exceeded',
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 51, seqEnd: 51, data: 'AFTER GAP' })
      })

      // Absence means UNKNOWN BOUNDS on a negotiated connection — never a
      // silent fall back to non-paced handling.
      expect(screen.getByTestId('restore-retention-loss-notice')).toBeTruthy()
      expectTerminalWriteContaining(term, 'AFTER GAP')

      const gapEvent = bridge.snapshot().perfEvents.find((event) => event.event === 'terminal.restore.retention_gap')
      expect(gapEvent).toMatchObject({ terminalId, fromSeq: 1, toSeq: 50 })
      expect(gapEvent?.headSeq).toBeNull()
      expect(gapEvent?.oldestRetainedSeq).toBeNull()
    })

    it('auto-kill removal: an old-server opencode retention gap never kills, replaces, or changes identity — honest notice and live output instead', async () => {
      // Old servers never emit `replay_window_exceeded` (the paced core is the
      // only emitter, and it requires negotiation), so this shape is only
      // reachable by simulation — but the removal contract must hold on BOTH
      // shapes: no terminal.kill, no replacement spawn, identity unchanged.
      const { store, tabId, terminalId, term } = await setupPacedPane({
        suffix: 'legacy-oc-gap',
        negotiated: false,
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses-paced-legacy-oc-gap' },
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 100,
          replayFromSeq: 1,
          replayToSeq: 100,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 90,
          reason: 'replay_window_exceeded',
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 91, seqEnd: 95, data: 'LIVE TAIL' })
      })

      const sent = sentMessages()
      expect(sent.some((msg) => msg?.type === 'terminal.kill')).toBe(false)
      expect(sent.some((msg) => msg?.type === 'terminal.create')).toBe(false)
      expect(terminalWriteStrings(term).some((entry) => entry.includes('Restarting OpenCode'))).toBe(false)

      // Terminal identity is untouched: same terminalId, still running.
      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.terminalId).toBe(terminalId)
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.status).toBe('running')

      // The old-server honest outcome: a local gap notice, and live output
      // keeps flowing on the unchanged surface.
      expectTerminalWriteContaining(term, 'Output gap 1-90: reconnect window exceeded')
      expectTerminalWriteContaining(term, 'LIVE TAIL')
    })

    it('an exit mid-replay withholds the credit for already-admitted writes; late arid frames neither crash, resurrect, nor credit', async () => {
      const { store, tabId, terminalId, term } = await setupPacedPane({ suffix: 'late-exit' })

      const withheldWriteCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) withheldWriteCallbacks.push(onWritten)
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 1,
          replayToSeq: 6,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'PRE' })
        messageHandler!({ type: 'terminal.exit', terminalId, exitCode: 0 })
      })
      expect(withheldWriteCallbacks.length).toBeGreaterThan(0)
      expect(creditMessages()).toEqual([])

      // The already-admitted write completes AFTER the exit: its consumption
      // may render, but the superseded generation never credits.
      act(() => {
        withheldWriteCallbacks.splice(0).forEach((cb) => cb())
      })
      expectTerminalWriteContaining(term, 'PRE')
      expect(creditMessages()).toEqual([])

      // A late arid-stamped replay frame after the exit is dropped by the
      // existing exited-terminal handling — no crash, no resurrection, no
      // credit.
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 4,
          seqEnd: 6,
          data: 'LATE',
          attachRequestId: latestAttachRequestIdForTerminal(terminalId),
          streamId: latestStreamIdByTerminal.get(terminalId) ?? `test-stream:${terminalId}`,
        })
      })
      expect(creditMessages()).toEqual([])
      expect(terminalWriteStrings(term).some((entry) => entry.includes('LATE'))).toBe(false)

      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.status).toBe('exited')
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.terminalId).toBeUndefined()
    })

    // Delta round-2 finding F1 + focused E2R1 finding 1, the ORDERED
    // complement of the safety case above: when the SERVER sequences the
    // deferred final output before terminal.exit (the natural-exit fix
    // pages the deferred range ONLY on continuation credits and delivers
    // the exit after the session's credited completion — the wire here
    // models that ordered stream), the client must render every final
    // frame and only then fold the exit — no frame lost to the exit
    // boundary, exit last.
    it('an ordered exit mid-replay renders the final output before the exit folds', async () => {
      const { store, tabId, terminalId, term } = await setupPacedPane({ suffix: 'ordered-exit' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 9,
          replayFromSeq: 1,
          replayToSeq: 9,
        })
        // The server-sequenced burst: the deferred final output pages
        // arrive FIRST (stamped with the current attach generation), then
        // terminal.exit LAST.
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'PRE' })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 4,
          seqEnd: 6,
          data: 'FINAL-OUTPUT',
          attachRequestId: latestAttachRequestIdForTerminal(terminalId),
          streamId: latestStreamIdByTerminal.get(terminalId) ?? `test-stream:${terminalId}`,
        })
        messageHandler!({ type: 'terminal.exit', terminalId, exitCode: 0 })
      })

      // Both ranges rendered, in wire order, on the live surface.
      expectTerminalWriteContaining(term, 'PRE')
      expectTerminalWriteContaining(term, 'FINAL-OUTPUT')
      const writes = terminalWriteStrings(term)
      const preAt = writes.findIndex((entry) => entry.includes('PRE'))
      const finalAt = writes.findIndex((entry) => entry.includes('FINAL-OUTPUT'))
      expect(preAt).toBeGreaterThanOrEqual(0)
      expect(finalAt).toBeGreaterThan(preAt)

      // The exit folded AFTER the final output: exited status, identity
      // released. Under the server's credited-exit contract the client's
      // page-end credits DRIVE the deferred pages (the server sequences
      // the exit behind them), so every consumed page is credited and
      // nothing credits after the fold (no page follows the exit).
      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.status).toBe('exited')
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.terminalId).toBeUndefined()
      expect(creditMessages().map((msg) => msg.consumedSeq)).toEqual([3, 6])
    })

    // ── Old-server downgrade matrix (responsive-terminal-restore task-008,
    // matrix cell 6): for EVERY attach intent the client sends, the payloads
    // are byte-identical to the pre-branch shapes when the ready echo lacks
    // the capabilities — full-shape toEqual pins, zero credit sends,
    // maxReplayBytes exactly where today sends it (and absent for opencode).
    // The mount hydrate's full-shape pin is the M1 test above; the sweep
    // below covers the remaining intents. ────────────────────────────────

    it('old server transport_reconnect resumes with the pre-branch payload shape (full-shape pin)', async () => {
      const { terminalId } = await setupPacedPane({ suffix: 'legacy-reconnect', negotiated: false })

      // Establish a checkpoint: the mount hydrate consumed frames 1-4.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 10,
          replayFromSeq: 1,
          replayToSeq: 10,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'HE' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 4, data: 'LLO' })
      })

      wsMocks.send.mockClear()
      act(() => { reconnectHandler?.() })

      const resumeAttach = attachMessagesFor(terminalId).at(-1)
      expect(resumeAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'transport_reconnect',
        cols: 80,
        rows: 24,
        sinceSeq: 4,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-reconnect:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        createRequestId: 'req-paced-legacy-reconnect',
        tabId: 'tab-paced-legacy-reconnect',
      })
      expect(resumeAttach).not.toHaveProperty('maxReplayBytes')
      expect(resumeAttach).not.toHaveProperty('replayPageBytes')
      expect(resumeAttach).not.toHaveProperty('surfaceReset')

      // The remainder arrives and is consumed with ZERO continuation credits.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 10,
          replayFromSeq: 5,
          replayToSeq: 10,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 10, data: ' WORLD' })
      })
      expect(creditMessages()).toEqual([])
    })

    it('old server hidden-pane fallback attach keeps the pre-branch keepalive_delta shape (full-shape pin)', async () => {
      const { terminalId, rerenderAt } = await setupPacedPane({ suffix: 'legacy-hidden', negotiated: false })

      // The visible pane hydrates to completion (the active tab's hydration
      // starts the background pump) and a checkpoint lands at 8.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 1,
          replayToSeq: 8,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 4, data: 'abcd' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 5, seqEnd: 8, data: 'efgh' })
      })

      // The pane goes hidden, then the transport reconnects: the hidden
      // branch re-arms via the background hydration queue (the old-server
      // fallback — no lifetime claim exists), and the pump grant attaches
      // the keepalive_delta catch-up.
      rerenderAt(true)
      wsMocks.send.mockClear()
      act(() => { reconnectHandler?.() })

      const hiddenAttach = await waitFor(() => {
        const found = attachMessagesFor(terminalId).at(-1)
        expect(found).toBeTruthy()
        return found
      })
      expect(hiddenAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'keepalive_delta',
        cols: 80,
        rows: 24,
        sinceSeq: 8,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-hidden:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'background',
        createRequestId: 'req-paced-legacy-hidden',
        tabId: 'tab-paced-legacy-hidden',
      })
      expect(hiddenAttach).not.toHaveProperty('maxReplayBytes')
      expect(hiddenAttach).not.toHaveProperty('replayPageBytes')
      expect(hiddenAttach).not.toHaveProperty('surfaceReset')
      expect(creditMessages()).toEqual([])
    })

    it('old server reveal promotion attaches with the pre-branch hydrate shape (full-shape pin)', async () => {
      const { terminalId, rerenderAt } = await setupPacedPane({
        suffix: 'legacy-reveal',
        negotiated: false,
        hidden: true,
        skipInitialAttachWait: true,
      })

      // A freshly-mounted hidden pane attaches NOTHING (it waits for reveal).
      expect(attachMessagesFor(terminalId)).toHaveLength(0)

      // Reveal: the deferred hydrate fires with today's exact legacy shape.
      rerenderAt(false)
      const revealAttach = await waitFor(() => {
        const found = attachMessagesFor(terminalId).at(-1)
        expect(found).toBeTruthy()
        return found
      })
      expect(revealAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
        sinceSeq: 0,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-reveal:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        maxReplayBytes: PACED_PAGE_BYTES,
        surfaceReset: true,
        createRequestId: 'req-paced-legacy-reveal',
        tabId: 'tab-paced-legacy-reveal',
      })
      expect(revealAttach).not.toHaveProperty('replayPageBytes')
      expect(creditMessages()).toEqual([])
    })

    it('old server load-more-history attach keeps the pre-branch shape (full-shape pin)', async () => {
      const { terminalId } = await setupPacedPane({ suffix: 'legacy-loadmore', negotiated: false })

      // The legacy byte-budget truncation: the recoverable-truncation banner
      // (the only "load more" trigger — an old-server shape the client has
      // kept since the Node-server era).
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 100,
          replayFromSeq: 1,
          replayToSeq: 100,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 90,
          reason: 'replay_budget_exceeded',
        })
      })
      expect(screen.getByRole('button', { name: 'Load earlier terminal history' })).toBeTruthy()

      wsMocks.send.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Load earlier terminal history' }))

      const loadMoreAttach = attachMessagesFor(terminalId).at(-1)
      expect(loadMoreAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
        sinceSeq: 0,
        attachRequestId: expect.stringMatching(/^pane-paced-legacy-loadmore:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        // Today's load-more hydrate carries NO replay budget (pre-branch the
        // handler passes no maxReplayBytes). The fresh-surface claim persists
        // when the truncation gap completes the attach (the gap completion
        // path keeps the marker), so the surfaceReset re-claim is today's
        // shape too.
        surfaceReset: true,
        createRequestId: 'req-paced-legacy-loadmore',
        tabId: 'tab-paced-legacy-loadmore',
      })
      expect(loadMoreAttach).not.toHaveProperty('maxReplayBytes')
      expect(loadMoreAttach).not.toHaveProperty('replayPageBytes')
      expect(creditMessages()).toEqual([])
    })

    it('downgrade lifecycle: after an old-server reconnect the next attach uses the legacy shape even though the previous connection was negotiated', async () => {
      // Matrix cell 7 (extend the negotiation-reset pin): the first
      // connection negotiated paced replay (replayPageBytes attaches); the
      // reconnect lands on an old server (the ws-client resets capabilities
      // on disconnect and the new ready carries none — pinned in
      // ws-client.reconcile.test.ts) — the NEXT attach must use the legacy
      // shape, and the pane must never emit a continuation credit again.
      const { terminalId } = await setupPacedPane({ suffix: 'downgrade' })
      const mountAttach = attachMessagesFor(terminalId).at(-1)
      expect(mountAttach).toMatchObject({ replayPageBytes: PACED_PAGE_BYTES })

      // A checkpoint lands at 6 on the negotiated connection.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 6,
          replayFromSeq: 1,
          replayToSeq: 6,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 4, seqEnd: 6, data: 'def' })
      })

      // The downgrade: the reconnect's ready carries no capabilities.
      wsMocks.capabilities = {}
      wsMocks.send.mockClear()
      act(() => { reconnectHandler?.() })

      const resumeAttach = attachMessagesFor(terminalId).at(-1)
      expect(resumeAttach).toEqual({
        type: 'terminal.attach',
        terminalId,
        intent: 'transport_reconnect',
        cols: 80,
        rows: 24,
        sinceSeq: 6,
        attachRequestId: expect.stringMatching(/^pane-paced-downgrade:\d+:[A-Za-z0-9_-]{6}$/),
        priority: 'foreground',
        createRequestId: 'req-paced-downgrade',
        tabId: 'tab-paced-downgrade',
      })
      expect(resumeAttach).not.toHaveProperty('replayPageBytes')
      expect(resumeAttach).not.toHaveProperty('maxReplayBytes')

      // The previously-negotiated pane consumes the remainder with ZERO
      // continuation credits — the paced consumption state died with the
      // old connection.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 10,
          replayFromSeq: 7,
          replayToSeq: 10,
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 7, seqEnd: 10, data: ' tail' })
      })
      expect(creditMessages()).toEqual([])
    })

    it('old-server retention shapes (silent tail, byte-budget gap, backlog gap) never kill, replace, or change identity', async () => {
      // Matrix cell 8: an old-server-shaped stream NEVER sends
      // `replay_window_exceeded` (the paced core is its only emitter and it
      // requires negotiation) — the shapes an old server CAN produce are the
      // byte-budget truncation gap, the slow-link backlog gap, and the
      // SILENT retained tail. None of them may trigger any kill/replacement
      // path (dead post-task-5). The simulated `replay_window_exceeded`
      // shape on a non-negotiated connection is pinned above; this test
      // covers the real old-server shapes.
      const { store, tabId, terminalId, term } = await setupPacedPane({
        suffix: 'legacy-shapes',
        negotiated: false,
        mode: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses-paced-legacy-shapes' },
      })

      // Shape 1 — the byte-budget truncation gap (recoverable): the honest
      // Load-more banner, not a kill or replacement.
      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 100,
          replayFromSeq: 1,
          replayToSeq: 100,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 90,
          reason: 'replay_budget_exceeded',
        })
      })
      expect(screen.getByRole('button', { name: 'Load earlier terminal history' })).toBeTruthy()

      // Shape 2 — the queue-overflow gap (slow link backlog): a local
      // notice only.
      act(() => {
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 91,
          toSeq: 95,
          reason: 'queue_overflow',
        })
      })
      expectTerminalWriteContaining(term, 'Output gap 91-95: slow link backlog')

      // Shape 3 — the silent retained tail: old servers deliver the
      // retained history with NO gap frame at all (the seq jump is silent).
      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 96, seqEnd: 100, data: 'RETAINED TAIL' })
      })
      expectTerminalWriteContaining(term, 'RETAINED TAIL')

      // The absence pin: no kill, no replacement spawn, no restart notice,
      // identity untouched, zero credits.
      const sent = sentMessages()
      expect(sent.some((msg) => msg?.type === 'terminal.kill')).toBe(false)
      expect(sent.some((msg) => msg?.type === 'terminal.create')).toBe(false)
      expect(terminalWriteStrings(term).some((entry) => entry.includes('Restarting OpenCode'))).toBe(false)

      const layout = store.getState().panes.layouts[tabId]
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal'
        && layout.content.terminalId).toBe(terminalId)
      expect(layout?.type === 'leaf' && layout.content.kind === 'terminal' && layout.content.status).toBe('running')
      expect(creditMessages()).toEqual([])
    })
  })

  describe('snapshot replay sanitization', () => {
    function setupTerminal() {
      const tabId = 'tab-1'
      const paneId = 'pane-1'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-clear-1',
        status: 'creating',
        mode: 'claude',
        shell: 'system',
        initialCwd: '/tmp',
      }
      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'claude',
              status: 'running',
              title: 'Claude',
              titleSetByUser: false,
              createRequestId: 'req-clear-1',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState({
            settings: {
              ...defaultSettings,
              terminal: {
                ...defaultSettings.terminal,
                osc52Clipboard: 'never',
              },
            },
          }),
          connection: { status: 'connected', error: null },
          turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
        },
      })
      return { tabId, paneId, paneContent, store }
    }

    it('does not consume legacy snapshot payload on terminal.created', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: 'legacy created snapshot',
        } as any)
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })

    it('ignores legacy terminal.snapshot frames', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          createdAt: Date.now(),
        })
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.snapshot',
          terminalId: 'term-1',
          snapshot: 'legacy snapshot payload',
        })
      })

      expect(term.clear).not.toHaveBeenCalled()
      expect(term.write).not.toHaveBeenCalled()
      expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    })
  })
})

describe('terminal.modes.sync (surface-reset mode preamble)', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null

  const TERMINAL_ID = 'term-modes-sync'

  function setupPane() {
    const tabId = 'tab-modes-sync'
    const paneId = 'pane-modes-sync'
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-modes-sync',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: TERMINAL_ID,
    }
    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            terminalId: TERMINAL_ID,
            createRequestId: 'req-modes-sync',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
      },
    })
    return { store, tabId, paneId, paneContent }
  }

  function sentAttaches() {
    return wsMocks.send.mock.calls
      .map(([m]) => m)
      .filter((m) => m?.type === 'terminal.attach' && m.terminalId === TERMINAL_ID)
  }

  async function renderPane() {
    const { store, tabId, paneId, paneContent } = setupPane()
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(reconnectHandler).not.toBeNull()
    })
  }

  beforeEach(() => {
    vi.useRealTimers()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    resetHydrationQueueForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    latestAttachRequestIdByTerminal.clear()
    latestStreamIdByTerminal.clear()
    wsMocks.isReady = true
    wsMocks.capabilities = {}
    wsMocks.send.mockClear()
    wsMocks.send.mockImplementation((msg: any) => {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg.terminalId === 'string'
        && typeof msg.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    })
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = (msg: any) => callback(withCurrentAttachRequestId(msg))
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) reconnectHandler = null
      }
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    terminalInstances.length = 0
    runtimeMocks.instances.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    installPerfAuditBridge(null)
    restoreMocks.consumeTerminalRestoreRequestId.mockReset()
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    resetHydrationQueueForTests()
    latestAttachRequestIdByTerminal.clear()
    latestStreamIdByTerminal.clear()
    messageHandler = null
    reconnectHandler = null
    installPerfAuditBridge(null)
  })

  it('claims surfaceReset (full viewport hydrate from seq 0) on the first attach of a freshly-constructed surface', async () => {
    await renderPane()
    await waitFor(() => {
      const attach = sentAttaches().at(-1)
      expect(attach).toBeTruthy()
      expect(attach.surfaceReset).toBe(true)
      expect(attach.sinceSeq).toBe(0)
      expect(attach.intent).toBe('viewport_hydrate')
    })
  })

  it('clears the fresh claim when the marker attach completes with no pending replay (empty tracker survives)', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        attachRequestId: sentAttaches().at(-1)!.attachRequestId,
        seq: 0,
        headSeq: 0,
      })
    })
    // reconnect → second attach must NOT re-claim a consumed marker
    act(() => { reconnectHandler!() })
    await waitFor(() => expect(sentAttaches().length).toBeGreaterThanOrEqual(2))
    const second = sentAttaches().at(-1)!
    expect(second.surfaceReset).toBeUndefined()
  })

  it('writes a correctly-tagged terminal.modes.sync through the write queue before claiming completion', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    const attach = sentAttaches().at(-1)!
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        attachRequestId: attach.attachRequestId,
        seq: 0,
        headSeq: 1,
        replayFromSeq: 1,
        replayToSeq: 1,
      })
      messageHandler!({
        type: 'terminal.modes.sync',
        terminalId: TERMINAL_ID,
        attachRequestId: attach.attachRequestId,
        data: '\u001b[?1003h',
      })
    })
    await waitFor(() => {
      expect(latestWrites().some((s) => s.includes('\u001b[?1003h'))).toBe(true)
      // the actual ESC byte, not the literal backslash-u
      expect(latestWrites().some((s) => s.includes('\x1b[?1003h'))).toBe(true)
    })
    // replay completes the attach → marker consumed → next attach unmarked
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId: TERMINAL_ID,
        seqStart: 1,
        seqEnd: 1,
        data: 'hello',
      })
    })
    await waitFor(() => expect(storeSentCount()).toBe(0) , { timeout: 1 }).catch(() => {})
    act(() => { reconnectHandler!() })
    await waitFor(() => expect(sentAttaches().length).toBeGreaterThanOrEqual(2))
    expect(sentAttaches().at(-1)!.surfaceReset).toBeUndefined()
  })

  it('fails closed on an untagged terminal.modes.sync (no bytes written, marker survives)', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        attachRequestId: sentAttaches().at(-1)!.attachRequestId,
        seq: 0,
        headSeq: 0,
      } as any)
      messageHandler!({
        type: 'terminal.modes.sync',
        terminalId: TERMINAL_ID,
        __preserveMissingAttachRequestId: true,
        data: '\x1b[?1003h',
      } as any)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(latestWrites().some((s) => s.includes('\x1b[?1003h'))).toBe(false)
    // attach completed via the no-pending-replay edge — a SECOND attach after
    // reconnect would not re-claim, so the observable gate here is: no write.
  })

  it('wipes a reset-then-written fresh surface before its forced full replay (fresheyes round 4: user-reset + reconnect duplication)', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    const firstAttach = sentAttaches().at(-1)!
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        attachRequestId: firstAttach.attachRequestId,
        seq: 0,
        headSeq: 0,
      })
    })
    const term = terminalInstances[terminalInstances.length - 1]
    term.clear.mockClear()

    // User Reset marks the surface fresh (marker nulled by round-4 A(iii)
    // hardening); subsequent LIVE output makes the surface non-blank. A later
    // reconnect forces sinceSeq=0 — the forced replay MUST wipe that content
    // first, or the surface shows the post-reset live tail duplicated on top
    // of full history.
    const actions = getTerminalActions('pane-modes-sync')!
    act(() => { actions.reset() })
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId: TERMINAL_ID,
        seqStart: 1,
        seqEnd: 1,
        data: 'post-reset live line\r\n',
      })
    })
    await new Promise((r) => setTimeout(r, 30))

    act(() => { reconnectHandler!() })
    await waitFor(() => expect(sentAttaches().length).toBeGreaterThanOrEqual(2))
    const second = sentAttaches().at(-1)!
    expect(second.surfaceReset).toBe(true)
    expect(second.sinceSeq).toBe(0)
    await waitFor(() => {
      expect(reconstructionWrites(term)).toHaveLength(1)
      expect(term.clear).not.toHaveBeenCalled()
    })
  })

  it('does NOT wipe the genuinely blank surface of a first-ever fresh attach', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    const term = terminalInstances[terminalInstances.length - 1]
    expect(term.clear).not.toHaveBeenCalled()
  })

  it('ignores a stale-generation terminal.modes.sync (bytes never written)', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        attachRequestId: sentAttaches().at(-1)!.attachRequestId,
        seq: 0,
        headSeq: 0,
      })
      messageHandler!({
        type: 'terminal.modes.sync',
        terminalId: TERMINAL_ID,
        attachRequestId: 'stale:attach:not-current',
        streamId: 'stale-stream',
        data: '\x1b[?1006h',
      } as any)
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(latestWrites().some((s) => s.includes('\x1b[?1006h'))).toBe(false)
  })

  function latestWrites(): string[] {
    const term = terminalInstances[terminalInstances.length - 1]
    return terminalWriteStrings(term)
  }
  function storeSentCount(): number { return wsMocks.send.mock.calls.length }
})

describe('replay phantom focus report silencing (kata 9gy8)', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null

  const TERMINAL_ID = 'term-9gy8-focus'
  const TAB_ID = 'tab-9gy8-focus'
  const PANE_ID = 'pane-9gy8-focus'

  const FOCUS_IN = '\u001b[I'
  const FOCUS_OUT = '\u001b[O'
  const ARM_FOCUS_REPORTING = '\u001b[?1004h'

  function setupPane() {
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-9gy8-focus',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: TERMINAL_ID,
    }
    const root: PaneNode = { type: 'leaf', id: PANE_ID, content: paneContent }
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        tabRecency: tabRecencyReducer,
        sessionActivity: sessionActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: TAB_ID,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            terminalId: TERMINAL_ID,
            createRequestId: 'req-9gy8-focus',
          }],
          activeTabId: TAB_ID,
        },
        panes: {
          layouts: { [TAB_ID]: root },
          activePane: { [TAB_ID]: PANE_ID },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-9gy8' },
        turnCompletion: { seq: 0, lastAtByTerminalId: {}, pendingEvents: [], attentionByTab: {} },
        tabRecency: { version: 1, paneLastInputAt: {} },
        sessionActivity: { sessions: {} },
      },
    })
    return { store, paneContent }
  }

  function sentAttaches() {
    return wsMocks.send.mock.calls
      .map(([m]) => m)
      .filter((m) => m?.type === 'terminal.attach' && m.terminalId === TERMINAL_ID)
  }

  function sentInputs() {
    return wsMocks.send.mock.calls
      .map(([m]) => m)
      .filter((m) => m?.type === 'terminal.input' && m.terminalId === TERMINAL_ID)
  }

  function sentFocusReports() {
    return sentInputs().filter((m) => m?.data === FOCUS_IN || m?.data === FOCUS_OUT)
  }

  function inputActivityActionTypes(dispatchSpy: ReturnType<typeof vi.fn>): string[] {
    return dispatchSpy.mock.calls
      .map((call) => (call[0] as { type?: unknown } | undefined)?.type)
      .filter((type): type is string => typeof type === 'string')
      .filter((type) => type === 'tabRecency/recordPaneTabActivity' || type === 'sessionActivity/updateSessionActivity')
  }

  function getTerm() {
    const term = terminalInstances[terminalInstances.length - 1]
    expect(term, 'a mock xterm instance must exist').toBeTruthy()
    return term
  }

  function getOnDataHandler(): (data: string) => void {
    const handler = getTerm().onData.mock.calls.at(-1)?.[0]
    expect(handler, 'xterm onData handler must be registered').toBeTruthy()
    return handler
  }

  async function renderPane() {
    const { store, paneContent } = setupPane()
    // Activity-observation pattern (same as TerminalView.lastInputAt.test.tsx):
    // a pass-through dispatch spy, installed BEFORE render so useAppDispatch
    // captures it.
    const originalDispatch = store.dispatch
    const dispatchSpy = vi.fn((action) => originalDispatch(action))
    store.dispatch = dispatchSpy as typeof store.dispatch
    render(
      <Provider store={store}>
        <TerminalView tabId={TAB_ID} paneId={PANE_ID} paneContent={paneContent} />
      </Provider>
    )
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
      expect(messageHandler).not.toBeNull()
      expect(reconnectHandler).not.toBeNull()
    })
    return { store, dispatchSpy }
  }

  async function beginAttachWithReplayWindow(replayToSeq: number) {
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        headSeq: replayToSeq,
        replayFromSeq: 1,
        replayToSeq,
      })
    })
  }

  // Drive a replay chunk whose write fires the registered xterm onData handler
  // with `fireDuringWrite` WHILE the chunk's replay write scope is still open —
  // the exact timing a real xterm produces when a replayed chunk contains the
  // app's ?1004h arm byte (xterm's parser re-fires the report mid-parse, before
  // the write callback runs and completes the scope). Firing onData after the
  // write resolves would be post-scope and would NOT exercise the gate.
  function writeReplayChunk(input: { seqStart: number; seqEnd: number; data: string; fireDuringWrite?: string }) {
    const term = getTerm()
    if (input.fireDuringWrite !== undefined) {
      const onData = getOnDataHandler()
      const payload = input.fireDuringWrite
      term.write.mockImplementationOnce((_chunk: string, onWritten?: () => void) => {
        onData(payload)
        onWritten?.()
      })
    }
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId: TERMINAL_ID,
        seqStart: input.seqStart,
        seqEnd: input.seqEnd,
        data: input.data,
      })
    })
  }

  beforeEach(() => {
    vi.useRealTimers()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    resetHydrationQueueForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    latestAttachRequestIdByTerminal.clear()
    latestStreamIdByTerminal.clear()
    wsMocks.isReady = true
    wsMocks.capabilities = {}
    wsMocks.send.mockClear()
    wsMocks.send.mockImplementation((msg: any) => {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg.terminalId === 'string'
        && typeof msg.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    })
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = (msg: any) => callback(withCurrentAttachRequestId(msg))
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) reconnectHandler = null
      }
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    terminalInstances.length = 0
    runtimeMocks.instances.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    installPerfAuditBridge(null)
    restoreMocks.consumeTerminalRestoreRequestId.mockReset()
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    resetHydrationQueueForTests()
    latestAttachRequestIdByTerminal.clear()
    latestStreamIdByTerminal.clear()
    messageHandler = null
    reconnectHandler = null
    installPerfAuditBridge(null)
  })

  it('swallows a phantom focus-in report fired while the replay write scope is open (no ws input, no input activity)', async () => {
    const { store, dispatchSpy } = await renderPane()
    await beginAttachWithReplayWindow(1)

    dispatchSpy.mockClear()
    writeReplayChunk({
      seqStart: 1,
      seqEnd: 1,
      data: `${ARM_FOCUS_REPORTING}armed prompt$ `,
      fireDuringWrite: FOCUS_IN,
    })

    // The replay chunk itself renders — the arm byte's text companions are written.
    expect(terminalWriteStrings(getTerm()).join('')).toContain('armed prompt$ ')
    // But the phantom report the parse invented reaches neither the wire nor the
    // input-activity ledgers.
    expect(sentFocusReports()).toEqual([])
    expect(inputActivityActionTypes(dispatchSpy)).toEqual([])
    expect(store.getState().tabRecency.paneLastInputAt[PANE_ID]).toBeUndefined()
  })

  it('swallows the blur variant (focus-out report) during replay', async () => {
    const { store, dispatchSpy } = await renderPane()
    await beginAttachWithReplayWindow(1)

    dispatchSpy.mockClear()
    writeReplayChunk({
      seqStart: 1,
      seqEnd: 1,
      data: `${ARM_FOCUS_REPORTING}armed prompt$ `,
      fireDuringWrite: FOCUS_OUT,
    })

    expect(terminalWriteStrings(getTerm()).join('')).toContain('armed prompt$ ')
    expect(sentFocusReports()).toEqual([])
    expect(inputActivityActionTypes(dispatchSpy)).toEqual([])
    expect(store.getState().tabRecency.paneLastInputAt[PANE_ID]).toBeUndefined()
  })

  it('leaves non-focus input untouched during the same replay scope window (bytes-level gate, not batch-level)', async () => {
    const { dispatchSpy } = await renderPane()
    await beginAttachWithReplayWindow(1)

    dispatchSpy.mockClear()
    writeReplayChunk({
      seqStart: 1,
      seqEnd: 1,
      data: `${ARM_FOCUS_REPORTING}armed prompt$ `,
      fireDuringWrite: 'x',
    })

    // A genuine keystroke landing mid-replay-write still goes to the wire…
    expect(sentInputs().filter((m) => m?.data === 'x')).toHaveLength(1)
    // …and the replay chunk itself is ingested normally.
    expect(terminalWriteStrings(getTerm()).join('')).toContain('armed prompt$ ')
  })

  it('still forwards a live focus report when no replay scope is open', async () => {
    await renderPane()
    await waitFor(() => expect(sentAttaches().length).toBe(1))
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: TERMINAL_ID,
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
    })

    fireData(getTerm(), FOCUS_IN)

    expect(sentFocusReports()).toHaveLength(1)
  })

  it('swallows the phantom on every replay of the same pane (no first-time-only state)', async () => {
    const { store, dispatchSpy } = await renderPane()
    await beginAttachWithReplayWindow(2)

    dispatchSpy.mockClear()
    for (const seq of [1, 2]) {
      writeReplayChunk({
        seqStart: seq,
        seqEnd: seq,
        data: `${ARM_FOCUS_REPORTING}replay line ${seq}\r\n`,
        fireDuringWrite: FOCUS_IN,
      })
    }

    expect(terminalWriteStrings(getTerm()).join('')).toContain('replay line 2')
    expect(sentFocusReports()).toEqual([])
    expect(inputActivityActionTypes(dispatchSpy)).toEqual([])
    expect(store.getState().tabRecency.paneLastInputAt[PANE_ID]).toBeUndefined()
  })
})

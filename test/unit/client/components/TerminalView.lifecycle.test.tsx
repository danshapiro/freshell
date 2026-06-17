import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer, { requestPaneRefresh } from '@/store/panesSlice'
import settingsReducer, { defaultSettings, updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setStatus as setConnectionStatus } from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { persistMiddleware, resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { LAYOUT_STORAGE_KEY } from '@/store/storage-keys'
import { flushPersistedLayoutNow } from '@/store/persistControl'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  __resetTerminalCursorCacheForTests,
  loadTerminalSurfaceCheckpoint,
  saveTerminalSurfaceCheckpoint,
} from '@/lib/terminal-cursor'
import { getHydrationQueue, resetHydrationQueueForTests } from '@/lib/hydration-queue'
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
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
}))

const restoreMocks = vi.hoisted(() => ({
  consumeTerminalRestoreRequestId: vi.fn(() => false),
  addTerminalRestoreRequestId: vi.fn(),
  consumeTerminalFreshRecoveryRequest: vi.fn(() => undefined),
  addTerminalFreshRecoveryRequestId: vi.fn(),
}))

const runtimeMocks = vi.hoisted(() => ({
  instances: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: terminalThemeMocks.getTerminalTheme,
}))

vi.mock('@/lib/terminal-restore', () => ({
  consumeTerminalRestoreRequestId: restoreMocks.consumeTerminalRestoreRequestId,
  addTerminalRestoreRequestId: restoreMocks.addTerminalRestoreRequestId,
  consumeTerminalFreshRecoveryRequest: restoreMocks.consumeTerminalFreshRecoveryRequest,
  addTerminalFreshRecoveryRequestId: restoreMocks.addTerminalFreshRecoveryRequestId,
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
    write = vi.fn((_data: string, onWritten?: () => void) => {
      onWritten?.()
    })
    writeln = vi.fn()
    clear = vi.fn()
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
} from '@/components/TerminalView'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

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

function expectTerminalWriteContaining(term: { write: { mock: { calls: Array<[unknown]> } } }, text: string) {
  expect(terminalWriteStrings(term).some((entry) => entry.includes(text))).toBe(true)
}

function withCurrentAttachRequestId<T extends { type?: string; terminalId?: string; attachRequestId?: string }>(
  msg: T & { __preserveMissingAttachRequestId?: boolean; __preserveMissingStreamId?: boolean },
): T {
  const isStreamPayload = msg.type === 'terminal.attach.ready'
    || msg.type === 'terminal.stream.changed'
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
    } else if (msg.type === 'terminal.output' || msg.type === 'terminal.output.batch' || msg.type === 'terminal.output.gap') {
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
    await waitFor(() => {
      expect(terminalInstances[0].focus).toHaveBeenCalled()
      expect(terminalInstances[1].focus).toHaveBeenCalled()
    })

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
      hidden?: boolean
      clearSends?: boolean
      requestId?: string
      ackInitialAttach?: boolean
      refreshOnMount?: boolean
      sessionRef?: TerminalPaneContent['sessionRef']
      serverInstanceId?: string
      streamId?: string
      waitForMessageHandler?: boolean
      waitForTerminalInstance?: boolean
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
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={opts?.hidden} />
        </Provider>
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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-from-ready',
        serverInstanceId: 'server-attach-stream',
      })?.parserAppliedSeq).toBe(1)
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: null,
        serverInstanceId: 'server-attach-stream',
      })).toBeNull()
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

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-before-change',
        serverInstanceId: 'server-active-stream-change',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-before-change',
        serverInstanceId: 'server-active-stream-change',
      })).toBeNull()
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-after-change',
        serverInstanceId: 'server-active-stream-change',
      })?.parserAppliedSeq).toBe(2)
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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-after-change',
        serverInstanceId: 'server-stale-replay-stream-change',
      })).toBeNull()
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

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-before-rotation',
        serverInstanceId: 'server-stream-rotation',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-after-rotation',
        serverInstanceId: 'server-stream-rotation',
      })).toBeNull()
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

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-geometry',
        serverInstanceId: 'server-geometry-authority',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-stream-mismatch',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-hole',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-malformed-numbers',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-malformed-numbers',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-surrogate-split',
      })).toBeNull()
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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-fail-closed',
      })).toBeNull()
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

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-overlap-tail',
      })?.parserAppliedSeq).toBe(10)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-invalid-overlap-tail',
      })?.parserAppliedSeq).toBe(10)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['aBc'])
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-barrier-coalesced',
      })?.parserAppliedSeq).toBe(3)
    })

    it('does not checkpoint across a stripped middle batch segment when adjacent renderable segments coalesce', async () => {
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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['AB'])
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      })).toBeNull()

      act(() => {
        rafCallbacks.shift()?.(16)
      })

      const submittedReplay = delayedCallbacks.map(({ data: chunk }) => chunk).join('')
      expect(submittedReplay).toBe(data)
      expect(delayedCallbacks.length).toBeLessThanOrEqual(2)
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      })).toBeNull()
      expect(queryByText('Recovering terminal output...')).not.toBeNull()

      act(() => {
        delayedCallbacks.forEach(({ callback }) => callback())
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-opencode-heavy-replay',
      })?.parserAppliedSeq).toBe(chunks.length)
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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-stripped-bel',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-complete',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-tail',
      })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-replay-stripped-tail',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-batch-mixed-stripped-bel',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-stripped-bel',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-complete',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-tail',
      })).toBeNull()

      act(() => {
        delayedCallbacks[0]?.callback()
      })

      await waitFor(() => {
        expect(queryByText('Recovering terminal output...')).toBeNull()
      })
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-replay-stripped-tail',
      })?.parserAppliedSeq).toBe(1)

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId,
        serverInstanceId: 'server-output-legacy-mixed-stripped-bel',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-missing-output-stream',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-active',
        serverInstanceId: 'server-missing-gap-stream',
      })).toBeNull()

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
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stored-stale-stream',
        serverInstanceId: 'server-missing-ready-stream',
      })).toBeNull()
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: null,
        serverInstanceId: 'server-missing-ready-stream',
      })).toBeNull()

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
      })
      expect(loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: null,
        serverInstanceId,
      })?.parserAppliedSeq).toBe(17)

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
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-stale-write-callback',
        serverInstanceId: 'server-a',
        streamId: 'stream-1',
        ackInitialAttach: false,
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: firstAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'first replay text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const initialCheckpoint = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      })
      expect(initialCheckpoint?.attachRequestId).toBe(firstAttach?.attachRequestId)
      expect(initialCheckpoint?.parserAppliedSeq).toBe(1)

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'old replay text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      expect(delayedCallbacks).toHaveLength(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      const secondAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(secondAttach?.attachRequestId).toBeTruthy()
      expect(secondAttach?.attachRequestId).not.toBe(firstAttach?.attachRequestId)
      expect(secondAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 4,
          replayFromSeq: 2,
          replayToSeq: 4,
          attachRequestId: secondAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 4,
          data: 'current replay text',
          attachRequestId: secondAttach!.attachRequestId,
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['old replay text'])

      act(() => {
        delayedCallbacks.find(({ data }) => data === 'old replay text')?.callback()
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual([
        'old replay text',
        'current replay text',
      ])

      const checkpointAfterStaleCallback = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      })
      expect(checkpointAfterStaleCallback).not.toBeNull()
      expect(checkpointAfterStaleCallback?.attachRequestId).toBe(firstAttach?.attachRequestId)
      expect(checkpointAfterStaleCallback?.parserAppliedSeq).toBe(1)

      const currentAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(currentAttach?.attachRequestId).toBe(secondAttach?.attachRequestId)

      wsMocks.send.mockClear()
      term.clear.mockClear()
      act(() => {
        delayedCallbacks.find(({ data }) => data === 'current replay text')?.callback()
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'viewport_hydrate',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
      expect(term.clear).toHaveBeenCalledTimes(1)

      const checkpointAfterCurrentCallback = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-1',
        serverInstanceId: 'server-a',
      })
      expect(checkpointAfterCurrentCallback?.attachRequestId).toBe(firstAttach?.attachRequestId)
      expect(checkpointAfterCurrentCallback?.parserAppliedSeq).toBe(1)
    })

    it('fails closed from delta attach when writes are in flight and repairs quarantine after drain', async () => {
      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-in-flight-delta',
        serverInstanceId: 'server-a',
        streamId: 'stream-delta',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'checkpointed text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const initialCheckpoint = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-delta',
        serverInstanceId: 'server-a',
      })
      expect(initialCheckpoint?.attachRequestId).toBe(firstAttach?.attachRequestId)
      expect(initialCheckpoint?.parserAppliedSeq).toBe(1)

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'old in-flight delta text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks).toHaveLength(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      const secondAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(secondAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      })
      const fallbackEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.catchup.full_hydrate_fallback')
      expect(fallbackEvents).toEqual([
        expect.objectContaining({
          event: 'terminal.catchup.full_hydrate_fallback',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: secondAttach!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
          hasInFlightWrites: true,
        }),
      ])
      const quarantineEvents = bridge.snapshot().perfEvents
        .filter((event) => event.event === 'terminal.catchup.surface_quarantined')
      expect(quarantineEvents).toEqual([
        expect.objectContaining({
          event: 'terminal.catchup.surface_quarantined',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: secondAttach!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
        }),
      ])
      expect(bridge.snapshot().milestones['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
      expect(bridge.snapshot().metadata['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
      expect(bridge.snapshot().milestones['terminal.catchup.surface_quarantined']).toBeUndefined()
      expect(bridge.snapshot().metadata['terminal.catchup.surface_quarantined']).toBeUndefined()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 3,
          replayFromSeq: 2,
          replayToSeq: 3,
          attachRequestId: secondAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 3,
          data: 'quarantined replay text',
          attachRequestId: secondAttach!.attachRequestId,
        })
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['old in-flight delta text'])

      act(() => {
        delayedCallbacks.find(({ data }) => data === 'old in-flight delta text')?.callback()
      })

      expect(delayedCallbacks.map(({ data }) => data)).toEqual([
        'old in-flight delta text',
        'quarantined replay text',
      ])

      wsMocks.send.mockClear()
      term.clear.mockClear()
      act(() => {
        delayedCallbacks.find(({ data }) => data === 'quarantined replay text')?.callback()
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'viewport_hydrate',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
      expect(term.clear).toHaveBeenCalledTimes(1)

      const checkpointAfterCallbacks = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-delta',
        serverInstanceId: 'server-a',
      })
      expect(checkpointAfterCallbacks?.attachRequestId).toBe(firstAttach?.attachRequestId)
      expect(checkpointAfterCallbacks?.parserAppliedSeq).toBe(1)

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

    it('drops quarantined replay and forces a clearing hydrate when quarantine repair times out before writes drain', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-in-flight-quarantine-timeout',
        serverInstanceId: 'server-a',
        streamId: 'stream-timeout',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'checkpointed text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push({ data, callback: onWritten })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'old in-flight timeout text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['old in-flight timeout text'])

      vi.useFakeTimers()
      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      const quarantinedAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(quarantinedAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 3,
          replayFromSeq: 2,
          replayToSeq: 3,
          attachRequestId: quarantinedAttach!.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 3,
          data: 'quarantined replay timeout text',
          attachRequestId: quarantinedAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks.map(({ data }) => data)).toEqual(['old in-flight timeout text'])

      act(() => {
        vi.advanceTimersByTime(2_100)
      })

      wsMocks.send.mockClear()
      term.clear.mockClear()
      act(() => {
        delayedCallbacks.find(({ data }) => data === 'old in-flight timeout text')?.callback()
      })

      expect(terminalWriteStrings(term)).not.toContain('quarantined replay timeout text')

      act(() => {
        vi.advanceTimersByTime(100)
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
      expect(term.clear).toHaveBeenCalledTimes(1)
      const repairAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(repairAttach?.attachRequestId).not.toBe(quarantinedAttach?.attachRequestId)
    })

    it('records repeated in-flight full-hydrate fallback and quarantine audit events separately', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-repeat-fallback-quarantine',
        serverInstanceId: 'server-a',
        streamId: 'stream-repeat',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'checkpoint before repeat fallback',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const delayedCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push(onWritten)
      })
      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'held in-flight write',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks).toHaveLength(1)

      const bridge = createPerfAuditBridge()
      installPerfAuditBridge(bridge)
      let now = 200
      const performanceNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
        now += 0.01
        return now
      })
      try {
        wsMocks.send.mockClear()
        act(() => {
          reconnectHandler?.()
          reconnectHandler?.()
        })

        const reconnectAttaches = sentMessages()
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(reconnectAttaches).toHaveLength(2)
        expect(reconnectAttaches[0]?.attachRequestId).not.toBe(reconnectAttaches[1]?.attachRequestId)

        const fallbackEvents = bridge.snapshot().perfEvents
          .filter((event) => event.event === 'terminal.catchup.full_hydrate_fallback')
        expect(fallbackEvents).toHaveLength(2)
        expect(fallbackEvents[0]).toEqual(expect.objectContaining({
          event: 'terminal.catchup.full_hydrate_fallback',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: reconnectAttaches[0]!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
          hasInFlightWrites: true,
        }))
        expect(fallbackEvents[1]).toEqual(expect.objectContaining({
          event: 'terminal.catchup.full_hydrate_fallback',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: reconnectAttaches[1]!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
          hasInFlightWrites: true,
        }))
        expect(Number(fallbackEvents[0]!.timestamp)).toBeLessThan(Number(fallbackEvents[1]!.timestamp))

        const quarantineEvents = bridge.snapshot().perfEvents
          .filter((event) => event.event === 'terminal.catchup.surface_quarantined')
        expect(quarantineEvents).toHaveLength(2)
        expect(quarantineEvents[0]).toEqual(expect.objectContaining({
          event: 'terminal.catchup.surface_quarantined',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: reconnectAttaches[0]!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
        }))
        expect(quarantineEvents[1]).toEqual(expect.objectContaining({
          event: 'terminal.catchup.surface_quarantined',
          timestamp: expect.any(Number),
          terminalId,
          attachRequestId: reconnectAttaches[1]!.attachRequestId,
          requestedIntent: 'transport_reconnect',
          intent: 'viewport_hydrate',
          reason: 'in_flight_writes',
        }))
        expect(Number(quarantineEvents[0]!.timestamp)).toBeLessThan(Number(quarantineEvents[1]!.timestamp))

        expect(bridge.snapshot().metadata['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
        expect(bridge.snapshot().milestones['terminal.catchup.full_hydrate_fallback']).toBeUndefined()
        expect(bridge.snapshot().metadata['terminal.catchup.surface_quarantined']).toBeUndefined()
        expect(bridge.snapshot().milestones['terminal.catchup.surface_quarantined']).toBeUndefined()
      } finally {
        performanceNowSpy.mockRestore()
      }
    })

    it('does not clear the old surface when full hydrate starts with in-flight writes', async () => {
      const { store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-in-flight-full-hydrate',
        serverInstanceId: 'server-a',
        streamId: 'stream-in-flight',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'trusted text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const trustedCheckpoint = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-in-flight',
        serverInstanceId: 'server-a',
      })
      expect(trustedCheckpoint?.parserAppliedSeq).toBe(1)

      const delayedCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push(onWritten)
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'in-flight text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks).toHaveLength(1)

      term.clear.mockClear()
      wsMocks.send.mockClear()
      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          intent: 'viewport_hydrate',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
      expect(term.clear).not.toHaveBeenCalled()

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

    it('cancels quarantined repair after invalid-terminal replacement before writes drain', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-quarantine-invalid',
        serverInstanceId: 'server-a',
        streamId: 'stream-invalid',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'trusted text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const delayedCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push(onWritten)
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'old in-flight text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks).toHaveLength(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      const quarantineAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(quarantineAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })

      act(() => {
        messageHandler!({
          type: 'error',
          code: 'INVALID_TERMINAL_ID',
          terminalId,
          message: 'gone',
        })
      })

      wsMocks.send.mockClear()
      await act(async () => {
        delayedCallbacks.forEach((callback) => callback())
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
    })

    it('handles tagged invalid-terminal errors from quarantine repair attaches', async () => {
      const { terminalId, term, store, tabId, requestId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-quarantine-repair-invalid',
        serverInstanceId: 'server-a',
        streamId: 'stream-repair-invalid',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'trusted text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })

      const delayedCallbacks: Array<() => void> = []
      term.write.mockImplementation((_data: string, onWritten?: () => void) => {
        if (onWritten) delayedCallbacks.push(onWritten)
      })

      act(() => {
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: 'old in-flight text',
          attachRequestId: firstAttach!.attachRequestId,
        })
      })
      expect(delayedCallbacks).toHaveLength(1)

      wsMocks.send.mockClear()
      act(() => {
        reconnectHandler?.()
      })

      const quarantineAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(quarantineAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })
      expect(quarantineAttach?.attachRequestId).toBeTruthy()

      wsMocks.send.mockClear()
      await act(async () => {
        delayedCallbacks.forEach((callback) => callback())
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      const repairAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(repairAttach).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
      })
      expect(repairAttach?.attachRequestId).toBeTruthy()
      expect(repairAttach?.attachRequestId).not.toBe(quarantineAttach?.attachRequestId)

      act(() => {
        messageHandler!({
          type: 'error',
          code: 'INVALID_TERMINAL_ID',
          terminalId,
          requestId: repairAttach!.attachRequestId,
          message: 'Terminal not running',
        })
      })

      await waitFor(() => {
        const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
        expect(layout.content.terminalId).toBeUndefined()
        expect(layout.content.status).toBe('creating')
        expect(layout.content.createRequestId).not.toBe(requestId)
      })

      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(restoreMocks.addTerminalFreshRecoveryRequestId).toHaveBeenCalledWith(
        layout.content.createRequestId,
        'fresh_after_restore_unavailable',
      )

      wsMocks.send.mockClear()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })

      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
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

    it('recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output', async () => {
      const sessionRef = { provider: 'opencode', sessionId: 'ses_focus_replay_gap' } as const
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

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith({
          type: 'terminal.kill',
          terminalId,
        })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.exit',
          terminalId,
          exitCode: 0,
        })
      })

      let replacementRequestId: string | undefined
      await waitFor(() => {
        const layout = store.getState().panes.layouts[tabId]
        expect(layout?.type).toBe('leaf')
        if (layout?.type !== 'leaf' || layout.content.kind !== 'terminal') {
          throw new Error('expected terminal pane')
        }
        expect(layout.content.terminalId).toBeUndefined()
        expect(layout.content.status).toBe('creating')
        expect(layout.content.sessionRef).toEqual(sessionRef)
        replacementRequestId = layout.content.createRequestId
        expect(replacementRequestId).not.toBe('req-opencode-focus-gap')
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.create',
          requestId: replacementRequestId,
          mode: 'opencode',
          sessionRef,
          restore: true,
        }))
      })
    })

    it('recreates a hidden restored OpenCode pane when background viewport hydration cannot replay startup output', async () => {
      const sessionRef = { provider: 'opencode', sessionId: 'ses_hidden_replay_gap' } as const
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

      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-opencode-hidden-gap',
        mode: 'opencode',
        hidden: true,
        clearSends: false,
        requestId: 'req-opencode-hidden-gap',
        sessionRef,
      })

      wsMocks.send.mockClear()
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
            && msg?.intent === 'viewport_hydrate'
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

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith({
          type: 'terminal.kill',
          terminalId,
        })
      })

      act(() => {
        messageHandler!({
          type: 'terminal.exit',
          terminalId,
          exitCode: 0,
        })
      })

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>,
      )

      let replacementRequestId: string | undefined
      await waitFor(() => {
        const layout = store.getState().panes.layouts[tabId]
        expect(layout?.type).toBe('leaf')
        if (layout?.type !== 'leaf' || layout.content.kind !== 'terminal') {
          throw new Error('expected terminal pane')
        }
        expect(layout.content.terminalId).toBeUndefined()
        expect(layout.content.status).toBe('creating')
        expect(layout.content.sessionRef).toEqual(sessionRef)
        replacementRequestId = layout.content.createRequestId
        expect(replacementRequestId).not.toBe('req-opencode-hidden-gap')
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.create',
          requestId: replacementRequestId,
          mode: 'opencode',
          sessionRef,
          restore: true,
        }))
      })
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

      const checkpointAfterReplay = loadTerminalSurfaceCheckpoint(terminalId, {
        streamId: 'stream-local-notice',
        serverInstanceId: 'server-local-notice',
      })
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

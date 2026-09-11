import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { __resetTerminalCursorCacheForTests } from '@/lib/terminal-cursor'
import { resetHydrationQueueForTests } from '@/lib/hydration-queue'
import { installPerfAuditBridge } from '@/lib/perf-audit-bridge'
import {
  addTerminalRestoreRequestId,
  clearTerminalRestoreRequestId,
} from '@/lib/terminal-restore'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

// FULL harness copied from TerminalView.lifecycle.test.tsx (~lines 1-381:
// hoisted mocks :1-118, wsMocks.send + messageHandler capture ~:326-355,
// beforeEach/afterEach ~:326-381, helpers as needed), EXCEPT the
// vi.mock('@/lib/terminal-restore') block at ~:67-73, which is intentionally
// omitted: this suite uses the real terminal-restore module so the
// re-arm -> non-destructive-peek chain is exercised for real (same approach
// as TerminalView.restore-flag-persistence.test.tsx).

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
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
  __resetLastSentViewportCacheForTests,
  RATE_LIMIT_RETRY_MAX_ATTEMPTS,
  RATE_LIMIT_RETRY_BASE_MS,
  RATE_LIMIT_RETRY_MAX_MS,
} from '@/components/TerminalView'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

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

let messageHandler: ((msg: any) => void) | null = null
let reconnectHandler: (() => void) | null = null
let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

const REQ = 'req-launch-retry'
const TAB = 'tab-launch-retry'
const PANE = 'pane-launch-retry'

function createSettingsState() {
  const serverSettings = createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug })
  const localSettings = resolveLocalSettings()
  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function makeStore() {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: REQ,
    status: 'creating',
    mode: 'shell',
    shell: 'system',
  }
  const root: PaneNode = { type: 'leaf', id: PANE, content: paneContent }
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
          id: TAB, mode: 'shell', status: 'running', title: 'Shell',
          titleSetByUser: false, createRequestId: REQ,
        }],
        activeTabId: TAB,
      },
      panes: { layouts: { [TAB]: root }, activePane: { [TAB]: PANE }, paneTitles: {} },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
    },
  })
  return { store, paneContent }
}

function sentCreates() {
  return wsMocks.send.mock.calls.map(([m]) => m).filter((m) => m?.type === 'terminal.create')
}

function paneStatus(store: ReturnType<typeof makeStore>['store']) {
  const layout = store.getState().panes.layouts[TAB] as { type: 'leaf'; content: any }
  return layout.content.status
}

async function renderPane(store: any, paneContent: TerminalPaneContent) {
  render(
    <Provider store={store}>
      <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
    </Provider>
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(messageHandler).not.toBeNull()
}

/** Anchor the launch: server acks the create, launchAttempt gets terminalId. */
function anchor(terminalId: string) {
  messageHandler!({ type: 'terminal.created', terminalId, requestId: REQ })
}

/** Launch-time INVALID_TERMINAL_ID in the "server lost the terminal" shape
 *  (no requestId, no terminalExitCode — the emitter shape of
 *  server/ws-handler.ts:2832). Passes the :4039 `!msg.requestId` guard branch
 *  and the :4061 same-terminal filter, landing in failedDuringLaunch. */
function launchInvalidTerminal(terminalId: string) {
  messageHandler!({
    type: 'error',
    code: 'INVALID_TERMINAL_ID',
    message: 'Unknown terminalId',
    terminalId,
  })
}

describe('launch-time INVALID_TERMINAL_ID bounded retry', () => {
  // beforeEach/afterEach copied from TerminalView.lifecycle.test.tsx (minus
  // the restoreMocks resets — this suite uses the real module), plus the
  // clearTerminalRestoreRequestId(REQ) bookends.
  beforeEach(() => {
    clearTerminalRestoreRequestId(REQ)
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
    clearTerminalRestoreRequestId(REQ)
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

  it('retries terminal.create with the SAME requestId and restore:true after a launch-time INVALID_TERMINAL_ID', async () => {
    vi.useFakeTimers()
    addTerminalRestoreRequestId(REQ) // this pane is a restore round
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)

    const first = sentCreates()
    expect(first.length).toBeGreaterThan(0)
    expect(first[first.length - 1].requestId).toBe(REQ)
    expect(first[first.length - 1].restore).toBe(true)

    await act(async () => { anchor('term-old') })
    // terminal.created consumed the restore flag (TerminalView:3694).
    await act(async () => { launchInvalidTerminal('term-old') })

    // NOT a dead end: still creating, no error status.
    expect(paneStatus(store)).toBe('creating')

    const before = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(RATE_LIMIT_RETRY_BASE_MS) })
    const after = sentCreates()
    expect(after.length).toBe(before + 1)
    const retried = after[after.length - 1]
    expect(retried.requestId).toBe(REQ)      // SAME createRequestId
    expect(retried.restore).toBe(true)       // re-armed before the retry
  })

  it('a non-restore launch also retries (without restore:true) instead of dying', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)
    await act(async () => { anchor('term-old') })
    await act(async () => { launchInvalidTerminal('term-old') })
    expect(paneStatus(store)).toBe('creating')
    const before = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(RATE_LIMIT_RETRY_BASE_MS) })
    const after = sentCreates()
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].requestId).toBe(REQ)
    expect(after[after.length - 1].restore).toBeUndefined()
  })

  it('caps retries at RATE_LIMIT_RETRY_MAX_ATTEMPTS even when every round anchors (terminal.created must NOT refund the budget)', async () => {
    // This test deliberately anchors between every failure round. It can only
    // pass if Step 1.3's :3689 change (full clearRateLimitRetry -> timer-only
    // cancelCreateRetryTimer) is in place: with today's anchor-time refund the
    // counter would oscillate 0->1->0->1 and exhaustion would never happen.
    vi.useFakeTimers()
    addTerminalRestoreRequestId(REQ)
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)

    await act(async () => { anchor('term-0') })
    await act(async () => { launchInvalidTerminal('term-0') })

    for (let attempt = 1; attempt <= RATE_LIMIT_RETRY_MAX_ATTEMPTS; attempt++) {
      const delay = Math.min(RATE_LIMIT_RETRY_BASE_MS * 2 ** (attempt - 1), RATE_LIMIT_RETRY_MAX_MS)
      const before = sentCreates().length
      await act(async () => { vi.advanceTimersByTime(delay) })
      expect(sentCreates().length).toBe(before + 1) // retry N fired
      // Each retry round anchors to a fresh terminal, then fails again —
      // except we stop failing after the last scheduled retry to check the cap.
      await act(async () => { anchor(`term-${attempt}`) })
      await act(async () => { launchInvalidTerminal(`term-${attempt}`) })
    }

    // Budget exhausted (5 schedules consumed) -> the 6th failure fell through
    // to failLaunch inside the loop's final iteration. The visible failure is
    // serialized through TerminalWriteQueue; let the queued frame/microtask
    // settle before asserting on the xterm mock.
    expect(paneStatus(store)).toBe('error')
    await act(async () => {
      vi.advanceTimersByTime(20)
      await Promise.resolve()
    })
    const wroteFailure = terminalInstances.some((t: any) =>
      t.write.mock.calls.some(([data]: [string]) => String(data).includes('[Restore failed]')))
    expect(wroteFailure).toBe(true)
    // And no further create is scheduled.
    const total = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(sentCreates().length).toBe(total)
  })

  it('does NOT retry a launch failure that carries a nonzero terminalExitCode (crashed CLI is not respawn-stormed)', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore()
    await renderPane(store, paneContent)
    await act(async () => { anchor('term-old') })
    await act(async () => {
      messageHandler!({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Terminal exited (exit 127)',
        terminalId: 'term-old',
        terminalExitCode: 127,
      })
    })
    expect(paneStatus(store)).toBe('error')
    const total = sentCreates().length
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(sentCreates().length).toBe(total)
  })
})

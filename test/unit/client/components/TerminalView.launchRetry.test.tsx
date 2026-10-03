import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { updatePaneContent } from '@/store/panesSlice'
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

const retryManagedRuntimeSoul = vi.hoisted(() => vi.fn())
const queueManagedRuntimeRefresh = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/lib/recovery/managed-runtime-recovery', () => ({ queueManagedRuntimeRefresh }))
const stopManagedRuntimeSoul = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  stopManagedRuntimeSoul,
  retryManagedRuntimeSoul,
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
let lastMessageCallback: ((msg: any) => void) | null = null
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
      lastMessageCallback = callback
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
    lastMessageCallback = null
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
    // to failLaunch inside the loop's final iteration.
    expect(paneStatus(store)).toBe('error')
    await act(async () => { vi.advanceTimersByTime(17) })
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

  it.each(['verified_empty', 'termination_unconfirmed', 'blocked_ownership', 'backend_unavailable', 'http_failure', 'missing_revision', 'missing_soul'])(
    'waits for exact-soul cleanup before replacing a lost terminal: %s', async (outcome) => {
      stopManagedRuntimeSoul.mockReset()
      let resolveStop!: (value: unknown) => void
      let rejectStop!: (error: Error) => void
      stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject }))
      const { store, paneContent } = makeStore()
      const content: TerminalPaneContent = {
        ...paneContent, status: 'error', mode: 'codex', terminalId: 'lost-terminal',
        sessionRef: { provider: 'codex', sessionId: 'retained-thread' }, resumeSessionId: 'retained-thread',
        soulId: outcome === 'missing_soul' ? undefined : 'persisted-lost-terminal-soul',
        soulIntentRevision: outcome === 'missing_revision' ? undefined : 21,
        recoverySummary: { desiredState: 'stopped', recoveryState: 'lost',
          durabilityState: 'resume_captured', allocationState: 'verified_durable' },
      }
      store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
      render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
      const retained = (store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content
      wsMocks.send.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
      if (outcome.startsWith('missing_')) {
        expect(await within(screen.getByTestId('managed-runtime-recovery-card')).findByRole('status')).toHaveTextContent('Your conversation has been kept')
        expect(stopManagedRuntimeSoul).not.toHaveBeenCalled()
        expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content).toMatchObject(retained)
        expect(sentCreates()).toHaveLength(0)
        return
      }
      await waitFor(() => expect(stopManagedRuntimeSoul).toHaveBeenCalledWith(content.soulId, 21))
      expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content).toMatchObject(content)
      expect(sentCreates()).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()

      await act(async () => {
        if (outcome === 'http_failure') rejectStop(new Error('Server is unavailable'))
        else resolveStop({ outcome, soul: { soulId: content.soulId, intentRevision: 21 } })
      })
      const after = (store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content
      if (outcome === 'verified_empty') {
        expect(after.createRequestId).not.toBe(content.createRequestId)
        expect(after.soulId).toBeUndefined()
        expect(after.sessionRef).toBeUndefined()
      } else {
        expect(after).toMatchObject(content)
        expect(await within(screen.getByTestId('managed-runtime-recovery-card')).findByRole('status')).toHaveTextContent(outcome === 'http_failure' ? 'Server is unavailable' : 'Your conversation has been kept')
        expect(sentCreates()).toHaveLength(0)
      }
    },
  )

  it.each([
    ['recovery', 'verified_empty'], ['recovery', 'termination_unconfirmed'], ['recovery', 'http_failure'],
    ['launch', 'verified_empty'], ['launch', 'termination_unconfirmed'], ['launch', 'http_failure'],
  ] as const)('does not alter a different terminal pane after a late %s card %s stop result', async (surface, outcome) => {
    stopManagedRuntimeSoul.mockReset()
    let resolveStop!: (value: unknown) => void
    let rejectStop!: (error: Error) => void
    stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject }))
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', soulId: 'old-soul', soulIntentRevision: 21,
      ...(surface === 'recovery'
        ? { recoverySummary: { desiredState: 'stopped', recoveryState: 'lost', durabilityState: 'resume_captured', allocationState: 'verified_durable' } as const }
        : { launchFailure: { code: 'SESSION_MISSING', message: 'The durable session is gone.', retryable: false } as const }),
    }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    const card = screen.getByTestId(surface === 'recovery' ? 'managed-runtime-recovery-card' : 'terminal-launch-failure-card')
    fireEvent.click(surface === 'recovery'
      ? within(card).getByRole('button', { name: 'Start new conversation' })
      : within(card).getByTestId('terminal-launch-failure-start-fresh'))
    await waitFor(() => expect(stopManagedRuntimeSoul).toHaveBeenCalledWith('old-soul', 21))
    const replacement = { ...content, createRequestId: 'different-create', soulId: 'different-soul' }
    act(() => store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: replacement })))
    // The mounted prop/ref is intentionally stale; the store already owns a different pane.
    await act(async () => {
      if (outcome === 'http_failure') rejectStop(new Error('Stale request failed'))
      else resolveStop({ outcome, soul: { soulId: 'old-soul', intentRevision: 22 } })
    })
    expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content).toMatchObject(replacement)
    expect(within(card).queryByRole('status')).toBeNull()
  })

  it.each(['newer_pane', 'older_result', 'wrong_soul'])('does not replace terminal authority after a %s stop response', async (scenario) => {
    stopManagedRuntimeSoul.mockReset()
    let resolveStop!: (value: unknown) => void
    stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve }))
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', soulId: 'same-soul', soulIntentRevision: 21,
      recoverySummary: { desiredState: 'stopped', recoveryState: 'lost', durabilityState: 'resume_captured', allocationState: 'verified_durable' } }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    if (scenario === 'newer_pane') act(() => store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: { ...content, soulIntentRevision: 24 } })))
    await act(async () => resolveStop({ outcome: 'verified_empty', soul: {
      soulId: scenario === 'wrong_soul' ? 'different-soul' : 'same-soul',
      intentRevision: scenario === 'older_result' ? 20 : 22,
    } }))
    const after = (store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content
    expect(after).toMatchObject({ ...content, soulIntentRevision: scenario === 'newer_pane' ? 24 : 21 })
    const card = screen.getByTestId('managed-runtime-recovery-card')
    if (scenario === 'newer_pane') expect(within(card).queryByRole('status')).toBeNull()
    else expect(await within(card).findByRole('status')).toHaveTextContent('Your conversation has been kept')
  })

  it('immediately retries a running SESSION_MISSING terminal with the committed stop revision', async () => {
    stopManagedRuntimeSoul.mockReset()
    let serverRevision = 21
    let running = true
    let resolveVerified!: (value: unknown) => void
    stopManagedRuntimeSoul.mockImplementation((_soulId: string, revision: number) => {
      if (revision !== serverRevision) return Promise.reject(new Error('Stale intent revision'))
      if (running) {
        running = false
        serverRevision += 1
        return Promise.resolve({ outcome: 'termination_unconfirmed', soul: { soulId: 'running-soul', intentRevision: serverRevision } })
      }
      return new Promise((resolve) => { resolveVerified = resolve })
    })
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', terminalId: 'old-terminal',
      soulId: 'running-soul', soulIntentRevision: 21,
      sessionRef: { provider: 'codex', sessionId: 'retained-thread' },
      launchFailure: { code: 'SESSION_MISSING', message: 'The durable session is gone.', retryable: false },
    }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    const card = screen.getByTestId('terminal-launch-failure-card')
    wsMocks.send.mockClear()
    fireEvent.click(within(card).getByTestId('terminal-launch-failure-start-fresh'))
    expect(await within(card).findByRole('status')).toHaveTextContent('Your conversation has been kept')
    const retained = (store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content
    expect(retained).toMatchObject({ createRequestId: content.createRequestId, soulId: 'running-soul', soulIntentRevision: 22, sessionRef: content.sessionRef })
    fireEvent.click(within(card).getByTestId('terminal-launch-failure-start-fresh'))
    await waitFor(() => expect(stopManagedRuntimeSoul).toHaveBeenNthCalledWith(2, 'running-soul', 22))
    expect(within(card).getByTestId('terminal-launch-failure-start-fresh')).toBeDisabled()
    expect(sentCreates()).toHaveLength(0)
    await act(async () => resolveVerified({ outcome: 'verified_empty', soul: { soulId: 'running-soul', intentRevision: 22 } }))
    expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content.createRequestId).not.toBe(content.createRequestId)
  })

  it('reports a rejected SESSION_MISSING start-fresh request inline and retains identity while pending', async () => {
    stopManagedRuntimeSoul.mockReset()
    let rejectStop!: (error: Error) => void
    stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectStop = reject }))
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', terminalId: 'retained-terminal',
      soulId: 'missing-session-soul', soulIntentRevision: 6, sessionRef: { provider: 'codex', sessionId: 'retained-thread' },
      launchFailure: { code: 'SESSION_MISSING', message: 'The durable session is gone.', retryable: false },
    }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    const card = screen.getByTestId('terminal-launch-failure-card')
    const button = within(card).getByTestId('terminal-launch-failure-start-fresh')
    wsMocks.send.mockClear()
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('Starting…')
    fireEvent.click(button)
    expect(stopManagedRuntimeSoul).toHaveBeenCalledTimes(1)
    expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content).toMatchObject(content)
    expect(sentCreates()).toHaveLength(0)
    await act(async () => rejectStop(new Error('Server is unavailable')))
    expect(await within(card).findByRole('status')).toHaveTextContent('Server is unavailable')
    expect(button).toBeEnabled()
    expect((store.getState().panes.layouts[TAB] as { content: TerminalPaneContent }).content).toMatchObject(content)
  })

  it.each(['blocked', 'lost'] as const)('shows only the managed %s decision when a prior launch failure exists', async (recoveryState) => {
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', soulId: 'same-soul', soulIntentRevision: 19,
      launchFailure: { code: 'LAUNCH_FAILED', message: 'Old launch failed', retryable: true },
      recoverySummary: { desiredState: 'running', recoveryState, reason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured', allocationState: 'verified_durable' } }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.queryByTestId('terminal-launch-failure-card')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry', exact: true })).not.toBeInTheDocument()
  })

  it('clears prior managed retry feedback when a different terminal conversation occupies the pane', async () => {
    retryManagedRuntimeSoul.mockRejectedValueOnce(new Error('Old conversation repair failed'))
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', soulId: 'old-retry-soul', soulIntentRevision: 19,
      recoverySummary: { desiredState: 'running', recoveryState: 'blocked', reason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured', allocationState: 'verified_durable' } }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    const view = render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    expect(await within(screen.getByTestId('managed-runtime-recovery-card')).findByRole('status')).toHaveTextContent('Old conversation repair failed')
    const replacement = { ...content, createRequestId: 'new-retry-create', soulId: 'new-retry-soul' }
    act(() => store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: replacement })))
    view.rerender(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={replacement} /></Provider>)
    expect(within(screen.getByTestId('managed-runtime-recovery-card')).queryByRole('status')).toBeNull()
  })

  it.each(['repair', 'reason', 'stale_result', 'stale_error', 'different_create', 'different_soul'] as const)('handles a managed terminal retry: %s', async (scenario) => {
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    retryManagedRuntimeSoul.mockReset()
    queueManagedRuntimeRefresh.mockClear()
    retryManagedRuntimeSoul.mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej }))
    const { store, paneContent } = makeStore()
    const content: TerminalPaneContent = { ...paneContent, status: 'error', soulId: 'retry-soul', soulIntentRevision: 19,
      recoverySummary: { desiredState: 'running', recoveryState: 'blocked', reason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured', allocationState: 'verified_durable' } }
    store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content }))
    render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={content} /></Provider>)
    const card = screen.getByTestId('managed-runtime-recovery-card')
    fireEvent.click(within(card).getByRole('button', { name: 'Retry recovery' }))
    expect(retryManagedRuntimeSoul).toHaveBeenCalledWith('retry-soul', 19)
    const stale = scenario.startsWith('stale') || scenario.startsWith('different')
    if (stale) act(() => store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: { ...content,
      ...(scenario === 'different_create' ? { createRequestId: 'another-create' }
        : scenario === 'different_soul' ? { soulId: 'another-soul' } : { soulIntentRevision: 20 }),
    } })))
    await act(async () => {
      if (scenario === 'stale_error') reject(new Error('Obsolete retry failure'))
      else resolve({ outcome: 'blocked', view: { soulId: 'retry-soul', intentRevision: 19, recoveryReason: 'OLD_RUNTIME_NOT_EMPTY' },
        probe: { kind: 'blocked', data: { reason: 'OLD_RUNTIME_NOT_EMPTY', retry_hint: { manualRetry: true,
          ...(scenario === 'reason' ? {} : { repair: 'Confirm the old process has stopped, then retry.' }) } } } })
    })
    if (stale) expect(within(card).queryByRole('status')).toBeNull()
    else expect(await within(card).findByRole('status')).toHaveTextContent(scenario === 'repair'
      ? 'Confirm the old process has stopped, then retry.' : 'The previous agent process could not be confirmed stopped. Check it before retrying recovery.')
  })

  it('keeps a blocked managed pane from re-creating after a rejected-terminal callback', async () => {
    const { store, paneContent } = makeStore()
    const rendered = render(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
      </Provider>,
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const createsBeforeManagedDecision = sentCreates().length
    expect(createsBeforeManagedDecision).toBeGreaterThan(0)

    store.dispatch(updatePaneContent({
      tabId: TAB,
      paneId: PANE,
      content: {
        ...paneContent,
        terminalId: 'term-managed-lost',
        status: 'error',
        mode: 'opencode',
        soulId: 'soul-managed',
        soulIntentRevision: 4,
        recoverySummary: {
          desiredState: 'stopped',
          recoveryState: 'blocked',
          reason: 'provider_unavailable',
          durabilityState: 'resume_captured',
          allocationState: 'verified_durable',
        },
      },
    }))
    const managedPane = store.getState().panes.layouts[TAB]
    if (managedPane.type !== 'leaf') throw new Error('expected managed leaf')
    await act(async () => {
      rendered.rerender(
        <Provider store={store}>
          <TerminalView tabId={TAB} paneId={PANE} paneContent={managedPane.content} />
        </Provider>,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('managed-runtime-recovery-card')).toBeInTheDocument()
    expect(wsMocks.send.mock.calls.some(([message]) => message?.type === 'terminal.attach')).toBe(false)
    const createsBeforeRejectedTerminal = sentCreates().length
    expect(lastMessageCallback).not.toBeNull()
    await act(async () => {
      lastMessageCallback?.({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        terminalId: 'term-managed-lost',
      })
    })
    expect(sentCreates()).toHaveLength(createsBeforeRejectedTerminal)
  })
})

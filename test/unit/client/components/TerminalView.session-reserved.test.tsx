import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, {
  applyReconcileAttach,
  resetPaneForReconcileCreate,
  RECONCILE_NOTICE_CORRECTED,
} from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

// Task 12: verdict-driven create args, SESSION_RESERVED bounded re-drive,
// launch-time INVALID_TERMINAL_ID bounded re-drive (F9), and exhaustion
// auto-resolve via a single-pane reconcile (council rule 8).
//
// Mounting scaffold copied from TerminalView.restore-flag-persistence.test.tsx.

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const send = vi.fn()
  const connect = vi.fn().mockResolvedValue(undefined)
  const onMessage = vi.fn((handler: (msg: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn(() => () => {})
  return {
    send,
    connect,
    onMessage,
    onReconnect,
    emit(msg: any) {
      for (const handler of [...messageHandlers]) handler(msg)
    },
    reset() {
      messageHandlers.clear()
      send.mockReset()
      connect.mockClear()
      onMessage.mockClear()
      onReconnect.mockClear()
    },
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

const terminalInstances = vi.hoisted(() => [] as any[])

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn((_data: string, cb?: () => void) => cb?.())
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

import TerminalView from '@/components/TerminalView'

const TAB_ID = 'tab1'
const PANE_ID = 'p1'

function paneContentWith(overrides: Partial<TerminalPaneContent> = {}): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'cr-1',
    status: 'creating',
    mode: 'shell',
    shell: 'system',
    initialCwd: '/tmp',
    ...overrides,
  }
}

function buildStore(paneContent: TerminalPaneContent) {
  const root: PaneNode = { type: 'leaf', id: PANE_ID, content: paneContent }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB_ID,
          mode: paneContent.mode,
          status: paneContent.status,
          title: 'Terminal',
          titleSetByUser: false,
          createRequestId: paneContent.createRequestId,
        }],
        activeTabId: TAB_ID,
      },
      panes: {
        layouts: { [TAB_ID]: root },
        activePane: { [TAB_ID]: PANE_ID },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    } as any,
  })
}

async function flushEffects() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

// Production passes paneContent selected from the store, so a store dispatch
// (e.g. a reconcile verdict fold) re-renders TerminalView with fresh content.
// Mirror that wiring instead of pinning a static prop.
function ConnectedTerminalView() {
  const content = useSelector((state: any) => {
    const layout = state.panes.layouts[TAB_ID] as { type: 'leaf'; content: TerminalPaneContent }
    return layout.content
  })
  return <TerminalView tabId={TAB_ID} paneId={PANE_ID} paneContent={content} />
}

async function mountPane(overrides: Partial<TerminalPaneContent> = {}) {
  const paneContent = paneContentWith(overrides)
  const store = buildStore(paneContent)
  render(
    <Provider store={store}>
      <ConnectedTerminalView />
    </Provider>
  )
  await flushEffects()
  return { store }
}

function sentOfType(type: string) {
  return wsHarness.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === type)
}

function countSentOfType(type: string) {
  return sentOfType(type).length
}

function lastSentOfType(type: string) {
  const all = sentOfType(type)
  return all[all.length - 1]
}

function lastAttachedTerminalId(): string | undefined {
  return lastSentOfType('terminal.attach')?.terminalId
}

function paneContent(store: ReturnType<typeof buildStore>): TerminalPaneContent {
  const layout = store.getState().panes.layouts[TAB_ID] as { type: 'leaf'; content: TerminalPaneContent }
  return layout.content
}

function xtermWrites(): string[] {
  return terminalInstances.flatMap((t: any) => t.write.mock.calls.map(([data]: [string]) => String(data)))
}

describe('TerminalView reconcile adoption: verdict-driven create + bounded re-drive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    wsHarness.reset()
    terminalInstances.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /// REQUIRED red test (A1 fix): folding a verdict into an ALREADY-MOUNTED pane
  /// (same createRequestId — never re-minted) must re-fire the create-or-attach
  /// effect via the reconcileEpoch bump. Without the dep-array change this is
  /// inert (deps key on createRequestId only, TerminalView.tsx:4486).
  it('respawn fold into a mounted pane re-fires the effect (terminal.create sent, same createRequestId)', async () => {
    const { store } = await mountPane({
      mode: 'claude',
      status: 'running',
      createRequestId: 'cr-1',
      terminalId: 'term-old',
    })
    // A mounted pane with a live terminalId attaches — it never creates.
    expect(countSentOfType('terminal.create')).toBe(0)

    act(() => {
      store.dispatch(resetPaneForReconcileCreate({
        tabId: TAB_ID,
        paneId: PANE_ID,
        intent: 'respawn',
        sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      }))
    })
    await flushEffects()

    expect(countSentOfType('terminal.create')).toBe(1)               // effect re-fired
    expect(lastSentOfType('terminal.create').requestId).toBe('cr-1') // never re-minted
  })

  it('attach fold into a mounted pane re-fires the effect (xterm attaches to the new terminalId)', async () => {
    const { store } = await mountPane({
      status: 'running',
      createRequestId: 'cr-1',
      terminalId: 'term-old',
    })
    expect(lastAttachedTerminalId()).toBe('term-old')

    act(() => {
      store.dispatch(applyReconcileAttach({
        tabId: TAB_ID,
        paneId: PANE_ID,
        terminalId: 'term-new',
      }))
    })
    await flushEffects()

    expect(lastAttachedTerminalId()).toBe('term-new')
  })

  it('respawn create uses the server-named sessionRef with restore:true', async () => {
    await mountPane({
      mode: 'claude',
      pendingReconcile: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      status: 'creating',
      createRequestId: 'cr-1',
    })
    const create = lastSentOfType('terminal.create')
    expect(create).toBeTruthy()
    expect(create.restore).toBe(true)
    expect(create.sessionRef).toMatchObject({ provider: 'claude', sessionId: 'server-truth' })
  })

  it('fresh create omits resume fields entirely', async () => {
    await mountPane({
      mode: 'claude',
      pendingReconcile: 'fresh',
      // Stale identity deliberately left in place: sendCreate must not send it.
      sessionRef: { provider: 'claude', sessionId: 'stale-identity' },
      resumeSessionId: 'stale-identity',
      status: 'creating',
      createRequestId: 'cr-1',
    })
    const create = lastSentOfType('terminal.create')
    expect(create).toBeTruthy()
    expect(create.sessionRef).toBeUndefined()
    expect(create.codexDurability).toBeUndefined()
    expect(create.liveTerminal).toBeUndefined()
    expect(create.restore).toBeUndefined()
  })

  it('SESSION_RESERVED re-drives the same create after retryAfterMs, same createRequestId', async () => {
    const { store } = await mountPane({
      mode: 'claude',
      pendingReconcile: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      status: 'creating',
      createRequestId: 'cr-1',
    })
    expect(countSentOfType('terminal.create')).toBe(1)

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_RESERVED',
        message: 'Session is reserved by another create',
        requestId: 'cr-1',
        retryAfterMs: 1000,
      })
    })
    // No immediate resend, and NOT a terminal error state.
    expect(countSentOfType('terminal.create')).toBe(1)
    expect(paneContent(store).status).toBe('creating')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(countSentOfType('terminal.create')).toBe(2)
    expect(lastSentOfType('terminal.create').requestId).toBe('cr-1') // never re-minted
  })

  /// loser-exhausts-then-holder-fails (council red test, client half):
  it('exhaustion auto-resolves via a single-pane reconcile — never a wedge', async () => {
    const { store } = await mountPane({
      mode: 'claude',
      pendingReconcile: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      status: 'creating',
      createRequestId: 'cr-1',
    })
    expect(countSentOfType('terminal.create')).toBe(1)

    // Keep answering SESSION_RESERVED past the 30s window.
    wsHarness.send.mockImplementation((msg: any) => {
      if (msg?.type === 'terminal.create') {
        queueMicrotask(() => {
          wsHarness.emit({
            type: 'error',
            code: 'SESSION_RESERVED',
            message: 'Session is reserved by another create',
            requestId: msg.requestId,
            retryAfterMs: 1000,
          })
        })
      }
    })
    // Kick the loop with the response to the initial create.
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_RESERVED',
        message: 'Session is reserved by another create',
        requestId: 'cr-1',
        retryAfterMs: 1000,
      })
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })

    const reconcileRequest = lastSentOfType('pane.reconcile.request')
    expect(reconcileRequest).toBeTruthy()
    expect(reconcileRequest.panes).toHaveLength(1)
    expect(reconcileRequest.panes[0].createRequestId).toBe('cr-1')

    // Holder failed -> server answers dead_session; the fold must run and
    // leave a visible, adjudicable state (never a silent wedge).
    act(() => {
      wsHarness.emit({
        type: 'pane.reconcile.result',
        reconcileId: reconcileRequest.reconcileId,
        serverInstanceId: 'srv-1',
        verdicts: [{
          paneKey: reconcileRequest.panes[0].paneKey,
          verdict: 'dead_session',
          reason: 'session_file_missing',
          sessionRef: { provider: 'claude', sessionId: 'server-truth' },
        }],
      })
    })
    await flushEffects()

    expect(paneContent(store).restoreError).toBeTruthy()

    // No-modal contract (Task 2): the dead verdict explains itself with
    // exactly ONE notice line written directly into the pane's own stale
    // buffer (CRLF-framed) — never a modal. The fold's dead-copy mint is
    // consumed one-shot, and the STORE copy never reaches the buffer.
    const deadNoticeLine = '\r\n[This pane\'s saved session no longer exists on disk - close this pane or start a new one]\r\n'
    expect(xtermWrites().filter((data) => data === deadNoticeLine)).toHaveLength(1)
    expect(xtermWrites().some((data) => data.includes('Saved session no longer exists on disk.'))).toBe(false)
    expect(paneContent(store).reconcileNotice).toBeUndefined()
  })

  it('INVALID_TERMINAL_ID at launch is retried bounded (F9), not a permanent error', async () => {
    const { store } = await mountPane({
      status: 'creating',
      createRequestId: 'cr-1',
      terminalId: 'term-stale',
      serverInstanceId: 'srv-old',
    })
    expect(countSentOfType('terminal.create')).toBe(0)

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId: 'term-stale',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(countSentOfType('terminal.create')).toBeGreaterThanOrEqual(2)
    // Every re-drive re-sends the SAME createRequestId (council rule 2).
    for (const create of sentOfType('terminal.create')) {
      expect(create.requestId).toBe('cr-1')
    }
    expect(paneContent(store).status).toBe('creating') // not a permanent error mid-retry
  })

  it('reconcileNotice is written to the terminal once after attach, then cleared', async () => {
    const { store } = await mountPane({
      status: 'running',
      createRequestId: 'cr-1',
      terminalId: 'term-old',
    })

    act(() => {
      store.dispatch(applyReconcileAttach({
        tabId: TAB_ID,
        paneId: PANE_ID,
        terminalId: 'term-new',
        corrected: true,
      }))
    })
    await flushEffects()

    expect(xtermWrites().some((data) => data.includes(RECONCILE_NOTICE_CORRECTED))).toBe(true)
    expect(paneContent(store).reconcileNotice).toBeUndefined()
  })
})

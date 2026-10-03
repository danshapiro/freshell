import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import terminalLifecycleReducer, { selectExitRecordFrom } from '@/store/terminalLifecycleSlice'
import { updatePaneContent } from '@/store/panesSlice'
import { resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import type { CrashTrace, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { __resetTerminalCursorCacheForTests } from '@/lib/terminal-cursor'
import { resetHydrationQueueForTests } from '@/lib/hydration-queue'
import { installPerfAuditBridge } from '@/lib/perf-audit-bridge'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

// Store + render harness mirrored from TerminalView.launchRetry.test.tsx
// (hoisted ws/xterm/lucide mocks, beforeEach/afterEach resets), trimmed to
// what an already-settled pane needs: these suites never replay attach
// streams, so the attachRequestId bookkeeping is omitted.

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
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
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView, { __resetLastSentViewportCacheForTests } from '@/components/TerminalView'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

let messageHandler: ((msg: any) => void) | null = null
let reconnectHandler: (() => void) | null = null
let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

const REQ = 'req-exit-banner'
const TAB = 'tab-exit-banner'
const PANE = 'pane-exit-banner'
const SESSION_ID = 'sess-keep'

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

interface StoreOptions {
  mode?: string
  status?: TerminalPaneContent['status']
  withSessionRef?: boolean
  crashTrace?: CrashTrace
  recoveryState?: NonNullable<TerminalPaneContent['recoverySummary']>['recoveryState']
  lifecycle?: {
    lastTerminalId?: string
    exit?: { exitCode: number; at: number }
    notice?: { kind: 'recovering'; attempt: number; maxAttempts: number; exitCode: number; at: number }
  }
}

function makeStore(opts: StoreOptions = {}) {
  const mode = opts.mode ?? 'claude'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: REQ,
    status: opts.status ?? 'exited',
    mode: mode as TerminalPaneContent['mode'],
    shell: 'system',
    ...(opts.recoveryState ? { soulId: 'managed-soul', recoverySummary: { desiredState: 'running' as const, recoveryState: opts.recoveryState, reason: 'provider_unavailable', durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } } : {}),
    ...(opts.crashTrace ? { crashTrace: opts.crashTrace } : {}),
    ...(opts.withSessionRef === false
      ? {}
      : { sessionRef: { provider: mode, sessionId: SESSION_ID } }),
  }
  const root: PaneNode = { type: 'leaf', id: PANE, content: paneContent }
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      terminalLifecycle: terminalLifecycleReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB, mode, status: paneContent.status, title: 'Agent',
          titleSetByUser: false, createRequestId: REQ,
        }],
        activeTabId: TAB,
      },
      panes: { layouts: { [TAB]: root }, activePane: { [TAB]: PANE }, paneTitles: {} },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
      terminalLifecycle: {
        byPaneId: opts.lifecycle ? { [PANE]: opts.lifecycle } : {},
      },
    } as any,
  })
  return { store, paneContent }
}

function paneState(store: ReturnType<typeof makeStore>['store']) {
  const layout = store.getState().panes.layouts[TAB] as { type: 'leaf'; content: any }
  return layout.content
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

describe('TerminalView exited-pane error banner', () => {
  beforeEach(() => {
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    resetHydrationQueueForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    wsMocks.send.mockClear()
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
    resetEnsureExtensionsRegistryCacheForTests()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        reconnectHandler = null
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
    __resetTerminalCursorCacheForTests()
    resetHydrationQueueForTests()
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
    installPerfAuditBridge(null)
  })

  it('shows the alert error bar for an agent pane settled exited with a non-zero exit record', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: { exit: { exitCode: 1, at: Date.now() } },
    })
    await renderPane(store, paneContent)

    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited (code 1)')
    expect(screen.getByRole('button', { name: 'Relaunch claude session' })).toBeInTheDocument()
  })

  it('Relaunch resets the pane for a respawn create with the SAME sessionRef', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: { exit: { exitCode: 1, at: Date.now() } },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Relaunch claude session' }))
    })

    const content = paneState(store)
    expect(content.status).toBe('creating')
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.sessionRef?.sessionId).toBe(SESSION_ID) // unchanged from seed
    expect(content.terminalId).toBeUndefined()
  })

  it('Relaunch clears the stale exit record so a failed relaunch does not resurrect the old crash banner', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: { exit: { exitCode: 1, at: Date.now() } },
    })
    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
      </Provider>
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(messageHandler).not.toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Relaunch claude session' }))
    })

    // The click must discard the PREVIOUS crash's record — a genuine
    // crash-during-relaunch still repopulates via recordTerminalExit.
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()

    // Relaunch create rejected: the pane settles 'error' with NO new
    // terminal.exit. The stale "process exited (code 1)" must not linger.
    act(() => {
      store.dispatch(updatePaneContent({
        tabId: TAB,
        paneId: PANE,
        content: { ...paneState(store), terminalId: undefined, streamId: undefined, status: 'error' },
      }))
    })
    rerender(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneState(store)} />
      </Provider>
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps shell panes quiet: no alert for an exited shell even with a non-zero exit record', async () => {
    const { store, paneContent } = makeStore({
      mode: 'shell',
      status: 'exited',
      withSessionRef: false,
      lifecycle: { exit: { exitCode: 1, at: Date.now() } },
    })
    await renderPane(store, paneContent)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps clean exits quiet: no alert for an agent pane with exit code 0 (D-3)', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: { exit: { exitCode: 0, at: Date.now() } },
    })
    await renderPane(store, paneContent)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a codeless alert with Relaunch for an exited agent pane with NO exit record (post-reload)', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      // ephemeral slice is empty after a page reload
    })
    await renderPane(store, paneContent)

    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited')
    expect(bar).not.toHaveTextContent('(code')
    expect(screen.getByRole('button', { name: 'Relaunch claude session' })).toBeInTheDocument()
  })

  it("treats a status-'error' agent pane WITH a non-zero exit record as a crash (alert + Relaunch); without a record it stays quiet", async () => {
    // Crash before terminal.attach.ready settles via failLaunch as 'error'
    // (crash-during-launch) — same user situation as an 'exited' crash.
    const crashed = makeStore({
      mode: 'claude',
      status: 'error',
      lifecycle: { exit: { exitCode: 1, at: Date.now() } },
    })
    await renderPane(crashed.store, crashed.paneContent)

    expect(screen.getByRole('alert')).toHaveTextContent('process exited (code 1)')
    expect(screen.getByRole('button', { name: 'Relaunch claude session' })).toBeInTheDocument()

    cleanup()
    messageHandler = null

    // Plain launch failure (create rejected — no exit record) keeps today's
    // presentation: no alert.
    const plainFailure = makeStore({ mode: 'claude', status: 'error' })
    await renderPane(plainFailure.store, plainFailure.paneContent)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the recovering notice up while the socket stays connected without a settle frame (no timer degradation — znhn#6 pin)', async () => {
    // Scope (D-3, validated): "no timer degradation" holds WHILE CONNECTED.
    // A disconnect/reconnect clears stale notices via the reconnect backstop
    // (tested below) — missed-frame paths always pass through a reconnect.
    vi.useFakeTimers()
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 1, at },
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(screen.getByText('claude crashed (exit 1) — auto-resuming, attempt 1/2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    vi.useRealTimers()
  })

  it('an out-of-order exited settle frame never touches pane content or status (D-1 allowlist pin)', async () => {
    // Cross-channel ordering (broadcast settle vs per-connection
    // terminal.exit) is NOT guaranteed (unbiased select!,
    // terminal.rs:325-334): the settle handler is lifecycle-only, and the
    // running|recovering content-write allowlist must block 'exited' from
    // pane content/status.
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'running',
      lifecycle: { lastTerminalId: 'term-live' },
    })
    const contentWithTid = { ...paneContent, terminalId: 'term-live' }
    act(() => {
      store.dispatch(updatePaneContent({ tabId: TAB, paneId: PANE, content: contentWithTid }))
    })
    await renderPane(store, paneState(store))

    await act(async () => {
      messageHandler!({ type: 'terminal.status', terminalId: 'term-live', status: 'exited', reason: 'retries_exhausted' })
    })

    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.terminalId).toBe('term-live')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a recovering notice does not survive a reconnect (D-3 backstop pin)', async () => {
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 1, at },
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    await renderPane(store, paneContent)
    expect(screen.getByText('claude crashed (exit 1) — auto-resuming, attempt 1/2')).toBeInTheDocument()
    expect(reconnectHandler).not.toBeNull()

    await act(async () => {
      reconnectHandler!()
    })
    expect(screen.queryByText(/auto-resuming/)).toBeNull()
  })

  it('clears the recovering notice the moment the settle frame arrives', async () => {
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 1, at },
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      messageHandler!({ type: 'terminal.status', terminalId: 'term-crashed', status: 'exited', reason: 'pane_closed' })
    })
    expect(screen.queryByText(/auto-resuming/)).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('process exited (code 1)')
  })

  it.each(['claude', 'codex', 'opencode'])('keeps %s managed automatic terminal events invisible and retains a final failure action', async (mode) => {
    const { store, paneContent } = makeStore({ mode, status: 'running', recoveryState: 'recovering',
      lifecycle: { lastTerminalId: 'term-crashed', exit: { exitCode: 137, at: Date.now() } } })
    const { rerender } = render(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} /></Provider>)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    act(() => messageHandler!({ type: 'terminal.status', terminalId: 'term-crashed', status: 'recovering',
      attempt: 1, maxAttempts: 3, exitCode: 137 }))
    expect(store.getState().terminalLifecycle.byPaneId[PANE].notice?.kind).toBe('recovering')
    expect(screen.queryByText(/auto-resuming/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => messageHandler!({ type: 'terminal.replaced', oldTerminalId: 'term-crashed', newTerminalId: 'term-new',
      exitCode: 137, attempt: 1, maxAttempts: 3 }))
    rerender(<Provider store={store}><TerminalView tabId={TAB} paneId={PANE} paneContent={paneState(store)} /></Provider>)
    expect(paneState(store)).toMatchObject({ terminalId: 'term-new', sessionRef: { provider: mode, sessionId: SESSION_ID },
      crashTrace: { exitCode: 137 } })
    expect(screen.queryByTestId('crash-trace')).toBeNull()
    expect(screen.queryByText(/auto-resumed/)).toBeNull()
    act(() => messageHandler!({ type: 'terminal.status', terminalId: 'term-new', status: 'exited', exitCode: 137,
      resumeCycles: 3, reason: 'retries_exhausted' }))
    expect(screen.getByRole('alert')).toHaveTextContent('process exited (code 137)')
    expect(screen.getByRole('button', { name: `Relaunch ${mode} session` })).toBeInTheDocument()
    expect(screen.queryByText(/crashed 3 times/)).toBeNull()
  })

  it('terminal.replaced writes a persistent crash trace onto pane content and shows the trace strip', async () => {
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'running',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
      </Provider>
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(messageHandler).not.toBeNull()

    await act(async () => {
      messageHandler!({ type: 'terminal.replaced', oldTerminalId: 'term-crashed', newTerminalId: 'term-new', exitCode: 1, attempt: 1, maxAttempts: 2 })
    })

    // The store now carries it on pane CONTENT (the persisted home):
    const content = paneState(store)
    expect(content.crashTrace?.exitCode).toBe(1)
    expect(typeof content.crashTrace?.resumedAtMs).toBe('number')

    // Re-render with the updated content (in production the parent passes
    // fresh store content on every render).
    rerender(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneState(store)} />
      </Provider>
    )
    const trace = screen.getByTestId('crash-trace')
    expect(trace).toHaveTextContent(/claude crashed \(exit 1\) & auto-resumed at \d{2}:\d{2}/)
    expect(trace).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('dismissing the crash trace clears it from pane content', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'running',
      crashTrace: { exitCode: 1, resumedAtMs: Date.now() },
    })
    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
      </Provider>
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByTestId('crash-trace')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss claude crash notice' }))
    })
    expect(paneState(store).crashTrace).toBeUndefined()
    rerender(
      <Provider store={store}>
        <TerminalView tabId={TAB} paneId={PANE} paneContent={paneState(store)} />
      </Provider>
    )
    expect(screen.queryByTestId('crash-trace')).toBeNull()
  })

  it('cancel button sends terminal.autoResumeCancel with the old terminal id', async () => {
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 1, at },
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    await renderPane(store, paneContent)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel auto-resume for claude' }))
    expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.autoResumeCancel', terminalId: 'term-crashed' })
  })

  it('renders the circuit-breaker banner from the typed resumeCycles settle field (znhn#2)', async () => {
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 1, at },
        notice: { kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at },
      },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-crashed',
        status: 'exited',
        reason: 'flap_circuit_breaker',
        resumeCycles: 3,
      })
    })

    expect(screen.getByRole('alert')).toHaveTextContent('claude crashed 3 times — auto-resume paused')
    // canResume derives from the seeded sessionRef (provider matches mode):
    // the button copy is honest about resuming this conversation.
    expect(screen.getByRole('button', { name: 'Relaunch claude session' }))
      .toHaveTextContent('Relaunch — resumes this conversation')
  })

  it('shows the final crash alert when a replacement exits before terminal.attach delivers terminal.exit', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'running',
      lifecycle: { lastTerminalId: 'term-previous' },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      messageHandler!({
        type: 'terminal.replaced',
        oldTerminalId: 'term-previous',
        newTerminalId: 'term-final',
        exitCode: 1,
        attempt: 2,
        maxAttempts: 2,
      })
      // The final replacement dies before this client has an attach stream,
      // so no terminal.exit arrives; the server settles by broadcast.
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-final',
        status: 'exited',
        exitCode: 1,
        reason: 'retries_exhausted',
      })
    })

    expect(screen.getByRole('alert')).toHaveTextContent('process exited (code 1)')
    expect(screen.getByRole('button', { name: 'Relaunch claude session' })).toBeInTheDocument()
  })

  it('keeps a clean settle quiet when terminal.exit was not delivered', async () => {
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'running',
      lifecycle: { lastTerminalId: 'term-clean' },
    })
    await renderPane(store, paneContent)

    await act(async () => {
      messageHandler!({
        type: 'terminal.status', terminalId: 'term-clean',
        status: 'exited', exitCode: 0, reason: 'clean_exit',
      })
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders the recovering notice from the frame FIELDS — prose is presentational, never parsed', async () => {
    // Council MEDIUM fix (7w4h/xkhx review): the client must read
    // attempt/maxAttempts/exitCode from the terminal.status frame's typed
    // fields. The reason prose here is DELIBERATELY reworded so any regex
    // parse of it ("attempt n/m", "exit N") finds nothing — if the banner
    // still shows invented defaults (1/2, exit 1), prose is load-bearing.
    const at = Date.now()
    const { store, paneContent } = makeStore({
      mode: 'claude',
      status: 'exited',
      lifecycle: {
        lastTerminalId: 'term-crashed',
        exit: { exitCode: 137, at },
      },
    })
    await renderPane(store, paneContent)

    act(() => {
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-crashed',
        status: 'recovering',
        attempt: 1,
        maxAttempts: 3,
        exitCode: 137,
        reason: 'claude quit unexpectedly and is being brought back',
      })
    })

    expect(
      screen.getByText('claude crashed (exit 137) — auto-resuming, attempt 1/3')
    ).toBeInTheDocument()
  })
})

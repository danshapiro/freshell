import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, {
  applyReconcileAttach,
  resetPaneForReconcileCreate,
  setPaneReconcileNotice,
  setPaneRestoreError,
  setReconcilePendingPanes,
  RECONCILE_NOTICE_CORRECTED,
} from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { buildRestoreError } from '@shared/session-contract'
import { DEAD_SESSION_RECONCILE_NOTICES, deadSessionReconcileNoticeFor } from '@/lib/pane-reconcile'
// This suite deliberately does NOT mock terminal-restore (see the codex
// breadcrumb exemption pin below): the real registry carries the
// registration -> consume round trip, and the real setPaneReconcileActive
// is the harness seam that arms the negotiated-connection shape
// (paneReconcileV1 active) for the exemption tests.
import { setPaneReconcileActive } from '@/lib/terminal-restore'

// Task 12: verdict-driven create args, SESSION_RESERVED bounded re-drive,
// launch-time INVALID_TERMINAL_ID bounded re-drive (F9), and exhaustion
// auto-resolve via a single-pane reconcile (council rule 8).
//
// Mounting scaffold copied from TerminalView.restore-flag-persistence.test.tsx.

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const reconnectHandlers = new Set<() => void>()
  const send = vi.fn()
  const connect = vi.fn().mockResolvedValue(undefined)
  const onMessage = vi.fn((handler: (msg: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn((handler: () => void) => {
    reconnectHandlers.add(handler)
    return () => reconnectHandlers.delete(handler)
  })
  return {
    send,
    connect,
    onMessage,
    onReconnect,
    emit(msg: any) {
      for (const handler of [...messageHandlers]) handler(msg)
    },
    fireReconnect() {
      for (const handler of [...reconnectHandlers]) handler()
    },
    reset() {
      messageHandlers.clear()
      reconnectHandlers.clear()
      send.mockReset()
      connect.mockClear()
      onMessage.mockClear()
      onReconnect.mockClear()
    },
  }
})

vi.mock('@/lib/ws-client', async (importOriginal) => {
  // Keep the real module's exports (TerminalView imports
  // RECONCILE_VERDICT_WAIT_MS from it); replace only the client instance.
  const actual = await importOriginal<typeof import('@/lib/ws-client')>()
  return {
    ...actual,
    getWsClient: () => ({
      send: wsHarness.send,
      connect: wsHarness.connect,
      onMessage: wsHarness.onMessage,
      onReconnect: wsHarness.onReconnect,
      // Production clients always expose the ready getter (ws-client.ts);
      // the mounted-reconstruction completion gate reads it, and without it
      // the post-terminal.created attach silently abandons in a harness.
      isReady: true,
    }),
  }
})

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
    // terminal-restore's reconcile-active flag is module state shared by
    // every test in this file (the real registry). The exemption tests arm
    // the negotiated-connection shape; every other test must run with it
    // inactive, exactly like a legacy (non-negotiated) connection.
    setPaneReconcileActive(false)
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
    // the RESIDENT durable copy source (delta round 4, finding 1) and the
    // STORE copy never reaches the buffer.
    const deadNoticeLine = '\r\n[This pane\'s saved session no longer exists on disk - close this pane or start a new one]\r\n'
    expect(xtermWrites().filter((data) => data === deadNoticeLine)).toHaveLength(1)
    expect(xtermWrites().some((data) => data.includes('Saved session no longer exists on disk.'))).toBe(false)
    expect(paneContent(store).reconcileNotice).toBe(DEAD_SESSION_RECONCILE_NOTICES.missing)

    // Create-lane stand-down (delta review round 1, finding 1): after the
    // dead verdict fold NO further terminal.create may be sent — the pane
    // waits for the user's explicit resolution through existing chrome,
    // never an automatic duplicate resume attempt.
    const createsAfterFold = countSentOfType('terminal.create')
    await flushEffects()
    expect(countSentOfType('terminal.create')).toBe(createsAfterFold)
  })

  it('a dead verdict folded mid-standoff stands the reserve-redrive timer down (no resume create after the fold)', async () => {
    const { store } = await mountPane({
      mode: 'claude',
      pendingReconcile: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
      status: 'creating',
      createRequestId: 'cr-1',
    })
    expect(countSentOfType('terminal.create')).toBe(1)

    // The standoff re-drive arms its 1s timer (no immediate resend).
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_RESERVED',
        message: 'Session is reserved by another create',
        requestId: 'cr-1',
        retryAfterMs: 1000,
      })
    })
    expect(countSentOfType('terminal.create')).toBe(1)

    // A foreign reconcile round (e.g. the boot reconcile across a flap)
    // adjudicates the pane dead while the timer is armed: dispatch exactly
    // the fold's actions (the fold itself is pinned in pane-reconcile.test).
    act(() => {
      store.dispatch(setPaneRestoreError({
        tabId: TAB_ID,
        paneId: PANE_ID,
        restoreError: buildRestoreError('durable_artifact_missing'),
      }))
      store.dispatch(setPaneReconcileNotice({
        tabId: TAB_ID,
        paneId: PANE_ID,
        notice: deadSessionReconcileNoticeFor('session_file_missing'),
      }))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The timer fired and STOOD DOWN: the armed re-drive must not resume
    // the adjudicated-dead session.
    expect(paneContent(store).restoreError?.reason).toBe('durable_artifact_missing')
    expect(countSentOfType('terminal.create')).toBe(1)
    expect(lastSentOfType('terminal.create').requestId).toBe('cr-1')
  })

  it('the dead-latch stand-down exempts the codex dead-live-handle breadcrumb recovery create (explicitly fresh, not a resume attempt)', async () => {
    // Delimiting pin for the create-lane gate (delta review round 1,
    // finding 1): the codex live-only collapse latches the SAME
    // durable_artifact_missing breadcrumb but mints an explicit
    // FRESH-recovery create (fresh_after_restore_unavailable) — the stand-
    // down keys on resume attempts, so that create must still fire. This
    // suite does not mock terminal-restore: the real registry carries the
    // registration -> consume round trip.
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-live',
      terminalId: 'term-codex-live',
      serverInstanceId: 'srv-local',
      // No sessionRef, no codexDurability: genuinely no durable identity.
    })
    expect(lastAttachedTerminalId()).toBe('term-codex-live')

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-live',
      })
    })

    // The collapse keeps the codex breadcrumb and mints the fresh-recovery
    // requestId (mirrors the codex-identity breadcrumb pin).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const content = paneContent(store)
    expect(content.terminalId).toBeUndefined()
    expect(content.status).toBe('creating')
    expect(content.restoreError?.reason).toBe('durable_artifact_missing')
    expect(content.createRequestId).not.toBe('cr-codex-live')

    // The latch stands — and the create lane still fires the FRESH create.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const freshCreates = sentOfType('terminal.create')
      .filter((msg) => msg?.recoveryIntent === 'fresh_after_restore_unavailable')
    expect(freshCreates).toHaveLength(1)
    expect(freshCreates[0]).not.toHaveProperty('sessionRef')
    expect(freshCreates[0].restore).toBeUndefined()
  })

  it('a SUCCESSFUL fresh recovery resolves its breadcrumb: a second INVALID_TERMINAL_ID still auto-recovers (delta-loop round 5)', async () => {
    // The codex dead-live-handle collapse latches durable_artifact_missing
    // as a BREADCRUMB for the recovery it minted. The recovery SUCCEEDING
    // (terminal.created for the recovery create anchoring) must resolve
    // that breadcrumb: a live pane must not carry the dead latch, or a
    // later INVALID_TERMINAL_ID on the SAME connection hits the
    // dead-session stand-down gate instead of the ordinary auto-recovery
    // lane — the pane stalls until an unrelated reconnect or user action.
    // The latch only survives a FAILED recovery (no terminal.created ever
    // lands), where standing down is the intended behavior. Reconcile
    // INACTIVE here: the consumed intent lives on the launch attempt that
    // sent the create.
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-breadcrumb-live',
      terminalId: 'term-codex-breadcrumb-live',
      serverInstanceId: 'srv-local',
      // No sessionRef, no codexDurability: genuinely no durable identity.
    })

    // (a) First loss: the dead-live-handle collapse — breadcrumb latched,
    // fresh-recovery create minted and sent.
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-breadcrumb-live',
      })
    })
    await flushEffects()
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-breadcrumb-live')
    expect(paneContent(store).restoreError?.reason).toBe('durable_artifact_missing')
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    // (b) The recovery SUCCEEDS: terminal.created for the recovery create
    // anchors (identity-less fresh terminal — no sessionRef on the frame).
    act(() => {
      wsHarness.emit({
        type: 'terminal.created',
        requestId: mintedId,
        terminalId: 'term-codex-breadcrumb-live-2',
      })
    })
    await flushEffects()
    expect(paneContent(store).terminalId).toBe('term-codex-breadcrumb-live-2')
    // THE FIX: the breadcrumb is resolved with the recovery — the live
    // pane carries no dead latch (today the stale breadcrumb survives the
    // successful create).
    expect(paneContent(store).restoreError).toBeUndefined()

    // Settle the queued attach so the next INVALID_TERMINAL_ID takes the
    // branch-5 reconnect lane (attachReady), not the launch-failure lane.
    const attach = lastSentOfType('terminal.attach')
    expect(attach?.attachRequestId).toBeTruthy()
    act(() => {
      wsHarness.emit({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-breadcrumb-live-2',
        attachRequestId: attach.attachRequestId,
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
    })
    await flushEffects()

    // (c) Second loss on the SAME connection: the pane is live with no
    // durable identity — the fresh-recovery auto lane must fire AGAIN.
    // Today the stale breadcrumb latches the stand-down gate and the pane
    // stalls (no create, no recovery).
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-breadcrumb-live-2',
      })
    })
    await flushEffects()
    await flushEffects()
    const secondMintedId = paneContent(store).createRequestId
    expect(secondMintedId).not.toBe(mintedId)
    expect(paneContent(store).status).toBe('creating')
    expect(paneContent(store).terminalId).toBeUndefined()
    const secondCreates = sentOfType('terminal.create')
      .filter((msg) => msg?.requestId === secondMintedId)
    expect(secondCreates).toHaveLength(1)
    expect(secondCreates[0]).not.toHaveProperty('sessionRef')
    expect(secondCreates[0].restore).toBeUndefined()
  })

  it('a SUCCESSFUL fresh recovery resolves its breadcrumb under ACTIVE pane reconcile too (the registry-peek shape)', async () => {
    // Companion pin for the other reconcile state: under ACTIVE
    // reconciliation the create frame stays plain-fresh (the consume is
    // gated), so the resolution signal is the surviving registry entry —
    // the same recovery succeeding must still clear the breadcrumb and
    // re-arm auto-recovery for a later INVALID_TERMINAL_ID.
    setPaneReconcileActive(true)
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-breadcrumb-active',
      terminalId: 'term-codex-breadcrumb-active',
      serverInstanceId: 'srv-local',
    })

    // (a) The collapse: breadcrumb latched, fresh-recovery create minted
    // (plain-fresh frame under active reconciliation).
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-breadcrumb-active',
      })
    })
    await flushEffects()
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-breadcrumb-active')
    expect(paneContent(store).restoreError?.reason).toBe('durable_artifact_missing')
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    // (b) The recovery SUCCEEDS.
    act(() => {
      wsHarness.emit({
        type: 'terminal.created',
        requestId: mintedId,
        terminalId: 'term-codex-breadcrumb-active-2',
      })
    })
    await flushEffects()
    expect(paneContent(store).terminalId).toBe('term-codex-breadcrumb-active-2')
    expect(paneContent(store).restoreError).toBeUndefined()

    const attach = lastSentOfType('terminal.attach')
    expect(attach?.attachRequestId).toBeTruthy()
    act(() => {
      wsHarness.emit({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-breadcrumb-active-2',
        attachRequestId: attach.attachRequestId,
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
    })
    await flushEffects()

    // (c) A later INVALID_TERMINAL_ID still auto-recovers.
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-breadcrumb-active-2',
      })
    })
    await flushEffects()
    await flushEffects()
    const secondMintedId = paneContent(store).createRequestId
    expect(secondMintedId).not.toBe(mintedId)
    expect(paneContent(store).status).toBe('creating')
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === secondMintedId)).toHaveLength(1)
  })

  it('the dead-latch exemption holds under ACTIVE pane reconcile too (the negotiated-connection shape)', async () => {
    // Focused episode 1, round 2 (the fresheyes finding): the exemption
    // used the consume-based intent read, which reports not-armed whenever
    // reconciliation is active -- and real connections negotiate
    // paneReconcileV1 (App arms the registry flag on ready), so on a live
    // connection the exemption was inert: the codex live-only collapse
    // (breadcrumb latch + fresh-recovery registration) had its explicitly
    // FRESH create suppressed and the pane wedged in 'creating'. The
    // exemption must answer identically in both reconcile states.
    setPaneReconcileActive(true)
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-live-active',
      terminalId: 'term-codex-live-active',
      serverInstanceId: 'srv-local',
      // No sessionRef, no codexDurability: genuinely no durable identity.
    })
    expect(lastAttachedTerminalId()).toBe('term-codex-live-active')

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-live-active',
      })
    })

    // The collapse keeps the codex breadcrumb and mints the fresh-recovery
    // requestId (mirrors the inactive pin above).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const content = paneContent(store)
    expect(content.terminalId).toBeUndefined()
    expect(content.status).toBe('creating')
    expect(content.restoreError?.reason).toBe('durable_artifact_missing')
    expect(content.createRequestId).not.toBe('cr-codex-live-active')

    // THE EXEMPTION HOLDS under active reconciliation: the latch stands and
    // the create lane still fires the FRESH create. (The consume-based
    // intent read keeps its gated semantics for the create frame -- under
    // this state the frame stays plain-fresh, so pin the create by
    // requestId and the absence of resume identity, not by recoveryIntent.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const freshCreates = sentOfType('terminal.create')
      .filter((msg) => msg?.requestId === content.createRequestId)
    expect(freshCreates).toHaveLength(1)
    expect(freshCreates[0]).not.toHaveProperty('sessionRef')
    expect(freshCreates[0].restore).toBeUndefined()
  })

  it('WS-reconnect re-drive keeps the exemption under ACTIVE pane reconcile (the fresh create is re-sent, never a resume)', async () => {
    // The reconnect re-drive is one of the three gated lanes: a transport
    // flap on an un-anchored 'creating' pane must keep exempting the
    // explicitly-fresh recovery create under the negotiated-connection
    // shape -- re-sending the SAME requestId (idempotent), never a resume.
    setPaneReconcileActive(true)
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-flap-active',
      terminalId: 'term-codex-flap-active',
      serverInstanceId: 'srv-local',
    })
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-flap-active',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-flap-active')

    // The fresh create went out before the flap...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    // ...and the flap re-drives the un-anchored pane: the exemption must
    // survive the reconnect lane too.
    act(() => {
      wsHarness.fireReconnect()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const after = sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)
    expect(after).toHaveLength(2)
    for (const create of after) {
      expect(create).not.toHaveProperty('sessionRef')
      expect(create.restore).toBeUndefined()
    }
  })

  it('the armed SESSION_RESERVED re-drive keeps the exemption under ACTIVE pane reconcile (the timer re-sends the fresh create)', async () => {
    // The armed reserve-redrive timer is the third gated lane: a
    // SESSION_RESERVED standoff on the fresh-recovery create must keep
    // exempting it under the negotiated-connection shape when the timer
    // fires -- re-sending the SAME requestId, never a resume.
    setPaneReconcileActive(true)
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-reserve-active',
      terminalId: 'term-codex-reserve-active',
      serverInstanceId: 'srv-local',
    })
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-reserve-active',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-reserve-active')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    // The standoff arms the re-drive timer (no immediate resend).
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_RESERVED',
        message: 'Session is reserved by another create',
        requestId: mintedId,
        retryAfterMs: 1000,
      })
    })
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // The timer fired and KEPT the exemption: the fresh create is re-sent.
    const after = sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)
    expect(after).toHaveLength(2)
    for (const create of after) {
      expect(create).not.toHaveProperty('sessionRef')
      expect(create.restore).toBeUndefined()
    }
  })

  it('the exemption survives the consume: a reconnect re-drive re-sends the fresh create WITH its intent (reconcile inactive)', async () => {
    // Delimiting pin for the gate's retry-stability (reconcile inactive):
    // the intent is consumed by the first create's frame, and the
    // re-drive lane must keep exempting (and re-stamping) the recovery
    // create across retries -- the exemption may not go inert after the
    // consume settles the registry entry.
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-flap-inactive',
      terminalId: 'term-codex-flap-inactive',
      serverInstanceId: 'srv-local',
    })
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-flap-inactive',
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-flap-inactive')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)

    act(() => {
      wsHarness.fireReconnect()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const creates = sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)
    expect(creates).toHaveLength(2)
    for (const create of creates) {
      expect(create.recoveryIntent).toBe('fresh_after_restore_unavailable')
      expect(create).not.toHaveProperty('sessionRef')
      expect(create.restore).toBeUndefined()
    }
  })

  it('a stale fresh-recovery exemption cannot unlock a resume once the pane holds a durable identity (delta round 2, finding 1)', async () => {
    // The reviewer's exact end-to-end sequence: a live-only codex pane
    // collapses into the explicitly-fresh recovery (breadcrumb latch +
    // registry entry, reconciliation ACTIVE so the entry is never
    // consumed), the fresh create anchors AND acquires a durable
    // sessionRef, the terminal exits (terminalId cleared, identity
    // retained), and a later boot-reconcile round adjudicates the session
    // dead after its file was deleted. The registry entry is STALE -- the
    // identity-less recovery shape it describes is gone -- so the
    // exemption must not hold: the create lane may not auto-send
    // terminal.create carrying the deleted sessionRef (the forbidden
    // duplicate resume attempt). The pane waits for the user's existing
    // chrome; the notice still writes.
    setPaneReconcileActive(true)
    const { store } = await mountPane({
      mode: 'codex',
      status: 'running',
      createRequestId: 'cr-codex-stale-exempt',
      terminalId: 'term-codex-stale-exempt',
      serverInstanceId: 'srv-local',
      // No sessionRef, no codexDurability: genuinely no durable identity.
    })

    // (a) The dead-live-handle collapse: fresh-recovery createRequestId
    // minted, breadcrumb latch set, registry entry registered (and never
    // consumed under ACTIVE reconciliation).
    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'terminal not found',
        terminalId: 'term-codex-stale-exempt',
      })
    })
    await flushEffects()
    const mintedId = paneContent(store).createRequestId
    expect(mintedId).not.toBe('cr-codex-stale-exempt')
    expect(paneContent(store).restoreError?.reason).toBe('durable_artifact_missing')
    const freshCreates = sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)
    expect(freshCreates).toHaveLength(1)
    expect(freshCreates[0]).not.toHaveProperty('sessionRef')

    // (b) The fresh session anchors AND acquires a durable identity
    // (terminal.created folds the server-named sessionRef).
    act(() => {
      wsHarness.emit({
        type: 'terminal.created',
        requestId: mintedId,
        terminalId: 'term-codex-stale-exempt-2',
        sessionRef: { provider: 'codex', sessionId: 'sess-stale-exempt' },
      })
    })
    await flushEffects()
    expect(paneContent(store).terminalId).toBe('term-codex-stale-exempt-2')
    expect(paneContent(store).sessionRef).toMatchObject({ provider: 'codex', sessionId: 'sess-stale-exempt' })

    // Settle the queued attach so the exit below takes the ordinary exit
    // branch (attachReady), not the launch-failure branch.
    const attach = lastSentOfType('terminal.attach')
    expect(attach?.attachRequestId).toBeTruthy()
    act(() => {
      wsHarness.emit({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-stale-exempt-2',
        attachRequestId: attach.attachRequestId,
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
    })
    await flushEffects()

    // (c) Exit: terminalId cleared, durable identity retained.
    act(() => {
      wsHarness.emit({ type: 'terminal.exit', terminalId: 'term-codex-stale-exempt-2', exitCode: 0 })
    })
    await flushEffects()
    expect(paneContent(store).terminalId).toBeUndefined()
    expect(paneContent(store).status).toBe('exited')
    expect(paneContent(store).sessionRef).toMatchObject({ provider: 'codex', sessionId: 'sess-stale-exempt' })

    // (d) The next boot-reconcile round holds the pane in its pre-verdict
    // wait, then folds the dead verdict for the deleted session file
    // (exactly the fold's terminal dead_session arm dispatches).
    act(() => {
      store.dispatch(setReconcilePendingPanes({
        paneKeys: [`${TAB_ID}:${PANE_ID}`],
        startedAt: Date.now(),
      }))
    })
    await flushEffects()
    act(() => {
      store.dispatch(setPaneRestoreError({
        tabId: TAB_ID,
        paneId: PANE_ID,
        restoreError: buildRestoreError('durable_artifact_missing'),
      }))
      store.dispatch(setPaneReconcileNotice({
        tabId: TAB_ID,
        paneId: PANE_ID,
        notice: deadSessionReconcileNoticeFor('session_not_on_disk'),
      }))
    })
    await flushEffects()

    // THE STALE EXEMPTION MUST NOT HOLD: the pane now HAS a resumable
    // durable identity, so the create lane stands down -- no
    // terminal.create carrying the deleted sessionRef is auto-sent (no
    // create at all beyond the one fresh create from (a)).
    expect(sentOfType('terminal.create').filter((msg) => msg?.requestId === mintedId)).toHaveLength(1)
    expect(sentOfType('terminal.create').some((msg) => msg?.sessionRef?.sessionId === 'sess-stale-exempt')).toBe(false)

    // The notice still writes (exactly one buffer line; the dead-copy
    // category mint stays resident as the durable copy source).
    const deadNoticeLine = '\r\n[This pane\'s saved session no longer exists on disk - close this pane or start a new one]\r\n'
    expect(xtermWrites().filter((data) => data === deadNoticeLine)).toHaveLength(1)
    expect(paneContent(store).reconcileNotice).toBe(DEAD_SESSION_RECONCILE_NOTICES.missing)
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { Store } from '@reduxjs/toolkit'
import panesReducer, {
  setReconcileWarming,
  removeLayout,
  replacePane,
  updatePaneContent,
} from '@/store/panesSlice'
import connectionReducer, { setSessionIndexReady, setStatus } from '@/store/connectionSlice'
import type { PaneNode, ReconcileWarmingState, TerminalPaneContent } from '@/store/paneTypes'
import { ReconcileWarmingRecoveryDriver } from '@/components/ReconcileWarmingRecoveryDriver'

// --- ws-client mock: capture sent frames, support multiple onMessage subscribers ---

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    onMessage: wsMocks.onMessage,
  }),
}))

const sentFrames: any[] = []
const messageHandlers = new Set<(msg: any) => void>()

function requests(): any[] {
  return sentFrames.filter((f) => f?.type === 'pane.reconcile.request')
}

function deliverServerFrame(frame: Record<string, unknown>): void {
  act(() => {
    for (const handler of [...messageHandlers]) handler(frame)
  })
}

function warnText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args) => args.map((a) => String(a)).join(' ')).join('\n')
}

// --- store helpers: real panes + connection reducers, seeded layouts ---

function leafPane(paneId: string): PaneNode {
  return {
    type: 'leaf',
    id: paneId,
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      status: 'creating',
      createRequestId: `cr-${paneId}`,
      sessionRef: { provider: 'claude', sessionId: `sess-${paneId}` },
    } as any,
  }
}

function layoutFor(paneIds: string[]): PaneNode {
  const leaves = paneIds.map((id) => leafPane(id))
  return leaves.reduce((acc, leaf, i) =>
    acc === null
      ? leaf
      : ({
          type: 'split',
          id: `split-${i}`,
          direction: 'horizontal',
          children: [acc, leaf],
          sizes: [50, 50],
        } as PaneNode),
  null as PaneNode | null)!
}

function ref(paneId: string): { tabId: string; paneId: string; createRequestId: string } {
  return { tabId: 'tab-1', paneId, createRequestId: `cr-${paneId}` }
}

function renderDriver(opts: {
  reconcileWarming?: ReconcileWarmingState | null
  paneIds?: string[]
  sessionIndexReady?: boolean
}): { store: Store } {
  const paneIds =
    opts.paneIds ??
    [...new Set([...(opts.reconcileWarming?.paneRefs ?? []).map((r) => r.paneId)])]
  const store = configureStore({
    reducer: { panes: panesReducer, connection: connectionReducer },
    preloadedState: {
      panes: {
        layouts: paneIds.length > 0 ? { 'tab-1': layoutFor(paneIds) } : {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        restoreFallbackAttemptsByPane: {},
        reconcileWarming: opts.reconcileWarming ?? null,
      } as any,
      connection: {
        status: 'ready',
        platform: null,
        availableClis: {},
        featureFlags: {},
        sessionIndexReady: opts.sessionIndexReady ?? false,
      } as any,
    },
  })
  render(
    <Provider store={store}>
      <ReconcileWarmingRecoveryDriver />
    </Provider>,
  )
  return { store }
}

function terminalContentOf(store: Store, paneId = 'p1'): TerminalPaneContent {
  const root = store.getState().panes.layouts['tab-1'] as PaneNode
  const found = (function find(node: PaneNode | undefined): TerminalPaneContent | undefined {
    if (!node) return undefined
    if (node.type === 'leaf') {
      return node.id === paneId && node.content.kind === 'terminal' ? node.content : undefined
    }
    return find(node.children[0]) ?? find(node.children[1])
  })(root)
  if (!found) throw new Error(`no terminal pane ${paneId}`)
  return found
}

function attachResultFor(req: any, terminalId: string): Record<string, unknown> {
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

function stillWarmingResultFor(req: any): Record<string, unknown> {
  return {
    type: 'pane.reconcile.result',
    reconcileId: req.reconcileId,
    bootId: 'boot-1',
    serverInstanceId: 'srv-1',
    verdicts: req.panes.map((pane: any) => ({
      paneKey: pane.paneKey,
      verdict: 'error',
      reason: 'index_warming',
    })),
  }
}

describe('ReconcileWarmingRecoveryDriver', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    sentFrames.length = 0
    messageHandlers.clear()
    wsMocks.send.mockImplementation((frame: unknown) => {
      sentFrames.push(frame)
    })
    wsMocks.onMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandlers.add(cb)
      return () => messageHandlers.delete(cb)
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('drives a reconcile for exactly the warming panes when the index becomes ready — zero interaction', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      paneIds: ['p1', 'p2'],
      sessionIndexReady: false,
    })
    expect(requests()).toHaveLength(0)
    act(() => {
      store.dispatch(setSessionIndexReady(true))
    })
    const reqs = requests()
    expect(reqs).toHaveLength(1)
    expect(reqs[0].type).toBe('pane.reconcile.request')
    expect(reqs[0].panes).toHaveLength(1)
    expect(reqs[0].panes[0].paneKey).toBe('tab-1:p1')
    expect(reqs[0].panes[0].createRequestId).toBe('cr-p1')
    expect(reqs[0].reconcileId).toBeTruthy()
  })

  it('does not drive while the index is not ready', () => {
    renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: false,
    })
    expect(requests()).toHaveLength(0)
  })

  it('drives when the ready frame reports readiness while panes are already parked (already-ready race)', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: false,
    })
    expect(requests()).toHaveLength(0)
    act(() => {
      // The ready frame folds both: a fresh handshake (lastReadyAt) and the
      // handshake's CURRENT readiness state (Task 5's ready.sessionIndexReady).
      store.dispatch(setStatus('ready'))
      store.dispatch(setSessionIndexReady(true))
    })
    expect(requests()).toHaveLength(1)
  })

  it('clears the warming state when its own result resolves every pane', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: true,
    })
    const req = requests()[0]
    expect(req).toBeDefined()
    deliverServerFrame(attachResultFor(req, 'live-1'))
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(terminalContentOf(store).terminalId).toBe('live-1')
    expect(terminalContentOf(store).status).toBe('running')
  })

  it('logs the terminal outcome at warn when its own drive folds an error verdict for a pane it drove', () => {
    // Delta fix finding 2: production (client-logger default level `warn`)
    // must record that a parked pane it drove resolved to an ERROR — the
    // honest failure transition, with the pane/session identifiers and the
    // failure cause. The happy-path settle stays info; only terminal
    // outcomes (exhaustion, watchdog, refusal, and per-pane error folds)
    // are warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req = requests()[0]
      expect(req).toBeDefined()
      deliverServerFrame({
        type: 'pane.reconcile.result',
        reconcileId: req.reconcileId,
        bootId: 'boot-1',
        serverInstanceId: 'srv-1',
        verdicts: [{
          paneKey: 'tab-1:p1',
          verdict: 'error',
          reason: 'session_store_unreadable',
        }],
      })
      // The fold latched the honest per-pane error and cleared the banner.
      expect(store.getState().panes.reconcileWarming).toBeNull()
      expect(terminalContentOf(store).restoreError).toMatchObject({
        reason: 'session_store_unreadable',
      })
      const text = warnText(warnSpy)
      expect(text).toContain('tab-1:p1')
      expect(text).toContain('claude:sess-p1')
      expect(text).toContain('cause=session_store_unreadable')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does not log a per-pane failure warn for a still-warming re-drive (the wait is not a terminal outcome)', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req = requests()[0]
      deliverServerFrame(stillWarmingResultFor(req))
      // Still-warming is the unchanged WAIT: bounded backoff, no per-pane
      // failure warn (transitions only — the gave-up warn at the retry
      // limit is the wait's own terminal record, pinned elsewhere).
      expect(warnText(warnSpy)).not.toContain('resolved to an error')
      expect(warnText(warnSpy)).not.toContain('gave up')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps the banner on a cardinality-violation result instead of clearing (checks violation before warming===0)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req = requests()[0]
      // Malformed result (verdict count mismatch) with warming===0 by
      // construction: the cardinality check must short-circuit the clear.
      deliverServerFrame({
        type: 'pane.reconcile.result',
        reconcileId: req.reconcileId,
        bootId: 'boot-1',
        serverInstanceId: 'srv-1',
        verdicts: [],
      })
      expect(store.getState().panes.reconcileWarming).not.toBeNull()
      expect(terminalContentOf(store).terminalId).toBeUndefined()
      expect(warnText(warnSpy)).toContain('cardinality violation')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps the banner and schedules one bounded backoff retry when a drive still returns warming, then stops at the limit', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req1 = requests()[0]
      deliverServerFrame(stillWarmingResultFor(req1))
      // Banner kept; no immediate re-drive (bounded backoff, not busy polling).
      expect(store.getState().panes.reconcileWarming).not.toBeNull()
      expect(requests()).toHaveLength(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      const reqs = requests()
      expect(reqs).toHaveLength(2)
      expect(reqs[1].reconcileId).not.toBe(req1.reconcileId)
      deliverServerFrame(stillWarmingResultFor(reqs[1]))
      // Attempt budget exhausted: gave up — the banner + manual Retry remain,
      // and no third drive ever fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(requests()).toHaveLength(2)
      expect(store.getState().panes.reconcileWarming).not.toBeNull()
      const text = warnText(warnSpy)
      expect(text).toContain('gave up')
      expect(text).toContain('tab-1:p1')
      expect(text).toContain('claude:sess-p1')
      expect(text).toContain('cause=still-warming')
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not send a second concurrent drive while one is in flight (dedup)', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: true,
    })
    expect(requests()).toHaveLength(1)
    // A fresh warming object (same refs) re-runs the effect; the in-flight
    // drive holds single-flight.
    act(() => {
      store.dispatch(setReconcileWarming({ count: 1, paneRefs: [ref('p1')] }))
    })
    expect(requests()).toHaveLength(1)
    // Readiness flapping re-runs the effect too; still one drive in flight.
    act(() => {
      store.dispatch(setSessionIndexReady(false))
    })
    act(() => {
      store.dispatch(setSessionIndexReady(true))
    })
    expect(requests()).toHaveLength(1)
  })

  it('clears the warming state without sending when every parked pane was closed (pre-readiness)', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: false,
    })
    expect(requests()).toHaveLength(0)
    act(() => {
      store.dispatch(removeLayout({ tabId: 'tab-1' }))
    })
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(requests()).toHaveLength(0)
  })

  it('drops a drive when the server answers a correlated error frame for its reconcileId', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req1 = requests()[0]
      deliverServerFrame({
        type: 'error',
        code: 'RECONCILE_UNAVAILABLE',
        message: 'reconcile unavailable',
        requestId: req1.reconcileId,
      })
      // The drive is dropped: its own late result folds NOTHING (the pane
      // stays unattached) and never clears the warming state.
      deliverServerFrame(attachResultFor(req1, 'live-1'))
      expect(terminalContentOf(store).terminalId).toBeUndefined()
      expect(store.getState().panes.reconcileWarming).not.toBeNull()
      // The re-arm tick fired immediately (never waiting out the watchdog):
      // a second drive with a fresh reconcileId went out.
      const reqs = requests()
      expect(reqs).toHaveLength(2)
      expect(reqs[1].reconcileId).not.toBe(req1.reconcileId)
      const text = warnText(warnSpy)
      expect(text).toContain('cause=RECONCILE_UNAVAILABLE')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('drops an unanswered drive after the result watchdog, then re-drives via the re-arm tick', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req1 = requests()[0]
      // Foreign results must not consume the in-flight drive.
      deliverServerFrame({
        type: 'pane.reconcile.result',
        reconcileId: 'foreign-id',
        verdicts: [],
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      const reqs = requests()
      expect(reqs).toHaveLength(2)
      expect(reqs[1].reconcileId).not.toBe(req1.reconcileId)
      const text = warnText(warnSpy)
      expect(text).toContain('result wait expired')
      expect(text).toContain('cause=result-lost')
      // The second unanswered drive watchdogs too — but the attempt budget
      // is exhausted, so no third drive fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(requests()).toHaveLength(2)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('resets the retry budget and re-drives on a new handshake even when sessionIndexReady stays true (lastReadyAt dep)', async () => {
    vi.useFakeTimers()
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req1 = requests()[0]
      deliverServerFrame(stillWarmingResultFor(req1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
      const req2 = requests()[1]
      deliverServerFrame(stillWarmingResultFor(req2))
      // Gave up: two drives spent, banner remains, readiness still true.
      expect(requests()).toHaveLength(2)
      expect(store.getState().panes.reconcileWarming).not.toBeNull()
      // A NEW handshake (reconnect / server restart) is a new readiness
      // observation: the budget resets and the drive re-arms even though
      // sessionIndexReady never flipped.
      act(() => {
        store.dispatch(setStatus('ready'))
      })
      const reqs = requests()
      expect(reqs).toHaveLength(3)
      expect(reqs[2].reconcileId).not.toBe(req2.reconcileId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds only its own reconcileId, skipping foreign results', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: true,
    })
    const req = requests()[0]
    deliverServerFrame({ ...attachResultFor(req, 'live-foreign'), reconcileId: 'foreign-reconcile-id' })
    expect(store.getState().panes.reconcileWarming).not.toBeNull()
    expect(terminalContentOf(store).terminalId).toBeUndefined()
    deliverServerFrame(attachResultFor(req, 'live-1'))
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(terminalContentOf(store).terminalId).toBe('live-1')
  })

  it('leaves restoreError panes out of the warming state (unreadable-store verdicts are not re-parked)', () => {
    const { store } = renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: true,
    })
    const req = requests()[0]
    deliverServerFrame({
      type: 'pane.reconcile.result',
      reconcileId: req.reconcileId,
      bootId: 'boot-1',
      serverInstanceId: 'srv-1',
      verdicts: [{ paneKey: 'tab-1:p1', verdict: 'error', reason: 'session_store_unreadable' }],
    })
    // The pane carries an honest per-pane error (identity preserved) and is
    // NOT re-parked as warming: the drive settles and clears the state.
    expect(store.getState().panes.reconcileWarming).toBeNull()
    expect(terminalContentOf(store).restoreError).toMatchObject({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'session_store_unreadable',
    })
    expect(terminalContentOf(store).sessionRef).toEqual({ provider: 'claude', sessionId: 'sess-p1' })
  })

  it('excludes a pane replaced while parked (new createRequestId under the same paneId) — its pending recovery is canceled, the replacement is never reconciled by the drive', async () => {
    vi.useFakeTimers()
    try {
      const { store } = renderDriver({
        reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
        sessionIndexReady: true,
      })
      const req1 = requests()[0]
      expect(req1.panes[0].createRequestId).toBe('cr-p1')
      // The parked pane is replaced while waiting: same paneId, NEW content
      // identity (the Replace-pane flow).
      act(() => {
        store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'p1' }))
        store.dispatch(updatePaneContent({
          tabId: 'tab-1',
          paneId: 'p1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            shell: 'system',
            createRequestId: 'cr-new',
            status: 'creating',
          },
        }))
      })
      // Canceled immediately: the parked ref no longer identity-matches, so
      // the pending recovery is cleared (never transferred to the
      // replacement).
      expect(store.getState().panes.reconcileWarming).toBeNull()
      // The still-warming verdict for the OLD identity re-parks the OLD ref;
      // the driver cancels it again (identity filter) — no re-drive.
      deliverServerFrame(stillWarmingResultFor(req1))
      expect(store.getState().panes.reconcileWarming).toBeNull()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      // Exactly one request ever went out — the replacement (cr-new) was
      // never reconciled by the drive, and the rebound content is untouched.
      const reqs = requests()
      expect(reqs).toHaveLength(1)
      expect(reqs[0].panes[0].createRequestId).toBe('cr-p1')
      expect(terminalContentOf(store).createRequestId).toBe('cr-new')
      expect(terminalContentOf(store).terminalId).toBeUndefined()
      expect(store.getState().panes.reconcileWarming).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders null (no visual surface of its own)', () => {
    renderDriver({
      reconcileWarming: { count: 1, paneRefs: [ref('p1')] },
      sessionIndexReady: true,
    })
    expect(document.body.textContent).toBe('')
  })
})

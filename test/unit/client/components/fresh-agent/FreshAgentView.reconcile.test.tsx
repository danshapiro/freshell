import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, {
  applyFreshAgentReconcileAttach,
  initLayout,
  resetFreshAgentPaneForReconcileCreate,
  setReconcilePendingPanes,
} from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer, { markSessionLost, setSessionStatus } from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'
import {
  FreshAgentView,
  FRESH_AGENT_RESERVE_RETRY_FLOOR_MS,
  FRESH_AGENT_RESERVE_RETRY_WINDOW_MS,
} from '@/components/fresh-agent/FreshAgentView'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { useAppSelector } from '@/store/hooks'
import { resetRebindQueueForTests } from '@/lib/rebind-queue'
import {
  buildReconcileRequestForPanes,
  foldVerdicts,
  setFreshAgentReconcileActive,
} from '@/lib/pane-reconcile'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

// Task 9: fresh-agent VIEW leg of pane reconcile -- verdict folds drive the
// create/attach effects (epoch re-fire with the SAME createRequestId),
// freshAgent.created consumes pendingReconcile, the mount create defers
// bounded while the pane is reconcile-pending, and reconcileNotice renders
// once as a role="status" line.
//
// Harness reused from FreshAgentView.test.tsx / FreshAgentView.hidden-rebind
// .test.tsx (store-backed render so verdict folds re-render the component),
// pending-gate scaffold from TerminalView.verdict-wait.test.tsx.

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn(),
}))

// Keep the REAL module exports (RECONCILE_VERDICT_WAIT_MS is defined ONCE in
// ws-client -- never redefined here) and stub only the client accessor.
vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>()
  return {
    ...actual,
    getWsClient: () => wsMock,
  }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentModelCapabilities: apiMock.getFreshAgentModelCapabilities,
    setSessionMetadata: apiMock.setSessionMetadata,
  }
})

import { RECONCILE_VERDICT_WAIT_MS } from '@/lib/ws-client'

const tabId = 'tab-1'
const paneId = 'pane-1'
// Claude durable session ids are UUIDs (isValidClaudeSessionId gates on it).
const DURABLE = '550e8400-e29b-41d4-a716-446655440777'

const baseContent: FreshAgentPaneContent = {
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-1',
  status: 'creating',
}

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      tabs: tabsReducer,
      // The .lost recovery driver is gated on connection.status === 'ready';
      // preload ready so existing tests keep their pre-gate behavior, and flip
      // it deliberately in the reconnect-evidence cases.
      connection: connectionReducer,
    },
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      tabs: {
        tabs: [{
          id: tabId,
          createRequestId: tabId,
          title: 'Tab 1',
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        }],
        activeTabId: tabId,
        renameRequestTabId: null,
        tombstones: [],
      },
    },
  })
}

let store: ReturnType<typeof createStore>

// Production passes paneContent selected from the store, so a store dispatch
// (e.g. a reconcile verdict fold) re-renders FreshAgentView with fresh content.
function StoreBackedFreshAgentView({ hidden }: { hidden?: boolean }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
}

function seedPendingForPane(seedTabId: string, seedPaneId: string) {
  store.dispatch(setReconcilePendingPanes({
    paneKeys: [`${seedTabId}:${seedPaneId}`],
    startedAt: Date.now(),
  }))
}

function renderFreshAgentPane(
  overrides: Partial<FreshAgentPaneContent> & { hidden?: boolean } = {},
) {
  const { hidden, ...contentOverrides } = overrides
  // The harness seeds pane content through initLayout, which runs
  // normalizePaneContent -- Task 2's fresh-agent preservation is what lets a
  // seeded pendingReconcile/reconcileNotice/reconcileEpoch reach the component.
  store.dispatch(initLayout({ tabId, paneId, content: { ...baseContent, ...contentOverrides } }))
  render(
    <Provider store={store}>
      <StoreBackedFreshAgentView hidden={hidden} />
    </Provider>,
  )
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

function sentOfType(type: string) {
  return wsMock.send.mock.calls
    .map(([message]) => message as Record<string, unknown>)
    .filter((message) => message?.type === type)
}

function receiveWs(message: Record<string, unknown>) {
  act(() => {
    for (const call of wsMock.onMessage.mock.calls) {
      call[0](message)
    }
  })
}

function leafContent(state: ReturnType<typeof store.getState>): FreshAgentPaneContent {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
    throw new Error('Expected fresh-agent leaf content')
  }
  return layout.content
}

// markSessionLost no-ops when the session record does not exist, so seed
// it first (setSessionStatus routes through resolveOrEnsureSession) -- the
// exact shape fresh-agent-ws produces before dispatching markSessionLost.
function markSessionLostInStore(sessionId = 'live-1') {
  act(() => {
    store.dispatch(setSessionStatus({ sessionId, sessionType: 'freshclaude', provider: 'claude', status: 'running' }))
    store.dispatch(markSessionLost({ sessionId, sessionType: 'freshclaude', provider: 'claude' }))
  })
}

function sessionInStore(state: ReturnType<typeof store.getState>, sessionId: string) {
  const key = makeFreshAgentSessionKey({ sessionId, sessionType: 'freshclaude', provider: 'claude' })
  const session = state.freshAgent.sessions[key]
  if (!session) throw new Error(`Missing freshAgent session ${sessionId}`)
  return session
}

// Shared harness setup for both describes (Task 9 fold drive, Task 10
// capability-gated .lost handling) -- file-level hooks apply to all tests.
beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    store = createStore()
    wsMock.send.mockReset()
    wsMock.onMessage.mockReset()
    wsMock.onReconnect.mockReset()
    wsMock.onMessage.mockImplementation(() => () => {})
    wsMock.onReconnect.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentModelCapabilities.mockReset()
    apiMock.post.mockReset()
    apiMock.setSessionMetadata.mockReset()
    apiMock.post.mockResolvedValue({ title: null, source: 'none' })
    apiMock.setSessionMetadata.mockResolvedValue(undefined)
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Claude summary',
      capabilities: { send: true, interrupt: true, fork: true },
      diffs: [],
      worktrees: [],
      turns: [],
    })
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [],
    })
  })

  afterEach(async () => {
    // Drain pending timers + promise continuations inside act BEFORE
    // restoring real timers, so no React work leaks past teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    cleanup()
    vi.useRealTimers()
    // The fresh-agent reconcile capability latch is module-global -- reset it
    // so a Task 10 test can never leak the capability into another test.
    setFreshAgentReconcileActive(false)
  })

describe('FreshAgentView reconcile fold drive (Task 9)', () => {
  it('a respawn fold on a mounted pane re-sends freshAgent.create with the server-named ref and the SAME createRequestId', async () => {
    // Mount in 'creating' so the initial create CONSUMES createSentRef, then
    // land the created ack -- the pane is now live with the same
    // createRequestId. Only the reconcileEpoch bump can re-arm the create
    // effect after the fold (council rule 2: the id is never re-minted).
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', createRequestId: 'req-1' })
    await flush() // initial mount consumed createSentRef
    expect(sentOfType('freshAgent.create')).toHaveLength(1)
    receiveWs({ type: 'freshAgent.created', requestId: 'req-1', sessionId: 'live-1', sessionType: 'freshclaude', provider: 'claude', runtimeProvider: 'claude' })
    await flush()
    act(() => {
      store.dispatch(resetFreshAgentPaneForReconcileCreate({
        tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE },
      }))
    })
    await flush()
    const creates = sentOfType('freshAgent.create')
    expect(creates).toHaveLength(2) // the fold re-fired the create effect
    const last = creates[creates.length - 1]
    expect(last.requestId).toBe('req-1')
    // Canonical carrier only: the server promotes sessionRef into its resume
    // input on every door (claude.rs/codex.rs/opencode_ws.rs create paths,
    // Node runtime-manager.ts:106-108) — the legacy duplicate is gone.
    expect(last.resumeSessionId).toBeUndefined()
    expect(last.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })

  it('an attach fold sends freshAgent.attach and no create', async () => {
    seedPendingForPane(tabId, paneId) // gate the mount create so the fold decides
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    act(() => {
      store.dispatch(applyFreshAgentReconcileAttach({ tabId, paneId, sessionRef: { provider: 'claude', sessionId: DURABLE } }))
    })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0)
    const attach = sentOfType('freshAgent.attach').find((m) => m.sessionId === DURABLE)!
    expect(attach).toBeTruthy()
    // claude's attach_durable_id reads resumeSessionId THEN sessionRef
    // (claude.rs `attach_durable_id`): the durable rides the canonical
    // sessionRef only — the legacy duplicate is no longer sent.
    expect(attach.resumeSessionId).toBeUndefined()
    expect(attach.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })

  it('the mount create defers while reconcile-pending and falls back after the bound', async () => {
    seedPendingForPane(tabId, paneId)
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONCILE_VERDICT_WAIT_MS + 50)
    })
    expect(sentOfType('freshAgent.create')).toHaveLength(1)
  })

  it('freshAgent.created clears pendingReconcile', async () => {
    renderFreshAgentPane({ status: 'creating', pendingReconcile: 'respawn', createRequestId: 'req-1' })
    await flush()
    receiveWs({ type: 'freshAgent.created', requestId: 'req-1', sessionId: 's-1', sessionType: 'freshclaude', provider: 'claude', runtimeProvider: 'claude' })
    await flush()
    expect(leafContent(store.getState()).pendingReconcile).toBeUndefined()
  })

  it('reconcileNotice renders once as role=status and is cleared', async () => {
    renderFreshAgentPane({ sessionId: 'live-1', status: 'connected', reconcileNotice: 'Reconciled: attached to the corrected session.' })
    // The notice renders synchronously on mount (getByRole, not findByRole:
    // waitFor does not advance vitest fake timers, so a missing element would
    // stall the full test timeout instead of failing fast).
    expect(screen.getByRole('status')).toHaveTextContent(/corrected/i)
    // The notice is a timed one-shot (5s visible, then cleared) -- advance
    // past the dismiss window and verify it was consumed from the store.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_050)
    })
    expect(leafContent(store.getState()).reconcileNotice).toBeUndefined()
  })

  it('a HIDDEN pane composes with the pending gate: nothing enqueues pre-verdict, the fold-driven create enqueues via the rebind queue', async () => {
    // A12 composition coverage (the one interaction no existing suite touches):
    // hidden pane + pending seeded -> the create effect returns BEFORE the
    // hiddenRef enqueue branch, so the rebind queue stays empty;
    // dispatch resetFreshAgentPaneForReconcileCreate (fold) -> pending cleared,
    // epoch bumps, effect re-fires -> the create ENQUEUES (not direct-send) and
    // the queue's pacing contract (<=4 un-acked) still governs it.
    seedPendingForPane(tabId, paneId)
    renderFreshAgentPane({ sessionId: undefined, status: 'creating', hidden: true, sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(0) // nothing enqueued, nothing sent
    act(() => {
      store.dispatch(resetFreshAgentPaneForReconcileCreate({ tabId, paneId, intent: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE } }))
    })
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100) // rebind-queue pacing tick
    })
    expect(sentOfType('freshAgent.create')).toHaveLength(1) // enqueued then paced out, same createRequestId
  })
})

// Task 10: capability-gated .lost handling -- when paneReconcileFreshAgentV1
// was negotiated (isFreshAgentReconcileActive), a lost session triggers a
// SINGLE-PANE reconcile owned by this view (fold-ownership rule) instead of
// the heuristic triggerRecovery re-mint. The legacy path is the
// capability-gated fallback (council rule: NEVER deleted).
describe('FreshAgentView .lost capability gate (Task 10)', () => {
  const ORIGINAL_CREATE_REQUEST_ID = baseContent.createRequestId

  it('.lost with fresh-agent reconcile active sends a single-pane reconcile instead of heuristic recovery', async () => {
    setFreshAgentReconcileActive(true)
    renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore()
    await flush()
    const reqs = sentOfType('pane.reconcile.request')
    expect(reqs).toHaveLength(1)
    expect(reqs[0].panes).toHaveLength(1)
    expect((reqs[0].panes as Array<{ kind: string }>)[0].kind).toBe('fresh-agent')
    // createRequestId unchanged -- no heuristic re-mint happened
    expect(leafContent(store.getState()).createRequestId).toBe(ORIGINAL_CREATE_REQUEST_ID)
  })

  it('.lost with the capability inactive falls back to legacy triggerRecovery (new createRequestId)', async () => {
    setFreshAgentReconcileActive(false)
    // Realistic lost-session environment: the snapshot fetch against a dead
    // thread 404s (see the snapshot-load effect's own comment). The default
    // resolving mock would overwrite the recovery status with the snapshot's.
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new Error('lost thread'))
    renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore()
    await flush()
    expect(sentOfType('pane.reconcile.request')).toHaveLength(0)
    expect(leafContent(store.getState()).createRequestId).not.toBe(ORIGINAL_CREATE_REQUEST_ID)
    expect(leafContent(store.getState()).status).toBe('creating')
  })

  it('folds only its own reconcileId and applies the verdict (respawn re-drives create)', async () => {
    setFreshAgentReconcileActive(true)
    renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore()
    await flush()
    const req = sentOfType('pane.reconcile.request')[0] as { reconcileId: string; panes: Array<{ paneKey: string }> }
    receiveWs({ type: 'pane.reconcile.result', reconcileId: 'FOREIGN', bootId: 'b', serverInstanceId: 's', verdicts: [] }) // ignored
    receiveWs({
      type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
      verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'respawn', sessionRef: { provider: 'claude', sessionId: DURABLE } }],
    })
    await flush()
    const creates = sentOfType('freshAgent.create')
    expect(creates.length).toBeGreaterThan(0)
    expect(creates[creates.length - 1].sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(creates[creates.length - 1].resumeSessionId).toBeUndefined()
  })

  it('legacy-only pane content promotes resumeSessionId into the create sessionRef client-side', async () => {
    // A pane whose only persisted identity is the legacy content field (no
    // sessionRef) must still reach the server with canonical identity: the
    // builders promote {provider: content.provider, sessionId} instead of
    // sending the legacy wire field.
    renderFreshAgentPane({
      sessionId: undefined,
      status: 'creating',
      createRequestId: 'req-1',
      resumeSessionId: DURABLE,
      sessionRef: undefined,
    })
    await flush()
    const creates = sentOfType('freshAgent.create')
    expect(creates).toHaveLength(1)
    expect(creates[0].sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
    expect(creates[0].resumeSessionId).toBeUndefined()
  })

  it('an attach verdict for the SAME durable-as-sessionId clears the lost flag (no reconcile loop)', async () => {
    // V3: the attach-path reducers never clear lost; when durable == old
    // sessionId the same session entry keeps lost=true and the driver
    // re-fires (loop). The fold arm must dispatch clearSessionLost for the
    // pane's session.
    setFreshAgentReconcileActive(true)
    renderFreshAgentPane({ sessionId: DURABLE, status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore(DURABLE)
    await flush()
    const req = sentOfType('pane.reconcile.request')[0] as { reconcileId: string; panes: Array<{ paneKey: string }> }
    receiveWs({
      type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
      verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'attach', sessionRef: { provider: 'claude', sessionId: DURABLE } }],
    })
    await flush()
    expect(sessionInStore(store.getState(), DURABLE).lost).toBe(false) // clearSessionLost landed
    expect(sentOfType('pane.reconcile.request')).toHaveLength(1) // and no second reconcile fired
  })
})

// Task 14: SESSION_RESERVED bounded re-drive + automatic exhaustion
// resolution. Delivery goes through BOTH the global handleFreshAgentMessage
// projection AND the mounted view's ws listener (pane-only delivery would let
// these tests pass while the real app still renders the error card from
// state.freshAgent.pendingCreateFailures -- two independent writers feed one
// card).
describe('FreshAgentView SESSION_RESERVED re-drive (Task 14)', () => {
  function receiveWsBoth(message: Record<string, unknown>) {
    act(() => {
      handleFreshAgentMessage(store.dispatch, message)
      for (const call of wsMock.onMessage.mock.calls) {
        call[0](message)
      }
    })
  }

  it('create.failed SESSION_RESERVED re-drives the same create after the floor (no error card, no create-failed)', async () => {
    renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    expect(sentOfType('freshAgent.create')).toHaveLength(1)

    receiveWsBoth({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true })
    await flush()
    // Never create-failed for a transient reservation. (The snapshot-hydration
    // effect may legitimately land 'idle' for a durable ref -- the contract is
    // the absence of the failure state, the error card, and createError.)
    expect(leafContent(store.getState()).status).not.toBe('create-failed')
    expect(leafContent(store.getState()).createError).toBeUndefined()
    // the GLOBAL projection must not have minted an error-card entry either:
    expect(store.getState().freshAgent.pendingCreateFailures['req-1']).toBeUndefined()
    expect(document.querySelector('.fresh-agent-error-card')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESH_AGENT_RESERVE_RETRY_FLOOR_MS + 20)
    })
    const creates = sentOfType('freshAgent.create')
    expect(creates).toHaveLength(2)
    expect(creates[1].requestId).toBe('req-1') // SAME createRequestId -- never re-minted
  })

  it('exhaustion auto-resolves via a single-pane reconcile (silent attach, no stale error card)', async () => {
    setFreshAgentReconcileActive(true)
    renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()

    // hammer SESSION_RESERVED past the window
    for (let t = 0; t <= FRESH_AGENT_RESERVE_RETRY_WINDOW_MS + 2_000; t += FRESH_AGENT_RESERVE_RETRY_FLOOR_MS) {
      receiveWsBoth({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SESSION_RESERVED', message: 'reserved', retryable: true })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FRESH_AGENT_RESERVE_RETRY_FLOOR_MS)
      })
    }
    const reqs = sentOfType('pane.reconcile.request') as Array<{ reconcileId: string; panes: Array<{ paneKey: string }> }>
    expect(reqs.length).toBeGreaterThanOrEqual(1)

    // fold attach -> silent attach to the winner
    const req = reqs[reqs.length - 1]
    receiveWsBoth({
      type: 'pane.reconcile.result', reconcileId: req.reconcileId, bootId: 'b', serverInstanceId: 's',
      verdicts: [{ paneKey: req.panes[0].paneKey, verdict: 'attach', sessionRef: { provider: 'claude', sessionId: DURABLE } }],
    })
    await flush()
    expect(leafContent(store.getState()).sessionId).toBe(DURABLE)
    // council rule 8: SILENT attach -- no stale error card may survive the auto-resolve
    expect(store.getState().freshAgent.pendingCreateFailures).toEqual({})
    expect(document.querySelector('.fresh-agent-error-card')).toBeNull()
  })

  it('non-reserved create.failed still lands create-failed status (regression)', async () => {
    renderFreshAgentPane({ status: 'creating', createRequestId: 'req-1' })
    await flush()
    receiveWsBoth({ type: 'freshAgent.create.failed', requestId: 'req-1', code: 'SPAWN_FAILED', message: 'x', retryable: false })
    await flush()
    expect(leafContent(store.getState()).status).toBe('create-failed')
    expect(store.getState().freshAgent.pendingCreateFailures['req-1']).toEqual({ code: 'SPAWN_FAILED', message: 'x', retryable: false })
  })

  it('freshAgent.error SESSION_RESERVED (attach loser) re-sends the attach after the floor and suppresses the error banner', async () => {
    renderFreshAgentPane({ sessionId: DURABLE, status: 'connected', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    await flush()
    const attachesBefore = sentOfType('freshAgent.attach').length
    expect(attachesBefore).toBeGreaterThanOrEqual(1)

    receiveWsBoth({
      type: 'freshAgent.event',
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.error', code: 'SESSION_RESERVED', message: 'Another resume for this session is in flight' },
    })
    await flush()
    // suppressed: the transient reservation must not surface as "Agent error"
    expect(screen.queryByText(/Agent error/i)).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FRESH_AGENT_RESERVE_RETRY_FLOOR_MS + 20)
    })
    expect(sentOfType('freshAgent.attach').length).toBeGreaterThan(attachesBefore) // re-driven
  })
})

// reconnect-revive Task 4: a fresh-agent pane whose slice entry got lost=true
// from a transient dead-window attach race must UNWEDGE on truth-bearing
// reconnect evidence -- (a) the server-authoritative Live -> attach verdict
// fold revokes the flag (re-arming the suppressed snapshot fetch), and (b) a
// fresh reconnect re-runs the .lost recovery driver even when every other dep
// is unchanged. fresh-eyes F4: recovery acts only on post-reconnect evidence
// -- a ready -> disconnected flip must clear nothing and mint nothing.
describe('FreshAgentView lost revocation on reconnect evidence (reconnect-revive Task 4)', () => {
  const CODEX_THREAD = 'thread-live-1'
  const codexLostLoc = { sessionId: CODEX_THREAD, sessionType: 'freshcodex' as const, provider: 'codex' as const }
  const codexKey = makeFreshAgentSessionKey(codexLostLoc)

  function setConnection(status: 'disconnected' | 'ready') {
    act(() => { store.dispatch(setStatus(status)) })
  }

  it('a server-authoritative attach fold revokes lost and the next snapshot-fetch run issues the HTTP GET', async () => {
    // Codex pane with its durable id already as sessionId (no sessionId change
    // possible): lost=true suppresses the snapshot GET (a guaranteed 404
    // against a thread the client believes dead), and only the BOOT reconcile
    // fold (foldVerdicts -- NOT this view's own .lost fold) can revoke it.
    setFreshAgentReconcileActive(true) // keep the .lost driver on the reconcile path (never resets pane content)
    act(() => {
      store.dispatch(setSessionStatus({ ...codexLostLoc, status: 'running' }))
      store.dispatch(markSessionLost(codexLostLoc))
    })
    expect(store.getState().freshAgent.sessions[codexKey].lost).toBe(true)

    renderFreshAgentPane({
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionId: CODEX_THREAD,
      sessionRef: { provider: 'codex', sessionId: CODEX_THREAD },
      status: 'connected',
    })
    await flush()
    expect(apiMock.getFreshAgentThreadSnapshot).not.toHaveBeenCalled() // suppressed while lost

    const bootRequest = buildReconcileRequestForPanes(store.getState(), [{ tabId, paneId }])
    if (!bootRequest) throw new Error('expected a single-pane boot reconcile request')
    act(() => {
      foldVerdicts(store.dispatch, bootRequest, {
        type: 'pane.reconcile.result',
        reconcileId: bootRequest.reconcileId,
        bootId: 'b',
        serverInstanceId: 's',
        verdicts: [{
          paneKey: bootRequest.panes[0].paneKey,
          verdict: 'attach',
          sessionRef: { provider: 'codex', sessionId: CODEX_THREAD },
        }],
      })
    })
    await flush()
    // The verdict was positive existence evidence: lost revoked, so the very
    // next snapshot-effect run issues the GET.
    expect(store.getState().freshAgent.sessions[codexKey].lost).toBe(false)
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalled()
  })

  it('a fresh reconnect re-runs the .lost recovery driver (disconnected -> ready), no verdict and unchanged deps', async () => {
    setFreshAgentReconcileActive(true)
    setConnection('disconnected')
    renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore()
    await flush()
    // Offline: the gate holds recovery -- nothing is sent, no session-id
    // clearing / create minting before any post-reconnect evidence exists.
    expect(sentOfType('pane.reconcile.request')).toHaveLength(0)
    expect(leafContent(store.getState()).createRequestId).toBe(baseContent.createRequestId)
    // Reconnect: the connection.status flip alone re-drives the driver.
    setConnection('ready')
    await flush()
    const reqs = sentOfType('pane.reconcile.request')
    expect(reqs).toHaveLength(1)
    expect((reqs[0].panes as Array<{ kind: string }>)[0].kind).toBe('fresh-agent')
    // A fresh disconnect/reconnect pair re-drives again (other deps unchanged).
    setConnection('disconnected')
    await flush()
    expect(sentOfType('pane.reconcile.request')).toHaveLength(1) // offline gate again
    setConnection('ready')
    await flush()
    expect(sentOfType('pane.reconcile.request')).toHaveLength(2)
  })

  it('lost while offline does NOT run triggerRecovery (no session-id clearing / create minting) -- fresh-eyes F4', async () => {
    setFreshAgentReconcileActive(false)
    // Realistic lost-thread env (same rationale as the Task 10 legacy test):
    // the snapshot fetch against a dead thread 404s, and the default resolving
    // mock would overwrite the recovery status with the snapshot's.
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new Error('lost thread'))
    setConnection('disconnected')
    renderFreshAgentPane({ sessionId: 'live-1', status: 'running', sessionRef: { provider: 'claude', sessionId: DURABLE } })
    markSessionLostInStore()
    await flush()
    // Ungated, this transition would already have cleared the pane's session
    // id and minted a new create request -- purely on dead-window-era evidence.
    expect(leafContent(store.getState()).createRequestId).toBe(baseContent.createRequestId)
    expect(leafContent(store.getState()).sessionId).toBe('live-1')
    expect(leafContent(store.getState()).status).toBe('running')
    // Control: the pane was recoverable all along -- reconnect runs recovery.
    setConnection('ready')
    await flush()
    expect(leafContent(store.getState()).createRequestId).not.toBe(baseContent.createRequestId)
    expect(leafContent(store.getState()).status).toBe('creating')
  })
})

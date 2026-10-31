import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock localStorage BEFORE importing slices (persistMiddleware reads it at import time)
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

import { configureStore } from '@reduxjs/toolkit'
import panesReducer, {
  initLayout,
  applyReconcileAttach,
  replacePane,
  resetPaneForReconcileCreate,
  setReconcileWarming,
  setPaneReconcileNotice,
  setPaneRestoreError,
  updatePaneContent,
} from '@/store/panesSlice'
import type { PanesState } from '@/store/panesSlice'
import type { TerminalPaneContent, PaneNode } from '@/store/paneTypes'
import type { AppDispatch, RootState } from '@/store/store'
import type { PaneVerdict, PaneReconcileRequest, PaneReconcileResultMessage } from '@shared/ws-protocol'
import { ReconcilePaneSchema, ReadyCapabilitiesSchema } from '@shared/ws-protocol'
import {
  buildReconcileRequest,
  buildReconcileRequestForPanes,
  collectTerminalPaneTargets,
  foldVerdicts,
  isDeadSessionReconcileNotice,
  paneKeyFor,
  DEAD_SESSION_RECONCILE_NOTICES,
} from '@/lib/pane-reconcile'
import type { UnknownAction } from '@reduxjs/toolkit'

function emptyPanesState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function addTerminalPane(
  state: PanesState,
  tabId: string,
  paneId: string,
  overrides: Partial<TerminalPaneContent> = {},
): PanesState {
  return panesReducer(state, initLayout({
    tabId,
    paneId,
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: `cr-${paneId}`,
      ...overrides,
    },
  }))
}

function asRootState(panes: PanesState): RootState {
  return { panes } as unknown as RootState
}

function storeStateWith2TerminalPanes(): RootState {
  let panes = emptyPanesState()
  panes = addTerminalPane(panes, 'tab1', 'p1', { terminalId: 't-1', status: 'running' })
  panes = addTerminalPane(panes, 'tab2', 'p2')
  return asRootState(panes)
}

function emptyState(): RootState {
  return asRootState(emptyPanesState())
}

type VerdictSpec = [PaneVerdict['verdict'], Partial<PaneVerdict>]

interface Dispatched {
  actions: UnknownAction[]
  types: string[]
  verdicts: PaneVerdict[]
  countOf: (type: string) => number
  lastPayloadOf: (type: string) => unknown
}

function recordingDispatch(): { dispatch: AppDispatch; dispatched: Dispatched } {
  const actions: UnknownAction[] = []
  const dispatched: Dispatched = {
    actions,
    get types() { return actions.map((a) => a.type) },
    verdicts: [],
    countOf: (type) => actions.filter((a) => a.type === type).length,
    lastPayloadOf: (type) => {
      const matches = actions.filter((a) => a.type === type)
      return (matches[matches.length - 1] as { payload?: unknown } | undefined)?.payload
    },
  }
  const dispatch = ((action: UnknownAction) => { actions.push(action); return action }) as unknown as AppDispatch
  return { dispatch, dispatched }
}

function foldHarness(specs: VerdictSpec[]) {
  let panes = emptyPanesState()
  specs.forEach((_, i) => {
    panes = addTerminalPane(panes, `tab${i + 1}`, `p${i + 1}`)
  })
  const req = buildReconcileRequest(asRootState(panes))
  if (!req) throw new Error('foldHarness: expected a request')
  const { dispatch, dispatched } = recordingDispatch()
  dispatched.verdicts = specs.map(([verdict, extra], i) => ({
    paneKey: req.panes[i].paneKey,
    verdict,
    ...extra,
  }))
  return { req, dispatch, dispatched }
}

function foldHarnessAllDead(n: number) {
  const specs: VerdictSpec[] = Array.from({ length: n }, (_, i) => (
    ['dead_session', { sessionRef: { provider: 'claude', sessionId: `gone-${i}` }, reason: 'session_missing' }]
  ))
  return foldHarness(specs)
}

function resultFor(req: PaneReconcileRequest, verdicts: PaneVerdict[]): PaneReconcileResultMessage {
  return {
    type: 'pane.reconcile.result',
    reconcileId: req.reconcileId,
    bootId: 'boot-1',
    serverInstanceId: 'srv-1',
    verdicts,
  }
}

function deadResultFor(req: PaneReconcileRequest): PaneReconcileResultMessage {
  return resultFor(req, req.panes.map((p) => ({
    paneKey: p.paneKey,
    verdict: 'dead_session' as const,
    sessionRef: { provider: 'claude', sessionId: 'gone' },
    reason: 'session_missing',
  })))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('paneKeyFor', () => {
  it('joins tabId and paneId with a colon', () => {
    expect(paneKeyFor('tab1', 'p1')).toBe('tab1:p1')
  })
})

describe('buildReconcileRequest', () => {
  it('collects terminal panes with paneKey tab:pane and required createRequestId', () => {
    const state = storeStateWith2TerminalPanes()
    const req = buildReconcileRequest(state)!
    expect(req.type).toBe('pane.reconcile.request')
    expect(req.reconcileId).toBeTruthy()
    expect(req.panes).toHaveLength(2)
    expect(req.panes[0].paneKey).toBe(paneKeyFor('tab1', 'p1'))
    expect(req.panes[0].createRequestId).toBeTruthy()
    expect(req.panes[0].kind).toBe('terminal')
    expect(req.panes[0].terminalId).toBe('t-1')
    expect(req.panes[1].paneKey).toBe(paneKeyFor('tab2', 'p2'))
  })

  it('returns null with no terminal panes', () => {
    expect(buildReconcileRequest(emptyState())).toBeNull()
  })

  it('does not reconcile a persisted managed preparation failure as a fresh create', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab1', 'blocked', {
      mode: 'opencode',
      status: 'error',
      createRequestId: 'failed-managed-create',
      launchFailure: {
        code: 'LAUNCH_FAILED',
        message: 'Configuration blocked: /workspace/missing.txt: referenced file was not found',
        retryable: true,
        providerPreparationFailure: {
          code: 'SELECTED_REFERENCE_UNAVAILABLE',
          stage: 'configuration',
          operation: 'resolve',
          cause: 'not_found',
          workspace: '/workspace',
          declaringConfig: '/workspace/opencode.json',
          selectedPath: '/workspace/missing.txt',
        },
      },
    })
    state = addTerminalPane(state, 'tab2', 'healthy', {
      mode: 'opencode', status: 'running', terminalId: 'terminal-healthy',
    })

    const request = buildReconcileRequest(asRootState(state))
    expect(request?.panes.map(pane => pane.paneKey)).toEqual(['tab2:healthy'])
    expect(buildReconcileRequestForPanes(asRootState(state), [{ tabId: 'tab1', paneId: 'blocked' }])).toBeNull()
  })

  it('caps at 200 panes with a console.error breadcrumb', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let panes = emptyPanesState()
    for (let i = 0; i < 201; i++) {
      panes = addTerminalPane(panes, `tab${i}`, `p${i}`)
    }
    const req = buildReconcileRequest(asRootState(panes))!
    expect(req.panes).toHaveLength(200)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('promotes a legacy-only terminal pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab_1', 'pane_1', {
      mode: 'claude', createRequestId: 'req-1',
      resumeSessionId: 'legacy-claude-session-id',
    } as Partial<TerminalPaneContent>)

    const req = buildReconcileRequest(asRootState(state))
    expect(req).not.toBeNull()
    const pane = req!.panes[0]
    expect(pane.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-claude-session-id' })
    expect(pane.resumeSessionId).toBeUndefined()
  })

  it("carries the pane's persisted namingHandle, so a restarted server's managed adoption rejoins a zero-turn name", () => {
    let state = emptyPanesState()
    // A zero-turn managed Claude pane renamed before its first message: its
    // sessionRef is the preallocated (record-less) session, its name lives
    // under the pending handle.
    state = addTerminalPane(state, 'tab1', 'zero-turn', {
      mode: 'claude',
      terminalId: 't-soul',
      status: 'running',
      soulId: 'soul-1',
      sessionRef: { provider: 'claude', sessionId: 'prealloc-1' },
      namingHandle: 'nh-zero-turn',
    } as Partial<TerminalPaneContent>)
    state = addTerminalPane(state, 'tab2', 'no-handle', { mode: 'claude', terminalId: 't-2' })

    const req = buildReconcileRequest(asRootState(state))!
    const zeroTurn = req.panes.find((p) => p.paneKey === paneKeyFor('tab1', 'zero-turn'))
    expect(zeroTurn?.namingHandle).toBe('nh-zero-turn')
    expect(zeroTurn?.sessionRef).toEqual({ provider: 'claude', sessionId: 'prealloc-1' })
    const noHandle = req.panes.find((p) => p.paneKey === paneKeyFor('tab2', 'no-handle'))
    expect(noHandle).toBeDefined()
    expect(noHandle).not.toHaveProperty('namingHandle')
  })

  it('never promotes a shell-mode legacy resumeSessionId (a stateless shell has no durable identity)', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab_1', 'pane_1', {
      mode: 'shell', createRequestId: 'req-sh-1',
      resumeSessionId: 'legacy-shell-id',
    } as Partial<TerminalPaneContent>)

    const req = buildReconcileRequest(asRootState(state))
    expect(req).not.toBeNull()
    const pane = req!.panes.find((p) => p.createRequestId === 'req-sh-1')
    expect(pane).toBeDefined()
    expect(pane!.sessionRef).toBeUndefined()
    expect(pane!.resumeSessionId).toBeUndefined()
  })
})

describe('buildReconcileRequestForPanes', () => {
  it('builds only for the given targets', () => {
    const state = storeStateWith2TerminalPanes()
    const req = buildReconcileRequestForPanes(state, [{ tabId: 'tab2', paneId: 'p2' }])!
    expect(req.panes).toHaveLength(1)
    expect(req.panes[0].paneKey).toBe(paneKeyFor('tab2', 'p2'))
  })

  it('returns null when no target resolves to a terminal pane', () => {
    const state = storeStateWith2TerminalPanes()
    expect(buildReconcileRequestForPanes(state, [{ tabId: 'nope', paneId: 'nada' }])).toBeNull()
  })
})

describe('collectTerminalPaneTargets', () => {
  it('finds panes whose terminalId is in the given set', () => {
    const state = storeStateWith2TerminalPanes()
    const targets = collectTerminalPaneTargets(state.panes.layouts, ['t-1'])
    expect(targets).toEqual([{ tabId: 'tab1', paneId: 'p1' }])
  })

  it('returns empty for unknown terminal ids', () => {
    const state = storeStateWith2TerminalPanes()
    expect(collectTerminalPaneTargets(state.panes.layouts, ['t-unknown'])).toEqual([])
  })
})

describe('foldVerdicts', () => {
  it('dispatches the right action per verdict', () => {
    const { req, dispatch, dispatched } = foldHarness([
      ['attach', { terminalId: 'T1' }],
      ['respawn', { sessionRef: { provider: 'claude', sessionId: 's' } }],
      ['fresh', { reason: 'identity_never_observed' }],
      ['dead_session', { sessionRef: { provider: 'codex', sessionId: 'gone' } }],
      ['error', { reason: 'index_warming' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome).toMatchObject({ attached: 1, respawned: 1, fresh: 1, warming: 1, cardinalityViolation: false })
    expect(dispatched.types).toContain(applyReconcileAttach.type)
    expect(dispatched.types).toContain(resetPaneForReconcileCreate.type)
    expect(dispatched.types).toContain(setReconcileWarming.type)
  })

  it('leaves a pane alone when managed truth is unavailable, instead of failing it', () => {
    // The supervisor owns managed souls. When the server could not read
    // managed truth it says so explicitly; the browser must NOT paint a
    // provider failure over a soul that is very likely alive — the managed
    // inventory reconciler is the authority and will set the real state.
    const { req, dispatch, dispatched } = foldHarness([
      ['error', { reason: 'managed_runtime_unavailable' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome).toMatchObject({ managedDeferred: 1, warming: 0 })
    expect(dispatched.types).not.toContain(setPaneRestoreError.type)
  })

  it('still fails a pane for an ordinary terminal error reason', () => {
    const { req, dispatch, dispatched } = foldHarness([
      ['error', { reason: 'provider_unavailable' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome).toMatchObject({ managedDeferred: 0 })
    expect(dispatched.types).toContain(setPaneRestoreError.type)
  })

  it('attach fold carries the result serverInstanceId and the pane ref parsed from the request', () => {
    const { req, dispatch, dispatched } = foldHarness([['attach', { terminalId: 'T1', corrected: true }]])
    foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(dispatched.lastPayloadOf(applyReconcileAttach.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      terminalId: 'T1',
      serverInstanceId: 'srv-1',
      corrected: true,
    })
  })

  it('respawn folds create-with-resume using the server-named sessionRef', () => {
    const { req, dispatch, dispatched } = foldHarness([
      ['respawn', { sessionRef: { provider: 'claude', sessionId: 'server-truth' } }],
    ])
    foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(dispatched.lastPayloadOf(resetPaneForReconcileCreate.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      intent: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
    })
  })

  it('dead sessions get exactly one per-pane restoreError latch, one dead-copy reconcileNotice, and no batched dispatch', () => {
    // No-modal contract (Task 4): dead_session folds carry NO batched
    // adjudication dispatch anymore — the per-pane restoreError latch is
    // the single dead-session state, plus the one-shot dead-copy notice
    // mint. RED while the batched adjudication dispatch still exists (it is
    // the 7th dispatch for 3 dead panes); GREEN exactly when it is removed.
    const { req, dispatch, dispatched } = foldHarnessAllDead(3)
    const outcome = foldVerdicts(dispatch, req, deadResultFor(req))
    expect(outcome.cardinalityViolation).toBe(false)
    expect(dispatched.actions).toHaveLength(6)
    expect(new Set(dispatched.actions.map((a) => a.type))).toEqual(
      new Set([setPaneRestoreError.type, setPaneReconcileNotice.type]),
    )
    const restoreErrors = dispatched.actions
      .filter((a) => a.type === setPaneRestoreError.type)
      .map((a) => (a as unknown as { payload: { restoreError: { code: string; reason: string } } }).payload.restoreError)
    expect(restoreErrors).toHaveLength(3)
    expect(restoreErrors.every((r) => r.code === 'RESTORE_UNAVAILABLE' && r.reason === 'durable_artifact_missing')).toBe(true)
    const deadNotices = dispatched.actions
      .filter((a) => a.type === setPaneReconcileNotice.type)
      .map((a) => (a as unknown as { payload: { notice: string } }).payload.notice)
    expect(deadNotices.every((notice) => isDeadSessionReconcileNotice(notice))).toBe(true)
    expect(deadNotices).toHaveLength(3)
  })

  it('dead sessions ALSO get a loud per-pane restoreError breadcrumb', () => {
    const { req, dispatch, dispatched } = foldHarnessAllDead(1)
    foldVerdicts(dispatch, req, deadResultFor(req))
    expect(dispatched.countOf(setPaneRestoreError.type)).toBe(1)
    expect(dispatched.lastPayloadOf(setPaneRestoreError.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' },
    })
    // ...beside the one-shot dead-copy notice mint (consumed by
    // TerminalView's buffer-notice machinery).
    expect(dispatched.countOf(setPaneReconcileNotice.type)).toBe(1)
    expect(isDeadSessionReconcileNotice(
      (dispatched.lastPayloadOf(setPaneReconcileNotice.type) as { notice: string }).notice,
    )).toBe(true)
  })

  it('dead terminal verdicts mint a reason-honest dead-copy reconcileNotice beside the latch', () => {
    // Copy honesty (fresh-eyes round 3): the server also returns dead_session
    // with reason respawn_exhausted while the session file is PRESENT — the
    // fold selects the STORE copy from the verdict's reason. Both variants
    // are the dead-copy CATEGORY (matched by predicate, never one string).
    const { req, dispatch, dispatched } = foldHarness([
      ['dead_session', { sessionRef: { provider: 'claude', sessionId: 'gone-file' }, reason: 'session_file_missing' }],
      ['dead_session', { sessionRef: { provider: 'claude', sessionId: 'gone-respawn' }, reason: 'respawn_exhausted' }],
      ['dead_session', { sessionRef: { provider: 'claude', sessionId: 'gone-unknown' } }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.cardinalityViolation).toBe(false)
    const noticePayloads = dispatched.actions
      .filter((a) => a.type === setPaneReconcileNotice.type)
      .map((a) => (a as unknown as { payload: { tabId: string; paneId: string; notice: string } }).payload)
    expect(noticePayloads).toHaveLength(3)
    expect(noticePayloads.map((p) => p.notice)).toEqual([
      DEAD_SESSION_RECONCILE_NOTICES.missing,
      DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted,
      // An unknown reason is honest about the general case, never a
      // disk-loss claim (plan prose: only the known-missing family says
      // "no longer exists on disk").
      DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted,
    ])
    expect(noticePayloads.map((p) => `${p.tabId}:${p.paneId}`)).toEqual(['tab1:p1', 'tab2:p2', 'tab3:p3'])
  })

  it('warming verdicts aggregate into ONE setReconcileWarming dispatch', () => {
    const { req, dispatch, dispatched } = foldHarness([
      ['error', { reason: 'index_warming' }],
      ['error', { reason: 'index_warming' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.warming).toBe(2)
    expect(dispatched.countOf(setReconcileWarming.type)).toBe(1)
    expect(dispatched.lastPayloadOf(setReconcileWarming.type)).toMatchObject({
      count: 2,
      paneRefs: [{ tabId: 'tab1', paneId: 'p1' }, { tabId: 'tab2', paneId: 'p2' }],
    })
  })

  it('cardinality violation folds NOTHING and flags the caller', () => {
    const { req, dispatch, dispatched } = foldHarness([['attach', { terminalId: 'T1' }]])
    const short = { ...resultFor(req, []), verdicts: [] }
    const outcome = foldVerdicts(dispatch, req, short)
    expect(outcome.cardinalityViolation).toBe(true)
    expect(dispatched.types).toHaveLength(0)
  })

  it('paneKey mismatch is a cardinality violation too', () => {
    const { req, dispatch, dispatched } = foldHarness([['attach', { terminalId: 'T1' }]])
    const mismatched = resultFor(req, [{ paneKey: 'other:pane', verdict: 'attach', terminalId: 'T1' }])
    const outcome = foldVerdicts(dispatch, req, mismatched)
    expect(outcome.cardinalityViolation).toBe(true)
    expect(dispatched.types).toHaveLength(0)
  })

  it('error{provider_unavailable} becomes a per-pane restoreError, not warming', () => {
    const { req, dispatch, dispatched } = foldHarness([['error', { reason: 'provider_unavailable' }]])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.warming).toBe(0)
    // folded via the existing restoreError rendering path
    expect(dispatched.countOf(setReconcileWarming.type)).toBe(0)
    expect(dispatched.countOf(setPaneRestoreError.type)).toBe(1)
  })

  it('invalid becomes a per-pane restoreError and counts as invalid', () => {
    const { req, dispatch, dispatched } = foldHarness([['invalid', { reason: 'unsupported_kind' }]])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.invalid).toBe(1)
    expect(dispatched.countOf(setPaneRestoreError.type)).toBe(1)
  })
})

describe('foldVerdicts stale-verdict identity guard (delta round 4, finding 2)', () => {
  // The guard lives in the REDUCERS the fold dispatches to, so these pins
  // drive a REAL store (the recording harness above cannot see reducer
  // behavior).
  function realStorePanes() {
    return configureStore({ reducer: { panes: panesReducer } })
  }

  function seedDeadAdjudicablePane(store: ReturnType<typeof realStorePanes>) {
    store.dispatch(initLayout({
      tabId: 'tab1',
      paneId: 'p1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        shell: 'system',
        createRequestId: 'cr-old',
        status: 'running',
        terminalId: 't-old',
        sessionRef: { provider: 'claude', sessionId: 'sess-gone' },
      },
    }))
  }

  function leafTerminalContent(store: ReturnType<typeof realStorePanes>): TerminalPaneContent {
    const layout = store.getState().panes.layouts['tab1'] as { type: 'leaf'; content: TerminalPaneContent }
    return layout.content
  }

  it('a dead verdict for replaced content cannot latch the replacement (Replace pane keeps the paneId, re-keys createRequestId)', () => {
    const store = realStorePanes()
    seedDeadAdjudicablePane(store)

    // A reconcile request goes out, carrying the OLD content's identity.
    const req = buildReconcileRequest(asRootState(store.getState().panes))!
    expect(req.panes[0].createRequestId).toBe('cr-old')

    // While the verdict is in flight, the user resolves the dead-looking
    // pane through existing chrome: Replace pane keeps the paneId, swaps
    // in the type picker, and the user's selection lands NEW terminal
    // content with a NEW createRequestId (the PaneContainer flow).
    store.dispatch(replacePane({ tabId: 'tab1', paneId: 'p1' }))
    store.dispatch(updatePaneContent({
      tabId: 'tab1',
      paneId: 'p1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        shell: 'system',
        createRequestId: 'cr-new',
        status: 'creating',
      },
    }))

    // The OLD request's dead verdict arrives. RED today: the verdict keys
    // only on (tabId, paneId), so the latch + dead-copy mint land on the
    // NEW content — and the new-create stand-down (keyed on the latch)
    // blocks the replacement from ever starting, breaking the requested
    // resolution through existing pane chrome.
    foldVerdicts(store.dispatch, req, deadResultFor(req))

    const content = leafTerminalContent(store)
    expect(content.createRequestId).toBe('cr-new')
    expect(content.restoreError).toBeUndefined()
    expect(content.reconcileNotice).toBeUndefined()
    expect(content.status).toBe('creating')
    expect(content.terminalId).toBeUndefined()
  })

  it('the same fold still latches + mints the pane the verdict describes (the guard is an exact-identity check)', () => {
    const store = realStorePanes()
    seedDeadAdjudicablePane(store)
    const req = buildReconcileRequest(asRootState(store.getState().panes))!
    foldVerdicts(store.dispatch, req, deadResultFor(req))
    const content = leafTerminalContent(store)
    expect(content.createRequestId).toBe('cr-old')
    expect(content.restoreError).toMatchObject({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'durable_artifact_missing',
    })
    expect(isDeadSessionReconcileNotice(content.reconcileNotice)).toBe(true)
  })
})

describe('deadSessionReconcileNoticeFor', () => {
  it('maps ONLY the known-missing reason family to the disk-loss copy; everything else gets the generic copy', async () => {
    const { deadSessionReconcileNoticeFor } = await import('@/lib/pane-reconcile')
    // The server's deleted-file reasons (and the legacy TS spelling) claim
    // the disk loss.
    expect(deadSessionReconcileNoticeFor('session_not_on_disk')).toBe(DEAD_SESSION_RECONCILE_NOTICES.missing)
    expect(deadSessionReconcileNoticeFor('session_file_missing')).toBe(DEAD_SESSION_RECONCILE_NOTICES.missing)
    // The present-but-unresumable reason...
    expect(deadSessionReconcileNoticeFor('respawn_exhausted')).toBe(DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted)
    // ...and any UNKNOWN reason (a future server's new code, a missing
    // reason field) must not claim the file is gone — honesty is the
    // generic "could not be resumed" copy.
    expect(deadSessionReconcileNoticeFor(undefined)).toBe(DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted)
    expect(deadSessionReconcileNoticeFor('some_future_dead_reason')).toBe(DEAD_SESSION_RECONCILE_NOTICES.respawnExhausted)
  })
})

describe('setPaneRestoreError reducer', () => {
  it('sets restoreError on the terminal pane content without touching identity or handles', () => {
    let panes = emptyPanesState()
    panes = addTerminalPane(panes, 'tab1', 'p1', { terminalId: 't-1', status: 'running' })
    const next = panesReducer(panes, setPaneRestoreError({
      tabId: 'tab1',
      paneId: 'p1',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' },
    }))
    const root = next.layouts['tab1']
    const leaf = (function find(node: PaneNode): TerminalPaneContent | undefined {
      if (node.type === 'leaf') return node.content.kind === 'terminal' ? node.content : undefined
      return find(node.children[0]) ?? find(node.children[1])
    })(root)
    expect(leaf?.restoreError).toEqual({ code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' })
    expect(leaf?.terminalId).toBe('t-1')
    expect(leaf?.createRequestId).toBe('cr-p1')
  })
})

describe('schema tests for reconcile v1 widening', () => {
  it('ReconcilePaneSchema accepts kind fresh-agent', () => {
    const parsed = ReconcilePaneSchema.safeParse({
      paneKey: 't1:p1', kind: 'fresh-agent', mode: 'claude', createRequestId: 'req-1',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
    })
    expect(parsed.success).toBe(true)
  })

  it('ReadyCapabilitiesSchema preserves paneReconcileFreshAgentV1 through parsing', () => {
    const parsed = ReadyCapabilitiesSchema.safeParse({ paneReconcileV1: true, paneReconcileFreshAgentV1: true })
    expect(parsed.success).toBe(true)
    // Load-bearing assertion: Zod non-strict objects STRIP unknown keys — they do
    // NOT reject (see the comment at shared/ws-protocol.ts:274-276). So
    // `.success` is true even on base and proves nothing. App consumes the
    // Zod-PARSED ready.data.capabilities (src/App.tsx:1022); if the key is
    // stripped, the feature silently never activates. Assert the key SURVIVES:
    expect(parsed.success ? parsed.data?.paneReconcileFreshAgentV1 : undefined).toBe(true)
  })

  it('ReadyCapabilitiesSchema preserves pacedTerminalReplayV1 through parsing', () => {
    // Workstream 1 (responsive terminal restore) negotiation: the paced-replay
    // echo must SURVIVE Zod parsing, not just parse successfully — the same
    // strip hazard as paneReconcileFreshAgentV1 above (an undeclared key is
    // silently stripped and the paced restore feature would never activate).
    const parsed = ReadyCapabilitiesSchema.safeParse({ pacedTerminalReplayV1: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data?.pacedTerminalReplayV1 : undefined).toBe(true)
  })
})

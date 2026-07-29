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

import panesReducer, {
  initLayout,
  applyReconcileAttach,
  resetPaneForReconcileCreate,
  setDeadSessionAdjudication,
  setReconcileWarming,
  setPaneRestoreError,
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
  paneKeyFor,
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

  it('sends the terminal pane persisted initial cwd and omits cwd when absent', () => {
    let panes = emptyPanesState()
    panes = addTerminalPane(panes, 'tab1', 'with-cwd', { initialCwd: '/persisted/project' })
    panes = addTerminalPane(panes, 'tab2', 'without-cwd')
    const req = buildReconcileRequest(asRootState(panes))!

    expect(req.panes[0].cwd).toBe('/persisted/project')
    expect(req.panes[1]).not.toHaveProperty('cwd')
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
    expect(outcome).toMatchObject({ attached: 1, respawned: 1, fresh: 1, dead: 1, warming: 1, cardinalityViolation: false })
    expect(dispatched.types).toContain(applyReconcileAttach.type)
    expect(dispatched.types).toContain(resetPaneForReconcileCreate.type)
    expect(dispatched.types).toContain(setDeadSessionAdjudication.type)
    expect(dispatched.types).toContain(setReconcileWarming.type)
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

  it('dead sessions are batched into ONE setDeadSessionAdjudication dispatch (never N)', () => {
    const { req, dispatch, dispatched } = foldHarnessAllDead(3)
    const outcome = foldVerdicts(dispatch, req, deadResultFor(req))
    expect(outcome.dead).toBe(3)
    expect(dispatched.countOf(setDeadSessionAdjudication.type)).toBe(1)
    expect(dispatched.lastPayloadOf(setDeadSessionAdjudication.type)).toHaveLength(3)
  })

  it('dead sessions ALSO get a loud per-pane restoreError breadcrumb', () => {
    const { req, dispatch, dispatched } = foldHarnessAllDead(1)
    foldVerdicts(dispatch, req, deadResultFor(req))
    expect(dispatched.countOf(setPaneRestoreError.type)).toBe(1)
    expect(dispatched.lastPayloadOf(setPaneRestoreError.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      restoreError: { code: 'RESTORE_UNAVAILABLE' },
    })
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
})

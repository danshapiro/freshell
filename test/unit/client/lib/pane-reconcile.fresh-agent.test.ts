import { describe, it, expect, vi, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

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
  applyFreshAgentReconcileAttach,
  resetFreshAgentPaneForReconcileCreate,
  setDeadSessionAdjudication,
  setPaneRestoreError,
} from '@/store/panesSlice'
import type { PanesState } from '@/store/panesSlice'
import type {
  DeadSessionEntry,
  FreshAgentPaneContent,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { AppDispatch, RootState } from '@/store/store'
import type { PaneVerdict, PaneReconcileRequest, PaneReconcileResultMessage } from '@shared/ws-protocol'
import {
  buildReconcileRequest,
  buildReconcileRequestForPanes,
  foldVerdicts,
  isFreshAgentReconcileActive,
  paneKeyFor,
  setFreshAgentReconcileActive,
} from '@/lib/pane-reconcile'
import { selectPaneOwnerDivergence } from '@/store/selectors/runtimeOwner'
import type { RuntimeOwnerRecord } from '@/store/freshAgentTypes'
import type { UnknownAction } from '@reduxjs/toolkit'

const FA_CREATE_REQUEST_ID = 'fa-cr-p9'
const DURABLE = '11111111-1111-4111-8111-111111111111'

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

function addFreshAgentPane(
  state: PanesState,
  tabId: string,
  paneId: string,
  overrides: Partial<FreshAgentPaneContent> = {},
): PanesState {
  return panesReducer(state, initLayout({
    tabId,
    paneId,
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: `fa-cr-${paneId}`,
      status: 'connected',
      ...overrides,
    },
  }))
}

function asRootState(panes: PanesState): RootState {
  return { panes } as unknown as RootState
}

function stateWithBothKinds(): RootState {
  let panes = emptyPanesState()
  panes = addTerminalPane(panes, 'tab1', 'p1', { terminalId: 't-1', status: 'running' })
  panes = addFreshAgentPane(panes, 'tab9', 'p9', {
    createRequestId: FA_CREATE_REQUEST_ID,
    sessionRef: { provider: 'claude', sessionId: DURABLE },
  })
  return asRootState(panes)
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

/** All-fresh-agent fold harness: one FA pane per verdict spec. */
function freshAgentFoldHarness(specs: VerdictSpec[]) {
  let panes = emptyPanesState()
  specs.forEach((_, i) => {
    panes = addFreshAgentPane(panes, `tab${i + 1}`, `p${i + 1}`)
  })
  const req = buildReconcileRequest(asRootState(panes), { includeFreshAgent: true })
  if (!req) throw new Error('freshAgentFoldHarness: expected a request')
  const { dispatch, dispatched } = recordingDispatch()
  dispatched.verdicts = specs.map(([verdict, extra], i) => ({
    paneKey: req.panes[i].paneKey,
    verdict,
    ...extra,
  }))
  return { req, dispatch, dispatched }
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

afterEach(() => {
  vi.restoreAllMocks()
  setFreshAgentReconcileActive(false)
})

describe('managed bootstrap history fold', () => {
  it.each([
    ['freshclaude', 'claude', DURABLE],
    ['kilroy', 'claude', DURABLE],
    ['freshcodex', 'codex', 'native-managed-codex'],
    ['freshopencode', 'opencode', 'ses_managed_opencode'],
  ] as const)('preserves the %s canonical source through an actual fresh fold', (sessionType, provider, nativeId) => {
    const store = configureStore({ reducer: { panes: panesReducer } })
    const sessionRef = { provider, sessionId: nativeId }
    store.dispatch(initLayout({ tabId: 'owned-tab', paneId: 'owned-pane', content: {
      kind: 'fresh-agent', sessionType, provider, createRequestId: FA_CREATE_REQUEST_ID,
      sessionId: 'old-live-handle', sessionRef, resumeSessionId: nativeId, status: 'connected',
      soulId: 'owned-soul', soulIntentRevision: 7,
    } }))
    const request = buildReconcileRequest(store.getState() as RootState, { includeFreshAgent: true })!
    const result = resultFor(request, [{ paneKey: request.panes[0].paneKey, verdict: 'fresh', reason: 'identity_never_observed' }])
    const outcome = foldVerdicts(store.dispatch as AppDispatch, request, result)
    expect(outcome.fresh).toBe(1)
    const root = store.getState().panes.layouts['owned-tab']
    expect(root.type).toBe('leaf')
    if (root.type !== 'leaf') throw new Error('expected owned pane')
    expect(root.content).toMatchObject({ sessionRef, resumeSessionId: nativeId, soulId: 'owned-soul',
      soulIntentRevision: 7, createRequestId: FA_CREATE_REQUEST_ID, pendingReconcile: 'fresh', reconcileEpoch: 1, status: 'creating' })
    expect((root.content as FreshAgentPaneContent).sessionId).toBeUndefined()
    expect(buildReconcileRequest(store.getState() as RootState, { includeFreshAgent: true })!.panes[0])
      .toMatchObject({ createRequestId: FA_CREATE_REQUEST_ID, sessionRef })
  })
})

describe('fresh-agent reconcile capability latch', () => {
  it('defaults to inactive, follows setFreshAgentReconcileActive', () => {
    expect(isFreshAgentReconcileActive()).toBe(false)
    setFreshAgentReconcileActive(true)
    expect(isFreshAgentReconcileActive()).toBe(true)
    setFreshAgentReconcileActive(false)
    expect(isFreshAgentReconcileActive()).toBe(false)
  })
})

describe('buildReconcileRequest with fresh-agent panes', () => {
  it('excludes fresh-agent panes by default (frozen behavior)', () => {
    const req = buildReconcileRequest(stateWithBothKinds())
    expect(req!.panes).toHaveLength(1)
    expect(req!.panes.every((p) => p.kind === 'terminal')).toBe(true)
  })

  it('includes fresh-agent panes when includeFreshAgent is true', () => {
    const req = buildReconcileRequest(stateWithBothKinds(), { includeFreshAgent: true })
    expect(req!.panes).toHaveLength(2)
    const fa = req!.panes.find((p) => p.kind === 'fresh-agent')!
    expect(fa.mode).toBe('claude')
    expect(fa.createRequestId).toBe(FA_CREATE_REQUEST_ID)
    expect(fa.sessionRef).toEqual({ provider: 'claude', sessionId: DURABLE })
  })

  it('skips fresh-agent panes without createRequestId', () => {
    // Built by hand: the initLayout reducer would mint a createRequestId.
    const panes = emptyPanesState()
    panes.layouts['tabX'] = {
      type: 'leaf',
      id: 'pX',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: '',
        status: 'connected',
      } as FreshAgentPaneContent,
    }
    const req = buildReconcileRequest(asRootState(panes), { includeFreshAgent: true })
    expect(req).toBeNull()
  })

  it('promotes a legacy-only fresh-agent pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    // Built by hand (same precedent as the createRequestId-less pane above):
    // initLayout → normalizePaneContent runs the store's own legacy migration,
    // which consumes a claude resumeSessionId into either a sessionRef or a
    // restoreError — so the route-through-the-reducer helper can never produce
    // the legacy-ONLY content this promotion guards (old persisted pane
    // content carrying resumeSessionId without a sessionRef, kata ejh6 §2).
    const panes = emptyPanesState()
    panes.layouts['tab_1'] = {
      type: 'leaf',
      id: 'pane_1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-fa-1',
        status: 'connected',
        resumeSessionId: 'legacy-fa-session-id',
      } as FreshAgentPaneContent,
    }

    const req = buildReconcileRequest(asRootState(panes), { includeFreshAgent: true })
    expect(req).not.toBeNull()
    const pane = req!.panes.find((p) => p.kind === 'fresh-agent')
    expect(pane).toBeDefined()
    expect(pane!.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-fa-session-id' })
    expect(pane!.resumeSessionId).toBeUndefined()
  })
})

describe('buildReconcileRequestForPanes is kind-agnostic', () => {
  it('produces a fresh-agent entry for a fresh-agent target', () => {
    const req = buildReconcileRequestForPanes(stateWithBothKinds(), [{ tabId: 'tab9', paneId: 'p9' }])!
    expect(req.panes).toHaveLength(1)
    expect(req.panes[0]).toMatchObject({
      paneKey: paneKeyFor('tab9', 'p9'),
      kind: 'fresh-agent',
      mode: 'claude',
      createRequestId: FA_CREATE_REQUEST_ID,
      sessionRef: { provider: 'claude', sessionId: DURABLE },
    })
  })
})

describe('foldVerdicts fresh-agent routing', () => {
  it('attach dispatches applyFreshAgentReconcileAttach with the verdict sessionRef', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([
      ['attach', { sessionRef: { provider: 'claude', sessionId: DURABLE }, corrected: true }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.attached).toBe(1)
    expect(dispatched.countOf(applyFreshAgentReconcileAttach.type)).toBe(1)
    expect(dispatched.lastPayloadOf(applyFreshAgentReconcileAttach.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      serverInstanceId: 'srv-1',
      corrected: true,
    })
  })

  it('attach without a sessionRef is skipped entirely (malformed verdict)', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([['attach', {}]])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.attached).toBe(0)
    expect(dispatched.types).toHaveLength(0)
  })

  it('respawn dispatches resetFreshAgentPaneForReconcileCreate intent respawn with server-named ref', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([
      ['respawn', { sessionRef: { provider: 'claude', sessionId: 'server-truth' } }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.respawned).toBe(1)
    expect(dispatched.lastPayloadOf(resetFreshAgentPaneForReconcileCreate.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      intent: 'respawn',
      sessionRef: { provider: 'claude', sessionId: 'server-truth' },
    })
  })

  it('fresh dispatches resetFreshAgentPaneForReconcileCreate intent fresh with reason', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([
      ['fresh', { reason: 'identity_never_observed' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    expect(outcome.fresh).toBe(1)
    expect(dispatched.lastPayloadOf(resetFreshAgentPaneForReconcileCreate.type)).toMatchObject({
      tabId: 'tab1',
      paneId: 'p1',
      intent: 'fresh',
      reason: 'identity_never_observed',
    })
  })

  it('dead_session joins ONE batched adjudication with kind fresh-agent and sets per-pane restoreError', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([
      ['dead_session', { sessionRef: { provider: 'claude', sessionId: 'gone-0' }, reason: 'session_missing' }],
      ['dead_session', { sessionRef: { provider: 'claude', sessionId: 'gone-1' }, reason: 'session_missing' }],
    ])
    const outcome = foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts))
    const batched = dispatched.actions.filter((a) => a.type === setDeadSessionAdjudication.type)
    expect(batched).toHaveLength(1)
    const entries = (batched[0] as { payload: DeadSessionEntry[] }).payload
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.kind === 'fresh-agent')).toBe(true)
    expect(entries.every((e) => e.title.length > 0)).toBe(true)
    expect(outcome.dead).toBe(2)
    expect(dispatched.countOf(setPaneRestoreError.type)).toBe(2)
    expect(dispatched.lastPayloadOf(setPaneRestoreError.type)).toMatchObject({
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' },
    })
  })

  it('mixed terminal + fresh-agent request routes each verdict to its kind reducers', () => {
    const req = buildReconcileRequest(stateWithBothKinds(), { includeFreshAgent: true })!
    expect(req.panes).toHaveLength(2)
    const { dispatch, dispatched } = recordingDispatch()
    const verdicts: PaneVerdict[] = req.panes.map((p) => (
      p.kind === 'terminal'
        ? { paneKey: p.paneKey, verdict: 'attach' as const, terminalId: 'T1' }
        : { paneKey: p.paneKey, verdict: 'attach' as const, sessionRef: { provider: 'claude', sessionId: DURABLE } }
    ))
    const onVerdictFolded = vi.fn()
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), { onVerdictFolded })
    expect(outcome.attached).toBe(2)
    expect(dispatched.countOf(applyReconcileAttach.type)).toBe(1)
    expect(dispatched.countOf(applyFreshAgentReconcileAttach.type)).toBe(1)
    // The hook fires for BOTH kinds — one call per folded pane.
    expect(onVerdictFolded.mock.calls.map((c) => c[0]).sort()).toEqual(
      req.panes.map((p) => p.createRequestId).sort(),
    )
  })

  it('cardinality violation still folds nothing', () => {
    const { req } = freshAgentFoldHarness([
      ['attach', { sessionRef: { provider: 'claude', sessionId: DURABLE } }],
    ])
    const rec = recordingDispatch()
    const outcome = foldVerdicts(rec.dispatch, req, resultFor(req, []))
    expect(outcome.cardinalityViolation).toBe(true)
    expect(rec.dispatched.types).toHaveLength(0)
  })

  it('onVerdictFolded fires once per folded pane with its createRequestId (and not on cardinality violation)', () => {
    const { req, dispatch, dispatched } = freshAgentFoldHarness([
      ['attach', { sessionRef: { provider: 'claude', sessionId: DURABLE } }],
      ['fresh', { reason: 'identity_never_observed' }],
      ['attach', {}], // malformed: skipped, must NOT fire the hook
    ])
    const onVerdictFolded = vi.fn()
    foldVerdicts(dispatch, req, resultFor(req, dispatched.verdicts), { onVerdictFolded })
    expect(onVerdictFolded.mock.calls.map((c) => c[0])).toEqual([
      req.panes[0].createRequestId,
      req.panes[1].createRequestId,
    ])

    // Cardinality violation: hook never fires.
    const hook2 = vi.fn()
    const rec = recordingDispatch()
    const outcome = foldVerdicts(rec.dispatch, req, resultFor(req, []), { onVerdictFolded: hook2 })
    expect(outcome.cardinalityViolation).toBe(true)
    expect(hook2).not.toHaveBeenCalled()
  })
})

describe('foldVerdicts runtime-owner divergence gate (kata b8ke, T1 rec A5)', () => {
  function ownerRecord(overrides: Partial<RuntimeOwnerRecord> = {}): RuntimeOwnerRecord {
    return {
      provider: 'claude',
      sessionId: DURABLE,
      epoch: 5,
      generation: 4,
      ownerKind: 'terminal',
      terminalId: 't-owned',
      transition: 'handoff-committed',
      updatedAt: Date.now(),
      ...overrides,
    }
  }

  function stateWithOwnerRecord(panes: PanesState, record: RuntimeOwnerRecord | null): RootState {
    const freshAgent = record
      ? { runtimeOwners: { [`${record.provider}:${record.sessionId}`]: record } }
      : { runtimeOwners: {} }
    return { panes, freshAgent } as unknown as RootState
  }

  function divergenceGate(state: RootState) {
    return (pane: { mode?: string; sessionRef?: { provider: string; sessionId: string } }) => (
      selectPaneOwnerDivergence(state, {
        paneKind: 'fresh-agent',
        provider: pane.mode,
        sessionRef: pane.sessionRef,
      })
    )
  }

  function respawnHarness(sessionRef: { provider: string; sessionId: string }) {
    let panes = emptyPanesState()
    panes = addFreshAgentPane(panes, 'tab1', 'p1', {
      createRequestId: 'fa-cr-div',
      sessionRef,
      sessionId: sessionRef.sessionId,
    })
    const req = buildReconcileRequest(asRootState(panes), { includeFreshAgent: true })
    if (!req) throw new Error('respawnHarness: expected a request')
    const verdicts: PaneVerdict[] = [{
      paneKey: req.panes[0].paneKey,
      verdict: 'respawn',
      sessionRef,
    }]
    return { panes, req, verdicts }
  }

  it('reconcile respawn verdict does not reset a divergent pane', () => {
    const { panes, req, verdicts } = respawnHarness({ provider: 'claude', sessionId: DURABLE })
    // The canonical session is TERMINAL-owned (generation 4): the pane must
    // keep its identity and render the divergence state instead of re-arming
    // a stale-kind freshAgent.create.
    const state = stateWithOwnerRecord(panes, ownerRecord({ ownerKind: 'terminal', generation: 4 }))
    const { dispatch, dispatched } = recordingDispatch()
    const onVerdictFolded = vi.fn()
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), {
      onVerdictFolded,
      getOwnerDivergence: divergenceGate(state),
    })
    expect(outcome.respawned).toBe(1)
    expect(dispatched.countOf(resetFreshAgentPaneForReconcileCreate.type)).toBe(0)
    // Handled WITHOUT the reset: the held create is retracted (ws.cancelCreate
    // via onVerdictFolded), never flushed at the RECONCILE_VERDICT_WAIT_MS bound.
    expect(onVerdictFolded).toHaveBeenCalledWith(req.panes[0].createRequestId)
  })

  it('reconcile fresh verdict does not reset a divergent pane either', () => {
    const { panes, req } = respawnHarness({ provider: 'claude', sessionId: DURABLE })
    const state = stateWithOwnerRecord(panes, ownerRecord({ ownerKind: 'terminal' }))
    const { dispatch, dispatched } = recordingDispatch()
    const verdicts: PaneVerdict[] = [{
      paneKey: req.panes[0].paneKey,
      verdict: 'fresh',
      reason: 'identity_never_observed',
    }]
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), {
      getOwnerDivergence: divergenceGate(state),
    })
    expect(outcome.fresh).toBe(1)
    expect(dispatched.countOf(resetFreshAgentPaneForReconcileCreate.type)).toBe(0)
  })

  it('respawn verdict still resets when the owner kind matches (same-kind owner)', () => {
    const { panes, req, verdicts } = respawnHarness({ provider: 'claude', sessionId: DURABLE })
    const state = stateWithOwnerRecord(panes, ownerRecord({ ownerKind: 'fresh-agent' }))
    const { dispatch, dispatched } = recordingDispatch()
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), {
      getOwnerDivergence: divergenceGate(state),
    })
    expect(outcome.respawned).toBe(1)
    expect(dispatched.countOf(resetFreshAgentPaneForReconcileCreate.type)).toBe(1)
  })

  it('respawn verdict still resets when no runtimeOwners record exists (legacy behavior preserved)', () => {
    const { panes, req, verdicts } = respawnHarness({ provider: 'claude', sessionId: DURABLE })
    const state = stateWithOwnerRecord(panes, null)
    const { dispatch, dispatched } = recordingDispatch()
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), {
      getOwnerDivergence: divergenceGate(state),
    })
    expect(outcome.respawned).toBe(1)
    expect(dispatched.countOf(resetFreshAgentPaneForReconcileCreate.type)).toBe(1)
  })

  it('a divergent pane with a matching sessionRef but a foreign owner record is not gated', () => {
    const { panes, req, verdicts } = respawnHarness({ provider: 'claude', sessionId: DURABLE })
    // A record for a DIFFERENT session must not gate this pane's respawn.
    const state = stateWithOwnerRecord(panes, ownerRecord({
      provider: 'claude',
      sessionId: 'some-other-session',
      ownerKind: 'terminal',
    }))
    const { dispatch, dispatched } = recordingDispatch()
    const outcome = foldVerdicts(dispatch, req, resultFor(req, verdicts), {
      getOwnerDivergence: divergenceGate(state),
    })
    expect(outcome.respawned).toBe(1)
    expect(dispatched.countOf(resetFreshAgentPaneForReconcileCreate.type)).toBe(1)
  })
})

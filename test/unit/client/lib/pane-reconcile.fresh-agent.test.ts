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
import type { UnknownAction } from '@reduxjs/toolkit'
import freshAgentReducer, {
  addPermissionRequest,
  addQuestionRequest,
  registerPendingCreate,
  sessionError,
  sessionSnapshotReceived,
  setSessionStatus,
  setStreaming,
} from '@/store/freshAgentSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'

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
  it('keeps pane and session runtime fences aligned across attach, events, and recreate', () => {
    const store = configureStore({
      reducer: { panes: panesReducer, freshAgent: freshAgentReducer },
    })
    store.dispatch(initLayout({
      tabId: 'tab1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: FA_CREATE_REQUEST_ID,
        sessionId: DURABLE,
        sessionRef: { provider: 'claude', sessionId: DURABLE },
        status: 'connected',
        runtimeId: 'fresh-old',
        runtimeGeneration: 7,
        serverInstanceId: 'srv-1',
      },
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      latestTurnId: 'turn-from-old-runtime',
      status: 'running',
      streamingActive: true,
      streamingText: 'old partial output',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    }))
    store.dispatch(sessionError({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      code: 'OLD_RUNTIME_ERROR',
      message: 'old runtime failed',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    }))
    store.dispatch(setSessionStatus({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      status: 'running',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    }))
    store.dispatch(setStreaming({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      active: true,
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    }))
    store.dispatch(addPermissionRequest({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'approval-old',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    } as never))
    store.dispatch(addQuestionRequest({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'question-old',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    } as never))

    const attachRequest = buildReconcileRequest(store.getState() as RootState, { includeFreshAgent: true })!
    foldVerdicts(store.dispatch, attachRequest, resultFor(attachRequest, [{
      paneKey: attachRequest.panes[0].paneKey,
      verdict: 'attach',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      runtime: { runtimeId: 'fresh-new', generation: 8 },
    }]))
    const sessionKey = `freshclaude:claude:${DURABLE}`
    expect(store.getState().freshAgent.sessions[sessionKey]).toMatchObject({
      runtimeId: 'fresh-new',
      runtimeGeneration: 8,
      status: 'starting',
      latestTurnId: undefined,
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
      lastError: undefined,
      lastErrorCode: undefined,
    })
    expect(store.getState().freshAgent.retiredRuntimeGenerations['fresh-old']).toBe(7)
    foldVerdicts(store.dispatch, attachRequest, resultFor(attachRequest, [{
      paneKey: attachRequest.panes[0].paneKey,
      verdict: 'attach',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
      runtime: { runtimeId: 'fresh-old', generation: 7 },
    }]))
    expect(store.getState().freshAgent.sessions[sessionKey]).toMatchObject({
      runtimeId: 'fresh-new', runtimeGeneration: 8,
    })
    const attachedPane = store.getState().panes.layouts.tab1
    expect(attachedPane.type === 'leaf' && attachedPane.content.kind === 'fresh-agent'
      ? attachedPane.content.runtimeId
      : undefined).toBe('fresh-new')
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      runtime: { runtimeId: 'fresh-old', generation: 7 },
      event: { type: 'freshAgent.status', status: 'running' },
    }, undefined, store.getState)
    expect(store.getState().freshAgent.sessions[sessionKey].status).toBe('starting')
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      runtime: { runtimeId: 'fresh-new', generation: 8 },
      event: { type: 'freshAgent.status', status: 'running' },
    }, undefined, store.getState)
    expect(store.getState().freshAgent.sessions[sessionKey].status).toBe('running')

    const newRuntime = { runtimeId: 'fresh-new', generation: 8 }
    store.dispatch(sessionError({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      code: 'NEW_RUNTIME_ERROR',
      message: 'new runtime failed before respawn',
      runtime: newRuntime,
    }))
    store.dispatch(setSessionStatus({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      status: 'running',
      runtime: newRuntime,
    }))
    store.dispatch(setStreaming({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      active: true,
      runtime: newRuntime,
    }))
    store.dispatch(addPermissionRequest({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'approval-new',
      runtime: newRuntime,
    } as never))
    store.dispatch(addQuestionRequest({
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'question-new',
      runtime: newRuntime,
    } as never))

    const respawnRequest = buildReconcileRequest(store.getState() as RootState, { includeFreshAgent: true })!
    foldVerdicts(store.dispatch, respawnRequest, resultFor(respawnRequest, [{
      paneKey: respawnRequest.panes[0].paneKey,
      verdict: 'respawn',
      sessionRef: { provider: 'claude', sessionId: DURABLE },
    }]))
    expect(store.getState().freshAgent.sessions[sessionKey]).toMatchObject({
      status: 'starting',
      latestTurnId: undefined,
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
      lastError: undefined,
      lastErrorCode: undefined,
    })
    expect(store.getState().freshAgent.sessions[sessionKey].runtimeId).toBeUndefined()
    expect(store.getState().freshAgent.retiredRuntimeGenerations['fresh-new']).toBe(8)

    store.dispatch(registerPendingCreate({
      requestId: FA_CREATE_REQUEST_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      expectsHistoryHydration: true,
    }))
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: FA_CREATE_REQUEST_ID,
      sessionId: DURABLE,
      sessionType: 'freshclaude',
      provider: 'claude',
      runtime: { runtimeId: 'fresh-created', generation: 9 },
    }, undefined, store.getState)
    expect(store.getState().freshAgent.sessions[sessionKey]).toMatchObject({
      runtimeId: 'fresh-created', runtimeGeneration: 9,
    })
  })

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

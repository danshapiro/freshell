import { describe, expect, it } from 'vitest'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import reducer, {
  addPermissionRequest,
  addQuestionRequest,
  adoptReconcileRuntime,
  applyAgentRestartReplaced,
  clearReconcileRuntime,
  registerPendingCreate,
  sessionCreated,
  sessionSnapshotReceived,
  setSessionStatus,
  setStreaming,
} from '@/store/freshAgentSlice'

const locator = {
  // Durable provider identity and runtime identity are deliberately distinct.
  // A restart replaces the latter while the former remains the session route.
  sessionId: 's1',
  sessionType: 'freshcodex' as const,
  provider: 'codex' as const,
}
const key = makeFreshAgentSessionKey(locator)
const oldRuntime = { runtimeId: 'fresh-old', generation: 7 }

function activeState() {
  let state = reducer(undefined, sessionSnapshotReceived({
    ...locator,
    latestTurnId: 'turn-1',
    status: 'running',
    revision: 3,
    historySessionId: 's1',
    streamingActive: true,
    streamingText: 'partial',
    runtime: oldRuntime,
  }))
  state = reducer(state, addPermissionRequest({
    ...locator,
    requestId: 'approval-1',
    toolName: 'Bash',
    input: {},
    runtime: oldRuntime,
  } as never))
  state = reducer(state, addQuestionRequest({
    ...locator,
    requestId: 'question-1',
    questions: [],
    runtime: oldRuntime,
  } as never))
  return state
}

function stateWithStaleRuntimeEphemera() {
  const state = structuredClone(activeState())
  state.sessions[key].snapshot = {
    threadId: 's1',
    sessionType: 'freshcodex',
    provider: 'codex',
  } as never
  state.sessions[key].lastError = 'old runtime failed'
  state.sessions[key].lastErrorCode = 'OLD_RUNTIME_ERROR'
  return state
}

describe('freshAgentSlice agent restart replacement', () => {
  it('clears stale snapshot, approval, question, stream, and activity state before accepting the replacement generation', () => {
    const state = stateWithStaleRuntimeEphemera()
    const next = reducer(state, applyAgentRestartReplaced({
      type: 'agent.restart.replaced',
      requestId: 'restart-1',
      provider: 'codex',
      sessionId: 's1',
      kind: 'fresh-agent',
      oldRuntimeId: 'fresh-old',
      oldGeneration: 7,
      runtimeId: 'fresh-new',
      generation: 8,
    }))

    expect(next.sessions[key]).toMatchObject({
      sessionId: 's1',
      sessionKey: key,
      threadId: 's1',
      runtimeId: 'fresh-new',
      runtimeGeneration: 8,
      status: 'starting',
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
    })
    expect(next.sessions[key].snapshot).toBeUndefined()
    expect(next.sessions[key].latestTurnId).toBeUndefined()
    expect(next.sessions[key].lastError).toBeUndefined()
    expect(next.sessions[key].lastErrorCode).toBeUndefined()
  })

  it('clears stale runtime ephemera when reconcile adopts a replacement runtime', () => {
    const next = reducer(stateWithStaleRuntimeEphemera(), adoptReconcileRuntime({
      provider: 'codex',
      sessionIds: ['s1'],
      runtime: { runtimeId: 'fresh-new', generation: 8 },
    }))

    expect(next.sessions[key]).toMatchObject({
      runtimeId: 'fresh-new',
      runtimeGeneration: 8,
      status: 'starting',
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
    })
    expect(next.sessions[key].snapshot).toBeUndefined()
    expect(next.sessions[key].latestTurnId).toBeUndefined()
    expect(next.sessions[key].lastError).toBeUndefined()
    expect(next.sessions[key].lastErrorCode).toBeUndefined()
  })

  it('preserves live ephemera for an idempotent reconcile adoption of the identical runtime', () => {
    const state = stateWithStaleRuntimeEphemera()
    const next = reducer(state, adoptReconcileRuntime({
      provider: 'codex',
      sessionIds: ['s1'],
      runtime: oldRuntime,
    }))

    expect(next).toBe(state)
    expect(next.sessions[key]).toMatchObject({
      runtimeId: oldRuntime.runtimeId,
      runtimeGeneration: oldRuntime.generation,
      status: 'running',
      latestTurnId: 'turn-1',
      streamingText: 'partial',
      streamingActive: true,
      lastError: 'old runtime failed',
      lastErrorCode: 'OLD_RUNTIME_ERROR',
    })

    const afterEvent = reducer(next, setSessionStatus({
      ...locator,
      status: 'idle',
      runtime: oldRuntime,
    }))
    expect(afterEvent.sessions[key].status).toBe('idle')
  })

  it('clears stale runtime ephemera when reconcile clears a runtime for recreation', () => {
    const next = reducer(stateWithStaleRuntimeEphemera(), clearReconcileRuntime({
      provider: 'codex',
      sessionIds: ['s1'],
    }))

    expect(next.sessions[key]).toMatchObject({
      status: 'starting',
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
    })
    expect(next.sessions[key].runtimeId).toBeUndefined()
    expect(next.sessions[key].runtimeGeneration).toBeUndefined()
    expect(next.sessions[key].snapshot).toBeUndefined()
    expect(next.sessions[key].latestTurnId).toBeUndefined()
    expect(next.sessions[key].lastError).toBeUndefined()
    expect(next.sessions[key].lastErrorCode).toBeUndefined()
  })

  it('clears stale runtime ephemera when a correlated create establishes the new runtime', () => {
    let state = stateWithStaleRuntimeEphemera()
    delete state.sessions[key].runtimeId
    delete state.sessions[key].runtimeGeneration
    state = reducer(state, registerPendingCreate({
      requestId: 'create-new',
      sessionType: 'freshcodex',
      provider: 'codex',
      expectsHistoryHydration: false,
    }))

    const next = reducer(state, sessionCreated({
      requestId: 'create-new',
      sessionId: 's1',
      sessionType: 'freshcodex',
      provider: 'codex',
      runtime: { runtimeId: 'fresh-new', generation: 8 },
    }))

    expect(next.sessions[key]).toMatchObject({
      runtimeId: 'fresh-new',
      runtimeGeneration: 8,
      status: 'connected',
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
    })
    expect(next.sessions[key].snapshot).toBeUndefined()
    expect(next.sessions[key].latestTurnId).toBeUndefined()
    expect(next.sessions[key].lastError).toBeUndefined()
    expect(next.sessions[key].lastErrorCode).toBeUndefined()
  })

  it('rejects old-runtime transport events after replacement but accepts the replacement generation', () => {
    let state = reducer(activeState(), applyAgentRestartReplaced({
      type: 'agent.restart.replaced',
      requestId: 'restart-1',
      provider: 'codex',
      sessionId: 's1',
      kind: 'fresh-agent',
      oldRuntimeId: 'fresh-old',
      oldGeneration: 7,
      runtimeId: 'fresh-new',
      generation: 8,
    }))

    state = reducer(state, setStreaming({ ...locator, active: true, runtime: oldRuntime }))
    state = reducer(state, setSessionStatus({ ...locator, status: 'running', runtime: oldRuntime }))
    expect(state.sessions[key].streamingActive).toBe(false)
    expect(state.sessions[key].status).toBe('starting')

    const replacementRuntime = { runtimeId: 'fresh-new', generation: 8 }
    const replacementLocator = locator
    state = reducer(state, setStreaming({ ...replacementLocator, active: true, runtime: replacementRuntime }))
    state = reducer(state, setSessionStatus({ ...replacementLocator, status: 'running', runtime: replacementRuntime }))
    expect(state.sessions[key].streamingActive).toBe(true)
    expect(state.sessions[key].status).toBe('running')
  })

  it('fails closed for an unfenced legacy session even when its durable session id matches', () => {
    let state = structuredClone(activeState())
    delete state.sessions[key].runtimeId
    delete state.sessions[key].runtimeGeneration

    state = reducer(state, applyAgentRestartReplaced({
      type: 'agent.restart.replaced',
      requestId: 'restart-legacy',
      provider: 'codex',
      sessionId: 's1',
      kind: 'fresh-agent',
      // This used to match through the sessionId fallback.
      oldRuntimeId: 's1',
      oldGeneration: 7,
      runtimeId: 'fresh-new',
      generation: 8,
    }))

    expect(state.sessions[key].sessionId).toBe('s1')
    expect(state.sessions[key]).not.toHaveProperty('runtimeId')
    expect(state.sessions[key]).not.toHaveProperty('runtimeGeneration')
  })
})

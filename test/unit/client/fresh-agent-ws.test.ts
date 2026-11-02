import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'

describe('fresh-agent websocket public contract', () => {
  it('treats a new operation error as non-terminal even for a session-lookup code', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'thread-op-error', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    handleFreshAgentMessage(store.dispatch, { ...outer, event: { type: 'freshAgent.status', status: 'running' } })
    expect(handleFreshAgentMessage(store.dispatch, { ...outer, event: { type: 'freshAgent.operation.error',
      code: 'INVALID_SESSION_ID', requestId: 'stop-1', message: 'The Stop request could not find the session.' } })).toBe(true)
    const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-op-error']
    expect(session.status).toBe('running')
    expect(session.lastError).toBe('The Stop request could not find the session.')
    expect(session.lastErrorRequestId).toBe('stop-1')
    expect(handleFreshAgentMessage(store.dispatch, { ...outer, event: { type: 'freshAgent.operation.error',
      code: 'INVALID_SESSION_ID', requestId: 'undo-1', rollback: true, message: 'Rollback failed.' } })).toBe(true)
    expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-op-error']).toEqual(session)
  })

  it('shows that a native control transport failure has an uncertain outcome', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'thread-uncertain', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    handleFreshAgentMessage(store.dispatch, { ...outer, event: { type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null } })
    handleFreshAgentMessage(store.dispatch, { ...outer, event: { type: 'freshAgent.error', code: 'CODEX_INTERRUPT_AMBIGUOUS',
      requestId: 'stop-1', operationReceipt: true, operationOutcomeUncertain: true, message: 'The provider connection closed.' } })
    const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-uncertain']
    expect(session.status).toBe('running')
    expect(session.lastError).toContain('The provider connection closed.')
    expect(session.lastError).toContain('could not be confirmed')
  })

  it('keeps a newer operation warning when an older receipt is replayed, while accepting fresh receipts', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'thread-replay', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.status', status: 'running' })
    const earlier = { type: 'freshAgent.operation.error', requestId: 'fork-a', operationReceipt: true,
      code: 'FORK_FAILED', message: 'The earlier fork failed.' }
    const later = { type: 'freshAgent.error', requestId: 'stop-b', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS',
      message: 'Stopping the agent could not be confirmed.' }
    send(earlier)
    send(later)
    send({ ...earlier, operationReceiptReplay: true })
    let session = store.getState().freshAgent.sessions['freshcodex:codex:thread-replay']
    expect(session.lastError).toBe(later.message)
    expect(session.lastErrorCode).toBe('COMMAND_AMBIGUOUS')
    expect(session.status).toBe('running')

    // The same payload can be a fresh provider response to a repeated
    // request. Only a known replay is suppressed.
    send(earlier)
    session = store.getState().freshAgent.sessions['freshcodex:codex:thread-replay']
    expect(session.lastError).toBe(earlier.message)
    expect(session.lastErrorCode).toBe('FORK_FAILED')

    send(later)
    send({ ...earlier, operationReceiptReplay: true, message: 'A corrected provider cause.' })
    session = store.getState().freshAgent.sessions['freshcodex:codex:thread-replay']
    expect(session.lastError).toBe('A corrected provider cause.')
  })

  it('does not restore an older answer error when the question ID is reused', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'thread-reused-question', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
    const earlier = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'The first answer was invalid.' }
    const later = { ...earlier, message: 'The later answer was invalid.' }
    const fallback = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS',
      message: 'Sending the answer could not be confirmed.' }
    send(earlier)
    send(later)
    send(fallback)
    send({ ...earlier, operationReceiptReplay: true })
    let session = store.getState().freshAgent.sessions['freshcodex:codex:thread-reused-question']
    expect(session.lastError).toBe(`${later.message} ${fallback.message}`)
    expect(session.pendingQuestions['question-1']).toBeDefined()
    expect(session.status).toBe('running')

    // A real new answer can fail with the same text; it must remain visible.
    send(earlier)
    session = store.getState().freshAgent.sessions['freshcodex:codex:thread-reused-question']
    expect(session.lastError).toBe(`${earlier.message} ${fallback.message}`)
  })

  it('keeps a running turn and pending question while preferring a control provider error over its fallback in either order', () => {
    for (const [nativeType, fallbackFirst, nativeUncertain] of [
      ['freshAgent.error', true, false],
      ['freshAgent.error', false, false],
      ['freshAgent.error', true, true],
      ['freshAgent.error', false, true],
      ['freshAgent.operation.error', true, false],
      ['freshAgent.operation.error', false, false],
      ['freshAgent.operation.error', true, true],
      ['freshAgent.operation.error', false, true],
    ] as const) {
      const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
      const outer = { type: 'freshAgent.event' as const, sessionId: 'thread-1', sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
      send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
      send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
      const native = { type: nativeType, code: 'INVALID_ANSWER', requestId: 'question-1', operationReceipt: true,
        ...(nativeUncertain ? { operationOutcomeUncertain: true } : {}), message: 'Choose an offered answer.' }
      const fallback = { type: 'freshAgent.error', code: 'COMMAND_AMBIGUOUS', requestId: 'question-1', operationReceipt: true, operationFallback: true, operationOutcomeUncertain: true, message: 'Sending the answer could not be confirmed.' }
      for (const event of fallbackFirst ? [fallback, native] : [native, fallback]) send(event)
      const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
      expect(session.status).toBe('running')
      expect(session.pendingQuestions['question-1']).toBeDefined()
      expect(session.lastError).toContain('Choose an offered answer.')
      expect(session.lastError).toContain('could not be confirmed')
      expect(session.lastError?.match(/could not be confirmed/g)).toHaveLength(1)
      expect(session.lastErrorCode).toBe('INVALID_ANSWER')

      // Attaching another pane replays the provider receipt from the host's
      // journal, but the gateway's transient fallback is not replayed.
      const combined = session.lastError
      send(native)
      const replayed = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
      expect(replayed.lastError).toBe(combined)
      expect(replayed.lastError?.match(/could not be confirmed/g)).toHaveLength(1)
      expect(replayed.status).toBe('running')
      expect(replayed.pendingQuestions['question-1']).toBeDefined()

      send({ ...native, message: 'The provider gave an updated explanation.' })
      const updated = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
      expect(updated.lastError).toContain('The provider gave an updated explanation.')
      expect(updated.lastError?.match(/could not be confirmed/g)).toHaveLength(1)
      expect(updated.lastError).not.toContain('Choose an offered answer.')

      send({ type: nativeType, code: 'INVALID_ANSWER', requestId: 'question-2', operationReceipt: true,
        message: 'A different answer was refused.' })
      const other = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
      expect(other.lastError).toBe('A different answer was refused.')
    }
  })

  it('removes a session when the fresh-agent killed acknowledgement arrives', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })

    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'thread-1',
        latestTurnId: null,
        status: 'idle',
        revision: 1,
      },
    })

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.killed',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      success: true,
    })).toBe(true)
    expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-1']).toBeUndefined()
  })

  it('keeps the session and surfaces an error when the kill reports success:false', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })

    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'thread-1',
        latestTurnId: null,
        status: 'idle',
        revision: 1,
      },
    })

    // The server's durable close FAILED (delta-r6-r2 Finding 5): the session
    // was NOT killed — the client must not fold it away as if it had been.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.killed',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      success: false,
    })).toBe(true)
    const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(session).toBeDefined()
    expect(session.lastErrorCode).toBe('KILL_FAILED')
    expect(session.lastError).toContain('still be running')
  })
  it('reduces a typed refusal code instead of the generic KILL_FAILED default (b8ke focused FR9)', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })

    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'thread-1',
        latestTurnId: null,
        status: 'idle',
        revision: 1,
      },
    })

    // The half-sent observed fence pair: the server refuses the kill with
    // the typed INVALID_FENCE code riding the killed answer — the pane's
    // session-error surface must show THAT code, not KILL_FAILED.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.killed',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      success: false,
      code: 'INVALID_FENCE',
      message: 'observedEpoch and observedGeneration must be sent together — a half-fence is invalid',
    })).toBe(true)
    const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(session).toBeDefined()
    expect(session.lastErrorCode).toBe('INVALID_FENCE')
    expect(session.lastError).toContain('together')

    // The event-wrapped shape folds identically.
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'thread-1',
        latestTurnId: null,
        status: 'idle',
        revision: 2,
      },
    })
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.killed',
        success: false,
        code: 'INVALID_FENCE',
        message: 'observedEpoch and observedGeneration must be sent together — a half-fence is invalid',
      },
    })).toBe(true)
    const folded = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(folded).toBeDefined()
    expect(folded.lastErrorCode).toBe('INVALID_FENCE')
  })

  // ── freshAgent.session.metadata: the live-settings convergence fold ─────────

  function seedLiveSession(store: ReturnType<typeof configureStore<{ freshAgent: typeof freshAgentReducer }>>) {
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.init',
        sessionId: 'thread-1',
        cliSessionId: 'thread-1',
        model: 'gpt-5.6-luna',
        effort: 'high',
        cwd: '/repo',
      },
    })
  }

  it('folds a session.metadata frame into the live model + effort', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })
    seedLiveSession(store)

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.metadata',
        sessionId: 'thread-1',
        model: 'gpt-5.6-sol',
        effort: 'low',
      },
    })).toBe(true)
    const session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(session.model).toBe('gpt-5.6-sol')
    expect(session.effort).toBe('low')
  })

  it('folds an explicit-null metadata as a CLEAR, and absent keys as no-statement', () => {
    const store = configureStore({
      reducer: { freshAgent: freshAgentReducer },
    })
    seedLiveSession(store)

    // Null states "explicitly no value" (e.g. opencode's Default thinking row):
    // the clear must REPLACE, not fall through to the stale prior.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.metadata',
        sessionId: 'thread-1',
        model: 'gpt-5.6-sol',
        effort: null,
      },
    })).toBe(true)
    let session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(session.model).toBe('gpt-5.6-sol')
    expect(session.effort).toBeNull()

    // Absent keys are "no statement": nothing changes.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.metadata',
        sessionId: 'thread-1',
      },
    })).toBe(true)
    session = store.getState().freshAgent.sessions['freshcodex:codex:thread-1']
    expect(session.model).toBe('gpt-5.6-sol')
    expect(session.effort).toBeNull()
  })
})

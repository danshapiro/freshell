import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { clearSessionError } from '@/store/freshAgentSlice'
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

  it('keeps repeated answer failures attributed to the same attempt across browsers', () => {
    const browsers = [0, 1].map(() => configureStore({ reducer: { freshAgent: freshAgentReducer } }))
    const locator = { sessionId: 'thread-two-browsers', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const outer = { type: 'freshAgent.event' as const, ...locator }
    const broadcast = (event: Record<string, unknown>) => {
      for (const browser of browsers) handleFreshAgentMessage(browser.dispatch, { ...outer, event })
    }
    const session = (index: number) => browsers[index].getState().freshAgent.sessions['freshcodex:codex:thread-two-browsers']
    broadcast({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    broadcast({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
    broadcast({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-1' })
    const previous = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
      operationAttemptId: 'attempt-1', code: 'INVALID_ANSWER', message: 'The first answer was invalid.' }
    broadcast(previous)
    expect(session(0).lastError).toBe(previous.message)
    expect(session(1).lastError).toBe(previous.message)

    // The second browser observes the retry but does not initiate it.
    broadcast({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2' })
    const fallback = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
      operationAttemptId: 'attempt-2', operationFallback: true, operationOutcomeUncertain: true,
      code: 'COMMAND_AMBIGUOUS', message: 'Sending the answer could not be confirmed.' }
    broadcast(fallback)
    broadcast(previous) // an old provider event may be delayed in the host journal
    broadcast({ ...previous, operationReceiptReplay: true })
    for (const index of [0, 1]) {
      expect(session(index).lastError).toBe(fallback.message)
      expect(session(index).status).toBe('running')
      expect(session(index).pendingQuestions['question-1']).toBeDefined()
    }

    const current = { ...previous, operationAttemptId: 'attempt-2', message: 'The second answer was invalid.' }
    broadcast(current)
    broadcast({ ...current, operationReceiptReplay: true })
    for (const index of [0, 1]) {
      expect(session(index).lastError).toBe(`${current.message} ${fallback.message}`)
    }

    // Retrying does not settle the previous uncertain delivery. Keep it
    // separately labeled when a later attempt receives a definite refusal.
    broadcast({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-3' })
    const newest = { ...previous, operationAttemptId: 'attempt-3', message: 'The third answer was invalid.' }
    broadcast(newest)
    for (const index of [0, 1]) {
      expect(session(index).lastError).toBe(`${newest.message} Earlier attempt: ${fallback.message}`)
    }
  })

  it('keeps an older host receipt visible without attributing it to a tagged attempt', () => {
    for (const [providerFirst, startSeen] of [[true, true], [false, true], [true, false], [false, false]]) {
      const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
      const locator = { sessionId: 'old-host', sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const outer = { type: 'freshAgent.event' as const, ...locator }
      const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
      send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
      if (startSeen) send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2' })
      const native = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
        code: 'INVALID_ANSWER', message: 'The provider reported an invalid answer.' }
      const fallback = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
        operationAttemptId: 'attempt-2', operationFallback: true, operationOutcomeUncertain: true,
        code: 'COMMAND_AMBIGUOUS', message: 'Sending the answer could not be confirmed.' }
      for (const event of providerFirst ? [native, fallback] : [fallback, native]) send(event)
      const session = store.getState().freshAgent.sessions['freshcodex:codex:old-host']
      expect(session.lastError).toContain(fallback.message)
      expect(session.lastError).toContain(native.message)
      expect(session.lastError).toContain('answer attempt unknown')
      expect(session.status).toBe('running')
    }
  })

  it('recovers the current answer when a pane joins after its start event', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const locator = { sessionId: 'late-join', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const outer = { type: 'freshAgent.event' as const, ...locator }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
    const older = { type: 'freshAgent.error', requestId: 'question-1', operationReceipt: true,
      operationAttemptId: 'attempt-1', code: 'INVALID_ANSWER', message: 'The first answer was invalid.' }
    const current = { ...older, operationAttemptId: 'attempt-2', message: 'The second answer was invalid.' }
    // A fresh pane can see journal receipts before its attach replay settles.
    send(older)
    send({ type: 'freshAgent.operation.error', requestId: 'question-1', operationAttemptId: 'attempt-1', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS', message: 'The first answer could not be confirmed.' })
    send(current)
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2', operationAttemptReplay: true })
    send({ type: 'freshAgent.operation.error', requestId: 'question-1', operationAttemptId: 'attempt-2', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, operationReceiptReplay: true,
      code: 'COMMAND_AMBIGUOUS', message: 'The second answer could not be confirmed.' })
    send({ ...older, operationReceiptReplay: true })
    const session = store.getState().freshAgent.sessions['freshcodex:codex:late-join']
    expect(session.lastError).toContain(current.message)
    expect(session.lastError).toContain('The second answer could not be confirmed.')
    expect(session.lastError).toContain('Earlier attempt: The first answer could not be confirmed.')
    expect(session.lastError).not.toContain(older.message)
    expect(session.pendingQuestions['question-1']).toBeDefined()
    expect(session.status).toBe('running')
  })

  it('does not move an unrelated uncertain answer onto an untagged older-host receipt', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const locator = { sessionId: 'different-controls', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const outer = { type: 'freshAgent.event' as const, ...locator }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.operation.started', requestId: 'question-a', operationAttemptId: 'attempt-a' })
    send({ type: 'freshAgent.error', requestId: 'question-a', operationAttemptId: 'attempt-a', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS', message: 'Answer A is unconfirmed.' })
    send({ type: 'freshAgent.operation.started', requestId: 'question-b', operationAttemptId: 'attempt-b' })
    send({ type: 'freshAgent.error', requestId: 'question-b', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'Answer B was invalid.' })
    let session = store.getState().freshAgent.sessions['freshcodex:codex:different-controls']
    expect(session.lastError).toContain('Answer B was invalid.')
    expect(session.lastError).toContain('Another request: Answer A is unconfirmed.')
    expect(session.lastErrorOperationUncertain).not.toBe(true)
    send({ type: 'freshAgent.operation.started', requestId: 'question-b', operationAttemptId: 'attempt-b2' })
    session = store.getState().freshAgent.sessions['freshcodex:codex:different-controls']
    expect(session.lastError).toContain('Another request: Answer A is unconfirmed.')
    expect(session.lastError).not.toContain('Earlier attempt: Answer A')
  })

  it('does not redisplay a dismissed answer warning when another pane attaches', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const locator = { sessionId: 'dismissed-replay', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const outer = { type: 'freshAgent.event' as const, ...locator }
    const start = { type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2' }
    const fallback = { type: 'freshAgent.operation.error', requestId: 'question-1', operationAttemptId: 'attempt-2',
      operationReceipt: true, operationFallback: true, operationOutcomeUncertain: true,
      code: 'COMMAND_AMBIGUOUS', message: 'Second answer unconfirmed.' }
    handleFreshAgentMessage(store.dispatch, { ...outer, event: start })
    handleFreshAgentMessage(store.dispatch, { ...outer, event: fallback })
    expect(store.getState().freshAgent.sessions['freshcodex:codex:dismissed-replay'].lastError).toContain('Second answer unconfirmed.')
    store.dispatch(clearSessionError(locator))
    handleFreshAgentMessage(store.dispatch, { ...outer, event: { ...start, operationAttemptReplay: true } })
    handleFreshAgentMessage(store.dispatch, { ...outer, event: { ...fallback, operationReceiptReplay: true } })
    expect(store.getState().freshAgent.sessions['freshcodex:codex:dismissed-replay'].lastError).toBeUndefined()
  })

  it('keeps a fallback separate until the matching host admission is observed', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const locator = { sessionId: 'unconfirmed-attempt', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const outer = { type: 'freshAgent.event' as const, ...locator }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-1',
      operationJournalId: 'journal-1', operationJournalSequence: 1 })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-1', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'The first answer was invalid.' })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-2', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS', message: 'The second answer is unconfirmed.' })
    let session = store.getState().freshAgent.sessions['freshcodex:codex:unconfirmed-attempt']
    expect(session.lastError).toContain('Another answer attempt: The second answer is unconfirmed.')
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2',
      operationAttemptReplay: true, operationJournalId: 'journal-1', operationJournalSequence: 3 })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-2', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'The second answer was invalid.' })
    session = store.getState().freshAgent.sessions['freshcodex:codex:unconfirmed-attempt']
    expect(session.lastError).toBe('The second answer was invalid. The second answer is unconfirmed.')
  })

  it('attributes a pre-replay fallback after the matching journal start arrives', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'fallback-before-replay', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-2', operationReceipt: true,
      operationFallback: true, operationOutcomeUncertain: true, code: 'COMMAND_AMBIGUOUS', message: 'The second answer is unconfirmed.' })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-1', operationAttemptReplay: true })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-1', operationReceipt: true,
      operationReceiptReplay: true, code: 'INVALID_ANSWER', message: 'The first answer was invalid.' })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2', operationAttemptReplay: true })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-2', operationReceipt: true,
      operationReceiptReplay: true, code: 'INVALID_ANSWER', message: 'The second answer was invalid.' })
    const session = store.getState().freshAgent.sessions['freshcodex:codex:fallback-before-replay']
    expect(session.lastError).toBe('The second answer was invalid. The second answer is unconfirmed.')
    expect(session.lastErrorOperationUncertain).toBe(true)
  })

  it('shows a replayed still-running answer as provisional and clears it when the request ends', () => {
    for (const settled of ['question-cancelled', 'provider-error'] as const) {
      const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
      const outer = { type: 'freshAgent.event' as const, sessionId: `pending-${settled}`, sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
      send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
      send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
      send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-1',
        operationJournalId: 'journal-1', operationJournalSequence: 1, operationAttemptReplay: true, operationPending: true })
      let session = store.getState().freshAgent.sessions[`freshcodex:codex:pending-${settled}`]
      expect(session.lastError).toContain('outcome is not yet confirmed')
      expect(session.pendingQuestions['question-1']).toBeDefined()
      if (settled === 'question-cancelled') {
        send({ type: 'freshAgent.question.cancelled', requestId: 'question-1' })
      } else {
        send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'attempt-1', operationReceipt: true,
          code: 'INVALID_ANSWER', message: 'The answer was invalid.' })
      }
      session = store.getState().freshAgent.sessions[`freshcodex:codex:pending-${settled}`]
      expect(session.lastError).toBe(settled === 'provider-error' ? 'The answer was invalid.' : undefined)
      expect(session.status).toBe('running')
    }
  })

  it('does not resurrect a settled answer from a delayed pending replay', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'stale-pending', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue?', options: [] }] })
    send({ type: 'freshAgent.question.cancelled', requestId: 'question-1', operationAttemptId: 'attempt-1',
      operationJournalId: 'journal-1', operationJournalSequence: 5 })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-1',
      operationJournalId: 'journal-1', operationJournalSequence: 3, operationAttemptReplay: true, operationPending: true })
    let session = store.getState().freshAgent.sessions['freshcodex:codex:stale-pending']
    expect(session.lastError).toBeUndefined()
    expect(session.pendingQuestions['question-1']).toBeUndefined()

    // Reusing the question ID for a genuinely newer request remains possible.
    send({ type: 'freshAgent.question.request', requestId: 'question-1', questions: [{ question: 'Continue again?', options: [] }] })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'attempt-2',
      operationJournalId: 'journal-1', operationJournalSequence: 6, operationAttemptReplay: true, operationPending: true })
    send({ type: 'freshAgent.question.cancelled', requestId: 'question-1', operationAttemptId: 'attempt-1',
      operationJournalId: 'journal-1', operationJournalSequence: 5 })
    session = store.getState().freshAgent.sessions['freshcodex:codex:stale-pending']
    expect(session.lastError).toContain('outcome is not yet confirmed')
    expect(session.pendingQuestions['question-1']).toBeDefined()
  })

  it('ignores delayed starts from a retired host journal', () => {
    const store = configureStore({ reducer: { freshAgent: freshAgentReducer } })
    const outer = { type: 'freshAgent.event' as const, sessionId: 'replaced-journal', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const send = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, { ...outer, event })
    send({ type: 'freshAgent.session.snapshot', status: 'running', revision: 1, latestTurnId: null })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'old-attempt',
      operationJournalId: 'old-journal', operationJournalSequence: 10 })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'new-attempt',
      operationJournalId: 'new-journal', operationJournalSequence: 1, operationAttemptReplay: true })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'new-attempt', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'The current answer was invalid.' })
    send({ type: 'freshAgent.operation.started', requestId: 'question-1', operationAttemptId: 'late-old-attempt',
      operationJournalId: 'old-journal', operationJournalSequence: 11 })
    send({ type: 'freshAgent.error', requestId: 'question-1', operationAttemptId: 'late-old-attempt', operationReceipt: true,
      code: 'INVALID_ANSWER', message: 'An older source answer was invalid.' })
    expect(store.getState().freshAgent.sessions['freshcodex:codex:replaced-journal'].lastError).toBe('The current answer was invalid.')
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

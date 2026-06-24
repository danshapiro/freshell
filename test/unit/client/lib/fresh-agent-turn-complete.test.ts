import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { setSessionStatus } from '@/store/freshAgentSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import type { PaneNode } from '@/store/paneTypes'

// Claude pane fixtures for waiting tests (waiting is Claude/kilroy-only)
const RUNTIME_ID = 'claude-runtime-nanoid'
const DURABLE_ID = '11111111-2222-4333-8444-555555555555'
const claudeLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-claude',
  content: {
    kind: 'fresh-agent', createRequestId: 'cr-claude', sessionType: 'freshclaude',
    provider: 'claude', sessionId: RUNTIME_ID, sessionRef: { provider: 'claude', sessionId: DURABLE_ID },
  } as never,
}
function makeClaudeStore() {
  return configureStore({
    reducer: {
      panes: () => ({ layouts: { 'tab-claude': claudeLeaf }, activePane: {} }) as never,
      tabs: () => ({ activeTabId: 'tab-claude' }) as never,
      freshAgent: freshAgentReducer,
      turnCompletion: turnCompletionReducer,
    },
  })
}
function waitingMessage(at: number) {
  return {
    type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.turn.waiting', sessionId: RUNTIME_ID, at },
  }
}

const TAB = 'tab-1'
const PANE = 'pane-1'
const SESSION_ID = 'ses_real_1'

const freshOpencodeLeaf: PaneNode = {
  type: 'leaf',
  id: PANE,
  content: {
    kind: 'fresh-agent',
    createRequestId: 'cr',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: SESSION_ID,
    sessionRef: { provider: 'opencode', sessionId: SESSION_ID },
  } as never,
}

function makeStore() {
  return configureStore({
    reducer: {
      panes: () => ({ layouts: { [TAB]: freshOpencodeLeaf }, activePane: {} }) as never,
      tabs: () => ({ activeTabId: TAB }) as never,
      freshAgent: freshAgentReducer,
      turnCompletion: turnCompletionReducer,
    },
  })
}

function turnCompleteMessage(at: number) {
  return {
    type: 'freshAgent.event',
    sessionId: SESSION_ID,
    sessionType: 'freshopencode',
    provider: 'opencode',
    event: { type: 'freshAgent.turn.complete', sessionId: SESSION_ID, at },
  }
}

describe('server-authoritative fresh-agent turn completion (client)', () => {
  it('routes a freshAgent.turn.complete event to recordTurnComplete for the owning tab/pane', () => {
    const store = makeStore()
    store.dispatch(setSessionStatus({ sessionId: SESSION_ID, sessionType: 'freshopencode', provider: 'opencode', status: 'idle' }))

    const handled = handleFreshAgentMessage(store.dispatch, turnCompleteMessage(1000))
    expect(handled).toBe(true)

    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabId: TAB, paneId: PANE, terminalId: `opencode:${SESSION_ID}`, at: 1000 })
  })

  it('dedupes a replayed/stale completion by the at-monotonic guard (no premature re-green)', () => {
    const store = makeStore()

    handleFreshAgentMessage(store.dispatch, turnCompleteMessage(1000))
    // Same timestamp (replay) and an older timestamp must both be dropped.
    handleFreshAgentMessage(store.dispatch, turnCompleteMessage(1000))
    handleFreshAgentMessage(store.dispatch, turnCompleteMessage(500))
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(1)

    // A strictly newer completion (next real turn) greens again.
    handleFreshAgentMessage(store.dispatch, turnCompleteMessage(2000))
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(2)
  })

  it('drops a malformed completion without a numeric at instead of fabricating Date.now()', () => {
    // The server always stamps a monotonic numeric `at` (every emit site uses
    // nextMonotonicTurnCompleteAt). A completion without one is malformed; fabricating a
    // client Date.now() would inject a timestamp that can collide with or regress against
    // the server clock — swallowing a real later completion or spuriously greening. Drop it.
    const store = makeStore()
    store.dispatch(setSessionStatus({ sessionId: SESSION_ID, sessionType: 'freshopencode', provider: 'opencode', status: 'idle' }))

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: SESSION_ID,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: { type: 'freshAgent.turn.complete', sessionId: SESSION_ID } as never,
    })
    expect(handled).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)

    // A non-finite at (e.g. NaN from a bad parse) is likewise dropped.
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: SESSION_ID,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: { type: 'freshAgent.turn.complete', sessionId: SESSION_ID, at: Number.NaN } as never,
    })
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('ignores a completion for a session that owns no live pane', () => {
    const store = makeStore()
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'ses_unknown',
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: { type: 'freshAgent.turn.complete', sessionId: 'ses_unknown', at: 1000 },
    })
    expect(handled).toBe(true)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('routes a Claude completion keyed by the runtime handle even when the pane carries a durable sessionRef', () => {
    // A RESTORED Claude/kilroy pane looks like this: the resumed bridge session gets a
    // fresh runtime handle (content.sessionId), while the persisted durable Claude UUID
    // lives in content.sessionRef. The server keys the completion event by the runtime
    // handle it subscribed with, so the lookup must match the runtime handle and not only
    // the sessionRef-preferred key (which would silently drop the chime).
    const localRuntimeId = 'claude-runtime-nanoid'
    const localDurableId = '11111111-2222-4333-8444-555555555555'
    const localClaudeLeaf: PaneNode = {
      type: 'leaf',
      id: 'pane-claude',
      content: {
        kind: 'fresh-agent',
        createRequestId: 'cr-claude',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: localRuntimeId,
        sessionRef: { provider: 'claude', sessionId: localDurableId },
      } as never,
    }
    const store = configureStore({
      reducer: {
        panes: () => ({ layouts: { 'tab-claude': localClaudeLeaf }, activePane: {} }) as never,
        tabs: () => ({ activeTabId: 'tab-claude' }) as never,
        freshAgent: freshAgentReducer,
        turnCompletion: turnCompletionReducer,
      },
    })

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: localRuntimeId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.turn.complete', sessionId: localRuntimeId, at: 1000 },
    })
    expect(handled).toBe(true)

    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabId: 'tab-claude', paneId: 'pane-claude', terminalId: `claude:${localRuntimeId}` })
  })
})

describe('server-authoritative fresh-agent waiting edge (client)', () => {
  it('routes freshAgent.turn.waiting to recordTurnComplete under the #waiting namespace (runtime-handle key)', () => {
    const store = makeClaudeStore()
    const handled = handleFreshAgentMessage(store.dispatch, waitingMessage(1000))
    expect(handled).toBe(true)
    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabId: 'tab-claude', paneId: 'pane-claude', terminalId: `claude:${RUNTIME_ID}#waiting`, at: 1000 })
  })

  it('a waiting edge does NOT suppress a later completion edge (separate dedupe namespace)', () => {
    const store = makeClaudeStore()
    handleFreshAgentMessage(store.dispatch, waitingMessage(5000))
    // A completion with a SMALLER at must still record (different terminalId bucket).
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.turn.complete', sessionId: RUNTIME_ID, at: 1000 },
    })
    const events = store.getState().turnCompletion.pendingEvents
    expect(events.map((e) => e.terminalId).sort())
      .toEqual([`claude:${RUNTIME_ID}`, `claude:${RUNTIME_ID}#waiting`].sort())
  })

  it('drops a malformed waiting edge without a numeric at', () => {
    const store = makeClaudeStore()
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.turn.waiting', sessionId: RUNTIME_ID },
    })
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })
})

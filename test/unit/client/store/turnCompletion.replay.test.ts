import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import reducer, { advanceCompletionBaseline, resetCompletionDedupeBaselines } from '@/store/turnCompletionSlice'
import {
  applyFreshAgentCompletion,
  applyFreshAgentWaiting,
  foldReadyFreshAgentAttention,
  observeFreshAgentSession,
} from '@/store/turnCompletionThunks'
import { turnCompletionReceiptMiddleware } from '@/store/turnCompletionReceipt'
import { ReadyMessageSchema } from '@/lib/ready-message-schema'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import type { AppDispatch } from '@/store/store'

const { focus } = vi.hoisted(() => ({ focus: { watched: false } }))
vi.mock('@/lib/window-focus', () => ({ isWindowFocused: () => focus.watched }))

function createStore() {
  const store = configureStore({
    reducer: {
      turnCompletion: reducer,
      tabs: (state = { activeTabId: 'tab-1' }) => state,
      panes: (state = { layouts: {
        'tab-1': { type: 'leaf', id: 'pane-1', content: {
          kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', sessionId: 'session-1',
        } },
      } }) => state,
      freshAgent: (state = { sessions: {} }) => state,
    },
    middleware: (getDefault) => getDefault().concat(turnCompletionReceiptMiddleware),
  })
  return { store, dispatch: store.dispatch as AppDispatch }
}

const mark = (at?: number, waiting?: number) => [{
  provider: 'claude', sessionId: 'session-1', sessionType: 'freshclaude',
  ...(at === undefined ? {} : { lastTurnCompleteAt: at }),
  ...(waiting === undefined ? {} : { lastWaitingAt: waiting }),
}]

describe('fresh-agent reconnect attention', () => {
  beforeEach(() => { focus.watched = false })

  it('advances baselines without lowering them or queueing an event', () => {
    let state = reducer(undefined, advanceCompletionBaseline({ terminalId: 'claude:session-1', at: 300 }))
    state = reducer(state, advanceCompletionBaseline({ terminalId: 'claude:session-1', at: 200 }))
    expect(state.lastAtByTerminalId['claude:session-1']).toBe(300)
    expect(state.seq).toBe(0)
    expect(state.pendingEvents).toEqual([])
  })

  it('seeds both edge kinds on first observation and replays only newer marks once', () => {
    const { store, dispatch } = createStore()
    dispatch(foldReadyFreshAgentAttention(mark(100, 110)))
    expect(store.getState().turnCompletion.seq).toBe(0)
    dispatch(foldReadyFreshAgentAttention(mark(101, 111)))
    dispatch(foldReadyFreshAgentAttention(mark(101, 111)))
    dispatch(foldReadyFreshAgentAttention(mark(99, 109)))
    expect(store.getState().turnCompletion.pendingEvents).toEqual([
      expect.objectContaining({ terminalId: 'claude:session-1', at: 101, watched: false }),
      expect.objectContaining({ terminalId: 'claude:session-1#waiting', at: 111, watched: false }),
    ])
  })

  it('classifies replay at receipt using the current focus and active tab', () => {
    const { store, dispatch } = createStore()
    dispatch(foldReadyFreshAgentAttention(mark(100)))
    focus.watched = true
    dispatch(foldReadyFreshAgentAttention(mark(101)))
    expect(store.getState().turnCompletion.pendingEvents[0]).toMatchObject({ watched: true })
  })

  it('seeds again after a restart baseline reset, without queueing an old completion', () => {
    const { store, dispatch } = createStore()
    dispatch(foldReadyFreshAgentAttention(mark(500)))
    dispatch(resetCompletionDedupeBaselines())
    dispatch(foldReadyFreshAgentAttention(mark(100)))
    expect(store.getState().turnCompletion.seq).toBe(0)
    dispatch(applyFreshAgentCompletion({ provider: 'claude', sessionId: 'session-1', at: 101 }))
    expect(store.getState().turnCompletion.seq).toBe(1)
  })

  it('observes a newly created session so a missed first completion replays', () => {
    const { store, dispatch } = createStore()
    handleFreshAgentMessage(dispatch, {
      type: 'freshAgent.created', requestId: 'create-1', sessionId: 'session-1',
      sessionType: 'freshclaude', provider: 'claude',
    })
    dispatch(foldReadyFreshAgentAttention(mark(100)))
    expect(store.getState().turnCompletion.seq).toBe(1)
  })

  it('observes an attached session without suppressing its first live completion', () => {
    const { store, dispatch } = createStore()
    handleFreshAgentMessage(dispatch, {
      type: 'freshAgent.event', sessionId: 'session-1', sessionType: 'freshclaude', provider: 'claude',
      event: { type: 'freshAgent.session.snapshot', status: 'idle' },
    })
    expect(store.getState().turnCompletion.lastAtByTerminalId['claude:session-1']).toBe(0)
    dispatch(applyFreshAgentCompletion({ provider: 'claude', sessionId: 'session-1', at: 100 }))
    expect(store.getState().turnCompletion.seq).toBe(1)
  })

  it('does not lower an observed session baseline', () => {
    const { store, dispatch } = createStore()
    dispatch(foldReadyFreshAgentAttention(mark(100, 200)))
    dispatch(observeFreshAgentSession({ provider: 'claude', sessionId: 'session-1' }))
    expect(store.getState().turnCompletion.lastAtByTerminalId).toEqual({
      'claude:session-1': 100, 'claude:session-1#waiting': 200,
    })
  })

  it('observes both edge kinds when a live edge first reveals a session', () => {
    const { store, dispatch } = createStore()
    dispatch(applyFreshAgentCompletion({ provider: 'claude', sessionId: 'session-1', at: 100 }))
    dispatch(foldReadyFreshAgentAttention(mark(100, 110)))
    expect(store.getState().turnCompletion.seq).toBe(2)
    expect(store.getState().turnCompletion.pendingEvents[1]).toMatchObject({ terminalId: 'claude:session-1#waiting', at: 110 })
  })

  it('records live edges without a local pane, preventing later replay', () => {
    const { store, dispatch } = createStore()
    const payload = { provider: 'claude', sessionId: 'remote-only', at: 100 }
    dispatch(applyFreshAgentCompletion(payload))
    dispatch(applyFreshAgentWaiting({ ...payload, at: 110 }))
    dispatch(foldReadyFreshAgentAttention([{ ...mark(100, 110)[0], sessionId: 'remote-only' }]))
    expect(store.getState().turnCompletion.seq).toBe(0)
    expect(store.getState().turnCompletion.lastAtByTerminalId).toEqual({
      'claude:remote-only': 100, 'claude:remote-only#waiting': 110,
    })
  })

  it('keeps a malformed replay from disabling the ready restart identity', () => {
    const valid = { type: 'ready', timestamp: 'now', bootId: 'boot-1', serverInstanceId: 'server-1' }
    const parsed = ReadyMessageSchema.parse({ ...valid, freshAgentAttention: mark(Number.NaN) })
    expect(parsed.bootId).toBe('boot-1')
    expect(parsed.freshAgentAttention).toBeUndefined()
    const { store, dispatch } = createStore()
    dispatch(foldReadyFreshAgentAttention(parsed.freshAgentAttention))
    expect(store.getState().turnCompletion.seq).toBe(0)
    expect(ReadyMessageSchema.parse({ ...valid, freshAgentAttention: mark(100) }).freshAgentAttention).toEqual(mark(100))
  })
})

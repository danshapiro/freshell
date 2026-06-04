import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { setSessionStatus, addPermissionRequest } from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { useAgentSessionTurnCompletion } from '@/hooks/useAgentSessionTurnCompletion'
import type { PaneNode } from '@/store/paneTypes'

const TAB = 'T'
const PANE = 'P'

const freshClaudeLeaf: PaneNode = {
  type: 'leaf',
  id: PANE,
  content: {
    kind: 'fresh-agent',
    createRequestId: 'cr',
    sessionType: 'freshclaude',
    provider: 'claude',
    sessionId: 'abc',
    sessionRef: { provider: 'claude', sessionId: 'abc' },
  } as never,
}

const panesState = { layouts: { [TAB]: freshClaudeLeaf }, activePane: {} }

function makeStore() {
  return configureStore({
    reducer: {
      panes: () => panesState as never,
      freshAgent: freshAgentReducer,
      agentChat: agentChatReducer,
      turnCompletion: turnCompletionReducer,
    },
  })
}

function render(store: ReturnType<typeof makeStore>) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(Provider, { store }, children)
  return renderHook(() => useAgentSessionTurnCompletion(), { wrapper })
}

const claudeRunning = { sessionId: 'abc', sessionType: 'freshclaude' as const, provider: 'claude' as const }

describe('useAgentSessionTurnCompletion', () => {
  it('fires green+attention once on a fresh-agent running -> idle transition', () => {
    const store = makeStore()
    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'running' })) })
    render(store)
    // first observation (running) does not fire
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)

    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'idle' })) })

    // The hook dispatches recordTurnComplete (-> pendingEvents); attention marking
    // is done downstream by useTurnCompletionNotifications.
    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabId: TAB, paneId: PANE, terminalId: 'claude:abc' })
  })

  it('does NOT fire when the session is already idle on first observation (restore/hydration)', () => {
    const store = makeStore()
    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'idle' })) })
    render(store)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
    // a subsequent unrelated idle re-set still does not fire
    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'idle' })) })
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
  })

  it('fires waiting-for-approval green+attention on a 0 -> >=1 pending permission transition', () => {
    const store = makeStore()
    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'running' })) })
    render(store)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)

    act(() => {
      store.dispatch(addPermissionRequest({ ...claudeRunning, requestId: 'perm1' } as never))
    })

    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabId: TAB, paneId: PANE, terminalId: 'claude:abc' })
  })
})

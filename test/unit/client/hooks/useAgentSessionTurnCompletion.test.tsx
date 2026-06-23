import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { setSessionStatus, addPermissionRequest } from '@/store/freshAgentSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { applyFreshAgentCompletion } from '@/store/turnCompletionThunks'
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
  it('does NOT fire on a busy -> idle transition (turn completion is server-authoritative)', () => {
    // Turn completion green/sound now flows from the server-authoritative
    // freshAgent.turn.complete edge (applyFreshAgentCompletion), not from
    // differentiating the client-side busy level. The hook must not re-derive it.
    const store = makeStore()
    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'running' })) })
    render(store)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)

    act(() => { store.dispatch(setSessionStatus({ ...claudeRunning, status: 'idle' })) })

    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
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
    // The waiting-for-approval edge dedupes under a distinct namespace (`#waiting`) so it
    // cannot poison the server turn-complete entry (`claude:abc`).
    expect(events[0]).toMatchObject({ tabId: TAB, paneId: PANE, terminalId: 'claude:abc#waiting' })
  })

  it('does not let a waiting-for-approval green swallow a later server completion', () => {
    // For opencode/codex the pane session key equals the server completion key, so if the
    // approval edge (CLIENT clock) and the server completion (SERVER clock) shared one
    // monotonic dedupe entry, an approval stamped ahead of the server clock (common on a
    // remote client) would suppress the real turn-complete. They must dedupe independently.
    const SES = 'ses_op_1'
    const opencodeLeaf: PaneNode = {
      type: 'leaf',
      id: 'pane-op',
      content: {
        kind: 'fresh-agent',
        createRequestId: 'cr-op',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId: SES,
        sessionRef: { provider: 'opencode', sessionId: SES },
      } as never,
    }
    const store = configureStore({
      reducer: {
        panes: () => ({ layouts: { 'tab-op': opencodeLeaf }, activePane: {} }) as never,
        tabs: () => ({ activeTabId: 'tab-op' }) as never,
        freshAgent: freshAgentReducer,
        turnCompletion: turnCompletionReducer,
      },
    })
    const opencodeRunning = { sessionId: SES, sessionType: 'freshopencode' as const, provider: 'opencode' as const }
    act(() => { store.dispatch(setSessionStatus({ ...opencodeRunning, status: 'running' })) })
    render(store as never)

    // Permission prompt → waiting-for-approval green (stamped with the large client clock).
    act(() => { store.dispatch(addPermissionRequest({ ...opencodeRunning, requestId: 'perm-op' } as never)) })
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(1)

    // The real server completion arrives with a much smaller (server-clock) `at`.
    act(() => { store.dispatch(applyFreshAgentCompletion({ provider: 'opencode', sessionId: SES, at: 1000 })) })

    const events = store.getState().turnCompletion.pendingEvents
    expect(events).toHaveLength(2)
    expect(events.some((e) => e.terminalId === `opencode:${SES}`)).toBe(true)
  })
})

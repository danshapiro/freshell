import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import turnCompletionReducer, { markTabAttention, markPaneAttention } from '@/store/turnCompletionSlice'
import { dismissTabGreen, selectPaneBySessionKey } from '@/store/turnCompletionAttention'
import type { RootState } from '@/store/store'
import type { PaneNode } from '@/store/paneTypes'

describe('dismissTabGreen', () => {
  const splitLayout: PaneNode = {
    type: 'split',
    id: 'split',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'shell' } },
      { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'c2', status: 'running', mode: 'shell' } },
    ],
  }

  function makeStore() {
    return configureStore({
      reducer: {
        panes: () => ({ layouts: { T: splitLayout }, activePane: {} } as never),
        turnCompletion: turnCompletionReducer,
      },
    })
  }

  it('clears the tab and EVERY pane with attention (not just the active pane)', () => {
    const store = makeStore()
    store.dispatch(markTabAttention({ tabId: 'T' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-1' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-2' }))

    store.dispatch(dismissTabGreen('T') as never)

    expect(store.getState().turnCompletion.attentionByTab['T']).toBeUndefined()
    expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
  })

  it('is a no-op when the tab has no attention', () => {
    const store = makeStore()
    store.dispatch(markPaneAttention({ paneId: 'pane-9' }))
    store.dispatch(dismissTabGreen('T') as never)
    // unrelated pane attention untouched (tab had no flag -> early return)
    expect(store.getState().turnCompletion.attentionByPane['pane-9']).toBe(true)
  })
})

function stateWithLayout(layout: PaneNode): RootState {
  return {
    panes: { layouts: { T: layout } },
    freshAgent: { sessions: {} },
    agentChat: { sessions: {} },
  } as unknown as RootState
}

describe('selectPaneBySessionKey', () => {
  it('maps a fresh-agent sessionKey (provider:sessionId) to its tab+pane', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'P',
      content: {
        kind: 'fresh-agent',
        createRequestId: 'cr',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: 'abc',
        sessionRef: { provider: 'claude', sessionId: 'abc' },
      } as never,
    }
    expect(selectPaneBySessionKey(stateWithLayout(layout), 'claude:abc')).toEqual({ tabId: 'T', paneId: 'P' })
  })

  it('maps an agent-chat sessionKey to its tab+pane', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'P',
      content: {
        kind: 'agent-chat',
        createRequestId: 'cr',
        provider: 'claude',
        sessionId: 'xyz',
        sessionRef: { provider: 'claude', sessionId: 'xyz' },
      } as never,
    }
    expect(selectPaneBySessionKey(stateWithLayout(layout), 'claude:xyz')).toEqual({ tabId: 'T', paneId: 'P' })
  })

  it('returns null when no pane owns the sessionKey', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'P',
      content: {
        kind: 'fresh-agent',
        createRequestId: 'cr',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: 'abc',
        sessionRef: { provider: 'claude', sessionId: 'abc' },
      } as never,
    }
    expect(selectPaneBySessionKey(stateWithLayout(layout), 'claude:other')).toBeNull()
  })

  it('finds the matching pane within a split layout', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'A', content: { kind: 'terminal', createRequestId: 'c0', status: 'running', mode: 'shell' } as never },
        {
          type: 'leaf',
          id: 'B',
          content: {
            kind: 'fresh-agent',
            createRequestId: 'cr',
            sessionType: 'freshcodex',
            provider: 'codex',
            sessionId: 's2',
            sessionRef: { provider: 'codex', sessionId: 's2' },
          } as never,
        },
      ],
    }
    expect(selectPaneBySessionKey(stateWithLayout(layout), 'codex:s2')).toEqual({ tabId: 'T', paneId: 'B' })
  })
})

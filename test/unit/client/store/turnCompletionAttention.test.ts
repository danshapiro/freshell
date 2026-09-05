import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import turnCompletionReducer, { markTabAttention, markPaneAttention } from '@/store/turnCompletionSlice'
import { dismissTabGreen, revokeFreshAgentAttention, selectPaneBySessionKey } from '@/store/turnCompletionAttention'
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

  it('maps a fresh-agent sessionKey through live session state when no explicit sessionRef exists', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'P',
      content: {
        kind: 'fresh-agent',
        createRequestId: 'cr',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: 'sdk-xyz',
      } as never,
    }
    const state = {
      panes: { layouts: { T: layout } },
      freshAgent: {
        sessions: {
          'freshclaude:claude:sdk-xyz': {
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: 'xyz',
            sessionKey: 'freshclaude:claude:sdk-xyz',
            threadId: 'xyz',
            status: 'idle',
            turns: [],
            historyItems: [],
            historyBodies: {},
            streamingText: '',
            streamingActive: false,
            pendingPermissions: {},
            pendingQuestions: {},
            totalCostUsd: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
          },
        },
      },
    } as unknown as RootState
    expect(selectPaneBySessionKey(state, 'claude:xyz')).toEqual({ tabId: 'T', paneId: 'P' })
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

// kata 1wxv decision 10 (r3 correction 7): a rollback revokes ONLY the undone
// pane's attention, then re-derives the tab flag as the OR over the tab's
// REMAINING panes — never a blanket tab dismiss while a sibling stays green.
describe('revokeFreshAgentAttention', () => {
  const ownerContent = {
    kind: 'fresh-agent',
    createRequestId: 'cr-owner',
    sessionType: 'freshopencode',
    provider: 'opencode',
    sessionId: 'ses_1',
    sessionRef: { provider: 'opencode', sessionId: 'ses_1' },
    status: 'idle',
  }
  const siblingTerminal = { kind: 'terminal', createRequestId: 'c-sib', status: 'running', mode: 'shell' }
  const strangerTerminal = { kind: 'terminal', createRequestId: 'c-stranger', status: 'running', mode: 'shell' }

  const splitLayout: PaneNode = {
    type: 'split',
    id: 'split',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      { type: 'leaf', id: 'owner-pane', content: ownerContent as never },
      { type: 'leaf', id: 'sibling-pane', content: siblingTerminal as never },
    ],
  }

  function makeStore(layouts: Record<string, PaneNode>) {
    return configureStore({
      reducer: {
        panes: () => ({ layouts, activePane: {} } as never),
        freshAgent: () => ({ sessions: {} } as never),
        turnCompletion: turnCompletionReducer,
      },
    })
  }

  it('is PANE-SCOPED: sibling attention survives and tab green stays derived from it', () => {
    const store = makeStore({
      T: splitLayout,
      OTHER: { type: 'leaf', id: 'stranger-pane', content: strangerTerminal as never },
    })
    store.dispatch(markTabAttention({ tabId: 'T' }))
    store.dispatch(markPaneAttention({ paneId: 'owner-pane' }))
    store.dispatch(markPaneAttention({ paneId: 'sibling-pane' }))
    store.dispatch(markTabAttention({ tabId: 'OTHER' }))

    store.dispatch(revokeFreshAgentAttention('opencode:ses_1') as never)

    const tc = store.getState().turnCompletion
    // The OWNER pane's attention entry is cleared…
    expect(tc.attentionByPane['owner-pane']).toBeUndefined()
    // …the SIBLING pane's attention SURVIVES (rollback revokes only the undone
    // turn's attention, never unrelated completions in the same tab)…
    expect(tc.attentionByPane['sibling-pane']).toBe(true)
    // …TAB-level green is the OR over remaining panes: STILL SET from the sibling…
    expect(tc.attentionByTab['T']).toBe(true)
    // …and the unrelated tab is untouched.
    expect(tc.attentionByTab['OTHER']).toBe(true)
  })

  it('clears the tab flag for a single-pane tab whose only attention holder was rolled back', () => {
    const store = makeStore({
      SOLO: { type: 'leaf', id: 'owner-pane', content: ownerContent as never },
    })
    store.dispatch(markTabAttention({ tabId: 'SOLO' }))
    store.dispatch(markPaneAttention({ paneId: 'owner-pane' }))

    store.dispatch(revokeFreshAgentAttention('opencode:ses_1') as never)

    const tc = store.getState().turnCompletion
    expect(tc.attentionByPane['owner-pane']).toBeUndefined()
    expect(tc.attentionByTab['SOLO']).toBeUndefined()
  })

  it('is a no-op when no pane owns the session key', () => {
    const store = makeStore({ T: splitLayout })
    store.dispatch(markTabAttention({ tabId: 'T' }))
    store.dispatch(markPaneAttention({ paneId: 'sibling-pane' }))

    store.dispatch(revokeFreshAgentAttention('opencode:ses_unknown') as never)

    const tc = store.getState().turnCompletion
    expect(tc.attentionByPane['sibling-pane']).toBe(true)
    expect(tc.attentionByTab['T']).toBe(true)
  })
})

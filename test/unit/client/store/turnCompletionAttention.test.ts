import { describe, it, expect } from 'vitest'
import { selectPaneBySessionKey } from '@/store/turnCompletionAttention'
import type { RootState } from '@/store/store'
import type { PaneNode } from '@/store/paneTypes'

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

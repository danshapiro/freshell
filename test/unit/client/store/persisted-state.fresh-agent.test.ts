import { describe, expect, it } from 'vitest'

import { parsePersistedPanesRaw } from '@/store/persistedState'

function findLeafContent(node: any): any {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'leaf') return node.content
  if (node.type === 'split' && Array.isArray(node.children)) {
    return findLeafContent(node.children[0]) ?? findLeafContent(node.children[1])
  }
  return undefined
}

describe('persistedState fresh-agent migration', () => {
  it('migrates persisted agent-chat panes to fresh-agent panes', () => {
    const parsed = parsePersistedPanesRaw(JSON.stringify({
      version: 6,
      layouts: {
        tab_1: {
          type: 'leaf',
          id: 'pane_1',
          content: { kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-1', status: 'idle' },
        },
      },
    }))

    expect(findLeafContent(parsed!.layouts.tab_1)).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
    })
  })
})

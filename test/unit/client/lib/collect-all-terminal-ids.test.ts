import { describe, it, expect } from 'vitest'
import { collectAllTerminalIds } from '@/lib/pane-utils'
import type { PaneNode } from '@/store/paneTypes'

function terminalLeaf(paneId: string, terminalId?: string): PaneNode {
  return {
    type: 'leaf',
    id: paneId,
    content: {
      kind: 'terminal',
      mode: 'shell',
      status: 'running',
      createRequestId: `req-${paneId}`,
      ...(terminalId ? { terminalId } : {}),
    },
  }
}

describe('collectAllTerminalIds', () => {
  it('returns an empty set for no layouts', () => {
    expect(collectAllTerminalIds({})).toEqual(new Set())
  })

  it('collects ids across multiple tab layouts', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': terminalLeaf('pane-1', 'term-a'),
      'tab-2': terminalLeaf('pane-2', 'term-b'),
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-a', 'term-b']))
  })

  it('walks split trees', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [terminalLeaf('pane-1', 'term-a'), terminalLeaf('pane-2', 'term-b')],
      },
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-a', 'term-b']))
  })

  it('dedupes a terminal referenced by two layouts', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': terminalLeaf('pane-1', 'term-dup'),
      'tab-2': terminalLeaf('pane-2', 'term-dup'),
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-dup']))
  })

  it('ignores undefined layouts, non-terminal panes, and terminals without ids', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': undefined,
      'tab-2': { type: 'leaf', id: 'pane-x', content: { kind: 'picker' } },
      'tab-3': terminalLeaf('pane-y'), // no terminalId yet (creating)
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set())
  })
})

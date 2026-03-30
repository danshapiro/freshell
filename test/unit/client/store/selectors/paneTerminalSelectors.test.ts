// Tests for pane-tree terminal ID selectors that replace Tab.terminalId reads.

import { describe, it, expect } from 'vitest'
import type { PaneNode } from '@/store/paneTypes'
import {
  selectTerminalIdsForTab,
  selectPrimaryTerminalIdForTab,
  selectTabIdByTerminalId,
} from '@/store/selectors/paneTerminalSelectors'

function makeLeaf(id: string, terminalId?: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      terminalId,
      createRequestId: `req-${id}`,
      status: 'running',
      mode: 'shell',
    },
  }
}

function makeBrowserLeaf(id: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'browser',
      browserInstanceId: `bi-${id}`,
      url: 'https://example.com',
      devToolsOpen: false,
    },
  }
}

function makeSplit(left: PaneNode, right: PaneNode): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [left, right],
    sizes: [50, 50],
  }
}

function makeState(overrides: {
  layouts?: Record<string, PaneNode>
  activePane?: Record<string, string>
}) {
  return {
    panes: {
      layouts: overrides.layouts ?? {},
      activePane: overrides.activePane ?? {},
      paneTitles: {},
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      refreshRequestsByPane: {},
    },
  } as any
}

describe('selectTerminalIdsForTab', () => {
  it('returns empty array when no layout exists', () => {
    const state = makeState({})
    expect(selectTerminalIdsForTab(state, 'tab-1')).toEqual([])
  })

  it('returns single terminal ID from a leaf', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1', 'term-abc') },
    })
    expect(selectTerminalIdsForTab(state, 'tab-1')).toEqual(['term-abc'])
  })

  it('skips leaves without terminal IDs', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1') },
    })
    expect(selectTerminalIdsForTab(state, 'tab-1')).toEqual([])
  })

  it('collects terminal IDs from split layout', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeSplit(
          makeLeaf('pane-1', 'term-a'),
          makeLeaf('pane-2', 'term-b'),
        ),
      },
    })
    expect(selectTerminalIdsForTab(state, 'tab-1')).toEqual(['term-a', 'term-b'])
  })

  it('ignores non-terminal panes in split', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeSplit(
          makeLeaf('pane-1', 'term-a'),
          makeBrowserLeaf('pane-2'),
        ),
      },
    })
    expect(selectTerminalIdsForTab(state, 'tab-1')).toEqual(['term-a'])
  })
})

describe('selectPrimaryTerminalIdForTab', () => {
  it('returns undefined when no layout exists', () => {
    const state = makeState({})
    expect(selectPrimaryTerminalIdForTab(state, 'tab-1')).toBeUndefined()
  })

  it('returns the active pane terminal ID when available', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeSplit(
          makeLeaf('pane-1', 'term-a'),
          makeLeaf('pane-2', 'term-b'),
        ),
      },
      activePane: { 'tab-1': 'pane-2' },
    })
    expect(selectPrimaryTerminalIdForTab(state, 'tab-1')).toBe('term-b')
  })

  it('falls back to first leaf when active pane has no terminal ID', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeSplit(
          makeLeaf('pane-1', 'term-a'),
          makeBrowserLeaf('pane-2'),
        ),
      },
      activePane: { 'tab-1': 'pane-2' },
    })
    expect(selectPrimaryTerminalIdForTab(state, 'tab-1')).toBe('term-a')
  })

  it('falls back to first leaf when no active pane is set', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1', 'term-a') },
    })
    expect(selectPrimaryTerminalIdForTab(state, 'tab-1')).toBe('term-a')
  })

  it('returns undefined when leaf has no terminal ID', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1') },
    })
    expect(selectPrimaryTerminalIdForTab(state, 'tab-1')).toBeUndefined()
  })
})

describe('selectTabIdByTerminalId', () => {
  it('returns undefined when no tabs have layouts', () => {
    const state = makeState({})
    expect(selectTabIdByTerminalId(state, 'term-a')).toBeUndefined()
  })

  it('finds tab ID for a terminal in a leaf', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1', 'term-a') },
    })
    expect(selectTabIdByTerminalId(state, 'term-a')).toBe('tab-1')
  })

  it('finds tab ID for a terminal in a split', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeSplit(
          makeBrowserLeaf('pane-1'),
          makeLeaf('pane-2', 'term-b'),
        ),
      },
    })
    expect(selectTabIdByTerminalId(state, 'term-b')).toBe('tab-1')
  })

  it('returns the correct tab when multiple tabs exist', () => {
    const state = makeState({
      layouts: {
        'tab-1': makeLeaf('pane-1', 'term-a'),
        'tab-2': makeLeaf('pane-2', 'term-b'),
      },
    })
    expect(selectTabIdByTerminalId(state, 'term-b')).toBe('tab-2')
  })

  it('returns undefined for unknown terminal ID', () => {
    const state = makeState({
      layouts: { 'tab-1': makeLeaf('pane-1', 'term-a') },
    })
    expect(selectTabIdByTerminalId(state, 'term-unknown')).toBeUndefined()
  })
})

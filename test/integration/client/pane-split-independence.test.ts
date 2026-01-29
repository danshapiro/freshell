import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout, splitPane } from '@/store/panesSlice'
import type { PaneContent, PaneNode } from '@/store/paneTypes'

/**
 * ACCEPTANCE TEST: Split panes create independent terminals.
 *
 * This test verifies the core fix for the mirroring bug:
 * When user splits a pane via FAB, each pane should have its own
 * unique createRequestId, resulting in independent backend terminals.
 */
describe('Pane Split Independence', () => {
  function getAllTerminalIds(node: PaneNode): string[] {
    if (node.type === 'leaf') {
      if (node.content.kind === 'terminal' && node.content.createRequestId) {
        return [node.content.createRequestId]
      }
      return []
    }
    return [
      ...getAllTerminalIds(node.children[0]),
      ...getAllTerminalIds(node.children[1]),
    ]
  }

  it('split panes have unique createRequestIds', () => {
    const store = configureStore({ reducer: { panes: panesReducer } })

    // User creates a tab (initLayout called)
    store.dispatch(initLayout({
      tabId: 'tab1',
      content: { kind: 'terminal', mode: 'shell' },
    }))

    const layout1 = store.getState().panes.layouts['tab1'] as { type: 'leaf'; id: string; content: PaneContent }
    const firstRequestId = layout1.content.kind === 'terminal' ? layout1.content.createRequestId : ''

    // User clicks FAB to split
    store.dispatch(splitPane({
      tabId: 'tab1',
      paneId: layout1.id,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
    }))

    const layout2 = store.getState().panes.layouts['tab1']
    const allRequestIds = getAllTerminalIds(layout2)

    // CRITICAL: Both panes have different createRequestIds
    expect(allRequestIds).toHaveLength(2)
    expect(allRequestIds[0]).not.toBe(allRequestIds[1])
    expect(allRequestIds).toContain(firstRequestId) // Original preserved
  })

  it('multiple splits all have unique createRequestIds', () => {
    const store = configureStore({ reducer: { panes: panesReducer } })

    store.dispatch(initLayout({
      tabId: 'tab1',
      content: { kind: 'terminal', mode: 'shell' },
    }))

    const layout1 = store.getState().panes.layouts['tab1'] as { type: 'leaf'; id: string }

    // First split
    store.dispatch(splitPane({
      tabId: 'tab1',
      paneId: layout1.id,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'shell' },
    }))

    // Get the new pane's ID
    const layout2 = store.getState().panes.layouts['tab1'] as { type: 'split'; children: [any, any] }
    const secondPaneId = layout2.children[1].id

    // Second split on the new pane
    store.dispatch(splitPane({
      tabId: 'tab1',
      paneId: secondPaneId,
      direction: 'vertical',
      newContent: { kind: 'terminal', mode: 'claude' },
    }))

    const layout3 = store.getState().panes.layouts['tab1']
    const allRequestIds = getAllTerminalIds(layout3)

    // All 3 panes have unique createRequestIds
    expect(allRequestIds).toHaveLength(3)
    const uniqueIds = new Set(allRequestIds)
    expect(uniqueIds.size).toBe(3)
  })
})

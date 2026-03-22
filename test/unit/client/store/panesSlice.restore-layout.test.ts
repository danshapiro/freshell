import { describe, it, expect } from 'vitest'
import panesReducer, { restoreLayout } from '@/store/panesSlice'
import type { PaneNode, PanesState } from '@/store/paneTypes'

function emptySt(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSources: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
  }
}

describe('restoreLayout', () => {
  it('injects a single-leaf layout with normalized content', () => {
    const layout: PaneNode = {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'terminal',
        terminalId: 'stale-term-id',
        createRequestId: 'stale-crq',
        status: 'running',
        mode: 'shell',
        shell: 'system',
      },
    }

    const state = panesReducer(emptySt(), restoreLayout({
      tabId: 'tab-1',
      layout,
      paneTitles: { p1: 'My Shell' },
      paneTitleSources: { p1: 'stable' },
    }))

    expect(state.layouts['tab-1']).toBeDefined()
    const restored = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(restored.type).toBe('leaf')
    // terminalId should be cleared (new terminal will be created)
    expect(restored.content.kind).toBe('terminal')
    if (restored.content.kind === 'terminal') {
      expect(restored.content.terminalId).toBeUndefined()
      expect(restored.content.status).toBe('creating')
      expect(restored.content.createRequestId).not.toBe('stale-crq')
    }
    expect(state.paneTitles['tab-1']?.p1).toBe('My Shell')
    expect(state.paneTitleSources['tab-1']?.p1).toBe('stable')
    expect(state.activePane['tab-1']).toBe('p1')
  })

  it('injects a split layout and sets activePane to first leaf', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'p1',
          content: {
            kind: 'terminal',
            terminalId: 'old-1',
            createRequestId: 'old-crq-1',
            status: 'running',
            mode: 'shell',
          },
        },
        {
          type: 'leaf',
          id: 'p2',
          content: {
            kind: 'browser',
            browserInstanceId: 'old-browser',
            url: 'https://example.com',
            devToolsOpen: false,
          },
        },
      ],
    }

    const state = panesReducer(emptySt(), restoreLayout({
      tabId: 'tab-2',
      layout,
      paneTitles: { p1: 'Shell', p2: 'Browser' },
      paneTitleSources: { p1: 'derived', p2: 'derived' },
    }))

    const root = state.layouts['tab-2']!
    expect(root.type).toBe('split')
    if (root.type === 'split') {
      const left = root.children[0]
      expect(left.type).toBe('leaf')
      if (left.type === 'leaf' && left.content.kind === 'terminal') {
        expect(left.content.terminalId).toBeUndefined()
        expect(left.content.status).toBe('creating')
      }
      const right = root.children[1]
      if (right.type === 'leaf' && right.content.kind === 'browser') {
        expect(right.content.browserInstanceId).not.toBe('old-browser')
      }
    }
    expect(state.activePane['tab-2']).toBe('p1')
  })

  it('does not overwrite an existing layout', () => {
    const existing: PaneNode = {
      type: 'leaf',
      id: 'existing-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'keep-me',
        status: 'running',
        mode: 'shell',
      },
    }
    const initial = emptySt()
    initial.layouts['tab-1'] = existing
    initial.activePane['tab-1'] = 'existing-pane'

    const newLayout: PaneNode = {
      type: 'leaf',
      id: 'new-pane',
      content: {
        kind: 'terminal',
        createRequestId: 'new-crq',
        status: 'creating',
        mode: 'shell',
      },
    }

    const state = panesReducer(initial, restoreLayout({
      tabId: 'tab-1',
      layout: newLayout,
      paneTitles: {},
      paneTitleSources: {},
    }))

    // Should not overwrite — existing layout preserved
    expect(state.layouts['tab-1'].type).toBe('leaf')
    if (state.layouts['tab-1'].type === 'leaf') {
      expect(state.layouts['tab-1'].id).toBe('existing-pane')
    }
  })
})

import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import panesReducer, {
  hydratePanes,
  initLayout,
  mergePaneContent,
  removeLayout,
  replacePane,
  restoreLayout,
  swapPanes,
  updatePaneContent,
} from '@/store/panesSlice'
import paneRuntimeTitleReducer, {
  clearPaneRuntimeTitle,
  clearPaneRuntimeTitleByTerminalId,
  setPaneRuntimeTitle,
  setPaneRuntimeTitleByTerminalId,
} from '@/store/paneRuntimeTitleSlice'

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      paneRuntimeTitle: paneRuntimeTitleReducer,
    },
  })
}

describe('paneRuntimeTitleSlice', () => {
  it('stores normalized runtime titles by pane id and clears them directly', () => {
    const store = createStore()

    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: '⠋ codex' }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({ 'pane-1': 'codex' })

    store.dispatch(clearPaneRuntimeTitle({ paneId: 'pane-1' }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})
  })

  it('updates and clears runtime titles by terminal id', () => {
    const store = createStore()

    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: 'term-1',
      },
    }))

    store.dispatch(setPaneRuntimeTitleByTerminalId({ terminalId: 'term-1', title: 'vim README.md' }) as any)
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({ 'pane-1': 'vim README.md' })

    store.dispatch(clearPaneRuntimeTitleByTerminalId({ terminalId: 'term-1' }) as any)
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})
  })

  it('clears runtime titles on content replacement, terminal rebinding, hydrate, and layout removal', () => {
    const store = createStore()

    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: 'term-1',
      },
    }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: 'vim README.md' }))

    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: 'term-1',
        resumeSessionId: 'session-1',
      },
      clearRuntimeTitle: false,
    }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({ 'pane-1': 'vim README.md' })

    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: 'term-2',
      },
    }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})

    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: 'htop' }))
    store.dispatch(mergePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      updates: { status: 'exited' },
    }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})

    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: 'python' }))
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})

    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: 'node server.js' }))
    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'shell',
            status: 'running',
            createRequestId: 'req-1',
            terminalId: 'term-1',
          },
        } as any,
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
      paneTitleSources: { 'tab-1': { 'pane-1': 'derived' } },
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      refreshRequestsByPane: {},
    }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})

    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-1', title: 'bash' }))
    store.dispatch(removeLayout({ tabId: 'tab-1', paneIds: ['pane-1'] }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})
  })

  it('keeps unrelated runtime titles when removing one tab layout', () => {
    const store = createStore()

    store.dispatch(initLayout({
      tabId: 'tab-a',
      paneId: 'pane-a',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-a',
        terminalId: 'term-a',
      },
    }))
    store.dispatch(initLayout({
      tabId: 'tab-b',
      paneId: 'pane-b',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-b',
        terminalId: 'term-b',
      },
    }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-a', title: 'vim a.ts' }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-b', title: 'htop' }))

    store.dispatch(removeLayout({ tabId: 'tab-b', paneIds: ['pane-b'] }))

    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({
      'pane-a': 'vim a.ts',
    })
  })

  it('keeps unrelated runtime titles when restoring one tab layout', () => {
    const store = createStore()

    store.dispatch(initLayout({
      tabId: 'tab-a',
      paneId: 'pane-a',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        createRequestId: 'req-a',
        terminalId: 'term-a',
      },
    }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-a', title: 'vim a.ts' }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-b', title: 'stale runtime title' }))

    store.dispatch(restoreLayout({
      tabId: 'tab-b',
      layout: {
        type: 'leaf',
        id: 'pane-b',
        content: {
          kind: 'terminal',
          mode: 'shell',
          status: 'running',
          createRequestId: 'req-b',
          terminalId: 'term-b',
        },
      },
      paneTitles: { 'pane-b': 'Shell' },
      paneTitleSources: { 'pane-b': 'derived' },
    }))

    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({
      'pane-a': 'vim a.ts',
    })
  })

  it('clears swapped pane runtime titles so pane ids do not keep stale labels', () => {
    const store = createStore()

    store.dispatch(hydratePanes({
      layouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-a',
              content: {
                kind: 'terminal',
                mode: 'shell',
                status: 'running',
                createRequestId: 'req-a',
                terminalId: 'term-a',
              },
            },
            {
              type: 'leaf',
              id: 'pane-b',
              content: {
                kind: 'terminal',
                mode: 'shell',
                status: 'running',
                createRequestId: 'req-b',
                terminalId: 'term-b',
              },
            },
          ],
        } as any,
      },
      activePane: { 'tab-1': 'pane-a' },
      paneTitles: { 'tab-1': { 'pane-a': 'Shell', 'pane-b': 'Shell' } },
      paneTitleSources: { 'tab-1': { 'pane-a': 'derived', 'pane-b': 'derived' } },
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      refreshRequestsByPane: {},
    }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-a', title: 'vim a.ts' }))
    store.dispatch(setPaneRuntimeTitle({ paneId: 'pane-b', title: 'htop' }))

    store.dispatch(swapPanes({ tabId: 'tab-1', paneId: 'pane-a', otherId: 'pane-b' }))

    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})
  })
})

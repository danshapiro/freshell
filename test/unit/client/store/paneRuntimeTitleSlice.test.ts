import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import panesReducer, {
  hydratePanes,
  initLayout,
  mergePaneContent,
  removeLayout,
  replacePane,
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
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId).toEqual({})
  })
})

import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { addPane, closePane } from '@/store/panesSlice'
import { tabFallbackIdentityMiddleware } from '@/store/tabFallbackIdentityMiddleware'
import tabsReducer from '@/store/tabsSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

describe('tabFallbackIdentityMiddleware', () => {
  const originalSessionRef = {
    provider: 'claude' as const,
    sessionId: '00000000-0000-4000-8000-000000000501',
  }

  const replacementSessionRef = {
    provider: 'claude' as const,
    sessionId: '00000000-0000-4000-8000-000000000502',
  }

  function makeStore() {
    const originalPane: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-original',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      sessionRef: originalSessionRef,
    }

    return configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(tabFallbackIdentityMiddleware),
      preloadedState: {
        tabs: {
          tabs: [{
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Claude Tab',
            mode: 'claude',
            status: 'running',
            shell: 'system',
            createdAt: 1,
            sessionRef: originalSessionRef,
            resumeSessionId: originalSessionRef.sessionId,
          }],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
          tombstones: [],
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: originalPane,
            } satisfies PaneNode,
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
          paneTitleSetByUser: {},
          refreshRequestsByPane: {},
          zoomedPane: {},
        },
      },
    })
  }

  it('clears stale shared tab identity when a single-pane tab becomes split', () => {
    const store = makeStore()

    store.dispatch(addPane({
      tabId: 'tab-1',
      newContent: {
        kind: 'terminal',
        createRequestId: 'req-replacement',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        sessionRef: replacementSessionRef,
      },
    }))

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.sessionRef).toBeUndefined()
    expect(tab?.resumeSessionId).toBeUndefined()
  })

  it('re-promotes the remaining leaf identity when a split tab collapses back to one pane', () => {
    const store = makeStore()

    store.dispatch(addPane({
      tabId: 'tab-1',
      newContent: {
        kind: 'terminal',
        createRequestId: 'req-replacement',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        sessionRef: replacementSessionRef,
      },
    }))

    store.dispatch(closePane({
      tabId: 'tab-1',
      paneId: 'pane-1',
    }))

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 'tab-1')
    expect(tab?.sessionRef).toEqual(replacementSessionRef)
    expect(tab?.resumeSessionId).toBeUndefined()
  })
})

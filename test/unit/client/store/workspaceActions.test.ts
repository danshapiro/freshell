import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import panesReducer from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import {
  createPaneBackedTab,
  hydrateWorkspaceSnapshot,
  restorePaneBackedTab,
} from '@/store/workspaceActions'

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'generated-id'),
}))

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [],
        activeTabId: null,
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    },
  })
}

describe('workspaceActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a pane-backed tab and its first layout in one dispatch', () => {
    const store = createStore()

    store.dispatch(
      createPaneBackedTab({
        tab: {
          id: 'tab-1',
          title: 'Claude',
          mode: 'claude',
          initialCwd: '/repo',
          resumeSessionId: 'claude-session-1',
        },
        paneId: 'pane-1',
        content: {
          kind: 'terminal',
          createRequestId: 'create-1',
          mode: 'claude',
          resumeSessionId: 'claude-session-1',
          initialCwd: '/repo',
        },
      }),
    )

    const state = store.getState()
    expect(state.tabs.tabs).toEqual([
      expect.objectContaining({
        id: 'tab-1',
        title: 'Claude',
        mode: 'claude',
        status: 'creating',
        createRequestId: 'tab-1',
        resumeSessionId: 'claude-session-1',
      }),
    ])
    expect(state.tabs.activeTabId).toBe('tab-1')
    expect(state.panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'terminal',
        createRequestId: 'create-1',
        mode: 'claude',
        status: 'creating',
        resumeSessionId: 'claude-session-1',
        initialCwd: '/repo',
      },
    })
    expect(state.panes.activePane['tab-1']).toBe('pane-1')
    expect(state.panes.paneTitles['tab-1']).toEqual({ 'pane-1': 'Claude' })
  })

  it('restores pane-backed tabs with normalized tab and pane defaults', () => {
    const store = createStore()

    store.dispatch(
      restorePaneBackedTab({
        tab: {
          id: 'restored-tab',
          title: 'Restored Tab',
          mode: 'codex',
          resumeSessionId: 'codex-session-1',
        },
        layout: {
          type: 'leaf',
          id: 'restored-pane',
          content: {
            kind: 'terminal',
            createRequestId: 'stale-create-id',
            terminalId: 'stale-terminal-id',
            status: 'running',
            mode: 'codex',
            resumeSessionId: 'codex-session-1',
          },
        },
        paneTitles: {
          'restored-pane': 'Restored Session',
        },
      }),
    )

    const state = store.getState()
    expect(state.tabs.tabs[0]).toEqual(
      expect.objectContaining({
        id: 'restored-tab',
        title: 'Restored Tab',
        mode: 'codex',
        status: 'creating',
        createRequestId: 'restored-tab',
      }),
    )
    expect(state.tabs.tabs[0].createdAt).toBeTypeOf('number')
    expect(state.panes.layouts['restored-tab']).toMatchObject({
      type: 'leaf',
      id: 'restored-pane',
      content: {
        kind: 'terminal',
        mode: 'codex',
        status: 'creating',
        resumeSessionId: 'codex-session-1',
      },
    })
    const restoredLayout = state.panes.layouts['restored-tab'] as {
      type: 'leaf'
      content: Record<string, unknown>
    }
    expect(restoredLayout.content).not.toMatchObject({
      createRequestId: 'stale-create-id',
      terminalId: 'stale-terminal-id',
      status: 'running',
    })
    expect(state.panes.paneTitles['restored-tab']).toEqual({
      'restored-pane': 'Restored Session',
    })
  })

  it('hydrates tabs and panes together while preserving reducer normalization', () => {
    const store = createStore()

    store.dispatch(
      hydrateWorkspaceSnapshot({
        tabs: {
          tabs: [
            {
              id: 'hydrated-tab',
              title: 'Hydrated Tab',
              mode: 'shell',
            },
          ],
          activeTabId: 'missing-active-tab',
          renameRequestTabId: 'stale-rename-request',
        },
        panes: {
          layouts: {
            'hydrated-tab': {
              type: 'leaf',
              id: 'hydrated-pane',
              content: {
                kind: 'browser',
                url: 'https://example.com',
                devToolsOpen: false,
              },
            },
          },
          activePane: {
            'hydrated-tab': 'missing-pane',
          },
          paneTitles: {},
          paneTitleSetByUser: {},
          renameRequestTabId: 'stale-tab-rename',
          renameRequestPaneId: 'stale-pane-rename',
          zoomedPane: {
            'hydrated-tab': 'hydrated-pane',
          },
          refreshRequestsByPane: {
            'hydrated-tab': {},
          },
        },
      }),
    )

    const state = store.getState()
    expect(state.tabs.tabs).toEqual([
      expect.objectContaining({
        id: 'hydrated-tab',
        title: 'Hydrated Tab',
        mode: 'shell',
        shell: 'system',
        status: 'creating',
        createRequestId: 'hydrated-tab',
      }),
    ])
    expect(state.tabs.activeTabId).toBe('hydrated-tab')
    expect(state.tabs.renameRequestTabId).toBeNull()
    expect(state.panes.layouts['hydrated-tab']).toMatchObject({
      type: 'leaf',
      id: 'hydrated-pane',
      content: {
        kind: 'browser',
        url: 'https://example.com',
        devToolsOpen: false,
      },
    })
    expect(state.panes.activePane['hydrated-tab']).toBe('hydrated-pane')
    expect(state.panes.renameRequestTabId).toBeNull()
    expect(state.panes.renameRequestPaneId).toBeNull()
    expect(state.panes.zoomedPane).toEqual({})
    expect(state.panes.refreshRequestsByPane).toEqual({})
  })
})

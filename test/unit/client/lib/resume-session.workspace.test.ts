import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import connectionReducer from '@/store/connectionSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import { findCheckpointWorkspaceForSession } from '@/lib/resume-session'
import type { RootState } from '@/store/store'

const sessionId = '550e8400-e29b-41d4-a716-446655440090'
const checkpointWorkspace = { path: '/selected/project', provenance: 'directory-picker' as const }

function createStore() {
  return configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, connection: connectionReducer },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Fresh session',
          status: 'running' as const,
          mode: 'claude' as const,
          initialCwd: '/repo',
          sessionRef: { provider: 'claude' as const, sessionId },
          checkpointWorkspace,
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
      },
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
      connection: {
        status: 'ready' as const,
        serverInstanceId: 'server-1',
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
    },
  })
}

describe('findCheckpointWorkspaceForSession', () => {
  it('reads the persisted workspace from a matching tab when its layout needs hydration', () => {
    const store = createStore()

    expect(findCheckpointWorkspaceForSession(store.getState() as RootState, {
      provider: 'claude',
      sessionId,
    })).toEqual(checkpointWorkspace)
  })

  it('reads the current workspace from a matching fresh-agent pane', () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        sessionId,
        sessionRef: { provider: 'claude', sessionId },
        status: 'idle',
        checkpointWorkspace,
      },
    }))

    expect(findCheckpointWorkspaceForSession(store.getState() as RootState, {
      provider: 'claude',
      sessionId,
    })).toEqual(checkpointWorkspace)
  })

  it('does not use a tab workspace for a different pane in the same split tab', () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        createRequestId: 'terminal-req',
        status: 'running',
        sessionRef: { provider: 'claude', sessionId },
      },
    }))

    expect(findCheckpointWorkspaceForSession(store.getState() as RootState, {
      provider: 'claude',
      sessionId,
    })).toBeUndefined()
  })
})

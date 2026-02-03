import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { hydratePanes, removeLayout } from '@/store/panesSlice'
import terminalActivityReducer, { recordOutput, recordInput } from '@/store/terminalActivitySlice'
import { paneActivityCleanupMiddleware } from '@/store/paneActivityCleanupMiddleware'
import type { PaneNode, TerminalPaneContent, SessionPaneContent } from '@/store/paneTypes'

function makeTerminalContent(id: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId: `req-${id}`,
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: `term-${id}`,
  }
}

function makeSessionContent(id: string): SessionPaneContent {
  return {
    kind: 'session',
    provider: 'claude',
    sessionId: `session-${id}`,
  }
}

function makeLeaf(id: string, content: TerminalPaneContent | SessionPaneContent): PaneNode {
  return { type: 'leaf', id, content }
}

function makeSplit(children: [PaneNode, PaneNode], direction: 'horizontal' | 'vertical' = 'horizontal'): PaneNode {
  return { type: 'split', direction, splitRatio: 0.5, children }
}

function createTestStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      terminalActivity: terminalActivityReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(paneActivityCleanupMiddleware),
  })
}

describe('paneActivityCleanupMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cleans up activity when terminal pane is removed via removeLayout', () => {
    const store = createTestStore()
    const paneId = 'pane-1'
    const tabId = 'tab-1'

    // Set up initial state with a terminal pane using hydratePanes
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(paneId, makeTerminalContent(paneId)) },
      activePane: { [tabId]: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Record activity for the terminal
    store.dispatch(recordOutput({ paneId }))
    store.dispatch(recordInput({ paneId }))

    // Verify activity exists
    const beforeState = store.getState().terminalActivity
    expect(beforeState.lastOutputAt[paneId]).toBeDefined()
    expect(beforeState.lastInputAt[paneId]).toBeDefined()

    // Remove the layout (which removes the pane)
    store.dispatch(removeLayout({ tabId }))

    // Verify activity was cleaned up
    const afterState = store.getState().terminalActivity
    expect(afterState.lastOutputAt[paneId]).toBeUndefined()
    expect(afterState.lastInputAt[paneId]).toBeUndefined()
  })

  it('cleans up activity when terminal pane is replaced with session pane via hydratePanes', () => {
    const store = createTestStore()
    const paneId = 'pane-1'
    const tabId = 'tab-1'

    // Set up initial state with a terminal pane
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(paneId, makeTerminalContent(paneId)) },
      activePane: { [tabId]: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Record activity for the terminal
    store.dispatch(recordOutput({ paneId }))

    // Verify activity exists
    expect(store.getState().terminalActivity.lastOutputAt[paneId]).toBeDefined()

    // Replace with session pane (same paneId, different content kind)
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(paneId, makeSessionContent(paneId)) },
      activePane: { [tabId]: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Verify activity was cleaned up (pane kind changed from terminal to session)
    expect(store.getState().terminalActivity.lastOutputAt[paneId]).toBeUndefined()
  })

  it('does not clean up activity for session panes', () => {
    const store = createTestStore()
    const paneId = 'pane-1'
    const tabId = 'tab-1'

    // Set up with a session pane (not terminal)
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(paneId, makeSessionContent(paneId)) },
      activePane: { [tabId]: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Remove the layout
    store.dispatch(removeLayout({ tabId }))

    // Should not throw or cause issues (no activity to clean for session panes)
    const state = store.getState().terminalActivity
    expect(state.lastOutputAt[paneId]).toBeUndefined()
  })

  it('cleans up activity when terminal is removed from split layout', () => {
    const store = createTestStore()
    const terminalPaneId = 'terminal-pane'
    const sessionPaneId = 'session-pane'
    const tabId = 'tab-1'

    // Set up split layout with terminal and session
    store.dispatch(hydratePanes({
      layouts: {
        [tabId]: makeSplit([
          makeLeaf(terminalPaneId, makeTerminalContent(terminalPaneId)),
          makeLeaf(sessionPaneId, makeSessionContent(sessionPaneId)),
        ]),
      },
      activePane: { [tabId]: terminalPaneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Record activity for terminal
    store.dispatch(recordOutput({ paneId: terminalPaneId }))

    // Verify activity exists
    expect(store.getState().terminalActivity.lastOutputAt[terminalPaneId]).toBeDefined()

    // Replace layout with just the session pane (removing terminal)
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(sessionPaneId, makeSessionContent(sessionPaneId)) },
      activePane: { [tabId]: sessionPaneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Verify terminal activity was cleaned up
    expect(store.getState().terminalActivity.lastOutputAt[terminalPaneId]).toBeUndefined()
  })

  it('does not affect non-pane actions', () => {
    const store = createTestStore()
    const paneId = 'pane-1'
    const tabId = 'tab-1'

    // Set up terminal with activity
    store.dispatch(hydratePanes({
      layouts: { [tabId]: makeLeaf(paneId, makeTerminalContent(paneId)) },
      activePane: { [tabId]: paneId },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))
    store.dispatch(recordOutput({ paneId }))

    // Dispatch a non-pane action (recordInput is terminalActivity/)
    const activityBefore = store.getState().terminalActivity.lastOutputAt[paneId]
    store.dispatch(recordInput({ paneId }))

    // Activity should still exist (middleware shouldn't interfere with non-pane actions)
    expect(store.getState().terminalActivity.lastOutputAt[paneId]).toBe(activityBefore)
  })

  it('handles multiple terminals being removed at once', () => {
    const store = createTestStore()
    const pane1 = 'pane-1'
    const pane2 = 'pane-2'
    const tabId = 'tab-1'

    // Set up split with two terminals
    store.dispatch(hydratePanes({
      layouts: {
        [tabId]: makeSplit([
          makeLeaf(pane1, makeTerminalContent(pane1)),
          makeLeaf(pane2, makeTerminalContent(pane2)),
        ]),
      },
      activePane: { [tabId]: pane1 },
      paneTitles: {},
      paneTitleSetByUser: {},
    }))

    // Record activity for both
    store.dispatch(recordOutput({ paneId: pane1 }))
    store.dispatch(recordOutput({ paneId: pane2 }))

    // Verify both have activity
    const before = store.getState().terminalActivity
    expect(before.lastOutputAt[pane1]).toBeDefined()
    expect(before.lastOutputAt[pane2]).toBeDefined()

    // Remove entire layout
    store.dispatch(removeLayout({ tabId }))

    // Both should be cleaned up
    const after = store.getState().terminalActivity
    expect(after.lastOutputAt[pane1]).toBeUndefined()
    expect(after.lastOutputAt[pane2]).toBeUndefined()
  })
})

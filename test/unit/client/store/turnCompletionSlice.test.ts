import { describe, it, expect } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import reducer, {
  clearTabAttention,
  clearPaneAttention,
  consumeTurnCompleteEvents,
  markTabAttention,
  markPaneAttention,
  recordTurnComplete,
  type TurnCompletionState,
} from '@/store/turnCompletionSlice'
import panesReducer from '@/store/panesSlice'
import tabsReducer, { closePaneWithCleanup, closeTab } from '@/store/tabsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import type { PaneNode } from '@/store/paneTypes'

describe('turnCompletionSlice', () => {
  it('records latest event with sequence id', () => {
    const state = reducer(
      undefined,
      recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-9', terminalId: 'term-2', at: 123 })
    )

    expect(state.lastEvent?.seq).toBe(1)
    expect(state.lastEvent?.tabId).toBe('tab-2')
    expect(state.lastEvent?.paneId).toBe('pane-9')
    expect(state.lastEvent?.terminalId).toBe('term-2')
    expect(state.lastEvent?.at).toBe(123)
    expect(state.pendingEvents).toHaveLength(1)
    expect(state.pendingEvents[0]?.seq).toBe(1)
  })

  it('increments sequence across events', () => {
    let state = reducer(
      undefined,
      recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 })
    )
    state = reducer(
      state,
      recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 200 })
    )

    expect(state.lastEvent?.seq).toBe(2)
    expect(state.seq).toBe(2)
    expect(state.pendingEvents).toHaveLength(2)
    expect(state.pendingEvents[0]?.seq).toBe(1)
    expect(state.pendingEvents[1]?.seq).toBe(2)
  })

  it('consumes pending events up through the handled sequence', () => {
    let state = reducer(
      undefined,
      recordTurnComplete({ tabId: 'tab-1', paneId: 'pane-1', terminalId: 'term-1', at: 100 })
    )
    state = reducer(
      state,
      recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-2', terminalId: 'term-2', at: 200 })
    )
    state = reducer(
      state,
      consumeTurnCompleteEvents({ throughSeq: 1 })
    )

    expect(state.pendingEvents).toHaveLength(1)
    expect(state.pendingEvents[0]?.seq).toBe(2)
  })

  it('marks and clears tab attention', () => {
    let state = reducer(undefined, markTabAttention({ tabId: 'tab-2' }))
    expect(state.attentionByTab['tab-2']).toBe(true)

    state = reducer(state, clearTabAttention({ tabId: 'tab-2' }))
    expect(state.attentionByTab['tab-2']).toBeUndefined()
  })

  it('markTabAttention is a no-op when already set (perf guard)', () => {
    const state = reducer(undefined, markTabAttention({ tabId: 'tab-1' }))
    const next = reducer(state, markTabAttention({ tabId: 'tab-1' }))
    // Immer returns the same reference when the draft is unmodified
    expect(next).toBe(state)
  })

  it('clearTabAttention is a no-op when not set (perf guard)', () => {
    const state = reducer(undefined, clearTabAttention({ tabId: 'tab-1' }))
    const initial: TurnCompletionState = {
      seq: 0,
      lastEvent: null,
      pendingEvents: [],
      attentionByTab: {},
      attentionByPane: {},
    }
    // Should return exact same state reference — no draft modification
    expect(state).toEqual(initial)
    // Also verify repeated clears don't mutate
    const next = reducer(state, clearTabAttention({ tabId: 'tab-1' }))
    expect(next).toBe(state)
  })

  it('marks and clears pane attention', () => {
    let state = reducer(undefined, markPaneAttention({ paneId: 'pane-5' }))
    expect(state.attentionByPane['pane-5']).toBe(true)

    state = reducer(state, clearPaneAttention({ paneId: 'pane-5' }))
    expect(state.attentionByPane['pane-5']).toBeUndefined()
  })

  it('markPaneAttention is a no-op when already set (perf guard)', () => {
    const state = reducer(undefined, markPaneAttention({ paneId: 'pane-1' }))
    const next = reducer(state, markPaneAttention({ paneId: 'pane-1' }))
    // Immer returns the same reference when the draft is unmodified
    expect(next).toBe(state)
  })

  it('clearPaneAttention is a no-op when not set (perf guard)', () => {
    const state = reducer(undefined, clearPaneAttention({ paneId: 'pane-1' }))
    // Should return exact same state reference — no draft modification
    const next = reducer(state, clearPaneAttention({ paneId: 'pane-1' }))
    expect(next).toBe(state)
  })

  describe('attention cleanup on pane/tab close (thunks)', () => {
    const splitLayout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [
        { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', createRequestId: 'cr-1', status: 'running', mode: 'shell' } },
        { type: 'leaf', id: 'pane-2', content: { kind: 'terminal', createRequestId: 'cr-2', status: 'running', mode: 'shell' } },
      ],
      sizes: [50, 50],
    }

    function createFullStore(layout: PaneNode = splitLayout) {
      const now = Date.now()
      return configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          turnCompletion: reducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{ id: 'tab-1', createRequestId: 'req-1', title: 'Tab 1', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: now }],
            activeTabId: 'tab-1',
            renameRequestTabId: null,
          },
          panes: {
            layouts: { 'tab-1': layout },
            activePane: { 'tab-1': 'pane-1' },
            paneTitles: {},
          },
          settings: { settings: defaultSettings, loaded: true },
          turnCompletion: {
            seq: 0,
            lastEvent: null,
            pendingEvents: [],
            attentionByTab: { 'tab-1': true },
            attentionByPane: { 'pane-1': true, 'pane-2': true },
          },
        },
      })
    }

    it('closePaneWithCleanup clears both pane and tab attention when pane is actually closed', async () => {
      const store = createFullStore()
      await store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }))
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
    })

    it('closePaneWithCleanup closes tab and clears attention when closing the only pane', async () => {
      const singleLayout: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', createRequestId: 'cr-1', status: 'running', mode: 'shell' },
      }
      const store = createFullStore(singleLayout)
      await store.dispatch(closePaneWithCleanup({ tabId: 'tab-1', paneId: 'pane-1' }))
      expect(store.getState().tabs.tabs).toHaveLength(0)
      expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
    })

    it('closeTab clears tab and all pane attention entries', async () => {
      const store = createFullStore()
      await store.dispatch(closeTab('tab-1'))
      expect(store.getState().turnCompletion.attentionByTab['tab-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-1']).toBeUndefined()
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
    })

    it('closeTab on a tab without attention is a no-op for attention state', async () => {
      const store = createFullStore()
      // Clear attention first
      store.dispatch(clearTabAttention({ tabId: 'tab-1' }))
      store.dispatch(clearPaneAttention({ paneId: 'pane-1' }))
      store.dispatch(clearPaneAttention({ paneId: 'pane-2' }))

      // Add attention to a different tab that won't be closed
      store.dispatch(markTabAttention({ tabId: 'tab-99' }))

      await store.dispatch(closeTab('tab-1'))
      // Unrelated tab's attention is untouched
      expect(store.getState().turnCompletion.attentionByTab['tab-99']).toBe(true)
    })
  })
})

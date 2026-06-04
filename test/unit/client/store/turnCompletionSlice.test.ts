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
import { applyServerCompletion } from '@/store/turnCompletionThunks'

describe('turnCompletionSlice', () => {
  it('records latest event with sequence id', () => {
    const state = reducer(
      undefined,
      recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-9', terminalId: 'term-2', at: 123 })
    )

    expect(state.pendingEvents.at(-1)?.seq).toBe(1)
    expect(state.pendingEvents.at(-1)?.tabId).toBe('tab-2')
    expect(state.pendingEvents.at(-1)?.paneId).toBe('pane-9')
    expect(state.pendingEvents.at(-1)?.terminalId).toBe('term-2')
    expect(state.pendingEvents.at(-1)?.at).toBe(123)
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

    expect(state.pendingEvents.at(-1)?.seq).toBe(2)
    expect(state.seq).toBe(2)
    expect(state.pendingEvents).toHaveLength(2)
    expect(state.pendingEvents[0]?.seq).toBe(1)
    expect(state.pendingEvents[1]?.seq).toBe(2)
  })

  it('ignores a duplicate turn-complete with the same terminalId and at', () => {
    let state = reducer(undefined, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
    state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
    expect(state.pendingEvents).toHaveLength(1)
  })

  it('records distinct turns for the same terminal at different times', () => {
    let state = reducer(undefined, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
    state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 6000 }))
    expect(state.pendingEvents).toHaveLength(2)
  })

  it('ignores an older/equal turn-complete for a terminal (monotonic, replay-safe)', () => {
    let state = reducer(undefined, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
    // A replayed/stale completion with an older `at` must NOT re-record (would re-green on replay).
    state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 4000 }))
    state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
    expect(state.pendingEvents).toHaveLength(1)
    // A strictly newer completion still records.
    state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5001 }))
    expect(state.pendingEvents).toHaveLength(2)
  })

  it('keys monotonic dedupe per terminalId (sessionKey strings allowed for SDK panes)', () => {
    let state = reducer(undefined, recordTurnComplete({ tabId: 'T', paneId: 'p1', terminalId: 'claude:abc', at: 10 }))
    state = reducer(state, recordTurnComplete({ tabId: 'T', paneId: 'p2', terminalId: 'codex:def', at: 10 }))
    expect(state.pendingEvents).toHaveLength(2)
  })

  it('dedupes server completions by per-terminal completionSeq while keeping local pending-event seq separate', () => {
    let state = reducer(
      undefined,
      recordTurnComplete({
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_000,
        completionSeq: 7,
      }),
    )

    expect(state.pendingEvents).toEqual([{
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'term-1',
      at: 1_000,
      completionSeq: 7,
      seq: 1,
    }])
    expect(state.lastAppliedCompletionSeqByTerminalId?.['term-1']).toBe(7)

    state = reducer(
      state,
      recordTurnComplete({
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_100,
        completionSeq: 7,
      }),
    )
    state = reducer(
      state,
      recordTurnComplete({
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_200,
        completionSeq: 6,
      }),
    )

    expect(state.pendingEvents).toHaveLength(1)
    expect(state.seq).toBe(1)

    state = reducer(
      state,
      recordTurnComplete({
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_300,
        completionSeq: 8,
      }),
    )

    expect(state.pendingEvents).toHaveLength(2)
    expect(state.pendingEvents[1]?.seq).toBe(2)
    expect(state.lastAppliedCompletionSeqByTerminalId?.['term-1']).toBe(8)
  })

  it('drops a server completion that is already covered by rehydrated completionSeq state', () => {
    const state = reducer(
      {
        seq: 0,
        lastAtByTerminalId: {},
        lastAppliedCompletionSeqByTerminalId: { 'term-1': 9 },
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
      recordTurnComplete({
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_000,
        completionSeq: 9,
      }),
    )

    expect(state.pendingEvents).toEqual([])
    expect(state.seq).toBe(0)
    expect(state.lastAppliedCompletionSeqByTerminalId?.['term-1']).toBe(9)
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
      lastAtByTerminalId: {},
      lastAppliedCompletionSeqByTerminalId: {},
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
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: {},
          },
          settings: { settings: defaultSettings, loaded: true },
          turnCompletion: {
            seq: 0,
            pendingEvents: [],
            lastAtByTerminalId: {},
            lastAppliedCompletionSeqByTerminalId: {},
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
      const result = await store.dispatch(closeTab('tab-1'))
      expect(result.type).toBe(closeTab.fulfilled.type)
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

  describe('applyServerCompletion thunk', () => {
    function createTerminalStore(terminalId = 'term-1') {
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
            tabs: [{ id: 'tab-1', createRequestId: 'req-1', title: 'Tab 1', status: 'running' as const, mode: 'opencode' as const, shell: 'system' as const, createdAt: now }],
            activeTabId: 'tab-1',
            renameRequestTabId: null,
          },
          panes: {
            layouts: {
              'tab-1': {
                type: 'leaf' as const,
                id: 'pane-1',
                content: {
                  kind: 'terminal' as const,
                  createRequestId: 'cr-1',
                  status: 'running' as const,
                  mode: 'opencode' as const,
                  shell: 'system' as const,
                  terminalId,
                },
              },
            },
            activePane: { 'tab-1': 'pane-1' },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: {},
          },
          settings: { settings: defaultSettings, loaded: true },
          turnCompletion: {
            seq: 0,
            lastAtByTerminalId: {},
            lastAppliedCompletionSeqByTerminalId: {},
            pendingEvents: [],
            attentionByTab: {},
            attentionByPane: {},
          },
        },
      })
    }

    it('resolves the owning pane and applies a newer server completion once', () => {
      const store = createTerminalStore()

      store.dispatch(applyServerCompletion({
        provider: 'opencode',
        terminalId: 'term-1',
        at: 1_000,
        completionSeq: 3,
      }) as any)
      store.dispatch(applyServerCompletion({
        provider: 'opencode',
        terminalId: 'term-1',
        at: 1_100,
        completionSeq: 3,
      }) as any)

      expect(store.getState().turnCompletion.pendingEvents).toEqual([{
        tabId: 'tab-1',
        paneId: 'pane-1',
        terminalId: 'term-1',
        at: 1_000,
        completionSeq: 3,
        seq: 1,
      }])
      expect(store.getState().turnCompletion.lastAppliedCompletionSeqByTerminalId?.['term-1']).toBe(3)
    })

    it('does not consume server completionSeq when no pane owns the terminal yet', () => {
      const store = createTerminalStore('term-owned')

      store.dispatch(applyServerCompletion({
        provider: 'codex',
        terminalId: 'term-missing',
        at: 1_000,
        completionSeq: 1,
      }) as any)

      expect(store.getState().turnCompletion.pendingEvents).toEqual([])
      expect(store.getState().turnCompletion.lastAppliedCompletionSeqByTerminalId?.['term-missing']).toBeUndefined()
    })
  })
})

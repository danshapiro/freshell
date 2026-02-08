import { describe, it, expect } from 'vitest'
import reducer, {
  clearTabAttention,
  consumeTurnCompleteEvents,
  markTabAttention,
  recordTurnComplete,
} from '@/store/turnCompletionSlice'

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
})

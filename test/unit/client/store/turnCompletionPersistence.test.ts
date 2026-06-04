import { configureStore } from '@reduxjs/toolkit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSIST_DEBOUNCE_MS, persistMiddleware, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import { TURN_COMPLETION_STORAGE_KEY } from '@/store/storage-keys'

async function importTurnCompletionSlice() {
  return import('@/store/turnCompletionSlice')
}

describe('turnCompletion persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    resetPersistFlushListenersForTests()
    vi.resetModules()
  })

  it('persists attention and applied completion sequence via persistMiddleware', async () => {
    const {
      default: turnCompletionReducer,
      markPaneAttention,
      markTabAttention,
      recordTurnComplete,
    } = await importTurnCompletionSlice()
    const store = configureStore({
      reducer: {
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(markTabAttention({ tabId: 'tab-1' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-1' }))
    store.dispatch(recordTurnComplete({
      tabId: 'tab-1',
      paneId: 'pane-1',
      terminalId: 'term-1',
      at: 1_000,
      completionSeq: 4,
    }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: { 'pane-1': true },
      lastAppliedCompletionSeqByTerminalId: { 'term-1': 4 },
    })
  })

  it('rehydrates attention and applied completion sequence from persisted state', async () => {
    localStorage.setItem(TURN_COMPLETION_STORAGE_KEY, JSON.stringify({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: { 'pane-1': true },
      lastAppliedCompletionSeqByTerminalId: { 'term-1': 4 },
    }))

    const { default: turnCompletionReducer } = await importTurnCompletionSlice()
    const state = turnCompletionReducer(undefined, { type: '@@INIT' })

    expect(state.attentionByTab).toEqual({ 'tab-1': true })
    expect(state.attentionByPane).toEqual({ 'pane-1': true })
    expect(state.lastAppliedCompletionSeqByTerminalId).toEqual({ 'term-1': 4 })
    expect(state.pendingEvents).toEqual([])
  })
})

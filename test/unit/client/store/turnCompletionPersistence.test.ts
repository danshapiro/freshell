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

  it('persists attention via persistMiddleware', async () => {
    const {
      default: turnCompletionReducer,
      markPaneAttention,
      markTabAttention,
    } = await importTurnCompletionSlice()
    const store = configureStore({
      reducer: {
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(markTabAttention({ tabId: 'tab-1' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-1' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: { 'pane-1': true },
      readyByTab: { 'tab-1': true },
    })
  })

  it('flushes a readyByTab-only change (clearTabReady after attention already cleared)', async () => {
    const {
      default: turnCompletionReducer,
      clearTabAttention,
      clearTabReady,
      markTabAttention,
    } = await importTurnCompletionSlice()
    const store = configureStore({
      reducer: {
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    // Mark then acknowledge: attention clears, ready persists through the flush.
    store.dispatch(markTabAttention({ tabId: 'tab-1' }))
    store.dispatch(clearTabAttention({ tabId: 'tab-1' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      attentionByTab: {},
      attentionByPane: {},
      readyByTab: { 'tab-1': true },
    })

    // A readyByTab-only mutation must still flush (dirty check compares readyByTab refs).
    store.dispatch(clearTabReady({ tabId: 'tab-1' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)
    expect(JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || '{}')).toEqual({
      version: 1,
      attentionByTab: {},
      attentionByPane: {},
      readyByTab: {},
    })
  })

  it('prunes persisted readyByTab to live tabs (no unbounded growth / cross-window resurrection)', async () => {
    const {
      default: turnCompletionReducer,
      markTabAttention,
    } = await importTurnCompletionSlice()
    const { default: tabsReducer } = await import('@/store/tabsSlice')
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        turnCompletion: turnCompletionReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
      preloadedState: {
        tabs: {
          tabs: [{ id: 'tab-live', createRequestId: 'req-1', title: 'Live', status: 'running' as const, mode: 'shell' as const, shell: 'system' as const, createdAt: Date.now() }],
          activeTabId: 'tab-live',
          renameRequestTabId: null,
        },
        turnCompletion: {
          seq: 0,
          lastAtByTerminalId: {},
          lastIdleAtByTerminalId: {},
          pendingEvents: [],
          attentionByTab: {},
          attentionByPane: {},
          // 'tab-ghost' is not in state.tabs.tabs (e.g. removed by a multi-window
          // hydrateTabs tombstone merge that never dispatched closeTab).
          readyByTab: { 'tab-live': true, 'tab-ghost': true },
        },
      } as any,
    })

    store.dispatch(markTabAttention({ tabId: 'tab-live' }))
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(localStorage.getItem(TURN_COMPLETION_STORAGE_KEY) || '{}')
    expect(persisted.readyByTab).toEqual({ 'tab-live': true })
  })

  it('rehydrates attention from persisted state (legacy completionSeq field tolerated)', async () => {
    localStorage.setItem(TURN_COMPLETION_STORAGE_KEY, JSON.stringify({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: { 'pane-1': true },
      readyByTab: { 'tab-2': true },
      // Written by older builds; must be ignored, not rejected.
      lastAppliedCompletionSeqByTerminalId: { 'term-1': 4 },
    }))

    const { default: turnCompletionReducer } = await importTurnCompletionSlice()
    const state = turnCompletionReducer(undefined, { type: '@@INIT' })

    expect(state.attentionByTab).toEqual({ 'tab-1': true })
    expect(state.attentionByPane).toEqual({ 'pane-1': true })
    expect(state.readyByTab).toEqual({ 'tab-2': true })
    expect(state.pendingEvents).toEqual([])
  })

  it('tolerates version-1 payloads without readyByTab (pre-readyByTab builds)', async () => {
    localStorage.setItem(TURN_COMPLETION_STORAGE_KEY, JSON.stringify({
      version: 1,
      attentionByTab: { 'tab-1': true },
      attentionByPane: {},
    }))

    const { default: turnCompletionReducer } = await importTurnCompletionSlice()
    const state = turnCompletionReducer(undefined, { type: '@@INIT' })

    expect(state.attentionByTab).toEqual({ 'tab-1': true })
    expect(state.readyByTab).toEqual({})
  })
})

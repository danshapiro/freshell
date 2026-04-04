import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import agentChatReducer, { setSessionStatus } from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedLayoutCacheForTests,
  resetPersistedPanesCacheForTests,
} from '@/store/persistMiddleware'
import {
  flushPersistedLayoutNow,
  getCanonicalDurableSessionId,
  getPreferredResumeSessionId,
} from '@/store/persistControl'
import tabsReducer, { addTab, updateTab } from '@/store/tabsSlice'

describe('persistControl', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    resetPersistFlushListenersForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistedPanesCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes the persisted layout immediately when explicitly requested', () => {
    const store = configureStore({
      reducer: {
        agentChat: agentChatReducer,
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    store.dispatch(addTab({ id: 'tab-1', title: 'Initial', mode: 'shell' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: { kind: 'terminal', mode: 'shell' },
    }))
    vi.runAllTimers()

    const baselineRaw = localStorage.getItem('freshell.layout.v3')
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Renamed' } }))

    expect(localStorage.getItem('freshell.layout.v3')).toBe(baselineRaw)

    store.dispatch(flushPersistedLayoutNow())

    const raw = localStorage.getItem('freshell.layout.v3')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).tabs.tabs[0].title).toBe('Renamed')
  })

  it('does not force immediate flush for unrelated session updates', () => {
    const store = configureStore({
      reducer: {
        agentChat: agentChatReducer,
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    store.dispatch(setSessionStatus({ sessionId: 'sdk-1', status: 'idle' }))

    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('prefers a canonical durable cliSessionId over a named restore token', () => {
    const session = {
      timelineSessionId: 'named-resume',
      cliSessionId: '00000000-0000-4000-8000-000000000321',
    }

    expect(getPreferredResumeSessionId(session)).toBe('00000000-0000-4000-8000-000000000321')
    expect(getCanonicalDurableSessionId(session)).toBe('00000000-0000-4000-8000-000000000321')
  })
})

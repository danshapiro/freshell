import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import freshAgentReducer, { setSessionStatus } from '@/store/freshAgentSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import {
  persistMiddleware,
  resetPersistFlushListenersForTests,
  resetPersistedLayoutCacheForTests,
  resetPersistedPanesCacheForTests,
} from '@/store/persistMiddleware'
import {
  buildTerminalDurableSessionRefUpdate,
  getAuthoritativeLocalLayoutPersistedAt,
  flushPersistedLayoutNow,
  getCanonicalDurableSessionId,
  getPreferredResumeSessionId,
  observeAuthoritativeLocalLayoutPersistedAt,
  resetAuthoritativeLocalLayoutPersistedAtForTests,
} from '@/store/persistControl'
import tabsReducer, { addTab, updateTab } from '@/store/tabsSlice'

const WINDOW_ID = 'client-persist-control-tests'
const OWN_LAYOUT_KEY = `freshell.layout.v3.${WINDOW_ID}`

describe('persistControl', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.setItem('freshell.layout-window-id.v1', WINDOW_ID)
    vi.useFakeTimers()
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    resetPersistFlushListenersForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistedPanesCacheForTests()
  })

  afterEach(() => {
    resetAuthoritativeLocalLayoutPersistedAtForTests()
    vi.useRealTimers()
  })

  it('flushes the persisted layout immediately when explicitly requested', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
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

    const baselineRaw = localStorage.getItem(OWN_LAYOUT_KEY)
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Renamed' } }))

    expect(localStorage.getItem(OWN_LAYOUT_KEY)).toBe(baselineRaw)

    store.dispatch(flushPersistedLayoutNow())

    const raw = localStorage.getItem(OWN_LAYOUT_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).tabs.tabs[0].title).toBe('Renamed')
  })

  it('does not force immediate flush for unrelated session updates', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
        tabs: tabsReducer,
        panes: panesReducer,
      },
      middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
    })

    const setItemSpy = vi.spyOn(localStorage, 'setItem')
    store.dispatch(setSessionStatus({
      sessionId: 'sdk-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      status: 'idle',
    }))

    expect(setItemSpy).not.toHaveBeenCalled()
  })

  it('retains the highest authoritative layout timestamp', () => {
    observeAuthoritativeLocalLayoutPersistedAt(OWN_LAYOUT_KEY, 150)
    observeAuthoritativeLocalLayoutPersistedAt(OWN_LAYOUT_KEY, 100)

    expect(getAuthoritativeLocalLayoutPersistedAt(OWN_LAYOUT_KEY)).toBe(150)
  })

  it('prefers a canonical durable cliSessionId over a named restore token', () => {
    const session = {
      historySessionId: 'named-resume',
      cliSessionId: '00000000-0000-4000-8000-000000000321',
    }

    expect(getPreferredResumeSessionId(session)).toBe('00000000-0000-4000-8000-000000000321')
    expect(getCanonicalDurableSessionId(session)).toBe('00000000-0000-4000-8000-000000000321')
  })
})

describe('buildTerminalDurableSessionRefUpdate metadata re-key', () => {
  it('moves sessionMetadataByKey from the old session key to the new one on rebind', () => {
    const update = buildTerminalDurableSessionRefUpdate({
      provider: 'opencode',
      sessionId: 'ses_new',
      paneSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      tabSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
      paneResumeSessionId: undefined,
      tabResumeSessionId: undefined,
      tabSessionMetadataByKey: {
        'opencode:ses_old': { sessionType: 'opencode', firstUserMessage: 'hello world' },
      },
    })
    expect(update?.tabUpdates?.sessionMetadataByKey).toBeDefined()
    expect(update!.tabUpdates!.sessionMetadataByKey!['opencode:ses_new']).toMatchObject({ firstUserMessage: 'hello world' })
    expect(update!.tabUpdates!.sessionMetadataByKey!['opencode:ses_old']).toBeUndefined()
  })

  it('returns null when nothing needs re-keying (metadata already under the new key)', () => {
    const update = buildTerminalDurableSessionRefUpdate({
      provider: 'opencode',
      sessionId: 'ses_new',
      paneSessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      tabSessionRef: { provider: 'opencode', sessionId: 'ses_new' },
      paneResumeSessionId: undefined,
      tabResumeSessionId: undefined,
      tabSessionMetadataByKey: {
        'opencode:ses_new': { sessionType: 'opencode' },
      },
    })
    expect(update).toBeNull()
  })

  it('does not add a sessionMetadataByKey update when the metadata map is absent or empty', () => {
    for (const tabSessionMetadataByKey of [undefined, {}]) {
      const update = buildTerminalDurableSessionRefUpdate({
        provider: 'opencode',
        sessionId: 'ses_new',
        paneSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        tabSessionRef: { provider: 'opencode', sessionId: 'ses_old' },
        paneResumeSessionId: undefined,
        tabResumeSessionId: undefined,
        tabSessionMetadataByKey,
      })
      expect(update?.tabUpdates?.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_new' })
      expect(update?.tabUpdates !== undefined && 'sessionMetadataByKey' in update.tabUpdates).toBe(false)
    }
  })
})

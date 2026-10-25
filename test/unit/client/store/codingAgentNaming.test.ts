import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import type { PaneNode } from '@/store/paneTypes'
import { finalizeCodingAgentSessionName } from '@/store/codingAgentNaming'

vi.mock('nanoid', () => {
  let n = 0
  return { nanoid: vi.fn(() => `pane-${++n}`) }
})

const apiMocks = vi.hoisted(() => ({ post: vi.fn() }))
const apiPost = apiMocks.post
vi.mock('@/lib/api', () => ({ api: { post: apiMocks.post } }))

function singlePaneStore(sessionType: 'kilroy' | 'freshclaude' | 'claude') {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content: { kind: 'fresh-agent', sessionType, provider: 'claude', sessionId: 'sess-1', createRequestId: 'r', status: 'idle' } }))
  const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
  return { store, tabId, paneId }
}

/**
 * Unified agent names (Task 5): the scoped fresh types (freshclaude,
 * freshcodex, freshopencode) no longer run ANY client-side generation — the
 * server's input-activity pipeline owns their fallback and AI naming, and
 * the accepted name arrives through the canonical session.name.updated push.
 * These tests pin BOTH sides: the scoped no-op, and the retained legacy
 * finalize for the out-of-scope kilroy type (unchanged behavior).
 */
describe('finalizeCodingAgentSessionName', () => {
  beforeEach(() => apiPost.mockReset())

  it('no-ops for scoped fresh types: no POST, no pane/tab title writes', async () => {
    const { store, tabId, paneId } = singlePaneStore('freshclaude')

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionType: 'freshclaude', sessionId: 'sess-1', firstMessage: 'please fix the login redirect bug',
    }) as never)

    expect(apiPost).not.toHaveBeenCalled()
    // The pane keeps its derived default — nothing was written.
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).toBe('Freshclaude')
    expect(store.getState().tabs.tabs[0].title).toBe('freshell')
  })

  it('still POSTs generate-title for the out-of-scope kilroy type and mirrors the server title into pane + single-pane tab', async () => {
    apiPost.mockResolvedValue({ title: 'Fix login redirect', source: 'ai' })
    const { store, tabId, paneId } = singlePaneStore('kilroy')

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionType: 'kilroy', sessionId: 'sess-1', firstMessage: 'please fix the login redirect bug',
    }) as never)

    expect(apiPost).toHaveBeenCalledWith(
      '/api/sessions/claude%3Asess-1/generate-title',
      { firstMessage: 'please fix the login redirect bug' },
    )
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Fix login redirect')
    expect(store.getState().tabs.tabs[0].title).toBe('Fix login redirect')
  })

  it('falls back to a local first-message title for kilroy when the server returns no title', async () => {
    apiPost.mockResolvedValue({ title: null, source: 'none' })
    const { store, tabId, paneId } = singlePaneStore('kilroy')

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionType: 'kilroy', sessionId: 'sess-1', firstMessage: 'Add a logout button to the header',
    }) as never)

    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Add a logout button to the header')
  })

  it('a kilroy finalize never retitles a session-owned tab (one ownership gate for every legacy writer)', async () => {
    apiPost.mockResolvedValue({ title: 'Fix login redirect', source: 'ai' })
    const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
    // The tab's naming source points at its pane, so the tab is
    // session-owned: its stored title is the saved-name mirror, never a
    // legacy write target.
    store.dispatch(addTab({ id: 'owned', title: 'LotL', mode: 'claude', nameSource: { kind: 'session', paneId: 'owned-pane' } }))
    store.dispatch(initLayout({
      tabId: 'owned',
      paneId: 'owned-pane',
      content: { kind: 'fresh-agent', sessionType: 'kilroy', provider: 'claude', sessionId: 'sess-1', createRequestId: 'r', status: 'idle' },
    }))

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId: 'owned', paneId: 'owned-pane', provider: 'claude', sessionType: 'kilroy', sessionId: 'sess-1', firstMessage: 'please fix the login redirect bug',
    }) as never)

    // The kilroy pane keeps its legacy pane naming; the tab title is untouched.
    expect(store.getState().panes.paneTitles.owned['owned-pane']).toBe('Fix login redirect')
    expect(store.getState().tabs.tabs[0].title).toBe('LotL')
  })

  it('writes the kilroy pane title as an auto source (not a user freeze)', async () => {
    apiPost.mockResolvedValue({ title: 'Server Title', source: 'first-message' })
    const { store, tabId, paneId } = singlePaneStore('kilroy')

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionType: 'kilroy', sessionId: 'sess-1', firstMessage: 'hello',
    }) as never)

    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeFalsy()
  })
})

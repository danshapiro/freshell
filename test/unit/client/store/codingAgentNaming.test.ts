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

function singlePaneStore() {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content: { kind: 'fresh-agent', sessionType: 'claude', provider: 'claude', sessionId: 'sess-1', createRequestId: 'r', status: 'idle' } }))
  const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
  return { store, tabId, paneId }
}

describe('finalizeCodingAgentSessionName', () => {
  beforeEach(() => apiPost.mockReset())

  it('POSTs generate-title and mirrors the server title into pane + single-pane tab', async () => {
    apiPost.mockResolvedValue({ title: 'Fix login redirect', source: 'ai' })
    const { store, tabId, paneId } = singlePaneStore()

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionId: 'sess-1', firstMessage: 'please fix the login redirect bug',
    }) as never)

    expect(apiPost).toHaveBeenCalledWith(
      '/api/sessions/claude%3Asess-1/generate-title',
      { firstMessage: 'please fix the login redirect bug' },
    )
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Fix login redirect')
    expect(store.getState().tabs.tabs[0].title).toBe('Fix login redirect')
  })

  it('falls back to a local first-message title when the server returns no title', async () => {
    apiPost.mockResolvedValue({ title: null, source: 'none' })
    const { store, tabId, paneId } = singlePaneStore()

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionId: 'sess-1', firstMessage: 'Add a logout button to the header',
    }) as never)

    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Add a logout button to the header')
  })

  it('writes the pane title as an auto source (not a user freeze)', async () => {
    apiPost.mockResolvedValue({ title: 'Server Title', source: 'first-message' })
    const { store, tabId, paneId } = singlePaneStore()

    await store.dispatch(finalizeCodingAgentSessionName({
      tabId, paneId, provider: 'claude', sessionId: 'sess-1', firstMessage: 'hello',
    }) as never)

    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBeFalsy()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import { applyPaneRename } from '@/store/titleSync'

vi.mock('nanoid', () => {
  let n = 0
  return { nanoid: vi.fn(() => `pane-${++n}`) }
})

const apiMocks = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/api', () => ({ api: { patch: apiMocks.patch } }))

function storeWith(content: PaneContent) {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'x', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content }))
  const paneId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).id
  return { store, tabId, paneId }
}

describe('rename server sync (alignment)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('syncs a coding-CLI terminal rename to the terminals API', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'claude', terminalId: 'term-9' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Project' }))
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-9', { titleOverride: 'My Project' })
  })

  it('does NOT sync a shell terminal rename (shell titles stay Redux-only)', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'shell', terminalId: 'term-shell' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Shell' }))
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('syncs a fresh-agent rename to the sessions API by composite key', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'fresh-agent', sessionType: 'claude', provider: 'claude', sessionId: 'sess-7', createRequestId: 'r', status: 'idle',
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Chat' }))
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/claude%3Asess-7', { titleOverride: 'My Chat' })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, splitPane } from '@/store/panesSlice'
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import { applyPaneRename, applyTabRename } from '@/store/titleSync'

vi.mock('nanoid', () => { let n = 0; return { nanoid: vi.fn(() => `pane-${++n}`) } })

// The contract under test: pane/tab renames must NOT touch the network. The
// mock stays as a tripwire even though nothing should call it.
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

describe('pane/tab rename local scope (b5fb)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('live coding-CLI terminal pane rename updates local labels and PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'claude', terminalId: 'term-9' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Project' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Project')
    // single-pane tab: tab title mirrors the pane label locally (existing org behavior)
    expect(store.getState().tabs.tabs[0].title).toBe('My Project')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('exited coding-CLI terminal pane with a retained sessionRef PATCHes nothing (stopped pane == live pane rule)', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'terminal', mode: 'claude', createRequestId: 'r-exited', status: 'exited',
      sessionRef: { provider: 'claude', sessionId: 's1' },
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Offline name' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Offline name')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('multi-pane tab rename changes the tab label only — pane labels are untouched', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'claude', terminalId: 'term-1' })
    store.dispatch(splitPane({
      tabId,
      paneId,
      direction: 'horizontal',
      newContent: { kind: 'terminal', mode: 'opencode', terminalId: 'term-2' } as PaneContent,
      newPaneId: 'pane-99',
    }))
    store.dispatch(applyTabRename({ tabId, title: 'Multi tab' }))
    expect(store.getState().tabs.tabs[0].title).toBe('Multi tab')
    // neither pane gained a label from the tab-organisation rename
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).not.toBe('Multi tab')
    expect(store.getState().panes.paneTitles[tabId]?.['pane-99']).not.toBe('Multi tab')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('fresh-agent pane rename (sessionId present) PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'fresh-agent', sessionType: 'claude', provider: 'claude', sessionId: 'sess-7',
      createRequestId: 'r', status: 'idle',
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Chat' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Chat')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('pre-ID fresh-agent pane rename stays local and is never retro-synced on identity adoption', () => {
    const { store, tabId, paneId } = storeWith({
      kind: 'fresh-agent', sessionType: 'claude', provider: 'claude',
      createRequestId: 'r-pre', status: 'connecting',
    } as unknown as PaneContent)
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Pre-ID label' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Pre-ID label')
    // Nothing is queued for later: with sync machinery deleted there is no
    // replay path, so an identity adoption (sessionId arriving later) can
    // never retro-persist this label. (FreshAgentView adoption coverage tests
    //  verify content adoption itself.)
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('single-pane tab rename mirrors into the pane label locally and PATCHes nothing', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'codex', terminalId: 'term-3' })
    store.dispatch(applyTabRename({ tabId, title: 'Tab org label' }))
    expect(store.getState().tabs.tabs[0].title).toBe('Tab org label')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Tab org label')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('shell terminal pane rename stays Redux-only (unchanged)', () => {
    const { store, tabId, paneId } = storeWith({ kind: 'terminal', mode: 'shell', terminalId: 'term-shell' })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'My Shell' }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('My Shell')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })
})

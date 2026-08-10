import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle, updatePaneTitleBySessionRef } from '@/store/panesSlice'
import { applySessionRenameCascade, applyPaneRename } from '@/store/titleSync'
import { renameOverviewTerminal } from '@/components/OverviewView'

vi.mock('nanoid', () => { let n = 0; return { nanoid: vi.fn(() => `pane-${++n}`) } })

const apiMocks = vi.hoisted(() => ({ patch: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/api', () => ({ api: { patch: apiMocks.patch } }))

function freshAgentStore() {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({
    tabId,
    content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
               sessionId: 's1', createRequestId: 'r1', status: 'running' },
  }))
  const paneId = (store.getState().panes.layouts[tabId] as { id: string }).id
  return { store, tabId, paneId }
}

describe('updatePaneTitleBySessionRef', () => {
  it('writes the pane title for a matching fresh-agent pane', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'New', setByUser: true }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('New')
  })
  it('non-matching sessionRef leaves titles alone', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'codex', sessionId: 's1', title: 'New' }))
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).not.toBe('New')
  })
  it('setByUser:false respects the sticky flag; setByUser:true overrides it (D6 policy)', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitle({ tabId, paneId, title: 'Mine' })) // sticky
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'Auto', setByUser: false }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Mine')
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'UserWins', setByUser: true }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('UserWins')
  })
})

describe('applySessionRenameCascade', () => {
  it('mirrors a sidebar session rename into the pane by sessionRef (D3/D4)', () => {
    const { store, tabId, paneId } = freshAgentStore()
    applySessionRenameCascade({ dispatch: store.dispatch, provider: 'claude',
      sessionId: 's1', title: 'Renamed', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Renamed')
  })
})

function terminalStore(content: Record<string, unknown>) {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({ tabId, content: content as never }))
  const paneId = (store.getState().panes.layouts[tabId] as { id: string }).id
  return { store, tabId, paneId }
}

describe('exited-terminal pane rename (D8)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the session override via sessionRef when the coding-CLI terminal has exited', () => {
    // TerminalView clears terminalId on exit (TerminalView.tsx:3841), so the
    // pane only carries its durable sessionRef.
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'claude', createRequestId: 'r-exited', status: 'exited',
      sessionRef: { provider: 'claude', sessionId: 's1' },
    })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Persisted rename' }))
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/claude%3As1', { titleOverride: 'Persisted rename' })
  })

  it('still cascades via the terminals API when the terminal is live', () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'claude', terminalId: 'term-live', createRequestId: 'r-live', status: 'running',
      sessionRef: { provider: 'claude', sessionId: 's1' },
    })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Live rename' }))
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-live', { titleOverride: 'Live rename' })
    expect(apiMocks.patch).not.toHaveBeenCalledWith('/api/sessions/claude%3As1', expect.anything())
  })

  it('does not PATCH anything when the exited terminal has no sessionRef', () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'claude', createRequestId: 'r-orphan', status: 'exited',
    })
    store.dispatch(applyPaneRename({ tabId, paneId, title: 'Nowhere to go' }))
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })
})

describe('OverviewView TerminalCard rename', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the terminal AND mirrors the title into paneTitles with setByUser: true', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: 'Overview name', description: 'a desc',
    })
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-1', {
      titleOverride: 'Overview name',
      descriptionOverride: 'a desc',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Overview name')
    expect(store.getState().panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
  })

  it('lands even on a previously user-renamed pane (user rename policy, Scope Decision 3)', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    store.dispatch(updatePaneTitle({ tabId, paneId, title: 'Mine' })) // sticky user title
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: 'Overview wins', description: '',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Overview wins')
  })

  it('does not dispatch a pane mirror for a blank title (description-only edit)', async () => {
    const { store, tabId, paneId } = terminalStore({
      kind: 'terminal', mode: 'shell', terminalId: 'term-1', createRequestId: 'r-term', status: 'running',
    })
    const before = store.getState().panes.paneTitles[tabId][paneId]
    await renameOverviewTerminal({
      dispatch: store.dispatch as never, terminalId: 'term-1', title: '', description: 'only desc',
    })
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/terminals/term-1', {
      titleOverride: undefined,
      descriptionOverride: 'only desc',
    })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe(before)
  })
})

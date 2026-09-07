import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle, updatePaneTitleBySessionRef } from '@/store/panesSlice'
import { applySessionRenameCascade, clearSessionTitleOverride } from '@/store/titleSync'
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

describe('clearSessionTitleOverride (reset to provider title)', () => {
  beforeEach(() => apiMocks.patch.mockClear())

  it('PATCHes the session with titleOverride:null by composite key', async () => {
    await clearSessionTitleOverride('claude', 's1')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/claude%3As1', { titleOverride: null })
  })

  it('URI-encodes the composite key as a single route segment', async () => {
    await clearSessionTitleOverride('opencode', 'a/b c')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/sessions/opencode%3Aa%2Fb%20c', { titleOverride: null })
  })

  it('propagates server errors (caller surfaces them in the dialog)', async () => {
    apiMocks.patch.mockRejectedValueOnce(new Error('500 boom'))
    await expect(clearSessionTitleOverride('opencode', 'z9')).rejects.toThrow('500 boom')
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

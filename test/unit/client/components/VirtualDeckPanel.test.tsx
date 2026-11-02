import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

const sendMock = vi.fn()
vi.mock('@/lib/ws-client', () => ({ getWsClient: () => ({ send: sendMock }) }))

import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import claudeActivityReducer from '@/store/claudeActivitySlice'
import amplifierActivityReducer from '@/store/amplifierActivitySlice'
import antigravityActivityReducer from '@/store/antigravityActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import deckReducer, { setVirtualDeckOpen } from '@/store/deckSlice'
import VirtualDeckPanel from '@/components/VirtualDeckPanel'

const reducer = {
  tabs: tabsReducer, panes: panesReducer, turnCompletion: turnCompletionReducer,
  freshAgent: freshAgentReducer, codexActivity: codexActivityReducer,
  claudeActivity: claudeActivityReducer, amplifierActivity: amplifierActivityReducer,
  antigravityActivity: antigravityActivityReducer,
  opencodeActivity: opencodeActivityReducer, paneRuntimeActivity: paneRuntimeActivityReducer,
  settings: settingsReducer, terminalMeta: terminalMetaReducer, repoIcons: repoIconsReducer,
  deck: deckReducer,
}

// Mirrors the Task 3 fixture builder with two seeded tabs: tabs t1/t2, terminal
// leaf panes p1/p2 with terminalId term-N (mode 'claude').
function makeStore() {
  const tabCount = 2
  const tabs = Array.from({ length: tabCount }, (_, i) => ({
    id: `t${i + 1}`, createRequestId: `c${i + 1}`, title: `tab${i + 1}`, status: 'running', mode: 'shell', createdAt: i + 1,
  }))
  const layouts: Record<string, unknown> = {}
  const activePane: Record<string, string> = {}
  for (let i = 1; i <= tabCount; i++) {
    layouts[`t${i}`] = {
      type: 'leaf', id: `p${i}`,
      content: { kind: 'terminal', terminalId: `term-${i}`, createRequestId: `c${i}`, status: 'running', mode: 'claude' },
    }
    activePane[`t${i}`] = `p${i}`
  }
  return configureStore({
    reducer,
    preloadedState: {
      tabs: { tabs, activeTabId: 't1', renameRequestTabId: null, tombstones: [] },
      panes: {
        layouts, activePane,
        paneTitles: {}, paneTitleSetByUser: {}, renameRequestTabId: null, renameRequestPaneId: null,
        zoomedPane: {}, refreshRequestsByPane: {}, restoreFallbackAttemptsByPane: {},
      },
    } as never,
  })
}

function renderPanel() {
  const store = makeStore()
  render(
    <Provider store={store}>
      <VirtualDeckPanel />
    </Provider>,
  )
  return store
}

function openPanel(store: ReturnType<typeof makeStore>) {
  act(() => {
    store.dispatch(setVirtualDeckOpen(true))
  })
}

describe('VirtualDeckPanel', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing while closed, opens with a dialog and 6 key buttons on Mini', () => {
    const store = renderPanel()
    expect(screen.queryByRole('dialog')).toBeNull()
    openPanel(store)
    expect(screen.getByRole('dialog', { name: 'Virtual Stream Deck' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /deck key/i })).toHaveLength(6)
  })

  it('clicking key 2 focuses the last tab in tab-bar order (default auto layout is reversed on Mini; key 1 is the pager)', () => {
    // The real settings reducer defaults keyLayout to 'auto', which resolves
    // REVERSED on the 6-key Mini: physical key 0 ('Deck key 1') is the pager,
    // and 'Deck key 2' (physical key 1) shows the LAST tab in tab-bar order (t2).
    const store = renderPanel()
    openPanel(store)
    expect(store.getState().tabs.activeTabId).toBe('t1')
    const key2 = screen.getByRole('button', { name: 'Deck key 2' })
    fireEvent.pointerDown(key2)
    fireEvent.pointerUp(key2)
    expect(store.getState().tabs.activeTabId).toBe('t2')
    // Pressing the pager key is a page wrap, never a focus change.
    const key1 = screen.getByRole('button', { name: 'Deck key 1' })
    fireEvent.pointerDown(key1)
    fireEvent.pointerUp(key1)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('Mini defaults to newest-first: Deck key 1 is the pager and Deck key 2 focuses the newest tab', () => {
    // Default settings keyLayout 'auto' + MINI_CAPS (6 keys) => reversed
    // arrangement. This test pins the DEFAULT itself, not a seeded value.
    const store = renderPanel()
    openPanel(store)
    expect(store.getState().settings.settings.streamDeck.keyLayout).toBe('auto')
    expect(store.getState().tabs.activeTabId).toBe('t1')
    // Deck key 2 (physical key index 1) shows the LAST tab in tab-bar order.
    const key2 = screen.getByRole('button', { name: 'Deck key 2' })
    fireEvent.pointerDown(key2)
    fireEvent.pointerUp(key2)
    expect(store.getState().tabs.activeTabId).toBe('t2')
    // Deck key 1 is the pager; with a single page pressing it changes no tab.
    const key1 = screen.getByRole('button', { name: 'Deck key 1' })
    fireEvent.pointerDown(key1)
    fireEvent.pointerUp(key1)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('Plus profile honors an explicit Newest first selection (pager on Deck key 1)', () => {
    const store = renderPanel()
    openPanel(store)
    act(() => {
      store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Plus' }))
    expect(screen.getAllByRole('button', { name: /deck key/i })).toHaveLength(8)
    // Reversed on the 8-key Plus too: Deck key 2 (physical index 1) is the
    // newest tab (t2, last in tab-bar order).
    const key2 = screen.getByRole('button', { name: 'Deck key 2' })
    fireEvent.pointerDown(key2)
    fireEvent.pointerUp(key2)
    expect(store.getState().tabs.activeTabId).toBe('t2')
    // Deck key 1 stays the pager: pressing it never changes the active tab.
    const key1 = screen.getByRole('button', { name: 'Deck key 1' })
    fireEvent.pointerDown(key1)
    fireEvent.pointerUp(key1)
    expect(store.getState().tabs.activeTabId).toBe('t2')
  })

  it('switching to the Plus profile shows 8 keys and dial controls', () => {
    const store = renderPanel()
    openPanel(store)
    fireEvent.click(screen.getByRole('button', { name: 'Plus' }))
    expect(screen.getAllByRole('button', { name: /deck key/i })).toHaveLength(8)
    expect(screen.getByRole('button', { name: 'Dial 1 rotate left' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dial 1 rotate right' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Press dial 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dial 2 rotate left' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dial 2 rotate right' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Press dial 2' })).toBeTruthy()
  })

  it('close button clears virtualDeckOpen', () => {
    const store = renderPanel()
    openPanel(store)
    fireEvent.click(screen.getByRole('button', { name: 'Close virtual deck' }))
    expect(store.getState().deck.virtualDeckOpen).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

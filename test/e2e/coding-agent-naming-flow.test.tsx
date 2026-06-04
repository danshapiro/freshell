import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabBar from '@/components/TabBar'
import tabsReducer, { openSessionTab, addTab, updateTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitleByTerminalId } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import { applyTabRename } from '@/store/titleSync'
import { getTabDisplayTitle } from '@/lib/tab-title'
import type { Tab } from '@/store/types'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn(), connect: vi.fn(), onMessage: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) }),
}))
vi.mock('@/lib/api', () => ({ api: { patch: vi.fn().mockResolvedValue({}) } }))
vi.mock('@/components/icons/PaneIcon', () => ({ default: () => <svg data-testid="pane-icon" /> }))

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: { settings: { settings: defaultSettings, loaded: true, lastSavedAt: null } } as never,
  })
}

describe('coding-agent naming flow (e2e)', () => {
  afterEach(() => cleanup())

  it('shows the dir name immediately, follows the server name, keeps a shell sibling separate, and freezes on rename', async () => {
    const store = createStore()
    const display = (tab: Tab) => {
      const s = store.getState()
      return getTabDisplayTitle(tab, s.panes.layouts[tab.id], s.panes.paneTitles[tab.id], s.extensions?.entries)
    }
    const claudeTab = () => store.getState().tabs.tabs.find((t) => t.mode === 'claude')!
    const shellTab = () => store.getState().tabs.tabs.find((t) => t.id === 'tab-shell')!

    // A coding-agent (claude) terminal opened in /home/dan/code/freshell.
    await act(async () => {
      await store.dispatch(openSessionTab({ provider: 'claude', cwd: '/home/dan/code/freshell', terminalId: 'term-claude', forceNew: true }) as never)
    })
    // A sibling plain shell tab (scope guard: must keep its own name).
    act(() => {
      store.dispatch(addTab({ id: 'tab-shell', mode: 'shell', shell: 'wsl' }))
      store.dispatch(initLayout({ tabId: 'tab-shell', content: { kind: 'terminal', mode: 'shell', shell: 'wsl', terminalId: 'term-shell' } }))
    })

    render(<Provider store={store}><TabBar /></Provider>)

    // 1. Dir name shows immediately for the coding agent; the shell keeps a shell name.
    expect(display(claudeTab())).toBe('freshell')
    expect(display(shellTab())).toBe('Shell')
    expect(screen.getAllByText('freshell').length).toBeGreaterThan(0)

    const claudeId = claudeTab().id

    // 2. Server promotes the first-message / Gemini name -> the tab follows it.
    act(() => {
      store.dispatch(updatePaneTitleByTerminalId({ terminalId: 'term-claude', title: 'Fix the login bug', setByUser: false }))
      store.dispatch(updateTab({ id: claudeId, updates: { title: 'Fix the login bug' } }))
    })
    expect(display(claudeTab())).toBe('Fix the login bug')
    expect(screen.getAllByText('Fix the login bug').length).toBeGreaterThan(0)
    expect(display(shellTab())).toBe('Shell') // sibling untouched

    // 3. User renames -> it changes.
    act(() => {
      store.dispatch(applyTabRename({ tabId: claudeId, title: 'My Project' }) as never)
    })
    expect(display(claudeTab())).toBe('My Project')
    expect(screen.getAllByText('My Project').length).toBeGreaterThan(0)

    // 4. ...and is then frozen against later automatic updates.
    act(() => {
      store.dispatch(updatePaneTitleByTerminalId({ terminalId: 'term-claude', title: 'Stale auto name', setByUser: false }))
    })
    expect(display(claudeTab())).toBe('My Project')
    expect(screen.queryByText('Stale auto name')).not.toBeInTheDocument()
  })
})

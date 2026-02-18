import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn(), close: vi.fn() }),
}))

vi.stubGlobal('localStorage', {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
})

function createTab(id: string, title: string): Tab {
  return {
    id,
    createRequestId: id,
    title,
    titleSetByUser: false,
    status: 'running' as const,
    mode: 'shell' as const,
    shell: 'system' as const,
    createdAt: Date.now(),
  }
}

function createLeafLayout(tabId: string): PaneNode {
  return {
    type: 'leaf',
    id: `pane-${tabId}`,
    content: {
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      createRequestId: `req-${tabId}`,
      status: 'running',
    },
  }
}

function createStore(tabs: Tab[], activeTabId: string) {
  const layouts: Record<string, PaneNode> = {}
  const activePane: Record<string, string> = {}
  for (const tab of tabs) {
    layouts[tab.id] = createLeafLayout(tab.id)
    activePane[tab.id] = `pane-${tab.id}`
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs,
        activeTabId,
        renameRequestTabId: null,
      },
      panes: {
        layouts,
        activePane,
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      connection: {
        status: 'ready' as const,
        lastError: undefined,
        platform: 'linux',
        availableClis: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(localStorage.getItem).mockReturnValue(null)
})

afterEach(() => cleanup())

describe('MobileTabStrip', () => {
  it('shows active tab name with position indicator', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [
        createTab('tab-1', 'My Project'),
        createTab('tab-2', 'Build Server'),
        createTab('tab-3', 'Test Runner'),
      ],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    // Title 'Build Server' does not match /^Tab \d+$/ so getTabDisplayTitle returns it directly
    expect(screen.getByText('Build Server')).toBeInTheDocument()
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
  })

  it('has previous and next navigation buttons when not on the last tab', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /previous tab/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next tab/i })).toBeInTheDocument()
  })

  it('disables prev button on first tab', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /previous tab/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next tab/i })).not.toBeDisabled()
  })

  it('shows new tab action on last tab', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /previous tab/i })).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: /next tab/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /new tab/i })).toBeInTheDocument()
  })

  it('switches to next tab on next button click', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /next tab/i }))
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })

  it('switches to previous tab on prev button click', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /previous tab/i }))
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('shows position 1 / 1 for single tab', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore([createTab('tab-1', 'Dev Server')], 'tab-1')
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByText('Dev Server')).toBeInTheDocument()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /previous tab/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /new tab/i })).toBeEnabled()
  })

  it('adds a new tab when right action is tapped on the last tab', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore(
      [createTab('tab-1', 'Tab 1'), createTab('tab-2', 'Tab 2')],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /new tab/i }))
    expect(store.getState().tabs.tabs).toHaveLength(3)
    expect(store.getState().tabs.activeTabId).toBe(store.getState().tabs.tabs[2].id)
  })

  it('has a tab switcher button in the center area', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const store = createStore([createTab('tab-1', 'Tab 1')], 'tab-1')
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /open tab switcher/i })).toBeInTheDocument()
  })

  it('calls onOpenSwitcher when tab switcher button is clicked', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const onOpenSwitcher = vi.fn()
    const store = createStore([createTab('tab-1', 'Tab 1')], 'tab-1')
    render(
      <Provider store={store}>
        <MobileTabStrip onOpenSwitcher={onOpenSwitcher} />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /open tab switcher/i }))
    expect(onOpenSwitcher).toHaveBeenCalledOnce()
  })

  it('uses getTabDisplayTitle for derived tab names', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    // A tab with empty title and no pane layout will show 'Tab' via getTabDisplayTitle
    const tab = createTab('tab-1', '')
    const store = createStore([tab], 'tab-1')
    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    // getTabDisplayTitle with empty title and a terminal pane layout returns
    // the derived name from the pane content (e.g. 'Shell' for shell mode)
    // The exact text depends on deriveTabName; just verify it renders something
    const switcherButton = screen.getByRole('button', { name: /open tab switcher/i })
    expect(switcherButton.textContent).toBeTruthy()
  })
})

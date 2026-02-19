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

function createTab(id: string, title: string, overrides?: Partial<Tab>): Tab {
  return {
    id,
    createRequestId: id,
    title,
    titleSetByUser: false,
    status: 'running' as const,
    mode: 'shell' as const,
    shell: 'system' as const,
    createdAt: Date.now(),
    ...overrides,
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

describe('TabSwitcher', () => {
  it('renders all tabs as cards', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
        createTab('tab-3', 'Codex'),
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })

  it('highlights the active tab with a ring', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
      ],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    const claudeCard = screen.getByRole('button', { name: /switch to claude/i })
    expect(claudeCard.className).toMatch(/ring-2/)
  })

  it('does not highlight inactive tabs', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
      ],
      'tab-2'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    const shellCard = screen.getByRole('button', { name: /switch to shell/i })
    expect(shellCard.className).not.toMatch(/ring-2/)
  })

  it('switches tab and closes on card tap', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const onClose = vi.fn()
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={onClose} />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /switch to claude/i }))
    expect(onClose).toHaveBeenCalled()
    expect(store.getState().tabs.activeTabId).toBe('tab-2')
  })

  it('closes without changing tab when tapping the active tab card', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const onClose = vi.fn()
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={onClose} />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /switch to shell/i }))
    expect(onClose).toHaveBeenCalled()
    expect(store.getState().tabs.activeTabId).toBe('tab-1')
  })

  it('has a new tab card', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [createTab('tab-1', 'Shell')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /new tab/i })).toBeInTheDocument()
  })

  it('creates a new tab and closes when new tab card is tapped', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const onClose = vi.fn()
    const store = createStore(
      [createTab('tab-1', 'Shell')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={onClose} />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /new tab/i }))
    expect(onClose).toHaveBeenCalled()
    expect(store.getState().tabs.tabs).toHaveLength(2)
  })

  it('has a close button', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [createTab('tab-1', 'Shell')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByRole('button', { name: /close tab switcher/i })).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const onClose = vi.fn()
    const store = createStore(
      [createTab('tab-1', 'Shell')],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={onClose} />
      </Provider>
    )

    fireEvent.click(screen.getByRole('button', { name: /close tab switcher/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows tab count in header', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
        createTab('tab-3', 'Codex'),
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByText('3 Tabs')).toBeInTheDocument()
  })

  it('shows status text for each tab', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell', { status: 'running' }),
        createTab('tab-2', 'Build', { status: 'exited' }),
        createTab('tab-3', 'Setup', { status: 'creating' }),
      ],
      'tab-1'
    )
    render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Exited')).toBeInTheDocument()
    expect(screen.getByText('Creating...')).toBeInTheDocument()
  })

  it('is rendered as a fullscreen overlay', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [createTab('tab-1', 'Shell')],
      'tab-1'
    )
    const { container } = render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    const overlay = container.firstElementChild as HTMLElement
    expect(overlay.className).toMatch(/fixed/)
    expect(overlay.className).toMatch(/inset-0/)
    expect(overlay.className).toMatch(/z-50/)
  })

  it('uses a 2-column grid layout for tab cards', async () => {
    const { TabSwitcher } = await import('@/components/TabSwitcher')
    const store = createStore(
      [
        createTab('tab-1', 'Shell'),
        createTab('tab-2', 'Claude'),
      ],
      'tab-1'
    )
    const { container } = render(
      <Provider store={store}>
        <TabSwitcher onClose={() => {}} />
      </Provider>
    )

    const grid = container.querySelector('.grid-cols-2')
    expect(grid).toBeTruthy()
  })
})

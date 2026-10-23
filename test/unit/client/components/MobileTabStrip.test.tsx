import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import opencodeActivityReducer, { type OpencodeActivityState } from '@/store/opencodeActivitySlice'
import turnCompletionReducer, { markTabAttention } from '@/store/turnCompletionSlice'
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

function createLeafLayout(tab: Tab): PaneNode {
  return {
    type: 'leaf',
    id: `pane-${tab.id}`,
    content: {
      kind: 'terminal',
      mode: tab.mode,
      shell: tab.shell || 'system',
      createRequestId: `req-${tab.id}`,
      status: tab.status,
      terminalId: tab.terminalId,
    },
  }
}

function createStore(
  tabs: Tab[],
  activeTabId: string,
  opts?: {
    codexActivity?: Partial<CodexActivityState>
    opencodeActivity?: Partial<OpencodeActivityState>
    includeCodexActivity?: boolean
    includeOpencodeActivity?: boolean
    attentionByTab?: Record<string, boolean>
    attentionByPane?: Record<string, boolean>
    watchedCompletionByTab?: Record<string, boolean>
    tabAttentionStyle?: 'highlight' | 'pulse' | 'darken' | 'none'
    attentionDismiss?: 'click' | 'type'
  },
) {
  const layouts: Record<string, PaneNode> = {}
  const activePane: Record<string, string> = {}
  for (const tab of tabs) {
    layouts[tab.id] = createLeafLayout(tab)
    activePane[tab.id] = `pane-${tab.id}`
  }

  const includeCodexActivity = opts?.includeCodexActivity ?? true
  const defaultCodexActivity: CodexActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
  const includeOpencodeActivity = opts?.includeOpencodeActivity ?? true
  const defaultOpencodeActivity: OpencodeActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }

  const reducer = {
    tabs: tabsReducer,
    panes: panesReducer,
    connection: connectionReducer,
    settings: settingsReducer,
    turnCompletion: turnCompletionReducer,
    ...(includeCodexActivity ? { codexActivity: codexActivityReducer } : {}),
    ...(includeOpencodeActivity ? { opencodeActivity: opencodeActivityReducer } : {}),
  }
  const preloadedState: Record<string, unknown> = {
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
      settings: {
        ...defaultSettings,
        panes: {
          ...defaultSettings.panes,
          ...(opts?.tabAttentionStyle ? { tabAttentionStyle: opts.tabAttentionStyle } : {}),
          ...(opts?.attentionDismiss ? { attentionDismiss: opts.attentionDismiss } : {}),
        },
      },
      loaded: true,
    },
    turnCompletion: {
      seq: 0,
      lastAtByTerminalId: {},
      lastIdleAtByTerminalId: {},
      pendingEvents: [],
      attentionByTab: opts?.attentionByTab ?? {},
      attentionByPane: opts?.attentionByPane ?? {},
      watchedCompletionByTab: opts?.watchedCompletionByTab ?? {},
    },
  }
  if (includeCodexActivity) {
    preloadedState.codexActivity = {
      ...defaultCodexActivity,
      ...(opts?.codexActivity ?? {}),
    }
  }
  if (includeOpencodeActivity) {
    preloadedState.opencodeActivity = {
      ...defaultOpencodeActivity,
      ...(opts?.opencodeActivity ?? {}),
    }
  }

  return configureStore({
    reducer,
    preloadedState,
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

  it('shows a busy badge when the active codex tab has exact busy activity', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const codexTab = createTab('tab-1', 'Codex', {
      mode: 'codex',
      terminalId: 'term-codex',
    })
    const store = createStore([codexTab], 'tab-1', {
      codexActivity: {
        byTerminalId: {
          'term-codex': {
            terminalId: 'term-codex',
            sessionId: 'session-codex',
            phase: 'busy',
            updatedAt: 10,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    const badge = screen.getByTestId('mobile-tab-busy-badge')
    expect(badge).toHaveTextContent('Busy')
    expect(badge.className).toContain('bg-blue-500/15')
    expect(badge.className).toContain('text-blue-600')
    expect(badge.className).not.toContain('animate-pulse')
  })

  it('shows a busy badge when the active opencode tab has exact busy activity', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const opencodeTab = createTab('tab-1', 'OpenCode', {
      mode: 'opencode',
      terminalId: 'term-opencode',
    })
    const store = createStore([opencodeTab], 'tab-1', {
      opencodeActivity: {
        byTerminalId: {
          'term-opencode': {
            terminalId: 'term-opencode',
            sessionId: 'session-opencode',
            phase: 'busy',
            updatedAt: 10,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <MobileTabStrip />
      </Provider>
    )

    const badge = screen.getByTestId('mobile-tab-busy-badge')
    expect(badge).toHaveTextContent('Busy')
    expect(badge.className).toContain('bg-blue-500/15')
    expect(badge.className).toContain('text-blue-600')
  })

  it('does not warn about selector instability when codex activity state is absent', async () => {
    const { MobileTabStrip } = await import('@/components/MobileTabStrip')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createStore([createTab('tab-1', 'Tab 1')], 'tab-1', {
      includeCodexActivity: false,
    })

    try {
      render(
        <Provider store={store}>
          <MobileTabStrip />
        </Provider>
      )

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('returned a different result when called with the same parameters'),
        expect.anything(),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  describe('needs-attention marks (G17)', () => {
    const fourTabs = () => [
      createTab('tab-1', 'Alpha'),
      createTab('tab-2', 'Bravo'),
      createTab('tab-3', 'Charlie'),
      createTab('tab-4', 'Delta'),
    ]

    // The "other tabs" status is a polite live region that stays mounted
    // (empty while no other tab is marked); its label is the region's text.
    const otherTabsStatus = () => screen.getByRole('status')
    // The visible chevron mark is decorative (aria-hidden; the chevron's
    // accessible description carries the meaning), so it has no role to query.
    const chevronDot = (name: string) =>
      screen.getByRole('button', { name }).querySelector('span[aria-hidden="true"]')

    async function renderStrip(store: ReturnType<typeof createStore>) {
      const { MobileTabStrip } = await import('@/components/MobileTabStrip')
      render(
        <Provider store={store}>
          <MobileTabStrip />
        </Provider>
      )
    }

    it('marks the active tab title when the active tab needs attention', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2', { attentionByTab: { 'tab-2': true } }))

      expect(screen.getByText('Bravo')).toHaveClass('bg-emerald-100')
      expect(screen.getByRole('button', { name: 'Open tab switcher' }))
        .toHaveAccessibleDescription('This tab needs attention')
      expect(otherTabsStatus()).toBeEmptyDOMElement()
    })

    it('counts the OTHER tabs that need attention in a status', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2', {
        attentionByTab: { 'tab-1': true, 'tab-2': true, 'tab-4': true },
      }))

      expect(within(otherTabsStatus()).getByText('2 other tabs need attention')).toBeInTheDocument()
    })

    it('dots only the chevron toward the tabs that need attention', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2', { attentionByTab: { 'tab-4': true } }))

      expect(screen.getByRole('button', { name: 'Next tab' }))
        .toHaveAccessibleDescription('A later tab needs attention')
      expect(screen.getByRole('button', { name: 'Previous tab' })).toHaveAccessibleDescription('')
      expect(within(otherTabsStatus()).getByText('1 other tab needs attention')).toBeInTheDocument()
      expect(chevronDot('Next tab')).toHaveClass('rounded-full', 'bg-emerald-500')
      expect(chevronDot('Previous tab')).toBeNull()
    })

    it('dots the previous chevron for an earlier tab that needs attention', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-3', { attentionByTab: { 'tab-1': true } }))

      expect(screen.getByRole('button', { name: 'Previous tab' }))
        .toHaveAccessibleDescription('An earlier tab needs attention')
      expect(screen.getByRole('button', { name: 'Next tab' })).toHaveAccessibleDescription('')
      expect(chevronDot('Previous tab')).toHaveClass('rounded-full', 'bg-emerald-500')
      expect(chevronDot('Next tab')).toBeNull()
    })

    it('draws the chevron dot in the user\'s attention style', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2', {
        tabAttentionStyle: 'darken',
        attentionByTab: { 'tab-1': true, 'tab-4': true },
      }))

      for (const name of ['Previous tab', 'Next tab']) {
        expect(chevronDot(name)).toHaveClass('rounded-full', 'bg-foreground/60')
        expect(chevronDot(name)).not.toHaveClass('bg-emerald-500')
      }
    })

    it('counts watched-completion marks like attention marks', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-1', { watchedCompletionByTab: { 'tab-3': true } }))

      expect(within(otherTabsStatus()).getByText('1 other tab needs attention')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Next tab' }))
        .toHaveAccessibleDescription('A later tab needs attention')
    })

    it('shows no mark at all when the attention style is none', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2', {
        tabAttentionStyle: 'none',
        attentionByTab: { 'tab-1': true, 'tab-2': true, 'tab-4': true },
      }))

      expect(otherTabsStatus()).toBeEmptyDOMElement()
      expect(screen.getByText('Bravo')).not.toHaveClass('bg-emerald-100')
      expect(screen.getByRole('button', { name: 'Open tab switcher' })).toHaveAccessibleDescription('')
      expect(screen.getByRole('button', { name: 'Next tab' })).toHaveAccessibleDescription('')
      expect(screen.getByRole('button', { name: 'Previous tab' })).toHaveAccessibleDescription('')
      expect(chevronDot('Next tab')).toBeNull()
      expect(chevronDot('Previous tab')).toBeNull()
    })

    it('shows no mark when no tab needs attention', async () => {
      await renderStrip(createStore(fourTabs(), 'tab-2'))

      expect(otherTabsStatus()).toBeEmptyDOMElement()
      expect(screen.getByText('Bravo')).not.toHaveClass('bg-emerald-100')
    })

    it('announces a new mark as text added to the status that was already mounted', async () => {
      const store = createStore(fourTabs(), 'tab-2')
      await renderStrip(store)
      const status = otherTabsStatus()
      expect(status).toBeEmptyDOMElement()

      act(() => { store.dispatch(markTabAttention({ tabId: 'tab-4' })) })
      expect(otherTabsStatus()).toBe(status)
      expect(within(status).getByText('1 other tab needs attention')).toBeInTheDocument()

      act(() => { store.dispatch(markTabAttention({ tabId: 'tab-1' })) })
      expect(otherTabsStatus()).toBe(status)
      expect(within(status).getByText('2 other tabs need attention')).toBeInTheDocument()
    })
  })
})

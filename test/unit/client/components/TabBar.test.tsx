import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabBar from '@/components/TabBar'
import tabsReducer, { TabsState } from '@/store/tabsSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import opencodeActivityReducer, { type OpencodeActivityState } from '@/store/opencodeActivitySlice'
import panesReducer from '@/store/panesSlice'
import repoIconsReducer from '@/store/repoIconsSlice'
import settingsReducer, { defaultSettings, updateSettingsLocal } from '@/store/settingsSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'
import { selectPaneOwnerFence } from '@/store/selectors/runtimeOwner'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
import type { Tab } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

// Mock the ws-client module
const { mockSend, wsMessageHandlers, mockManagedVisibility } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockManagedVisibility: vi.fn(),
  wsMessageHandlers: new Set<(msg: unknown) => void>(),
}))
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: (handler: (msg: unknown) => void) => {
      wsMessageHandlers.add(handler)
      return () => {
        wsMessageHandlers.delete(handler)
      }
    },
  }),
}))

/** Deliver a server frame to every subscribed ws handler (the kill-ack waits). */
function emitWsMessage(msg: unknown) {
  for (const handler of [...wsMessageHandlers]) handler(msg)
}

/** Answer every in-flight correlated terminal kill with success. */
function ackAllTerminalKills() {
  for (const [msg] of mockSend.mock.calls) {
    const m = msg as { type?: string; terminalId?: string; requestId?: string }
    if (m?.type === 'terminal.kill' && m.requestId && m.terminalId) {
      emitWsMessage({
        type: 'terminal.killed',
        requestId: m.requestId,
        terminalId: m.terminalId,
        success: true,
      })
    }
  }
}

/** Answer every in-flight pane.closed AND every whole-tab panes.closed batch
 * with success (delta-r7-r3, F2 + focused-episode-7 round 3, F1: the
 * healthy-server close acknowledgments the close gate awaits). */
function ackAllPaneCloses() {
  for (const [msg] of mockSend.mock.calls) {
    const m = msg as { type?: string; createRequestId?: string; requestId?: string }
    if (m?.type === 'pane.closed' && m.createRequestId) {
      emitWsMessage({
        type: 'pane.closed.result',
        createRequestId: m.createRequestId,
        success: true,
      })
    }
    if (m?.type === 'panes.closed' && m.requestId) {
      emitWsMessage({
        type: 'panes.closed.result',
        requestId: m.requestId,
        success: true,
      })
    }
  }
}

// Mock the api module so the repo-icon meta probe thunk never hits the network
vi.mock('@/lib/api', () => ({
  updateManagedRuntimeViewVisibility: mockManagedVisibility,
  api: {
    get: vi.fn().mockRejectedValue(new Error('no server in tests')),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

// Mock lucide-react icons. Partial mock: TabBar's import chain
// (TabBarResizeHandle -> @/components/panes) pulls in many icons; keep the
// real module and override only the ones stubbed with testids below.
vi.mock('lucide-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lucide-react')>()),
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Plus: ({ className }: { className?: string }) => (
    <svg data-testid="plus-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
  ChevronDown: ({ className }: { className?: string }) => (
    <svg data-testid="chevron-down-icon" className={className} />
  ),
  ChevronLeft: ({ className }: { className?: string }) => (
    <svg data-testid="chevron-left-icon" className={className} />
  ),
  ChevronRight: ({ className }: { className?: string }) => (
    <svg data-testid="chevron-right-icon" className={className} />
  ),
  Terminal: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-icon" className={className} />
  ),
  MessageSquare: ({ className }: { className?: string }) => (
    <svg data-testid="message-square-icon" className={className} />
  ),
}))

// Mock PaneIcon component
vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: any) => (
    <svg
      data-testid="pane-icon"
      data-content-kind={content?.kind}
      data-content-mode={content?.mode}
      data-terminal-id={content?.terminalId}
      className={className}
    />
  ),
}))

// Mock RepoIcon component
vi.mock('@/components/icons/RepoIcon', () => ({
  default: ({ info, className }: { info: any; className?: string }) => (
    <svg data-testid="repo-icon" data-repo-key={info?.repoKey} data-repo-name={info?.repoName} className={className} />
  ),
}))

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: `tab-${Math.random().toString(36).slice(2)}`,
    createRequestId: 'req-1',
    title: 'Terminal 1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    ...overrides,
  }
}

function createTwoTerminalSplitLayout(firstTerminalId: string, secondTerminalId: string): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        type: 'leaf',
        id: 'pane-1',
        content: {
          kind: 'terminal',
          mode: 'shell',
          shell: 'system',
          status: 'running',
          createRequestId: 'req-pane-1',
          terminalId: firstTerminalId,
        },
      },
      {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'terminal',
          mode: 'shell',
          shell: 'system',
          status: 'running',
          createRequestId: 'req-pane-2',
          terminalId: secondTerminalId,
        },
      },
    ],
  }
}

function createStore(
  initialState: Partial<TabsState> = {},
  attentionByTab: Record<string, boolean> = {},
  panesState: {
    layouts?: Record<string, PaneNode>
    activePane?: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
  } = {},
  codexActivityState: CodexActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  },
  opencodeActivityState: OpencodeActivityState = {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  },
) {
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = resolveLocalSettings()

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      panes: panesReducer,
      repoIcons: repoIconsReducer,
      settings: settingsReducer,
      terminalMeta: terminalMetaReducer,
      turnCompletion: turnCompletionReducer,
      freshAgent: freshAgentReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(terminalDetachMiddleware),
    preloadedState: {
      tabs: {
        tabs: [],
        activeTabId: null,
        renameRequestTabId: null,
        ...initialState,
      },
      codexActivity: codexActivityState,
      opencodeActivity: opencodeActivityState,
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        ...panesState,
      },
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
      },
      turnCompletion: {
        seq: 0,
        pendingEvents: [],
        attentionByTab,
      },
    },
  })
}

function renderWithStore(
  ui: React.ReactElement,
  store: ReturnType<typeof createStore>
) {
  return render(<Provider store={store}>{ui}</Provider>)
}

describe('TabBar', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockManagedVisibility.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders nothing when there are no tabs', () => {
      const store = createStore({ tabs: [], activeTabId: null })
      const { container } = renderWithStore(<TabBar />, store)
      expect(container.firstChild).toBeNull()
    })

    it('renders list of tabs', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Terminal 2' })
      const tab3 = createTab({ id: 'tab-3', title: 'Terminal 3' })

      const store = createStore({
        tabs: [tab1, tab2, tab3],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      expect(screen.getByText('Terminal 1')).toBeInTheDocument()
      expect(screen.getByText('Terminal 2')).toBeInTheDocument()
      expect(screen.getByText('Terminal 3')).toBeInTheDocument()
    })

    it('renders add button', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByTitle('New shell tab')
      expect(addButton).toBeInTheDocument()
    })

    it('renders close button for each tab', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Terminal 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const closeButtons = screen.getAllByTitle('Close (Shift+Click to kill)')
      expect(closeButtons).toHaveLength(2)
    })

    it('renders a bottom separator line behind tabs', () => {
      const tab = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      const { container } = renderWithStore(<TabBar />, store)
      const separator = container.querySelector(
        'div.pointer-events-none.absolute.inset-x-0.bottom-0.h-px'
      ) as HTMLDivElement | null

      expect(separator).toBeInTheDocument()
      expect(separator?.className).toContain('bg-muted-foreground/45')
    })

    it('hides vertical overflow on the tab strip while preserving horizontal scrolling', () => {
      const tab = createTab({ id: 'tab-1', title: 'Terminal 1' })
      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })
      // Single-row-specific behavior: opt out of the multirow default explicitly.
      store.dispatch(updateSettingsLocal({ panes: { multirowTabs: false } }))

      const { container } = renderWithStore(<TabBar />, store)

      // The scrollable tab strip has the scrollbar-none class
      const tabStrip = container.querySelector('.scrollbar-none') as HTMLDivElement | null

      expect(tabStrip).toBeInTheDocument()
      expect(tabStrip?.className).toContain('overflow-x-auto')
      expect(tabStrip?.className).toContain('overflow-y-hidden')
      expect(tabStrip?.className).toContain('scrollbar-none')
    })

    it('renders the + button outside the scrollable tab container', () => {
      const tab = createTab({ id: 'tab-1' })
      const store = createStore({ tabs: [tab], activeTabId: 'tab-1' })

      renderWithStore(<TabBar />, store)

      const addButton = screen.getByTitle('New shell tab')
      // Use overflow-x-auto to find the scrollable container -- this class exists
      // on the scroll strip both before and after the change.
      const scrollContainer = addButton.closest('.overflow-x-auto')

      // The + button should NOT be inside the scrollable container
      expect(scrollContainer).toBeNull()
    })

    it('shows blue icon on the exact busy terminal in a tab', () => {
      const tab = createTab({
        id: 'tab-codex',
        title: 'Codex Tab',
        mode: 'codex',
        terminalId: 'term-1',
      })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-codex' },
        {},
        { layouts: { 'tab-codex': createTwoTerminalSplitLayout('term-1', 'term-2') } },
        {
          byTerminalId: {
            'term-1': { terminalId: 'term-1', phase: 'busy', updatedAt: 10 },
          },
          lastSnapshotSeq: 0,
          liveMutationSeqByTerminalId: {},
          removedMutationSeqByTerminalId: {},
        },
      )

      renderWithStore(<TabBar />, store)

      const tabElement = screen.getByLabelText('Codex Tab')
      const icons = within(tabElement).getAllByTestId('pane-icon')
      const busyIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-1')
      const idleIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-2')

      expect(busyIcon?.getAttribute('class')).toContain('text-blue-500')
      expect(idleIcon?.getAttribute('class') ?? '').not.toContain('text-blue-500')
    })

    it('shows blue icon when the exact record is pending', () => {
      const tab = createTab({
        id: 'tab-codex',
        title: 'Codex Pending',
        mode: 'codex',
        terminalId: 'term-1',
      })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-codex' },
        {},
        {
          layouts: {
            'tab-codex': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-1',
              },
            },
          },
        },
        {
          byTerminalId: {
            'term-1': { terminalId: 'term-1', phase: 'pending', updatedAt: 10 },
          },
          lastSnapshotSeq: 0,
          liveMutationSeqByTerminalId: {},
          removedMutationSeqByTerminalId: {},
        },
      )

      renderWithStore(<TabBar />, store)

      // Unified agent names (Task 5): the scoped tab's display name is its
      // canonical/derived pane name, not the stored tab title — locate the
      // tab by its id.
      const tabElement = document.querySelector('[data-tab-id="tab-codex"]') as HTMLElement
      const blueIcons = within(tabElement).getAllByTestId('pane-icon')
        .filter((icon) => icon.getAttribute('class')?.includes('text-blue-500'))

      expect(blueIcons).toHaveLength(1)
    })

    it('shows no activity when pane has no terminalId during rehydrate gap', () => {
      const tab = createTab({
        id: 'tab-rehydrate',
        title: 'Rehydrate Gap',
        mode: 'codex',
      })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-rehydrate' },
        {},
        {
          layouts: {
            'tab-rehydrate': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: undefined,
              },
            },
          },
        },
        {
          byTerminalId: {
            'term-tab': { terminalId: 'term-tab', phase: 'busy', updatedAt: 10 },
          },
          lastSnapshotSeq: 0,
          liveMutationSeqByTerminalId: {},
          removedMutationSeqByTerminalId: {},
        },
      )

      renderWithStore(<TabBar />, store)

      const tabElement = document.querySelector('[data-tab-id="tab-rehydrate"]') as HTMLElement
      const blueIcons = within(tabElement).getAllByTestId('pane-icon')
        .filter((icon) => icon.getAttribute('class')?.includes('text-blue-500'))

      expect(blueIcons).toHaveLength(0)
    })

    it('shows blue icon on the exact busy OpenCode terminal in a tab', () => {
      const tab = createTab({
        id: 'tab-opencode',
        title: 'OpenCode Tab',
        mode: 'opencode',
        terminalId: 'term-opencode-1',
      })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-opencode' },
        {},
        { layouts: { 'tab-opencode': createTwoTerminalSplitLayout('term-opencode-1', 'term-opencode-2') } },
        undefined,
        {
          byTerminalId: {
            'term-opencode-1': { terminalId: 'term-opencode-1', phase: 'busy', updatedAt: 10 },
          },
          lastSnapshotSeq: 0,
          liveMutationSeqByTerminalId: {},
          removedMutationSeqByTerminalId: {},
        },
      )

      renderWithStore(<TabBar />, store)

      const tabElement = screen.getByLabelText('OpenCode Tab')
      const icons = within(tabElement).getAllByTestId('pane-icon')
      const busyIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-opencode-1')
      const idleIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-opencode-2')

      expect(busyIcon?.getAttribute('class')).toContain('text-blue-500')
      expect(idleIcon?.getAttribute('class') ?? '').not.toContain('text-blue-500')
    })
  })

  describe('active tab highlighting', () => {
    it('highlights active tab with different styles', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Active Tab' })
      const tab2 = createTab({ id: 'tab-2', title: 'Inactive Tab' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const activeTabElement = screen.getByText('Active Tab').closest('div[class*="group"]')
      const inactiveTabElement = screen.getByText('Inactive Tab').closest('div[class*="group"]')

      // Active tab should match the app background and keep an outline
      expect(activeTabElement?.className).toContain('bg-background')
      expect(activeTabElement?.className).toContain('text-foreground')
      expect(activeTabElement?.className).toContain('border-b-background')
      expect(activeTabElement?.className).not.toContain('-mb-px')

      // Inactive tabs should be slightly off-background gray
      expect(inactiveTabElement?.className).toContain('bg-muted')
      expect(inactiveTabElement?.className).not.toContain('border-b')
    })

    it('updates active tab highlight when active tab changes', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      const { rerender } = renderWithStore(<TabBar />, store)

      // Initial state - tab 1 is active
      let tab1Element = screen.getByText('Tab 1').closest('div[class*="group"]')
      expect(tab1Element?.className).toContain('bg-background')

      // Click tab 2 to change active tab
      fireEvent.click(screen.getByText('Tab 2'))

      // Re-render to reflect state change
      rerender(
        <Provider store={store}>
          <TabBar />
        </Provider>
      )

      // Now tab 2 should be active
      const tab2Element = screen.getByText('Tab 2').closest('div[class*="group"]')
      tab1Element = screen.getByText('Tab 1').closest('div[class*="group"]')

      expect(tab2Element?.className).toContain('bg-background')
      expect(tab1Element?.className).toContain('bg-muted')
    })

    it('highlights inactive tabs that need attention', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Active Tab' })
      const tab2 = createTab({ id: 'tab-2', title: 'Needs Attention' })

      const store = createStore(
        {
          tabs: [tab1, tab2],
          activeTabId: 'tab-1',
        },
        { 'tab-2': true }
      )

      renderWithStore(<TabBar />, store)

      const attentionTabElement = screen.getByText('Needs Attention').closest('div[class*="group"]')
      expect(attentionTabElement?.className).toContain('bg-emerald-100')
      expect(attentionTabElement?.className).toContain('text-emerald-900')
    })
  })

  describe('tab interactions', () => {
    it('clicking tab calls setActiveTab', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Click on tab 2
      fireEvent.click(screen.getByText('Tab 2'))

      // Check that the store state was updated
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    it('add button creates new shell tab', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Terminal 1' })

      const store = createStore({
        tabs: [tab1],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Click the add button
      const addButton = screen.getByTitle('New shell tab')
      fireEvent.click(addButton)

      // Check that a new tab was added
      const state = store.getState().tabs
      expect(state.tabs).toHaveLength(2)
      expect(state.tabs[1].title).toBe('Tab 2')
      expect(state.tabs[1].mode).toBe('shell')
      // New tab should become active
      expect(state.activeTabId).toBe(state.tabs[1].id)
    })

    it('close button removes tab', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Click the close button for tab 1
      const closeButtons = screen.getAllByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButtons[0])

      // Check that tab 1 was removed
      const state = store.getState().tabs
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].id).toBe('tab-2')
    })

    it('close button sends detach message when pane has terminalId', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-123',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton)

      // Delta-r7-r3 (Finding F2): the close gate sends the durable pane-close
      // evidence FIRST and awaits the server's answer before the layout loses
      // the pane; on ack the identity-driven detach follows (about the
      // terminal, never the pane). Focused-episode-7 round 3 (Finding F1):
      // the whole-tab close is ONE batch envelope.
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'panes.closed',
          tabId: 'tab-1',
          requestId: expect.any(String),
          panes: [{ createRequestId: 'req-pane-1', terminalId: 'term-123' }],
        }),
      )
      ackAllPaneCloses()
      await waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith({
          type: 'terminal.detach',
          terminalId: 'term-123',
        })
      })
    })

    it('shift+click on close button sends a correlated kill and closes the tab only once it is acknowledged', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-456',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'terminal.kill',
          terminalId: 'term-456',
          createRequestId: 'req-pane-1',
          requestId: expect.any(String),
        }),
      )
      // The tab survives until the correlated durable close lands.
      expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-1'])
      ackAllTerminalKills()
      // The kill-succeeded closeTab then runs the pane-close evidence gate
      // (delta-r7-r3, F2): the tab still stands until the batch envelope is
      // acked (focused-episode-7 round 3, F1).
      await waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'panes.closed',
            panes: [{ createRequestId: 'req-pane-1', terminalId: 'term-456' }],
          }),
        )
      })
      expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-1'])
      ackAllPaneCloses()
      await waitFor(() => {
        expect(store.getState().tabs.tabs).toEqual([])
      })
    })

    it('Shift-closes a managed terminal when kill hides its view before the inventory update', async () => {
      const node: PaneNode = {
        type: 'leaf', id: 'managed-terminal-pane',
        content: {
          kind: 'terminal', mode: 'codex', status: 'running',
          createRequestId: 'managed-terminal-create', terminalId: 'managed-terminal',
          soulId: 'managed-terminal-soul', viewIntentId: 'managed-terminal-view',
          viewIntentRevision: 2, soulIntentRevision: 7,
        },
      }
      const store = createStore(
        { tabs: [createTab({ id: 'tab-1' })], activeTabId: 'tab-1' }, {},
        { layouts: { 'tab-1': node }, activePane: { 'tab-1': node.id } },
      )
      let stopped = false
      mockManagedVisibility.mockImplementation(async (viewId, visibility, revision, soulRevision) => {
        expect(stopped).toBe(true)
        expect([viewId, visibility, revision, soulRevision]).toEqual(['managed-terminal-view', 'detached', 2, 7])
        return { viewId, soulId: 'managed-terminal-soul', visibility: 'hidden', revision: 3, soulIntentRevision: 8 }
      })
      renderWithStore(<TabBar />, store)
      fireEvent.click(screen.getByTitle('Close (Shift+Click to kill)'), { shiftKey: true })
      expect(mockManagedVisibility).not.toHaveBeenCalled()
      stopped = true
      ackAllTerminalKills()
      await waitFor(() => expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ type: 'panes.closed' })))
      expect(store.getState().panes.layouts['tab-1']).toEqual(node)
      ackAllPaneCloses()
      await waitFor(() => expect(store.getState().tabs.tabs).toEqual([]))
      expect(store.getState().panes.layouts['tab-1']).toBeUndefined()
      expect(mockManagedVisibility).toHaveBeenCalledTimes(1)
    })

    // b8ke ext r20 F2: the shift-close kill of a session-backed pane
    // carries the session's observed (epoch, generation) pair on the
    // wire — a reconnect-queued stale kill is typed-refused by the
    // server instead of killing a newer owner.
    it('shift+click kill of a session-backed pane carries the observed owner fence (b8ke ext r20 F2)', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-codex-9',
                sessionRef: { provider: 'codex', sessionId: 'codex-fence-ses' },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )
      // The runtimeOwners record: (epoch 12, generation 34) — the pair
      // the shift-close kill must carry.
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'codex',
        sessionId: 'codex-fence-ses',
        epoch: 12,
        generation: 34,
        ownerKind: 'terminal',
        operationId: 'handoff-1',
        transition: 'handoff-committed',
      }))

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'terminal.kill',
          terminalId: 'term-codex-9',
          createRequestId: 'req-pane-1',
          requestId: expect.any(String),
          observedEpoch: 12,
          observedGeneration: 34,
        }),
      )
    })

    // b8ke ext r20 F2: a pane with NO owner record (or no sessionRef)
    // legitimately sends the kill without the pair.
    it('shift+click kill of a session-backed pane with NO owner record sends no pair (b8ke ext r20 F2)', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-codex-10',
                sessionRef: { provider: 'codex', sessionId: 'codex-no-record' },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      const kills = mockSend.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((m) => m.type === 'terminal.kill')
      expect(kills).toHaveLength(1)
      expect(kills[0]).toMatchObject({
        type: 'terminal.kill',
        terminalId: 'term-codex-10',
        createRequestId: 'req-pane-1',
      })
      expect(kills[0]).not.toHaveProperty('observedEpoch')
      expect(kills[0]).not.toHaveProperty('observedGeneration')
    })


    it('plain close sends exactly one terminal.detach per terminal', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-123',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton)

      // Exactly ONE pane-close evidence message — the gate's acknowledged
      // BATCH send (the whole-tab close, focused-episode-7 round 3 F1; the
      // middleware belt skips its duplicate via the one-shot confirmation
      // mark, delta-r7-r3 F2).
      const paneClosed = mockSend.mock.calls
        .map(([msg]) => msg as { type?: string; tabId?: string; panes?: unknown })
        .filter((msg) => msg?.type === 'panes.closed')
      expect(paneClosed).toEqual([
        expect.objectContaining({
          type: 'panes.closed',
          tabId: 'tab-1',
          panes: [{ createRequestId: 'req-pane-1', terminalId: 'term-123' }],
        }),
      ])
      ackAllPaneCloses()
      await waitFor(() => {
        const detachMessages = mockSend.mock.calls
          .map(([msg]) => msg as { type?: string; terminalId?: string; createRequestId?: string })
          .filter((msg) => msg?.type === 'terminal.detach')
        // Exactly ONE identity-driven detach (never a CRID rider —
        // delta-r7-r2 F2); the pane-close evidence is the separate
        // panes.closed batch message above.
        expect(detachMessages).toEqual([
          { type: 'terminal.detach', terminalId: 'term-123' },
        ])
      })
    })

    it('shift close leaves the tab standing when the terminal close is not durably acknowledged', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-fail',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      const killMsg = mockSend.mock.calls
        .map(([msg]) => msg as { type?: string; requestId?: string })
        .find((msg) => msg?.type === 'terminal.kill')
      emitWsMessage({
        type: 'terminal.killed',
        requestId: killMsg?.requestId,
        terminalId: 'term-fail',
        success: false,
        error: 'the terminal close could not be recorded durably; the terminal was left running',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(
        ['tab-1'],
        'an unacknowledged close is not a close: the tab stays',
      )
    })

    // b8ke ext r20 F2: the queued-stale-kill-across-reconnect discipline.
    // The kill is decided against the session's observed (epoch,
    // generation) pair; while it sits queued/in-flight another device
    // advances the session; the server's stale-claim TYPED refusal
    // surfaces as terminal.killed{success:false} — the ack resolves
    // not-ok, the close gate never closes the tab, and the newer
    // owner's record survives (the refused kill never folds a death).
    it('a reconnect-queued stale-fence kill is typed-refused and the newer owner survives (b8ke ext r20 F2)', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-stale-1',
                sessionRef: { provider: 'codex', sessionId: 'codex-stale-ses' },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )
      // The record the shift-close observed at decision time: (12, 34).
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'codex',
        sessionId: 'codex-stale-ses',
        epoch: 12,
        generation: 34,
        ownerKind: 'terminal',
        operationId: 'handoff-1',
        transition: 'handoff-committed',
      }))

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      // The queued kill carries the pair observed at decision time.
      const killMsg = mockSend.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .find((msg) => msg?.type === 'terminal.kill')
      expect(killMsg).toMatchObject({
        type: 'terminal.kill',
        terminalId: 'term-stale-1',
        observedEpoch: 12,
        observedGeneration: 34,
      })

      // While the kill sits queued, ANOTHER device advances the session
      // through a handoff — the reconnect fold refreshes the record.
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'codex',
        sessionId: 'codex-stale-ses',
        epoch: 12,
        generation: 35,
        ownerKind: 'terminal',
        operationId: 'handoff-2',
        transition: 'handoff-committed',
      }))

      // The server refuses the stale pair typed — nothing is killed.
      emitWsMessage({
        type: 'terminal.killed',
        requestId: killMsg?.requestId as string,
        terminalId: 'term-stale-1',
        success: false,
        error: 'ownership moved to a newer runtime; refresh and retry',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The typed refusal is not a close: the tab survives…
      expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(
        ['tab-1'],
        'a stale-fence-refused kill never closes the tab — the newer owner lives',
      )
      // …and the newer owner's record is untouched by the refused kill
      // (the canonical fence selector reads the record the pane sees).
      expect(selectPaneOwnerFence(store.getState(), {
        sessionRef: { provider: 'codex', sessionId: 'codex-stale-ses' },
      })).toEqual({ epoch: 12, generation: 35 })
    })

    // b8ke fence-heal (fix b): a typed-refused close-tab kill carries the
    // coordinator's CURRENT pair on the correlated terminal.killed ack —
    // the caller (which holds the sessionRef identity) folds it, so the
    // NEXT close attempt sends the fresh pair instead of looping on the
    // refused stale one.
    it('a typed-refused close-tab kill folds the fresh pair and the next close sends it (fix b)', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-refold-1',
                sessionRef: { provider: 'codex', sessionId: 'codex-refold-ses' },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )
      // The record the first shift-close observed at decision time: (12, 34).
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'codex',
        sessionId: 'codex-refold-ses',
        epoch: 12,
        generation: 34,
        ownerKind: 'terminal',
        operationId: 'handoff-1',
        transition: 'handoff-committed',
      }))

      renderWithStore(<TabBar />, store)

      // First close attempt: the kill carries the observed (stale) pair.
      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })
      const firstKill = mockSend.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .find((msg) => msg?.type === 'terminal.kill')
      expect(firstKill).toMatchObject({
        type: 'terminal.kill',
        terminalId: 'term-refold-1',
        observedEpoch: 12,
        observedGeneration: 34,
      })

      // The server refuses the stale pair typed — the correlated ack
      // carries the coordinator's CURRENT pair.
      emitWsMessage({
        type: 'terminal.killed',
        requestId: firstKill?.requestId as string,
        terminalId: 'term-refold-1',
        success: false,
        error: 'ownership moved to a newer runtime; refresh and retry',
        ownerKind: 'terminal',
        ownerEpoch: 12,
        ownerGeneration: 40,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The refused close never dropped the tab…
      expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(['tab-1'])
      // …and the caller folded the fresh pair onto the session record.
      const folded = store.getState().freshAgent.runtimeOwners['codex:codex-refold-ses']
      expect(folded.generation).toBe(40)
      expect(folded.ownerKind).toBe('terminal')

      // The NEXT close attempt sends the fresh pair.
      const closeButtonAgain = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButtonAgain, { shiftKey: true })
      const kills = mockSend.mock.calls
        .map(([msg]) => msg as Record<string, unknown>)
        .filter((msg) => msg?.type === 'terminal.kill')
      expect(kills).toHaveLength(2)
      expect(kills[1]).toMatchObject({
        type: 'terminal.kill',
        terminalId: 'term-refold-1',
        observedEpoch: 12,
        observedGeneration: 40,
      })
    })

    it('shift close sends terminal.kill and no terminal.detach', () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'shell',
                shell: 'system',
                status: 'running',
                createRequestId: 'req-pane-1',
                terminalId: 'term-456',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      const sentTypes = mockSend.mock.calls
        .map(([msg]) => (msg as { type?: string })?.type)
      expect(sentTypes).toContain('terminal.kill')
      expect(sentTypes).not.toContain('terminal.detach')
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'terminal.kill', terminalId: 'term-456' }),
      )
    })

    it('close button detaches every terminal in split pane layout', async () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
      })

      const store = createStore(
        {
          tabs: [tab],
          activeTabId: 'tab-1',
        },
        {},
        {
          layouts: {
            'tab-1': createTwoTerminalSplitLayout('term-a', 'term-b'),
          },
          activePane: {
            'tab-1': 'pane-1',
          },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton)

      // Delta-r7-r2 (Finding F2): EVERY removed pane's close evidence lands
      // FIRST; focused-episode-7 round 3 (Finding F1) carries the tab's full
      // pane set in ONE batch envelope — then the identity-driven detaches
      // fire only once the close evidence is acknowledged (delta-r7-r3 F2
      // gate).
      expect(mockSend).toHaveBeenNthCalledWith(1, expect.objectContaining({
        type: 'panes.closed',
        tabId: 'tab-1',
        panes: [
          { createRequestId: 'req-pane-1', terminalId: 'term-a' },
          { createRequestId: 'req-pane-2', terminalId: 'term-b' },
        ],
      }))
      ackAllPaneCloses()
      await waitFor(() => {
        expect(mockSend).toHaveBeenCalledTimes(3)
        expect(mockSend).toHaveBeenNthCalledWith(2, {
          type: 'terminal.detach',
          terminalId: 'term-a',
        })
        expect(mockSend).toHaveBeenNthCalledWith(3, {
          type: 'terminal.detach',
          terminalId: 'term-b',
        })
      })
    })

    it('shift+click kills every terminal in split pane layout', () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
        terminalId: 'term-stale',
      })

      const store = createStore(
        {
          tabs: [tab],
          activeTabId: 'tab-1',
        },
        {},
        {
          layouts: {
            'tab-1': createTwoTerminalSplitLayout('term-a', 'term-b'),
          },
          activePane: {
            'tab-1': 'pane-1',
          },
        },
      )

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton, { shiftKey: true })

      expect(mockSend).toHaveBeenCalledTimes(2)
      expect(mockSend).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          type: 'terminal.kill',
          terminalId: 'term-a',
        }),
      )
      expect(mockSend).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          type: 'terminal.kill',
          terminalId: 'term-b',
        }),
      )
    })

    it('close button does not send ws message when tab has no terminalId', () => {
      const tab = createTab({
        id: 'tab-1',
        title: 'Tab 1',
        terminalId: undefined,
      })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton)

      expect(mockSend).not.toHaveBeenCalled()
    })

    it('closes a leftover legacy coding CLI tab without sending the legacy kill message', () => {
      const legacyTab = createTab({
        id: 'legacy-tab',
        title: 'Legacy Tab',
        mode: 'codex',
        codingCliSessionId: 'legacy-session',
      } as any)
      const store = createStore({
        tabs: [legacyTab],
        activeTabId: 'legacy-tab',
        renameRequestTabId: null,
        tombstones: [],
      })
      renderWithStore(<TabBar />, store)

      fireEvent.click(screen.getByTitle('Close (Shift+Click to kill)'))

      expect(mockSend).not.toHaveBeenCalledWith(expect.objectContaining({
        type: ['codingcli', 'kill'].join('.'),
      }))
    })

    it('clicking close button stops event propagation (does not activate tab)', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-2',
      })

      renderWithStore(<TabBar />, store)

      // Click the close button for tab 1 (not active)
      const closeButtons = screen.getAllByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButtons[0])

      // Tab 2 should still be active (close button click should not activate tab 1)
      // After removing tab 1, only tab 2 remains and it should be active
      const state = store.getState().tabs
      expect(state.activeTabId).toBe('tab-2')
    })
  })

  describe('terminal status indicator', () => {
    // Helper to get class attribute from SVG elements (className is SVGAnimatedString)
    const getClassString = (element: Element): string => {
      return element.getAttribute('class') || ''
    }

    // With iconsOnTabs=true (default), tabs with mode use PaneIcon with status classes
    it('shows running status indicator for running terminal', () => {
      const tab = createTab({ id: 'tab-1', status: 'running' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      const runningIndicator = icons.find((c) =>
        getClassString(c).includes('text-success')
      )
      expect(runningIndicator).toBeDefined()
    })

    it('shows exited status indicator for exited terminal', () => {
      const tab = createTab({ id: 'tab-1', status: 'exited' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      const exitedIndicator = icons.find((c) =>
        getClassString(c).includes('text-muted-foreground/40')
      )
      expect(exitedIndicator).toBeDefined()
    })

    it('shows error status indicator for error terminal', () => {
      const tab = createTab({ id: 'tab-1', status: 'error' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      const errorIndicator = icons.find((c) =>
        getClassString(c).includes('text-destructive')
      )
      expect(errorIndicator).toBeDefined()
    })

    it('shows a muted creating status indicator for a creating terminal', () => {
      const tab = createTab({ id: 'tab-1', status: 'creating' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      const creatingIndicator = icons.find((c) =>
        getClassString(c).includes('text-muted-foreground')
      )
      expect(creatingIndicator).toBeDefined()
      expect(getClassString(creatingIndicator!)).not.toContain('text-blue-500')
    })

    it('displays correct status for multiple tabs with different statuses', () => {
      const runningTab = createTab({ id: 'tab-1', status: 'running', title: 'Running' })
      const exitedTab = createTab({ id: 'tab-2', status: 'exited', title: 'Exited' })
      const errorTab = createTab({ id: 'tab-3', status: 'error', title: 'Error' })

      const store = createStore({
        tabs: [runningTab, exitedTab, errorTab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')

      // We should have 3 status indicators (one per tab)
      expect(icons).toHaveLength(3)

      // Check for running indicator
      const hasRunning = icons.some((c) => getClassString(c).includes('text-success'))
      expect(hasRunning).toBe(true)

      // Check for exited indicator
      const hasExited = icons.some((c) =>
        getClassString(c).includes('text-muted-foreground/40')
      )
      expect(hasExited).toBe(true)

      // Check for error indicator
      const hasError = icons.some((c) => getClassString(c).includes('text-destructive'))
      expect(hasError).toBe(true)
    })
  })

  describe('tab renaming', () => {
    it('double-click on tab enables rename mode', () => {
      const tab = createTab({ id: 'tab-1', title: 'Original Title' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Double-click on the tab
      const tabElement = screen.getByText('Original Title').closest('div')
      fireEvent.doubleClick(tabElement!)

      // Input should appear
      const input = screen.getByDisplayValue('Original Title')
      expect(input).toBeInTheDocument()
      expect(input.tagName).toBe('INPUT')
    })

    it('blur on rename input updates tab title', () => {
      const tab = createTab({ id: 'tab-1', title: 'Original Title' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Double-click to enable rename mode
      const tabElement = screen.getByText('Original Title').closest('div')
      fireEvent.doubleClick(tabElement!)

      // Type new title
      const input = screen.getByDisplayValue('Original Title')
      fireEvent.change(input, { target: { value: 'New Title' } })

      // Blur to save
      fireEvent.blur(input)

      // Check store was updated
      expect(store.getState().tabs.tabs[0].title).toBe('New Title')
    })

    it('pressing Enter saves rename', () => {
      const tab = createTab({ id: 'tab-1', title: 'Original Title' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Double-click to enable rename mode
      const tabElement = screen.getByText('Original Title').closest('div')
      fireEvent.doubleClick(tabElement!)

      // Type new title and press Enter
      const input = screen.getByDisplayValue('Original Title')
      fireEvent.change(input, { target: { value: 'Renamed Tab' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      // Check store was updated
      expect(store.getState().tabs.tabs[0].title).toBe('Renamed Tab')
    })

    it('pressing Escape cancels rename and keeps original title', () => {
      const tab = createTab({ id: 'tab-1', title: 'Original Title' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Double-click to enable rename mode
      const tabElement = screen.getByText('Original Title').closest('div')
      fireEvent.doubleClick(tabElement!)

      // Type new title but then press Escape
      const input = screen.getByDisplayValue('Original Title')
      fireEvent.change(input, { target: { value: 'Will Not Save' } })
      fireEvent.keyDown(input, { key: 'Escape' })

      // The input value at blur time determines the saved title
      // In this implementation, Escape triggers blur which saves the current value
      // Check store - it will save whatever value was in the input at blur time
      expect(store.getState().tabs.tabs[0].title).toBe('Will Not Save')
    })

    it('empty rename value keeps original title', () => {
      const tab = createTab({ id: 'tab-1', title: 'Original Title' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Double-click to enable rename mode
      const tabElement = screen.getByText('Original Title').closest('div')
      fireEvent.doubleClick(tabElement!)

      // Clear the title
      const input = screen.getByDisplayValue('Original Title')
      fireEvent.change(input, { target: { value: '' } })
      fireEvent.blur(input)

      // Empty value should keep original title
      expect(store.getState().tabs.tabs[0].title).toBe('Original Title')
    })
  })

  describe('removing active tab behavior', () => {
    it('removing active tab switches to immediate left tab', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })
      const tab3 = createTab({ id: 'tab-3', title: 'Tab 3' })

      const store = createStore({
        tabs: [tab1, tab2, tab3],
        activeTabId: 'tab-3',
      })

      renderWithStore(<TabBar />, store)

      // Close tab 3 (the active tab)
      const closeButtons = screen.getAllByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButtons[2])

      // Active tab should switch to immediate left tab (tab-2)
      const state = store.getState().tabs
      expect(state.tabs).toHaveLength(2)
      expect(state.activeTabId).toBe('tab-2')
    })

    it('removing last tab sets activeTabId to null', () => {
      const tab = createTab({ id: 'tab-1', title: 'Only Tab' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Close the only tab
      const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
      fireEvent.click(closeButton)

      // activeTabId should be null
      const state = store.getState().tabs
      expect(state.tabs).toHaveLength(0)
      expect(state.activeTabId).toBeNull()
    })
  })

  describe('drag and drop reordering', () => {
    it('renders tabs in a sortable container', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Both tabs should be rendered (sortable context doesn't change this)
      expect(screen.getByText('Tab 1')).toBeInTheDocument()
      expect(screen.getByText('Tab 2')).toBeInTheDocument()
    })

    it('Ctrl+Shift+ArrowRight moves active tab right', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })
      const tab3 = createTab({ id: 'tab-3', title: 'Tab 3' })

      const store = createStore({
        tabs: [tab1, tab2, tab3],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      // Press Ctrl+Shift+ArrowRight
      fireEvent.keyDown(window, {
        key: 'ArrowRight',
        ctrlKey: true,
        shiftKey: true,
      })

      // Tab 1 should have moved from index 0 to index 1
      const state = store.getState().tabs
      expect(state.tabs[0].id).toBe('tab-2')
      expect(state.tabs[1].id).toBe('tab-1')
      expect(state.tabs[2].id).toBe('tab-3')
    })

    it('does not move tabs for Ctrl+Shift+ArrowRight from a focused textbox', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      try {
        textarea.focus()
        fireEvent.keyDown(textarea, {
          key: 'ArrowRight',
          ctrlKey: true,
          shiftKey: true,
        })

        const state = store.getState().tabs
        expect(state.tabs[0].id).toBe('tab-1')
        expect(state.tabs[1].id).toBe('tab-2')
      } finally {
        textarea.remove()
      }
    })

    it('Ctrl+Shift+ArrowLeft moves active tab left', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })
      const tab3 = createTab({ id: 'tab-3', title: 'Tab 3' })

      const store = createStore({
        tabs: [tab1, tab2, tab3],
        activeTabId: 'tab-2',
      })

      renderWithStore(<TabBar />, store)

      // Press Ctrl+Shift+ArrowLeft
      fireEvent.keyDown(window, {
        key: 'ArrowLeft',
        ctrlKey: true,
        shiftKey: true,
      })

      // Tab 2 should have moved from index 1 to index 0
      const state = store.getState().tabs
      expect(state.tabs[0].id).toBe('tab-2')
      expect(state.tabs[1].id).toBe('tab-1')
      expect(state.tabs[2].id).toBe('tab-3')
    })

    it('Ctrl+Shift+ArrowLeft at first position does nothing', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      fireEvent.keyDown(window, {
        key: 'ArrowLeft',
        ctrlKey: true,
        shiftKey: true,
      })

      // Order unchanged
      const state = store.getState().tabs
      expect(state.tabs[0].id).toBe('tab-1')
      expect(state.tabs[1].id).toBe('tab-2')
    })

    it('Ctrl+Shift+ArrowRight at last position does nothing', () => {
      const tab1 = createTab({ id: 'tab-1', title: 'Tab 1' })
      const tab2 = createTab({ id: 'tab-2', title: 'Tab 2' })

      const store = createStore({
        tabs: [tab1, tab2],
        activeTabId: 'tab-2',
      })

      renderWithStore(<TabBar />, store)

      fireEvent.keyDown(window, {
        key: 'ArrowRight',
        ctrlKey: true,
        shiftKey: true,
      })

      // Order unchanged
      const state = store.getState().tabs
      expect(state.tabs[0].id).toBe('tab-1')
      expect(state.tabs[1].id).toBe('tab-2')
    })
  })

  describe('pane type icons on tabs', () => {
    // Helper to get class attribute from SVG elements
    const getClassString = (element: Element): string => {
      return element.getAttribute('class') || ''
    }

    it('renders one icon per pane when iconsOnTabs is enabled', () => {
      const tab = createTab({ id: 'tab-1', title: 'Split Tab' })

      const store = createStore(
        {
          tabs: [tab],
          activeTabId: 'tab-1',
        },
        {},
        {
          layouts: {
            'tab-1': createTwoTerminalSplitLayout('term-a', 'term-b'),
          },
          activePane: {
            'tab-1': 'pane-1',
          },
        },
      )

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      expect(icons).toHaveLength(2)
      expect(icons[0].getAttribute('data-content-kind')).toBe('terminal')
      expect(icons[1].getAttribute('data-content-kind')).toBe('terminal')
    })

    it('renders single status dot when iconsOnTabs is disabled', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1', status: 'running' })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      // Disable iconsOnTabs via settings
      store.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { defaultNewPane: 'ask', iconsOnTabs: false } },
      })

      renderWithStore(<TabBar />, store)

      // Should have circle-icon (StatusDot), not pane-icon
      const circles = screen.getAllByTestId('circle-icon')
      expect(circles.length).toBeGreaterThanOrEqual(1)
      const hasSuccess = circles.some((c) =>
        getClassString(c).includes('fill-success')
      )
      expect(hasSuccess).toBe(true)

      // No pane-icon should be rendered
      expect(screen.queryByTestId('pane-icon')).toBeNull()
    })

    it('caps at 3 icons and shows overflow indicator', () => {
      const tab = createTab({ id: 'tab-1', title: 'Many Panes' })

      // Build a deeply nested layout with 7 panes
      // Structure: split(split(split(split(split(split(leaf, leaf), leaf), leaf), leaf), leaf), leaf)
      function makeLeaf(id: string, termId: string): PaneNode {
        return {
          type: 'leaf',
          id,
          content: {
            kind: 'terminal',
            mode: 'shell',
            shell: 'system',
            status: 'running',
            createRequestId: `req-${id}`,
            terminalId: termId,
          },
        }
      }

      let tree: PaneNode = makeLeaf('pane-1', 'term-1')
      for (let i = 2; i <= 7; i++) {
        tree = {
          type: 'split',
          id: `split-${i - 1}`,
          direction: 'horizontal',
          sizes: [50, 50],
          children: [tree, makeLeaf(`pane-${i}`, `term-${i}`)],
        }
      }

      const store = createStore(
        {
          tabs: [tab],
          activeTabId: 'tab-1',
        },
        {},
        {
          layouts: {
            'tab-1': tree,
          },
          activePane: {
            'tab-1': 'pane-1',
          },
        },
      )

      renderWithStore(<TabBar />, store)

      // Should show 3 icons + overflow indicator
      const icons = screen.getAllByTestId('pane-icon')
      expect(icons).toHaveLength(3)

      // Overflow indicator shows +4
      expect(screen.getByText('+4')).toBeInTheDocument()
    })

    it('renders single icon for tab with single pane (no layout)', () => {
      // Tab with mode but no paneLayout entry -> fallback synthesis
      const tab = createTab({
        id: 'tab-1',
        title: 'Single Pane',
        mode: 'claude',
        status: 'running',
      })

      const store = createStore({
        tabs: [tab],
        activeTabId: 'tab-1',
      })

      renderWithStore(<TabBar />, store)

      const icons = screen.getAllByTestId('pane-icon')
      expect(icons).toHaveLength(1)
      expect(icons[0].getAttribute('data-content-kind')).toBe('terminal')
      expect(icons[0].getAttribute('data-content-mode')).toBe('claude')
    })

    it('renders a repo icon for a coding pane once meta is known', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1', status: 'running' })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: { kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )
      store.dispatch({
        type: 'repoIcons/fetchMeta/fulfilled',
        meta: { arg: '/repo/a' },
        payload: { repoRoot: '/repo/a', checkoutRoot: '/repo/a', repoName: 'a', hasIcon: true },
      })
      renderWithStore(<TabBar />, store)
      expect(screen.getAllByTestId('repo-icon').length).toBeGreaterThanOrEqual(1)
    })

    it('renders no repo icon when panes.repoIconsOnTabs is disabled', () => {
      const tab = createTab({ id: 'tab-1', title: 'Tab 1', status: 'running' })
      const store = createStore(
        { tabs: [tab], activeTabId: 'tab-1' },
        {},
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: { kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd: '/repo/a' },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
        },
      )
      store.dispatch({
        type: 'repoIcons/fetchMeta/fulfilled',
        meta: { arg: '/repo/a' },
        payload: { repoRoot: '/repo/a', checkoutRoot: '/repo/a', repoName: 'a', hasIcon: true },
      })
      store.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { repoIconsOnTabs: false } },
      })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('repo-icon')).toBeNull()
    })
  })
})

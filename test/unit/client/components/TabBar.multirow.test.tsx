import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabBar from '@/components/TabBar'
import tabsReducer from '@/store/tabsSlice'
import codingCliReducer from '@/store/codingCliSlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import opencodeActivityReducer from '@/store/opencodeActivitySlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { Tab } from '@/store/types'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: vi.fn() }),
}))

vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
  Plus: ({ className }: { className?: string }) => <svg data-testid="plus-icon" className={className} />,
  Circle: ({ className }: { className?: string }) => <svg data-testid="circle-icon" className={className} />,
  ChevronDown: ({ className }: { className?: string }) => <svg data-testid="chevron-down-icon" className={className} />,
  ChevronLeft: ({ className }: { className?: string }) => <svg data-testid="chevron-left-icon" className={className} />,
  ChevronRight: ({ className }: { className?: string }) => <svg data-testid="chevron-right-icon" className={className} />,
  Terminal: ({ className }: { className?: string }) => <svg data-testid="terminal-icon" className={className} />,
  MessageSquare: ({ className }: { className?: string }) => <svg data-testid="message-square-icon" className={className} />,
  PanelLeft: ({ className }: { className?: string }) => <svg data-testid="panel-left-icon" className={className} />,
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: any) => (
    <svg data-testid="pane-icon" data-content-kind={content?.kind} data-content-mode={content?.mode} className={className} />
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

function createStore(options: { tabs: Tab[]; activeTabId: string | null; multirowTabs?: boolean }) {
  const localSettings = resolveLocalSettings(
    options.multirowTabs ? { panes: { multirowTabs: true } } : undefined,
  )
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      codingCli: codingCliReducer,
      codexActivity: codexActivityReducer,
      opencodeActivity: opencodeActivityReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: { tabs: options.tabs, activeTabId: options.activeTabId, renameRequestTabId: null },
      codingCli: { sessions: {}, pendingRequests: {} },
      codexActivity: { byTerminalId: {}, lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {} },
      opencodeActivity: { byTerminalId: {}, lastSnapshotSeq: 0, liveMutationSeqByTerminalId: {}, removedMutationSeqByTerminalId: {} },
      panes: { layouts: {}, activePane: {}, paneTitles: {} },
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
      },
      turnCompletion: { seq: 0, pendingEvents: [], attentionByTab: {} },
    },
  })
}

function renderWithStore(ui: React.ReactElement, store: ReturnType<typeof createStore>) {
  return render(<Provider store={store}>{ui}</Provider>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('TabBar multirow tabs', () => {
  it('uses flex-wrap on the tab strip container when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
  })

  it('does not use flex-wrap when multirowTabs is disabled (default)', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).toBeNull()
  })

  it('uses overflow-x-auto when multirowTabs is disabled (default)', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const scrollContainer = container.querySelector('.overflow-x-auto')
    expect(scrollContainer).not.toBeNull()
  })

  it('does not render scroll arrow buttons when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.queryByLabelText('Scroll tabs left')
    const rightBtn = screen.queryByLabelText('Scroll tabs right')
    expect(leftBtn).toBeNull()
    expect(rightBtn).toBeNull()
  })

  it('renders scroll arrow buttons when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    renderWithStore(<TabBar />, store)

    const leftBtn = screen.getByLabelText('Scroll tabs left')
    const rightBtn = screen.getByLabelText('Scroll tabs right')
    expect(leftBtn).toBeInTheDocument()
    expect(rightBtn).toBeInTheDocument()
  })

  it('applies h-auto to the outer wrapper and max-h-32 to the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('h-auto')
    expect(wrapper.className).not.toContain('h-12')

    const tabStrip = container.querySelector('.flex-wrap')
    expect(tabStrip).not.toBeNull()
    expect(tabStrip!.className).toContain('max-h-32')
  })

  it('applies fixed height to the outer wrapper when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('h-12')
    expect(wrapper.className).not.toContain('h-auto')
  })

  it('still renders all tabs when multirowTabs is enabled', () => {
    const tabs = [
      createTab({ id: 'tab-1', title: 'Tab 1' }),
      createTab({ id: 'tab-2', title: 'Tab 2' }),
      createTab({ id: 'tab-3', title: 'Tab 3' }),
    ]
    const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    expect(screen.getByText('Tab 1')).toBeInTheDocument()
    expect(screen.getByText('Tab 2')).toBeInTheDocument()
    expect(screen.getByText('Tab 3')).toBeInTheDocument()
  })

  it('still renders the + new tab button when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    renderWithStore(<TabBar />, store)

    const addButton = screen.getByRole('button', { name: 'New shell tab' })
    expect(addButton).toBeInTheDocument()
  })

  it('does not use overflow-y-auto on the tab strip when multirowTabs is disabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: false })
    const { container } = renderWithStore(<TabBar />, store)

    const scrollContainer = container.querySelector('.overflow-x-auto')
    expect(scrollContainer).not.toBeNull()
    expect(scrollContainer!.className).not.toContain('overflow-y-auto')
  })

  it('uses overflow-y-auto on the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
    expect(flexWrap!.className).toContain('overflow-y-auto')
  })

  it('does not apply overflow-x-hidden to the tab strip when multirowTabs is enabled', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(<TabBar />, store)

    const flexWrap = container.querySelector('.flex-wrap')
    expect(flexWrap).not.toBeNull()
    expect(flexWrap!.className).not.toContain('overflow-x-hidden')
  })

  it('does not apply h-full to sidebar reopen slot in multirow mode', () => {
    const tab = createTab({ id: 'tab-1' })
    const store = createStore({ tabs: [tab], activeTabId: 'tab-1', multirowTabs: true })
    const { container } = renderWithStore(
      <TabBar sidebarCollapsed={true} onToggleSidebar={() => {}} />,
      store,
    )

    const slot = container.querySelector('[data-testid="desktop-sidebar-reopen-slot"]')
    expect(slot).not.toBeNull()
    expect(slot!.className).not.toContain('h-full')
  })
})

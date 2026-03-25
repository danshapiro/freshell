import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'

// Hoist mock functions so vi.mock can reference them
const { mockPaneLayout, addTerminalRestoreRequestId } = vi.hoisted(() => ({
  mockPaneLayout: vi.fn(() => <div data-testid="pane-layout" />),
  addTerminalRestoreRequestId: vi.fn(),
}))

// Mock PaneLayout to capture props
vi.mock('@/components/panes', () => ({
  PaneLayout: mockPaneLayout,
}))

// Mock SessionView
vi.mock('@/components/SessionView', () => ({
  default: () => <div data-testid="session-view" />,
}))

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId,
}))

interface TabConfig {
  id: string
  mode: string
  terminalId?: string
  codingCliSessionId?: string
  resumeSessionId?: string
  sessionMetadataByKey?: Record<string, unknown>
  createRequestId?: string
}

interface StoreOptions {
  defaultNewPane?: 'ask' | 'shell' | 'browser' | 'editor'
  layouts?: Record<string, unknown>
  activePane?: Record<string, string>
}

function createStore(tabs: TabConfig[], options: StoreOptions = {}) {
  const settings = {
    ...defaultSettings,
    panes: {
      ...defaultSettings.panes,
      defaultNewPane: options.defaultNewPane || 'ask',
    },
  }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: tabs.map((t) => ({
          id: t.id,
          mode: t.mode as any,
          status: 'running' as const,
          title: 'Test',
          terminalId: t.terminalId,
          codingCliSessionId: t.codingCliSessionId,
          resumeSessionId: t.resumeSessionId,
          sessionMetadataByKey: t.sessionMetadataByKey,
          createRequestId: t.createRequestId || 'req-1',
        })),
        activeTabId: tabs[0]?.id,
      },
      panes: {
        layouts: options.layouts || {},
        activePane: options.activePane || {},
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      settings: {
        settings,
        loaded: true,
      },
    },
  })
}

function createLeafLayout(content: Record<string, unknown> = {}) {
  return {
    type: 'leaf',
    id: 'pane-1',
    content: {
      kind: 'terminal',
      createRequestId: 'pane-req-1',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      ...content,
    },
  }
}

describe('TabContent', () => {
  beforeEach(() => {
    mockPaneLayout.mockClear()
    addTerminalRestoreRequestId.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  describe('terminalId passthrough', () => {
    it('passes terminalId to PaneLayout defaultContent when tab has terminalId', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell', terminalId: 'existing-terminal-123' }],
        { layouts: { 'tab-1': createLeafLayout({ terminalId: 'existing-terminal-123' }) } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            terminalId: 'existing-terminal-123',
          }),
        }),
        expect.anything()
      )
    })

    it('shows picker when tab has no terminalId and defaultNewPane is ask', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell' }],
        { defaultNewPane: 'ask', layouts: { 'tab-1': createLeafLayout() } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            kind: 'picker',
          }),
        }),
        expect.anything()
      )
    })

    it('passes undefined terminalId when tab has no terminalId and defaultNewPane is shell', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell' }],
        { defaultNewPane: 'shell', layouts: { 'tab-1': createLeafLayout() } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            kind: 'terminal',
            terminalId: undefined,
          }),
        }),
        expect.anything()
      )
    })
  })

  describe('coding CLI sessions', () => {
    it('renders SessionView when codingCliSessionId is present and no terminalId', () => {
      const store = createStore([
        { id: 'tab-1', mode: 'codex', codingCliSessionId: 'coding-session-1' },
      ])

      const { getByTestId } = render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(getByTestId('session-view')).toBeInTheDocument()
      expect(mockPaneLayout).not.toHaveBeenCalled()
    })

    it('renders an explicit integrity error when a pane-backed agent-chat tab is missing its layout', () => {
      const store = createStore([
        {
          id: 'tab-1',
          mode: 'claude',
          resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
          sessionMetadataByKey: {
            'claude:550e8400-e29b-41d4-a716-446655440000': {
              sessionType: 'freshclaude',
            },
          },
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(screen.getByTestId('missing-layout-error')).toBeInTheDocument()
      expect(mockPaneLayout).not.toHaveBeenCalled()
      expect(addTerminalRestoreRequestId).not.toHaveBeenCalled()
    })

    it('renders an explicit integrity error instead of issuing a degraded coding restore request', () => {
      const store = createStore([
        {
          id: 'tab-restore',
          mode: 'codex',
          resumeSessionId: 'codex-session-123',
          createRequestId: 'req-restore',
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-restore" />
        </Provider>
      )

      expect(screen.getByTestId('missing-layout-error')).toBeInTheDocument()
      expect(addTerminalRestoreRequestId).not.toHaveBeenCalled()
      expect(mockPaneLayout).not.toHaveBeenCalled()
    })

    it('shows the integrity error for pane-backed shell tabs whose layout is missing', () => {
      const store = createStore([
        {
          id: 'tab-shell-missing-layout',
          mode: 'shell',
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-shell-missing-layout" />
        </Provider>
      )

      expect(screen.getByTestId('missing-layout-error')).toBeInTheDocument()
      expect(addTerminalRestoreRequestId).not.toHaveBeenCalled()
      expect(mockPaneLayout).not.toHaveBeenCalled()
    })
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true to PaneLayout when hidden prop is true', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }],
        { layouts: { 'tab-1': createLeafLayout({ terminalId: 'term-1' }) } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={true} />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: true }),
        expect.anything()
      )
    })

    it('passes hidden=false to PaneLayout when hidden prop is false', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }],
        { layouts: { 'tab-1': createLeafLayout({ terminalId: 'term-1' }) } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={false} />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: false }),
        expect.anything()
      )
    })

    it('passes hidden=undefined to PaneLayout when hidden prop is not provided', () => {
      const store = createStore(
        [{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }],
        { layouts: { 'tab-1': createLeafLayout({ terminalId: 'term-1' }) } },
      )

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({ hidden: undefined }),
        expect.anything()
      )
    })
  })

  describe('visibility CSS classes', () => {
    it('applies tab-hidden class when hidden=true', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      const { container } = render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={true} />
        </Provider>
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('tab-hidden')
      // Ensure we're not using Tailwind's 'hidden' class (display:none) - check class list
      expect(wrapper.classList.contains('hidden')).toBe(false)
    })

    it('applies tab-visible class when hidden=false', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      const { container } = render(
        <Provider store={store}>
          <TabContent tabId="tab-1" hidden={false} />
        </Provider>
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('tab-visible')
      expect(wrapper.className).not.toContain('tab-hidden')
    })

    it('applies tab-visible class when hidden is undefined', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

      const { container } = render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain('tab-visible')
    })
  })
})

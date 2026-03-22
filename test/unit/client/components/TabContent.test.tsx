import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
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
  title?: string
  titleSource?: 'derived' | 'stable' | 'user'
  terminalId?: string
  codingCliSessionId?: string
  resumeSessionId?: string
  sessionMetadataByKey?: Record<string, unknown>
  createRequestId?: string
}

interface StoreOptions {
  defaultNewPane?: 'ask' | 'shell' | 'browser' | 'editor'
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
          title: t.title ?? 'Test',
          titleSource: t.titleSource,
          terminalId: t.terminalId,
          codingCliSessionId: t.codingCliSessionId,
          resumeSessionId: t.resumeSessionId,
          sessionMetadataByKey: t.sessionMetadataByKey,
          createRequestId: t.createRequestId || 'req-1',
        })),
        activeTabId: tabs[0]?.id,
      },
      panes: {
        layouts: {},
        activePane: {},
      },
      settings: {
        settings,
        loaded: true,
      },
    },
  })
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
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'existing-terminal-123' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }], { defaultNewPane: 'ask' })

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }], { defaultNewPane: 'shell' })

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

    it('passes durable pane title metadata when the tab title source is stable', () => {
      const store = createStore([
        {
          id: 'tab-1',
          mode: 'shell',
          terminalId: 'existing-terminal-123',
          title: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
          titleSource: 'stable',
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPaneTitle: 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346',
          defaultPaneTitleSource: 'stable',
        }),
        expect.anything(),
      )
    })

    it('passes durable pane title metadata for legacy stable titles without a stored source', () => {
      const store = createStore([
        {
          id: 'tab-1',
          mode: 'shell',
          terminalId: 'existing-terminal-123',
          title: 'Ops Desk',
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-1" />
        </Provider>
      )

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPaneTitle: 'Ops Desk',
          defaultPaneTitleSource: 'stable',
        }),
        expect.anything(),
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

    it('restores agent-chat default content for no-layout tabs using persisted session metadata', () => {
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

      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            kind: 'agent-chat',
            provider: 'freshclaude',
            resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
          }),
        }),
        expect.anything(),
      )
    })

    it('reuses tab.createRequestId for degraded no-layout coding restore requests', () => {
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

      expect(addTerminalRestoreRequestId).toHaveBeenCalledWith('req-restore')
      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-restore',
            resumeSessionId: 'codex-session-123',
          }),
        }),
        expect.anything(),
      )
    })

    it('preserves live terminalId for no-layout coding tabs while keeping the tab createRequestId', () => {
      const store = createStore([
        {
          id: 'tab-stale-terminal',
          mode: 'codex',
          terminalId: 'term-stale',
          resumeSessionId: 'codex-session-123',
          createRequestId: 'req-stale-terminal',
        },
      ])

      render(
        <Provider store={store}>
          <TabContent tabId="tab-stale-terminal" />
        </Provider>
      )

      expect(addTerminalRestoreRequestId).toHaveBeenCalledWith('req-stale-terminal')
      expect(mockPaneLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultContent: expect.objectContaining({
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-stale-terminal',
            resumeSessionId: 'codex-session-123',
            terminalId: 'term-stale',
          }),
        }),
        expect.anything(),
      )
    })
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true to PaneLayout when hidden prop is true', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell', terminalId: 'term-1' }])

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'

// Hoist mock functions so vi.mock can reference them
const { mockPaneLayout } = vi.hoisted(() => ({
  mockPaneLayout: vi.fn(() => <div data-testid="pane-layout" />),
}))

// Mock PaneLayout to capture props
vi.mock('@/components/panes', () => ({
  PaneLayout: mockPaneLayout,
}))

// Mock SessionView
vi.mock('@/components/SessionView', () => ({
  default: () => <div data-testid="session-view" />,
}))

interface TabConfig {
  id: string
  mode: string
  codingCliSessionId?: string
  resumeSessionId?: string
  sessionMetadataByKey?: Record<string, unknown>
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
          title: 'Test',
          codingCliSessionId: t.codingCliSessionId,
          resumeSessionId: t.resumeSessionId,
          sessionMetadataByKey: t.sessionMetadataByKey,
          createRequestId: 'req-1',
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
  })

  afterEach(() => {
    cleanup()
  })

  describe('default content resolution', () => {
    it('shows picker when defaultNewPane is ask', () => {
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

    it('passes terminal content when defaultNewPane is shell', () => {
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
            mode: 'shell',
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
  })

  describe('hidden prop propagation', () => {
    it('passes hidden=true to PaneLayout when hidden prop is true', () => {
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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
      const store = createStore([{ id: 'tab-1', mode: 'shell' }])

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

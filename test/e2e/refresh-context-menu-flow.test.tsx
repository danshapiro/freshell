import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import { api } from '@/lib/api'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import PaneLayout from '@/components/panes/PaneLayout'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import type { PaneNode } from '@/store/paneTypes'

const wsMocks = {
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => vi.fn()),
  onReconnect: vi.fn(() => vi.fn()),
  setHelloExtensionProvider: vi.fn(),
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/lib/url-rewrite', async () => {
  const actual = await vi.importActual<typeof import('@/lib/url-rewrite')>('@/lib/url-rewrite')
  return {
    ...actual,
    isLoopbackHostname: vi.fn((hostname: string) => {
      if (hostname === window.location.hostname) return false
      return actual.isLoopbackHostname(hostname)
    }),
  }
})

vi.mock('@/components/panes/FloatingActionButton', () => ({
  default: () => null,
}))

vi.mock('@/components/panes/IntersectionDragOverlay', () => ({
  default: () => null,
}))

function createBrowserLeaf(id: string, browserInstanceId: string, url: string): Extract<PaneNode, { type: 'leaf' }> {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'browser',
      browserInstanceId,
      url,
      devToolsOpen: false,
    },
  }
}

function createTerminalLeaf(id: string, terminalId: string): Extract<PaneNode, { type: 'leaf' }> {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      terminalId,
      createRequestId: `req-${terminalId}`,
      status: 'running',
      mode: 'shell',
      shell: 'system',
    },
  }
}

function createStore(layout: PaneNode, options?: { zoomedPaneId?: string }) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': layout.type === 'leaf' ? layout.id : layout.children[0].id },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: options?.zoomedPaneId ? { 'tab-1': options.zoomedPaneId } : {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: 'linux',
        availableClis: {},
        featureFlags: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function renderFlow(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        <div data-context={ContextIds.Tab} data-tab-id="tab-1">
          Tab One
        </div>
        <PaneLayout
          tabId="tab-1"
          defaultContent={{ kind: 'browser', url: '', devToolsOpen: false }}
        />
      </ContextMenuProvider>
    </Provider>,
  )
}

describe('refresh context menu flow (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue([])
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue({})
  })

  afterEach(() => {
    cleanup()
  })

  it('Refresh tab exits zoom and refreshes all browser panes in the stored layout', async () => {
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {}))

    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        createBrowserLeaf('pane-1', 'browser-1', 'http://127.0.0.1:3000'),
        createBrowserLeaf('pane-2', 'browser-2', 'http://127.0.0.1:3001'),
      ],
    }
    const store = createStore(layout, { zoomedPaneId: 'pane-1' })
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1)
    })
    vi.mocked(api.post).mockClear()

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

    await waitFor(() => {
      expect(store.getState().panes.zoomedPane['tab-1']).toBeUndefined()
    })
    await waitFor(() => {
      expect(container.querySelectorAll('[data-context="pane"]')).toHaveLength(2)
    })
    await waitFor(() => {
      expect(vi.mocked(api.post)).toHaveBeenCalledTimes(4)
    })
    await waitFor(() => {
      expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
    })
  })

  it('Refresh pane from the pane shell queues and consumes a matching browser refresh request', async () => {
    let reloadCount = 0
    const contentWindowSpy = vi.spyOn(window.HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(() => {
      return {
        location: {
          reload: () => {
            reloadCount += 1
          },
        },
      } as any
    })
    try {
      const layout = createBrowserLeaf('pane-1', 'browser-1', 'https://example.com')
      const store = createStore(layout)
      const user = userEvent.setup()
      const { container } = renderFlow(store)

      const paneShell = container.querySelector('[data-context="pane"]') as HTMLElement
      expect(paneShell).not.toBeNull()

      await user.pointer({ target: paneShell, keys: '[MouseRight]' })
      await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

      await waitFor(() => {
        expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
      })
      expect(reloadCount).toBe(1)
    } finally {
      contentWindowSpy.mockRestore()
    }
  })

  it('Refresh pane detaches and reattaches a terminal pane through the pane shell menu', async () => {
    const store = createStore(createTerminalLeaf('pane-1', 'term-1'))
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    await waitFor(() => {
      expect(
        wsMocks.send.mock.calls.some(([msg]) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-1'),
      ).toBe(true)
    })
    wsMocks.send.mockClear()

    const paneShell = container.querySelector('[data-context="pane"]') as HTMLElement
    expect(paneShell).not.toBeNull()

    await user.pointer({ target: paneShell, keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

    await waitFor(() => {
      const sends = wsMocks.send.mock.calls.map(([msg]) => msg)
      const detachIdx = sends.findIndex((msg) => msg?.type === 'terminal.detach' && msg?.terminalId === 'term-1')
      const attachIdx = sends.findIndex((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-1')

      expect(detachIdx).toBeGreaterThanOrEqual(0)
      expect(attachIdx).toBeGreaterThan(detachIdx)
      expect(sends[attachIdx]).toMatchObject({
        type: 'terminal.attach',
        terminalId: 'term-1',
        sinceSeq: 0,
      })
    })

    expect(store.getState().panes.refreshRequestsByPane['tab-1']).toBeUndefined()
  })
})

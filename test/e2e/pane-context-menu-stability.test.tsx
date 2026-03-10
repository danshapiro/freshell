import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
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

const terminalInstances = vi.hoisted(() => [] as Array<{
  focus: ReturnType<typeof vi.fn>
  surface: HTMLElement | null
}>)

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

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    focus = vi.fn()
    surface: HTMLElement | null = null

    constructor() {
      terminalInstances.push(this)
    }

    open = vi.fn((element: HTMLElement) => {
      const surface = document.createElement('div')
      surface.setAttribute('data-testid', 'terminal-xterm-surface')
      surface.tabIndex = -1
      element.appendChild(surface)
      this.surface = surface
    })

    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    selectAll = vi.fn()
    scrollLines = vi.fn()
    scrollToBottom = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    paste = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
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

function createTwoPaneLayout(): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      createTerminalLeaf('pane-1', 'term-1'),
      createTerminalLeaf('pane-2', 'term-2'),
    ],
  }
}

function createStore(layout: PaneNode, platform: string = 'linux') {
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
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform,
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

async function settleMenu() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('pane context menu stability (e2e)', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    vi.clearAllMocks()
    vi.mocked(api.get).mockResolvedValue([])
    vi.mocked(api.post).mockResolvedValue({})
    vi.mocked(api.patch).mockResolvedValue({})
    vi.mocked(api.put).mockResolvedValue({})
    vi.mocked(api.delete).mockResolvedValue({})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the pane menu open when right-clicking an inactive terminal pane header', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    const header = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await user.pointer({ target: header, keys: '[MouseRight]' })
    await settleMenu()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
  })

  it('keeps the terminal menu open when right-clicking inside an inactive terminal body', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    const surface = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [data-testid="terminal-xterm-surface"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await user.pointer({ target: surface, keys: '[MouseRight]' })
    await settleMenu()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Search' })).toBeInTheDocument()
  })

  it('keeps the pane menu open for a primary-button context-menu gesture on an inactive pane header', async () => {
    const store = createStore(createTwoPaneLayout(), 'darwin')
    const { container } = renderFlow(store)

    const header = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.mouseDown(header, { button: 0, buttons: 1, ctrlKey: true })
    fireEvent.contextMenu(header, {
      button: 0,
      buttons: 0,
      ctrlKey: true,
      clientX: 48,
      clientY: 32,
    })
    await settleMenu()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
    expect(store.getState().panes.activePane['tab-1']).toBe('pane-1')
  })

  it('still activates an inactive pane on Ctrl+LeftClick for non-mac platforms', async () => {
    const store = createStore(createTwoPaneLayout(), 'linux')
    const { container } = renderFlow(store)

    const header = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.mouseDown(header, { button: 0, buttons: 1, ctrlKey: true })

    await waitFor(() => {
      expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
    })
  })

  it('still activates an inactive pane on middle click for non-mac platforms', async () => {
    const store = createStore(createTwoPaneLayout(), 'linux')
    const { container } = renderFlow(store)

    const header = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    fireEvent.mouseDown(header, { button: 1, buttons: 4 })

    await waitFor(() => {
      expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
    })
  })

  it('still activates an inactive pane on primary click', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    const header = await waitFor(() => {
      const node = container.querySelector('[data-pane-id="pane-2"] [role="banner"]')
      expect(node).not.toBeNull()
      return node as HTMLElement
    })

    await user.pointer({ target: header, keys: '[MouseLeft]' })

    await waitFor(() => {
      expect(store.getState().panes.activePane['tab-1']).toBe('pane-2')
    })
  })
})

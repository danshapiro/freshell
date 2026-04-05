import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import { api } from '@/lib/api'
import { isMacLike } from '@/lib/utils'
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

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils')
  return {
    ...actual,
    isMacLike: vi.fn(() => false),
  }
})

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

    constructor() {}

    open = vi.fn((element: HTMLElement) => {
      const surface = document.createElement('div')
      surface.setAttribute('data-testid', 'terminal-xterm-surface')
      surface.tabIndex = -1
      element.appendChild(surface)
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
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    dispose = vi.fn()
    buffer = {
      active: {
        viewportY: 0,
        getLine: vi.fn(() => null),
      },
    }
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

function createTwoPaneLayout(): PaneNode {
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
          terminalId: 'term-1',
          createRequestId: 'req-term-1',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
      {
        type: 'leaf',
        id: 'pane-2',
        content: {
          kind: 'terminal',
          terminalId: 'term-2',
          createRequestId: 'req-term-2',
          status: 'running',
          mode: 'shell',
          shell: 'system',
        },
      },
    ],
  }
}

function createStore(layout: PaneNode) {
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
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: 'Tab One',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-1' },
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

describe('terminal URL context menu items (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isMacLike).mockReturnValue(false)
    vi.mocked(api.get).mockResolvedValue([])
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('right-clicking a terminal pane with a hovered URL shows URL-specific menu items', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    // Wait for terminal to mount
    const terminalWrapper = await waitFor(() => {
      const el = container.querySelector('[data-pane-id="pane-1"][data-context="terminal"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    // Simulate hover state by setting the data attribute
    terminalWrapper.dataset.hoveredUrl = 'https://hovered.example.com/path'

    // Find an element inside the terminal to right-click
    const surface = terminalWrapper.querySelector('[data-testid="terminal-xterm-container"]') || terminalWrapper
    await user.pointer({ target: surface, keys: '[MouseRight]' })
    await settleMenu()

    // URL-specific items should appear
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open URL in pane' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open URL in new tab' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Open in external browser' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy URL' })).toBeInTheDocument()

    // Standard terminal items should also be present
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeInTheDocument()
  })

  it('right-clicking a terminal pane without a hovered URL shows no URL-specific items', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    const terminalWrapper = await waitFor(() => {
      const el = container.querySelector('[data-pane-id="pane-1"][data-context="terminal"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    // No hoveredUrl set
    const surface = terminalWrapper.querySelector('[data-testid="terminal-xterm-container"]') || terminalWrapper
    await user.pointer({ target: surface, keys: '[MouseRight]' })
    await settleMenu()

    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open URL in pane' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Copy URL' })).not.toBeInTheDocument()

    // Standard items should be present
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
  })

  it('selecting "Open URL in pane" creates a browser pane split', async () => {
    const store = createStore(createTwoPaneLayout())
    const user = userEvent.setup()
    const { container } = renderFlow(store)

    const terminalWrapper = await waitFor(() => {
      const el = container.querySelector('[data-pane-id="pane-1"][data-context="terminal"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })

    terminalWrapper.dataset.hoveredUrl = 'https://split.example.com'

    const surface = terminalWrapper.querySelector('[data-testid="terminal-xterm-container"]') || terminalWrapper
    await user.pointer({ target: surface, keys: '[MouseRight]' })
    await settleMenu()

    const openInPaneItem = screen.getByRole('menuitem', { name: 'Open URL in pane' })
    await user.click(openInPaneItem)

    // Check layout has been split
    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      // The root should still be a split
      expect(layout.type).toBe('split')
      if (layout.type !== 'split') return

      // One of the branches should now contain a browser pane with the URL
      const findBrowserPane = (node: any): boolean => {
        if (node.type === 'leaf' && node.content?.kind === 'browser' && node.content?.url === 'https://split.example.com') {
          return true
        }
        if (node.type === 'split') {
          return findBrowserPane(node.children[0]) || findBrowserPane(node.children[1])
        }
        return false
      }
      expect(findBrowserPane(layout)).toBe(true)
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/terminals') return []
    if (path === '/api/files/read?path=%2Ftmp%2Fexample.txt') {
      return {
        content: 'console.log(42)\n',
        language: 'typescript',
        filePath: '/tmp/example.txt',
      }
    }
    throw new Error(`Unexpected api.get path: ${path}`)
  }),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: apiMocks.get,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
    suspendWebgl: vi.fn(() => false),
    resumeWebgl: vi.fn(),
  }),
}))

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value = '' }: { value?: string }) => (
    <textarea data-testid="monaco-mock" value={value} readOnly />
  )

  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})

const linkProvidersByPaneId = new Map<string, {
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
}>()

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    paneId: string | null = null
    buffer = {
      active: {
        viewportY: 0,
        getLine: vi.fn(() => ({
          translateToString: () => '/tmp/example.txt',
        })),
      },
    }
    open = vi.fn((element: HTMLElement) => {
      this.paneId = element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      // Store only the first registered provider (file path provider)
      if (this.paneId && !linkProvidersByPaneId.has(this.paneId)) {
        linkProvidersByPaneId.set(this.paneId, provider)
      }
      return { dispose: vi.fn() }
    })
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    paste = vi.fn()
    reset = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    scrollLines = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createTerminalContent(createRequestId: string, terminalId: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId,
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
  }
}

function createStore() {
  const clickedPaneId = 'pane-clicked'
  const layout: PaneNode = {
    type: 'split',
    id: 'split-root',
    direction: 'vertical',
    sizes: [45, 55],
    children: [
      {
        type: 'leaf',
        id: 'pane-left',
        content: createTerminalContent('req-left', 'term-left'),
      },
      {
        type: 'split',
        id: 'split-right',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: 'pane-middle',
            content: createTerminalContent('req-middle', 'term-middle'),
          },
          {
            type: 'leaf',
            id: clickedPaneId,
            content: createTerminalContent('req-clicked', 'term-clicked'),
          },
        ],
      },
    ],
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-left',
          title: 'Shell',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          terminalId: 'term-left',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-left' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { 'tab-1': clickedPaneId },
        refreshRequestsByPane: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'ready',
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
    },
  })
}

describe('terminal file links open Monaco on the clicked pane branch without navigating tabs', () => {
  beforeEach(() => {
    apiMocks.get.mockClear()
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockClear()
    wsMocks.onReconnect.mockClear()
    wsMocks.setHelloExtensionProvider.mockClear()
    linkProvidersByPaneId.clear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the same tab, clears zoom, and opens the editor off the clicked nested pane instead of the active pane', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TabContent tabId="tab-1" />
      </Provider>
    )

    await waitFor(() => {
      expect(linkProvidersByPaneId.has('pane-clicked')).toBe(true)
    })

    const clickedProvider = linkProvidersByPaneId.get('pane-clicked')!
    let links: any[] | undefined
    clickedProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toHaveLength(1)
    expect(links![0].text).toBe('/tmp/example.txt')

    links![0].activate()

    await waitFor(() => {
      expect(store.getState().tabs.tabs).toHaveLength(1)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
      expect(store.getState().panes.zoomedPane['tab-1']).toBeUndefined()
      expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
    })

    const root = store.getState().panes.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type !== 'split') {
      throw new Error('expected root split layout')
    }

    expect(root.children[0]).toMatchObject({ type: 'leaf', id: 'pane-left' })

    const rightBranch = root.children[1]
    expect(rightBranch.type).toBe('split')
    if (rightBranch.type !== 'split') {
      throw new Error('expected right branch split layout')
    }

    expect(rightBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-middle' })

    const clickedBranch = rightBranch.children[1]
    expect(clickedBranch.type).toBe('split')
    if (clickedBranch.type !== 'split') {
      throw new Error('expected clicked branch split layout')
    }

    expect(clickedBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-clicked' })
    expect(clickedBranch.children[1]).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'editor',
        filePath: '/tmp/example.txt',
      },
    })

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('/api/files/read?path=%2Ftmp%2Fexample.txt')
    })
  })
})

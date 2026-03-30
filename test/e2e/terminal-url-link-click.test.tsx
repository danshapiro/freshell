import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
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

// Track URL link providers by pane ID (index 1 = URL provider, index 0 = file path provider)
const urlLinkProvidersByPaneId = new Map<string, {
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
}>()

const linkHandlersByPaneId = new Map<string, {
  activate: (event: MouseEvent, uri: string) => void
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
          translateToString: () => 'Visit https://example.com/docs for more info',
        })),
      },
    }
    open = vi.fn((element: HTMLElement) => {
      this.paneId = element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
      if (this.paneId && this.options.linkHandler) {
        linkHandlersByPaneId.set(this.paneId, this.options.linkHandler as any)
      }
    })
    loadAddon = vi.fn()
    private providerCount = 0
    registerLinkProvider = vi.fn((provider: any) => {
      this.providerCount++
      // Second provider is the URL provider
      if (this.providerCount === 2 && this.paneId) {
        urlLinkProvidersByPaneId.set(this.paneId, provider)
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
    scrollToBottom = vi.fn()

    constructor(opts?: Record<string, unknown>) {
      if (opts) this.options = opts
    }
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

function createStore(opts?: { warnExternalLinks?: boolean }) {
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

  const settings = {
    ...defaultSettings,
    terminal: {
      ...defaultSettings.terminal,
      warnExternalLinks: opts?.warnExternalLinks ?? false,
    },
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
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: {
        settings,
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

describe('terminal URL links open browser pane on the clicked pane branch without navigating tabs', () => {
  beforeEach(() => {
    apiMocks.get.mockClear()
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockClear()
    wsMocks.onReconnect.mockClear()
    wsMocks.setHelloExtensionProvider.mockClear()
    urlLinkProvidersByPaneId.clear()
    linkHandlersByPaneId.clear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('clicking a URL in a nested terminal pane opens a browser pane on the same tab branch', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TabContent tabId="tab-1" />
      </Provider>
    )

    await waitFor(() => {
      expect(urlLinkProvidersByPaneId.has('pane-clicked')).toBe(true)
    })

    const clickedProvider = urlLinkProvidersByPaneId.get('pane-clicked')!
    let links: any[] | undefined
    clickedProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toHaveLength(1)
    expect(links![0].text).toBe('https://example.com/docs')

    links![0].activate(new MouseEvent('click'))

    await waitFor(() => {
      expect(store.getState().tabs.tabs).toHaveLength(1)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
    })

    const root = store.getState().panes.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type !== 'split') throw new Error('expected root split layout')

    expect(root.children[0]).toMatchObject({ type: 'leaf', id: 'pane-left' })

    const rightBranch = root.children[1]
    expect(rightBranch.type).toBe('split')
    if (rightBranch.type !== 'split') throw new Error('expected right branch split layout')

    expect(rightBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-middle' })

    const clickedBranch = rightBranch.children[1]
    expect(clickedBranch.type).toBe('split')
    if (clickedBranch.type !== 'split') throw new Error('expected clicked branch split layout')

    expect(clickedBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-clicked' })
    expect(clickedBranch.children[1]).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'browser',
        url: 'https://example.com/docs',
        devToolsOpen: false,
      },
    })
  })

  it('OSC 8 link click in a nested pane opens browser pane (with warnExternalLinks disabled)', async () => {
    const store = createStore({ warnExternalLinks: false })

    render(
      <Provider store={store}>
        <TabContent tabId="tab-1" />
      </Provider>
    )

    await waitFor(() => {
      expect(linkHandlersByPaneId.has('pane-clicked')).toBe(true)
    })

    const handler = linkHandlersByPaneId.get('pane-clicked')!
    handler.activate(new MouseEvent('click'), 'https://osc8.example.com/path')

    await waitFor(() => {
      expect(store.getState().tabs.tabs).toHaveLength(1)
    })

    const root = store.getState().panes.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type !== 'split') throw new Error('expected root split layout')

    const rightBranch = root.children[1]
    expect(rightBranch.type).toBe('split')
    if (rightBranch.type !== 'split') throw new Error('expected right branch split layout')

    const clickedBranch = rightBranch.children[1]
    expect(clickedBranch.type).toBe('split')
    if (clickedBranch.type !== 'split') throw new Error('expected clicked branch split layout')

    expect(clickedBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-clicked' })
    expect(clickedBranch.children[1]).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'browser',
        url: 'https://osc8.example.com/path',
        devToolsOpen: false,
      },
    })
  })
})

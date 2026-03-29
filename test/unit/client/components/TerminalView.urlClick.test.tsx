import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TerminalView from '@/components/TerminalView'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { getHoveredUrl, clearHoveredUrl } from '@/lib/terminal-hovered-url'
import type { TerminalPaneContent } from '@/store/paneTypes'
import type { AppSettings } from '@/store/types'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: vi.fn() }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

const terminalInstances: any[] = []
const registeredLinkProviders: any[] = []

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    paneId: string | null = null
    buffer = {
      active: {
        getLine: vi.fn(() => ({
          translateToString: () => 'Visit https://detected.example.com here',
        })),
      },
    }
    open = vi.fn((element: HTMLElement) => {
      this.paneId = element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      registeredLinkProviders.push(provider)
      return { dispose: vi.fn() }
    })
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    selectAll = vi.fn()
    reset = vi.fn()
    scrollToBottom = vi.fn()
    constructor(opts?: Record<string, unknown>) {
      if (opts) this.options = opts
      terminalInstances.push(this)
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

const paneContent: TerminalPaneContent = {
  kind: 'terminal',
  createRequestId: 'req-1',
  status: 'running',
  mode: 'shell',
  shell: 'system',
  terminalId: 'term-1',
  initialCwd: '/tmp',
}

function createStore(settingsOverride?: Partial<AppSettings>) {
  const mergedSettings = {
    ...defaultSettings,
    ...settingsOverride,
    terminal: { ...defaultSettings.terminal, ...settingsOverride?.terminal },
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-1',
          title: 'Test',
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          terminalId: 'term-1',
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': { type: 'leaf' as const, id: 'pane-1', content: paneContent } },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
      },
      settings: { settings: mergedSettings, loaded: true },
      connection: { status: 'connected' as const, error: null },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
    },
  })
}

function getLinkHandler() {
  const term = terminalInstances[terminalInstances.length - 1]
  return term.options.linkHandler as {
    activate: (event: MouseEvent, uri: string) => void
    hover?: (event: MouseEvent, text: string, range: any) => void
    leave?: (event: MouseEvent, text: string, range: any) => void
  }
}

function getUrlLinkProvider() {
  // URL link provider is registered second (after file path provider)
  return registeredLinkProviders[registeredLinkProviders.length - 1] as {
    provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
  }
}

describe('TerminalView URL click behavior', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    terminalInstances.length = 0
    registeredLinkProviders.length = 0
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    windowOpenSpy.mockRestore()
    vi.unstubAllGlobals()
    clearHoveredUrl('pane-1')
  })

  it('OSC 8 linkHandler.activate with warnExternalLinks=false dispatches splitPane with browser content', async () => {
    const store = createStore({ terminal: { ...defaultSettings.terminal, warnExternalLinks: false } })

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    const handler = getLinkHandler()
    act(() => {
      handler.activate(new MouseEvent('click'), 'https://example.com')
    })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout.type).toBe('split')
    if (layout.type === 'split') {
      expect(layout.children[1]).toMatchObject({
        type: 'leaf',
        content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
      })
    }
    expect(windowOpenSpy).not.toHaveBeenCalled()
  })

  it('OSC 8 linkHandler.activate with warnExternalLinks=true shows modal, confirm opens browser pane', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    const handler = getLinkHandler()
    act(() => {
      handler.activate(new MouseEvent('click'), 'https://example.com/page')
    })

    await waitFor(() => {
      expect(screen.getByText('Open external link?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Open link'))

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout.type).toBe('split')
      if (layout.type === 'split') {
        expect(layout.children[1]).toMatchObject({
          type: 'leaf',
          content: { kind: 'browser', url: 'https://example.com/page', devToolsOpen: false },
        })
      }
    })
    expect(windowOpenSpy).not.toHaveBeenCalled()
  })

  it('OSC 8 linkHandler.hover sets hovered URL in module and data attribute', async () => {
    const store = createStore()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    const handler = getLinkHandler()
    expect(handler.hover).toBeDefined()

    const mockRange = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } }
    act(() => {
      handler.hover!(new MouseEvent('mouseover'), 'https://hovered.example.com', mockRange)
    })

    expect(getHoveredUrl('pane-1')).toBe('https://hovered.example.com')
    const wrapper = container.querySelector('[data-context="terminal"]') as HTMLElement
    expect(wrapper?.dataset.hoveredUrl).toBe('https://hovered.example.com')
  })

  it('OSC 8 linkHandler.leave clears hovered URL from module and data attribute', async () => {
    const store = createStore()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    const handler = getLinkHandler()
    const mockRange = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } }

    // First hover
    act(() => {
      handler.hover!(new MouseEvent('mouseover'), 'https://hovered.example.com', mockRange)
    })
    expect(getHoveredUrl('pane-1')).toBe('https://hovered.example.com')

    // Then leave
    act(() => {
      handler.leave!(new MouseEvent('mouseout'), 'https://hovered.example.com', mockRange)
    })

    expect(getHoveredUrl('pane-1')).toBeUndefined()
    const wrapper = container.querySelector('[data-context="terminal"]') as HTMLElement
    expect(wrapper?.dataset.hoveredUrl).toBeUndefined()
  })

  it('URL link provider activate with warnExternalLinks=false dispatches splitPane with browser content', async () => {
    const store = createStore({ terminal: { ...defaultSettings.terminal, warnExternalLinks: false } })

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    const urlProvider = getUrlLinkProvider()
    let links: any[] | undefined
    urlProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toBeDefined()
    expect(links!.length).toBeGreaterThan(0)

    act(() => {
      links![0].activate(new MouseEvent('click'))
    })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout.type).toBe('split')
    if (layout.type === 'split') {
      expect(layout.children[1]).toMatchObject({
        type: 'leaf',
        content: { kind: 'browser', url: 'https://detected.example.com', devToolsOpen: false },
      })
    }
  })

  it('URL link provider hover sets hovered URL in module and data attribute', async () => {
    const store = createStore()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    const urlProvider = getUrlLinkProvider()
    let links: any[] | undefined
    urlProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toBeDefined()
    act(() => {
      links![0].hover(new MouseEvent('mouseover'), links![0].text)
    })

    expect(getHoveredUrl('pane-1')).toBe('https://detected.example.com')
    const wrapper = container.querySelector('[data-context="terminal"]') as HTMLElement
    expect(wrapper?.dataset.hoveredUrl).toBe('https://detected.example.com')
  })

  it('URL link provider leave clears hovered URL', async () => {
    const store = createStore()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    const urlProvider = getUrlLinkProvider()
    let links: any[] | undefined
    urlProvider.provideLinks(1, (provided) => {
      links = provided
    })

    // Hover then leave
    act(() => {
      links![0].hover(new MouseEvent('mouseover'), links![0].text)
    })
    expect(getHoveredUrl('pane-1')).toBeDefined()

    act(() => {
      links![0].leave(new MouseEvent('mouseout'), links![0].text)
    })

    expect(getHoveredUrl('pane-1')).toBeUndefined()
    const wrapper = container.querySelector('[data-context="terminal"]') as HTMLElement
    expect(wrapper?.dataset.hoveredUrl).toBeUndefined()
  })

  it('URL link provider detects URLs in terminal buffer line', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    const urlProvider = getUrlLinkProvider()
    let links: any[] | undefined
    urlProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toBeDefined()
    expect(links!.length).toBe(1)
    expect(links![0].text).toBe('https://detected.example.com')
    // startIndex 6 in 'Visit https://detected.example.com here'
    // x is 1-based: startIndex + 1 = 7
    expect(links![0].range.start.x).toBe(7)
  })

  it('URL link provider returns undefined for lines with no URLs', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    // Override buffer line to return text without URLs
    const term = terminalInstances[terminalInstances.length - 1]
    term.buffer.active.getLine.mockReturnValueOnce({
      translateToString: () => 'Just a normal line with /tmp/file.txt',
    })

    const urlProvider = getUrlLinkProvider()
    let links: any[] | undefined
    urlProvider.provideLinks(2, (provided) => {
      links = provided
    })

    expect(links).toBeUndefined()
  })

  it('terminal dispose clears hovered URL', async () => {
    const store = createStore()

    const { unmount } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    // Set hovered URL via hover callback
    const handler = getLinkHandler()
    const mockRange = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } }
    act(() => {
      handler.hover!(new MouseEvent('mouseover'), 'https://hovered.example.com', mockRange)
    })
    expect(getHoveredUrl('pane-1')).toBe('https://hovered.example.com')

    // Unmount
    unmount()

    expect(getHoveredUrl('pane-1')).toBeUndefined()
  })

  it('file path link provider is registered before URL link provider', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(registeredLinkProviders.length).toBeGreaterThanOrEqual(2)
    })

    // First provider (file path) should detect file paths
    const fileProvider = registeredLinkProviders[0]

    // Override buffer to return a file path
    const term = terminalInstances[terminalInstances.length - 1]
    term.buffer.active.getLine.mockReturnValueOnce({
      translateToString: () => '/tmp/example.txt',
    })

    let fileLinks: any[] | undefined
    fileProvider.provideLinks(1, (provided: any) => {
      fileLinks = provided
    })

    expect(fileLinks).toBeDefined()
    expect(fileLinks![0].text).toBe('/tmp/example.txt')

    // Second provider (URL) should detect URLs
    const urlProvider = registeredLinkProviders[1]
    // Use original getLine mock (returns URL text)
    let urlLinks: any[] | undefined
    urlProvider.provideLinks(1, (provided: any) => {
      urlLinks = provided
    })

    expect(urlLinks).toBeDefined()
    expect(urlLinks![0].text).toBe('https://detected.example.com')
  })
})

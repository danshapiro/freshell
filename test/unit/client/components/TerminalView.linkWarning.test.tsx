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

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
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

function activateLinkHandler(uri: string) {
  const term = terminalInstances[terminalInstances.length - 1]
  const handler = term.options.linkHandler as { activate: (event: MouseEvent, uri: string) => void }
  act(() => {
    handler.activate(new MouseEvent('click'), uri)
  })
}

describe('TerminalView link warning', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    terminalInstances.length = 0
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    windowOpenSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('shows confirm modal when link is clicked with warnExternalLinks enabled', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    activateLinkHandler('https://example.com')

    await waitFor(() => {
      expect(screen.getByText('Open external link?')).toBeInTheDocument()
    })
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(windowOpenSpy).not.toHaveBeenCalled()
  })

  it('opens link and closes modal on confirm', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    activateLinkHandler('https://example.com/page')

    await waitFor(() => {
      expect(screen.getByText('Open external link?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Open link'))

    await waitFor(() => {
      expect(windowOpenSpy).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer')
    })
    expect(screen.queryByText('Open external link?')).not.toBeInTheDocument()
  })

  it('does not open link on cancel', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    activateLinkHandler('https://malicious.example.com')

    await waitFor(() => {
      expect(screen.getByText('Open external link?')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Cancel'))

    await waitFor(() => {
      expect(screen.queryByText('Open external link?')).not.toBeInTheDocument()
    })
    expect(windowOpenSpy).not.toHaveBeenCalled()
  })

  it('bypasses modal when warnExternalLinks is disabled', async () => {
    const store = createStore({ terminal: { ...defaultSettings.terminal, warnExternalLinks: false } })

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
    })

    activateLinkHandler('https://trusted.example.com')

    await waitFor(() => {
      expect(windowOpenSpy).toHaveBeenCalledWith('https://trusted.example.com', '_blank', 'noopener,noreferrer')
    })
    expect(screen.queryByText('Open external link?')).not.toBeInTheDocument()
  })
})

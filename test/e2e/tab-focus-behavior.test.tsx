import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useAppSelector } from '@/store/hooks'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import TabBar from '@/components/TabBar'
import TerminalView from '@/components/TerminalView'
import type { TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const terminalInstances: Array<{ focus: ReturnType<typeof vi.fn> }> = []

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

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
    constructor() {
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

function createStore(activeTabId: string = 'tab-1') {
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
        tabs: [
          {
            id: 'tab-1',
            title: 'Tab 1',
            createRequestId: 'tab-1',
            mode: 'shell' as const,
            status: 'running' as const,
            shell: 'system' as const,
            createdAt: Date.now(),
          },
          {
            id: 'tab-2',
            title: 'Tab 2',
            createRequestId: 'tab-2',
            mode: 'shell' as const,
            status: 'running' as const,
            shell: 'system' as const,
            createdAt: Date.now(),
          },
          {
            id: 'tab-3',
            title: 'Tab 3',
            createRequestId: 'tab-3',
            mode: 'shell' as const,
            status: 'running' as const,
            shell: 'system' as const,
            createdAt: Date.now(),
          },
        ],
        activeTabId,
      },
      panes: {
        layouts: {},
        activePane: {
          'tab-2': 'pane-2b',
        },
        paneTitles: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'ready' as const,
        platform: 'linux',
        availableClis: {},
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
      },
    },
  })
}

function FocusHarness() {
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const hidden = activeTabId !== 'tab-2'

  const paneA: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-a',
    mode: 'shell',
    shell: 'system',
    status: 'running',
  }
  const paneB: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-b',
    mode: 'shell',
    shell: 'system',
    status: 'running',
  }

  return (
    <>
      <TabBar />
      <TerminalView tabId="tab-2" paneId="pane-2a" paneContent={paneA} hidden={hidden} />
      <TerminalView tabId="tab-2" paneId="pane-2b" paneContent={paneB} hidden={hidden} />
    </>
  )
}

describe('tab focus behavior (e2e)', () => {
  beforeEach(() => {
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockClear()
    wsMocks.onReconnect.mockClear()
    terminalInstances.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('clicking a tab focuses its last-used pane terminal', async () => {
    const store = createStore('tab-1')

    render(
      <Provider store={store}>
        <FocusHarness />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(2)
    })
    await waitFor(() => {
      expect(terminalInstances[0].focus).toHaveBeenCalled()
      expect(terminalInstances[1].focus).toHaveBeenCalled()
    })

    terminalInstances[0].focus.mockClear()
    terminalInstances[1].focus.mockClear()

    fireEvent.click(screen.getByLabelText('Tab 2'))

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })
    await waitFor(() => {
      expect(terminalInstances[1].focus).toHaveBeenCalledTimes(1)
    })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('closing active tab activates the tab to the left', async () => {
    const store = createStore('tab-3')

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    const closeButtons = screen.getAllByTitle('Close (Shift+Click to kill)')
    act(() => {
      fireEvent.click(closeButtons[2])
    })

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })
  })

  it('closing a split tab detaches all pane terminals', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              title: 'Tab 1',
              createRequestId: 'tab-1',
              terminalId: 'term-stale',
              mode: 'shell' as const,
              status: 'running' as const,
              shell: 'system' as const,
              createdAt: Date.now(),
            },
          ],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'split',
              id: 'split-1',
              direction: 'horizontal' as const,
              sizes: [50, 50] as [number, number],
              children: [
                {
                  type: 'leaf',
                  id: 'pane-1',
                  content: {
                    kind: 'terminal',
                    mode: 'shell',
                    shell: 'system',
                    status: 'running',
                    createRequestId: 'req-pane-1',
                    terminalId: 'term-a',
                  },
                },
                {
                  type: 'leaf',
                  id: 'pane-2',
                  content: {
                    kind: 'terminal',
                    mode: 'shell',
                    shell: 'system',
                    status: 'running',
                    createRequestId: 'req-pane-2',
                    terminalId: 'term-b',
                  },
                },
              ],
            },
          },
          activePane: {
            'tab-1': 'pane-1',
          },
          paneTitles: {},
        },
        settings: {
          settings: defaultSettings,
          loaded: true,
        },
        connection: {
          status: 'ready' as const,
          platform: 'linux',
          availableClis: {},
        },
        turnCompletion: {
          seq: 0,
          lastEvent: null,
          pendingEvents: [],
          attentionByTab: {},
        },
      },
    })

    render(
      <Provider store={store}>
        <TabBar />
      </Provider>
    )

    const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
    fireEvent.click(closeButton)

    const detachMessages = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.detach')

    expect(detachMessages).toEqual([
      { type: 'terminal.detach', terminalId: 'term-a' },
      { type: 'terminal.detach', terminalId: 'term-b' },
    ])
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const runtimeMockState = vi.hoisted(() => ({
  throwOnAttach: false,
  lastEnableWebgl: null as boolean | null,
  lastRuntime: null as null | {
    attachAddons: () => void
    fit: () => void
    findNext: () => boolean
    findPrevious: () => boolean
    dispose: () => void
    webglActive: () => boolean
    emitContextLoss: () => void
  },
}))

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

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: ({ enableWebgl }: { enableWebgl: boolean }) => {
    runtimeMockState.lastEnableWebgl = enableWebgl
    let webgl = enableWebgl
    const runtime = {
      attachAddons: () => {
        if (runtimeMockState.throwOnAttach) {
          throw new Error('addon init failure')
        }
      },
      fit: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearDecorations: vi.fn(),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
      webglActive: () => webgl,
      emitContextLoss: () => {
        webgl = false
      },
    }
    runtimeMockState.lastRuntime = runtime
    return runtime
  },
}))

const terminalInstances: any[] = []
let messageHandler: ((msg: any) => void) | null = null

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
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

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView from '@/components/TerminalView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createStore(renderer: 'auto' | 'webgl' | 'canvas') {
  const tabId = 'tab-renderer'
  const paneId = 'pane-renderer'
  const terminalId = 'term-renderer'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-renderer',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'shell',
          status: 'running',
          title: 'Shell',
          terminalId,
          createRequestId: 'req-renderer',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: {
        settings: {
          ...defaultSettings,
          terminal: {
            ...defaultSettings.terminal,
            renderer,
          },
        },
        status: 'loaded',
      },
      connection: { status: 'connected', error: null },
    },
  })

  return { store, tabId, paneId, paneContent, terminalId }
}

describe('TerminalView renderer mode', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    runtimeMockState.throwOnAttach = false
    runtimeMockState.lastEnableWebgl = null
    runtimeMockState.lastRuntime = null
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => {
        if (messageHandler === callback) messageHandler = null
      }
    })
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    messageHandler = null
  })

  it('auto mode attempts WebGL', async () => {
    const { store, tabId, paneId, paneContent } = createStore('auto')
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(runtimeMockState.lastEnableWebgl).toBe(true)
    })
  })

  it('canvas mode skips WebGL attempt', async () => {
    const { store, tabId, paneId, paneContent } = createStore('canvas')
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(runtimeMockState.lastEnableWebgl).toBe(false)
    })
  })

  it('continues opening terminal when addon attach fails', async () => {
    runtimeMockState.throwOnAttach = true
    const { store, tabId, paneId, paneContent } = createStore('auto')

    expect(() =>
      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>,
      ),
    ).not.toThrow()

    await waitFor(() => {
      expect(terminalInstances[0]?.open).toHaveBeenCalled()
    })
  })

  it('remains functional after WebGL context loss', async () => {
    const { store, tabId, paneId, paneContent, terminalId } = createStore('auto')
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
      expect(runtimeMockState.lastRuntime).not.toBeNull()
    })

    runtimeMockState.lastRuntime!.emitContextLoss()
    expect(runtimeMockState.lastRuntime!.webglActive()).toBe(false)

    messageHandler!({ type: 'terminal.output', terminalId, data: 'still works' })
    expect(terminalInstances[0].write).toHaveBeenCalledWith('still works')
  })
})

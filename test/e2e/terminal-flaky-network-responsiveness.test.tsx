import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer, { setStatus } from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const handlers = new Set<(msg: any) => void>()
  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onReconnect: vi.fn(() => () => {}),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }),
    emit(msg: any) {
      for (const handler of handlers) handler(msg)
    },
    reset() {
      handlers.clear()
    },
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
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
  }),
}))

const terminalInstances: Array<{
  write: ReturnType<typeof vi.fn>
  writeln: ReturnType<typeof vi.fn>
}> = []

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    getSelection = vi.fn(() => '')
    clear = vi.fn()
    write = vi.fn((data: string, cb?: () => void) => {
      cb?.()
      return data.length
    })
    writeln = vi.fn()

    constructor() {
      terminalInstances.push(this as unknown as {
        write: ReturnType<typeof vi.fn>
        writeln: ReturnType<typeof vi.fn>
      })
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

function createStore() {
  const pane: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-flaky',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-flaky',
  }

  const layout: PaneNode = { type: 'leaf', id: 'pane-flaky', content: pane }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{ id: 'tab-flaky', mode: 'shell', status: 'running', title: 'Flaky', createRequestId: 'req-flaky', terminalId: 'term-flaky' }],
        activeTabId: 'tab-flaky',
      },
      panes: {
        layouts: { 'tab-flaky': layout },
        activePane: { 'tab-flaky': 'pane-flaky' },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'disconnected', error: null },
    },
  })
}

function flushRafQueue(pending: FrameRequestCallback[]) {
  let guard = 0
  while (pending.length > 0 && guard < 100) {
    const cb = pending.shift()
    cb?.(performance.now())
    guard += 1
  }
}

describe('terminal flaky-network responsiveness (e2e)', () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let rafSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelRafSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.connect.mockClear()
    terminalInstances.length = 0
    rafCallbacks = []
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    rafSpy?.mockRestore()
    cancelRafSpy?.mockRestore()
    rafSpy = null
    cancelRafSpy = null
  })

  it('shows non-blocking offline/recovering status and continues rendering after output gaps', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-flaky"
          paneId="pane-flaky"
          paneContent={{
            kind: 'terminal',
            createRequestId: 'req-flaky',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            terminalId: 'term-flaky',
          }}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBe(1)
      expect(wsHarness.onMessage).toHaveBeenCalled()
    })

    expect(screen.getByText('Offline: input will queue until reconnected.')).toBeInTheDocument()
    expect(screen.queryByText('Starting terminal...')).not.toBeInTheDocument()
    expect(wsHarness.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-flaky',
      sinceSeq: 0,
    }))

    store.dispatch(setStatus('ready'))
    await waitFor(() => {
      expect(screen.getByText('Recovering terminal output...')).toBeInTheDocument()
    })

    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-flaky',
      headSeq: 3,
      replayFromSeq: 1,
      replayToSeq: 3,
    })
    wsHarness.emit({
      type: 'terminal.output.gap',
      terminalId: 'term-flaky',
      fromSeq: 4,
      toSeq: 8,
      reason: 'queue_overflow',
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-flaky',
      seqStart: 9,
      seqEnd: 9,
      data: 'after-gap',
    })

    flushRafQueue(rafCallbacks)

    expect(terminalInstances[0].writeln).toHaveBeenCalledWith(expect.stringContaining('[Output gap 4-8'))
    expect(terminalInstances[0].write).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByText('Recovering terminal output...')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Starting terminal...')).not.toBeInTheDocument()
  })

  it('renders replayFrom>1 frames and live output while recovering status clears', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-flaky"
          paneId="pane-flaky"
          paneContent={{
            kind: 'terminal',
            createRequestId: 'req-flaky',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            terminalId: 'term-flaky',
          }}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBe(1)
      expect(wsHarness.onMessage).toHaveBeenCalled()
    })

    store.dispatch(setStatus('ready'))
    await waitFor(() => {
      expect(screen.getByText('Recovering terminal output...')).toBeInTheDocument()
    })

    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-flaky',
      headSeq: 9,
      replayFromSeq: 7,
      replayToSeq: 9,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-flaky',
      seqStart: 7,
      seqEnd: 7,
      data: 'replay-7',
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-flaky',
      seqStart: 8,
      seqEnd: 8,
      data: 'replay-8',
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-flaky',
      seqStart: 9,
      seqEnd: 9,
      data: 'replay-9',
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-flaky',
      seqStart: 10,
      seqEnd: 10,
      data: 'live-10',
    })

    flushRafQueue(rafCallbacks)

    const writes = terminalInstances[0].write.mock.calls.map(([data]) => String(data)).join('')
    expect(writes).toContain('replay-7')
    expect(writes).toContain('replay-9')
    expect(writes).toContain('live-10')
    await waitFor(() => {
      expect(screen.queryByText('Recovering terminal output...')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Offline: input will queue until reconnected.')).not.toBeInTheDocument()
  })
})

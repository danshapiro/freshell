import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const handlers = new Set<(msg: any) => void>()
  const durationSamples: number[] = []

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onReconnect: vi.fn(() => () => {}),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }),
    emit(msg: any) {
      for (const handler of handlers) {
        const startedAt = performance.now()
        handler(msg)
        durationSamples.push(performance.now() - startedAt)
      }
    },
    reset() {
      handlers.clear()
      durationSamples.length = 0
    },
    clearDurations() {
      durationSamples.length = 0
    },
    durations() {
      return [...durationSamples]
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

const terminalInstances: Array<{ write: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> }> = []

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

    constructor() {
      terminalInstances.push(this as unknown as { write: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> })
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
  const pane1: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-1',
  }
  const pane2: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-2',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-2',
  }

  const layouts: Record<string, PaneNode> = {
    'tab-1': { type: 'leaf', id: 'pane-1', content: pane1 },
    'tab-2': { type: 'leaf', id: 'pane-2', content: pane2 },
  }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          { id: 'tab-1', mode: 'shell', status: 'running', title: 'One', createRequestId: 'req-1', terminalId: 'term-1' },
          { id: 'tab-2', mode: 'shell', status: 'running', title: 'Two', createRequestId: 'req-2', terminalId: 'term-2' },
        ],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts,
        activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2' },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    },
  })

  return { store, pane1, pane2 }
}

function flushRafQueue(pending: FrameRequestCallback[]) {
  let guard = 0
  while (pending.length > 0 && guard < 100) {
    const cb = pending.shift()
    cb?.(performance.now())
    guard += 1
  }
}

describe('terminal console violations regression (e2e)', () => {
  let rafCallbacks: FrameRequestCallback[] = []
  let rafSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelRafSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    wsHarness.clearDurations()
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

  it('uses v2 sequence output without warning spam and keeps ws handlers off synchronous writes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { store, pane1, pane2 } = createStore()
    render(
      <Provider store={store}>
        <>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={pane1} hidden={false} />
          <TerminalView tabId="tab-2" paneId="pane-2" paneContent={pane2} hidden={false} />
        </>
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBe(2)
      expect(wsHarness.onMessage).toHaveBeenCalled()
    })

    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-2', seqStart: 1, seqEnd: 1, data: 'two' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 1, seqEnd: 1, data: 'one' })

    flushRafQueue(rafCallbacks)
    expect(terminalInstances[0].write).toHaveBeenCalled()
    expect(terminalInstances[1].write).toHaveBeenCalled()

    const overlapWarnings = warnSpy.mock.calls.flat().filter((arg) =>
      typeof arg === 'string' && arg.includes('overlapping terminal.output sequence range')
    )
    expect(overlapWarnings).toHaveLength(0)

    terminalInstances[0].write.mockClear()
    terminalInstances[1].write.mockClear()
    wsHarness.clearDurations()

    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 2, seqEnd: 2, data: 'A' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 3, seqEnd: 3, data: 'B' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 4, seqEnd: 4, data: 'C' })

    expect(terminalInstances[0].write).not.toHaveBeenCalled()
    const wsHandlerDurationSamples = wsHarness.durations()
    expect(wsHandlerDurationSamples.some((ms) => ms > 30)).toBe(false)

    flushRafQueue(rafCallbacks)
    expect(terminalInstances[0].write).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('does not log overlap warnings when replay frames arrive after attach.ready', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { store, pane1 } = createStore()
    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={pane1} hidden={false} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBe(1)
      expect(wsHarness.onMessage).toHaveBeenCalled()
    })

    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-1',
      headSeq: 8,
      replayFromSeq: 6,
      replayToSeq: 8,
    })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 6, seqEnd: 6, data: 'R6' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 7, seqEnd: 7, data: 'R7' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-1', seqStart: 8, seqEnd: 8, data: 'R8' })

    flushRafQueue(rafCallbacks)

    const writes = terminalInstances[0].write.mock.calls.map(([data]) => String(data)).join('')
    expect(writes).toContain('R6')
    expect(writes).toContain('R7')
    expect(writes).toContain('R8')

    const overlapWarnings = warnSpy.mock.calls.flat().filter((arg) =>
      typeof arg === 'string' && arg.includes('overlapping terminal.output sequence range')
    )
    expect(overlapWarnings).toHaveLength(0)

    warnSpy.mockRestore()
  })
})

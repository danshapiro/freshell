import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const reconnectHandlers = new Set<() => void>()
  const latestAttachRequestIdByTerminal = new Map<string, string>()

  const withCurrentAttachRequestId = (msg: any) => {
    if (
      msg?.attachRequestId
      || typeof msg?.terminalId !== 'string'
      || (msg?.type !== 'terminal.attach.ready' && msg?.type !== 'terminal.output' && msg?.type !== 'terminal.output.gap')
    ) {
      return msg
    }
    const attachRequestId = latestAttachRequestIdByTerminal.get(msg.terminalId)
    return attachRequestId ? { ...msg, attachRequestId } : msg
  }

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    }),
    onReconnect: vi.fn((handler: () => void) => {
      reconnectHandlers.add(handler)
      return () => reconnectHandlers.delete(handler)
    }),
    emit(msg: any) {
      const normalized = withCurrentAttachRequestId(msg)
      for (const handler of messageHandlers) handler(normalized)
    },
    triggerReconnect() {
      for (const handler of reconnectHandlers) handler()
    },
    rememberAttach(msg: any) {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg?.terminalId === 'string'
        && typeof msg?.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    },
    reset() {
      messageHandlers.clear()
      reconnectHandlers.clear()
      latestAttachRequestIdByTerminal.clear()
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
    attachCustomWheelEventHandler = vi.fn()
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

function createStore(options: {
  status: 'creating' | 'running'
  requestId: string
  terminalId?: string
}) {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: options.requestId,
    status: options.status,
    mode: 'shell',
    shell: 'system',
    ...(options.terminalId ? { terminalId: options.terminalId } : {}),
  }

  const layout: PaneNode = { type: 'leaf', id: 'pane-order', content: paneContent }

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
          id: 'tab-order',
          mode: 'shell',
          status: options.status,
          title: 'Order',
          createRequestId: options.requestId,
          ...(options.terminalId ? { terminalId: options.terminalId } : {}),
        }],
        activeTabId: 'tab-order',
      },
      panes: {
        layouts: { 'tab-order': layout },
        activePane: { 'tab-order': 'pane-order' },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'ready', error: null },
    },
  })
}

function sentMessages() {
  return wsHarness.send.mock.calls.map(([msg]) => msg)
}

function lastSent(type: string, terminalId?: string) {
  return sentMessages().reverse().find((msg) => {
    if (msg?.type !== type) return false
    if (terminalId && msg?.terminalId !== terminalId) return false
    return true
  })
}

describe('terminal create/attach ordering (e2e)', () => {
  beforeEach(() => {
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.send.mockImplementation((msg: any) => {
      wsHarness.rememberAttach(msg)
    })
    wsHarness.connect.mockClear()
    terminalInstances.length = 0
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('create path orders create -> created -> attach -> attach.ready -> replay output', async () => {
    const store = createStore({ status: 'creating', requestId: 'req-order-create' })

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-order"
          paneId="pane-order"
          paneContent={store.getState().panes.layouts['tab-order']!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.create')).toMatchObject({
        type: 'terminal.create',
        requestId: 'req-order-create',
      })
    })

    wsHarness.send.mockClear()
    wsHarness.emit({
      type: 'terminal.created',
      requestId: 'req-order-create',
      terminalId: 'term-order-create',
      createdAt: Date.now(),
    })

    await waitFor(() => {
      expect(lastSent('terminal.attach', 'term-order-create')).toMatchObject({
        type: 'terminal.attach',
        terminalId: 'term-order-create',
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
        intent: 'viewport_hydrate',
      })
    })

    const attach = lastSent('terminal.attach', 'term-order-create')
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-order-create',
      headSeq: 1,
      replayFromSeq: 1,
      replayToSeq: 1,
      attachRequestId: attach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-create',
      seqStart: 1,
      seqEnd: 1,
      data: 'create-replay-1',
      attachRequestId: attach.attachRequestId,
    })

    const writes = terminalInstances[0].write.mock.calls.map(([data]) => String(data)).join('')
    expect(writes).toContain('create-replay-1')
  })

  it('hidden restore stays detached until visible, then replays through the visible attach generation', async () => {
    const store = createStore({
      status: 'running',
      requestId: 'req-order-hidden',
      terminalId: 'term-order-hidden',
    })

    const view = render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-order"
          paneId="pane-order"
          paneContent={store.getState().panes.layouts['tab-order']!.content as TerminalPaneContent}
          hidden
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBe(1)
    })
    expect(lastSent('terminal.attach', 'term-order-hidden')).toBeUndefined()

    view.rerender(
      <Provider store={store}>
        <TerminalView
          tabId="tab-order"
          paneId="pane-order"
          paneContent={store.getState().panes.layouts['tab-order']!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', 'term-order-hidden')).toMatchObject({
        type: 'terminal.attach',
        terminalId: 'term-order-hidden',
        sinceSeq: 0,
        attachRequestId: expect.any(String),
        intent: 'viewport_hydrate',
      })
    })
    expect(wsHarness.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === 'term-order-hidden')).toHaveLength(0)

    const attach = lastSent('terminal.attach', 'term-order-hidden')
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-order-hidden',
      headSeq: 8,
      replayFromSeq: 6,
      replayToSeq: 8,
      attachRequestId: attach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-hidden',
      seqStart: 6,
      seqEnd: 6,
      data: 'hidden-r6',
      attachRequestId: attach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-hidden',
      seqStart: 8,
      seqEnd: 8,
      data: 'hidden-r8',
      attachRequestId: attach.attachRequestId,
    })

    const writes = terminalInstances[0].write.mock.calls.map(([data]) => String(data)).join('')
    expect(writes).toContain('hidden-r6')
    expect(writes).toContain('hidden-r8')
  })

  it('reconnect path drops stale frames from the old attach generation and accepts the new one only after ready', async () => {
    const store = createStore({
      status: 'running',
      requestId: 'req-order-reconnect',
      terminalId: 'term-order-reconnect',
    })

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-order"
          paneId="pane-order"
          paneContent={store.getState().panes.layouts['tab-order']!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', 'term-order-reconnect')).toMatchObject({
        type: 'terminal.attach',
        terminalId: 'term-order-reconnect',
        attachRequestId: expect.any(String),
      })
    })

    const firstAttach = lastSent('terminal.attach', 'term-order-reconnect')
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-order-reconnect',
      headSeq: 1,
      replayFromSeq: 2,
      replayToSeq: 1,
      attachRequestId: firstAttach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-reconnect',
      seqStart: 2,
      seqEnd: 2,
      data: 'before-reconnect',
      attachRequestId: firstAttach.attachRequestId,
    })

    wsHarness.send.mockClear()
    wsHarness.triggerReconnect()

    await waitFor(() => {
      expect(lastSent('terminal.attach', 'term-order-reconnect')).toMatchObject({
        type: 'terminal.attach',
        terminalId: 'term-order-reconnect',
        sinceSeq: 2,
        attachRequestId: expect.any(String),
        intent: 'transport_reconnect',
      })
    })

    const secondAttach = lastSent('terminal.attach', 'term-order-reconnect')
    expect(secondAttach.attachRequestId).not.toBe(firstAttach.attachRequestId)

    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-reconnect',
      seqStart: 3,
      seqEnd: 3,
      data: 'stale-after-reconnect',
      attachRequestId: firstAttach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-order-reconnect',
      headSeq: 2,
      replayFromSeq: 3,
      replayToSeq: 2,
      attachRequestId: secondAttach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-order-reconnect',
      seqStart: 3,
      seqEnd: 3,
      data: 'fresh-after-reconnect',
      attachRequestId: secondAttach.attachRequestId,
    })

    const writes = terminalInstances[0].write.mock.calls.map(([data]) => String(data)).join('')
    expect(writes).toContain('before-reconnect')
    expect(writes).not.toContain('stale-after-reconnect')
    expect(writes).toContain('fresh-after-reconnect')
  })
})

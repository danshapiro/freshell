import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import TerminalView from '@/components/TerminalView'
import connectionReducer from '@/store/connectionSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  OPEN_CODE_STARTUP_EXPECTED_CLEANED,
  OPEN_CODE_STARTUP_EXPECTED_REPLIES,
  OPEN_CODE_STARTUP_PROBE_FRAME,
  OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES,
  OPEN_CODE_STARTUP_VISIBLE_TEXT,
} from '@test/helpers/opencode-startup-probes'

const terminalTheme = {
  foreground: '#aabbcc',
  background: '#112233',
  cursor: '#ddeeff',
}

const ioEvents: Array<{ kind: 'send' | 'write', type?: string, data: string }> = []

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
  getTerminalTheme: () => terminalTheme,
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
    writeln = vi.fn()
    write = vi.fn((data: string, cb?: () => void) => {
      ioEvents.push({ kind: 'write', data: String(data) })
      cb?.()
      return data.length
    })

    constructor() {
      terminalInstances.push(this as unknown as { write: ReturnType<typeof vi.fn> })
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

function createStore(terminalId: string) {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: `req-${terminalId}`,
    status: 'running',
    mode: 'opencode',
    shell: 'system',
    terminalId,
  }

  const layout: PaneNode = { type: 'leaf', id: `pane-${terminalId}`, content: paneContent }

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
          id: `tab-${terminalId}`,
          mode: 'opencode',
          status: 'running',
          title: 'OpenCode',
          createRequestId: `req-${terminalId}`,
          terminalId,
        }],
        activeTabId: `tab-${terminalId}`,
      },
      panes: {
        layouts: { [`tab-${terminalId}`]: layout },
        activePane: { [`tab-${terminalId}`]: `pane-${terminalId}` },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'ready', error: null },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    } as any,
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

describe('opencode startup probes (e2e)', () => {
  beforeEach(() => {
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.send.mockImplementation((msg: any) => {
      if (msg?.type === 'terminal.input' && typeof msg?.data === 'string') {
        ioEvents.push({ kind: 'send', type: msg.type, data: msg.data })
      }
      wsHarness.rememberAttach(msg)
    })
    wsHarness.connect.mockClear()
    terminalInstances.length = 0
    ioEvents.length = 0
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

  it('replies to live startup probes before writing visible output', async () => {
    const terminalId = 'term-opencode-live'
    const store = createStore(terminalId)

    render(
      <Provider store={store}>
        <TerminalView
          tabId={`tab-${terminalId}`}
          paneId={`pane-${terminalId}`}
          paneContent={store.getState().panes.layouts[`tab-${terminalId}`]!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', terminalId)).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        attachRequestId: expect.any(String),
      })
    })

    const attach = lastSent('terminal.attach', terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 0,
      replayFromSeq: 1,
      replayToSeq: 0,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: `${OPEN_CODE_STARTUP_PROBE_FRAME}${OPEN_CODE_STARTUP_VISIBLE_TEXT}`,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalledWith(OPEN_CODE_STARTUP_EXPECTED_CLEANED, undefined)
    })

    const inputMessages = sentMessages().filter((msg) => msg?.type === 'terminal.input')
    expect(inputMessages).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
      { kind: 'write' as const, data: OPEN_CODE_STARTUP_EXPECTED_CLEANED },
    ])
  })

  it('strips historical startup probes during replay without sending late replies', async () => {
    const terminalId = 'term-opencode-replay'
    const store = createStore(terminalId)

    render(
      <Provider store={store}>
        <TerminalView
          tabId={`tab-${terminalId}`}
          paneId={`pane-${terminalId}`}
          paneContent={store.getState().panes.layouts[`tab-${terminalId}`]!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', terminalId)).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        attachRequestId: expect.any(String),
      })
    })

    const attach = lastSent('terminal.attach', terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 2,
      replayFromSeq: 1,
      replayToSeq: 2,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[0],
      attachRequestId: attach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 2,
      data: `${OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[1]}${OPEN_CODE_STARTUP_VISIBLE_TEXT}`,
      attachRequestId: attach.attachRequestId,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 3,
      seqEnd: 3,
      data: 'live tail',
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([
      { kind: 'write', data: OPEN_CODE_STARTUP_EXPECTED_CLEANED },
      { kind: 'write', data: 'live tail' },
    ])
  })

  it('does not complete a replay-fragment startup probe from the first live frame', async () => {
    const terminalId = 'term-opencode-replay-live-boundary'
    const store = createStore(terminalId)

    render(
      <Provider store={store}>
        <TerminalView
          tabId={`tab-${terminalId}`}
          paneId={`pane-${terminalId}`}
          paneContent={store.getState().panes.layouts[`tab-${terminalId}`]!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', terminalId)).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        attachRequestId: expect.any(String),
      })
    })

    const attach = lastSent('terminal.attach', terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 1,
      replayFromSeq: 1,
      replayToSeq: 1,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[0],
      attachRequestId: attach.attachRequestId,
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([])

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 2,
      data: `${OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[1]}${OPEN_CODE_STARTUP_VISIBLE_TEXT}`,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toHaveLength(1)
    expect(ioEvents[0]).toEqual({
      kind: 'write',
      data: expect.stringContaining(OPEN_CODE_STARTUP_VISIBLE_TEXT),
    })
  })

  it('buffers a split live startup probe and replies exactly once when it completes', async () => {
    const terminalId = 'term-opencode-split-live'
    const store = createStore(terminalId)

    render(
      <Provider store={store}>
        <TerminalView
          tabId={`tab-${terminalId}`}
          paneId={`pane-${terminalId}`}
          paneContent={store.getState().panes.layouts[`tab-${terminalId}`]!.content as TerminalPaneContent}
          hidden={false}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(lastSent('terminal.attach', terminalId)).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        attachRequestId: expect.any(String),
      })
    })

    const attach = lastSent('terminal.attach', terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 0,
      replayFromSeq: 1,
      replayToSeq: 0,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[0],
      attachRequestId: attach.attachRequestId,
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([])

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 2,
      data: `${OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES[1]}${OPEN_CODE_STARTUP_VISIBLE_TEXT}`,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    const inputMessages = sentMessages().filter((msg) => msg?.type === 'terminal.input')
    expect(inputMessages).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
      { kind: 'write' as const, data: OPEN_CODE_STARTUP_EXPECTED_CLEANED },
    ])
  })
})

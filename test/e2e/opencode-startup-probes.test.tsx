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
  OPEN_CODE_STARTUP_POST_REPLY_FRAMES,
  OPEN_CODE_STARTUP_PROBE_FRAME,
  OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES,
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

function createStore(options: {
  requestId: string
  terminalId?: string
  status?: 'creating' | 'running'
}) {
  const terminalId = options.terminalId
  const status = options.status ?? (terminalId ? 'running' : 'creating')
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: options.requestId,
    status,
    mode: 'opencode',
    shell: 'system',
    ...(terminalId ? { terminalId } : {}),
  }

  const stableId = terminalId ?? options.requestId
  const layout: PaneNode = { type: 'leaf', id: `pane-${stableId}`, content: paneContent }

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
          id: `tab-${stableId}`,
          mode: 'opencode',
          status,
          title: 'OpenCode',
          createRequestId: options.requestId,
          ...(terminalId ? { terminalId } : {}),
        }],
        activeTabId: `tab-${stableId}`,
      },
      panes: {
        layouts: { [`tab-${stableId}`]: layout },
        activePane: { [`tab-${stableId}`]: `pane-${stableId}` },
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

function writeEvents() {
  return ioEvents.filter((event) => event.kind === 'write')
}

function postReplySeqRange(index: number, afterProbeSeqEnd: number) {
  if (index === 0) {
    return {
      seqStart: afterProbeSeqEnd + 1,
      seqEnd: afterProbeSeqEnd + 3,
    }
  }

  const seq = afterProbeSeqEnd + 3 + index
  return { seqStart: seq, seqEnd: seq }
}

function emitCapturedPostReplyFrames(
  terminalId: string,
  attachRequestId: string,
  afterProbeSeqEnd: number,
  opts?: {
    prependFirstFrame?: string
  },
) {
  OPEN_CODE_STARTUP_POST_REPLY_FRAMES.forEach((frame, index) => {
    const range = postReplySeqRange(index, afterProbeSeqEnd)
    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: range.seqStart,
      seqEnd: range.seqEnd,
      data: `${index === 0 ? opts?.prependFirstFrame ?? '' : ''}${frame}`,
      attachRequestId,
    })
  })
}

async function renderCreatedTerminal(terminalId: string) {
  const requestId = `req-${terminalId}`
  const store = createStore({ requestId })
  const stableId = requestId

  render(
    <Provider store={store}>
      <TerminalView
        tabId={`tab-${stableId}`}
        paneId={`pane-${stableId}`}
        paneContent={store.getState().panes.layouts[`tab-${stableId}`]!.content as TerminalPaneContent}
        hidden={false}
      />
    </Provider>,
  )

  await waitFor(() => {
    expect(lastSent('terminal.create')).toMatchObject({
      type: 'terminal.create',
      requestId,
      mode: 'opencode',
    })
  })

  wsHarness.send.mockClear()

  wsHarness.emit({
    type: 'terminal.created',
    requestId,
    terminalId,
    createdAt: Date.now(),
  })

  await waitFor(() => {
    expect(lastSent('terminal.attach', terminalId)).toMatchObject({
      type: 'terminal.attach',
      terminalId,
      attachRequestId: expect.any(String),
    })
  })

  const attach = lastSent('terminal.attach', terminalId)

  return {
    store,
    attach,
    terminalId,
  }
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

  it('replies to live startup probes before writing the first captured post-reply output', async () => {
    const terminalId = 'term-opencode-live'
    const { attach } = await renderCreatedTerminal(terminalId)
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
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
      attachRequestId: attach.attachRequestId,
    })

    expect(terminalInstances[0]!.write).not.toHaveBeenCalled()

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
    ])

    emitCapturedPostReplyFrames(terminalId, attach.attachRequestId, 1)

    await waitFor(() => {
      expect(writeEvents().map((event) => event.data).join('')).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
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
      ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((data) => ({ kind: 'write' as const, data })),
    ])
  })

  it('passes later standalone OSC 11 queries through unchanged after startup completes', async () => {
    const terminalId = 'term-opencode-runtime-osc11'
    const { attach } = await renderCreatedTerminal(terminalId)
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
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
      attachRequestId: attach.attachRequestId,
    })
    emitCapturedPostReplyFrames(terminalId, attach.attachRequestId, 1)

    await waitFor(() => {
      expect(writeEvents().map((event) => event.data).join('')).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
    })

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 5,
      seqEnd: 5,
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(writeEvents().map((event) => event.data)).toEqual([
        ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES,
        OPEN_CODE_STARTUP_PROBE_FRAME,
      ])
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
      ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((data) => ({ kind: 'write' as const, data })),
      { kind: 'write' as const, data: OPEN_CODE_STARTUP_PROBE_FRAME },
    ])
  })

  it('strips historical startup probes during replay without sending late replies', async () => {
    const terminalId = 'term-opencode-replay'
    const { attach } = await renderCreatedTerminal(terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 4,
      replayFromSeq: 1,
      replayToSeq: 4,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
      attachRequestId: attach.attachRequestId,
    })
    emitCapturedPostReplyFrames(terminalId, attach.attachRequestId, 1)
    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 5,
      seqEnd: 5,
      data: 'live tail',
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((data) => ({ kind: 'write' as const, data })),
      { kind: 'write', data: 'live tail' },
    ])
  })

  it('does not complete a replay-fragment startup probe from the first live frame', async () => {
    const terminalId = 'term-opencode-replay-live-boundary'
    const [firstSplitFrame, secondSplitFrame] = OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES
    const { attach } = await renderCreatedTerminal(terminalId)
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
      data: firstSplitFrame,
      attachRequestId: attach.attachRequestId,
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([])

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 4,
      data: `${secondSplitFrame}${OPEN_CODE_STARTUP_POST_REPLY_FRAMES[0] ?? ''}`,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toHaveLength(1)
    expect(ioEvents[0]).toEqual({
      kind: 'write',
      data: OPEN_CODE_STARTUP_EXPECTED_CLEANED,
    })
  })

  it('discards replay fragments that end before the final startup-probe bytes', async () => {
    const terminalId = 'term-opencode-replay-early-fragment'
    const { attach } = await renderCreatedTerminal(terminalId)
    const replayFragment = OPEN_CODE_STARTUP_PROBE_FRAME.slice(0, -2)
    const liveRemainder = OPEN_CODE_STARTUP_PROBE_FRAME.slice(replayFragment.length)

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
      data: replayFragment,
      attachRequestId: attach.attachRequestId,
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([])

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 4,
      data: `${liveRemainder}${OPEN_CODE_STARTUP_POST_REPLY_FRAMES[0] ?? ''}`,
      attachRequestId: attach.attachRequestId,
    })

    await waitFor(() => {
      expect(terminalInstances[0]!.write).toHaveBeenCalled()
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([
      { kind: 'write', data: OPEN_CODE_STARTUP_EXPECTED_CLEANED },
    ])
  })

  it('buffers a split live startup probe and replies exactly once when it completes', async () => {
    const terminalId = 'term-opencode-split-live'
    const [firstSplitFrame, secondSplitFrame] = OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES
    const { attach } = await renderCreatedTerminal(terminalId)
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
      data: firstSplitFrame,
      attachRequestId: attach.attachRequestId,
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual([])
    expect(ioEvents).toEqual([])

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 2,
      seqEnd: 4,
      data: `${secondSplitFrame}${OPEN_CODE_STARTUP_POST_REPLY_FRAMES[0] ?? ''}`,
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
      { kind: 'write' as const, data: OPEN_CODE_STARTUP_POST_REPLY_FRAMES[0] ?? '' },
    ])
  })

  it('answers a complete startup probe on the first accepted post-replay live frame', async () => {
    const terminalId = 'term-opencode-first-live-after-replay'
    const { attach } = await renderCreatedTerminal(terminalId)
    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId,
      headSeq: 4,
      replayFromSeq: 1,
      replayToSeq: 4,
      attachRequestId: attach.attachRequestId,
    })

    wsHarness.send.mockClear()
    ioEvents.length = 0

    wsHarness.emit({
      type: 'terminal.output',
      terminalId,
      seqStart: 5,
      seqEnd: 5,
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
      attachRequestId: attach.attachRequestId,
    })

    expect(terminalInstances[0]!.write).not.toHaveBeenCalled()

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.input')).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )

    emitCapturedPostReplyFrames(terminalId, attach.attachRequestId, 5)

    await waitFor(() => {
      expect(writeEvents().map((event) => event.data).join('')).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
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
      ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((data) => ({ kind: 'write' as const, data })),
    ])
  })
})

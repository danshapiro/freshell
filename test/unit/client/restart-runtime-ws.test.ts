import { configureStore } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import panesReducer from '@/store/panesSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import tabsReducer, { updateTab } from '@/store/tabsSlice'
import terminalLifecycleReducer, {
  recordTerminalExit,
} from '@/store/terminalLifecycleSlice'
import { WsClient } from '@/lib/ws-client'

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.OPEN
  onopen: null | (() => void) = null
  onmessage: null | ((ev: { data: string }) => void) = null
  onclose: null | ((ev: { code: number; reason: string }) => void) = null
  onerror: null | (() => void) = null
  sent: string[] = []

  constructor(_url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: unknown) {
    this.sent.push(String(data))
  }

  close() {
    this.onclose?.({ code: 1000, reason: '' })
  }

  message(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  drop() {
    this.onclose?.({ code: 1006, reason: 'dropped' })
  }
}

function sent(socket: MockWebSocket) {
  return socket.sent.map((frame) => JSON.parse(frame))
}

function makeStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      freshAgent: freshAgentReducer,
      tabs: tabsReducer,
      terminalLifecycle: terminalLifecycleReducer,
    },
    preloadedState: {
      panes: {
        layouts: {
          tab1: {
            type: 'leaf' as const,
            id: 'pane-1',
            content: {
              kind: 'terminal' as const,
              createRequestId: 'create-1',
              status: 'running' as const,
              mode: 'claude' as const,
              shell: 'system' as const,
              terminalId: 'terminal-old',
              runtimeId: 'terminal-old',
              runtimeGeneration: 7,
              sessionRef: { provider: 'claude', sessionId: 's1' },
            },
          },
          tab2: {
            type: 'leaf' as const,
            id: 'pane-2',
            content: {
              kind: 'terminal' as const,
              createRequestId: 'create-2',
              status: 'running' as const,
              mode: 'claude' as const,
              shell: 'system' as const,
              terminalId: 'terminal-old',
              runtimeId: 'terminal-old',
              runtimeGeneration: 7,
              sessionRef: { provider: 'claude', sessionId: 's1' },
            },
          },
        },
        activePane: { tab1: 'pane-1', tab2: 'pane-2' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
        restoreFallbackAttemptsByPane: {},
      },
      freshAgent: {
        sessions: {},
        pendingCreates: {},
        pendingCreateFailures: {},
        availableModels: [],
      },
      tabs: {
        tabs: [
          {
            id: 'tab1',
            createRequestId: 'tab1',
            title: 'Viewer one',
            status: 'running' as const,
            mode: 'claude' as const,
            shell: 'system' as const,
            createdAt: 1,
          },
          {
            id: 'tab2',
            createRequestId: 'tab2',
            title: 'Viewer two',
            status: 'running' as const,
            mode: 'claude' as const,
            shell: 'system' as const,
            createdAt: 2,
          },
        ],
        activeTabId: 'tab1',
        renameRequestTabId: null,
        tombstones: [],
      },
      terminalLifecycle: {
        byPaneId: {},
      },
    },
  })
}

const request = {
  type: 'agent.restart' as const,
  requestId: 'restart-1',
  provider: 'claude',
  sessionId: 's1',
  kind: 'terminal' as const,
  liveId: 'terminal-old',
  expectedGeneration: 7,
}
const replaced = {
  type: 'agent.restart.replaced' as const,
  requestId: 'restart-1',
  provider: 'claude',
  sessionId: 's1',
  kind: 'terminal' as const,
  oldRuntimeId: 'terminal-old',
  oldGeneration: 7,
  runtimeId: 'terminal-new',
  generation: 8,
}
const started = {
  type: 'agent.restart.started' as const,
  requestId: 'restart-1',
  provider: 'claude',
  sessionId: 's1',
  kind: 'terminal' as const,
  runtime: {
    runtimeId: 'terminal-old',
    generation: 7,
  },
}
const retryableFailed = {
  type: 'agent.restart.failed' as const,
  requestId: 'restart-1',
  provider: 'claude',
  sessionId: 's1',
  kind: 'terminal' as const,
  runtimeId: 'terminal-old',
  generation: 7,
  code: 'REPLACEMENT_FAILED' as const,
  message: 'replacement is temporarily unavailable',
  retryable: true,
  recoveryPending: true,
}

describe('WsClient restart transaction folding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    // @ts-expect-error test transport
    globalThis.WebSocket = MockWebSocket
    localStorage.setItem('freshell.auth-token', 'token')
    ;(window as any).setTimeout = globalThis.setTimeout
    ;(window as any).clearTimeout = globalThis.clearTimeout
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('folds one replacement centrally and does not create for a duplicate event', async () => {
    const store = makeStore()
    const client = new WsClient('ws://example/ws')
    client.bindAgentRestartStore(store)
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise

    socket.message(replaced)
    socket.message(replaced)

    const content = store.getState().panes.layouts.tab1
    expect(content.type).toBe('leaf')
    if (content.type !== 'leaf' || content.content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.content.terminalId).toBe('terminal-new')
    expect(sent(socket).filter((frame) => frame.type === 'terminal.create')).toHaveLength(0)
  })

  it('restores every replacement viewer tab and clears only their old exit state', async () => {
    const store = makeStore()
    store.dispatch(updateTab({ id: 'tab1', updates: { status: 'exited' } }))
    store.dispatch(updateTab({ id: 'tab2', updates: { status: 'exited' } }))
    store.dispatch(recordTerminalExit({
      paneId: 'pane-1',
      terminalId: 'terminal-old',
      exitCode: 0,
      at: 1,
    }))
    store.dispatch(recordTerminalExit({
      paneId: 'pane-2',
      terminalId: 'terminal-old',
      exitCode: 0,
      at: 1,
    }))
    store.dispatch(recordTerminalExit({
      paneId: 'unrelated-pane',
      terminalId: 'terminal-unrelated',
      exitCode: 1,
      at: 1,
    }))

    const client = new WsClient('ws://example/ws')
    client.bindAgentRestartStore(store)
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise

    socket.message(replaced)

    expect(store.getState().tabs.tabs.map((tab) => [tab.id, tab.status])).toEqual([
      ['tab1', 'running'],
      ['tab2', 'running'],
    ])
    expect(store.getState().terminalLifecycle.byPaneId['pane-1']).toBeUndefined()
    expect(store.getState().terminalLifecycle.byPaneId['pane-2']).toBeUndefined()
    expect(store.getState().terminalLifecycle.byPaneId['unrelated-pane']?.exit?.exitCode).toBe(1)
  })

  it('resends an in-flight restart after ready and folds the stored terminal result once', async () => {
    const store = makeStore()
    const client = new WsClient('ws://example/ws')
    client.bindAgentRestartStore(store)
    const onReplacement = vi.fn()
    client.onMessage((message) => {
      if (message.type === 'agent.restart.replaced') {
        const content = store.getState().panes.layouts.tab1
        if (content.type !== 'leaf' || content.content.kind !== 'terminal') throw new Error('expected terminal')
        onReplacement(content.content.runtimeGeneration)
      }
    })

    const firstConnect = client.connect()
    const first = MockWebSocket.instances[0]
    first.onopen?.()
    first.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await firstConnect

    client.requestAgentRestart(request)
    expect(sent(first).filter((frame) => frame.type === 'agent.restart')).toEqual([request])
    first.drop()

    const reconnect = client.connect()
    const second = MockWebSocket.instances[1]
    second.onopen?.()
    second.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await reconnect
    expect(sent(second).filter((frame) => frame.type === 'agent.restart')).toEqual([request])

    second.message(replaced)
    second.message(replaced)
    expect(onReplacement).toHaveBeenCalledOnce()
    expect(onReplacement).toHaveBeenCalledWith(8)
    const content = store.getState().panes.layouts.tab1
    if (content.type !== 'leaf' || content.content.kind !== 'terminal') throw new Error('expected terminal')
    expect(content.content.runtimeGeneration).toBe(8)
  })

  it('retains and retries the byte-identical request after a retryable post-shutdown failure', async () => {
    const client = new WsClient('ws://example/ws')
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise

    client.requestAgentRestart(request)
    const firstWireRequest = socket.sent.find((frame) => JSON.parse(frame).type === 'agent.restart')
    expect(firstWireRequest).toBeDefined()

    socket.message(started)
    socket.message(retryableFailed)
    await vi.advanceTimersByTimeAsync(499)
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)

    const restartFrames = socket.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')
    expect(restartFrames).toEqual([firstWireRequest, firstWireRequest])

    socket.message(replaced)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')).toEqual([
      firstWireRequest,
      firstWireRequest,
    ])
  })

  it('keeps a post-shutdown retry pending across reconnect and resends the original request', async () => {
    const client = new WsClient('ws://example/ws')
    const firstConnect = client.connect()
    const first = MockWebSocket.instances[0]
    first.onopen?.()
    first.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await firstConnect

    client.requestAgentRestart(request)
    const originalWireRequest = first.sent.find((frame) => JSON.parse(frame).type === 'agent.restart')
    first.message(started)
    first.message(retryableFailed)
    first.drop()

    const reconnect = client.connect()
    const second = MockWebSocket.instances[1]
    second.onopen?.()
    second.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await reconnect

    expect(second.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')).toEqual([
      originalWireRequest,
    ])
    second.message(replaced)
  })

  it('keeps durable recovery when reconnect receives failure before started replay', async () => {
    const client = new WsClient('ws://example/ws')
    const firstConnect = client.connect()
    const first = MockWebSocket.instances[0]
    first.onopen?.()
    first.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await firstConnect

    client.requestAgentRestart(request)
    const originalWireRequest = first.sent.find((frame) => JSON.parse(frame).type === 'agent.restart')
    expect(originalWireRequest).toBeDefined()

    // The server accepted and retired the predecessor, but this socket drops
    // before the client observes its started edge.
    first.drop()
    const reconnect = client.connect()
    const second = MockWebSocket.instances[1]
    second.onopen?.()
    second.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await reconnect
    expect(client.isAgentRestartRecoveryPending(request.requestId)).toBe(false)

    // A failure from the durable transaction can overtake the replayed
    // started edge on the new socket. The frame itself is authoritative.
    second.message(retryableFailed)
    expect(client.isAgentRestartRecoveryPending(request.requestId)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)

    expect(second.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')).toEqual([
      originalWireRequest,
      originalWireRequest,
    ])
  })

  it('finalizes a retryable warming-index preflight failure that arrived before started', async () => {
    const client = new WsClient('ws://example/ws')
    const firstConnect = client.connect()
    const first = MockWebSocket.instances[0]
    first.onopen?.()
    first.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await firstConnect

    client.requestAgentRestart(request)
    first.message({
      ...retryableFailed,
      code: 'PREFLIGHT_FAILED' as const,
      message: 'session index is still warming; retry restart shortly',
      recoveryPending: false,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent(first).filter((frame) => frame.type === 'agent.restart')).toEqual([request])
    expect(client.isAgentRestartRecoveryPending(request.requestId)).toBe(false)

    first.drop()
    const reconnect = client.connect()
    const second = MockWebSocket.instances[1]
    second.onopen?.()
    second.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await reconnect

    expect(sent(second).filter((frame) => frame.type === 'agent.restart')).toHaveLength(0)
  })

  it('surfaces automatic retry exhaustion and Retry now reuses the original bytes and request ID', async () => {
    const client = new WsClient('ws://example/ws')
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise

    client.requestAgentRestart(request)
    const originalWireRequest = socket.sent.find((frame) => JSON.parse(frame).type === 'agent.restart')
    expect(originalWireRequest).toBeDefined()
    socket.message(started)

    for (const delay of [500, 1_000, 2_000]) {
      socket.message(retryableFailed)
      await vi.advanceTimersByTimeAsync(delay)
    }
    socket.message(retryableFailed)

    expect(client.isAgentRestartRecoveryPending(request.requestId)).toBe(true)
    expect(client.isAgentRestartRetryExhausted(request.requestId)).toBe(true)
    expect(client.retryAgentRestart(request.requestId)).toBe(true)
    expect(client.isAgentRestartRetryExhausted(request.requestId)).toBe(false)
    const restartFrames = socket.sent.filter((frame) => JSON.parse(frame).type === 'agent.restart')
    expect(restartFrames).toEqual([
      originalWireRequest,
      originalWireRequest,
      originalWireRequest,
      originalWireRequest,
      originalWireRequest,
    ])
  })

  it('finalizes a nonretryable failure and never retries it', async () => {
    const client = new WsClient('ws://example/ws')
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise

    client.requestAgentRestart(request)
    socket.message({ ...retryableFailed, retryable: false, code: 'UNRESUMABLE' as const })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(sent(socket).filter((frame) => frame.type === 'agent.restart')).toEqual([request])
  })

  it('does not replay a restart to a reconnected server that omitted the capability', async () => {
    const client = new WsClient('ws://example/ws')
    const firstConnect = client.connect()
    const first = MockWebSocket.instances[0]
    first.onopen?.()
    first.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await firstConnect
    client.requestAgentRestart(request)
    first.drop()

    const reconnect = client.connect()
    const downgraded = MockWebSocket.instances[1]
    downgraded.onopen?.()
    downgraded.message({ type: 'ready' })
    await reconnect

    expect(sent(downgraded).filter((frame) => frame.type === 'agent.restart')).toHaveLength(0)
  })

  it('refuses a new restart when the ready frame did not negotiate support', async () => {
    const client = new WsClient('ws://example/ws')
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready' })
    await promise

    expect(() => client.requestAgentRestart(request)).toThrow(/does not support/i)
    expect(sent(socket).filter((frame) => frame.type === 'agent.restart')).toHaveLength(0)
  })

  it('drops old-generation runtime frames after the replacement commits', async () => {
    const store = makeStore()
    const client = new WsClient('ws://example/ws')
    client.bindAgentRestartStore(store)
    const delivered = vi.fn()
    client.onMessage(delivered)
    const promise = client.connect()
    const socket = MockWebSocket.instances[0]
    socket.onopen?.()
    socket.message({ type: 'ready', capabilities: { agentRestartV1: true } })
    await promise
    delivered.mockClear()

    socket.message(replaced)
    socket.message({
      type: 'terminal.output',
      terminalId: 'terminal-old',
      data: 'stale',
      seqStart: 1,
      seqEnd: 1,
      streamId: 'old-stream',
      runtime: { runtimeId: 'terminal-old', generation: 7 },
    })
    socket.message({
      type: 'terminal.output',
      terminalId: 'terminal-new',
      data: 'current',
      seqStart: 1,
      seqEnd: 1,
      streamId: 'new-stream',
      runtime: { runtimeId: 'terminal-new', generation: 8 },
    })

    expect(delivered.mock.calls.map(([message]) => message.type)).toEqual([
      'agent.restart.replaced',
      'terminal.output',
    ])
    expect(delivered.mock.calls[1][0].data).toBe('current')
  })
})

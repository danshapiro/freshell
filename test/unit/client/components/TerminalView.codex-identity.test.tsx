import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const restoreRequestIds = new Set<string>()
  const send = vi.fn()
  const connect = vi.fn().mockResolvedValue(undefined)
  const onMessage = vi.fn((handler: (msg: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn(() => () => {})
  return {
    send,
    connect,
    onMessage,
    onReconnect,
    emit(msg: any) {
      for (const handler of [...messageHandlers]) handler(msg)
    },
    addRestoreRequestId(id: string) {
      restoreRequestIds.add(id)
    },
    consumeRestoreRequestId(id: string) {
      if (!restoreRequestIds.has(id)) return false
      restoreRequestIds.delete(id)
      return true
    },
    reset() {
      messageHandlers.clear()
      restoreRequestIds.clear()
      send.mockClear()
      connect.mockClear()
      onMessage.mockClear()
      onReconnect.mockClear()
    },
  }
})

const runtimeHarness = vi.hoisted(() => ({
  terminals: [] as any[],
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId: (id: string) => wsHarness.addRestoreRequestId(id),
  consumeTerminalRestoreRequestId: (id: string) => wsHarness.consumeRestoreRequestId(id),
  addTerminalFreshRecoveryRequestId: vi.fn(),
  consumeTerminalFreshRecoveryRequest: vi.fn(() => undefined),
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

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    private dataHandler?: (data: string) => void
    open = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler
      return { dispose: vi.fn() }
    })
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

    emitData(data: string) {
      this.dataHandler?.(data)
    }

    constructor() {
      runtimeHarness.terminals.push(this)
    }
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function findLeaf(node: PaneNode | undefined, paneId: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (!node) return null
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

function TerminalViewFromStore({ tabId, paneId }: { tabId: string; paneId: string }) {
  const paneContent = useAppSelector((state) => findLeaf(state.panes.layouts[tabId], paneId)?.content ?? null)
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

function createStore(content: TerminalPaneContent) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          mode: content.mode,
          status: content.status,
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: content.createRequestId,
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content,
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
    } as any,
  })
}

function sentMessages() {
  return wsHarness.send.mock.calls.map(([msg]) => msg)
}

describe('TerminalView codex identity', () => {
  beforeEach(() => {
    wsHarness.reset()
    runtimeHarness.terminals.length = 0
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

  it('includes expectedSessionRef on attach, resize, and input for canonical Codex panes', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-1',
      serverInstanceId: 'srv-local',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-1',
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-1')).toBe(true)
    })
    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.resize' && msg.terminalId === 'term-1')).toBe(true)
    })

    const term = runtimeHarness.terminals[0]
    act(() => {
      term.emitData('hello')
    })

    expect(sentMessages()).toContainEqual(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-1',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
    }))
    expect(sentMessages()).toContainEqual(expect.objectContaining({
      type: 'terminal.resize',
      terminalId: 'term-1',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
    }))
    expect(sentMessages()).toContainEqual({
      type: 'terminal.input',
      terminalId: 'term-1',
      data: 'hello',
      expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' },
    })
  })

  it('omits expectedSessionRef when only Codex durability evidence exists', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-2',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-2',
      serverInstanceId: 'srv-local',
      codexDurability: {
        schemaVersion: 1,
        state: 'captured_pre_turn',
        candidate: {
          provider: 'codex',
          candidateThreadId: 'thread-candidate',
          rolloutPath: '/tmp/rollout.jsonl',
          source: 'thread_started_notification',
          capturedAt: 1,
        },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-2')).toBe(true)
    })

    const term = runtimeHarness.terminals[0]
    act(() => {
      term.emitData('hello')
    })

    const attach = sentMessages().find((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-2')
    const input = sentMessages().find((msg) => msg?.type === 'terminal.input' && msg.terminalId === 'term-2')
    expect(attach?.expectedSessionRef).toBeUndefined()
    expect(input?.expectedSessionRef).toBeUndefined()
  })

  it('repairs stale runtime plumbing on SESSION_IDENTITY_MISMATCH and reissues a restore create', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-old',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-old',
      serverInstanceId: 'srv-old',
      streamId: 'stream-old',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-new',
      },
      codexDurability: {
        schemaVersion: 1,
        state: 'durable',
        durableThreadId: 'thread-new',
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-old')).toBe(true)
    })

    wsHarness.send.mockClear()

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
        message: 'wrong thread',
      })
    })

    await waitFor(() => {
      const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')
      expect(leaf?.content.kind).toBe('terminal')
      expect((leaf?.content as TerminalPaneContent).terminalId).toBeUndefined()
      expect((leaf?.content as TerminalPaneContent).status).toBe('creating')
    })

    const createMessages = sentMessages().filter((msg) => msg?.type === 'terminal.create')
    expect(createMessages).toHaveLength(1)
    expect(createMessages[0]).toMatchObject({
      type: 'terminal.create',
      mode: 'codex',
      restore: true,
      sessionRef: { provider: 'codex', sessionId: 'thread-new' },
    })
    expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-old')).toBe(false)

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'SESSION_IDENTITY_MISMATCH',
        terminalId: 'term-old',
        expectedSessionRef: { provider: 'codex', sessionId: 'thread-new' },
        actualSessionRef: { provider: 'codex', sessionId: 'thread-old' },
        message: 'wrong thread',
      })
    })

    expect(sentMessages().filter((msg) => msg?.type === 'terminal.create')).toHaveLength(1)
  })
})

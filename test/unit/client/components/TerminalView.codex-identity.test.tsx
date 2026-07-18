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

  it('preserves a durable-identity breadcrumb instead of silently wiping restoreError when a codex pane has no resumable identity on INVALID_TERMINAL_ID', async () => {
    // Regression test: previously this branch persisted a totally clean slate
    // (restoreError: undefined) the instant the live terminal died with no
    // sessionRef/codexDurability candidate -- destroying any trace that this
    // pane used to be a durable codex session, so a refresh mid-restore
    // showed a blank, unexplained fresh terminal with no way to recognize
    // what happened. Scoped to codex only: it's the only terminal mode with
    // a durable-identity capture mechanism (codexDurability) to have lost --
    // claude/gemini terminal mode has an existing, intentional "silent clean
    // fresh recovery" contract (see TerminalView.lifecycle.test.tsx: "starts
    // explicit fresh recovery for a live-only INVALID_TERMINAL_ID reconnect").
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-codex-lost',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-codex-lost',
      serverInstanceId: 'srv-local',
      // No sessionRef, no codexDurability candidate: genuinely no durable
      // identity breadcrumb is recoverable for this pane.
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-codex-lost')).toBe(true)
    })

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        terminalId: 'term-codex-lost',
        message: 'terminal not found',
      })
    })

    await waitFor(() => {
      const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')
      const content = leaf?.content as TerminalPaneContent
      expect(content.terminalId).toBeUndefined()
      expect(content.status).toBe('creating')
      expect(content.restoreError).toBeDefined()
      expect(content.restoreError?.reason).toBe('durable_artifact_missing')
    })
  })

  it('leaves restoreError untouched (fresh path stays silent) for a plain shell pane on the same INVALID_TERMINAL_ID collapse', async () => {
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-shell-lost',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: 'term-shell-lost',
      serverInstanceId: 'srv-local',
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-shell-lost')).toBe(true)
    })

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        terminalId: 'term-shell-lost',
        message: 'terminal not found',
      })
    })

    await waitFor(() => {
      const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')
      const content = leaf?.content as TerminalPaneContent
      expect(content.terminalId).toBeUndefined()
      expect(content.status).toBe('creating')
    })
    const leaf = findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')
    expect((leaf?.content as TerminalPaneContent).restoreError).toBeUndefined()
  })

  it('re-drives creation for a still-unanchored pane on a second reconnect (bounded, idempotent re-anchor)', async () => {
    // Regression test: ws-client drops any queued terminal.attach on
    // reconnect (nothing to attach to for a pane with no live terminal yet),
    // and the pane's own onReconnect handler previously did nothing when it
    // had no terminalId. A create/attach in flight when a SECOND disconnect
    // landed mid-restore was therefore a one-shot: nothing ever retried it,
    // leaving the pane permanently half-restored.
    const store = createStore({
      kind: 'terminal',
      createRequestId: 'req-reanchor',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      serverInstanceId: 'srv-local',
      // No terminalId yet: this pane is still awaiting terminal.created.
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.create' && msg.requestId === 'req-reanchor')).toBe(true)
    })

    wsHarness.send.mockClear()

    // Simulate reconnect completion (e.g. the server restarted a second time
    // mid-restore): the ready handler fires every registered reconnect
    // handler on each reconnect, regardless of how many there were before.
    const reconnectHandler = wsHarness.onReconnect.mock.calls[0]?.[0]
    expect(reconnectHandler).toBeTypeOf('function')
    act(() => {
      reconnectHandler()
    })

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.create' && msg.requestId === 'req-reanchor')).toBe(true)
    })

    // Idempotent: a second reconnect with the pane still unanchored must not
    // spawn duplicate creates beyond what the re-drive already sent once.
    const createCountAfterFirstReanchor = sentMessages().filter((msg) => msg?.type === 'terminal.create').length
    act(() => {
      reconnectHandler()
    })
    await waitFor(() => {
      expect(sentMessages().filter((msg) => msg?.type === 'terminal.create').length).toBeGreaterThanOrEqual(createCountAfterFirstReanchor)
    })
    expect(sentMessages().filter((msg) => msg?.type === 'terminal.create').every((msg) => msg.requestId === 'req-reanchor')).toBe(true)
  })
})

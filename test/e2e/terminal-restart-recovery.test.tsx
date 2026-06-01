import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { clearDeadTerminals, reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const addedRestoreIds = new Set<string>()
  const addedFreshRecoveryIds = new Map<string, string>()

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    }),
    onReconnect: vi.fn(() => () => {}),
    addRestoreRequestId(id: string) {
      addedRestoreIds.add(id)
    },
    consumeRestoreRequestId(id: string) {
      if (!addedRestoreIds.has(id)) return false
      addedRestoreIds.delete(id)
      return true
    },
    addFreshRecoveryRequestId(id: string, intent: string) {
      addedFreshRecoveryIds.set(id, intent)
      addedRestoreIds.delete(id)
    },
    consumeFreshRecoveryRequest(id: string) {
      const intent = addedFreshRecoveryIds.get(id)
      if (!intent) return undefined
      addedFreshRecoveryIds.delete(id)
      addedRestoreIds.delete(id)
      return intent
    },
    reset() {
      messageHandlers.clear()
      addedRestoreIds.clear()
      addedFreshRecoveryIds.clear()
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

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId: (id: string) => wsHarness.addRestoreRequestId(id),
  consumeTerminalRestoreRequestId: (id: string) => wsHarness.consumeRestoreRequestId(id),
  addTerminalFreshRecoveryRequestId: (id: string, intent: string) => wsHarness.addFreshRecoveryRequestId(id, intent),
  consumeTerminalFreshRecoveryRequest: (id: string) => wsHarness.consumeFreshRecoveryRequest(id),
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
  }

  return { Terminal: MockTerminal }
})

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

function createStore(layout: PaneNode) {
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
          id: 'tab-restart',
          mode: 'codex',
          status: 'running',
          title: 'Restart',
          titleSetByUser: false,
          createRequestId: 'tab-restart',
        }],
        activeTabId: 'tab-restart',
      },
      panes: {
        layouts: { 'tab-restart': layout },
        activePane: { 'tab-restart': 'pane-codex' },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'ready', error: null, serverInstanceId: 'srv-new' },
    },
  })
}

function registerRecoveryRequestsFromState(store: ReturnType<typeof createStore>) {
  const state = store.getState()
  const attempts = state.panes.restoreFallbackAttemptsByPane || {}
  const walk = (tabId: string, node: PaneNode) => {
    if (node.type === 'leaf') {
      const content = node.content
      if (content.kind !== 'terminal' || content.status !== 'creating') return
      const attempt = attempts[tabId]?.[node.id]
      if (attempt?.requestId === content.createRequestId && !content.sessionRef) {
        wsHarness.addFreshRecoveryRequestId(content.createRequestId, 'fresh_after_restore_unavailable')
      } else if (content.sessionRef) {
        wsHarness.addRestoreRequestId(content.createRequestId)
      }
      return
    }
    walk(tabId, node.children[0])
    walk(tabId, node.children[1])
  }

  for (const [tabId, node] of Object.entries(state.panes.layouts)) {
    walk(tabId, node)
  }
}

function sentMessages() {
  return wsHarness.send.mock.calls.map(([msg]) => msg)
}

describe('terminal restart recovery (e2e)', () => {
  beforeEach(() => {
    wsHarness.reset()
    wsHarness.send.mockClear()
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

  it('restores panes with durable identity and fresh-recovers missing-identity panes once after inventory loss', async () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-root',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        {
          type: 'leaf',
          id: 'pane-codex',
          content: {
            kind: 'terminal',
            createRequestId: 'req-codex-old',
            status: 'running',
            mode: 'codex',
            shell: 'system',
            terminalId: 'term-codex-old',
            serverInstanceId: 'srv-old',
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-session-1',
            },
          } satisfies TerminalPaneContent,
        },
        {
          type: 'split',
          id: 'split-secondary',
          direction: 'vertical',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'pane-opencode',
              content: {
                kind: 'terminal',
                createRequestId: 'req-opencode-old',
                status: 'running',
                mode: 'opencode',
                shell: 'system',
                terminalId: 'term-opencode-old',
                serverInstanceId: 'srv-old',
                sessionRef: {
                  provider: 'opencode',
                  sessionId: 'opencode-root-session-1',
                },
              } satisfies TerminalPaneContent,
            },
            {
              type: 'leaf',
              id: 'pane-shell',
              content: {
                kind: 'terminal',
                createRequestId: 'req-shell-old',
                status: 'running',
                mode: 'shell',
                shell: 'system',
                terminalId: 'term-shell-old',
                serverInstanceId: 'srv-old',
              } satisfies TerminalPaneContent,
            },
          ],
        },
      ],
    }

    const store = createStore(layout)

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-restart" paneId="pane-codex" />
        <TerminalViewFromStore tabId="tab-restart" paneId="pane-opencode" />
        <TerminalViewFromStore tabId="tab-restart" paneId="pane-shell" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-codex-old')).toBe(true)
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-opencode-old')).toBe(true)
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-shell-old')).toBe(true)
    })

    wsHarness.send.mockClear()
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    registerRecoveryRequestsFromState(store)

    await waitFor(() => {
      const creates = sentMessages().filter((msg) => msg?.type === 'terminal.create')
      expect(creates).toHaveLength(3)

      const codexCreate = creates.find((msg) => msg.mode === 'codex')
      expect(codexCreate).toMatchObject({
        type: 'terminal.create',
        mode: 'codex',
        restore: true,
        sessionRef: {
          provider: 'codex',
          sessionId: 'codex-session-1',
        },
      })

      const opencodeCreate = creates.find((msg) => msg.mode === 'opencode')
      expect(opencodeCreate).toMatchObject({
        type: 'terminal.create',
        mode: 'opencode',
        restore: true,
        sessionRef: {
          provider: 'opencode',
          sessionId: 'opencode-root-session-1',
        },
      })
      expect(opencodeCreate).not.toHaveProperty('recoveryIntent')

      const shellCreate = creates.find((msg) => msg.mode === 'shell')
      expect(shellCreate).toMatchObject({
        type: 'terminal.create',
        mode: 'shell',
        recoveryIntent: 'fresh_after_restore_unavailable',
      })
      expect(shellCreate).not.toHaveProperty('restore')
      expect(shellCreate).not.toHaveProperty('sessionRef')
      expect(shellCreate).not.toHaveProperty('liveTerminal')
    })

    wsHarness.send.mockClear()
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    registerRecoveryRequestsFromState(store)

    await waitFor(() => {
      expect(sentMessages().filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)
    })
  })

  it('restores an OpenCode pane after inventory recovers a missing sessionRef before stale-handle cleanup', async () => {
    const paneId = 'pane-codex'
    const layout: PaneNode = {
      type: 'leaf',
      id: paneId,
      content: {
        kind: 'terminal',
        createRequestId: 'req-opencode-old',
        status: 'running',
        mode: 'opencode',
        shell: 'system',
        terminalId: 'term-opencode-old',
        serverInstanceId: 'srv-old',
      } satisfies TerminalPaneContent,
    }
    const store = createStore(layout)

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId="tab-restart" paneId={paneId} />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-opencode-old')).toBe(true)
    })

    wsHarness.send.mockClear()
    store.dispatch(reconcileTerminalSessionRefByTerminalId({
      terminalId: 'term-opencode-old',
      sessionRef: {
        provider: 'opencode',
        sessionId: 'ses_root_recovered_before_dead_clear',
      },
    }))
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    registerRecoveryRequestsFromState(store)

    await waitFor(() => {
      const create = sentMessages().find((msg) => msg?.type === 'terminal.create')
      expect(create).toMatchObject({
        type: 'terminal.create',
        mode: 'opencode',
        restore: true,
        sessionRef: {
          provider: 'opencode',
          sessionId: 'ses_root_recovered_before_dead_clear',
        },
      })
      expect(create).not.toHaveProperty('recoveryIntent')
    })
  })
})

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import TerminalView from '@/components/TerminalView'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { persistMiddleware, resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
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
  getTerminalTheme: vi.fn(() => ({})),
}))

vi.mock('@/lib/terminal-restore', () => ({
  consumeTerminalRestoreRequestId: vi.fn(() => false),
  addTerminalRestoreRequestId: vi.fn(),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

const terminalInstances: any[] = []

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createSettingsState() {
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = resolveLocalSettings()
  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function contentFor(store: ReturnType<typeof createStore>, tabId: string): TerminalPaneContent {
  const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
  return layout.content
}

function latestAttachRequestId(terminalId: string): string | undefined {
  return [...wsMocks.send.mock.calls]
    .map(([msg]) => msg)
    .reverse()
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    ?.attachRequestId
}

function createStore() {
  const tabId = 'tab-codex-resilience'
  const paneId = 'pane-codex-resilience'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-codex-resilience',
    status: 'creating',
    mode: 'codex',
    shell: 'system',
    initialCwd: '/tmp',
  }
  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
      paneRuntimeActivity: paneRuntimeActivityReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(persistMiddleware),
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'codex',
          status: 'creating',
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: 'req-codex-resilience',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      turnCompletion: { terminalStates: {} },
      paneRuntimeActivity: { byPaneId: {} },
    },
  })
  return { store, tabId, paneId, paneContent }
}

describe('Codex session resilience flow', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    terminalInstances.length = 0
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => {
        messageHandler = null
      }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) {
          reconnectHandler = null
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    messageHandler = null
    reconnectHandler = null
  })

  it('keeps the mounted pane and terminal id until terminal.exit', async () => {
    const { store, tabId, paneId, paneContent } = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => expect(messageHandler).not.toBeNull())

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-codex-resilience',
        terminalId: 'term-codex-resilience',
        createdAt: Date.now(),
      })
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-resilience',
        attachRequestId: latestAttachRequestId('term-codex-resilience'),
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-codex-resilience',
        status: 'recovering',
      })
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-codex-resilience',
        status: 'running',
      })
    })

    expect(contentFor(store, tabId).terminalId).toBe('term-codex-resilience')
    expect(contentFor(store, tabId).status).toBe('running')

    const onData = terminalInstances[0].onData.mock.calls[0][0]
    act(() => {
      onData('x')
    })
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.input',
      terminalId: 'term-codex-resilience',
      data: 'x',
    }))

    act(() => {
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-codex-resilience',
        status: 'recovery_failed',
      })
    })
    expect(contentFor(store, tabId).terminalId).toBe('term-codex-resilience')
    expect(contentFor(store, tabId).status).toBe('recovery_failed')

    act(() => {
      messageHandler!({
        type: 'terminal.exit',
        terminalId: 'term-codex-resilience',
        exitCode: 0,
      })
    })
    expect(contentFor(store, tabId).terminalId).toBeUndefined()
    expect(contentFor(store, tabId).status).toBe('exited')
  })

  it('keeps server runtime status authoritative when reattach becomes ready', async () => {
    const { store, tabId, paneId, paneContent } = createStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => expect(messageHandler).not.toBeNull())
    await waitFor(() => expect(reconnectHandler).not.toBeNull())

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-codex-resilience',
        terminalId: 'term-codex-reattach',
        createdAt: Date.now(),
      })
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-reattach',
        attachRequestId: latestAttachRequestId('term-codex-reattach'),
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
      messageHandler!({
        type: 'terminal.status',
        terminalId: 'term-codex-reattach',
        status: 'recovery_failed',
      })
    })
    expect(contentFor(store, tabId).status).toBe('recovery_failed')

    act(() => {
      reconnectHandler!()
    })
    const reattachRequestId = latestAttachRequestId('term-codex-reattach')
    expect(reattachRequestId).toBeTruthy()

    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-codex-reattach',
        attachRequestId: reattachRequestId,
        headSeq: 0,
        replayFromSeq: 0,
        replayToSeq: 0,
      })
    })

    expect(contentFor(store, tabId).terminalId).toBe('term-codex-reattach')
    expect(contentFor(store, tabId).status).toBe('recovery_failed')
  })
})

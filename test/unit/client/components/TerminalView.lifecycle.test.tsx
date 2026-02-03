import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

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
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('xterm/css/xterm.css', () => ({}))

import TerminalView from '@/components/TerminalView'

function TerminalViewFromStore({ tabId, paneId }: { tabId: string; paneId: string }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf') return null
    return layout.content
  })
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

describe('TerminalView lifecycle updates', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    wsMocks.send.mockClear()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => { messageHandler = null }
    })
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('preserves terminalId across sequential status updates', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'creating',
      mode: 'claude',
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
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            title: 'Claude',
            createdAt: Date.now(),
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-1',
      terminalId: 'term-1',
      snapshot: '',
      createdAt: Date.now(),
    })

    messageHandler!({
      type: 'terminal.attached',
      terminalId: 'term-1',
      snapshot: '',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(layout.content.status).toBe('running')
  })

  it('ignores INVALID_TERMINAL_ID errors for other terminals', async () => {
    const tabId = 'tab-2'
    const paneId = 'pane-2'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-2',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-1',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            title: 'Claude',
            createdAt: Date.now(),
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
          paneTitleSetByUser: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-2',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
    }))
  })

  it('recreates terminal once after INVALID_TERMINAL_ID for the current terminal', async () => {
    const tabId = 'tab-3'
    const paneId = 'pane-3'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-3',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-3',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-3',
            createRequestId: 'req-3',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null },
      },
    })

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()
    const onMessageCallsBefore = wsMocks.onMessage.mock.calls.length

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-3',
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.createRequestId).not.toBe('req-3')
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    const newPaneContent = layout.content as TerminalPaneContent
    const newRequestId = newPaneContent.createRequestId

    rerender(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={newPaneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage.mock.calls.length).toBeGreaterThan(onMessageCallsBefore)
    })

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThanOrEqual(1)
    })

    const createCalls = wsMocks.send.mock.calls.filter(([msg]) =>
      msg?.type === 'terminal.create' && msg.requestId === newRequestId
    )
    expect(createCalls).toHaveLength(1)
  })

  it('does not reconnect after terminal.exit when INVALID_TERMINAL_ID is received', async () => {
    // This test verifies the fix for the runaway terminal creation loop:
    // 1. Terminal exits normally (e.g., Claude fails to resume)
    // 2. Some operation (resize) triggers INVALID_TERMINAL_ID for the dead terminal
    // 3. The INVALID_TERMINAL_ID handler should NOT trigger reconnection because
    //    the terminal was already marked as exited (terminalIdRef was cleared)
    const tabId = 'tab-exit'
    const paneId = 'pane-exit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-exit',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-exit',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-exit',
            createRequestId: 'req-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Terminal exits (simulates Claude failing to resume due to invalid path)
    messageHandler!({
      type: 'terminal.exit',
      terminalId: 'term-exit',
      exitCode: 1,
    })

    // Verify status is 'exited'
    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.status).toBe('exited')
    })

    // Clear send mock to track only new calls
    wsMocks.send.mockClear()

    // Now simulate INVALID_TERMINAL_ID (as if a resize was sent to the dead terminal)
    // This should NOT trigger reconnection because terminal already exited
    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-exit',
    })

    // Give any async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify NO terminal.create was sent (this is the key assertion)
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)

    // Verify the pane content still shows exited status with original terminalId preserved in Redux
    // (but the ref should have been cleared, which we can't directly test here)
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('exited')
  })
})

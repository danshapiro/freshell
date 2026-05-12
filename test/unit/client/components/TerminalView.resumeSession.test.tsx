import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { useAppSelector } from '@/store/hooks'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
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
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

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

describe('TerminalView durable session contract', () => {
  beforeEach(() => {
    wsMocks.send.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('includes canonical sessionRef when creating a durable restore terminal', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      sessionRef: {
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      },
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
            createRequestId: 'req-1',
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
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: 'req-1',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_CLAUDE_SESSION_ID,
        },
      }))
    })
  })

  it('keeps terminal.created live-only until an explicit terminal.session.associated arrives', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'
    let messageHandler: ((msg: any) => void) | null = null

    wsMocks.onMessage.mockImplementation((handler: (msg: any) => void) => {
      messageHandler = handler
      return () => {}
    })

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
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-1',
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
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: 'req-1',
      }))
    })

    messageHandler?.({
      type: 'terminal.created',
      requestId: 'req-1',
      terminalId: 'term-1',
    })

    await waitFor(() => {
      const content = store.getState().panes.layouts[tabId]
      if (content?.type !== 'leaf') throw new Error('unexpected layout')
      if (content.content.kind !== 'terminal') throw new Error('unexpected content')
      expect(content.content.terminalId).toBe('term-1')
      expect(content.content.resumeSessionId).toBeUndefined()
      expect(content.content.sessionRef).toBeUndefined()
    })
  })

  it('persists canonical durable sessionRef only after terminal.session.associated', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'
    let messageHandler: ((msg: any) => void) | null = null

    wsMocks.onMessage.mockImplementation((handler: (msg: any) => void) => {
      messageHandler = handler
      return () => {}
    })

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
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-1',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: 'req-1',
      }))
    })

    messageHandler?.({
      type: 'terminal.created',
      requestId: 'req-1',
      terminalId: 'term-1',
    })

    messageHandler?.({
      type: 'terminal.session.associated',
      terminalId: 'term-1',
      sessionRef: {
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      },
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId]
      if (layout?.type !== 'leaf') throw new Error('unexpected layout')
      if (layout.content.kind !== 'terminal') throw new Error('unexpected content')
      expect(layout.content.sessionRef).toEqual({
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      })

      const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
      expect(tab?.sessionRef).toEqual({
        provider: 'claude',
        sessionId: VALID_CLAUDE_SESSION_ID,
      })
    })
  })

  it('creates a fresh terminal once after invalid terminal id with no durable session ref', async () => {
    const tabId = 'tab-opencode'
    const paneId = 'pane-opencode'
    let messageHandler: ((msg: any) => void) | null = null

    wsMocks.onMessage.mockImplementation((handler: (msg: any) => void) => {
      messageHandler = handler
      return () => {}
    })

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-opencode-fresh-fallback',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      terminalId: 'dead-term-1',
      serverInstanceId: 'srv-old',
      initialCwd: '/repo/project',
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
            mode: 'opencode',
            status: 'running',
            title: 'OpenCode',
            titleSetByUser: false,
            createRequestId: 'req-opencode-fresh-fallback',
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
      </Provider>,
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    wsMocks.send.mockClear()

    messageHandler?.({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      terminalId: 'dead-term-1',
      message: 'Unknown terminalId',
    })

    await waitFor(() => {
      const createMessage = wsMocks.send.mock.calls.find(([msg]) => (
        msg.type === 'terminal.create'
        && msg.mode === 'opencode'
        && msg.recoveryIntent === 'fresh_after_restore_unavailable'
      ))?.[0]
      expect(createMessage).toMatchObject({
        type: 'terminal.create',
        mode: 'opencode',
        recoveryIntent: 'fresh_after_restore_unavailable',
      })
      expect(createMessage).not.toHaveProperty('restore')
      expect(createMessage).not.toHaveProperty('sessionRef')
      expect(createMessage).not.toHaveProperty('liveTerminal')
      expect(createMessage).not.toHaveProperty('resumeSessionId')
    })

    const firstFreshCreates = wsMocks.send.mock.calls.filter(([msg]) => (
      msg.type === 'terminal.create'
      && msg.mode === 'opencode'
      && msg.recoveryIntent === 'fresh_after_restore_unavailable'
      && msg.restore !== true
      && !('sessionRef' in msg)
      && !('liveTerminal' in msg)
    ))
    expect(firstFreshCreates).toHaveLength(1)

    wsMocks.send.mockClear()
    messageHandler?.({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      terminalId: 'dead-term-1',
      message: 'Unknown terminalId',
    })

    await waitFor(() => {
      const secondFreshCreates = wsMocks.send.mock.calls.filter(([msg]) => (
        msg.type === 'terminal.create'
        && msg.mode === 'opencode'
        && msg.recoveryIntent === 'fresh_after_restore_unavailable'
      ))
      expect(secondFreshCreates).toHaveLength(0)
    })
  })
})

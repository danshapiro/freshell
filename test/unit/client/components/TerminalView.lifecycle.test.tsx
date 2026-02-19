import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const restoreMocks = vi.hoisted(() => ({
  consumeTerminalRestoreRequestId: vi.fn(() => false),
  addTerminalRestoreRequestId: vi.fn(),
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

vi.mock('@/lib/terminal-restore', () => ({
  consumeTerminalRestoreRequestId: restoreMocks.consumeTerminalRestoreRequestId,
  addTerminalRestoreRequestId: restoreMocks.addTerminalRestoreRequestId,
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
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() { terminalInstances.push(this) }
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

describe('TerminalView lifecycle updates', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null

  beforeEach(() => {
    wsMocks.send.mockClear()
    restoreMocks.consumeTerminalRestoreRequestId.mockReset()
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    terminalInstances.length = 0
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) reconnectHandler = null
      }
    })
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    reconnectHandler = null
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

  it('focuses the remembered active pane terminal when tab becomes active', async () => {
    const paneA: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-a',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }
    const paneB: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-b',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              mode: 'shell',
              status: 'running',
              title: 'Tab 1',
              createRequestId: 'tab-1',
            },
            {
              id: 'tab-2',
              mode: 'shell',
              status: 'running',
              title: 'Tab 2',
              createRequestId: 'tab-2',
            },
          ],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {
            'tab-2': 'pane-2b',
          },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    function Tab2TerminalViews() {
      const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
      const hidden = activeTabId !== 'tab-2'

      return (
        <>
          <TerminalView tabId="tab-2" paneId="pane-2a" paneContent={paneA} hidden={hidden} />
          <TerminalView tabId="tab-2" paneId="pane-2b" paneContent={paneB} hidden={hidden} />
        </>
      )
    }

    render(
      <Provider store={store}>
        <Tab2TerminalViews />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(2)
    })
    await waitFor(() => {
      expect(terminalInstances[0].focus).toHaveBeenCalled()
      expect(terminalInstances[1].focus).toHaveBeenCalled()
    })

    terminalInstances[0].focus.mockClear()
    terminalInstances[1].focus.mockClear()

    act(() => {
      store.dispatch(setActiveTab('tab-2'))
    })

    await waitFor(() => {
      expect(terminalInstances[1].focus).toHaveBeenCalledTimes(1)
    })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('records turn completion and strips BEL from codex output', async () => {
    const tabId = 'tab-codex-bell'
    const paneId = 'pane-codex-bell'
    const terminalId = 'term-codex-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-bell',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
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
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-bell',
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
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
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
      type: 'terminal.output',
      terminalId,
      data: 'hello\x07world',
    })

    expect(terminalInstances[0].write).toHaveBeenCalledWith('helloworld')
    expect(store.getState().turnCompletion.lastEvent?.tabId).toBe(tabId)
    expect(store.getState().turnCompletion.lastEvent?.paneId).toBe(paneId)
    expect(store.getState().turnCompletion.lastEvent?.terminalId).toBe(terminalId)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(1)
  })

  it('preserves OSC title BEL terminators and does not record turn completion', async () => {
    const tabId = 'tab-codex-osc'
    const paneId = 'pane-codex-osc'
    const terminalId = 'term-codex-osc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-osc',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
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
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-osc',
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
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
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
      type: 'terminal.output',
      terminalId,
      data: '\x1b]0;New title\x07',
    })

    expect(terminalInstances[0].write).toHaveBeenCalledWith('\x1b]0;New title\x07')
    expect(store.getState().turnCompletion.lastEvent).toBeNull()
  })

  it('does not record turn completion for shell mode output', async () => {
    const tabId = 'tab-shell-bell'
    const paneId = 'pane-shell-bell'
    const terminalId = 'term-shell-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-shell-bell',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId,
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
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-shell-bell',
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
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      data: 'hello\x07world',
    })

    expect(terminalInstances[0].write).toHaveBeenCalledWith('hello\x07world')
    expect(store.getState().turnCompletion.lastEvent).toBeNull()
  })

  it('does not send terminal.attach after terminal.created (prevents snapshot races)', async () => {
    const tabId = 'tab-no-double-attach'
    const paneId = 'pane-no-double-attach'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-double-attach',
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
            createRequestId: paneContent.createRequestId,
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
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'terminal.created',
      requestId: paneContent.createRequestId,
      terminalId: 'term-no-double-attach',
      snapshot: '',
      createdAt: Date.now(),
    })

    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
    }))
    // We still need to size the PTY to the visible terminal.
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
      terminalId: 'term-no-double-attach',
    }))
  })

  it('does not send duplicate terminal.resize from attach (visibility effect handles it)', async () => {
    const tabId = 'tab-no-premature-resize'
    const paneId = 'pane-no-premature-resize'

    // Simulate a refresh scenario: pane already has a terminalId from localStorage.
    // The attach() function should NOT send its own terminal.resize. The only resize
    // should come from the visibility effect (which calls fit() first), preventing
    // a premature resize with xterm's default 80×24 that would cause TUI apps like
    // Codex to render at the wrong dimensions (text input at top of pane).
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-premature-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-existing',
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
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-existing',
            createRequestId: paneContent.createRequestId,
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

    // terminal.attach is sent from the attach function
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-existing',
    }))

    // terminal.resize should be sent exactly once (from the visibility effect, which
    // calls fit() before sending). The attach() function must NOT send a second resize.
    const resizeCalls = wsMocks.send.mock.calls.filter(
      ([msg]: [any]) => msg.type === 'terminal.resize'
    )
    expect(resizeCalls).toHaveLength(1)

    // The resize must come BEFORE the attach (visibility effect runs before WS effect)
    const allCalls = wsMocks.send.mock.calls.map(([msg]: [any]) => msg.type)
    const resizeIdx = allCalls.indexOf('terminal.resize')
    const attachIdx = allCalls.indexOf('terminal.attach')
    expect(resizeIdx).toBeLessThan(attachIdx)
  })

  it('does not send terminal.resize for hidden tabs on attach (defers to visibility effect)', async () => {
    const tabId = 'tab-hidden-resize'
    const paneId = 'pane-hidden-resize'

    // Hidden (background) tabs should not send any resize on attach.
    // The visibility effect skips hidden tabs, and attach() no longer sends resize.
    // The correct resize will be sent when the tab becomes visible.
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-hidden-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-hidden',
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
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-hidden',
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: 'some-other-tab',
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
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // terminal.attach is sent
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-hidden',
    }))

    // No terminal.resize should be sent: visibility effect skips hidden tabs,
    // and attach() no longer sends resize. Without this fix, attach() would
    // send 80×24 (xterm defaults), causing the Codex TUI to render at wrong
    // dimensions and persist until the tab becomes visible.
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
    }))
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
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-1',
            createRequestId: 'req-2',
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

  it('marks restored terminal.create requests', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore'
    const paneId = 'pane-restore'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
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
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-restore',
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
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThan(0)
      expect(createCalls[0][0].restore).toBe(true)
    })
  })

  it('retries terminal.create after RATE_LIMITED errors', async () => {
    vi.useFakeTimers()
    const tabId = 'tab-rate-limit'
    const paneId = 'pane-rate-limit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-rate-limit',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
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
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-rate-limit',
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

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(messageHandler).not.toBeNull()

    const createCallsBefore = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsBefore.length).toBeGreaterThan(0)

    messageHandler!({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many terminal.create requests',
      requestId: 'req-rate-limit',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('creating')

    await act(async () => {
      vi.advanceTimersByTime(250)
    })

    const createCallsAfter = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsAfter.length).toBe(createCallsBefore.length + 1)
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

    // Verify user-facing feedback was shown
    const term = terminalInstances[0]
    const writelnCalls = term.writeln.mock.calls.map(([s]: [string]) => s)
    expect(writelnCalls.some((s: string) => s.includes('Terminal exited'))).toBe(true)
  })

  it('mirrors resumeSessionId to tab on terminal.session.associated', async () => {
    const tabId = 'tab-session-assoc'
    const paneId = 'pane-session-assoc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-assoc',
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
            createRequestId: 'req-assoc',
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
      expect(messageHandler).not.toBeNull()
    })

    // Simulate terminal creation first to set terminalId
    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-assoc',
      terminalId: 'term-assoc',
      snapshot: '',
      createdAt: Date.now(),
    })

    // Simulate session association
    messageHandler!({
      type: 'terminal.session.associated',
      terminalId: 'term-assoc',
      sessionId: 'session-abc-123',
    })

    // Verify pane content has resumeSessionId + sessionRef
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.resumeSessionId).toBe('session-abc-123')
    expect(layout.content.sessionRef).toEqual({
      provider: 'claude',
      sessionId: 'session-abc-123',
      serverInstanceId: 'srv-local',
    })

    // Verify tab also has resumeSessionId mirrored
    const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
    expect(tab?.resumeSessionId).toBe('session-abc-123')
  })

  it('clears tab terminalId and sets status to creating on INVALID_TERMINAL_ID reconnect', async () => {
    const tabId = 'tab-clear-tid'
    const paneId = 'pane-clear-tid'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-clear',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-clear',
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
            terminalId: 'term-clear',
            createRequestId: 'req-clear',
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
      expect(messageHandler).not.toBeNull()
    })

    // Trigger INVALID_TERMINAL_ID for the current terminal
    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-clear',
    })

    // Wait for state update
    await waitFor(() => {
      const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
      expect(tab?.terminalId).toBeUndefined()
    })

    // Verify tab status was set to 'creating'
    const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
    expect(tab?.status).toBe('creating')

    // Verify pane content was also updated
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBeUndefined()
    expect(layout.content.status).toBe('creating')
  })

  describe('chunked attach lifecycle', () => {
    const ATTACH_CHUNK_TIMEOUT_MS = 35_000

    async function renderTerminalHarness(opts?: { status?: 'creating' | 'running'; terminalId?: string }) {
      const tabId = 'tab-chunked'
      const paneId = 'pane-chunked'
      const requestId = 'req-chunked'
      const initialStatus = opts?.status ?? 'running'
      const terminalId = opts?.terminalId

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: requestId,
        status: initialStatus,
        mode: 'shell',
        shell: 'system',
        ...(terminalId ? { terminalId } : {}),
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
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
              id: tabId,
              mode: 'shell',
              status: initialStatus,
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: requestId,
              ...(terminalId ? { terminalId } : {}),
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

      const view = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      await waitFor(() => {
        expect(terminalInstances.length).toBeGreaterThan(0)
      })

      wsMocks.send.mockClear()

      return {
        ...view,
        store,
        term: terminalInstances[terminalInstances.length - 1],
        tabId,
        paneId,
        requestId,
        terminalId: terminalId || 'term-chunked',
      }
    }

    it('buffers start/chunk frames and writes exactly once on terminal.attached.end', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-chunk-1' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 6, totalChunks: 2 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      expect(term.write).not.toHaveBeenCalled()

      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'def' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 6, totalChunks: 2 })

      expect(term.clear).toHaveBeenCalledTimes(1)
      expect(term.write).toHaveBeenCalledTimes(1)
      expect(term.write).toHaveBeenCalledWith('abcdef')
    })

    it('keeps attaching state pending after terminal.created with snapshotChunked until end arrives', async () => {
      const { term, requestId, queryByTestId } = await renderTerminalHarness({ status: 'creating' })

      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-chunk-created',
        snapshotChunked: true,
        createdAt: Date.now(),
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(queryByTestId('loader')).not.toBeNull()

      messageHandler!({ type: 'terminal.attached.start', terminalId: 'term-chunk-created', totalCodeUnits: 3, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId: 'term-chunk-created', chunk: 'ok!' })
      messageHandler!({ type: 'terminal.attached.end', terminalId: 'term-chunk-created', totalCodeUnits: 3, totalChunks: 1 })

      expect(term.write).toHaveBeenCalledWith('ok!')
    })

    it('drops snapshot when totalCodeUnits mismatches and triggers guarded auto-reattach', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-codeunits' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 5, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 5, totalChunks: 1 })

      expect(term.write).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.attach', terminalId })
    })

    it('drops snapshot when chunk count mismatches and triggers guarded auto-reattach', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-chunkcount' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 2 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 3, totalChunks: 2 })

      expect(term.write).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.attach', terminalId })
    })

    it('drops snapshot when start/end metadata mismatches and triggers guarded auto-reattach', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-meta-mismatch' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 4, totalChunks: 1 })

      expect(term.write).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.attach', terminalId })
    })

    it('ignores mismatched terminalId chunk frames and logs a warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-active' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId: 'term-other', chunk: 'xxx' })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 3, totalChunks: 1 })

      expect(term.write).toHaveBeenCalledWith('abc')
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('cancels in-flight chunk sequence on terminal.exit and ignores later end frame', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-exit-mid' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'abc' })
      messageHandler!({ type: 'terminal.exit', terminalId, exitCode: 0 })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 3, totalChunks: 1 })

      expect(term.write).not.toHaveBeenCalled()
    })

    it('replaces prior in-flight chunk state when a new start arrives for the same terminal', async () => {
      const { term, terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-restart' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 6, totalChunks: 2 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'old' })

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      messageHandler!({ type: 'terminal.attached.chunk', terminalId, chunk: 'new' })
      messageHandler!({ type: 'terminal.attached.end', terminalId, totalCodeUnits: 3, totalChunks: 1 })

      expect(term.write).toHaveBeenCalledTimes(1)
      expect(term.write).toHaveBeenCalledWith('new')
    })

    it('times out chunked attach and auto-reattaches at most once per terminal per generation', async () => {
      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-timeout-once' })
      vi.useFakeTimers()

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      await act(async () => {
        vi.advanceTimersByTime(ATTACH_CHUNK_TIMEOUT_MS + 1)
      })

      const firstAutoAttachCalls = wsMocks.send.mock.calls.filter((call) => call[0]?.type === 'terminal.attach' && call[0]?.terminalId === terminalId)
      expect(firstAutoAttachCalls).toHaveLength(1)

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      await act(async () => {
        vi.advanceTimersByTime(ATTACH_CHUNK_TIMEOUT_MS + 1)
      })

      const totalAutoAttachCalls = wsMocks.send.mock.calls.filter((call) => call[0]?.type === 'terminal.attach' && call[0]?.terminalId === terminalId)
      expect(totalAutoAttachCalls).toHaveLength(1)
    })

    it('resets auto-reattach guard after reconnect generation changes', async () => {
      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-timeout-generation' })
      vi.useFakeTimers()

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      await act(async () => {
        vi.advanceTimersByTime(ATTACH_CHUNK_TIMEOUT_MS + 1)
      })
      const beforeReconnect = wsMocks.send.mock.calls.filter((call) => call[0]?.type === 'terminal.attach' && call[0]?.terminalId === terminalId)
      expect(beforeReconnect).toHaveLength(1)

      reconnectHandler?.()
      wsMocks.send.mockClear()

      messageHandler!({ type: 'terminal.attached.start', terminalId, totalCodeUnits: 3, totalChunks: 1 })
      await act(async () => {
        vi.advanceTimersByTime(ATTACH_CHUNK_TIMEOUT_MS + 1)
      })
      const afterReconnect = wsMocks.send.mock.calls.filter((call) => call[0]?.type === 'terminal.attach' && call[0]?.terminalId === terminalId)
      expect(afterReconnect).toHaveLength(1)
    })
  })

  describe('xterm clear on terminal creation/attach', () => {
    function setupTerminal() {
      const tabId = 'tab-1'
      const paneId = 'pane-1'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-clear-1',
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
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'claude',
              status: 'running',
              title: 'Claude',
              titleSetByUser: false,
              createRequestId: 'req-clear-1',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: {
            settings: {
              ...defaultSettings,
              terminal: {
                ...defaultSettings.terminal,
                osc52Clipboard: 'never',
              },
            },
            status: 'loaded',
          },
          connection: { status: 'connected', error: null },
          turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
        },
      })
      return { tabId, paneId, paneContent, store }
    }

    it('clears xterm on terminal.created with empty snapshot', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
        })
      })

      // term.clear() should be called even with no snapshot
      expect(term.clear).toHaveBeenCalled()
      // term.write() should NOT be called (no snapshot to write)
      expect(term.write).not.toHaveBeenCalled()
    })

    it('clears xterm on terminal.created with non-empty snapshot', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()
      const osc52 = '\u001b]52;c;Y29weQ==\u0007'

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: `hello${osc52} world`,
        })
      })

      expect(term.clear).toHaveBeenCalled()
      expect(term.write).toHaveBeenCalledWith('hello world')
      expect(store.getState().turnCompletion.lastEvent).toBeNull()
    })

    it('sanitizes terminal.snapshot replay and does not emit turn completion', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()
      const osc52 = '\u001b]52;c;Y29weQ==\u0007'

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: '',
        })
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.snapshot',
          terminalId: 'term-1',
          snapshot: `snap${osc52}shot`,
        })
      })

      expect(term.clear).toHaveBeenCalled()
      expect(term.write).toHaveBeenCalledWith('snapshot')
      expect(store.getState().turnCompletion.lastEvent).toBeNull()
    })

    it('clears xterm on terminal.attached with empty snapshot', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // First, create the terminal so it has a terminalId
      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: '',
        })
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      // Then receive terminal.attached with empty snapshot
      act(() => {
        messageHandler!({
          type: 'terminal.attached',
          terminalId: 'term-1',
        })
      })

      // term.clear() should be called even with no snapshot
      expect(term.clear).toHaveBeenCalled()
      expect(term.write).not.toHaveBeenCalled()
    })

    it('clears xterm on terminal.attached with non-empty snapshot', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()
      const osc52 = '\u001b]52;c;Y29weQ==\u0007'

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      // Create terminal first
      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: '',
        })
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      // Receive terminal.attached with a snapshot
      act(() => {
        messageHandler!({
          type: 'terminal.attached',
          terminalId: 'term-1',
          snapshot: `attached ${osc52}content`,
        })
      })

      expect(term.clear).toHaveBeenCalled()
      expect(term.write).toHaveBeenCalledWith('attached content')
      expect(store.getState().turnCompletion.lastEvent).toBeNull()
    })
  })
})

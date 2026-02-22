import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { __resetTerminalCursorCacheForTests } from '@/lib/terminal-cursor'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'
import TerminalView from '@/components/TerminalView'

const wsHarness = vi.hoisted(() => {
  const handlers = new Set<(msg: any) => void>()
  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onReconnect: vi.fn(() => () => {}),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }),
    emit(msg: any) {
      for (const handler of handlers) {
        handler(msg)
      }
    },
    reset() {
      handlers.clear()
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

const terminalInstances: Array<{
  write: ReturnType<typeof vi.fn>
  writeln: ReturnType<typeof vi.fn>
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
    write = vi.fn((data: string, cb?: () => void) => {
      cb?.()
      return data.length
    })
    writeln = vi.fn()

    constructor() {
      terminalInstances.push(this as unknown as {
        write: ReturnType<typeof vi.fn>
        writeln: ReturnType<typeof vi.fn>
      })
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

function TerminalPaneFromStore({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden: boolean }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf') return null
    return layout.content
  })
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
}

function TerminalWorkspace({ showSettings }: { showSettings: boolean }) {
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  if (showSettings) {
    return <div data-testid="settings-view">Settings</div>
  }
  return (
    <>
      <TerminalPaneFromStore tabId="tab-1" paneId="pane-1" hidden={activeTabId !== 'tab-1'} />
      <TerminalPaneFromStore tabId="tab-2" paneId="pane-2" hidden={activeTabId !== 'tab-2'} />
    </>
  )
}

function createStore() {
  const pane1: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-active',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-active',
  }
  const pane2: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-hidden',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-hidden',
  }

  const layout1: PaneNode = { type: 'leaf', id: 'pane-1', content: pane1 }
  const layout2: PaneNode = { type: 'leaf', id: 'pane-2', content: pane2 }

  return configureStore({
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
            title: 'Active',
            createRequestId: 'req-active',
            terminalId: 'term-active',
          },
          {
            id: 'tab-2',
            mode: 'shell',
            status: 'running',
            title: 'Hidden',
            createRequestId: 'req-hidden',
            terminalId: 'term-hidden',
          },
        ],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {
          'tab-1': layout1,
          'tab-2': layout2,
        },
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'ready', error: null },
    },
  })
}

describe('settings remount scrollback hydration (e2e)', () => {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.connect.mockClear()
    terminalInstances.length = 0
    localStorage.clear()
    __resetTerminalCursorCacheForTests()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
    localStorage.clear()
    __resetTerminalCursorCacheForTests()
  })

  it('hydrates visible remounts, defers hidden remount hydration, and avoids replay-window gaps', async () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      'term-active': {
        seq: 5,
        updatedAt: Date.now(),
      },
      'term-hidden': {
        seq: 7,
        updatedAt: Date.now(),
      },
    }))
    __resetTerminalCursorCacheForTests()

    const store = createStore()
    const view = render(
      <Provider store={store}>
        <TerminalWorkspace showSettings={false} />
      </Provider>,
    )

    await waitFor(() => {
      const attachCalls = wsHarness.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach')
      expect(attachCalls.length).toBeGreaterThanOrEqual(2)
    })

    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-active', seqStart: 6, seqEnd: 6, data: 'active-before-settings' })
    wsHarness.emit({ type: 'terminal.output', terminalId: 'term-hidden', seqStart: 8, seqEnd: 8, data: 'hidden-before-settings' })

    view.rerender(
      <Provider store={store}>
        <TerminalWorkspace showSettings />
      </Provider>,
    )

    expect(screen.getByTestId('settings-view')).toBeInTheDocument()

    wsHarness.send.mockClear()
    view.rerender(
      <Provider store={store}>
        <TerminalWorkspace showSettings={false} />
      </Provider>,
    )

    await waitFor(() => {
      const remountAttachCalls = wsHarness.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach')
      const activeAttach = remountAttachCalls.find((msg) => msg.terminalId === 'term-active')
      const hiddenAttach = remountAttachCalls.find((msg) => msg.terminalId === 'term-hidden')
      expect(activeAttach?.sinceSeq).toBe(0)
      expect(hiddenAttach?.sinceSeq).toBeGreaterThan(0)
    })

    wsHarness.send.mockClear()
    act(() => {
      store.dispatch(setActiveTab('tab-2'))
    })

    await waitFor(() => {
      expect(wsHarness.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-hidden',
        sinceSeq: 0,
      }))
    })

    wsHarness.emit({
      type: 'terminal.attach.ready',
      terminalId: 'term-hidden',
      headSeq: 8,
      replayFromSeq: 1,
      replayToSeq: 8,
    })
    wsHarness.emit({
      type: 'terminal.output',
      terminalId: 'term-hidden',
      seqStart: 9,
      seqEnd: 9,
      data: 'hidden-replayed-after-settings',
    })

    const allWrites = terminalInstances.flatMap((instance) => instance.write.mock.calls.map(([data]) => data))
    expect(allWrites).toContain('hidden-replayed-after-settings')
    const allGapLines = terminalInstances.flatMap((instance) => instance.writeln.mock.calls.map(([data]) => String(data)))
    expect(allGapLines.some((line) => line.includes('reconnect window exceeded'))).toBe(false)
  })
})

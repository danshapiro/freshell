import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { useAppSelector } from '@/store/hooks'
import TabBar from '@/components/TabBar'
import TerminalView from '@/components/TerminalView'
import { useTurnCompletionNotifications } from '@/hooks/useTurnCompletionNotifications'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const playSound = vi.hoisted(() => vi.fn())

const wsMocks = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((callback: (msg: any) => void) => {
      messageHandlers.add(callback)
      return () => messageHandlers.delete(callback)
    }),
    onReconnect: vi.fn(() => () => {}),
    resetHandlers: () => messageHandlers.clear(),
    emitMessage: (msg: any) => {
      for (const callback of messageHandlers) callback(msg)
    },
  }
})

vi.mock('@/hooks/useNotificationSound', () => ({
  useNotificationSound: () => ({ play: playSound }),
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

const terminalInstances: any[] = []

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
    selectAll = vi.fn()
    reset = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function Harness() {
  useTurnCompletionNotifications()

  const tabs = useAppSelector((state) => state.tabs.tabs)
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const layouts = useAppSelector((state) => state.panes.layouts)

  return (
    <div>
      <TabBar />
      {tabs.map((tab) => {
        const layout = layouts[tab.id]
        if (!layout || layout.type !== 'leaf') return null
        if (layout.content.kind !== 'terminal') return null

        return (
          <TerminalView
            key={tab.id}
            tabId={tab.id}
            paneId={layout.id}
            paneContent={layout.content}
            hidden={tab.id !== activeTabId}
          />
        )
      })}
    </div>
  )
}

function createStore() {
  const foregroundTab: Tab = {
    id: 'tab-1',
    createRequestId: 'req-1',
    title: 'Foreground',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-1',
    createdAt: Date.now(),
  }

  const backgroundTab: Tab = {
    id: 'tab-2',
    createRequestId: 'req-2',
    title: 'Background',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-2',
    createdAt: Date.now(),
  }

  const pane1: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-1',
    initialCwd: '/tmp',
  }

  const pane2: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-2',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-2',
    initialCwd: '/tmp',
  }

  const layouts: Record<string, PaneNode> = {
    'tab-1': { type: 'leaf', id: 'pane-1', content: pane1 },
    'tab-2': { type: 'leaf', id: 'pane-2', content: pane2 },
  }

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
        tabs: [foregroundTab, backgroundTab],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts,
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'connected' as const,
        error: null,
      },
      turnCompletion: {
        seq: 0,
        lastEvent: null,
        pendingEvents: [],
        attentionByTab: {},
      },
    },
  })
}

describe('turn complete notification flow (e2e)', () => {
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  const originalHasFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus')
  let hasFocus = true
  let hidden = false

  beforeEach(() => {
    playSound.mockClear()
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockClear()
    wsMocks.resetHandlers()
    terminalInstances.length = 0

    hasFocus = true
    hidden = false

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    })

    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => hasFocus,
    })

    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()

    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
    }

    if (originalHasFocus) {
      Object.defineProperty(document, 'hasFocus', originalHasFocus)
    }
  })

  it('bells and highlights on background completion, attention persists until user input', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <Harness />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage).toHaveBeenCalled()
    })

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.output',
        terminalId: 'term-2',
        data: '\x07',
      })
    })

    await waitFor(() => {
      expect(playSound).toHaveBeenCalledTimes(1)
    })

    const backgroundTabBefore = screen.getByText('Background').closest('div[class*="group"]')
    expect(backgroundTabBefore?.className).toContain('bg-emerald-100')

    act(() => {
      hasFocus = false
      window.dispatchEvent(new Event('blur'))
    })

    fireEvent.click(screen.getByText('Background'))

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    // Attention persists after switching tab and regaining focus;
    // it's now cleared by TerminalView on user input, not by focus events
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)

    act(() => {
      hasFocus = true
      window.dispatchEvent(new Event('focus'))
    })

    // Attention still persists — no auto-clear on focus
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)

    // Active tab with attention uses inline styles (colored top border + bg)
    // instead of the bg-emerald-100 class used on inactive tabs
    const backgroundTabAfter = screen.getByText('Background').closest('div[class*="group"]')
    expect(backgroundTabAfter?.style.borderTopColor).toBe('rgb(5, 150, 105)')
  })
})

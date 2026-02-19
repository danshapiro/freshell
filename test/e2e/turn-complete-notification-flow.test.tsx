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
import type { Tab, AttentionDismiss } from '@/store/types'

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
    selectAll = vi.fn()
    reset = vi.fn()
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

function createStore(attentionDismiss: AttentionDismiss = 'click') {
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
        settings: {
          ...defaultSettings,
          panes: { ...defaultSettings.panes, attentionDismiss },
        },
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
        attentionByPane: {},
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

  it('bells and highlights on background completion, clears on tab click (default click mode)', async () => {
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

    // Switch to the background tab — in 'click' mode, attention clears on tab switch
    fireEvent.click(screen.getByText('Background'))

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
    })

    const backgroundTabAfter = screen.getByText('Background').closest('div[class*="group"]')
    expect(backgroundTabAfter?.className).not.toContain('bg-emerald-100')
  })

  it('click mode clears both tab and pane attention when switching to completed tab', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <Harness />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage).toHaveBeenCalled()
    })

    // Emit turn complete signal on background tab's terminal
    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.output',
        terminalId: 'term-2',
        data: '\x07',
      })
    })

    // Both tab and pane attention should be set
    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)

    // Switch to the background tab — click mode clears both tab AND pane attention
    fireEvent.click(screen.getByText('Background'))

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
    })
  })

  it('click mode: clicking the already-active tab clears attention', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <Harness />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage).toHaveBeenCalled()
    })

    // Switch to tab-2 first so it's active
    fireEvent.click(screen.getByText('Background'))
    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    // Emit turn complete signal on tab-2 (the now-active tab)
    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.output',
        terminalId: 'term-2',
        data: '\x07',
      })
    })

    // Tab-2 should have attention
    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })

    // Click tab-2 again (already active) — should clear attention
    fireEvent.click(screen.getByText('Background'))

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
  })

  it('type mode: attention persists after tab switch, clears on terminal input', async () => {
    const store = createStore('type')

    render(
      <Provider store={store}>
        <Harness />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage).toHaveBeenCalled()
    })

    // Emit turn complete signal on background tab's terminal
    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.output',
        terminalId: 'term-2',
        data: '\x07',
      })
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)

    // Switch to background tab — in 'type' mode, attention persists
    fireEvent.click(screen.getByText('Background'))

    await waitFor(() => {
      expect(store.getState().tabs.activeTabId).toBe('tab-2')
    })

    // Attention should still be set (type mode does NOT clear on tab switch)
    expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBe(true)

    // Simulate user typing in tab-2's terminal.
    // terminalInstances[0] = tab-1, terminalInstances[1] = tab-2
    // Each has onData registered by TerminalView during init.
    const tab2Terminal = terminalInstances[1]
    expect(tab2Terminal.onData).toHaveBeenCalled()
    const onDataCallback = tab2Terminal.onData.mock.calls[0][0] as (data: string) => void

    // Give React a render cycle so refs are synced with the latest attention state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    act(() => {
      onDataCallback('x')
    })

    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
    })
    expect(store.getState().turnCompletion.attentionByPane['pane-2']).toBeUndefined()
  })
})

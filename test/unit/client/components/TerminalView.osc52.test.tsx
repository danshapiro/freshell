import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(true),
  readText: vi.fn().mockResolvedValue(null),
}))

const apiMocks = vi.hoisted(() => ({
  patch: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: clipboardMocks.copyText,
  readText: clipboardMocks.readText,
}))

vi.mock('@/lib/api', () => ({
  api: {
    patch: apiMocks.patch,
  },
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
  }),
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
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView from '@/components/TerminalView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const OSC52_COPY = '\u001b]52;c;Y29weQ==\u0007'

function createStore(policy: 'ask' | 'always' | 'never') {
  const tabId = 'tab-osc52'
  const paneId = 'pane-osc52'
  const terminalId = 'term-osc52'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-osc52',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId,
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
          terminalId,
          createRequestId: 'req-osc52',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: {
        loaded: true,
        settings: {
          ...defaultSettings,
          terminal: {
            ...defaultSettings.terminal,
            osc52Clipboard: policy,
          },
        },
      },
      connection: { status: 'connected', error: null },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    } as any,
  })

  return { store, tabId, paneId, paneContent, terminalId }
}

describe('TerminalView OSC52 policy handling', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    terminalInstances.length = 0
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => { messageHandler = null }
    })
    clipboardMocks.copyText.mockClear()
    clipboardMocks.copyText.mockResolvedValue(true)
    apiMocks.patch.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    messageHandler = null
  })

  async function renderView(policy: 'ask' | 'always' | 'never') {
    const { store, tabId, paneId, paneContent, terminalId } = createStore(policy)
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    return { store, terminalId }
  }

  it('always policy copies silently without prompt', async () => {
    const { terminalId } = await renderView('always')
    messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })

    expect(terminalInstances[0].write).toHaveBeenCalledWith('beforeafter')
    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })

  it('never policy does not copy and does not prompt', async () => {
    const { terminalId } = await renderView('never')
    messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })

    expect(terminalInstances[0].write).toHaveBeenCalledWith('beforeafter')
    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })

  it('ask + Yes copies once and keeps ask policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Yes' })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('ask')
  })

  it('ask + No does not copy and keeps ask policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'No' })

    fireEvent.click(screen.getByRole('button', { name: 'No' }))

    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('ask')
  })

  it('ask + Always copies and persists always policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Always' })

    fireEvent.click(screen.getByRole('button', { name: 'Always' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('always')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/settings', {
      terminal: { osc52Clipboard: 'always' },
    })
  })

  it('ask + Never does not copy and persists never policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Never' })

    fireEvent.click(screen.getByRole('button', { name: 'Never' }))

    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('never')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/settings', {
      terminal: { osc52Clipboard: 'never' },
    })
  })

  it('swallows clipboard write rejection', async () => {
    clipboardMocks.copyText.mockRejectedValueOnce(new Error('clipboard blocked'))
    const { terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Yes' })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await act(async () => Promise.resolve())

    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })
})

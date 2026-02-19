import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import TerminalView from '@/components/TerminalView'
import type { TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(true),
}))

const apiMocks = vi.hoisted(() => ({
  patch: vi.fn().mockResolvedValue({}),
}))

let messageHandler: ((msg: any) => void) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: clipboardMocks.copyText,
  readText: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/api', () => ({
  api: {
    patch: apiMocks.patch,
  },
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
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

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const OSC52_COPY = '\u001b]52;c;Y29weQ==\u0007'

function createStore(policy: 'ask' | 'always' | 'never') {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-osc52',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-osc52',
    initialCwd: '/tmp',
  }

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
          id: 'tab-1',
          mode: 'codex' as const,
          status: 'running' as const,
          title: 'Codex',
          createRequestId: 'req-osc52',
          terminalId: 'term-osc52',
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf' as const,
            id: 'pane-1',
            content: paneContent,
          },
        },
        activePane: { 'tab-1': 'pane-1' },
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
      connection: { status: 'connected' as const, error: null },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    } as any,
  })

  return { store, paneContent }
}

describe('terminal OSC52 policy flow (e2e)', () => {
  beforeEach(() => {
    clipboardMocks.copyText.mockClear()
    apiMocks.patch.mockClear()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = callback
      return () => {
        if (messageHandler === callback) messageHandler = null
      }
    })
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    messageHandler = null
  })

  it('Ask policy prompts and Always updates global policy', async () => {
    const { store, paneContent } = createStore('ask')

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({ type: 'terminal.output', terminalId: 'term-osc52', data: `before${OSC52_COPY}after` })
    await screen.findByRole('button', { name: 'Always' })
    fireEvent.click(screen.getByRole('button', { name: 'Always' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('always')
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/settings', {
      terminal: { osc52Clipboard: 'always' },
    })
  })

  it('Never policy does not prompt and does not copy', async () => {
    const { store, paneContent } = createStore('never')

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({ type: 'terminal.output', terminalId: 'term-osc52', data: `before${OSC52_COPY}after` })
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('never')
  })
})

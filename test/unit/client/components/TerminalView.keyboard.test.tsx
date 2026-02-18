import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { getTerminalActions } from '@/lib/pane-action-registry'

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

// Capture the keyboard handler callback
let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let capturedOnData: ((data: string) => void) | null = null
let capturedTerminal: { paste: ReturnType<typeof vi.fn> } | null = null
let capturedLinkProvider: {
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
} | null = null

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    buffer = {
      active: {
        getLine: vi.fn(() => ({
          translateToString: () => '/tmp/example.txt',
        })),
      },
    }
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      capturedLinkProvider = provider
      return { dispose: vi.fn() }
    })
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn((cb: (data: string) => void) => {
      capturedOnData = cb
    })
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    selectAll = vi.fn()
    reset = vi.fn()
    paste = vi.fn((text: string) => {
      capturedOnData?.(text)
    })
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      capturedKeyHandler = handler
    })
    getSelection = vi.fn(() => 'selected text')
    focus = vi.fn()

    constructor() {
      capturedTerminal = this
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

// Mock clipboard
const clipboardMocks = vi.hoisted(() => ({
  readText: vi.fn().mockResolvedValue('pasted content'),
  copyText: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/clipboard', () => ({
  readText: clipboardMocks.readText,
  copyText: clipboardMocks.copyText,
}))

import TerminalView from '@/components/TerminalView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createTestStore(terminalId?: string) {
  const tabId = 'tab-1'
  const paneId = 'pane-1'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  return {
    store: configureStore({
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
            mode: 'shell' as const,
            status: 'running' as const,
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-1',
            terminalId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' as const },
        connection: { status: 'connected' as const, error: null },
      },
    }),
    tabId,
    paneId,
    paneContent,
  }
}

function createKeyboardEvent(key: string, modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}, type = 'keydown'): KeyboardEvent {
  const codeByKey: Record<string, string> = {
    v: 'KeyV',
    V: 'KeyV',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    Insert: 'Insert',
  }

  return {
    key,
    code: codeByKey[key] || `Key${key.toUpperCase()}`,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    type,
    repeat: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent
}

describe('TerminalView keyboard handling', () => {
  beforeEach(() => {
    capturedKeyHandler = null
    capturedOnData = null
    capturedTerminal = null
    capturedLinkProvider = null
    wsMocks.send.mockClear()
    clipboardMocks.readText.mockClear()
    clipboardMocks.copyText.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  describe('Ctrl+V paste', () => {
    it('Ctrl+V returns false and does not send input directly', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = createKeyboardEvent('v', { ctrlKey: true })
      const result = capturedKeyHandler!(event)
      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('Cmd+V (Meta+V) returns false and does not send input directly', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = createKeyboardEvent('v', { metaKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('Cmd+Alt+V returns false and does not send input directly', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = createKeyboardEvent('v', { metaKey: true, altKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('repeated Ctrl+V keydown stays blocked and does not send input directly', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = { ...createKeyboardEvent('v', { ctrlKey: true }), repeat: true } as KeyboardEvent
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('Shift+Insert returns false and does not send input directly', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = createKeyboardEvent('Insert', { shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('Shift+Insert by key stays blocked even when code differs', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const wsSendCountBefore = wsMocks.send.mock.calls.length
      const event = { ...createKeyboardEvent('Insert', { shiftKey: true }), code: 'Numpad0' } as KeyboardEvent
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledTimes(wsSendCountBefore)
    })

    it('does not paste on keyup events', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('v', { ctrlKey: true }, 'keyup')
      const result = capturedKeyHandler!(event)

      // Should return true to let xterm handle it (or do nothing)
      expect(result).toBe(true)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
    })

    it('does not paste without Ctrl modifier', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('v', {})
      const result = capturedKeyHandler!(event)

      // Should return true to let xterm handle normal 'v' key
      expect(result).toBe(true)
      expect(clipboardMocks.readText).not.toHaveBeenCalled()
    })
  })

  describe('Ctrl+Shift+C copy', () => {
    it('copies selection on Ctrl+Shift+C', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('C', { ctrlKey: true, shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      // The copy happens via navigator.clipboard.writeText in the handler
    })
  })

  describe('tab switching shortcuts', () => {
    it('returns false for Ctrl+Shift+[ to switch to previous tab', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('[', { ctrlKey: true, shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(event.preventDefault).toHaveBeenCalled()
    })

    it('returns false for Ctrl+Shift+] to switch to next tab', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent(']', { ctrlKey: true, shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(event.preventDefault).toHaveBeenCalled()
    })
  })

  describe('newline shortcut', () => {
    it('returns false for Shift+Enter and sends newline to terminal', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('Enter', { shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(wsMocks.send).toHaveBeenCalledWith({
        type: 'terminal.input',
        terminalId: 'term-1',
        data: '\n',
      })
    })

    it('returns false for Shift+Enter without terminal id and does not send input', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore(undefined)

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('Enter', { shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(wsMocks.send).not.toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'terminal.input',
          data: '\n',
        }),
      )
    })

    it('returns true for plain Enter so xterm handles it', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('Enter')
      const result = capturedKeyHandler!(event)

      expect(result).toBe(true)
    })
  })

  describe('search shortcut', () => {
    it('returns false for Ctrl+F to open terminal search', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('f', { ctrlKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)
      expect(event.preventDefault).toHaveBeenCalled()
    })
  })

  describe('terminal actions paste', () => {
    it('context-menu paste uses term.paste and emits exactly one terminal.input via onData', async () => {
      clipboardMocks.readText.mockResolvedValue('pasted content')
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedTerminal).not.toBeNull()
      })

      const actions = getTerminalActions(paneId)
      expect(actions).toBeDefined()

      const initialInputMessages = wsMocks.send.mock.calls.filter(
        ([msg]) => (msg as { type?: string }).type === 'terminal.input'
      ).length

      await actions!.paste()

      expect(capturedTerminal!.paste).toHaveBeenCalledWith('pasted content')

      const inputMessages = wsMocks.send.mock.calls.filter(
        ([msg]) => (msg as { type?: string }).type === 'terminal.input'
      )
      expect(inputMessages).toHaveLength(initialInputMessages + 1)
      expect(inputMessages.at(-1)?.[0]).toEqual({
        type: 'terminal.input',
        terminalId: 'term-1',
        data: 'pasted content',
      })
    })
  })

  describe('other keys', () => {
    it('returns true for unhandled keys to let xterm process them', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('a', {})
      const result = capturedKeyHandler!(event)

      expect(result).toBe(true)
    })
  })

  describe('local file path links', () => {
    it('opens an editor tab when a detected local file link is activated', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedLinkProvider).not.toBeNull()
      })

      let links: any[] | undefined
      capturedLinkProvider!.provideLinks(1, (provided) => {
        links = provided
      })

      expect(links).toBeDefined()
      expect(links).toHaveLength(1)
      expect(links![0].text).toBe('/tmp/example.txt')

      links![0].activate()

      const nextTab = store.getState().tabs.tabs[1]
      expect(nextTab).toBeDefined()
      const layout = store.getState().panes.layouts[nextTab.id]
      expect(layout).toBeDefined()
      expect(layout.type).toBe('leaf')
      if (layout.type === 'leaf') {
        expect(layout.content.kind).toBe('editor')
        if (layout.content.kind === 'editor') {
          expect(layout.content.filePath).toBe('/tmp/example.txt')
        }
      }
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

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
    selectAll = vi.fn()
    reset = vi.fn()
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      capturedKeyHandler = handler
    })
    getSelection = vi.fn(() => 'selected text')
  }

  return { Terminal: MockTerminal }
})

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('xterm/css/xterm.css', () => ({}))

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
  return {
    key,
    code: key === 'v' ? 'KeyV' : key === 'V' ? 'KeyV' : key === '[' ? 'BracketLeft' : key === ']' ? 'BracketRight' : `Key${key.toUpperCase()}`,
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
    it('handles Ctrl+V by reading clipboard and sending input', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('v', { ctrlKey: true })
      const result = capturedKeyHandler!(event)

      // Handler should return false to prevent xterm from processing the key
      expect(result).toBe(false)

      // Wait for async clipboard read
      await waitFor(() => {
        expect(clipboardMocks.readText).toHaveBeenCalled()
      })

      // Should send terminal input with pasted content
      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith({
          type: 'terminal.input',
          terminalId: 'term-1',
          data: 'pasted content',
        })
      })
    })

    it('handles Ctrl+Shift+V by reading clipboard and sending input', async () => {
      const { store, tabId, paneId, paneContent } = createTestStore('term-1')

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(capturedKeyHandler).not.toBeNull()
      })

      const event = createKeyboardEvent('V', { ctrlKey: true, shiftKey: true })
      const result = capturedKeyHandler!(event)

      expect(result).toBe(false)

      await waitFor(() => {
        expect(clipboardMocks.readText).toHaveBeenCalled()
      })

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith({
          type: 'terminal.input',
          terminalId: 'term-1',
          data: 'pasted content',
        })
      })
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
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import TerminalView from '@/components/TerminalView'
import type { TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

let keyHandler: ((event: KeyboardEvent) => boolean) | null = null
let onDataCb: ((data: string) => void) | null = null
let openedElement: HTMLElement | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    pasteListener: ((event: ClipboardEvent) => void) | null = null
    open = vi.fn((element: HTMLElement) => {
      openedElement = element
      this.pasteListener = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData('text/plain') || ''
        this.paste(text)
      }
      element.addEventListener('paste', this.pasteListener)
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    dispose = vi.fn(() => {
      if (openedElement && this.pasteListener) {
        openedElement.removeEventListener('paste', this.pasteListener)
      }
      this.pasteListener = null
    })
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    getSelection = vi.fn(() => '')
    selectAll = vi.fn()
    focus = vi.fn()
    onData = vi.fn((cb: (data: string) => void) => {
      onDataCb = cb
    })
    attachCustomKeyEventHandler = vi.fn((cb: (event: KeyboardEvent) => boolean) => {
      keyHandler = cb
    })
    paste = vi.fn((text: string) => {
      onDataCb?.(text)
    })
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

function createPasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (mimeType: string) => (mimeType === 'text/plain' ? text : ''),
    } as Pick<DataTransfer, 'getData'>,
  })
  return event
}

function createStore() {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-1',
    initialCwd: '/tmp',
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          mode: 'shell' as const,
          status: 'running' as const,
          title: 'Shell',
          titleSetByUser: false,
          createRequestId: 'req-1',
          terminalId: 'term-1',
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
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'connected' as const,
        lastError: undefined,
        platform: null,
        availableClis: {},
      },
    },
  })
}

describe('terminal paste single-ingress (e2e)', () => {
  beforeEach(() => {
    keyHandler = null
    onDataCb = null
    openedElement = null
    wsMocks.send.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('does not send on keydown paste shortcut; sends once on paste event', async () => {
    const store = createStore()
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: 'term-1',
      initialCwd: '/tmp',
    }

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(keyHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(onDataCb).not.toBeNull()
    })

    wsMocks.send.mockClear()

    const blocked = keyHandler!({
      key: 'v',
      code: 'KeyV',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      type: 'keydown',
      repeat: false,
    } as KeyboardEvent)

    expect(blocked).toBe(false)
    expect(wsMocks.send).not.toHaveBeenCalled()

    expect(openedElement).not.toBeNull()
    openedElement!.dispatchEvent(createPasteEvent('paste payload'))

    expect(wsMocks.send).toHaveBeenCalledTimes(1)
    expect(wsMocks.send).toHaveBeenCalledWith({
      type: 'terminal.input',
      terminalId: 'term-1',
      data: 'paste payload',
    })
  })

  it('does not send on Meta+Alt+V keydown; sends once on paste event', async () => {
    const store = createStore()
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: 'term-1',
      initialCwd: '/tmp',
    }

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(keyHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(onDataCb).not.toBeNull()
    })

    wsMocks.send.mockClear()

    const blocked = keyHandler!({
      key: 'v',
      code: 'KeyV',
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      altKey: true,
      type: 'keydown',
      repeat: false,
    } as KeyboardEvent)

    expect(blocked).toBe(false)
    expect(wsMocks.send).not.toHaveBeenCalled()

    expect(openedElement).not.toBeNull()
    openedElement!.dispatchEvent(createPasteEvent('meta-alt paste payload'))

    expect(wsMocks.send).toHaveBeenCalledTimes(1)
    expect(wsMocks.send).toHaveBeenCalledWith({
      type: 'terminal.input',
      terminalId: 'term-1',
      data: 'meta-alt paste payload',
    })
  })
})

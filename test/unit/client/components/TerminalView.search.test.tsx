import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const searchTerminalViewMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      patch: vi.fn().mockResolvedValue({}),
    },
    searchTerminalView: (...args: any[]) => searchTerminalViewMock(...args),
  }
})

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(true),
  readText: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
  }),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let capturedTerminal: { focus: ReturnType<typeof vi.fn> } | null = null
let capturedTerminalOptions: Record<string, unknown> | null = null

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
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      capturedKeyHandler = handler
    })
    getSelection = vi.fn(() => '')
    focus = vi.fn()

    constructor(options?: Record<string, unknown>) {
      capturedTerminal = this
      capturedTerminalOptions = options ?? null
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

function createTestStore() {
  const tabId = 'tab-1'
  const paneId = 'pane-1'
  const terminalId = 'term-1'

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
        terminalDirectory: terminalDirectoryReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
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
        settings: { settings: defaultSettings, status: 'loaded' },
        connection: { status: 'connected', error: null },
      },
    }),
    tabId,
    paneId,
    paneContent,
  }
}

function createKeyboardEvent(
  key: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    code: key === 'f' ? 'KeyF' : `Key${key.toUpperCase()}`,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    type: 'keydown',
    repeat: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('TerminalView search', () => {
  beforeEach(() => {
    capturedKeyHandler = null
    capturedTerminal = null
    capturedTerminalOptions = null
    searchTerminalViewMock.mockReset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens search on Ctrl+F, uses the server-owned search route, and cycles matches', async () => {
    searchTerminalViewMock.mockResolvedValue({
      matches: [
        { line: 1, column: 0, text: 'needle one' },
        { line: 5, column: 4, text: 'needle two' },
      ],
      nextCursor: null,
    })

    const { store, tabId, paneId, paneContent } = createTestStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull()
    })

    const openSearchEvent = createKeyboardEvent('f', { ctrlKey: true })
    const keyResult = capturedKeyHandler!(openSearchEvent)
    expect(keyResult).toBe(false)
    expect(openSearchEvent.preventDefault).toHaveBeenCalled()

    const input = await screen.findByRole('textbox', { name: 'Terminal search' })
    fireEvent.change(input, { target: { value: 'needle' } })

    await waitFor(() => {
      expect(searchTerminalViewMock).toHaveBeenCalledWith(
        'term-1',
        { query: 'needle' },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
    })

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(screen.getByText('2 of 2')).toBeInTheDocument()
    })

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    await waitFor(() => {
      expect(screen.getByText('1 of 2')).toBeInTheDocument()
    })

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Terminal search' })).not.toBeInTheDocument()
    })
    expect(store.getState().terminalDirectory.searches['term-1']).toBeUndefined()
    expect(capturedTerminal?.focus).toHaveBeenCalled()
  })

  it('aborts stale server-owned searches when the query changes', async () => {
    const first = createDeferred<{ matches: Array<{ line: number; column: number; text: string }>; nextCursor: null }>()
    const signals: AbortSignal[] = []

    searchTerminalViewMock
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return first.promise
      })
      .mockImplementationOnce((_terminalId: string, _query: { query: string }, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal)
        return Promise.resolve({
          matches: [{ line: 2, column: 1, text: 'needle two' }],
          nextCursor: null,
        })
      })

    const { store, tabId, paneId, paneContent } = createTestStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull()
    })

    capturedKeyHandler!(createKeyboardEvent('f', { ctrlKey: true }))
    const input = await screen.findByRole('textbox', { name: 'Terminal search' })

    fireEvent.change(input, { target: { value: 'need' } })
    await waitFor(() => {
      expect(searchTerminalViewMock).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(input, { target: { value: 'needle' } })
    await waitFor(() => {
      expect(searchTerminalViewMock).toHaveBeenCalledTimes(2)
    })

    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)

    first.resolve({ matches: [], nextCursor: null })

    await waitFor(() => {
      expect(screen.getByText('1 of 1')).toBeInTheDocument()
    })
  })

  it('displays "No results" when the server search returns no matches', async () => {
    searchTerminalViewMock.mockResolvedValue({
      matches: [],
      nextCursor: null,
    })

    const { store, tabId, paneId, paneContent } = createTestStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull()
    })

    capturedKeyHandler!(createKeyboardEvent('f', { ctrlKey: true }))
    const input = await screen.findByRole('textbox', { name: 'Terminal search' })
    fireEvent.change(input, { target: { value: 'nonexistent' } })

    await waitFor(() => {
      expect(screen.getByText('No results')).toBeInTheDocument()
    })
  })

  it('creates Terminal with allowProposedApi for decoration support', async () => {
    const { store, tabId, paneId, paneContent } = createTestStore()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(capturedTerminalOptions).not.toBeNull()
    })

    expect(capturedTerminalOptions).toEqual(
      expect.objectContaining({ allowProposedApi: true }),
    )
  })
})

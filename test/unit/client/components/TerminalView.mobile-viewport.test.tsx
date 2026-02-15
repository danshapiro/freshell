import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import type { TerminalPaneContent } from '@/store/paneTypes'

const mockSend = vi.fn()

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

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    getSelection: vi.fn(() => ''),
    focus: vi.fn(),
    cols: 80,
    rows: 24,
    options: {},
  })),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: vi.fn(() => ({
    send: mockSend,
    onMessage: vi.fn(() => vi.fn()),
    onReconnect: vi.fn(() => vi.fn()),
    connect: vi.fn(() => Promise.resolve()),
  })),
}))

import TerminalView from '@/components/TerminalView'

function createStore() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      sessionActivity: sessionActivityReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          mode: 'shell' as const,
          status: 'running' as const,
          title: 'Test',
          createRequestId: 'req-1',
        }],
        activeTabId: 'tab-1',
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' as const },
      connection: { status: 'connected' as const, error: null },
      sessionActivity: {},
    },
  })
}

function createTerminalContent(): TerminalPaneContent {
  return {
    kind: 'terminal',
    mode: 'shell',
    shell: 'system',
    createRequestId: 'req-1',
    status: 'running',
  }
}

type ViewportListener = () => void
type VisualViewportMock = {
  height: number
  offsetTop: number
  addEventListener: (event: 'resize' | 'scroll', listener: ViewportListener) => void
  removeEventListener: (event: 'resize' | 'scroll', listener: ViewportListener) => void
  dispatch: (event: 'resize' | 'scroll') => void
}

function createVisualViewportMock(height: number, offsetTop = 0): VisualViewportMock {
  const listeners = {
    resize: new Set<ViewportListener>(),
    scroll: new Set<ViewportListener>(),
  }

  return {
    height,
    offsetTop,
    addEventListener(event, listener) {
      listeners[event].add(listener)
    },
    removeEventListener(event, listener) {
      listeners[event].delete(listener)
    },
    dispatch(event) {
      for (const listener of listeners[event]) {
        listener()
      }
    },
  }
}

describe('TerminalView mobile viewport handling', () => {
  let originalVisualViewport: VisualViewport | undefined
  let originalInnerHeight: number
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).setMobileForTest(false)
    originalVisualViewport = window.visualViewport
    originalInnerHeight = window.innerHeight
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    ;(globalThis as any).setMobileForTest(false)
    Object.defineProperty(window, 'visualViewport', { value: originalVisualViewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true })
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
  })

  it('applies touch-action none and keyboard inset height on mobile', async () => {
    const viewport = createVisualViewportMock(780, 0)
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    ;(globalThis as any).setMobileForTest(true)

    const store = createStore()
    const { getByTestId } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={createTerminalContent()} hidden={false} />
      </Provider>
    )

    const terminalContainer = getByTestId('terminal-xterm-container')
    expect(terminalContainer.style.touchAction).toBe('none')
    expect(terminalContainer.style.height).toBe('calc(100% - 176px)')

    act(() => {
      viewport.height = 860 // Inset 40px: below activation threshold
      viewport.dispatch('resize')
    })

    await waitFor(() => {
      expect(terminalContainer.style.height).toBe('calc(100% - 56px)')
    })
  })

  it('does not apply mobile touch-action overrides on desktop', () => {
    const viewport = createVisualViewportMock(780, 0)
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    ;(globalThis as any).setMobileForTest(false)

    const store = createStore()
    const { getByTestId } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={createTerminalContent()} hidden={false} />
      </Provider>
    )

    const terminalContainer = getByTestId('terminal-xterm-container')
    expect(terminalContainer.style.touchAction || '').toBe('')
    expect(terminalContainer.style.height).toBe('')
  })

  it('renders mobile key toolbar, creates a new tab, and sends key input', async () => {
    const viewport = createVisualViewportMock(860, 0)
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    ;(globalThis as any).setMobileForTest(true)

    const store = createStore()
    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{ ...createTerminalContent(), terminalId: 'term-1' }}
          hidden={false}
        />
      </Provider>
    )

    expect(screen.getByTestId('mobile-terminal-toolbar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create new tab' }))
    await waitFor(() => {
      expect(store.getState().tabs.tabs).toHaveLength(2)
      expect(store.getState().tabs.activeTabId).not.toBe('tab-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Send |' }))

    await waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'term-1', data: '|' })
    })
  })
})

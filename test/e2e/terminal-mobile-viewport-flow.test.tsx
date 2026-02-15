import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import type { TerminalPaneContent } from '@/store/paneTypes'

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
    send: vi.fn(),
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

describe('terminal mobile viewport flow (e2e)', () => {
  let originalVisualViewport: VisualViewport | undefined
  let originalInnerHeight: number
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
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

  it('uses touch-action none and shrinks terminal when virtual keyboard appears', () => {
    const listeners = new Set<() => void>()
    const viewport = {
      height: 760,
      offsetTop: 0,
      addEventListener: (_event: 'resize' | 'scroll', listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: 'resize' | 'scroll', listener: () => void) => listeners.delete(listener),
    }

    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    ;(globalThis as any).setMobileForTest(true)

    const { getByTestId } = render(
      <Provider store={createStore()}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={createTerminalContent()} hidden={false} />
      </Provider>
    )

    const terminalContainer = getByTestId('terminal-xterm-container')
    expect(terminalContainer.style.touchAction).toBe('none')
    expect(terminalContainer.style.height).toBe('calc(100% - 140px)')

    act(() => {
      viewport.height = 870
      for (const listener of listeners) {
        listener()
      }
    })

    expect(terminalContainer.style.height).toBe('')
  })
})

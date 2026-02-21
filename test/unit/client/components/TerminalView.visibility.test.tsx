import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import type { TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  onMessage: vi.fn(() => vi.fn()),
  onReconnect: vi.fn(() => vi.fn()),
}))

const runtimeMocks = vi.hoisted(() => ({
  instances: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}))

// Mock ResizeObserver (not available in jsdom)
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock xterm.js and FitAddon
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    getSelection: vi.fn(),
    focus: vi.fn(),
    cols: 80,
    rows: 24,
    options: {},
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn(),
  })),
}))

// Mock ws-client
vi.mock('@/lib/ws-client', () => ({
  getWsClient: vi.fn(() => ({
    send: wsMocks.send,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    connect: wsMocks.connect,
  })),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => {
    const runtime = {
      attachAddons: vi.fn(),
      fit: vi.fn(),
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearDecorations: vi.fn(),
      onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
      webglActive: vi.fn(() => false),
    }
    runtimeMocks.instances.push(runtime)
    return runtime
  },
}))

// Must import after mocks
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

describe('TerminalView visibility CSS classes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.instances.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('applies tab-hidden class when hidden=true', () => {
    const store = createStore()
    const content = createTerminalContent()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} hidden={true} />
      </Provider>
    )

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('tab-hidden')
    expect(wrapper.classList.contains('hidden')).toBe(false)
  })

  it('applies tab-visible class when hidden=false', () => {
    const store = createStore()
    const content = createTerminalContent()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} hidden={false} />
      </Provider>
    )

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('tab-visible')
    expect(wrapper.className).not.toContain('tab-hidden')
  })

  it('applies tab-visible class when hidden is undefined', () => {
    const store = createStore()
    const content = createTerminalContent()

    const { container } = render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} />
      </Provider>
    )

    const wrapper = container.firstChild as HTMLElement
    expect(wrapper.className).toContain('tab-visible')
  })

  it('coalesces hidden->visible layout work into one fit/resize frame', () => {
    const pendingRaf: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      pendingRaf.push(cb)
      return pendingRaf.length
    })
    const cancelRafSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    try {
      const store = createStore()
      const content = { ...createTerminalContent(), terminalId: 'term-1' }
      const { rerender } = render(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} hidden={true} />
        </Provider>
      )

      while (pendingRaf.length > 0) {
        pendingRaf.shift()?.(16)
      }

      const runtime = runtimeMocks.instances[0]
      runtime.fit.mockClear()
      wsMocks.send.mockClear()

      rerender(
        <Provider store={store}>
          <TerminalView tabId="tab-1" paneId="pane-1" paneContent={content} hidden={false} />
        </Provider>
      )

      expect(pendingRaf.length).toBe(1)
      pendingRaf.shift()?.(32)

      expect(runtime.fit).toHaveBeenCalledTimes(1)
      const resizeMessages = wsMocks.send.mock.calls
        .map((call) => call[0] as { type?: string; terminalId?: string })
        .filter((msg) => msg.type === 'terminal.resize' && msg.terminalId === 'term-1')
      expect(resizeMessages).toHaveLength(1)
    } finally {
      rafSpy.mockRestore()
      cancelRafSpy.mockRestore()
    }
  })
})

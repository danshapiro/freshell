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
    send: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    onReconnect: vi.fn(() => vi.fn()),
    connect: vi.fn(() => Promise.resolve()),
  })),
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
})

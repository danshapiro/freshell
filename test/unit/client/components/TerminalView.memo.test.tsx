import { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
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

const renderCounters = vi.hoisted(() => ({
  mobileHookCalls: 0,
}))

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    attachCustomWheelEventHandler: vi.fn(),
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

vi.mock('@/hooks/useMobile', () => ({
  useMobile: () => {
    renderCounters.mobileHookCalls += 1
    return false
  },
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

function StableTerminalViewHarness({
  paneContent,
}: {
  paneContent: TerminalPaneContent
}) {
  const [count, setCount] = useState(0)

  return (
    <>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Parent rerender {count}
      </button>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={false} />
    </>
  )
}

function HiddenToggleTerminalViewHarness({
  paneContent,
}: {
  paneContent: TerminalPaneContent
}) {
  const [hidden, setHidden] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setHidden((value) => !value)}>
        Toggle hidden
      </button>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={hidden} />
    </>
  )
}

describe('TerminalView memo behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.instances.length = 0
    renderCounters.mobileHookCalls = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('does not rerender on an unrelated parent rerender when its props are identical', () => {
    const store = createStore()
    const paneContent = createTerminalContent()

    render(
      <Provider store={store}>
        <StableTerminalViewHarness paneContent={paneContent} />
      </Provider>,
    )

    const initialMobileHookCalls = renderCounters.mobileHookCalls
    expect(initialMobileHookCalls).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /parent rerender/i }))

    expect(renderCounters.mobileHookCalls).toBe(initialMobileHookCalls)
  })

  it('rerenders when a real prop change flips hidden', () => {
    const store = createStore()
    const paneContent = createTerminalContent()

    const { container } = render(
      <Provider store={store}>
        <HiddenToggleTerminalViewHarness paneContent={paneContent} />
      </Provider>,
    )

    const initialMobileHookCalls = renderCounters.mobileHookCalls
    expect(initialMobileHookCalls).toBeGreaterThan(0)
    expect((container.querySelector('.tab-visible') as HTMLElement | null)?.className).toContain('tab-visible')

    fireEvent.click(screen.getByRole('button', { name: /toggle hidden/i }))

    expect(renderCounters.mobileHookCalls).toBeGreaterThan(initialMobileHookCalls)
    expect((container.querySelector('.tab-hidden') as HTMLElement | null)?.className).toContain('tab-hidden')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
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

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ getAuthToken: vi.fn(() => undefined) }))
vi.mock('@/lib/terminal-themes', () => ({ getTerminalTheme: () => ({}) }))
vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))
vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: () => {},
    fit: vi.fn(),
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: () => false,
    emitContextLoss: () => {},
  }),
}))

const terminalInstances: Array<{ titleCb?: (t: string) => void }> = []

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
    titleCb?: (t: string) => void
    onTitleChange = vi.fn((cb: (t: string) => void) => {
      this.titleCb = cb
      return { dispose: vi.fn() }
    })
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
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

function createStore(mode: TerminalPaneContent['mode']) {
  const tabId = 'tab-1'
  const paneId = 'pane-1'
  const terminalId = 'term-1'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode,
    shell: mode === 'shell' ? 'system' : undefined,
    terminalId,
    initialCwd: '/home/dan/code/freshell',
  }
  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      extensions: extensionsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{ id: tabId, mode, status: 'running', title: 'freshell', terminalId, createRequestId: 'req-1' }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: { [tabId]: { [paneId]: 'freshell' } },
      },
      settings: { settings: { ...defaultSettings }, status: 'loaded' },
      connection: { status: 'ready', error: null },
      extensions: { entries: [] },
    },
  })
  return { store, tabId, paneId, paneContent, terminalId }
}

async function renderAndGetTitleCb(store: ReturnType<typeof createStore>['store'], paneContent: TerminalPaneContent, tabId: string, paneId: string) {
  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>,
  )
  await waitFor(() => {
    expect(terminalInstances.length).toBeGreaterThan(0)
    expect(terminalInstances[terminalInstances.length - 1].titleCb).toBeTypeOf('function')
  })
  return terminalInstances[terminalInstances.length - 1].titleCb!
}

describe('TerminalView OSC title scope', () => {
  beforeEach(() => {
    terminalInstances.length = 0
    resetEnsureExtensionsRegistryCacheForTests()
    wsMocks.send.mockClear()
    wsMocks.onMessage.mockImplementation(() => () => {})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })
  afterEach(() => {
    cleanup()
    resetEnsureExtensionsRegistryCacheForTests()
  })

  it('a shell terminal still follows OSC titles (program tracking)', async () => {
    const { store, paneContent, tabId, paneId } = createStore('shell')
    const fire = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('vim README.md'))

    expect(store.getState().tabs.tabs[0].title).toBe('vim README.md')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('vim README.md')
  })

  it('a coding-agent (claude) terminal ignores OSC titles (stays its working-dir name)', async () => {
    const { store, paneContent, tabId, paneId } = createStore('claude')
    const fire = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('Building project...'))

    expect(store.getState().tabs.tabs[0].title).toBe('freshell')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('freshell')
  })
})

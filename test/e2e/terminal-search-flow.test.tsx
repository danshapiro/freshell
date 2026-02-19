import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const runtimeMocks = vi.hoisted(() => ({
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  clearDecorations: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
}))

let keyHandler: ((event: KeyboardEvent) => boolean) | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: runtimeMocks.findNext,
    findPrevious: runtimeMocks.findPrevious,
    clearDecorations: runtimeMocks.clearDecorations,
    onDidChangeResults: runtimeMocks.onDidChangeResults,
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
  }),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn((cb: (event: KeyboardEvent) => boolean) => {
      keyHandler = cb
    })
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createStore() {
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-search',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-search',
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
          createRequestId: 'req-search',
          terminalId: 'term-search',
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
      settings: { settings: defaultSettings, loaded: true },
      connection: { status: 'connected' as const, error: null },
    },
  })
}

describe('terminal search flow (e2e)', () => {
  beforeEach(() => {
    keyHandler = null
    runtimeMocks.findNext.mockClear()
    runtimeMocks.findPrevious.mockClear()
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

  it('opens search on Ctrl+F and navigates next/previous matches', async () => {
    const store = createStore()
    const paneContent = (store.getState().panes.layouts['tab-1'] as any).content as TerminalPaneContent

    render(
      <Provider store={store}>
        <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(keyHandler).not.toBeNull()
    })

    const blocked = keyHandler!({
      key: 'f',
      code: 'KeyF',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      type: 'keydown',
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent)

    expect(blocked).toBe(false)
    const input = await screen.findByRole('textbox', { name: 'Terminal search' })

    fireEvent.change(input, { target: { value: 'needle' } })
    expect(runtimeMocks.findNext).toHaveBeenCalledWith('needle', expect.objectContaining({
      caseSensitive: false,
      incremental: true,
      decorations: expect.objectContaining({
        matchOverviewRuler: expect.any(String),
        activeMatchColorOverviewRuler: expect.any(String),
      }),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(runtimeMocks.findPrevious).toHaveBeenCalledWith('needle', expect.objectContaining({
      decorations: expect.objectContaining({
        matchOverviewRuler: expect.any(String),
        activeMatchColorOverviewRuler: expect.any(String),
      }),
    }))
  })
})

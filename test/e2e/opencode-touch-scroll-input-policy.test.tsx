import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientExtensionEntry } from '@shared/extension-types'
import TerminalView from '@/components/TerminalView'
import connectionReducer from '@/store/connectionSlice'
import extensionsReducer from '@/store/extensionsSlice'
import panesReducer from '@/store/panesSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

let latestTerminal: {
  scrollLines: ReturnType<typeof vi.fn>
  element: HTMLElement | null
} | null = null

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

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
    suspendWebgl: vi.fn(() => false),
    resumeWebgl: vi.fn(),
  }),
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    buffer = { active: { type: 'alternate' as const } }
    modes = {
      applicationCursorKeysMode: false,
      mouseTrackingMode: 'any' as const,
    }
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    selectAll = vi.fn()
    reset = vi.fn()
    scrollToBottom = vi.fn()
    scrollLines = vi.fn()
    element: HTMLElement | null = null

    constructor() {
      latestTerminal = this
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const opencodeExtensionWithBehaviorHint: ClientExtensionEntry = {
  name: 'opencode',
  version: '1.0.0',
  label: 'OpenCode',
  description: 'OpenCode CLI agent',
  category: 'cli',
  cli: {
    terminalBehavior: {
      preferredRenderer: 'canvas',
      scrollInputPolicy: 'native',
    },
  },
}

function createStore(mode: TerminalPaneContent['mode'], extensions: ClientExtensionEntry[] = []) {
  const tabId = `tab-${mode}`
  const paneId = `pane-${mode}`
  const terminalId = `term-${mode}`

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: `req-${mode}`,
    status: 'running',
    mode,
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
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
        tabs: [{
          id: tabId,
          mode,
          status: 'running',
          title: 'Terminal',
          titleSetByUser: false,
          createRequestId: paneContent.createRequestId,
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
      connection: {
        status: 'ready' as const,
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
      extensions: { entries: extensions },
    },
  })

  return { store, tabId, paneId, paneContent, terminalId }
}

describe('opencode touch scroll input policy (e2e)', () => {
  beforeEach(() => {
    latestTerminal = null
    wsMocks.send.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    ;(globalThis as any).setMobileForTest(true)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    ;(globalThis as any).setMobileForTest(false)
  })

  it('dispatches synthetic wheel events for opencode providers when policy is native', async () => {
    const { store, tabId, paneId, paneContent } = createStore('opencode', [opencodeExtensionWithBehaviorHint])

    const { getByTestId } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    const container = getByTestId('terminal-xterm-container')

    await waitFor(() => {
      expect(latestTerminal).not.toBeNull()
    })

    // Set up a mock element for dispatchEvent
    const mockEl = document.createElement('div')
    const dispatchSpy = vi.fn()
    mockEl.dispatchEvent = dispatchSpy
    if (latestTerminal) {
      latestTerminal.element = mockEl
    }

    wsMocks.send.mockClear()

    fireEvent.touchStart(container, {
      touches: [{ clientX: 20, clientY: 120 }],
    })
    fireEvent.touchMove(container, {
      touches: [{ clientX: 20, clientY: 100 }],
    })

    // Should dispatch synthetic wheel events to the terminal element
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const wheelEvent = dispatchSpy.mock.calls[0][0] as WheelEvent
    expect(wheelEvent).toBeInstanceOf(WheelEvent)
    expect(wheelEvent.deltaY).toBe(1)
    expect(wheelEvent.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE)
    expect(wheelEvent.clientX).toBe(20)
    expect(wheelEvent.clientY).toBe(100)
    // Should NOT send cursor key sequences
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.input',
    }))
    // Should NOT call scrollLines (alt buffer has no scrollback)
    expect(latestTerminal?.scrollLines).not.toHaveBeenCalled()
  })

  it('dispatches synthetic wheel events for shell providers in alt screen with mouse tracking', async () => {
    const { store, tabId, paneId, paneContent } = createStore('shell')

    const { getByTestId } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )

    const container = getByTestId('terminal-xterm-container')

    await waitFor(() => {
      expect(latestTerminal).not.toBeNull()
    })

    // Set up a mock element for dispatchEvent
    const mockEl = document.createElement('div')
    const dispatchSpy = vi.fn()
    mockEl.dispatchEvent = dispatchSpy
    if (latestTerminal) {
      latestTerminal.element = mockEl
    }

    wsMocks.send.mockClear()

    fireEvent.touchStart(container, {
      touches: [{ clientX: 20, clientY: 120 }],
    })
    fireEvent.touchMove(container, {
      touches: [{ clientX: 20, clientY: 100 }],
    })

    // Shell providers default to native policy, so they should dispatch wheel events
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const wheelEvent = dispatchSpy.mock.calls[0][0] as WheelEvent
    expect(wheelEvent).toBeInstanceOf(WheelEvent)
    expect(wheelEvent.deltaY).toBe(1)
    expect(wheelEvent.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE)
    expect(wheelEvent.clientX).toBe(20)
    expect(wheelEvent.clientY).toBe(100)
    // Should NOT send cursor key sequences
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.input',
    }))
    // Should NOT call scrollLines (alt buffer has no scrollback)
    expect(latestTerminal?.scrollLines).not.toHaveBeenCalled()
  })
})

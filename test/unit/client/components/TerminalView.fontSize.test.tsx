import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings, updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { TerminalPaneContent } from '@/store/paneTypes'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  extractLegacyLocalSettingsSeed,
  resolveLocalSettings,
} from '@shared/settings'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  onMessage: vi.fn(() => vi.fn()),
  onReconnect: vi.fn(() => vi.fn()),
}))

const runtimeMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    fit: ReturnType<typeof vi.fn>
  }>,
}))

const terminalMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>
    cols: number
    rows: number
    onData: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }>,
  constructorOptions: [] as Array<Record<string, unknown>>,
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

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation((options?: Record<string, unknown>) => {
    terminalMocks.constructorOptions.push({ ...(options ?? {}) })
    const term = {
      options: { ...(options ?? {}) },
      cols: 80,
      rows: 24,
      open: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      attachCustomWheelEventHandler: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn((_data: string, onWritten?: () => void) => { onWritten?.() }),
      writeln: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
      getSelection: vi.fn(() => ''),
      focus: vi.fn(),
    }
    terminalMocks.instances.push(term)
    return term
  }),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: vi.fn(() => ({
    send: wsMocks.send,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    connect: wsMocks.connect,
  })),
}))

import TerminalView, { __resetLastSentViewportCacheForTests } from '@/components/TerminalView'

function createStore(terminalFontSize = 16) {
  // Mirror the app boot path: the persisted browser-preferences blob is
  // normalized (clamped to 12-64, rounded) before the slice resolves the
  // working settings.
  const serverSettings = createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug })
  const localSettings = resolveLocalSettings(
    extractLegacyLocalSettingsSeed({ terminal: { fontSize: terminalFontSize } }),
  )
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
      settings: {
        serverSettings,
        localSettings,
        settings: composeResolvedSettings(serverSettings, localSettings),
        loaded: true,
        lastSavedAt: undefined,
      },
      connection: { status: 'connected' as const, error: null },
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
    terminalId: 'term-1',
  }
}

async function renderTerminal(store: ReturnType<typeof createStore>) {
  const view = render(
    <Provider store={store}>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={createTerminalContent()} hidden={false} />
    </Provider>
  )
  await waitFor(() => {
    expect(terminalMocks.instances.length).toBeGreaterThan(0)
  })
  return {
    ...view,
    term: terminalMocks.instances[terminalMocks.instances.length - 1],
    runtime: runtimeMocks.instances[runtimeMocks.instances.length - 1],
  }
}

function sentResizeMessages() {
  return wsMocks.send.mock.calls
    .map(([msg]) => msg as { type?: string; terminalId?: string; cols?: number; rows?: number })
    .filter((msg) => msg.type === 'terminal.resize' && msg.terminalId === 'term-1')
}

describe('TerminalView terminal font size (SYNC-02: 64px direct entry, live metrics)', () => {
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    runtimeMocks.instances.length = 0
    terminalMocks.instances.length = 0
    terminalMocks.constructorOptions.length = 0
    __resetLastSentViewportCacheForTests()
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
  })

  it('constructs the xterm instance at the persisted 64px on startup (no default-font flash)', async () => {
    // Reload path: 64px was persisted before the restart; the slice resolves
    // it at boot, and the new Terminal() must receive it directly.
    const store = createStore(64)

    const { term } = await renderTerminal(store)

    expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
    expect(terminalMocks.constructorOptions[0]).toMatchObject({ fontSize: 64 })
    expect(term.options.fontSize).toBe(64)
  })

  it('applies a live 64px change to the existing xterm and re-fits cell geometry', async () => {
    const store = createStore()
    const { term, runtime } = await renderTerminal(store)

    await waitFor(() => {
      expect(term.options.fontSize).toBe(16)
    })

    // A larger font enlarges xterm's cell box; fit() then lands on a smaller
    // grid. The mock stands in for that recalculation.
    runtime.fit.mockImplementation(() => {
      term.cols = 40
      term.rows = 12
    })
    runtime.fit.mockClear()
    wsMocks.send.mockClear()

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 64 } }))
    })

    await waitFor(() => {
      expect(term.options.fontSize).toBe(64)
    })
    expect(store.getState().settings.settings.terminal.fontSize).toBe(64)

    // Cell metrics recomputed live: exactly one fit and exactly one
    // terminal.resize with the new geometry reach the pty.
    expect(runtime.fit).toHaveBeenCalledTimes(1)
    expect(sentResizeMessages()).toEqual([{ type: 'terminal.resize', terminalId: 'term-1', cols: 40, rows: 12 }])

    // The xterm instance was updated in place, not recreated.
    expect(terminalMocks.instances).toHaveLength(1)
    expect(term.dispose).not.toHaveBeenCalled()
  })

  it('clamps out-of-range live font size changes before they reach xterm', async () => {
    const store = createStore()
    const { term } = await renderTerminal(store)

    await waitFor(() => {
      expect(term.options.fontSize).toBe(16)
    })

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 999 } }))
    })
    expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
    await waitFor(() => {
      expect(term.options.fontSize).toBe(64)
    })

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 8 } }))
    })
    expect(store.getState().settings.settings.terminal.fontSize).toBe(12)
    await waitFor(() => {
      expect(term.options.fontSize).toBe(12)
    })
  })

  it('keeps terminal user input flowing after a live 64px change', async () => {
    const store = createStore()
    const { term } = await renderTerminal(store)

    await waitFor(() => {
      expect(term.options.fontSize).toBe(16)
    })

    act(() => {
      store.dispatch(updateSettingsLocal({ terminal: { fontSize: 64 } }))
    })
    await waitFor(() => {
      expect(term.options.fontSize).toBe(64)
    })

    wsMocks.send.mockClear()
    const onDataHandler = term.onData.mock.calls.at(-1)?.[0] as ((data: string) => void) | undefined
    expect(onDataHandler).toBeTruthy()
    act(() => {
      onDataHandler!('x')
    })

    expect(wsMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal.input', terminalId: 'term-1', data: 'x' }),
    )
  })
})

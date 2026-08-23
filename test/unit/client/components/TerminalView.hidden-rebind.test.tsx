import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { updatePaneContent } from '@/store/panesSlice'
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

const hydrationMocks = vi.hoisted(() => {
  const registered: Array<{ tabId: string; paneId: string; trigger: () => void }> = []
  return {
    registered,
    queue: {
      register: vi.fn((entry: { tabId: string; paneId: string; trigger: () => void }, _options?: unknown) => {
        registered.push(entry)
      }),
      unregister: vi.fn(),
      onActiveTabReady: vi.fn(),
      onActiveTabChanged: vi.fn(),
      onHydrationComplete: vi.fn(),
    },
  }
})

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

vi.mock('@/lib/hydration-queue', () => ({
  getHydrationQueue: () => hydrationMocks.queue,
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
        // The layout MUST reference pane-1: #534's attach gate
        // (TerminalView attachTerminal -> collectAllTerminalIds) refuses to
        // attach any terminal the layouts don't reference. terminal.created
        // writes the terminalId into this leaf via updatePaneContent, which
        // is exactly what happens in production for hidden panes.
        layouts: {
          'tab-1': {
            type: 'leaf' as const,
            id: 'pane-1',
            content: {
              kind: 'terminal' as const,
              mode: 'shell' as const,
              shell: 'system' as const,
              status: 'creating' as const,
              createRequestId: 'req-1',
            },
          },
        },
        activePane: {},
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' as const },
      connection: { status: 'connected' as const, error: null },
      sessionActivity: {},
    },
  })
}

const baseTerminalContent: TerminalPaneContent = {
  kind: 'terminal',
  mode: 'shell',
  shell: 'system',
  createRequestId: 'req-1',
  status: 'running',
}

type RenderOptions = {
  paneContent: TerminalPaneContent
  hidden: boolean
}

function renderTerminalView(opts: RenderOptions) {
  const store = createStore()
  const ui = (o: RenderOptions) => (
    <Provider store={store}>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={o.paneContent} hidden={o.hidden} />
    </Provider>
  )
  const result = render(ui(opts))
  return {
    store,
    rerender: (o: RenderOptions) => result.rerender(ui(o)),
  }
}

function sentFrames(type: string) {
  return wsMocks.send.mock.calls
    .map(([frame]: [{ type?: string }]) => frame)
    .filter((frame: { type?: string }) => frame?.type === type)
}

function latestAttachRequestIdForTerminal(terminalId: string): string | undefined {
  const attach = [...wsMocks.send.mock.calls]
    .map(([msg]) => msg as { type?: string; terminalId?: string; attachRequestId?: string })
    .reverse()
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  return typeof attach?.attachRequestId === 'string' ? attach.attachRequestId : undefined
}

function deliverWsMessage(frame: Record<string, unknown>) {
  act(() => {
    for (const call of wsMocks.onMessage.mock.calls) {
      call[0](frame)
    }
  })
}

describe('TerminalView hidden-pane rebind (F8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.instances.length = 0
    hydrationMocks.registered.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('terminal.created while HIDDEN registers for background hydration and attaches when triggered', () => {
    // Pane starts in status 'creating' with no terminalId, hidden.
    renderTerminalView({
      paneContent: { ...baseTerminalContent, terminalId: undefined, status: 'creating', createRequestId: 'req-1' },
      hidden: true,
    })
    // The create is sent even while hidden (existing behavior).
    expect(sentFrames('terminal.create').length).toBeGreaterThanOrEqual(1)
    // Server acks the create. Mirror the terminal.created frame shape used in
    // TerminalView.lifecycle.test.tsx.
    deliverWsMessage({ type: 'terminal.created', requestId: 'req-1', terminalId: 'term-1', createdAt: Date.now() })
    // THE FIX: hidden pane must now be registered for background hydration
    // WITH queueIfStarted (the queue's only post-startup pump path), after
    // clearing this pane's stale slot.
    expect(hydrationMocks.queue.onHydrationComplete).toHaveBeenCalled()
    expect(hydrationMocks.queue.register).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: expect.any(Function) }),
      expect.objectContaining({ queueIfStarted: true }),
    )
    const entry = hydrationMocks.registered.at(-1)!
    // When the hydration queue grants the slot, a real attach frame goes out.
    act(() => { entry.trigger() })
    const attaches = sentFrames('terminal.attach')
    expect(attaches.length).toBeGreaterThanOrEqual(1)
    expect(attaches.at(-1)).toMatchObject({ terminalId: 'term-1' })
  })

  it('reveal after background rebind performs only surface hydration (no second attach when live)', () => {
    const { rerender } = renderTerminalView({
      paneContent: { ...baseTerminalContent, terminalId: undefined, status: 'creating', createRequestId: 'req-2' },
      hidden: true,
    })
    deliverWsMessage({ type: 'terminal.created', requestId: 'req-2', terminalId: 'term-2', createdAt: Date.now() })
    act(() => { hydrationMocks.registered.at(-1)!.trigger() })
    // Complete the attach so deferred mode becomes 'live'. Mirror the
    // terminal.attach.ready frame shape used in TerminalView.lifecycle.test.tsx
    // (its message-handler wrapper tags frames with the live attachRequestId
    // and a streamId).
    deliverWsMessage({
      type: 'terminal.attach.ready',
      terminalId: 'term-2',
      attachRequestId: latestAttachRequestIdForTerminal('term-2'),
      streamId: 'test-stream:term-2',
      headSeq: 0,
      replayFromSeq: 0,
      replayToSeq: 0,
    })
    const attachesBeforeReveal = sentFrames('terminal.attach').length
    rerender({
      paneContent: { ...baseTerminalContent, terminalId: 'term-2', status: 'running', createRequestId: 'req-2' },
      hidden: false,
    })
    // The reveal effect requires mode === 'waiting_for_geometry' to attach;
    // a live pane only gets a layout fit.
    expect(sentFrames('terminal.attach').length).toBe(attachesBeforeReveal)
  })

  it('reconnect while hidden re-registers with queueIfStarted (the pump cannot wait for reveal)', () => {
    const { store } = renderTerminalView({
      paneContent: { ...baseTerminalContent, terminalId: 'term-3', status: 'running', createRequestId: 'req-3' },
      hidden: true,
    })
    // Fold the live terminalId into the layout (mirrors the terminal.created
    // fold) so the #534 attach gate admits it.
    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: { ...baseTerminalContent, terminalId: 'term-3', status: 'running', createRequestId: 'req-3' },
      }))
    })
    // The mount-time background-hydration registration consumed the guard;
    // clear the mock log so the assertions below see only the reconnect's
    // actions.
    hydrationMocks.queue.register.mockClear()
    hydrationMocks.queue.onHydrationComplete.mockClear()

    const reconnect = wsMocks.onReconnect.mock.calls.at(-1)?.[0]
    expect(reconnect).toBeTypeOf('function')
    act(() => { reconnect() })

    // THE FIX: same three-step dance as the terminal.created hidden path --
    // release this pane's stale queue slot, then re-register with
    // queueIfStarted, since a hidden pane's reattach must not wait for reveal.
    expect(hydrationMocks.queue.onHydrationComplete).toHaveBeenCalledWith('pane-1')
    expect(hydrationMocks.queue.register).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'pane-1', trigger: expect.any(Function) }),
      expect.objectContaining({ queueIfStarted: true }),
    )

    // When the queue grants the slot, a full replay attach leaves the client
    // even though the pane is still hidden (no usable checkpoint here).
    wsMocks.send.mockClear()
    act(() => { hydrationMocks.registered.at(-1)!.trigger() })
    expect(sentFrames('terminal.attach').at(-1)).toMatchObject({
      terminalId: 'term-3',
      intent: 'keepalive_delta', // wire token for hidden viewport hydration
      sinceSeq: 0,
      priority: 'background',
    })
  })
})

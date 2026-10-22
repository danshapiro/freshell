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

/** A tab whose naming source is a Claude pane (session-owned), split with
 * the shell pane under test; or, with `owned: false`, the same split as a
 * legacy tab. */
function createSplitStore(opts: { owned: boolean }) {
  const tabId = 'tab-1'
  const paneId = 'pane-shell'
  const terminalId = 'term-shell'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-shell',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/home/dan/code/freshell',
  }
  const claudeContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-claude',
    status: 'running',
    mode: 'claude',
    terminalId: 'term-claude',
    sessionRef: { provider: 'claude', sessionId: 'sess-1' },
  }
  const root: PaneNode = {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      { type: 'leaf', id: 'pane-claude', content: claudeContent },
      { type: 'leaf', id: paneId, content: paneContent },
    ],
  }
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
          mode: 'claude',
          status: 'running',
          title: 'LotL',
          createRequestId: 'req-claude',
          nameSource: opts.owned ? { kind: 'session', paneId: 'pane-claude' } : { kind: 'legacy' },
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: { [tabId]: { [paneId]: 'Shell' } },
      },
      settings: { settings: { ...defaultSettings }, status: 'loaded' },
      connection: { status: 'ready', error: null },
      extensions: { entries: [] },
    } as any,
  })
  return { store, tabId, paneId, paneContent, terminalId }
}

async function renderAndGetTitleCb(store: ReturnType<typeof createStore>['store'], paneContent: TerminalPaneContent, tabId: string, paneId: string) {
  const view = render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>,
  )
  await waitFor(() => {
    expect(terminalInstances.length).toBeGreaterThan(0)
    expect(terminalInstances[terminalInstances.length - 1].titleCb).toBeTypeOf('function')
  })
  return { titleCb: terminalInstances[terminalInstances.length - 1].titleCb!, view }
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
    const { titleCb: fire } = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('vim README.md'))

    expect(store.getState().tabs.tabs[0].title).toBe('vim README.md')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('vim README.md')
  })

  it('a coding-agent (claude) terminal ignores OSC titles (stays its working-dir name)', async () => {
    const { store, paneContent, tabId, paneId } = createStore('claude')
    const { titleCb: fire } = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('Building project...'))

    expect(store.getState().tabs.tabs[0].title).toBe('freshell')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('freshell')
  })

  it('a shell terminal still folds terminal.title.updated frames into tab and pane titles', async () => {
    const { store, paneContent, tabId, paneId, terminalId } = createStore('shell')
    await renderAndGetTitleCb(store, paneContent, tabId, paneId)
    const onMessage = wsMocks.onMessage.mock.calls[wsMocks.onMessage.mock.calls.length - 1]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({ type: 'terminal.title.updated', terminalId, title: 'Registry title' })
    })

    expect(store.getState().tabs.tabs[0].title).toBe('Registry title')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Registry title')
  })

  it('a scoped coding-agent (claude) terminal ignores terminal.title.updated for pane and tab titles (Task 5)', async () => {
    const { store, paneContent, tabId, paneId, terminalId } = createStore('claude')
    await renderAndGetTitleCb(store, paneContent, tabId, paneId)
    const onMessage = wsMocks.onMessage.mock.calls[wsMocks.onMessage.mock.calls.length - 1]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({ type: 'terminal.title.updated', terminalId, title: 'Unrevisioned registry title' })
    })

    // Display comes from the canonical sessionNames cache; an unrevisioned
    // registry title never rewrites the pane, and it can never name a tab.
    expect(store.getState().tabs.tabs[0].title).toBe('freshell')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('freshell')
  })

  it('an OSC title from a shell pane inside a session-owned tab does not retitle the tab', async () => {
    const { store, paneContent, tabId, paneId } = createSplitStore({ owned: true })
    const { titleCb: fire } = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('vim README.md'))

    // The shell pane still tracks its program; the session-owned tab keeps
    // its saved-name mirror.
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('vim README.md')
    expect(store.getState().tabs.tabs[0].title).toBe('LotL')
  })

  it('an OSC title from a shell pane inside a legacy split tab still retitles the tab', async () => {
    const { store, paneContent, tabId, paneId } = createSplitStore({ owned: false })
    const { titleCb: fire } = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    act(() => fire('vim README.md'))

    expect(store.getState().tabs.tabs[0].title).toBe('vim README.md')
  })

  it('a registry title for a shell pane inside a session-owned tab does not retitle the tab', async () => {
    const { store, paneContent, tabId, paneId, terminalId } = createSplitStore({ owned: true })
    await renderAndGetTitleCb(store, paneContent, tabId, paneId)
    const onMessage = wsMocks.onMessage.mock.calls[wsMocks.onMessage.mock.calls.length - 1]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({ type: 'terminal.title.updated', terminalId, title: 'Registry title' })
    })

    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Registry title')
    expect(store.getState().tabs.tabs[0].title).toBe('LotL')
  })

  it('the exit suffix never touches a session-owned tab', async () => {
    const { store, paneContent, tabId, paneId, terminalId } = createSplitStore({ owned: true })
    await renderAndGetTitleCb(store, paneContent, tabId, paneId)
    const onMessage = wsMocks.onMessage.mock.calls[wsMocks.onMessage.mock.calls.length - 1]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({ type: 'terminal.attach.ready', terminalId, headSeq: 0, replayFromSeq: 1, replayToSeq: 0 })
    })
    act(() => {
      onMessage({ type: 'terminal.exit', terminalId, exitCode: 0 })
    })

    const tab = store.getState().tabs.tabs[0]
    expect(tab.status).toBe('exited')
    expect(tab.title).toBe('LotL')
  })

  it('the exit suffix still marks a legacy split tab', async () => {
    const { store, paneContent, tabId, paneId, terminalId } = createSplitStore({ owned: false })
    await renderAndGetTitleCb(store, paneContent, tabId, paneId)
    const onMessage = wsMocks.onMessage.mock.calls[wsMocks.onMessage.mock.calls.length - 1]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({ type: 'terminal.attach.ready', terminalId, headSeq: 0, replayFromSeq: 1, replayToSeq: 0 })
    })
    act(() => {
      onMessage({ type: 'terminal.exit', terminalId, exitCode: 0 })
    })

    const tab = store.getState().tabs.tabs[0]
    expect(tab.status).toBe('exited')
    expect(tab.title).toBe('LotL (exit 0)')
  })

  it('ignores a stale title callback after its terminal instance is disposed', async () => {
    const { store, paneContent, tabId, paneId } = createStore('shell')
    const { titleCb: staleFire, view } = await renderAndGetTitleCb(store, paneContent, tabId, paneId)

    view.unmount()

    const current = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(1)
      expect(terminalInstances[terminalInstances.length - 1].titleCb).toBeTypeOf('function')
    })
    const currentFire = terminalInstances[terminalInstances.length - 1].titleCb!

    act(() => staleFire('stale old title'))

    expect(store.getState().tabs.tabs[0].title).toBe('freshell')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('freshell')

    act(() => currentFire('current title'))

    expect(store.getState().tabs.tabs[0].title).toBe('current title')
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('current title')

    current.unmount()
  })
})

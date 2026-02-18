import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import TerminalView from '@/components/TerminalView'
import type { TerminalPaneContent } from '@/store/paneTypes'

let onDataCallback: ((data: string) => void) | null = null

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCallback = cb
      return { dispose: vi.fn() }
    }),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    cols: 80,
    rows: 24,
    options: {},
    getSelection: vi.fn(() => ''),
    focus: vi.fn(),
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}))

const mockSend = vi.fn()
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.stubGlobal('ResizeObserver', vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  disconnect: vi.fn(),
})))

describe('TerminalView - lastInputAt updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onDataCallback = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  const VALID_CLAUDE_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

  function createStore(opts?: { resumeSessionId?: string; provider?: 'claude' | 'codex' }) {
    const provider = opts?.provider || (opts?.resumeSessionId ? 'claude' : undefined)
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
            createRequestId: 'req-1',
            title: 'Test Tab',
            status: 'running' as const,
            mode: (provider || 'shell') as const,
            createdAt: Date.now(),
            terminalId: 'term-1',
            codingCliProvider: provider,
          }],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {},
        },
        settings: {
          settings: defaultSettings,
          loaded: true,
        },
        connection: {
          status: 'connected' as const,
        },
        sessionActivity: {
          sessions: {},
        },
      },
    })
  }

  it('dispatches updateTab with lastInputAt when user types', async () => {
    const store = createStore()
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      mode: 'shell',
      shell: 'system',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={paneContent}
        />
      </Provider>
    )

    expect(onDataCallback).not.toBeNull()
    const beforeInput = Date.now()
    onDataCallback!('hello')
    const afterInput = Date.now()

    const tab = store.getState().tabs.tabs[0]
    expect(tab.lastInputAt).toBeGreaterThanOrEqual(beforeInput)
    expect(tab.lastInputAt).toBeLessThanOrEqual(afterInput)
  })

  it('updates sessionActivity for Claude sessions with resumeSessionId', async () => {
    const store = createStore({ resumeSessionId: VALID_CLAUDE_SESSION_ID })
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      mode: 'claude',
      shell: 'system',
      status: 'running',
      resumeSessionId: VALID_CLAUDE_SESSION_ID,
    }

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={paneContent}
        />
      </Provider>
    )

    expect(onDataCallback).not.toBeNull()
    const beforeInput = Date.now()
    onDataCallback!('hello')
    const afterInput = Date.now()

    const sessionTime = store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]
    expect(sessionTime).toBeGreaterThanOrEqual(beforeInput)
    expect(sessionTime).toBeLessThanOrEqual(afterInput)
  })

  it('throttles sessionActivity updates to avoid per-keystroke dispatch', async () => {
    const store = createStore({ resumeSessionId: VALID_CLAUDE_SESSION_ID })
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      mode: 'claude',
      shell: 'system',
      status: 'running',
      resumeSessionId: VALID_CLAUDE_SESSION_ID,
    }

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={paneContent}
        />
      </Provider>
    )

    expect(onDataCallback).not.toBeNull()

    onDataCallback!('first')
    const firstTime = store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]

    vi.advanceTimersByTime(1000)
    onDataCallback!('second')
    const secondTime = store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]

    expect(secondTime).toBe(firstTime)

    vi.advanceTimersByTime(5000)
    onDataCallback!('third')
    const thirdTime = store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]

    expect(thirdTime).toBeGreaterThan(firstTime)
  })

  it('does not update sessionActivity for tabs without resumeSessionId', async () => {
    const store = createStore({ resumeSessionId: undefined })
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      mode: 'shell',
      shell: 'system',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <TerminalView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={paneContent}
        />
      </Provider>
    )

    expect(onDataCallback).not.toBeNull()
    onDataCallback!('hello')

    expect(store.getState().sessionActivity.sessions).toEqual({})
  })
})

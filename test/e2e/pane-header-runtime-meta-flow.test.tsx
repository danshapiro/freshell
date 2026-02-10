import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import App from '@/App'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import panesReducer from '@/store/panesSlice'
import idleWarningsReducer from '@/store/idleWarningsSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import terminalMetaReducer from '@/store/terminalMetaSlice'
import type { Tab } from '@/store/types'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((callback: (msg: any) => void) => {
      messageHandlers.add(callback)
      return () => messageHandlers.delete(callback)
    }),
    onReconnect: vi.fn(() => () => {}),
    setHelloExtensionProvider: vi.fn(),
    emitMessage: (msg: any) => {
      for (const callback of messageHandlers) callback(msg)
    },
    resetHandlers: () => messageHandlers.clear(),
  }
})

const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => apiGet(url),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: () => {},
}))

vi.mock('@/hooks/useTurnCompletionNotifications', () => ({
  useTurnCompletionNotifications: () => {},
}))

vi.mock('@/store/crossTabSync', () => ({
  installCrossTabSync: () => () => {},
}))

vi.mock('@/components/Sidebar', () => ({
  default: () => <div data-testid="mock-sidebar">Sidebar</div>,
  AppView: {} as any,
}))

vi.mock('@/components/HistoryView', () => ({
  default: () => <div data-testid="mock-history-view">History View</div>,
}))

vi.mock('@/components/SettingsView', () => ({
  default: () => <div data-testid="mock-settings-view">Settings View</div>,
}))

vi.mock('@/components/OverviewView', () => ({
  default: () => <div data-testid="mock-overview-view">Overview View</div>,
}))

vi.mock('@/components/AuthRequiredModal', () => ({
  AuthRequiredModal: () => null,
}))

vi.mock('@/components/TerminalView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`terminal-${paneId}`}>Terminal</div>,
}))

function createStore() {
  const codexTab: Tab = {
    id: 'tab-codex',
    createRequestId: 'req-codex',
    title: 'Codex Tab',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-codex',
    createdAt: Date.now(),
  }

  const claudeTab: Tab = {
    id: 'tab-claude',
    createRequestId: 'req-claude',
    title: 'Claude Tab',
    status: 'running',
    mode: 'claude',
    shell: 'system',
    terminalId: 'term-claude',
    createdAt: Date.now(),
  }

  const codexPane: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-codex',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId: 'term-codex',
    initialCwd: '/home/user/code/freshell',
  }

  const claudePane: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-claude',
    status: 'running',
    mode: 'claude',
    shell: 'system',
    terminalId: 'term-claude',
    initialCwd: '/home/user/code/freshell',
  }

  const layouts: Record<string, PaneNode> = {
    'tab-codex': { type: 'leaf', id: 'pane-codex', content: codexPane },
    'tab-claude': { type: 'leaf', id: 'pane-claude', content: claudePane },
  }

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      panes: panesReducer,
      idleWarnings: idleWarningsReducer,
      turnCompletion: turnCompletionReducer,
      terminalMeta: terminalMetaReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, collapsed: true },
        },
        loaded: true,
        lastSavedAt: null,
      },
      tabs: {
        tabs: [codexTab, claudeTab],
        activeTabId: 'tab-codex',
        renameRequestTabId: null,
      },
      panes: {
        layouts,
        activePane: {
          'tab-codex': 'pane-codex',
          'tab-claude': 'pane-claude',
        },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      terminalMeta: {
        byTerminalId: {},
      },
      idleWarnings: {
        warnings: {},
      },
    },
  })
}

describe('pane header runtime metadata flow (e2e)', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    wsMocks.resetHandlers()

    apiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') {
        return Promise.resolve({
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, collapsed: true },
        })
      }
      if (url === '/api/platform') {
        return Promise.resolve({
          platform: 'linux',
          availableClis: { codex: true, claude: true },
        })
      }
      if (url === '/api/sessions') {
        return Promise.resolve([])
      }
      return Promise.resolve({})
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders parity labels for codex/claude, updates compact percentage, and clears on terminal exit', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.connect).toHaveBeenCalled()
    })

    act(() => {
      wsMocks.emitMessage({ type: 'ready' })
    })

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'terminal.meta.list',
        })
      )
    })

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.meta.list.response',
        requestId: 'req-meta',
        terminals: [
          {
            terminalId: 'term-codex',
            provider: 'codex',
            displaySubdir: 'freshell',
            branch: 'main',
            isDirty: true,
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 5,
              cachedTokens: 0,
              totalTokens: 15,
              compactPercent: 25,
            },
            updatedAt: Date.now(),
          },
          {
            terminalId: 'term-claude',
            provider: 'claude',
            displaySubdir: 'freshell',
            branch: 'main',
            isDirty: true,
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 5,
              cachedTokens: 0,
              totalTokens: 15,
              compactPercent: 25,
            },
            updatedAt: Date.now(),
          },
        ],
      })
    })

    await waitFor(() => {
      expect(Object.keys(store.getState().terminalMeta.byTerminalId)).toHaveLength(2)
    })

    await waitFor(() => {
      expect(screen.getAllByText(/freshell \(main\*\)\s+25%/)).toHaveLength(2)
    })

    // Single-pane tabs still render title bars (and thus pane close buttons).
    expect(screen.getAllByTitle('Close pane')).toHaveLength(2)

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.meta.updated',
        upsert: [
          {
            terminalId: 'term-claude',
            provider: 'claude',
            displaySubdir: 'freshell',
            branch: 'main',
            isDirty: true,
            tokenUsage: {
              inputTokens: 11,
              outputTokens: 6,
              cachedTokens: 0,
              totalTokens: 17,
            },
            updatedAt: Date.now(),
          },
        ],
        remove: [],
      })
    })

    await waitFor(() => {
      expect(screen.getAllByText(/freshell \(main\*\)\s+25%/)).toHaveLength(1)
      expect(screen.getByText(/^freshell \(main\*\)$/)).toBeInTheDocument()
    })

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.exit',
        terminalId: 'term-claude',
        exitCode: 0,
      })
    })

    await waitFor(() => {
      expect(screen.getAllByText(/freshell \(main\*\)\s+25%/)).toHaveLength(1)
      expect(screen.queryByText(/^freshell \(main\*\)$/)).not.toBeInTheDocument()
    })
  })

  it('does not erase newer runtime metadata when an older snapshot response arrives', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <App />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.connect).toHaveBeenCalled()
    })

    act(() => {
      wsMocks.emitMessage({ type: 'ready' })
    })

    let requestId = ''
    await waitFor(() => {
      const metaCall = wsMocks.send.mock.calls
        .map((call) => call[0])
        .find((msg) => msg?.type === 'terminal.meta.list')
      expect(metaCall).toBeDefined()
      requestId = metaCall.requestId
    })

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.meta.updated',
        upsert: [
          {
            terminalId: 'term-codex',
            provider: 'codex',
            displaySubdir: 'freshell',
            branch: 'main',
            isDirty: true,
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 5,
              cachedTokens: 0,
              totalTokens: 15,
              compactPercent: 25,
            },
            updatedAt: Date.now(),
          },
        ],
        remove: [],
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
    })

    act(() => {
      wsMocks.emitMessage({
        type: 'terminal.meta.list.response',
        requestId,
        terminals: [],
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
    })
  })
})

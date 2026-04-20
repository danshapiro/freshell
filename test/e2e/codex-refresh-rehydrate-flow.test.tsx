import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import { persistMiddleware, resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import { parsePersistedLayoutRaw } from '@/store/persistedState'
import { LAYOUT_STORAGE_KEY } from '@/store/storage-keys'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import TerminalView from '@/components/TerminalView'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const reconnectHandlers = new Set<() => void>()
  const latestAttachRequestIdByTerminal = new Map<string, string>()
  const addedRestoreIds = new Set<string>()

  const withCurrentAttachRequestId = (msg: any) => {
    if (
      msg?.attachRequestId
      || typeof msg?.terminalId !== 'string'
      || (msg?.type !== 'terminal.attach.ready' && msg?.type !== 'terminal.output' && msg?.type !== 'terminal.output.gap')
    ) {
      return msg
    }
    const attachRequestId = latestAttachRequestIdByTerminal.get(msg.terminalId)
    return attachRequestId ? { ...msg, attachRequestId } : msg
  }

  return {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      messageHandlers.add(handler)
      return () => messageHandlers.delete(handler)
    }),
    onReconnect: vi.fn((handler: () => void) => {
      reconnectHandlers.add(handler)
      return () => reconnectHandlers.delete(handler)
    }),
    emit(msg: any) {
      const normalized = withCurrentAttachRequestId(msg)
      for (const handler of messageHandlers) handler(normalized)
    },
    rememberAttach(msg: any) {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg?.terminalId === 'string'
        && typeof msg?.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    },
    addRestoreRequestId(id: string) {
      addedRestoreIds.add(id)
    },
    consumeRestoreRequestId(id: string) {
      if (!addedRestoreIds.has(id)) return false
      addedRestoreIds.delete(id)
      return true
    },
    reset() {
      messageHandlers.clear()
      reconnectHandlers.clear()
      latestAttachRequestIdByTerminal.clear()
      addedRestoreIds.clear()
    },
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-restore', () => ({
  addTerminalRestoreRequestId: (id: string) => wsHarness.addRestoreRequestId(id),
  consumeTerminalRestoreRequestId: (id: string) => wsHarness.consumeRestoreRequestId(id),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
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
  }),
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    getSelection = vi.fn(() => '')
    clear = vi.fn()
    write = vi.fn((data: string, cb?: () => void) => {
      cb?.()
      return data.length
    })
    writeln = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createSettingsState() {
  const serverSettings = createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = resolveLocalSettings()

  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function createStore(preloadedState: {
  tabs: {
    tabs: Array<Record<string, unknown>>
    activeTabId: string | null
  }
  panes: {
    layouts: Record<string, unknown>
    activePane: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
    paneTitleSetByUser?: Record<string, Record<string, boolean>>
  }
}) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(persistMiddleware),
    preloadedState: {
      tabs: preloadedState.tabs,
      panes: {
        ...preloadedState.panes,
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
      },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
    },
  })
}

function TerminalViewFromStore({ tabId, paneId }: { tabId: string; paneId: string }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf') return null
    return layout.content
  })
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

function readPersistedLayoutSnapshotForTest() {
  const raw = globalThis.localStorage.getItem(LAYOUT_STORAGE_KEY)
  return raw ? parsePersistedLayoutRaw(raw) : null
}

function sentMessages() {
  return wsHarness.send.mock.calls.map(([msg]) => msg)
}

function getTerminalPaneContent(store: ReturnType<typeof createStore>, tabId: string): TerminalPaneContent | null {
  const layout = store.getState().panes.layouts[tabId] as PaneNode | undefined
  if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'terminal') return null
  return layout.content
}

describe('codex refresh rehydrate flow (e2e)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.send.mockImplementation((msg: any) => {
      wsHarness.rememberAttach(msg)
    })
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('restores the same Codex session after a refresh', async () => {
    const tabId = 'tab-codex-refresh'
    const paneId = 'pane-codex-refresh'
    const initialPaneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-refresh',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
    }

    const initialStore = createStore({
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'codex',
          status: 'creating',
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: 'req-codex-refresh',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: { type: 'leaf', id: paneId, content: initialPaneContent } },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
    })

    const firstRender = render(
      <Provider store={initialStore}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => msg?.type === 'terminal.create' && msg.requestId === 'req-codex-refresh')).toBe(true)
    })

    act(() => {
      wsHarness.emit({
        type: 'terminal.created',
        requestId: 'req-codex-refresh',
        terminalId: 'term-codex-refresh-old',
        createdAt: 1,
        effectiveResumeSessionId: 'thread-new-1',
      })
    })

    await waitFor(() => {
      const persisted = readPersistedLayoutSnapshotForTest()
      expect(persisted?.tabs.tabs.find((tab) => tab.id === tabId)?.resumeSessionId).toBe('thread-new-1')
      expect((persisted?.panes.layouts[tabId] as any)?.content?.resumeSessionId).toBe('thread-new-1')
    })

    const persisted = readPersistedLayoutSnapshotForTest()
    expect(persisted).toBeTruthy()

    firstRender.unmount()
    cleanup()
    wsHarness.reset()
    wsHarness.send.mockClear()
    wsHarness.send.mockImplementation((msg: any) => {
      wsHarness.rememberAttach(msg)
    })
    resetPersistedLayoutCacheForTests()

    const restoredStore = createStore({
      tabs: {
        tabs: persisted!.tabs.tabs,
        activeTabId: persisted!.tabs.activeTabId,
      },
      panes: {
        layouts: persisted!.panes.layouts,
        activePane: persisted!.panes.activePane,
        paneTitles: persisted!.panes.paneTitles,
        paneTitleSetByUser: persisted!.panes.paneTitleSetByUser,
      },
    })

    render(
      <Provider store={restoredStore}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>,
    )

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId: 'term-codex-refresh-old',
      })
    })

    await waitFor(() => {
      const recreated = sentMessages().find((msg) => (
        msg?.type === 'terminal.create'
        && msg?.requestId !== 'req-codex-refresh'
      ))
      expect(recreated).toMatchObject({
        type: 'terminal.create',
        mode: 'codex',
        resumeSessionId: 'thread-new-1',
        restore: true,
      })
    })
  })

  it('reattaches a same-server live Codex terminal before any durable identity exists', async () => {
    const tabId = 'tab-codex-live'
    const paneId = 'pane-codex-live'
    const store = createStore({
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'codex',
          status: 'running',
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: 'req-codex-live',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: {
          [tabId]: {
            type: 'leaf',
            id: paneId,
            content: {
              kind: 'terminal',
              createRequestId: 'req-codex-live',
              status: 'running',
              mode: 'codex',
              shell: 'system',
              terminalId: 'term-codex-live',
            },
          },
        },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => (
        msg?.type === 'terminal.attach'
        && msg?.terminalId === 'term-codex-live'
      ))).toBe(true)
    })

    expect(sentMessages().some((msg) => msg?.type === 'terminal.create')).toBe(false)
  })

  it('surfaces restore-unavailable instead of starting a fresh Codex session when a live-only terminal is gone', async () => {
    const tabId = 'tab-codex-live-only'
    const paneId = 'pane-codex-live-only'
    const store = createStore({
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'codex',
          status: 'running',
          title: 'Codex',
          titleSetByUser: false,
          createRequestId: 'req-codex-live-only',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: {
          [tabId]: {
            type: 'leaf',
            id: paneId,
            content: {
              kind: 'terminal',
              createRequestId: 'req-codex-live-only',
              status: 'running',
              mode: 'codex',
              shell: 'system',
              terminalId: 'term-codex-live-only',
            },
          },
        },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentMessages().some((msg) => (
        msg?.type === 'terminal.attach'
        && msg?.terminalId === 'term-codex-live-only'
      ))).toBe(true)
    })

    const baselineMessages = sentMessages().length

    act(() => {
      wsHarness.emit({
        type: 'error',
        code: 'INVALID_TERMINAL_ID',
        message: 'Unknown terminalId',
        terminalId: 'term-codex-live-only',
      })
    })

    await waitFor(() => {
      expect(sentMessages().slice(baselineMessages).some((msg) => msg?.type === 'terminal.create')).toBe(false)
      expect((getTerminalPaneContent(store, tabId) as any)?.restoreError).toEqual({
        code: 'RESTORE_UNAVAILABLE',
        reason: 'dead_live_handle',
      })
    })
  })
})

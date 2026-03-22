import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer, { setActiveTab } from '@/store/tabsSlice'
import panesReducer, { requestPaneRefresh, updatePaneContent } from '@/store/panesSlice'
import settingsReducer, { defaultSettings, updateSettingsLocal } from '@/store/settingsSlice'
import connectionReducer, { setServerInstanceId } from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import paneRuntimeTitleReducer, { setPaneRuntimeTitle } from '@/store/paneRuntimeTitleSlice'
import paneRuntimeActivityReducer from '@/store/paneRuntimeActivitySlice'
import { syncPaneTitleByTerminalId } from '@/store/paneTitleSync'
import { syncStableTitleByTerminalId } from '@/store/titleSync'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { getTabDisplayTitle } from '@/lib/tab-title'
import { __resetTerminalCursorCacheForTests } from '@/lib/terminal-cursor'
import { createPerfAuditBridge, installPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
}))

const restoreMocks = vi.hoisted(() => ({
  consumeTerminalRestoreRequestId: vi.fn(() => false),
  addTerminalRestoreRequestId: vi.fn(),
  hasTerminalRestoreRequestId: vi.fn(() => false),
}))

const runtimeMocks = vi.hoisted(() => ({
  instances: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: terminalThemeMocks.getTerminalTheme,
}))

vi.mock('@/lib/terminal-restore', () => ({
  consumeTerminalRestoreRequestId: restoreMocks.consumeTerminalRestoreRequestId,
  addTerminalRestoreRequestId: restoreMocks.addTerminalRestoreRequestId,
  hasTerminalRestoreRequestId: restoreMocks.hasTerminalRestoreRequestId,
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

const terminalInstances: any[] = []
const latestAttachRequestIdByTerminal = new Map<string, string>()

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() { terminalInstances.push(this) }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() {
      runtimeMocks.instances.push(this)
    }
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView, {
  __getLastSentViewportCacheSizeForTests,
  __resetLastSentViewportCacheForTests,
} from '@/components/TerminalView'

function TerminalViewFromStore({ tabId, paneId, hidden }: { tabId: string; paneId: string; hidden?: boolean }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf') return null
    return layout.content
  })
  if (!paneContent || paneContent.kind !== 'terminal') return null
  return <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
}

function TabLabelsFromStore() {
  const tabs = useAppSelector((state) => state.tabs.tabs)
  const layouts = useAppSelector((state) => state.panes.layouts)
  const paneTitles = useAppSelector((state) => state.panes.paneTitles)
  const paneTitleSources = useAppSelector((state) => state.panes.paneTitleSources)
  const paneRuntimeTitles = useAppSelector((state) => state.paneRuntimeTitle.titlesByPaneId)

  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.id} data-testid={`tab-label-${tab.id}`}>
          {getTabDisplayTitle(
            tab,
            layouts[tab.id],
            paneTitles[tab.id],
            paneTitleSources?.[tab.id],
            paneRuntimeTitles,
          )}
        </div>
      ))}
    </>
  )
}

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function ensureLocalStorageApiForTest() {
  const storage = globalThis.localStorage as Partial<Storage> | undefined
  if (
    storage &&
    typeof storage.getItem === 'function' &&
    typeof storage.setItem === 'function' &&
    typeof storage.removeItem === 'function' &&
    typeof storage.clear === 'function' &&
    typeof storage.key === 'function'
  ) {
    return
  }

  const backing = new Map<string, string>()
  const memoryStorage: Storage = {
    get length() {
      return backing.size
    },
    clear() {
      backing.clear()
    },
    getItem(key: string) {
      return backing.has(key) ? backing.get(key)! : null
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null
    },
    removeItem(key: string) {
      backing.delete(key)
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value))
    },
  }

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  })
}

function clearLocalStorageForTest() {
  ensureLocalStorageApiForTest()
  const storage = globalThis.localStorage as Storage | undefined
  if (!storage) return
  storage.clear()
}

function setLocalStorageItemForTest(key: string, value: string) {
  ensureLocalStorageApiForTest()
  const storage = globalThis.localStorage as Storage | undefined
  if (!storage) return
  storage.setItem(key, value)
}

function latestAttachRequestIdForTerminal(terminalId: string | undefined): string | undefined {
  if (!terminalId) return undefined
  const remembered = latestAttachRequestIdByTerminal.get(terminalId)
  if (remembered) return remembered
  const attach = [...wsMocks.send.mock.calls]
    .map(([msg]) => msg)
    .reverse()
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  return typeof attach?.attachRequestId === 'string' ? attach.attachRequestId : undefined
}

function createSettingsState(overrides: Record<string, unknown> = {}) {
  const serverSettings = (overrides.serverSettings as Record<string, unknown> | undefined) ?? createDefaultServerSettings({
    loggingDebug: defaultSettings.logging.debug,
  })
  const localSettings = (overrides.localSettings as Record<string, unknown> | undefined) ?? resolveLocalSettings()

  return {
    serverSettings,
    localSettings,
    settings: Object.prototype.hasOwnProperty.call(overrides, 'settings')
      ? overrides.settings
      : composeResolvedSettings(serverSettings as never, localSettings as never),
    loaded: true,
    lastSavedAt: undefined,
    ...overrides,
  }
}

function withCurrentAttachRequestId<T extends { type?: string; terminalId?: string; attachRequestId?: string }>(
  msg: T & { __preserveMissingAttachRequestId?: boolean },
): T {
  if (msg.__preserveMissingAttachRequestId) return msg
  if (msg.attachRequestId || typeof msg.terminalId !== 'string') return msg
  if (msg.type !== 'terminal.attach.ready' && msg.type !== 'terminal.output' && msg.type !== 'terminal.output.gap') {
    return msg
  }
  const attachRequestId = latestAttachRequestIdForTerminal(msg.terminalId)
  if (!attachRequestId) return msg
  return { ...msg, attachRequestId }
}

describe('TerminalView lifecycle updates', () => {
  let messageHandler: ((msg: any) => void) | null = null
  let reconnectHandler: (() => void) | null = null
  let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
  let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    latestAttachRequestIdByTerminal.clear()
    wsMocks.send.mockClear()
    wsMocks.send.mockImplementation((msg: any) => {
      if (
        msg?.type === 'terminal.attach'
        && typeof msg.terminalId === 'string'
        && typeof msg.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    })
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
    restoreMocks.consumeTerminalRestoreRequestId.mockReset()
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
    restoreMocks.hasTerminalRestoreRequestId.mockReset()
    restoreMocks.hasTerminalRestoreRequestId.mockReturnValue(false)
    terminalInstances.length = 0
    runtimeMocks.instances.length = 0
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = (msg: any) => callback(withCurrentAttachRequestId(msg))
      return () => { messageHandler = null }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        if (reconnectHandler === callback) reconnectHandler = null
      }
    })
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    installPerfAuditBridge(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearLocalStorageForTest()
    __resetTerminalCursorCacheForTests()
    delete window.__FRESHELL_TEST_HARNESS__
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
    reconnectHandler = null
    installPerfAuditBridge(null)
  })

  function setupThemeTerminal() {
    const tabId = 'tab-theme'
    const paneId = 'pane-theme'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-theme',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-theme',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    return { store, tabId, paneId, paneContent }
  }

  it('enables minimum contrast ratio when terminal theme is light', async () => {
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ isDark: false })
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(4.5)
    })
  })

  it('skips terminal create when the e2e harness suppresses terminal network effects for the pane', () => {
    window.__FRESHELL_TEST_HARNESS__ = {
      getState: vi.fn(),
      dispatch: vi.fn(),
      getWsReadyState: vi.fn(),
      waitForConnection: vi.fn(),
      forceDisconnect: vi.fn(),
      sendWsMessage: vi.fn(),
      setAgentChatNetworkEffectsSuppressed: vi.fn(),
      isAgentChatNetworkEffectsSuppressed: vi.fn(() => false),
      setTerminalNetworkEffectsSuppressed: vi.fn(),
      isTerminalNetworkEffectsSuppressed: vi.fn((paneId: string) => paneId === 'pane-theme'),
      getTerminalBuffer: vi.fn(),
      registerTerminalBuffer: vi.fn(),
      unregisterTerminalBuffer: vi.fn(),
      getPerfAuditSnapshot: vi.fn(),
    }

    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    const createCalls = wsMocks.send.mock.calls.filter(
      ([msg]) => msg?.type === 'terminal.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('skips terminal create when terminal network suppression is persisted in storage for the pane', () => {
    setLocalStorageItemForTest(
      'freshell.e2e.suppressedTerminalPaneIds',
      JSON.stringify(['pane-theme']),
    )

    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    const createCalls = wsMocks.send.mock.calls.filter(
      ([msg]) => msg?.type === 'terminal.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('marks terminal.first_output when the focused terminal renders output', async () => {
    const bridge = createPerfAuditBridge()
    installPerfAuditBridge(bridge)
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-theme',
        terminalId: 'term-1',
        createdAt: Date.now(),
      })
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId: 'term-1',
        attachRequestId: latestAttachRequestIdForTerminal('term-1'),
        seq: 0,
      })
      messageHandler!({
        type: 'terminal.output',
        terminalId: 'term-1',
        seqStart: 1,
        seqEnd: 1,
        data: 'hello from terminal',
      })
    })

    expect(bridge.snapshot().milestones['terminal.first_output']).toBeTypeOf('number')
  })

  it('keeps default contrast behavior when terminal theme is dark', async () => {
    terminalThemeMocks.getTerminalTheme.mockReturnValue({ isDark: true })
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(1)
    })
  })

  it('updates minimum contrast ratio when switching from dark to light theme at runtime', async () => {
    terminalThemeMocks.getTerminalTheme.mockImplementation((_, appTheme: unknown) => (
      appTheme === 'light' ? { isDark: false } : { isDark: true }
    ))
    const { store, tabId, paneId, paneContent } = setupThemeTerminal()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(1)
    })

    act(() => {
      store.dispatch(updateSettingsLocal({ theme: 'light' }))
    })

    await waitFor(() => {
      expect(terminalInstances[0]?.options.minimumContrastRatio).toBe(4.5)
    })
  })

  it('preserves terminalId across sequential status updates', async () => {
    const tabId = 'tab-1'
    const paneId = 'pane-1'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-1',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-1',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-1',
      terminalId: 'term-1',
      createdAt: Date.now(),
    })

    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId: 'term-1',
      headSeq: 0,
      replayFromSeq: 0,
      replayToSeq: 0,
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(layout.content.status).toBe('running')
  })

  it('focuses the remembered active pane terminal when tab becomes active', async () => {
    const paneA: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-a',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }
    const paneB: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-b',
      status: 'running',
      mode: 'shell',
      shell: 'system',
    }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              mode: 'shell',
              status: 'running',
              title: 'Tab 1',
              createRequestId: 'tab-1',
            },
            {
              id: 'tab-2',
              mode: 'shell',
              status: 'running',
              title: 'Tab 2',
              createRequestId: 'tab-2',
            },
          ],
          activeTabId: 'tab-1',
        },
        panes: {
          layouts: {},
          activePane: {
            'tab-2': 'pane-2b',
          },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    function Tab2TerminalViews() {
      const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
      const hidden = activeTabId !== 'tab-2'

      return (
        <>
          <TerminalView tabId="tab-2" paneId="pane-2a" paneContent={paneA} hidden={hidden} />
          <TerminalView tabId="tab-2" paneId="pane-2b" paneContent={paneB} hidden={hidden} />
        </>
      )
    }

    render(
      <Provider store={store}>
        <Tab2TerminalViews />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(2)
    })
    await waitFor(() => {
      expect(terminalInstances[0].focus).toHaveBeenCalled()
      expect(terminalInstances[1].focus).toHaveBeenCalled()
    })

    terminalInstances[0].focus.mockClear()
    terminalInstances[1].focus.mockClear()

    act(() => {
      store.dispatch(setActiveTab('tab-2'))
    })

    await waitFor(() => {
      expect(terminalInstances[1].focus).toHaveBeenCalledTimes(1)
    })
    expect(terminalInstances[0].focus).not.toHaveBeenCalled()
  })

  it('records turn completion and strips BEL from codex output', async () => {
    const tabId = 'tab-codex-bell'
    const paneId = 'pane-codex-bell'
    const terminalId = 'term-codex-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-bell',
      status: 'running',
      mode: 'codex',
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
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-bell',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'hello\x07world',
    })

    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === 'helloworld')).toBe(true)
    expect(store.getState().turnCompletion.lastEvent?.tabId).toBe(tabId)
    expect(store.getState().turnCompletion.lastEvent?.paneId).toBe(paneId)
    expect(store.getState().turnCompletion.lastEvent?.terminalId).toBe(terminalId)
    expect(store.getState().turnCompletion.pendingEvents).toHaveLength(1)
  })

  it('preserves OSC title BEL terminators and does not record turn completion', async () => {
    const tabId = 'tab-codex-osc'
    const paneId = 'pane-codex-osc'
    const terminalId = 'term-codex-osc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex-osc',
      status: 'running',
      mode: 'codex',
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
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-codex-osc',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: '\x1b]0;New title\x07',
    })

    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === '\x1b]0;New title\x07')).toBe(true)
    expect(store.getState().turnCompletion.lastEvent).toBeNull()
  })

  it('tracks claude terminal runtime activity from submit to output to turn completion', async () => {
    const tabId = 'tab-claude-activity'
    const paneId = 'pane-claude-activity'
    const terminalId = 'term-claude-activity'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-activity',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '11111111-1111-4111-8111-111111111111',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
            createRequestId: 'req-claude-activity',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'pending',
    })

    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Claude is working',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'working',
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('does not re-enter working state when claude output arrives after turn completion BEL', async () => {
    const tabId = 'tab-claude-post-bel'
    const paneId = 'pane-claude-post-bel'
    const terminalId = 'term-claude-post-bel'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-post-bel',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '22222222-2222-4222-8222-222222222222',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '22222222-2222-4222-8222-222222222222',
            createRequestId: 'req-claude-post-bel',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    // Step 1: User submits input -> pending
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'pending',
    })

    // Complete attach handshake
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // Step 2: Claude produces output -> working
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Claude is thinking...',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'working',
    })

    // Step 3: Turn completion BEL -> cleared
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Step 4: Post-BEL output (Claude's next prompt) -> should STAY cleared
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 3,
        seqEnd: 3,
        data: '\r\n> ',
      })
    })

    // THIS IS THE KEY ASSERTION: activity should still be cleared, not re-set to working
    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('allows working state again after user submits new input following a completed turn', async () => {
    const tabId = 'tab-claude-second-turn'
    const paneId = 'pane-claude-second-turn'
    const terminalId = 'term-claude-second-turn'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-second-turn',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '33333333-3333-4333-8333-333333333333',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '33333333-3333-4333-8333-333333333333',
            createRequestId: 'req-claude-second-turn',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    const onData = terminalInstances[0].onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(onData).toBeTypeOf('function')

    // First turn: submit -> working -> BEL clear
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'pending',
    })

    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'First response',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'working',
    })

    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: '\x07',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Post-BEL prompt -- guard should prevent re-triggering
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 3,
        seqEnd: 3,
        data: '\r\n> ',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()

    // Second turn: user submits new input -> guard resets
    act(() => {
      onData?.('\r')
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'pending',
    })

    // New output after second submit -> should set working again
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 4,
        seqEnd: 4,
        data: 'Second response',
      })
    })

    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
      source: 'terminal',
      phase: 'working',
    })
  })

  it('does not show working state for initial prompt output before any user input', async () => {
    const tabId = 'tab-claude-initial'
    const paneId = 'pane-claude-initial'
    const terminalId = 'term-claude-initial'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-claude-initial',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId,
      resumeSessionId: '44444444-4444-4444-8444-444444444444',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        turnCompletion: turnCompletionReducer,
        paneRuntimeActivity: paneRuntimeActivityReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId,
            resumeSessionId: '44444444-4444-4444-8444-444444444444',
            createRequestId: 'req-claude-initial',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
        paneRuntimeActivity: { byPaneId: {} },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })

    // Complete attach handshake (no user input yet)
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    // Initial prompt output before any user input
    act(() => {
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'Welcome to Claude\r\n> ',
      })
    })

    // Should NOT show as working -- no user input has been submitted yet
    expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
  })

  it('does not record turn completion for shell mode output', async () => {
    const tabId = 'tab-shell-bell'
    const paneId = 'pane-shell-bell'
    const terminalId = 'term-shell-bell'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-shell-bell',
      status: 'running',
      mode: 'shell',
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
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            terminalId,
            createRequestId: 'req-shell-bell',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    const initialAttach = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
    act(() => {
      messageHandler!({
        type: 'terminal.attach.ready',
        terminalId,
        headSeq: 0,
        replayFromSeq: 1,
        replayToSeq: 0,
        attachRequestId: initialAttach?.attachRequestId,
      })
    })

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'hello\x07world',
    })

    expect(terminalInstances[0].write.mock.calls.some((call) => call[0] === 'hello\x07world')).toBe(true)
    expect(store.getState().turnCompletion.lastEvent).toBeNull()
  })

  it('sends a viewport attach after terminal.created without issuing a second resize', async () => {
    const tabId = 'tab-no-double-attach'
    const paneId = 'pane-no-double-attach'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-double-attach',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'terminal.created',
      requestId: paneContent.createRequestId,
      terminalId: 'term-no-double-attach',
      createdAt: Date.now(),
    })

    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-no-double-attach',
      sinceSeq: 0,
      cols: expect.any(Number),
      rows: expect.any(Number),
    }))
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
      terminalId: 'term-no-double-attach',
    }))
  })

  it('does not send duplicate terminal.resize from attach (visibility effect handles it)', async () => {
    const tabId = 'tab-no-premature-resize'
    const paneId = 'pane-no-premature-resize'

    // Simulate a refresh scenario: pane already has a terminalId from localStorage.
    // The attach() function should NOT send its own terminal.resize. The only resize
    // should come from the visibility effect (which calls fit() first), preventing
    // a premature resize with xterm's default 80×24 that would cause TUI apps like
    // Codex to render at the wrong dimensions (text input at top of pane).
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-no-premature-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-existing',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-existing',
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // terminal.attach is sent from the attach function
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-existing',
      sinceSeq: 0,
      attachRequestId: expect.any(String),
    }))

    // terminal.resize should be sent before attach by layout effects. The attach() function
    // itself must not send an additional resize after attach is emitted.
    const resizeCalls = wsMocks.send.mock.calls.filter(
      ([msg]: [any]) => msg.type === 'terminal.resize'
    )
    expect(resizeCalls.length).toBeGreaterThan(0)

    // Every resize must occur before attach.
    const allCalls = wsMocks.send.mock.calls.map(([msg]: [any]) => msg.type)
    const attachIdx = allCalls.indexOf('terminal.attach')
    const resizeIndices = allCalls
      .map((type, idx) => ({ type, idx }))
      .filter((entry) => entry.type === 'terminal.resize')
      .map((entry) => entry.idx)
    expect(resizeIndices.every((idx) => idx < attachIdx)).toBe(true)
  })

  it('does not attach or resize hidden tabs until they become visible', async () => {
    const tabId = 'tab-hidden-resize'
    const paneId = 'pane-hidden-resize'

    // Hidden (background) tabs should not send any resize on attach.
    // The visibility effect skips hidden tabs, and attach() no longer sends resize.
    // The correct resize will be sent when the tab becomes visible.
    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-hidden-resize',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-hidden',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-hidden',
            createRequestId: paneContent.createRequestId,
          }],
          activeTabId: 'some-other-tab',
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-hidden',
    }))
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
    }))
  })

  it('keeps a hidden single-pane durable title after a later runtime title update', async () => {
    const visibleTabId = 'tab-visible'
    const durableTabId = 'tab-durable'
    const durablePaneId = 'pane-durable'
    const terminalId = 'term-durable'
    const durableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'

    const visiblePaneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-visible',
      status: 'running',
      mode: 'shell',
      shell: 'system',
      terminalId: 'term-visible',
      initialCwd: '/tmp',
    }

    const durablePaneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-durable',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId,
      initialCwd: '/tmp',
    }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: visibleTabId,
              mode: 'shell',
              status: 'running',
              title: 'Shell',
              titleSetByUser: false,
              terminalId: 'term-visible',
              createRequestId: 'req-visible',
            },
            {
              id: durableTabId,
              mode: 'codex',
              status: 'running',
              title: 'Codex',
              titleSetByUser: false,
              terminalId,
              createRequestId: 'req-durable',
            },
          ],
          activeTabId: visibleTabId,
        },
        panes: {
          layouts: {
            [visibleTabId]: { type: 'leaf', id: 'pane-visible', content: visiblePaneContent },
            [durableTabId]: { type: 'leaf', id: durablePaneId, content: durablePaneContent },
          },
          activePane: {
            [visibleTabId]: 'pane-visible',
            [durableTabId]: durablePaneId,
          },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
      },
    })

    function DurableTerminalUnderTest() {
      const hidden = useAppSelector((state) => state.tabs.activeTabId !== durableTabId)
      return <TerminalView tabId={durableTabId} paneId={durablePaneId} paneContent={durablePaneContent} hidden={hidden} />
    }

    render(
      <Provider store={store}>
        <>
          <TabLabelsFromStore />
          <DurableTerminalUnderTest />
        </>
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances).toHaveLength(1)
      expect(terminalInstances[0].onTitleChange).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      await store.dispatch(syncPaneTitleByTerminalId({ terminalId, title: durableTitle }))
    })

    await waitFor(() => {
      expect(document.querySelector(`[data-testid="tab-label-${durableTabId}"]`)?.textContent).toBe(durableTitle)
    })

    const titleListener = terminalInstances[0].onTitleChange.mock.calls[0]?.[0]
    expect(titleListener).toBeTypeOf('function')

    act(() => {
      titleListener('codex')
    })

    await waitFor(() => {
      expect(document.querySelector(`[data-testid="tab-label-${durableTabId}"]`)?.textContent).toBe(durableTitle)
    })

    act(() => {
      store.dispatch(setActiveTab(durableTabId))
    })

    await waitFor(() => {
      expect(document.querySelector(`[data-testid="tab-label-${durableTabId}"]`)?.textContent).toBe(durableTitle)
    })
  })

  it('ignores INVALID_TERMINAL_ID errors for other terminals', async () => {
    const tabId = 'tab-2'
    const paneId = 'pane-2'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-2',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-1',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-1',
            createRequestId: 'req-2',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-2',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBe('term-1')
    expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
    }))
  })

  it('recreates terminal once after INVALID_TERMINAL_ID for the current terminal', async () => {
    const tabId = 'tab-3'
    const paneId = 'pane-3'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-3',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-3',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-3',
            createRequestId: 'req-3',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()
    const onMessageCallsBefore = wsMocks.onMessage.mock.calls.length

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-3',
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.createRequestId).not.toBe('req-3')
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    const newPaneContent = layout.content as TerminalPaneContent
    const newRequestId = newPaneContent.createRequestId

    rerender(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={newPaneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.onMessage.mock.calls.length).toBeGreaterThan(onMessageCallsBefore)
    })

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThanOrEqual(1)
    })

    const createCalls = wsMocks.send.mock.calls.filter(([msg]) =>
      msg?.type === 'terminal.create' && msg.requestId === newRequestId
    )
    expect(createCalls).toHaveLength(1)
  })

  it('marks restored terminal.create requests', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore'
    const paneId = 'pane-restore'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-restore',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls.length).toBeGreaterThan(0)
      expect(createCalls[0][0].restore).toBe(true)
    })
  })

  it('waits for the local server instance id before restoring an exact coding session', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore-codex'
    const paneId = 'pane-restore-codex'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-codex',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      resumeSessionId: 'codex-session-123',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-123',
        serverInstanceId: 'srv-local',
      },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-restore-codex',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: undefined },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')).toHaveLength(0)

    act(() => {
      store.dispatch(setServerInstanceId('srv-local'))
    })

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: 'req-restore-codex',
        resumeSessionId: 'codex-session-123',
        restore: true,
      }))
    })
  })

  it('blocks restore when a coding pane cannot prove exact local identity', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore-foreign'
    const paneId = 'pane-restore-foreign'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-foreign',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      resumeSessionId: 'codex-session-123',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-123',
        serverInstanceId: 'srv-remote',
      },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-restore-foreign',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls).toHaveLength(0)
      expect(terminalInstances[0].writeln).toHaveBeenCalledWith(
        expect.stringContaining('[Restore blocked: exact session identity missing]'),
      )
    })
  })

  it('waits for local identity before attaching a restored coding pane with a persisted terminalId, then blocks foreign ownership', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    restoreMocks.hasTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore-foreign-attach'
    const paneId = 'pane-restore-foreign-attach'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-foreign-attach',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-restore-foreign-attach',
      resumeSessionId: 'codex-session-foreign',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-foreign',
        serverInstanceId: 'srv-remote',
      },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-restore-foreign-attach',
            terminalId: 'term-restore-foreign-attach',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: undefined },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(terminalInstances.length).toBeGreaterThan(0)
    })
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.attach')).toHaveLength(0)
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')).toHaveLength(0)

    act(() => {
      store.dispatch(setServerInstanceId('srv-local'))
    })

    await waitFor(() => {
      const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
      expect(sent.filter((msg) => msg?.type === 'terminal.attach')).toHaveLength(0)
      expect(sent.filter((msg) => msg?.type === 'terminal.create')).toHaveLength(0)
      expect(terminalInstances[0].writeln).toHaveBeenCalledWith(
        expect.stringContaining('[Restore blocked: exact session identity missing]'),
      )
    })
  })

  it('preserves same-server live terminal attach for restored coding panes that only have terminalId authority', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore-live-attach'
    const paneId = 'pane-restore-live-attach'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-live-attach',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-restore-live-attach',
      resumeSessionId: 'codex-session-live',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-restore-live-attach',
            terminalId: 'term-restore-live-attach',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-restore-live-attach',
        attachRequestId: expect.any(String),
      }))
    })
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')).toHaveLength(0)
  })

  it('clears stale foreign exact identity after a fresh local create', async () => {
    const tabId = 'tab-open-foreign-copy'
    const paneId = 'pane-open-foreign-copy'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-open-foreign-copy',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      resumeSessionId: 'codex-session-123',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-session-123',
        serverInstanceId: 'srv-remote',
      },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-open-foreign-copy',
            resumeSessionId: 'codex-session-123',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: 'req-open-foreign-copy',
        resumeSessionId: undefined,
      }))
    })

    expect(messageHandler).not.toBeNull()
    act(() => {
      messageHandler!({
        type: 'terminal.created',
        requestId: 'req-open-foreign-copy',
        terminalId: 'term-open-foreign-copy',
        createdAt: Date.now(),
      })
    })

    const layout = store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>
    const nextContent = layout.content as TerminalPaneContent
    expect(nextContent.terminalId).toBe('term-open-foreign-copy')
    expect(nextContent.sessionRef).toBeUndefined()
    expect(nextContent.resumeSessionId).toBeUndefined()
    expect(store.getState().tabs.tabs[0]?.resumeSessionId).toBeUndefined()
  })

  it('blocks restore when an exact sessionRef belongs to a different provider than the pane mode', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-restore-provider-mismatch'
    const paneId = 'pane-restore-provider-mismatch'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-restore-provider-mismatch',
      status: 'creating',
      mode: 'codex',
      shell: 'system',
      resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      sessionRef: {
        provider: 'claude',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        serverInstanceId: 'srv-local',
      },
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            createRequestId: 'req-restore-provider-mismatch',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls).toHaveLength(0)
      expect(terminalInstances[0].writeln).toHaveBeenCalledWith(
        expect.stringContaining('[Restore blocked: exact session identity missing]'),
      )
    })
  })

  it('blocks stale no-layout coding terminal reattach after INVALID_TERMINAL_ID instead of recreating from mirrored resume metadata', async () => {
    restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(true)
    const tabId = 'tab-stale-no-layout'
    const paneId = 'pane-stale-no-layout'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-stale-no-layout',
      status: 'running',
      mode: 'codex',
      shell: 'system',
      terminalId: 'term-stale-no-layout',
      resumeSessionId: 'codex-session-123',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'codex',
            status: 'running',
            title: 'Codex',
            titleSetByUser: false,
            terminalId: 'term-stale-no-layout',
            resumeSessionId: 'codex-session-123',
            createRequestId: 'req-stale-no-layout',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    const { rerender } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    wsMocks.send.mockClear()

    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-stale-no-layout',
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.terminalId).toBeUndefined()
      expect(layout.content.createRequestId).toBe('req-stale-no-layout')
      const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
      expect(createCalls).toHaveLength(0)
      expect(terminalInstances[0].writeln).toHaveBeenCalledWith(
        expect.stringContaining('[Restore blocked: exact session identity missing]'),
      )
    })
  })

  it('retries terminal.create after RATE_LIMITED errors', async () => {
    vi.useFakeTimers()
    const tabId = 'tab-rate-limit'
    const paneId = 'pane-rate-limit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-rate-limit',
      status: 'creating',
      mode: 'shell',
      shell: 'system',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'shell',
            status: 'running',
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-rate-limit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(messageHandler).not.toBeNull()

    const createCallsBefore = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsBefore.length).toBeGreaterThan(0)

    messageHandler!({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many terminal.create requests',
      requestId: 'req-rate-limit',
    })

    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('creating')

    await act(async () => {
      vi.advanceTimersByTime(250)
    })

    const createCallsAfter = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCallsAfter.length).toBe(createCallsBefore.length + 1)
  })

  it('does not reconnect after terminal.exit when INVALID_TERMINAL_ID is received', async () => {
    // This test verifies the fix for the runaway terminal creation loop:
    // 1. Terminal exits normally (e.g., Claude fails to resume)
    // 2. Some operation (resize) triggers INVALID_TERMINAL_ID for the dead terminal
    // 3. The INVALID_TERMINAL_ID handler should NOT trigger reconnection because
    //    the terminal was already marked as exited (terminalIdRef was cleared)
    const tabId = 'tab-exit'
    const paneId = 'pane-exit'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-exit',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-exit',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-exit',
            createRequestId: 'req-exit',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalViewFromStore tabId={tabId} paneId={paneId} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Terminal exits (simulates Claude failing to resume due to invalid path)
    messageHandler!({
      type: 'terminal.exit',
      terminalId: 'term-exit',
      exitCode: 1,
    })

    // Verify status is 'exited'
    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
      expect(layout.content.status).toBe('exited')
    })

    // Clear send mock to track only new calls
    wsMocks.send.mockClear()

    // Now simulate INVALID_TERMINAL_ID (as if a resize was sent to the dead terminal)
    // This should NOT trigger reconnection because terminal already exited
    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-exit',
    })

    // Give any async operations time to complete
    await new Promise(resolve => setTimeout(resolve, 50))

    // Verify NO terminal.create was sent (this is the key assertion)
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) => msg?.type === 'terminal.create')
    expect(createCalls).toHaveLength(0)

    // Verify the pane content still shows exited status with original terminalId preserved in Redux
    // (but the ref should have been cleared, which we can't directly test here)
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.status).toBe('exited')

    // Verify user-facing feedback was shown
    const term = terminalInstances[0]
    const writelnCalls = term.writeln.mock.calls.map(([s]: [string]) => s)
    expect(writelnCalls.some((s: string) => s.includes('Terminal exited'))).toBe(true)
  })

  it('mirrors resumeSessionId to tab on terminal.session.associated', async () => {
    const tabId = 'tab-session-assoc'
    const paneId = 'pane-session-assoc'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-assoc',
      status: 'creating',
      mode: 'claude',
      shell: 'system',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        paneRuntimeTitle: paneRuntimeTitleReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            createRequestId: 'req-assoc',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        paneRuntimeTitle: {
          titlesByPaneId: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Simulate terminal creation first to set terminalId
    messageHandler!({
      type: 'terminal.created',
      requestId: 'req-assoc',
      terminalId: 'term-assoc',
      createdAt: Date.now(),
    })
    store.dispatch(setPaneRuntimeTitle({ paneId, title: 'vim README.md' }))
    expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')

    // Simulate session association
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'

    messageHandler!({
      type: 'terminal.session.associated',
      terminalId: 'term-assoc',
      sessionId,
    })

    // Verify pane content has resumeSessionId + sessionRef
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.resumeSessionId).toBe(sessionId)
    expect(layout.content.sessionRef).toEqual({
      provider: 'claude',
      sessionId,
      serverInstanceId: 'srv-local',
    })

    // Verify tab also has resumeSessionId mirrored
    const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
    expect(tab?.resumeSessionId).toBe(sessionId)
    expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
  })

  it('clears tab terminalId and sets status to creating on INVALID_TERMINAL_ID reconnect', async () => {
    const tabId = 'tab-clear-tid'
    const paneId = 'pane-clear-tid'

    const paneContent: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-clear',
      status: 'running',
      mode: 'claude',
      shell: 'system',
      terminalId: 'term-clear',
      initialCwd: '/tmp',
    }

    const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        connection: connectionReducer,
      },
      preloadedState: {
        tabs: {
          tabs: [{
            id: tabId,
            mode: 'claude',
            status: 'running',
            title: 'Claude',
            titleSetByUser: false,
            terminalId: 'term-clear',
            createRequestId: 'req-clear',
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: createSettingsState(),
        connection: { status: 'connected', error: null },
      },
    })

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })

    // Trigger INVALID_TERMINAL_ID for the current terminal
    messageHandler!({
      type: 'error',
      code: 'INVALID_TERMINAL_ID',
      message: 'Unknown terminalId',
      terminalId: 'term-clear',
    })

    // Wait for state update
    await waitFor(() => {
      const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
      expect(tab?.terminalId).toBeUndefined()
    })

    // Verify tab status was set to 'creating'
    const tab = store.getState().tabs.tabs.find(t => t.id === tabId)
    expect(tab?.status).toBe('creating')

    // Verify pane content was also updated
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.terminalId).toBeUndefined()
    expect(layout.content.status).toBe('creating')
  })

  describe('non-blocking reconnect', () => {
    function setupNonBlockingTerminal(connectionStatus: 'ready' | 'disconnected') {
      const tabId = 'tab-non-blocking'
      const paneId = 'pane-non-blocking'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-non-blocking',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        terminalId: 'term-non-blocking',
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
          paneRuntimeTitle: paneRuntimeTitleReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: 'running',
              title: 'Shell',
              titleSetByUser: false,
              terminalId: 'term-non-blocking',
              createRequestId: 'req-non-blocking',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState(),
          connection: {
            status: connectionStatus,
            error: null,
          },
          turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {} },
        },
      })

      return { tabId, paneId, paneContent, store }
    }

    it('does not render a blocking reconnect spinner during attach replay', async () => {
      const { tabId, paneId, paneContent, store } = setupNonBlockingTerminal('ready')

      const { queryByText, queryByTestId } = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-non-blocking',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      expect(queryByTestId('loader')).toBeNull()
      expect(queryByText('Reconnecting...')).toBeNull()
      expect(queryByText('Recovering terminal output...')).not.toBeNull()
    })

    it('shows inline offline status while disconnected without blocking overlay', async () => {
      const { tabId, paneId, paneContent, store } = setupNonBlockingTerminal('disconnected')

      const { queryByText, queryByTestId } = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-non-blocking',
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      expect(queryByTestId('loader')).toBeNull()
      expect(queryByText('Reconnecting...')).toBeNull()
      expect(queryByText('Offline: input will queue until reconnected.')).not.toBeNull()
    })
  })

  describe('v2 stream lifecycle', () => {
    async function renderTerminalHarness(opts?: {
      status?: 'creating' | 'running'
      terminalId?: string
      hidden?: boolean
      clearSends?: boolean
      requestId?: string
      ackInitialAttach?: boolean
      refreshOnMount?: boolean
    }) {
      const tabId = 'tab-v2-stream'
      const paneId = 'pane-v2-stream'
      const requestId = opts?.requestId ?? 'req-v2-stream'
      const initialStatus = opts?.status ?? 'running'
      const terminalId = opts?.terminalId

      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: requestId,
        status: initialStatus,
        mode: 'shell',
        shell: 'system',
        ...(terminalId ? { terminalId } : {}),
      }

      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
          paneRuntimeTitle: paneRuntimeTitleReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'shell',
              status: initialStatus,
              title: 'Shell',
              titleSetByUser: false,
              createRequestId: requestId,
              ...(terminalId ? { terminalId } : {}),
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
            paneTitleSetByUser: {},
            renameRequestTabId: null,
            renameRequestPaneId: null,
            zoomedPane: {},
            refreshRequestsByPane: opts?.refreshOnMount
              ? {
                [tabId]: {
                  [paneId]: {
                    requestId: 'refresh-v2-stream',
                    target: { kind: 'terminal', createRequestId: requestId },
                  },
                },
              }
              : {},
          },
          paneRuntimeTitle: {
            titlesByPaneId: {},
          },
          settings: createSettingsState(),
          connection: { status: 'connected', error: null },
        },
      })

      const view = render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={opts?.hidden} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      await waitFor(() => {
        expect(terminalInstances.length).toBeGreaterThan(0)
      })

      if (opts?.ackInitialAttach !== false && initialStatus === 'running' && terminalId && !opts?.hidden) {
        const initialAttach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        if (initialAttach?.attachRequestId) {
          act(() => {
            messageHandler!({
              type: 'terminal.attach.ready',
              terminalId,
              headSeq: initialAttach.sinceSeq ?? 0,
              replayFromSeq: (initialAttach.sinceSeq ?? 0) + 1,
              replayToSeq: initialAttach.sinceSeq ?? 0,
              attachRequestId: initialAttach.attachRequestId,
            })
          })
        }
      }

      if (opts?.clearSends !== false) {
        wsMocks.send.mockClear()
      }

      return {
        ...view,
        store,
        tabId,
        paneId,
        term: terminalInstances[terminalInstances.length - 1],
        requestId,
        terminalId: terminalId || 'term-v2-stream',
      }
    }

    it('create path sends terminal.create then explicit attach with viewport', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-split-create',
      })

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId,
      }))

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-split-1', createdAt: Date.now() })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-split-1',
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
      }))
    })

    it('terminal.created always triggers explicit attach with viewport', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-legacy-create',
      })

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-legacy-1', createdAt: Date.now() })

      const attachCalls = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-legacy-1')
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]).toMatchObject({
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
      })
    })

    it('hidden create path defers attach until visible and measured', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-create',
      })

      wsMocks.send.mockClear()
      messageHandler!({ type: 'terminal.created', requestId, terminalId: 'term-hidden-create', createdAt: Date.now() })

      let attachCalls = wsMocks.send.mock.calls.map(([msg]) => msg).filter((msg) => msg?.type === 'terminal.attach')
      expect(attachCalls).toHaveLength(0)

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      await waitFor(() => {
        attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-hidden-create')
        expect(attachCalls).toHaveLength(1)
      })
      expect(attachCalls[0]).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
        attachRequestId: expect.any(String),
      })
    })

    it('hidden split create keeps viewport_hydrate intent when reconnect fires before reveal', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-reconnect-intent',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-hidden-reconnect-intent',
        createdAt: Date.now(),
      })

      // Reconnect while hidden should not downgrade pending viewport hydration to delta attach.
      reconnectHandler?.()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      let attachCalls: Array<Record<string, unknown>> = []
      await waitFor(() => {
        attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-hidden-reconnect-intent')
        expect(attachCalls.length).toBeGreaterThan(0)
      })

      expect(attachCalls[0]).toMatchObject({
        sinceSeq: 0,
        cols: expect.any(Number),
        rows: expect.any(Number),
      })
    })

    it('ignores duplicate terminal.created for a handled split request', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-duplicate-created',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-duplicate-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const attachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-duplicate-created')
        expect(attachCalls).toHaveLength(1)
      })

      const countByType = (type: string) => wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === type && msg?.terminalId === 'term-v2-duplicate-created')
        .length

      const attachCountAfterFirst = countByType('terminal.attach')
      const resizeCountAfterFirst = countByType('terminal.resize')

      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-duplicate-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        expect(countByType('terminal.attach')).toBe(attachCountAfterFirst)
        expect(countByType('terminal.resize')).toBe(resizeCountAfterFirst)
      })
    })

    it('handles same requestId terminal.created when terminalId changes', async () => {
      const { requestId } = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        requestId: 'req-v2-replaced-created',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-first-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const firstAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-first-created')
        expect(firstAttachCalls).toHaveLength(1)
      })

      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-v2-replaced-created',
        createdAt: Date.now(),
      })

      await waitFor(() => {
        const firstAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-first-created')
        const replacedAttachCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-replaced-created')
        expect(firstAttachCalls).toHaveLength(1)
        expect(replacedAttachCalls).toHaveLength(1)
      })
    })

    it('reconnect and future creates stay on the explicit attach lifecycle', async () => {
      const first = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-latched-first',
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: first.requestId,
      }))

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId: first.requestId,
        terminalId: 'term-latched-1',
        createdAt: Date.now(),
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-latched-1',
        cols: expect.any(Number),
        rows: expect.any(Number),
      }))

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-latched-1',
        cols: expect.any(Number),
        rows: expect.any(Number),
      }))

      first.unmount()
      wsMocks.send.mockClear()

      const second = await renderTerminalHarness({
        status: 'creating',
        hidden: false,
        clearSends: false,
        requestId: 'req-v2-latched-second',
      })
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.create',
        requestId: second.requestId,
      }))
    })

    it('claims a pending refresh request on mount by detaching and reattaching once', async () => {
      const { store, tabId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-refresh-mount',
        refreshOnMount: true,
        clearSends: false,
      })

      const sends = wsMocks.send.mock.calls.map(([msg]) => msg)
      const detachIdx = sends.findIndex((msg) => msg?.type === 'terminal.detach' && msg?.terminalId === terminalId)
      const attachCalls = sends.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

      expect(detachIdx).toBeGreaterThanOrEqual(0)
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]).toMatchObject({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
      })
      expect(store.getState().panes.refreshRequestsByPane[tabId]).toBeUndefined()
    })

    it('refreshes an attached terminal when a matching request arrives after mount', async () => {
      const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-refresh-late',
      })

      wsMocks.send.mockClear()

      act(() => {
        store.dispatch(requestPaneRefresh({ tabId, paneId }))
      })

      await waitFor(() => {
        const sends = wsMocks.send.mock.calls.map(([msg]) => msg)
        const detachIdx = sends.findIndex((msg) => msg?.type === 'terminal.detach' && msg?.terminalId === terminalId)
        const attachIdx = sends.findIndex((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

        expect(detachIdx).toBeGreaterThanOrEqual(0)
        expect(attachIdx).toBeGreaterThan(detachIdx)
        expect(sends[attachIdx]).toMatchObject({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
        })
      })

      expect(store.getState().panes.refreshRequestsByPane[tabId]).toBeUndefined()
    })

    it('sends sinceSeq=0 when attaching without previously rendered output', async () => {
      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-attach' })
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
        attachRequestId: expect.any(String),
      }))
    })

    it('drops stale and untagged terminal.output from non-current attach generations', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-attach-gen',
        clearSends: false,
      })

      const firstAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(firstAttach?.attachRequestId).toBeTruthy()

      wsMocks.send.mockClear()
      reconnectHandler?.()

      const secondAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

      expect(secondAttach?.attachRequestId).toBeTruthy()
      expect(secondAttach?.attachRequestId).not.toBe(firstAttach?.attachRequestId)

      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 1,
        seqEnd: 1,
        data: 'STALE',
        attachRequestId: firstAttach!.attachRequestId,
      } as any)
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 2,
        seqEnd: 2,
        data: 'FRESH',
        attachRequestId: secondAttach!.attachRequestId,
      } as any)
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: 3,
        seqEnd: 3,
        data: 'UNTAGGED',
        __preserveMissingAttachRequestId: true,
      } as any)

      const writes = term.write.mock.calls.map(([d]) => String(d)).join('')
      expect(writes).toContain('FRESH')
      expect(writes).not.toContain('STALE')
      expect(writes).not.toContain('UNTAGGED')
    })

    it('keeps queued viewport_hydrate intent when reconnect fires before the first hidden attach completes', async () => {
      const { requestId, rerender, store, tabId, paneId } = await renderTerminalHarness({
        status: 'creating',
        hidden: true,
        requestId: 'req-v2-hidden-created-before-reconnect',
      })

      wsMocks.send.mockClear()
      messageHandler!({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-hidden-created-before-reconnect',
        createdAt: Date.now(),
      })

      reconnectHandler?.()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>,
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId: 'term-hidden-created-before-reconnect',
          sinceSeq: 0,
          cols: expect.any(Number),
          rows: expect.any(Number),
        }))
      })
    })

    it('uses the highest rendered sequence in reconnect attach requests', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-reconnect' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'ab' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 3, seqEnd: 3, data: 'c' })

      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('ab')
      expect(writes).toContain('c')

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 3,
        attachRequestId: expect.any(String),
      }))
    })

    it('reattaches with latest rendered sequence after terminal view remount', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-remount' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
    })

    it('does not attach a remounted hidden pane until it becomes visible', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-hidden-remount' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
      }))
    })

    it('performs one deferred viewport hydration attach when a remounted hidden pane becomes visible', async () => {
      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-deferred-hydrate' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      unmount()
      wsMocks.send.mockClear()

      const view = render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })
      expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
      }))

      wsMocks.send.mockClear()
      view.rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })
      expect(wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 3,
          replayFromSeq: 1,
          replayToSeq: 3,
        })
      })

      wsMocks.send.mockClear()
      view.rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
        </Provider>
      )
      view.rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      const hydrateCalls = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId && msg?.sinceSeq === 0)
      expect(hydrateCalls).toHaveLength(0)
    })

    it('uses max(persisted cursor, in-memory sequence) for reconnect attach requests', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-max-cursor': {
          seq: 8,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-max-cursor' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 9, seqEnd: 10, data: 'ij' })
      wsMocks.send.mockClear()

      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 10,
        attachRequestId: expect.any(String),
      }))
    })

    it('keeps reconnect attach on high-water cursor when reconnect fires during remount hydration', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-reconnect-during-hydration': {
          seq: 11,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { store, tabId, paneId, terminalId, unmount } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-reconnect-during-hydration',
      })

      unmount()
      wsMocks.send.mockClear()

      render(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.attach',
          terminalId,
          sinceSeq: 0,
          attachRequestId: expect.any(String),
        }))
      })

      wsMocks.send.mockClear()
      reconnectHandler?.()

      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 11,
        attachRequestId: expect.any(String),
      }))
    })

    it('keeps viewport replay output when reconnect attach starts before the viewport replay arrives', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-overlapping-attach-ready': {
          seq: 12,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-overlapping-attach-ready',
      })

      // Simulate a reconnect attach racing ahead of the first viewport replay.
      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 12,
        attachRequestId: expect.any(String),
      }))

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 12,
          replayFromSeq: 1,
          replayToSeq: 12,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: 'history-1',
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 6,
          seqEnd: 6,
          data: 'history-6',
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 12,
          seqEnd: 12,
          data: 'history-12',
        })
      })

      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('history-1')
      expect(writes).toContain('history-6')
      expect(writes).toContain('history-12')
    })

    it('preserves persisted high-water when a hydration replay starts at sequence 1', async () => {
      setLocalStorageItemForTest(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
        'term-v2-seq-reset': {
          seq: 12,
          updatedAt: Date.now(),
        },
      }))
      __resetTerminalCursorCacheForTests()

      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-seq-reset' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('abc')

      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 12,
        attachRequestId: expect.any(String),
      }))
    })

    it('ignores overlapping output ranges and keeps forward-only rendering', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-overlap' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'first' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 2, data: 'overlap' })
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 2, seqEnd: 2, data: 'second' })

      const writes = term.write.mock.calls.map(([data]: [string]) => data)
      expect(writes).toContain('first')
      expect(writes).toContain('second')
      expect(writes).not.toContain('overlap')
    })

    it('renders replay_window_exceeded banner during viewport_hydrate attach generation', async () => {
      const { terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-hydrate-gap',
        clearSends: false,
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(attach?.attachRequestId).toBeTruthy()

      term.writeln.mockClear()
      messageHandler!({
        type: 'terminal.output.gap',
        terminalId,
        fromSeq: 1,
        toSeq: 50,
        reason: 'replay_window_exceeded',
        attachRequestId: attach!.attachRequestId,
      } as any)

      expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining('Output gap 1-50: reconnect window exceeded'))

      wsMocks.send.mockClear()
      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 50,
        attachRequestId: expect.any(String),
      }))
    })

    it('revealing a hidden running pane sends a viewport attach with sinceSeq=0', async () => {
      const { store, tabId, paneId, terminalId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-bootstrap-gap',
        hidden: true,
        clearSends: false,
      })

      wsMocks.send.mockClear()

      rerender(
        <Provider store={store}>
          <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
        </Provider>
      )

      let attach: any
      await waitFor(() => {
        attach = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
        expect(attach).toBeTruthy()
      })
      expect(attach?.sinceSeq).toBe(0)
      expect(attach?.attachRequestId).toBeTruthy()
    })

    it('does not send terminal.resize when an already-live terminal is hidden and revealed with unchanged geometry', async () => {
      const { rerender, store, tabId, paneId, terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-no-resize',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      wsMocks.send.mockClear()
      runtime!.fit.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        expect(runtime!.fit).toHaveBeenCalled()
      })

      const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
      expect(sent.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)).toHaveLength(0)
      expect(sent.filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)).toHaveLength(0)
    })

    it('does not send terminal.resize when a create-path terminal is already-live before a same-geometry reveal', async () => {
      const { rerender, store, tabId, paneId, requestId } = await renderTerminalHarness({
        status: 'creating',
        requestId: 'req-live-reveal-created',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId,
          terminalId: 'term-live-reveal-created',
          createdAt: Date.now(),
        })
      })

      const attach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .reverse()
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-live-reveal-created')
      expect(attach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-live-reveal-created',
          headSeq: attach?.sinceSeq ?? 0,
          replayFromSeq: (attach?.sinceSeq ?? 0) + 1,
          replayToSeq: attach?.sinceSeq ?? 0,
          attachRequestId: attach.attachRequestId,
        })
      })

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      wsMocks.send.mockClear()
      runtime!.fit.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        expect(runtime!.fit).toHaveBeenCalled()
      })

      const sent = wsMocks.send.mock.calls.map(([msg]) => msg)
      expect(sent.filter((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-live-reveal-created')).toHaveLength(0)
      expect(sent.filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === 'term-live-reveal-created')).toHaveLength(0)
    })

    it('sends exactly one terminal.resize when an already-live terminal is revealed after geometry changes', async () => {
      const { rerender, store, tabId, paneId, terminalId, term } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-real-resize',
        clearSends: false,
      })

      const runtime = runtimeMocks.instances.at(-1)
      expect(runtime).toBeTruthy()

      const queuedFrames: FrameRequestCallback[] = []
      requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
        queuedFrames.push(cb)
        return queuedFrames.length
      })

      runtime!.fit.mockImplementation(() => {
        term.cols = 132
        term.rows = 40
      })

      wsMocks.send.mockClear()

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden
            />
          </Provider>,
        )
      })
      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      await act(async () => {
        queuedFrames.splice(0).forEach((cb) => cb(0))
      })

      await waitFor(() => {
        const resizeCalls = wsMocks.send.mock.calls
          .map(([msg]) => msg)
          .filter((msg) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)
        expect(resizeCalls).toHaveLength(1)
      })
    })

    it('evicts cached viewport entries when a terminal exits', async () => {
      const { terminalId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-live-reveal-cache-evict',
        clearSends: false,
      })

      expect(__getLastSentViewportCacheSizeForTests()).toBe(1)

      act(() => {
        messageHandler!({
          type: 'terminal.exit',
          terminalId,
          exitCode: 0,
        })
      })

      expect(__getLastSentViewportCacheSizeForTests()).toBe(0)
    })

    it('bounds cached viewport entries to the most recent terminals', async () => {
      for (let index = 0; index < 205; index += 1) {
        const { unmount } = await renderTerminalHarness({
          status: 'running',
          terminalId: `term-live-reveal-cache-bound-${index}`,
          clearSends: false,
        })
        unmount()
      }

      expect(__getLastSentViewportCacheSizeForTests()).toBe(200)
    })

    it('renders terminal.output.gap marker and advances sinceSeq for subsequent attach', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-gap' })

      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: 'ok' })
      term.writeln.mockClear()
      wsMocks.send.mockClear()

      messageHandler!({
        type: 'terminal.output.gap',
        terminalId,
        fromSeq: 2,
        toSeq: 5,
        reason: 'queue_overflow',
      })

      expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining('Output gap 2-5: slow link backlog'))

      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 5,
        attachRequestId: expect.any(String),
      }))
    })

    it('renders replay frames after attach.ready when replay starts above 1', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-ready-then-replay' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 8,
          replayFromSeq: 6,
          replayToSeq: 8,
        })
      })

      act(() => {
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 6, seqEnd: 6, data: 'R6' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 7, seqEnd: 7, data: 'R7' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 8, seqEnd: 8, data: 'R8' })
      })

      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('R6')
      expect(writes).toContain('R7')
      expect(writes).toContain('R8')
    })

    it('does not restore runtime titles from replayed OSC frames, but accepts a later live re-emission', async () => {
      const { terminalId, term, store, paneId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-replay',
        ackInitialAttach: false,
        clearSends: false,
      })

      const initialAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(initialAttach?.attachRequestId).toBeTruthy()

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (String(data).includes('\x1b]0;vim README.md\x07')) {
          titleListener('vim README.md')
        }
        onWritten?.()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 1,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: initialAttach.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: '\x1b]0;vim README.md\x07',
          attachRequestId: initialAttach.attachRequestId,
        })
      })

      expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('restores the same runtime title after an INVALID_TERMINAL_ID rebind', async () => {
      const { terminalId, term, store, paneId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-rebind',
      })

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })

      act(() => {
        messageHandler!({
          type: 'error',
          code: 'INVALID_TERMINAL_ID',
          terminalId,
        })
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()
        expect(store.getState().panes.layouts['tab-v2-stream']).toMatchObject({
          type: 'leaf',
          content: {
            status: 'creating',
          },
        })
      })

      const reboundRequestId = (store.getState().panes.layouts['tab-v2-stream'] as Extract<PaneNode, { type: 'leaf' }>).content.createRequestId
      expect(reboundRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: reboundRequestId,
          terminalId: 'term-v2-runtime-title-rebound',
          createdAt: Date.now(),
        })
      })

      const reboundAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-runtime-title-rebound')
      expect(reboundAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-v2-runtime-title-rebound',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: reboundAttach.attachRequestId,
        })
      })

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('restores the same runtime title after exit followed by pane recreation', async () => {
      const { terminalId, term, store, paneId, tabId, rerender } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-exit',
      })

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })

      act(() => {
        messageHandler!({
          type: 'terminal.exit',
          terminalId,
          exitCode: 0,
        })
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()
        expect(store.getState().panes.layouts[tabId]).toMatchObject({
          type: 'leaf',
          content: {
            status: 'exited',
          },
        })
      })

      act(() => {
        store.dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            kind: 'terminal',
            mode: 'shell',
            shell: 'system',
            status: 'creating',
            createRequestId: 'req-v2-runtime-title-after-exit',
          },
        }))
        store.dispatch(setActiveTab(tabId))
      })

      const readPaneContent = () => {
        const layout = store.getState().panes.layouts[tabId]
        return layout && layout.type === 'leaf' && layout.content.kind === 'terminal' ? layout.content : null
      }

      await act(async () => {
        rerender(
          <Provider store={store}>
            <TerminalView
              tabId={tabId}
              paneId={paneId}
              paneContent={readPaneContent()!}
              hidden={false}
            />
          </Provider>,
        )
      })

      const recreatedRequestId = (store.getState().panes.layouts[tabId] as Extract<PaneNode, { type: 'leaf' }>).content.createRequestId
      expect(recreatedRequestId).toBe('req-v2-runtime-title-after-exit')

      await waitFor(() => {
        expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'terminal.create',
          requestId: 'req-v2-runtime-title-after-exit',
        }))
      })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: recreatedRequestId,
          terminalId: 'term-v2-runtime-title-after-exit',
          createdAt: Date.now(),
        })
      })

      const recreatedAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-v2-runtime-title-after-exit')
      expect(recreatedAttach?.attachRequestId).toBeTruthy()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-v2-runtime-title-after-exit',
          headSeq: 0,
          replayFromSeq: 1,
          replayToSeq: 0,
          attachRequestId: recreatedAttach.attachRequestId,
        })
      })

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('restores the same runtime title after a stable durable title sync clears runtime state', async () => {
      const { terminalId, term, store, paneId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-stable-clear',
      })

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })

      await act(async () => {
        await store.dispatch(syncStableTitleByTerminalId({
          terminalId,
          title: 'Claude Session',
        }) as any)
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('restores the same runtime title after updatePaneContent clears runtime state', async () => {
      const { terminalId, term, store, paneId, tabId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-content-clear',
      })

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })

      act(() => {
        store.dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            kind: 'terminal',
            mode: 'shell',
            shell: 'system',
            status: 'running',
            createRequestId: 'req-v2-runtime-title-content-clear',
            terminalId,
          },
        }))
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('ignores the first post-replay attach frame for runtime title restoration', async () => {
      const { terminalId, term, store, paneId } = await renderTerminalHarness({
        status: 'running',
        terminalId: 'term-v2-runtime-title-post-replay',
        ackInitialAttach: false,
        clearSends: false,
      })

      const initialAttach = wsMocks.send.mock.calls
        .map(([msg]) => msg)
        .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
      expect(initialAttach?.attachRequestId).toBeTruthy()

      const titleListener = term.onTitleChange.mock.calls[0]?.[0]
      expect(titleListener).toBeTypeOf('function')

      term.write.mockImplementation((data: string, onWritten?: () => void) => {
        if (String(data).includes('\x1b]0;vim README.md\x07')) {
          titleListener('vim README.md')
        }
        onWritten?.()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 2,
          replayFromSeq: 1,
          replayToSeq: 1,
          attachRequestId: initialAttach.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 1,
          seqEnd: 1,
          data: '\x1b]0;vim README.md\x07',
          attachRequestId: initialAttach.attachRequestId,
        })
        messageHandler!({
          type: 'terminal.output',
          terminalId,
          seqStart: 2,
          seqEnd: 2,
          data: '\x1b]0;vim README.md\x07',
          attachRequestId: initialAttach.attachRequestId,
        })
      })

      expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBeUndefined()

      await act(async () => {
        await Promise.resolve()
      })

      act(() => {
        titleListener('vim README.md')
      })

      await waitFor(() => {
        expect(store.getState().paneRuntimeTitle.titlesByPaneId[paneId]).toBe('vim README.md')
      })
    })

    it('keeps continuity through gap + replay tail + live output', async () => {
      const { terminalId, term } = await renderTerminalHarness({ status: 'running', terminalId: 'term-v2-gap-tail' })

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId,
          headSeq: 12,
          replayFromSeq: 9,
          replayToSeq: 12,
        })
        messageHandler!({
          type: 'terminal.output.gap',
          terminalId,
          fromSeq: 1,
          toSeq: 8,
          reason: 'replay_window_exceeded',
        })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 9, seqEnd: 12, data: 'TAIL' })
        messageHandler!({ type: 'terminal.output', terminalId, seqStart: 13, seqEnd: 13, data: 'LIVE' })
      })

      expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining('Output gap 1-8: reconnect window exceeded'))
      const writes = term.write.mock.calls.map(([data]: [string]) => String(data)).join('')
      expect(writes).toContain('TAIL')
      expect(writes).toContain('LIVE')
    })

    it('updates attach sequence from terminal.attach.ready after terminal.created (broker no-replay sentinel)', async () => {
      const { requestId, term } = await renderTerminalHarness({ status: 'creating' })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId,
          terminalId: 'term-v2-created',
          createdAt: Date.now(),
          // legacy payload should be ignored in v2 create handling
          snapshot: 'legacy snapshot payload',
        } as any)
      })

      expect(term.write).not.toHaveBeenCalled()
      wsMocks.send.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.attach.ready',
          terminalId: 'term-v2-created',
          // Broker emits replayFrom=head+1 and replayTo=head when no replay frames exist.
          headSeq: 7,
          replayFromSeq: 8,
          replayToSeq: 7,
        })
      })

      reconnectHandler?.()
      expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'terminal.attach',
        terminalId: 'term-v2-created',
        sinceSeq: 7,
        attachRequestId: expect.any(String),
      }))
    })
  })

  describe('snapshot replay sanitization', () => {
    function setupTerminal() {
      const tabId = 'tab-1'
      const paneId = 'pane-1'
      const paneContent: TerminalPaneContent = {
        kind: 'terminal',
        createRequestId: 'req-clear-1',
        status: 'creating',
        mode: 'claude',
        shell: 'system',
        initialCwd: '/tmp',
      }
      const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
      const store = configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          settings: settingsReducer,
          connection: connectionReducer,
          turnCompletion: turnCompletionReducer,
        },
        preloadedState: {
          tabs: {
            tabs: [{
              id: tabId,
              mode: 'claude',
              status: 'running',
              title: 'Claude',
              titleSetByUser: false,
              createRequestId: 'req-clear-1',
            }],
            activeTabId: tabId,
          },
          panes: {
            layouts: { [tabId]: root },
            activePane: { [tabId]: paneId },
            paneTitles: {},
          },
          settings: createSettingsState({
            settings: {
              ...defaultSettings,
              terminal: {
                ...defaultSettings.terminal,
                osc52Clipboard: 'never',
              },
            },
          }),
          connection: { status: 'connected', error: null },
          turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
        },
      })
      return { tabId, paneId, paneContent, store }
    }

    it('does not consume legacy snapshot payload on terminal.created', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          snapshot: 'legacy created snapshot',
        } as any)
      })

      expect(term.write).not.toHaveBeenCalled()
      expect(store.getState().turnCompletion.lastEvent).toBeNull()
    })

    it('ignores legacy terminal.snapshot frames', async () => {
      const { tabId, paneId, paneContent, store } = setupTerminal()

      render(
        <Provider store={store}>
          <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
        </Provider>
      )

      await waitFor(() => {
        expect(messageHandler).not.toBeNull()
      })

      act(() => {
        messageHandler!({
          type: 'terminal.created',
          requestId: 'req-clear-1',
          terminalId: 'term-1',
          createdAt: Date.now(),
        })
      })

      const term = terminalInstances[terminalInstances.length - 1]
      term.clear.mockClear()
      term.write.mockClear()

      act(() => {
        messageHandler!({
          type: 'terminal.snapshot',
          terminalId: 'term-1',
          snapshot: 'legacy snapshot payload',
        })
      })

      expect(term.clear).not.toHaveBeenCalled()
      expect(term.write).not.toHaveBeenCalled()
      expect(store.getState().turnCompletion.lastEvent).toBeNull()
    })
  })
})

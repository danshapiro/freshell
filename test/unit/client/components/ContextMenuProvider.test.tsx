import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'

import tabsReducer from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneContent } from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import extensionsReducer from '@/store/extensionsSlice'
import tabRecencyReducer from '@/store/tabRecencySlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import type { ClientExtensionEntry } from '@shared/extension-types'

const defaultCliExtensions: ClientExtensionEntry[] = [
  {
    name: 'claude', version: '1.0.0', label: 'Claude CLI', description: '', category: 'cli',
    picker: { shortcut: 'L' },
    cli: { supportsPermissionMode: true, supportsResume: true, resumeCommandTemplate: ['claude', '--resume', '{{sessionId}}'] },
  },
  {
    name: 'codex', version: '1.0.0', label: 'Codex CLI', description: '', category: 'cli',
    picker: { shortcut: 'X' },
    cli: { supportsModel: true, supportsSandbox: true, supportsResume: true, resumeCommandTemplate: ['codex', 'resume', '{{sessionId}}'] },
  },
]
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import TabBar from '@/components/TabBar'
import Pane from '@/components/panes/Pane'

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}))

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

const apiMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue([]),
  post: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
  put: vi.fn().mockResolvedValue({}),
  delete: vi.fn().mockResolvedValue({}),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMocks,
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: apiMocks.get,
    post: apiMocks.post,
    patch: apiMocks.patch,
    put: apiMocks.put,
    delete: apiMocks.delete,
  },
  setSessionMetadata: apiMocks.setSessionMetadata,
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: clipboardMocks.copyText,
}))

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const CODEX_THREAD_ID = '019ec8c9-2b12-7001-a11d-e2e089860320'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createTestStore(options?: { platform?: string | null }) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
          {
            id: 'tab-2',
            createRequestId: 'tab-2',
            title: 'Tab Two',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 2,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready',
        platform: options?.platform ?? null,
      },
    },
  })
}

function renderWithProvider(ui: React.ReactNode, options?: { platform?: string | null }) {
  const store = createTestStore(options)
  const utils = render(
    <Provider store={store}>
      <ContextMenuProvider
        view="terminal"
        onViewChange={() => {}}
        onToggleSidebar={() => {}}
        sidebarCollapsed={false}
      >
        {ui}
      </ContextMenuProvider>
    </Provider>
  )
  return { store, ...utils }
}

function createStoreWithSession() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [
          {
            projectPath: '/test/project',
            sessions: [
              {
                sessionId: VALID_SESSION_ID,
                provider: 'claude',
                title: 'Test Session',
                cwd: '/test/project',
                createdAt: 1000,
                lastActivityAt: 2000,
                messageCount: 5,
              },
            ],
          },
        ],
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
    },
  })
}

function createStoreWithSidebarWindowAgentSession() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [
          {
            projectPath: '/history/project',
            sessions: [
              {
                sessionId: 'history-only',
                provider: 'claude',
                title: 'History Only',
                cwd: '/history/project',
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          },
        ],
        activeSurface: 'history',
        windows: {
          history: {
            projects: [
              {
                projectPath: '/history/project',
                sessions: [
                  {
                    sessionId: 'history-only',
                    provider: 'claude',
                    title: 'History Only',
                    cwd: '/history/project',
                    createdAt: 1000,
                    updatedAt: 2000,
                  },
                ],
              },
            ],
            lastLoadedAt: 1,
          },
          sidebar: {
            projects: [
              {
                projectPath: '/sidebar/project',
                sessions: [
                  {
                    sessionId: VALID_SESSION_ID,
                    provider: 'claude',
                    sessionType: 'freshclaude',
                    title: 'Sidebar Agent Session',
                    cwd: '/sidebar/project',
                    createdAt: 1000,
                    updatedAt: 2000,
                  },
                ],
              },
            ],
            lastLoadedAt: 1,
          },
        },
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready',
        platform: null,
      },
    },
  })
}

function createStoreWithOverlappingSessionWindows() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [
          {
            projectPath: '/shared/project',
            sessions: [
              {
                sessionId: VALID_SESSION_ID,
                provider: 'claude',
                sessionType: 'freshclaude',
                title: 'Sidebar Agent Session',
                cwd: '/shared/project/sidebar',
                createdAt: 1000,
                updatedAt: 2000,
              },
            ],
          },
        ],
        activeSurface: 'history',
        windows: {
          sidebar: {
            projects: [
              {
                projectPath: '/shared/project',
                sessions: [
                  {
                    sessionId: VALID_SESSION_ID,
                    provider: 'claude',
                    sessionType: 'freshclaude',
                    title: 'Sidebar Agent Session',
                    cwd: '/shared/project/sidebar',
                    createdAt: 1000,
                    updatedAt: 2000,
                  },
                ],
              },
            ],
            lastLoadedAt: 1,
          },
          history: {
            projects: [
              {
                projectPath: '/shared/project',
                sessions: [
                  {
                    sessionId: VALID_SESSION_ID,
                    provider: 'claude',
                    title: 'History Terminal Session',
                    cwd: '/shared/project/history',
                    createdAt: 1000,
                    updatedAt: 2000,
                  },
                  {
                    sessionId: 'history-extra',
                    provider: 'claude',
                    title: 'History Extra Session',
                    cwd: '/shared/project/history',
                    createdAt: 1000,
                    updatedAt: 2000,
                  },
                ],
              },
            ],
            lastLoadedAt: 1,
          },
        },
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready',
        platform: null,
      },
    },
  })
}

function createStoreWithBrowserPane(options?: { zoomedPaneId?: string }) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Tab One',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'browser',
              browserInstanceId: 'browser-1',
              url: 'https://example.com',
              devToolsOpen: false,
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Browser' } },
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: options?.zoomedPaneId ? { 'tab-1': options.zoomedPaneId } : {},
        refreshRequestsByPane: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready',
        platform: null,
      },
    },
  })
}

function createStoreWithTerminalPane() {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      settings: settingsReducer,
      extensions: extensionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            createRequestId: 'tab-1',
            title: 'Shell',
            status: 'running',
            mode: 'shell',
            shell: 'system',
            createdAt: 1,
          },
        ],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              status: 'running',
              terminalId: 'term-1',
            },
          },
        },
        activePane: { 'tab-1': 'pane-1' },
        paneTitles: { 'tab-1': { 'pane-1': 'Shell' } },
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      connection: {
        status: 'ready',
        platform: 'linux',
      },
    },
  })
}

describe('ContextMenuProvider', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    apiMocks.setSessionMetadata.mockResolvedValue(undefined)
  })

  it('does not emit selector instability warnings when feature flags are absent', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store } = renderWithProvider(
        <div data-context={ContextIds.Global}>Global area</div>,
      )

      store.dispatch({ type: 'test/unrelated' })

      expect(consoleWarnSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Selector')
    } finally {
      consoleWarnSpy.mockRestore()
    }
  })

  it('opens menu on right click and dispatches close tab', async () => {
    const user = userEvent.setup()
    const { store } = renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })

    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByText('Close tab'))

    expect(store.getState().tabs.tabs).toHaveLength(1)
    expect(store.getState().tabs.tabs[0].id).toBe('tab-2')
  })

  it('closes menu on outside click', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div>
        <div data-context={ContextIds.Tab} data-tab-id="tab-1">
          Tab One
        </div>
        <button type="button">Outside</button>
      </div>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(screen.getByText('Outside'))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('respects native menu for input-like elements', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.Global}>
        <input aria-label="Name" />
      </div>
    )

    await user.pointer({ target: screen.getByLabelText('Name'), keys: '[MouseRight]' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('allows native menu for links inside non-global contexts', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.FreshAgent} data-session-id="sess-1">
        <a href="https://example.com">Example Link</a>
      </div>
    )

    await user.pointer({ target: screen.getByText('Example Link'), keys: '[MouseRight]' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('allows native menu when Shift is held', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1">
        Tab One
      </div>
    )

    await user.keyboard('{Shift>}')
    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.keyboard('{/Shift}')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens menu via keyboard context key', async () => {
    const user = userEvent.setup()
    renderWithProvider(
      <div data-context={ContextIds.Tab} data-tab-id="tab-1" tabIndex={0}>
        Tab One
      </div>
    )

    const target = screen.getByText('Tab One')
    await user.click(target)
    fireEvent.keyDown(document, { key: 'F10', shiftKey: true })

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('refreshes a tab from the tab context menu and clears zoom first', async () => {
    const user = userEvent.setup()
    const store = createStoreWithBrowserPane({ zoomedPaneId: 'pane-1' })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Tab} data-tab-id="tab-1">
            Tab One
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

    expect(store.getState().panes.zoomedPane['tab-1']).toBeUndefined()
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toMatchObject({
      target: { kind: 'browser', browserInstanceId: 'browser-1' },
    })
  })

  it('opens the pane menu from the pane shell keyboard target and queues Refresh pane', async () => {
    const user = userEvent.setup()
    const store = createStoreWithBrowserPane()

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <Pane
            tabId="tab-1"
            paneId="pane-1"
            isActive={true}
            isOnlyPane={true}
            title="Browser"
            content={{
              kind: 'browser',
              browserInstanceId: 'browser-1',
              url: 'https://example.com',
              devToolsOpen: false,
            }}
            onClose={() => {}}
            onFocus={() => {}}
          >
            <div>Pane body</div>
          </Pane>
        </ContextMenuProvider>
      </Provider>
    )

    const paneShell = screen.getByRole('group', { name: 'Pane: Browser' })
    paneShell.focus()
    expect(document.activeElement).toBe(paneShell)

    fireEvent.keyDown(document, { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toMatchObject({
      target: { kind: 'browser', browserInstanceId: 'browser-1' },
    })
  })

  it('Rename tab from context menu enters inline rename mode (no prompt)', async () => {
    const user = userEvent.setup()
    const promptSpy = vi.spyOn(window, 'prompt')

    const store = createTestStore()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <TabBar />
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByText('Rename tab'))

    // Inline rename input should appear with the current display title
    const input = await screen.findByRole('textbox')
    expect(input.tagName).toBe('INPUT')
    expect((input as HTMLInputElement).value).toBe('Tab One')
    expect(promptSpy).not.toHaveBeenCalled()
    promptSpy.mockRestore()
  })

  it('open in this tab splits the pane instead of replacing the layout', async () => {
    const user = userEvent.setup()
    const store = createStoreWithSession()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="history"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.SidebarSession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
          >
            Test Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    // Verify initial state has one pane
    const initialLayout = store.getState().panes.layouts['tab-1']
    expect(initialLayout?.type).toBe('leaf')

    // Open context menu and click "Open in this tab"
    await user.pointer({ target: screen.getByText('Test Session'), keys: '[MouseRight]' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByText('Open in this tab'))

    // After clicking, the layout should be a split with two panes
    const newLayout = store.getState().panes.layouts['tab-1']
    expect(newLayout?.type).toBe('split')
    if (newLayout?.type === 'split') {
      expect(newLayout.children).toHaveLength(2)
      // Original pane should still exist
      const originalPane = newLayout.children.find(
        (child) => child.type === 'leaf' && child.id === 'pane-1'
      )
      expect(originalPane).toBeDefined()
      // New pane should have the session info
      const newPane = newLayout.children.find(
        (child) => child.type === 'leaf' && child.id !== 'pane-1'
      )
      expect(newPane).toBeDefined()
      if (newPane?.type === 'leaf') {
        expect(newPane.content.kind).toBe('terminal')
        if (newPane.content.kind === 'terminal') {
          expect(newPane.content.mode).toBe('claude')
          expect(newPane.content.sessionRef).toEqual({
            provider: 'claude',
            sessionId: VALID_SESSION_ID,
          })
        }
      }
    }
  })

  it('reopens a CLI terminal session as a FreshAgent pane', async () => {
    const user = userEvent.setup()
    const store = createTestStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        status: 'running',
        terminalId: 'term-1',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    }))

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.Terminal}
            data-tab-id="tab-1"
            data-pane-id="pane-1"
          >
            Terminal body
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Terminal body'), keys: '[MouseRight]' })
    await user.click(await screen.findByRole('menuitem', { name: 'Reopen as freshclaude' }))

    await waitFor(() => {
      expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith(
        'claude',
        VALID_SESSION_ID,
        'freshclaude',
        { sessionTypeSource: 'explicit' },
      )
    })
    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
    })

    expect(store.getState().panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionType: 'freshclaude',
        resumeSessionId: VALID_SESSION_ID,
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    })
    expect(store.getState().tabs.tabs[0].sessionMetadataByKey).toEqual({
      [`claude:${VALID_SESSION_ID}`]: {
        sessionType: 'freshclaude',
      },
    })
  })

  it('reopens a FreshAgent pane as its CLI terminal session', async () => {
    const user = userEvent.setup()
    const store = createTestStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        provider: 'claude',
        sessionType: 'freshclaude',
        sessionId: 'runtime-sdk-session-id',
        status: 'idle',
        resumeSessionId: VALID_SESSION_ID,
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    }))

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.FreshAgent}
            data-session-id="runtime-sdk-session-id"
            data-tab-id="tab-1"
            data-pane-id="pane-1"
            data-provider="claude"
            data-session-type="freshclaude"
          >
            FreshAgent body
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('FreshAgent body'), keys: '[MouseRight]' })
    await user.click(await screen.findByRole('menuitem', { name: 'Reopen as Claude CLI' }))

    await waitFor(() => {
      expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith(
        'claude',
        VALID_SESSION_ID,
        'claude',
        { sessionTypeSource: 'explicit' },
      )
    })
    await waitFor(() => {
      expect(wsMocks.send).toHaveBeenCalledWith({
        type: 'freshAgent.kill',
        sessionId: 'runtime-sdk-session-id',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
    })

    expect(store.getState().panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'terminal',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    })
    expect(store.getState().tabs.tabs[0].sessionMetadataByKey).toEqual({
      [`claude:${VALID_SESSION_ID}`]: {
        sessionType: 'claude',
      },
    })
  })

  it('reopens a restored FreshCodex pane when right-clicking transcript body content', async () => {
    const user = userEvent.setup()
    const store = createTestStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        provider: 'codex',
        sessionType: 'freshcodex',
        status: 'idle',
        createRequestId: 'req-freshcodex',
        sessionRef: {
          provider: 'codex',
          sessionId: CODEX_THREAD_ID,
        },
        initialCwd: '/test/project',
      },
    }))

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.FreshAgent}
            data-tab-id="tab-1"
            data-pane-id="pane-1"
            data-provider="codex"
            data-session-type="freshcodex"
          >
            <div data-context="fresh-agent-transcript">FreshCodex transcript body</div>
          </div>
        </ContextMenuProvider>
      </Provider>,
    )

    await user.pointer({ target: screen.getByText('FreshCodex transcript body'), keys: '[MouseRight]' })
    await user.click(await screen.findByRole('menuitem', { name: 'Reopen as Codex CLI' }))

    await waitFor(() => {
      expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith(
        'codex',
        CODEX_THREAD_ID,
        'codex',
        { sessionTypeSource: 'explicit' },
      )
    })

    expect(store.getState().panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'terminal',
        mode: 'codex',
        sessionRef: {
          provider: 'codex',
          sessionId: CODEX_THREAD_ID,
        },
        initialCwd: '/test/project',
      },
    })
    expect(store.getState().tabs.tabs[0].sessionMetadataByKey).toEqual({
      [`codex:${CODEX_THREAD_ID}`]: {
        sessionType: 'codex',
      },
    })
  })

  it('does not kill or replace a pane when reopen metadata persistence fails', async () => {
    const user = userEvent.setup()
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMocks.setSessionMetadata.mockRejectedValueOnce(new Error('persist failed'))
    const store = createTestStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        status: 'running',
        terminalId: 'term-1',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    }))

    try {
      render(
        <Provider store={store}>
          <ContextMenuProvider
            view="terminal"
            onViewChange={() => {}}
            onToggleSidebar={() => {}}
            sidebarCollapsed={false}
          >
            <div
              data-context={ContextIds.Terminal}
              data-tab-id="tab-1"
              data-pane-id="pane-1"
            >
              Terminal body
            </div>
          </ContextMenuProvider>
        </Provider>
      )

      await user.pointer({ target: screen.getByText('Terminal body'), keys: '[MouseRight]' })
      await user.click(await screen.findByRole('menuitem', { name: 'Reopen as freshclaude' }))

      await waitFor(() => {
        expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith(
          'claude',
          VALID_SESSION_ID,
          'freshclaude',
          { sessionTypeSource: 'explicit' },
        )
      })
      await waitFor(() => {
        expect(consoleWarnSpy).toHaveBeenCalled()
      })

      expect(wsMocks.send).not.toHaveBeenCalled()
      expect(store.getState().panes.layouts['tab-1']).toMatchObject({
        type: 'leaf',
        content: {
          kind: 'terminal',
          mode: 'claude',
          status: 'running',
          terminalId: 'term-1',
          sessionRef: {
            provider: 'claude',
            sessionId: VALID_SESSION_ID,
          },
          initialCwd: '/test/project',
        },
      })
    } finally {
      consoleWarnSpy.mockRestore()
    }
  })

  it('does not kill or overwrite a pane that changes while reopen metadata is pending', async () => {
    const user = userEvent.setup()
    const deferred = createDeferred<void>()
    apiMocks.setSessionMetadata.mockReturnValueOnce(deferred.promise)
    const store = createTestStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'claude',
        status: 'running',
        terminalId: 'term-1',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        initialCwd: '/test/project',
      },
    }))

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.Terminal}
            data-tab-id="tab-1"
            data-pane-id="pane-1"
          >
            Terminal body
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Terminal body'), keys: '[MouseRight]' })
    await user.click(await screen.findByRole('menuitem', { name: 'Reopen as freshclaude' }))

    await waitFor(() => {
      expect(apiMocks.setSessionMetadata).toHaveBeenCalledWith(
        'claude',
        VALID_SESSION_ID,
        'freshclaude',
        { sessionTypeSource: 'explicit' },
      )
    })

    store.dispatch(updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'browser',
        url: 'https://example.com',
        devToolsOpen: false,
      },
    }))

    await act(async () => {
      deferred.resolve()
      await deferred.promise
      await Promise.resolve()
    })

    expect(wsMocks.send).not.toHaveBeenCalled()
    expect(store.getState().panes.layouts['tab-1']).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'browser',
        url: 'https://example.com',
      },
    })
    expect(store.getState().tabs.tabs[0].sessionMetadataByKey).toBeUndefined()
  })

  it('uses the sidebar session window for sidebar actions and preserves fresh-agent session type', async () => {
    const user = userEvent.setup()
    const store = createStoreWithSidebarWindowAgentSession()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.SidebarSession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
            data-session-type="freshclaude"
          >
            Sidebar Agent Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Sidebar Agent Session'), keys: '[MouseRight]' })
    await user.click(screen.getByText('Open in this tab'))

    const newLayout = store.getState().panes.layouts['tab-1']
    expect(newLayout?.type).toBe('split')
    if (newLayout?.type === 'split') {
      const newPane = newLayout.children.find(
        (child) => child.type === 'leaf' && child.id !== 'pane-1',
      )
      expect(newPane).toBeDefined()
      if (newPane?.type === 'leaf') {
        expect(newPane.content).toMatchObject({
          kind: 'fresh-agent',
          provider: 'claude',
          sessionType: 'freshclaude',
          resumeSessionId: VALID_SESSION_ID,
          sessionRef: {
            provider: 'claude',
            sessionId: VALID_SESSION_ID,
          },
        })
      }
    }

    expect(store.getState().tabs.tabs[0].sessionMetadataByKey).toEqual({
      [`claude:${VALID_SESSION_ID}`]: {
        sessionType: 'freshclaude',
      },
    })
  })

  it('uses the history session window for history-session actions even when sidebar has a conflicting session snapshot', async () => {
    const user = userEvent.setup()
    const store = createStoreWithOverlappingSessionWindows()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="history"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.HistorySession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
          >
            History Terminal Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('History Terminal Session'), keys: '[MouseRight]' })
    await user.click(screen.getByText('Open session'))

    const openedTab = store.getState().tabs.tabs.find((tab) => tab.id !== 'tab-1')
    expect(openedTab).toMatchObject({
      title: 'History Terminal Session',
      initialCwd: '/shared/project/history',
      sessionRef: {
        provider: 'claude',
        sessionId: VALID_SESSION_ID,
      },
    })
    expect(store.getState().panes.layouts[openedTab!.id]).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'terminal',
        mode: 'claude',
        initialCwd: '/shared/project/history',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
        status: 'creating',
      },
    })
  })

  it('uses the history project window for history-project actions even when sidebar has a conflicting project snapshot', async () => {
    const user = userEvent.setup()
    const store = createStoreWithOverlappingSessionWindows()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="history"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.HistoryProject}
            data-project-path="/shared/project"
          >
            Shared Project
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Shared Project'), keys: '[MouseRight]' })
    await user.click(screen.getByText('Open all sessions in tabs'))
    await user.click(await screen.findByRole('button', { name: 'Open tabs' }))

    const openedTabs = store.getState().tabs.tabs.filter((tab) => tab.id !== 'tab-1')
    expect(openedTabs).toHaveLength(2)
    expect(openedTabs.map((tab) => tab.title)).toEqual([
      'History Terminal Session',
      'History Extra Session',
    ])
  })

  it('copies resume command from sidebar session context menu', async () => {
    const user = userEvent.setup()
    const store = createStoreWithSession()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.SidebarSession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
          >
            Sidebar Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Sidebar Session'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(`claude --resume ${VALID_SESSION_ID}`)
  })

  it('copies session metadata with minute-bucketed open-tab recency', async () => {
    const user = userEvent.setup()
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        extensions: extensionsReducer,
        tabRecency: tabRecencyReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Claude Tab',
              status: 'running',
              mode: 'claude',
              createdAt: 1_740_000_000_000,
              updatedAt: 1_740_000_999_999,
              sessionRef: {
                provider: 'claude',
                sessionId: VALID_SESSION_ID,
              },
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                status: 'running',
                createRequestId: 'req-1',
                sessionRef: {
                  provider: 'claude',
                  sessionId: VALID_SESSION_ID,
                },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: { 'tab-1': { 'pane-1': 'Claude Tab' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
        tabRecency: {
          paneLastInputAt: {
            'pane-1': 1_740_000_080_000,
          },
        },
        sessions: {
          projects: [
            {
              projectPath: '/test/project',
              sessions: [
                {
                  sessionId: VALID_SESSION_ID,
                  provider: 'claude',
                  title: 'Test Session',
                  cwd: '/test/project',
                  createdAt: 1000,
                  lastActivityAt: 2000,
                  messageCount: 5,
                },
              ],
            },
          ],
          expandedProjects: new Set<string>(),
        },
        extensions: {
          entries: defaultCliExtensions,
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.SidebarSession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
          >
            Sidebar Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Sidebar Session'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy full metadata' }))

    const copied = JSON.parse(clipboardMocks.copyText.mock.calls.at(-1)?.[0] ?? '{}')
    expect(copied.tabLastInputAt).toBe(1_740_000_060_000)
    expect(copied.tabLastInputAtIso).toBe(new Date(1_740_000_060_000).toISOString())
  })

  it('copies session metadata when open-tab recency is the zero bucket', async () => {
    const user = userEvent.setup()
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        extensions: extensionsReducer,
        tabRecency: tabRecencyReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Claude Tab',
              status: 'running',
              mode: 'claude',
              createdAt: 0,
              updatedAt: 999_999,
              sessionRef: {
                provider: 'claude',
                sessionId: VALID_SESSION_ID,
              },
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                status: 'running',
                createRequestId: 'req-1',
                sessionRef: {
                  provider: 'claude',
                  sessionId: VALID_SESSION_ID,
                },
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: { 'tab-1': { 'pane-1': 'Claude Tab' } },
          paneTitleSetByUser: {},
          renameRequestTabId: null,
          renameRequestPaneId: null,
          zoomedPane: {},
          refreshRequestsByPane: {},
        },
        tabRecency: {
          paneLastInputAt: {
            'pane-1': 0,
          },
        },
        sessions: {
          projects: [
            {
              projectPath: '/test/project',
              sessions: [
                {
                  sessionId: VALID_SESSION_ID,
                  provider: 'claude',
                  title: 'Test Session',
                  cwd: '/test/project',
                  createdAt: 1000,
                  lastActivityAt: 2000,
                  messageCount: 5,
                },
              ],
            },
          ],
          expandedProjects: new Set<string>(),
        },
        extensions: {
          entries: defaultCliExtensions,
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.SidebarSession}
            data-session-id={VALID_SESSION_ID}
            data-provider="claude"
          >
            Sidebar Session
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Sidebar Session'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy full metadata' }))

    const copied = JSON.parse(clipboardMocks.copyText.mock.calls.at(-1)?.[0] ?? '{}')
    expect(copied.tabLastInputAt).toBe(0)
    expect(copied.tabLastInputAtIso).toBe(new Date(0).toISOString())
  })

  it('copies resume command from terminal pane context menu for codex pane', async () => {
    const user = userEvent.setup()
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        extensions: extensionsReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Codex',
              status: 'running',
              mode: 'codex',
              createdAt: 1,
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        extensions: {
          entries: defaultCliExtensions,
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'codex',
                status: 'running',
                resumeSessionId: 'codex-session-123',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
        },
        sessions: {
          projects: [],
          expandedProjects: new Set<string>(),
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
            Codex Pane
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Codex Pane'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('codex resume codex-session-123')
  })

  it('copies resume command from pane header context menu for cli panes', async () => {
    const user = userEvent.setup()
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        extensions: extensionsReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Claude',
              status: 'running',
              mode: 'claude',
              createdAt: 1,
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        extensions: {
          entries: defaultCliExtensions,
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                status: 'running',
                resumeSessionId: VALID_SESSION_ID,
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
        },
        sessions: {
          projects: [],
          expandedProjects: new Set<string>(),
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Pane} data-tab-id="tab-1" data-pane-id="pane-1">
            Pane Header
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Pane Header'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(`claude --resume ${VALID_SESSION_ID}`)
  })

  it('does not show resume command on shell pane header context menu', async () => {
    const user = userEvent.setup()
    const store = createStoreWithSession()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Pane} data-tab-id="tab-1" data-pane-id="pane-1">
            Shell Pane Header
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Shell Pane Header'), keys: '[MouseRight]' })
    expect(screen.queryByRole('menuitem', { name: 'Copy resume command' })).toBeNull()
  })

  it('does not show resume command on shell pane context menu', async () => {
    const user = userEvent.setup()
    const store = createStoreWithSession()
    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
            Shell Pane
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Shell Pane'), keys: '[MouseRight]' })
    expect(screen.queryByRole('menuitem', { name: 'Copy resume command' })).toBeNull()
  })

  it('shows resume command on tab context menu only when tab has a single CLI pane', async () => {
    const user = userEvent.setup()
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
        extensions: extensionsReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Claude',
              status: 'running',
              mode: 'claude',
              createdAt: 1,
            },
            {
              id: 'tab-2',
              createRequestId: 'tab-2',
              title: 'Split',
              status: 'running',
              mode: 'shell',
              createdAt: 2,
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                status: 'running',
                resumeSessionId: VALID_SESSION_ID,
              },
            },
            'tab-2': {
              type: 'split',
              id: 'split-1',
              direction: 'horizontal',
              sizes: [0.5, 0.5],
              children: [
                {
                  type: 'leaf',
                  id: 'pane-2a',
                  content: { kind: 'terminal', mode: 'claude', status: 'running', resumeSessionId: VALID_SESSION_ID },
                },
                {
                  type: 'leaf',
                  id: 'pane-2b',
                  content: { kind: 'terminal', mode: 'shell', status: 'running' },
                },
              ],
            },
          },
          activePane: { 'tab-1': 'pane-1', 'tab-2': 'pane-2a' },
          paneTitles: {},
        },
        sessions: {
          projects: [],
          expandedProjects: new Set<string>(),
        },
        extensions: {
          entries: defaultCliExtensions,
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div>
            <div data-context={ContextIds.Tab} data-tab-id="tab-1">Single CLI Tab</div>
            <div data-context={ContextIds.Tab} data-tab-id="tab-2">Split Tab</div>
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Single CLI Tab'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Copy resume command' }))
    expect(clipboardMocks.copyText).toHaveBeenCalledWith(`claude --resume ${VALID_SESSION_ID}`)

    await user.pointer({ target: screen.getByText('Split Tab'), keys: '[MouseRight]' })
    expect(screen.queryByRole('menuitem', { name: 'Copy resume command' })).toBeNull()
  })

  describe('platform-specific tab-add menu', () => {
    it('shows Shell option on non-Windows platforms', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <div data-context={ContextIds.TabAdd}>Add Tab</div>,
        { platform: 'darwin' }
      )

      await user.pointer({ target: screen.getByText('Add Tab'), keys: '[MouseRight]' })

      expect(screen.getByText('New Shell tab')).toBeInTheDocument()
      expect(screen.queryByText('New CMD tab')).not.toBeInTheDocument()
      expect(screen.queryByText('New PowerShell tab')).not.toBeInTheDocument()
      expect(screen.queryByText('New WSL tab')).not.toBeInTheDocument()
    })

    it('shows Windows shell options on win32 platform', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <div data-context={ContextIds.TabAdd}>Add Tab</div>,
        { platform: 'win32' }
      )

      await user.pointer({ target: screen.getByText('Add Tab'), keys: '[MouseRight]' })

      expect(screen.getByText('New CMD tab')).toBeInTheDocument()
      expect(screen.getByText('New PowerShell tab')).toBeInTheDocument()
      expect(screen.getByText('New WSL tab')).toBeInTheDocument()
      expect(screen.queryByText('New Shell tab')).not.toBeInTheDocument()
    })

    it('shows Windows shell options on wsl platform', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <div data-context={ContextIds.TabAdd}>Add Tab</div>,
        { platform: 'wsl' }
      )

      await user.pointer({ target: screen.getByText('Add Tab'), keys: '[MouseRight]' })

      expect(screen.getByText('New CMD tab')).toBeInTheDocument()
      expect(screen.getByText('New PowerShell tab')).toBeInTheDocument()
      expect(screen.getByText('New WSL tab')).toBeInTheDocument()
      expect(screen.queryByText('New Shell tab')).not.toBeInTheDocument()
    })

    it('shows Shell option when platform is null', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <div data-context={ContextIds.TabAdd}>Add Tab</div>,
        { platform: null }
      )

      await user.pointer({ target: screen.getByText('Add Tab'), keys: '[MouseRight]' })

      expect(screen.getByText('New Shell tab')).toBeInTheDocument()
      expect(screen.queryByText('New CMD tab')).not.toBeInTheDocument()
    })

    it('always shows Browser and Editor options', async () => {
      const user = userEvent.setup()
      renderWithProvider(
        <div data-context={ContextIds.TabAdd}>Add Tab</div>,
        { platform: 'win32' }
      )

      await user.pointer({ target: screen.getByText('Add Tab'), keys: '[MouseRight]' })

      expect(screen.getByText('New Browser tab')).toBeInTheDocument()
      expect(screen.getByText('New Editor tab')).toBeInTheDocument()
    })
  })

  it('renders Copy, Paste, and Select all as the first terminal menu section with icons', async () => {
    const user = userEvent.setup()
    const store = createStoreWithTerminalPane()

    render(
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
            Terminal Content
          </div>
        </ContextMenuProvider>
      </Provider>
    )

    await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })

    const menu = screen.getByRole('menu')
    const children = Array.from(menu.children)
    expect(
      children.slice(0, 4).map((node) =>
        node.getAttribute('role') === 'menuitem'
          ? node.textContent?.replace(/\s+/g, ' ').trim()
          : node.getAttribute('role'),
      ),
    ).toEqual(['Copy', 'Paste', 'Select all', 'separator'])

    for (const node of children.slice(0, 3)) {
      expect(node.querySelector('svg')).not.toBeNull()
    }
  })

  describe('Replace pane', () => {
    it('detaches terminal and replaces pane with picker via context menu', async () => {
      const user = userEvent.setup()
      wsMocks.send.mockClear()

      const store = createStoreWithTerminalPane()

      render(
        <Provider store={store}>
          <ContextMenuProvider
            view="terminal"
            onViewChange={() => {}}
            onToggleSidebar={() => {}}
            sidebarCollapsed={false}
          >
            <div data-context={ContextIds.Terminal} data-tab-id="tab-1" data-pane-id="pane-1">
              Terminal Content
            </div>
          </ContextMenuProvider>
        </Provider>
      )

      await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })
      expect(screen.getByRole('menu')).toBeInTheDocument()

      await user.click(screen.getByRole('menuitem', { name: 'Replace pane' }))

      // Verify terminal.detach was sent via the actual handler
      expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId: 'term-1' })

      // Verify pane content is now picker
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout.type).toBe('leaf')
      if (layout.type === 'leaf') {
        expect(layout.content).toEqual({ kind: 'picker' })
      }

      // Verify pane content no longer has the old terminal
      // (tab.terminalId was removed; terminal ownership is in pane content only)
    })

  })
})

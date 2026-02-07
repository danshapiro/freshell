import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'

import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import codingCliReducer from '@/store/codingCliSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import TabBar from '@/components/TabBar'

const VALID_SESSION_ID = '33333333-3333-3333-3333-333333333333'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    setHelloExtensionProvider: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

function createTestStore(options?: { platform?: string | null }) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      sessions: sessionsReducer,
      connection: connectionReducer,
      codingCli: codingCliReducer,
      settings: settingsReducer,
      sessionActivity: sessionActivityReducer,
      connection: connectionReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 'tab-1',
            title: 'Tab One',
            createdAt: 1,
          },
          {
            id: 'tab-2',
            title: 'Tab Two',
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
      },
      sessions: {
        projects: [],
        expandedProjects: new Set<string>(),
      },
      connection: {
        status: 'ready',
        platform: options?.platform ?? null,
      },
      codingCli: {
        sessions: {},
        pendingRequests: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      sessionActivity: {
        sessions: {},
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
      codingCli: codingCliReducer,
      settings: settingsReducer,
      sessionActivity: sessionActivityReducer,
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
                updatedAt: 2000,
                messageCount: 5,
              },
            ],
          },
        ],
        expandedProjects: new Set<string>(),
      },
      codingCli: {
        sessions: {},
        pendingRequests: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      sessionActivity: {
        sessions: {},
      },
    },
  })
}

describe('ContextMenuProvider', () => {
  afterEach(() => cleanup())
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
          expect(newPane.content.resumeSessionId).toBe(VALID_SESSION_ID)
        }
      }
    }
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
})

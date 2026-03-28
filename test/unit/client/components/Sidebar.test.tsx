import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer, {
  commitSessionWindowReplacement,
  setSessionWindowLoading,
} from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import extensionsReducer from '@/store/extensionsSlice'
import codexActivityReducer, { type CodexActivityState } from '@/store/codexActivitySlice'
import terminalDirectoryReducer, { setTerminalDirectoryWindowData } from '@/store/terminalDirectorySlice'
import type { ProjectGroup, BackgroundTerminal, TabMode } from '@/store/types'
import type { PaneNode } from '@/store/paneTypes'
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

// Mock the WebSocket client
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockFetchSidebarSessionsSnapshot = vi.fn()
const mockGetTerminalDirectoryPage = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

// Mock the searchSessions API
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: (...args: any[]) => mockFetchSidebarSessionsSnapshot(...args),
    getTerminalDirectoryPage: (...args: any[]) => mockGetTerminalDirectoryPage(...args),
    searchSessions: vi.fn(),
  }
})

import { searchSessions as mockSearchSessions } from '@/lib/api'

const sessionId = (label: string) => {
  const hex = createHash('md5').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createTestStore(options?: {
  projects?: ProjectGroup[]
  sessions?: Record<string, unknown>
  terminals?: BackgroundTerminal[]
  tabs?: Array<{
    id: string
    terminalId?: string
    resumeSessionId?: string
    mode?: string
    lastInputAt?: number
    status?: 'running' | 'creating' | 'exited' | 'error'
  }>
  panes?: {
    layouts: Record<string, PaneNode>
    activePane: Record<string, string>
    paneTitles?: Record<string, Record<string, string>>
    paneTitleSetByUser?: Record<string, Record<string, boolean>>
  }
  activeTabId?: string
  serverInstanceId?: string
  sortMode?: 'recency' | 'activity' | 'project'
  showProjectBadges?: boolean
  sessionOpenMode?: 'tab' | 'split'
  sessionActivity?: Record<string, number>
  codexActivity?: Partial<CodexActivityState>
}) {
  const projects = (options?.projects ?? []).map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  const inferredLayouts: Record<string, PaneNode> = {}
  const inferredActivePane: Record<string, string> = {}
  if (!options?.panes) {
    for (const tab of options?.tabs ?? []) {
      const paneId = `pane-${tab.id}`
      const mode = (tab.mode as TabMode | undefined) || (tab.resumeSessionId ? 'claude' : 'shell')
      inferredLayouts[tab.id] = {
        type: 'leaf',
        id: paneId,
        content: {
          kind: 'terminal',
          mode,
          createRequestId: `req-${tab.id}`,
          status: tab.status || 'running',
          terminalId: tab.terminalId,
          resumeSessionId: tab.resumeSessionId,
        },
      }
      inferredActivePane[tab.id] = paneId
    }
  }

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      extensions: extensionsReducer,
      codexActivity: codexActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
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
          sidebar: {
            ...defaultSettings.sidebar,
            sortMode: options?.sortMode ?? 'activity',
            showProjectBadges: options?.showProjectBadges ?? true,
            hideEmptySessions: false,
          },
          panes: {
            ...defaultSettings.panes,
            sessionOpenMode: options?.sessionOpenMode ?? defaultSettings.panes.sessionOpenMode,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: options?.tabs ?? [],
        activeTabId: options?.activeTabId ?? null,
      },
      panes: options?.panes ?? {
        layouts: inferredLayouts,
        activePane: inferredActivePane,
        paneTitles: {},
        paneTitleSetByUser: {},
      },
      sessions: {
        projects,
        expandedProjects: new Set<string>(),
        isLoading: false,
        error: null,
        ...options?.sessions,
      },
      connection: {
        status: 'connected',
        error: null,
        serverInstanceId: options?.serverInstanceId,
      },
      sessionActivity: {
        sessions: options?.sessionActivity ?? {},
      },
      extensions: {
        entries: defaultCliExtensions,
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
        ...(options?.codexActivity ?? {}),
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: options?.terminals ?? [],
            nextCursor: null,
            revision: 1,
          },
        },
        searches: {},
      },
    },
  })
}

function collectLeafPanes(node: PaneNode): PaneNode[] {
  if (node.type === 'leaf') return [node]
  return [...collectLeafPanes(node.children[0]), ...collectLeafPanes(node.children[1])]
}

function renderSidebar(
  store: ReturnType<typeof createTestStore>,
  terminals: BackgroundTerminal[] = []
) {
  const onNavigate = vi.fn()
  if (terminals.length > 0) {
    store.dispatch(setTerminalDirectoryWindowData({
      surface: 'sidebar',
      items: terminals,
      nextCursor: null,
      revision: 1,
    }))
  }

  const result = render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={onNavigate} />
    </Provider>
  )

  return { ...result, onNavigate }
}

function setSidebarListGeometry(
  node: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number; scrollTop: number }
) {
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: geometry.clientHeight })
  Object.defineProperty(node, 'scrollHeight', { configurable: true, value: geometry.scrollHeight })
  Object.defineProperty(node, 'scrollTop', { configurable: true, value: geometry.scrollTop, writable: true })
}

function triggerNearBottomScroll(
  node: HTMLElement,
  geometry: { clientHeight: number; scrollHeight: number }
) {
  setSidebarListGeometry(node, {
    clientHeight: geometry.clientHeight,
    scrollHeight: geometry.scrollHeight,
    scrollTop: geometry.scrollHeight - geometry.clientHeight,
  })
  fireEvent.scroll(node)
}

function getSidebarSessionOrder(labels: string[]): string[] {
  const list = screen.getByTestId('sidebar-session-list')
  return Array.from(list.querySelectorAll('button'))
    .map((button) => labels.find((label) => button.textContent?.includes(label)))
    .filter((label): label is string => Boolean(label))
}

describe('Sidebar Component - Session-Centric Display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.mocked(mockSearchSessions).mockReset()
    mockFetchSidebarSessionsSnapshot.mockReset()
    mockFetchSidebarSessionsSnapshot.mockResolvedValue({ projects: [] })
    mockGetTerminalDirectoryPage.mockReset()
    mockGetTerminalDirectoryPage.mockResolvedValue({
      items: [],
      nextCursor: null,
      revision: 1,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  describe('displays sessions only (not terminals)', () => {
    it('keeps restored open sessions visible without issuing sidebar directory fetches on mount', () => {
      const store = createTestStore({
        tabs: [{
          id: 'tab-restored',
          title: 'Restored Session',
          mode: 'codex',
          resumeSessionId: 'codex-restored',
          createdAt: 2_000,
        }],
        panes: {
          layouts: {
            'tab-restored': {
              type: 'leaf',
              id: 'pane-restored',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-restored',
                status: 'running',
                resumeSessionId: 'codex-restored',
                cwd: '/tmp/restored-project',
              },
            },
          },
          activePane: {
            'tab-restored': 'pane-restored',
          },
          paneTitles: {
            'tab-restored': {
              'pane-restored': 'Restored Session',
            },
          },
        },
      })

      renderSidebar(store)

      expect(screen.getAllByText('Restored Session').length).toBeGreaterThan(0)
      expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
      expect(mockGetTerminalDirectoryPage).not.toHaveBeenCalled()
    })

    it('shows sessions from projects', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project-a',
          color: '#ff0000',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/project-a',
              lastActivityAt: Date.now() - 1000,
              title: 'Fix authentication bug',
              cwd: '/home/user/project-a',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, [])

      act(() => {
        vi.advanceTimersByTime(100)
      })

      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument()
    })

    it('does not show shell-only terminals in sidebar', async () => {
      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'term-1',
          title: 'Shell',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'shell',
          cwd: '/home/user',
        },
      ]

      const store = createTestStore({ projects: [] })
      renderSidebar(store, terminals)

      vi.advanceTimersByTime(100)

      // Shell terminal should not appear - only "No sessions yet" message
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      expect(screen.queryByText('Shell')).not.toBeInTheDocument()
    })

    it('shows session title, not terminal title', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-abc'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Implement user authentication',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'term-1',
          title: 'Claude', // Generic terminal title
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'claude',
          resumeSessionId: sessionId('session-abc'),
          cwd: '/home/user/project',
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, terminals)

      vi.advanceTimersByTime(100)

      // Should show session title, not "Claude"
      expect(screen.getByText('Implement user authentication')).toBeInTheDocument()
    })

    it('shows tooltips when hovering anywhere on a session row (not just the text)', () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: 'session-abc',
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Implement user authentication',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, [])

      act(() => {
        vi.advanceTimersByTime(100)
      })

      const title = screen.getByText('Implement user authentication')
      const rowButton = title.closest('button')
      expect(rowButton).toBeTruthy()

      fireEvent.mouseEnter(rowButton!)
      expect(screen.getByText('Claude CLI: Implement user authentication')).toBeInTheDocument()

      fireEvent.mouseLeave(rowButton!)
      expect(screen.queryByText('Claude CLI: Implement user authentication')).not.toBeInTheDocument()
    })

    it('renders freshclaude icon and label for sessions with sessionType freshclaude', () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: 'session-fc',
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Freshclaude session',
              cwd: '/home/user/project',
              sessionType: 'freshclaude',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, [])

      act(() => {
        vi.advanceTimersByTime(100)
      })

      const title = screen.getByText('Freshclaude session')
      const rowButton = title.closest('button')
      expect(rowButton).toBeTruthy()

      // Tooltip should show "Freshclaude" label (not "Claude CLI")
      fireEvent.mouseEnter(rowButton!)
      expect(screen.getByText('Freshclaude: Freshclaude session')).toBeInTheDocument()
      // Should NOT show "Claude CLI" label
      expect(screen.queryByText('Claude CLI: Freshclaude session')).not.toBeInTheDocument()

      // The icon SVG should be the FreshclaudeIcon (viewBox 0 0 1024 1024), not ClaudeIcon
      const svg = rowButton!.querySelector('svg')
      expect(svg).toBeTruthy()
      expect(svg!.getAttribute('viewBox')).toBe('0 0 1024 1024')
    })
  })

  describe('running session decoration', () => {
    it('marks session as running when matching terminal exists', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-running'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Active work session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'term-active',
          title: 'Claude',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'claude',
          resumeSessionId: sessionId('session-running'),
          cwd: '/home/user/project',
        },
      ]

      const store = createTestStore({ projects, sortMode: 'activity' })
      renderSidebar(store, terminals)

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      expect(screen.queryByText(/^Running$/)).not.toBeInTheDocument()
      expect(screen.getByText('Active work session')).toBeInTheDocument()
    })

    it('does not mark session as running when terminal is exited', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Completed session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'term-exited',
          title: 'Claude',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'exited', // Exited, not running
          hasClients: false,
          mode: 'claude',
          resumeSessionId: sessionId('session-1'),
          cwd: '/home/user/project',
        },
      ]

      const store = createTestStore({ projects, sortMode: 'activity' })
      renderSidebar(store, terminals)

      vi.advanceTimersByTime(100)

      // "Running" section should not appear since no sessions are running
      expect(screen.queryByText('Running')).not.toBeInTheDocument()
      expect(screen.getByText('Completed session')).toBeInTheDocument()
    })

    it('does not mark session as running when terminal mode is shell', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Session with shell terminal',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'term-shell',
          title: 'Shell',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'shell', // Shell mode, not claude
          resumeSessionId: sessionId('session-1'),
          cwd: '/home/user/project',
        },
      ]

      const store = createTestStore({ projects, sortMode: 'activity' })
      renderSidebar(store, terminals)

      vi.advanceTimersByTime(100)

      // "Running" section should not appear
      expect(screen.queryByText('Running')).not.toBeInTheDocument()
    })
  })

  describe('pane-based session tracking', () => {
    it('treats pane resumeSessionId as open and active even when tab has none', async () => {
      const session = sessionId('session-pane-open')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: session,
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Pane-owned session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          mode: 'claude' as const,
        },
      ]

      const panes = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              resumeSessionId: session,
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
        },
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs, panes, activeTabId: 'tab-1' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const button = screen.getByText('Pane-owned session').closest('button')
      expect(button).not.toBeNull()
      expect(button).toHaveAttribute('data-has-tab', 'true')
      expect(button).toHaveClass('bg-muted')
    })

    it('marks non-UUID Claude pane resumeSessionId as hasTab (named resume)', async () => {
      const namedResume = 'not-a-uuid'
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: namedResume,
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Named resume session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          mode: 'claude' as const,
        },
      ]

      const panes = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              resumeSessionId: namedResume,
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
        },
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs, panes, activeTabId: 'tab-1' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const button = screen.getByText('Named resume session').closest('button')
      expect(button).not.toBeNull()
      // Non-UUID Claude resume names are now recognized as valid tabs
      expect(button).toHaveAttribute('data-has-tab', 'true')
    })
  })

  describe('activity sort mode', () => {
    it('shows sessions with tabs above sessions without tabs', async () => {
      const now = Date.now()
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-no-tab'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Session without tab',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-with-tab'),
              projectPath: '/home/user/project',
              lastActivityAt: now - 10000,
              title: 'Session with tab',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          resumeSessionId: sessionId('session-with-tab'),
          mode: 'claude',
          lastInputAt: now - 5000,
        },
      ]

      const store = createTestStore({ projects, tabs, sortMode: 'activity' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.includes('Session')
      )

      expect(buttons[0]).toHaveTextContent('Session with tab')
      expect(buttons[1]).toHaveTextContent('Session without tab')
    })

    it('sorts tabbed sessions by ratcheted activity', async () => {
      const now = Date.now()
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-old-input'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Old input session',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-recent-input'),
              projectPath: '/home/user/project',
              lastActivityAt: now - 10000,
              title: 'Recent input session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          resumeSessionId: sessionId('session-old-input'),
          mode: 'claude',
        },
        {
          id: 'tab-2',
          resumeSessionId: sessionId('session-recent-input'),
          mode: 'claude',
        },
      ]

      const sessionActivity = {
        [`claude:${sessionId('session-old-input')}`]: now - 60000,
        [`claude:${sessionId('session-recent-input')}`]: now - 1000,
      }

      const store = createTestStore({ projects, tabs, sortMode: 'activity', sessionActivity })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.includes('session')
      )

      expect(buttons[0]).toHaveTextContent('Recent input session')
      expect(buttons[1]).toHaveTextContent('Old input session')
    })

    it('uses session timestamp for tabbed sessions without ratcheted activity', async () => {
      const now = Date.now()
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-with-input'),
              projectPath: '/home/user/project',
              lastActivityAt: now - 60000,
              title: 'Has input timestamp',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-no-input'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'No input timestamp',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          resumeSessionId: sessionId('session-with-input'),
          mode: 'claude',
        },
        {
          id: 'tab-2',
          resumeSessionId: sessionId('session-no-input'),
          mode: 'claude',
        },
      ]

      const store = createTestStore({ projects, tabs, sortMode: 'activity' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.includes('timestamp')
      )

      expect(buttons[0]).toHaveTextContent('No input timestamp')
      expect(buttons[1]).toHaveTextContent('Has input timestamp')
    })

    it('uses ratcheted sessionActivity for closed tabs (preserves position)', async () => {
      const now = Date.now()
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-was-active'),
              projectPath: '/home/user/project',
              lastActivityAt: now - 60000,
              title: 'Was active session',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-never-active'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Never active session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const sessionActivity = {
        [`claude:${sessionId('session-was-active')}`]: now - 1000,
      }

      const store = createTestStore({
        projects,
        tabs: [],
        sortMode: 'activity',
        sessionActivity,
      })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.includes('session')
      )

      expect(buttons[0]).toHaveTextContent('Was active session')
      expect(buttons[1]).toHaveTextContent('Never active session')
    })

    it('shows green indicator for sessions with tabs, muted for others', async () => {
      const now = Date.now()
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-with-tab'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Tabbed session',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-no-tab'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'No tab session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          resumeSessionId: sessionId('session-with-tab'),
          mode: 'claude',
        },
      ]

      const store = createTestStore({ projects, tabs, sortMode: 'activity' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const tabbedButton = screen.getByRole('button', { name: /Tabbed session/ })
      expect(tabbedButton.querySelector('.text-success')).toBeTruthy()
      expect(tabbedButton.querySelector('svg.text-muted-foreground')).toBeFalsy()

      const noTabButton = screen.getByRole('button', { name: /No tab session/ })
      expect(noTabButton.querySelector('svg.text-muted-foreground')).toBeTruthy()
      expect(noTabButton.querySelector('.text-success')).toBeFalsy()
    })

    it('shows blue indicator for busy codex sessions instead of green', async () => {
      const now = Date.now()
      const terminalId = 'term-busy-codex'
      const busySessionId = sessionId('busy-session')
      const idleSessionId = sessionId('idle-session')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: busySessionId,
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Busy codex session',
              cwd: '/home/user/project',
              provider: 'codex',
            },
            {
              sessionId: idleSessionId,
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Idle session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          terminalId,
          resumeSessionId: busySessionId,
          mode: 'codex',
        },
        {
          id: 'tab-2',
          resumeSessionId: idleSessionId,
          mode: 'claude',
        },
      ]

      // Background terminal needed so the selector can map session→terminalId
      const terminals: BackgroundTerminal[] = [
        {
          terminalId,
          title: 'Codex',
          createdAt: now,
          status: 'running',
          hasClients: true,
          mode: 'codex',
          resumeSessionId: busySessionId,
        },
      ]

      const store = createTestStore({
        projects,
        tabs,
        sortMode: 'activity',
        codexActivity: {
          byTerminalId: {
            [terminalId]: {
              terminalId,
              sessionId: 'session-codex',
              phase: 'busy',
              lastActivityAt: 10,
            },
          },
        },
      })
      renderSidebar(store, terminals)

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      // The busy session should have a blue icon
      const busyButton = screen.getByRole('button', { name: /Busy codex session/ })
      expect(busyButton.querySelector('.text-blue-500')).toBeTruthy()
      expect(busyButton.querySelector('.text-success')).toBeFalsy()

      // The idle session with a tab should still be green, not blue
      const idleButton = screen.getByRole('button', { name: /Idle session/ })
      expect(idleButton.querySelector('.text-success')).toBeTruthy()
      expect(idleButton.querySelector('.text-blue-500')).toBeFalsy()
    })

    it('shows blue when a non-primary terminal for the session is busy', async () => {
      const now = Date.now()
      const oldTerminalId = 'term-old'
      const newTerminalId = 'term-new'
      const sid = sessionId('multi-terminal')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sid,
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Multi terminal',
              cwd: '/home/user/project',
              provider: 'codex',
            },
          ],
        },
      ]

      const tabs = [
        { id: 'tab-1', terminalId: newTerminalId, resumeSessionId: sid, mode: 'codex' },
      ]

      // Two background terminals for the same session — old one is primary (earlier createdAt)
      const terminals: BackgroundTerminal[] = [
        {
          terminalId: oldTerminalId,
          title: 'Codex Old',
          createdAt: now - 5000,
          status: 'running',
          hasClients: false,
          mode: 'codex',
          resumeSessionId: sid,
        },
        {
          terminalId: newTerminalId,
          title: 'Codex New',
          createdAt: now,
          status: 'running',
          hasClients: true,
          mode: 'codex',
          resumeSessionId: sid,
        },
      ]

      const store = createTestStore({
        projects,
        tabs,
        sortMode: 'activity',
        codexActivity: {
          byTerminalId: {
            // Only the newer terminal is busy — not the primary one
            [newTerminalId]: {
              terminalId: newTerminalId,
              sessionId: 'sess',
              phase: 'busy',
              lastActivityAt: 10,
            },
          },
        },
      })
      renderSidebar(store, terminals)

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const button = screen.getByRole('button', { name: /Multi terminal/ })
      expect(button.querySelector('.text-blue-500')).toBeTruthy()
      expect(button.querySelector('.text-success')).toBeFalsy()
    })
  })

  describe('session filtering', () => {
    it('filters sessions by title via server-side search', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [
          {
            sessionId: sessionId('session-1'),
            provider: 'claude',
            projectPath: '/home/user/project',
            matchedIn: 'title' as const,
            lastActivityAt: Date.now(),
            title: 'Fix authentication bug',
            cwd: '/home/user/project',
          },
        ],
        tier: 'title',
        query: 'auth',
        totalScanned: 2,
      })

      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Fix authentication bug',
              cwd: '/home/user/project',
            },
            {
              sessionId: sessionId('session-2'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now() - 1000,
              title: 'Add user profile page',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      // Both sessions visible initially
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument()
      expect(screen.getByText('Add user profile page')).toBeInTheDocument()

      // Type in search
      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'auth' } })

      // Wait for debounce + server response
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      // Only matching session visible (server-side filtering)
      expect(screen.getByText('Fix authentication bug')).toBeInTheDocument()
      expect(screen.queryByText('Add user profile page')).not.toBeInTheDocument()
    })

    it('filters sessions via server-side search by project path', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [
          {
            sessionId: sessionId('session-1'),
            provider: 'claude',
            projectPath: '/home/user/project-alpha',
            matchedIn: 'title' as const,
            lastActivityAt: Date.now(),
            title: 'Alpha work',
            cwd: '/home/user/project-alpha',
          },
        ],
        tier: 'title',
        query: 'alpha',
        totalScanned: 2,
      })

      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project-alpha',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/project-alpha',
              lastActivityAt: Date.now(),
              title: 'Alpha work',
              cwd: '/home/user/project-alpha',
            },
          ],
        },
        {
          projectPath: '/home/user/project-beta',
          sessions: [
            {
              sessionId: sessionId('session-2'),
              projectPath: '/home/user/project-beta',
              lastActivityAt: Date.now(),
              title: 'Beta work',
              cwd: '/home/user/project-beta',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      const searchInput = screen.getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'alpha' } })

      // Wait for debounce + server response
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      expect(screen.getByText('Alpha work')).toBeInTheDocument()
      expect(screen.queryByText('Beta work')).not.toBeInTheDocument()
    })
  })

  describe('session click handling', () => {
    it('resumes non-running session on click', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-to-resume'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Session to resume',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const store = createTestStore({ projects })
      const { onNavigate } = renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      const sessionButton = screen.getByText('Session to resume').closest('button')
      fireEvent.click(sessionButton!)

      // Should navigate to terminal view
      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Check store has new tab with resumeSessionId
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)
      expect(state.tabs.tabs[0].resumeSessionId).toBe(sessionId('session-to-resume'))
      expect(state.tabs.tabs[0].mode).toBe('claude')
    })

    it('switches to existing tab when clicking non-running session that is already open', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-already-open'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Already open session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const targetSessionId = sessionId('session-already-open')

      // Pre-existing tab without resumeSessionId; pane content owns the session
      const existingTabs = [
        {
          id: 'existing-tab-id',
          mode: 'claude' as const,
        },
      ]

      const panes = {
        layouts: {
          'existing-tab-id': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-1',
              status: 'running',
              resumeSessionId: targetSessionId,
            },
          },
        },
        activePane: {
          'existing-tab-id': 'pane-1',
        },
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs: existingTabs, panes, activeTabId: null })
      const { onNavigate } = renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      const sessionButton = screen.getByText('Already open session').closest('button')
      fireEvent.click(sessionButton!)

      // Should navigate to terminal view
      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should NOT create a new tab - should switch to existing
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)
      expect(state.tabs.activeTabId).toBe('existing-tab-id')
    })

    it('switches to existing tab when clicking running session that has a tab', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-running'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Running session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'running-terminal-id',
          title: 'Claude',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'claude',
          resumeSessionId: sessionId('session-running'),
          cwd: '/home/user/project',
        },
      ]

      // Pre-existing tab with this terminalId
      const existingTabs = [
        {
          id: 'existing-tab-for-terminal',
          terminalId: 'running-terminal-id',
          mode: 'claude' as const,
          resumeSessionId: sessionId('session-running'),
        },
      ]

      const panes = {
        layouts: {
          'existing-tab-for-terminal': {
            type: 'leaf',
            id: 'pane-running',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-running',
              status: 'running',
              terminalId: 'running-terminal-id',
              resumeSessionId: sessionId('session-running'),
            },
          },
        },
        activePane: {
          'existing-tab-for-terminal': 'pane-running',
        },
        paneTitles: {},
      }

      const store = createTestStore({
        projects,
        tabs: existingTabs,
        panes,
        activeTabId: null,
        sortMode: 'activity',
      })
      const { onNavigate } = renderSidebar(store, terminals)

      // Advance timers to process the mock response and wait for state update
      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('Running session').closest('button')
      fireEvent.click(sessionButton!)

      // Should navigate to terminal view
      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should NOT create a new tab - should switch to existing
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)
      expect(state.tabs.activeTabId).toBe('existing-tab-for-terminal')
    })

    it('creates new tab to attach when clicking running session without existing tab', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-running-no-tab'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Running without tab',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const terminals: BackgroundTerminal[] = [
        {
          terminalId: 'orphan-terminal-id',
          title: 'Claude',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          status: 'running',
          hasClients: false,
          mode: 'claude',
          resumeSessionId: sessionId('session-running-no-tab'),
          cwd: '/home/user/project',
        },
      ]

      const store = createTestStore({ projects, tabs: [], activeTabId: null, sortMode: 'activity' })
      const { onNavigate } = renderSidebar(store, terminals)

      // Advance timers to process the mock response and wait for state update
      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('Running without tab').closest('button')
      fireEvent.click(sessionButton!)

      // Should navigate to terminal view
      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should create a new tab with the terminalId to attach
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)
      expect(state.tabs.tabs[0].terminalId).toBe('orphan-terminal-id')
      expect(state.tabs.tabs[0].resumeSessionId).toBe(sessionId('session-running-no-tab'))
      expect(state.tabs.tabs[0].mode).toBe('claude')
    })
  })

  describe('empty state', () => {
    it('shows empty message when no sessions exist', async () => {
      const store = createTestStore({ projects: [] })
      renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('No sessions yet')).toBeInTheDocument()
    })
  })

  describe('project badges', () => {
    it('shows project name as subtitle when showProjectBadges is true', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/my-awesome-project',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/my-awesome-project',
              lastActivityAt: Date.now(),
              title: 'Session title',
              cwd: '/home/user/my-awesome-project',
            },
          ],
        },
      ]

      const store = createTestStore({ projects, showProjectBadges: true })
      renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      expect(screen.getByText('my-awesome-project')).toBeInTheDocument()
    })

    it('hides project name when showProjectBadges is false', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/my-awesome-project',
          sessions: [
            {
              sessionId: sessionId('session-1'),
              projectPath: '/home/user/my-awesome-project',
              lastActivityAt: Date.now(),
              title: 'Session title',
              cwd: '/home/user/my-awesome-project',
            },
          ],
        },
      ]

      const store = createTestStore({ projects, showProjectBadges: false })
      renderSidebar(store, [])

      vi.advanceTimersByTime(100)

      expect(screen.queryByText('my-awesome-project')).not.toBeInTheDocument()
    })
  })

  describe('dynamic width', () => {
    it('applies width from prop', async () => {
      const store = createTestStore({ projects: [] })
      const { container } = render(
        <Provider store={store}>
          <Sidebar view="terminal" onNavigate={vi.fn()} width={350} />
        </Provider>
      )

      vi.advanceTimersByTime(100)

      const sidebar = container.firstChild as HTMLElement
      expect(sidebar.style.width).toBe('350px')
    })

    it('uses default width of 288px when no width prop provided', async () => {
      const store = createTestStore({ projects: [] })
      const { container } = render(
        <Provider store={store}>
          <Sidebar view="terminal" onNavigate={vi.fn()} />
        </Provider>
      )

      vi.advanceTimersByTime(100)

      const sidebar = container.firstChild as HTMLElement
      expect(sidebar.style.width).toBe('288px')
    })

    it('has transition class for smooth width changes', async () => {
      const store = createTestStore({ projects: [] })
      const { container } = render(
        <Provider store={store}>
          <Sidebar view="terminal" onNavigate={vi.fn()} width={300} />
        </Provider>
      )

      vi.advanceTimersByTime(100)

      const sidebar = container.firstChild as HTMLElement
      expect(sidebar.className).toContain('transition-')
    })
  })

  describe('Search clear button', () => {
    it('renders and clears a preloaded requested search from sidebar state', async () => {
      const store = createTestStore({
        sessions: {
          activeSurface: 'sidebar',
          windows: {
            sidebar: {
              projects: [],
              lastLoadedAt: 1_700_000_000_000,
              query: 'preloaded search',
              searchTier: 'fullText',
            },
          },
        },
      })
      const { getByPlaceholderText, getByRole, queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const input = getByPlaceholderText('Search...')
      expect(input).toHaveValue('preloaded search')
      expect(getByRole('combobox', { name: /search tier/i })).toHaveValue('fullText')

      fireEvent.click(getByRole('button', { name: /clear search/i }))

      expect(input).toHaveValue('')
      expect(queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()
      expect(queryByRole('combobox', { name: /search tier/i })).not.toBeInTheDocument()
    })

    it('does not write search request state to Redux until the debounced request starts', async () => {
      const searchRequest = createDeferred<any>()
      vi.mocked(mockSearchSessions).mockReturnValueOnce(searchRequest.promise)

      const store = createTestStore({
        sessions: {
          activeSurface: 'sidebar',
          windows: {
            sidebar: {
              projects: [],
            },
          },
        },
      })
      const { getByPlaceholderText, getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'draft query' } })
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'fullText' } })

      expect((store.getState().sessions.windows.sidebar as any).query).toBeUndefined()
      expect((store.getState().sessions.windows.sidebar as any).searchTier).toBeUndefined()

      await act(() => vi.advanceTimersByTime(299))

      expect((store.getState().sessions.windows.sidebar as any).query).toBeUndefined()
      expect((store.getState().sessions.windows.sidebar as any).searchTier).toBeUndefined()

      await act(async () => {
        vi.advanceTimersByTime(1)
        await Promise.resolve()
      })

      expect((store.getState().sessions.windows.sidebar as any).query).toBe('draft query')
      expect((store.getState().sessions.windows.sidebar as any).searchTier).toBe('fullText')

      await act(async () => {
        searchRequest.resolve({
          results: [],
          tier: 'title',
          query: 'draft query',
          totalScanned: 0,
        })
        await Promise.resolve()
      })
    })

    it('shows clear button when search has text', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, getByRole, queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // No clear button initially
      expect(queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()

      // Type in search
      const input = getByPlaceholderText('Search...')
      fireEvent.change(input, { target: { value: 'test' } })

      // Should show clear button
      expect(getByRole('button', { name: /clear search/i })).toBeInTheDocument()
    })

    it('clears search when clear button is clicked', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, getByRole, queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // Type in search
      const input = getByPlaceholderText('Search...')
      fireEvent.change(input, { target: { value: 'test' } })
      expect(input).toHaveValue('test')

      // Click clear button
      fireEvent.click(getByRole('button', { name: /clear search/i }))

      // Search should be cleared
      expect(input).toHaveValue('')
      // Clear button should be hidden
      expect(queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()
    })
  })

  describe('Search tier toggle', () => {
    it('follows requested search updates from Redux after mount', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      act(() => {
        store.dispatch(setSessionWindowLoading({
          surface: 'sidebar',
          loading: false,
          query: 'store-driven query',
          searchTier: 'userMessages',
        }))
      })

      expect(getByPlaceholderText('Search...')).toHaveValue('store-driven query')
      expect(getByRole('combobox', { name: /search tier/i })).toHaveValue('userMessages')
      expect(getByRole('button', { name: /clear search/i })).toBeInTheDocument()
    })

    it('dispatches a preloaded requested search on mount when no applied result set is committed', async () => {
      const searchRequest = createDeferred<any>()
      vi.mocked(mockSearchSessions).mockReturnValueOnce(searchRequest.promise)

      const store = createTestStore({
        sessions: {
          activeSurface: 'sidebar',
          windows: {
            sidebar: {
              projects: [],
              query: 'prefilled request',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(300)
        await Promise.resolve()
      })

      expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
        query: 'prefilled request',
        tier: 'title',
      }))

      await act(async () => {
        searchRequest.resolve({
          results: [],
          tier: 'title',
          query: 'prefilled request',
          totalScanned: 0,
        })
        await Promise.resolve()
      })
    })

    it('renders tier selector when searching', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // Type in search
      const input = getByPlaceholderText('Search...')
      fireEvent.change(input, { target: { value: 'test' } })

      // Should show tier selector
      expect(getByRole('combobox', { name: /search tier/i })).toBeInTheDocument()
    })

    it('hides tier selector when search is empty', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, queryByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      const input = getByPlaceholderText('Search...')
      expect(input).toHaveValue('')
      expect(queryByRole('combobox', { name: /search tier/i })).not.toBeInTheDocument()
    })

    it('defaults to title tier', async () => {
      const store = createTestStore()
      const { getByPlaceholderText, getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })

      const select = getByRole('combobox', { name: /search tier/i })
      expect(select).toHaveValue('title')
    })
  })

  describe('Search loading state', () => {
    it('shows loading indicator while searching', async () => {
      // Make the search take some time
      vi.mocked(mockSearchSessions).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          results: [],
          tier: 'userMessages',
          query: 'test',
          totalScanned: 0,
        }), 1000))
      )

      const store = createTestStore({ projects: [] })
      const { getByPlaceholderText, getByRole, getByTestId, queryByTestId } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'userMessages' } })

      // After debounce but before search completes
      await act(() => vi.advanceTimersByTime(350))
      expect(getByTestId('search-loading')).toBeInTheDocument()

      // Completion is covered by the empty-results test below.
    })

    it('shows "No results" message when search returns empty', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [],
        tier: 'userMessages',
        query: 'nonexistent',
        totalScanned: 10,
      })

      const store = createTestStore({ projects: [] })
      const { getByPlaceholderText, getByRole, getByText } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'nonexistent' } })
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'userMessages' } })

      // Wait for debounce and flush promises
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      expect(getByText(/no results/i)).toBeInTheDocument()
    })

    it('keeps loading state when switching back to title tier during search', async () => {
      // Make the search take a long time to ensure we can switch tiers mid-search
      vi.mocked(mockSearchSessions).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          results: [],
          tier: 'userMessages',
          query: 'test',
          totalScanned: 0,
        }), 5000))
      )

      const store = createTestStore({ projects: [] })
      const { getByPlaceholderText, getByRole, getByTestId, queryByTestId } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // Start a userMessages search
      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'userMessages' } })

      // Wait for debounce - loading indicator should appear
      await act(() => vi.advanceTimersByTime(350))
      expect(getByTestId('search-loading')).toBeInTheDocument()

      // Switch back to title tier while search is in progress
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'title' } })

      // Title-tier searches are also store-owned, so loading stays visible.
      await act(async () => {
        vi.advanceTimersByTime(0)
        await Promise.resolve()
      })
      expect(queryByTestId('search-loading')).toBeInTheDocument()
    })

    it('keeps a loaded sidebar list mounted during a non-search refresh', async () => {
      const recentProjects: ProjectGroup[] = [{
        projectPath: '/work/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/work/recent',
          lastActivityAt: 1_700_000_000_000,
          title: 'Recent Session',
        }],
      }]

      const store = createTestStore({
        projects: recentProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: recentProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: recentProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'background',
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Recent Session')).toBeInTheDocument()
      expect(screen.getByTestId('sidebar-session-list')).toBeInTheDocument()
      expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
      expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
    })

    it('keeps loaded search results mounted during a silent background refresh', async () => {
      const searchProjects: ProjectGroup[] = [{
        projectPath: '/work/search',
        sessions: [{
          provider: 'codex',
          sessionId: 'search-session',
          projectPath: '/work/search',
          lastActivityAt: 1_700_000_000_000,
          title: 'Search Result',
        }],
      }]

      const store = createTestStore({
        projects: searchProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: searchProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: searchProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'background',
              query: 'search',
              searchTier: 'title',
            },
          },
        },
      })

      const { getByPlaceholderText } = renderSidebar(store, [])
      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'search' } })

      expect(screen.getByText('Search Result')).toBeInTheDocument()
      expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
    })

    it('keeps loaded search results mounted while visible search work is in flight', async () => {
      const searchProjects: ProjectGroup[] = [{
        projectPath: '/work/search',
        sessions: [{
          provider: 'codex',
          sessionId: 'search-session',
          projectPath: '/work/search',
          lastActivityAt: 1_700_000_000_000,
          title: 'Search Result',
        }],
      }]

      const store = createTestStore({
        projects: searchProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: searchProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: searchProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'search',
              query: 'search',
              searchTier: 'title',
            },
          },
        },
      })

      const { getByPlaceholderText } = renderSidebar(store, [])
      const searchInput = getByPlaceholderText('Search...')
      fireEvent.change(searchInput, { target: { value: 'search' } })

      expect(screen.getByText('Search Result')).toBeInTheDocument()
      const searchLoading = screen.getByTestId('search-loading')
      expect(searchLoading).toBeInTheDocument()
      expect(searchLoading.querySelector('span:not(.sr-only)')).toHaveTextContent('Searching...')
      expect(searchInput).toHaveClass('pr-36')
    })

    it('hides search chrome when clearing to browse while stale search results remain visible', async () => {
      const searchProjects: ProjectGroup[] = [{
        projectPath: '/work/search',
        sessions: [{
          provider: 'codex',
          sessionId: 'search-session',
          projectPath: '/work/search',
          lastActivityAt: 1_700_000_000_000,
          title: 'Search Result',
        }],
      }]

      const store = createTestStore({
        projects: searchProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: searchProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: searchProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'search',
              query: '',
              searchTier: 'title',
              appliedQuery: 'search',
              appliedSearchTier: 'title',
            },
          },
        },
      })

      const { getByPlaceholderText } = renderSidebar(store, [])
      const searchInput = getByPlaceholderText('Search...')

      expect(searchInput).toHaveValue('')
      expect(screen.getByText('Search Result')).toBeInTheDocument()
      expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: /search tier/i })).not.toBeInTheDocument()
    })

    it('keeps a loaded empty-state message visible during refresh', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          projects: [],
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: [],
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'background',
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('No sessions yet')).toBeInTheDocument()
      expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
      expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
    })

    it('keeps a loaded sidebar list mounted during pagination without showing refresh chrome', async () => {
      const recentProjects: ProjectGroup[] = [{
        projectPath: '/work/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/work/recent',
          lastActivityAt: 1_700_000_000_000,
          title: 'Recent Session',
        }],
      }]

      const store = createTestStore({
        projects: recentProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: recentProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: recentProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              loadingKind: 'pagination',
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Recent Session')).toBeInTheDocument()
      expect(screen.getByTestId('sidebar-session-list')).toBeInTheDocument()
      expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
      expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
    })

    it('keeps first-load search blocking when no results have loaded yet', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          projects: [],
          windows: {
            sidebar: {
              projects: [],
              loading: true,
              loadingKind: 'initial',
              query: 'search',
              searchTier: 'title',
            },
          },
        },
      })

      const { getByPlaceholderText } = renderSidebar(store, [])
      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'search' } })

      expect(screen.getByTestId('search-loading')).toBeInTheDocument()
      expect(screen.queryByText('Search Result')).not.toBeInTheDocument()
    })

    it('keeps initial sidebar loads blocking even when fallback tab sessions exist', async () => {
      const fallbackSessionId = sessionId('fallback-sidebar-load')
      const store = createTestStore({
        projects: [],
        tabs: [{
          id: 'tab-fallback-load',
          title: 'Fallback Session',
          mode: 'codex',
          resumeSessionId: fallbackSessionId,
          createdAt: 2_000,
        }],
        panes: {
          layouts: {
            'tab-fallback-load': {
              type: 'leaf',
              id: 'pane-fallback-load',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-fallback-load',
                status: 'running',
                resumeSessionId: fallbackSessionId,
                cwd: '/tmp/fallback-load',
              },
            },
          },
          activePane: {
            'tab-fallback-load': 'pane-fallback-load',
          },
          paneTitles: {
            'tab-fallback-load': {
              'pane-fallback-load': 'Fallback Session',
            },
          },
        },
        sessions: {
          activeSurface: 'sidebar',
          projects: [],
          windows: {
            sidebar: {
              projects: [],
              loading: true,
              loadingKind: 'initial',
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Loading sessions...')).toBeInTheDocument()
      expect(screen.queryByText('Fallback Session')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-session-list')).not.toBeInTheDocument()
    })

    it('keeps first-load search blocking even when fallback tab sessions exist', async () => {
      const fallbackSessionId = sessionId('fallback-search-load')
      const store = createTestStore({
        projects: [],
        tabs: [{
          id: 'tab-fallback-search',
          title: 'Fallback Search Session',
          mode: 'codex',
          resumeSessionId: fallbackSessionId,
          createdAt: 2_000,
        }],
        panes: {
          layouts: {
            'tab-fallback-search': {
              type: 'leaf',
              id: 'pane-fallback-search',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-fallback-search',
                status: 'running',
                resumeSessionId: fallbackSessionId,
                cwd: '/tmp/fallback-search',
              },
            },
          },
          activePane: {
            'tab-fallback-search': 'pane-fallback-search',
          },
          paneTitles: {
            'tab-fallback-search': {
              'pane-fallback-search': 'Fallback Search Session',
            },
          },
        },
        sessions: {
          activeSurface: 'sidebar',
          projects: [],
          windows: {
            sidebar: {
              projects: [],
              loading: true,
              loadingKind: 'initial',
              query: 'search',
              searchTier: 'title',
            },
          },
        },
      })

      const { getByPlaceholderText } = renderSidebar(store, [])
      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'search' } })

      expect(screen.getByTestId('search-loading')).toBeInTheDocument()
      expect(screen.queryByText('Fallback Search Session')).not.toBeInTheDocument()
      expect(screen.queryByTestId('sidebar-session-list')).not.toBeInTheDocument()
    })

    it('starts append pagination when the loaded sidebar is scrolled near the bottom', async () => {
      vi.useRealTimers()

      mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-session',
            projectPath: '/older',
            lastActivityAt: 10,
            title: 'Older Session',
          }],
        }],
        totalSessions: 2,
        oldestIncludedTimestamp: 10,
        oldestIncludedSessionId: 'codex:older-session',
        hasMore: false,
      })

      const store = createTestStore({
        projects: [{
          projectPath: '/recent',
          sessions: [{
            provider: 'codex',
            sessionId: 'recent-session',
            projectPath: '/recent',
            lastActivityAt: 20,
            title: 'Recent Session',
          }],
        }],
        sessions: {
          activeSurface: 'sidebar',
          projects: [{
            projectPath: '/recent',
            sessions: [{
              provider: 'codex',
              sessionId: 'recent-session',
              projectPath: '/recent',
              lastActivityAt: 20,
              title: 'Recent Session',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/recent',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'recent-session',
                  projectPath: '/recent',
                  lastActivityAt: 20,
                  title: 'Recent Session',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 20,
              oldestLoadedSessionId: 'codex:recent-session',
              loading: false,
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store)
      expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)

      const list = screen.getByTestId('sidebar-session-list')
      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

      await waitFor(() => {
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
          limit: 50,
          before: 20,
          beforeId: 'codex:recent-session',
          signal: expect.any(AbortSignal),
        }))
      })
      await waitFor(() => {
        expect(screen.getByText('Older Session')).toBeInTheDocument()
      })
      expect(screen.getByText('Recent Session')).toBeInTheDocument()
    })

    it('starts append pagination when a loaded sidebar is shorter than the viewport', async () => {
      vi.useRealTimers()

      const resizeCallbacks: Array<() => void> = []
      class MockResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
        }
        observe() {}
        disconnect() {}
      }
      vi.stubGlobal('ResizeObserver', MockResizeObserver)

      mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-session',
            projectPath: '/older',
            lastActivityAt: 10,
            title: 'Older Session',
          }],
        }],
        totalSessions: 2,
        oldestIncludedTimestamp: 10,
        oldestIncludedSessionId: 'codex:older-session',
        hasMore: false,
      })

      const store = createTestStore({
        projects: [{
          projectPath: '/recent',
          sessions: [{
            provider: 'codex',
            sessionId: 'recent-session',
            projectPath: '/recent',
            lastActivityAt: 20,
            title: 'Recent Session',
          }],
        }],
        sessions: {
          activeSurface: 'sidebar',
          projects: [{
            projectPath: '/recent',
            sessions: [{
              provider: 'codex',
              sessionId: 'recent-session',
              projectPath: '/recent',
              lastActivityAt: 20,
              title: 'Recent Session',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/recent',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'recent-session',
                  projectPath: '/recent',
                  lastActivityAt: 20,
                  title: 'Recent Session',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 20,
              oldestLoadedSessionId: 'codex:recent-session',
              loading: false,
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      try {
        renderSidebar(store)
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)

        const list = screen.getByTestId('sidebar-session-list')
        setSidebarListGeometry(list, { clientHeight: 560, scrollHeight: 112, scrollTop: 0 })

        await act(async () => {
          resizeCallbacks.forEach((callback) => callback())
          await Promise.resolve()
        })

        await waitFor(() => {
          expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
            limit: 50,
            before: 20,
            beforeId: 'codex:recent-session',
            signal: expect.any(AbortSignal),
          }))
        })
        await waitFor(() => {
          expect(screen.getByText('Older Session')).toBeInTheDocument()
        })
        expect(screen.getByText('Recent Session')).toBeInTheDocument()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('does not append while the sidebar window is showing committed search results', () => {
      const store = createTestStore({
        sessions: {
          activeSurface: 'sidebar',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/search',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'search-session',
                  projectPath: '/search',
                  lastActivityAt: 20,
                  title: 'Search Result',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 20,
              oldestLoadedSessionId: 'codex:search-session',
              loading: false,
              query: 'search',
              searchTier: 'title',
              appliedQuery: 'search',
              appliedSearchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store)
      const list = screen.getByTestId('sidebar-session-list')
      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

      expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
    })

    it('continues append pagination while the user has only typed an uncommitted sidebar search query', async () => {
      vi.useRealTimers()

      mockSearchSessions.mockResolvedValue({
        results: [],
        tier: 'title',
        query: 'search',
        totalScanned: 0,
      } as any)

      mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-session',
            projectPath: '/older',
            lastActivityAt: 10,
            title: 'Older Session',
          }],
        }],
        totalSessions: 2,
        oldestIncludedTimestamp: 10,
        oldestIncludedSessionId: 'codex:older-session',
        hasMore: false,
      })

      const store = createTestStore({
        sessions: {
          activeSurface: 'sidebar',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/recent',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'recent-session',
                  projectPath: '/recent',
                  lastActivityAt: 20,
                  title: 'Recent Session',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 20,
              oldestLoadedSessionId: 'codex:recent-session',
              loading: false,
              query: '',
              searchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store)
      fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'search' } })

      const list = screen.getByTestId('sidebar-session-list')
      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

      await waitFor(() => {
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
          limit: 50,
          before: 20,
          beforeId: 'codex:recent-session',
          signal: expect.any(AbortSignal),
        }))
      })
      await waitFor(() => {
        expect(screen.getByText('Older Session')).toBeInTheDocument()
      })
      expect(screen.getByText('Recent Session')).toBeInTheDocument()
    })

    it('releases the sidebar append guard even when another session surface is active', async () => {
      vi.useRealTimers()

      mockFetchSidebarSessionsSnapshot
        .mockResolvedValueOnce({
          projects: [{
            projectPath: '/older',
            sessions: [{
              provider: 'codex',
              sessionId: 'older-session-1',
              projectPath: '/older',
              lastActivityAt: 10,
              title: 'Older Session 1',
            }],
          }],
          totalSessions: 2,
          oldestIncludedTimestamp: 10,
          oldestIncludedSessionId: 'codex:older-session-1',
          hasMore: true,
        })
        .mockResolvedValueOnce({
          projects: [{
            projectPath: '/older',
            sessions: [{
              provider: 'codex',
              sessionId: 'older-session-2',
              projectPath: '/older',
              lastActivityAt: 8,
              title: 'Older Session 2',
            }],
          }],
          totalSessions: 3,
          oldestIncludedTimestamp: 8,
          oldestIncludedSessionId: 'codex:older-session-2',
          hasMore: false,
        })

      const store = createTestStore({
        sessions: {
          activeSurface: 'history',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/recent',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'recent-session',
                  projectPath: '/recent',
                  lastActivityAt: 20,
                  title: 'Recent Session',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 20,
              oldestLoadedSessionId: 'codex:recent-session',
              loading: false,
              query: '',
              searchTier: 'title',
            },
            history: {
              projects: [],
              lastLoadedAt: 1_700_000_000_000,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store)
      const list = screen.getByTestId('sidebar-session-list')

      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })
      await waitFor(() => {
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
      })
      await screen.findByText('Older Session 1')

      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })
      await waitFor(() => {
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
      })
      await screen.findByText('Older Session 2')
    })

    it('does not start append pagination while the sidebar is already refreshing', () => {
      const recentProjects: ProjectGroup[] = [{
        projectPath: '/work/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/work/recent',
          lastActivityAt: 1_700_000_000_000,
          title: 'Recent Session',
        }],
      }]

      const store = createTestStore({
        projects: recentProjects,
        sessions: {
          activeSurface: 'sidebar',
          projects: recentProjects,
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 1_700_000_000_000,
          oldestLoadedSessionId: 'codex:recent-session',
          loadingMore: true,
          windows: {
            sidebar: {
              projects: recentProjects,
              lastLoadedAt: 1_700_000_000_000,
              loading: true,
              query: '',
              searchTier: 'title',
              hasMore: true,
              oldestLoadedTimestamp: 1_700_000_000_000,
              oldestLoadedSessionId: 'codex:recent-session',
            },
          },
        },
      })

      renderSidebar(store)

      const list = screen.getByTestId('sidebar-session-list')
      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

      expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
    })
  })

  describe('Backend search integration', () => {
    beforeEach(() => {
      vi.mocked(mockSearchSessions).mockReset()
    })

    it('calls searchSessions API when tier is not title and query exists', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [
          { sessionId: 'result-1', provider: 'claude', projectPath: '/proj', matchedIn: 'userMessage', lastActivityAt: 1000, snippet: 'Found it' },
        ],
        tier: 'userMessages',
        query: 'test',
        totalScanned: 5,
      })

      const store = createTestStore({ projects: [] })
      const { getByPlaceholderText, getByRole } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      // Enter search query
      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })

      // Change tier to userMessages
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'userMessages' } })

      // Wait for debounce and flush async (two-phase search: title then userMessages)
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
        await Promise.resolve()
      })

      // Two-phase search: Phase 1 calls with title, Phase 2 calls with userMessages
      expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
        query: 'test',
        tier: 'title',
      }))
      expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
        query: 'test',
        tier: 'userMessages',
      }))
    })

    it('displays search results from API', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [
          { sessionId: 'result-1', provider: 'claude', projectPath: '/proj', matchedIn: 'userMessage', lastActivityAt: 1000, title: 'Found Session', snippet: 'test found here' },
        ],
        tier: 'userMessages',
        query: 'test',
        totalScanned: 5,
      })

      const store = createTestStore({ projects: [] })
      const { getByPlaceholderText, getByRole, getByText } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })
      fireEvent.change(getByRole('combobox', { name: /search tier/i }), { target: { value: 'userMessages' } })

      // Advance past debounce and flush promises
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      expect(getByText('Found Session')).toBeInTheDocument()
    })

    it('calls searchSessions API for title tier (server-side search)', async () => {
      vi.mocked(mockSearchSessions).mockResolvedValue({
        results: [
          { sessionId: 's1', provider: 'claude', projectPath: '/proj', matchedIn: 'title', lastActivityAt: 1000, title: 'Test session' },
        ],
        tier: 'title',
        query: 'test',
        totalScanned: 1,
      })

      const store = createTestStore({
        projects: [
          {
            projectPath: '/proj',
            sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/proj', lastActivityAt: 1000, title: 'Test session', cwd: '/proj' }],
          },
        ],
      })
      const { getByPlaceholderText } = renderSidebar(store, [])
      await act(() => vi.advanceTimersByTime(100))

      fireEvent.change(getByPlaceholderText('Search...'), { target: { value: 'test' } })

      // Keep default title tier
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      // After bypass removal, title tier search DOES call the API
      expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
        query: 'test',
        tier: 'title',
      }))
    })
  })

  describe('sidebar click opens pane', () => {
    it('splits a new pane in the current tab when clicking a session', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-to-split'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Session to split',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        {
          id: 'tab-1',
          mode: 'shell' as const,
        },
      ]

      const panes = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
        },
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs, panes, activeTabId: 'tab-1', sessionOpenMode: 'split' })
      const { onNavigate } = renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('Session to split').closest('button')
      fireEvent.click(sessionButton!)

      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should NOT create a new tab
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)

      // The layout should now be a split with two panes
      const layout = state.panes.layouts['tab-1']
      expect(layout.type).toBe('split')
      if (layout.type === 'split') {
        const leaves = [layout.children[0], layout.children[1]]
        const sessionPane = leaves.find(
          (child) =>
            child.type === 'leaf' &&
            child.content.kind === 'terminal' &&
            child.content.resumeSessionId === sessionId('session-to-split')
        )
        expect(sessionPane).toBeDefined()
      }
    })

    it('focuses existing pane when clicking a session already open in another tab', async () => {
      const targetSessionId = sessionId('session-already-in-pane')

      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: targetSessionId,
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Already in pane',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        { id: 'tab-1', mode: 'shell' as const },
        { id: 'tab-2', mode: 'claude' as const },
      ]

      const panes = {
        layouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-1',
              status: 'running',
            },
          },
          'tab-2': {
            type: 'leaf',
            id: 'pane-2',
            content: {
              kind: 'terminal',
              mode: 'claude',
              createRequestId: 'req-2',
              status: 'running',
              resumeSessionId: targetSessionId,
            },
          },
        },
        activePane: {
          'tab-1': 'pane-1',
          'tab-2': 'pane-2',
        },
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs, panes, activeTabId: 'tab-1' })
      const { onNavigate } = renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('Already in pane').closest('button')
      fireEvent.click(sessionButton!)

      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should switch to the tab containing the session, not create a new one
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(2)
      expect(state.tabs.activeTabId).toBe('tab-2')
      expect(state.panes.activePane['tab-2']).toBe('pane-2')
    })

    it('does not hijack a foreign copied pane when opening the local session', async () => {
      const targetSessionId = sessionId('session-foreign-copy')

      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: targetSessionId,
              provider: 'codex',
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Local codex session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        { id: 'tab-foreign', mode: 'codex' as const },
      ]

      const panes = {
        layouts: {
          'tab-foreign': {
            type: 'leaf',
            id: 'pane-foreign',
            content: {
              kind: 'terminal',
              mode: 'codex',
              createRequestId: 'req-foreign',
              status: 'running',
              sessionRef: {
                provider: 'codex',
                sessionId: targetSessionId,
                serverInstanceId: 'srv-remote',
              },
            },
          },
        },
        activePane: {
          'tab-foreign': 'pane-foreign',
        },
        paneTitles: {},
      }

      const store = createTestStore({
        projects,
        tabs,
        panes,
        activeTabId: 'tab-foreign',
        serverInstanceId: 'srv-local',
        sessionOpenMode: 'split',
      })
      const { onNavigate } = renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('Local codex session').closest('button')
      fireEvent.click(sessionButton!)

      expect(onNavigate).toHaveBeenCalledWith('terminal')

      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(1)
      expect(state.panes.activePane['tab-foreign']).not.toBe('pane-foreign')
      const layout = state.panes.layouts['tab-foreign']
      expect(layout.type).toBe('split')
      const localPane = collectLeafPanes(layout).find((pane) => (
        pane.type === 'leaf'
        && pane.content.kind === 'terminal'
        && pane.content.resumeSessionId === targetSessionId
      ))
      expect(localPane).toBeDefined()
    })

    it('falls back to creating a new tab when active tab has no layout', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('session-no-layout'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'No layout tab',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        { id: 'tab-1', mode: 'claude' as const },
      ]

      // Active tab exists but has no layout
      const panes = {
        layouts: {},
        activePane: {},
        paneTitles: {},
      }

      const store = createTestStore({ projects, tabs, panes, activeTabId: 'tab-1' })
      const { onNavigate } = renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const sessionButton = screen.getByText('No layout tab').closest('button')
      fireEvent.click(sessionButton!)

      expect(onNavigate).toHaveBeenCalledWith('terminal')

      // Should create a new tab since active tab has no layout
      const state = store.getState()
      expect(state.tabs.tabs).toHaveLength(2)
      const newTab = state.tabs.tabs.find((t: any) => t.resumeSessionId === sessionId('session-no-layout'))
      expect(newTab).toBeDefined()
    })
  })

  describe('deep search pending indicator', () => {
    beforeEach(() => {
      vi.mocked(mockSearchSessions).mockReset()
    })

    it('shows "Scanning files..." when deepSearchPending is true and items are visible', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          wsSnapshotReceived: true,
          windows: {
            sidebar: {
              projects: [
                {
                  projectPath: '/proj',
                  sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/proj', lastActivityAt: 1000, title: 'Found Session' }],
                },
              ],
              lastLoadedAt: Date.now(),
              query: 'test',
              searchTier: 'fullText',
              appliedQuery: 'test',
              appliedSearchTier: 'fullText',
              deepSearchPending: true,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Scanning files...')).toBeInTheDocument()
      expect(screen.getByText('Scanning files...').closest('[role="status"]')).toBeInTheDocument()
    })

    it('does not show "Scanning files..." when deepSearchPending is false', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          wsSnapshotReceived: true,
          windows: {
            sidebar: {
              projects: [
                {
                  projectPath: '/proj',
                  sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/proj', lastActivityAt: 1000, title: 'Found Session' }],
                },
              ],
              lastLoadedAt: Date.now(),
              query: 'test',
              searchTier: 'fullText',
              appliedQuery: 'test',
              appliedSearchTier: 'fullText',
              deepSearchPending: false,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.queryByText('Scanning files...')).not.toBeInTheDocument()
    })

    it('shows "Scanning files..." in empty state when deepSearchPending is true and no items visible', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          wsSnapshotReceived: true,
          windows: {
            sidebar: {
              projects: [],
              lastLoadedAt: Date.now(),
              query: 'test',
              searchTier: 'fullText',
              appliedQuery: 'test',
              appliedSearchTier: 'fullText',
              deepSearchPending: true,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Scanning files...')).toBeInTheDocument()
      expect(screen.queryByText('No results found')).not.toBeInTheDocument()
    })

    it('clearing search input removes "Scanning files..." indicator', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          wsSnapshotReceived: true,
          windows: {
            sidebar: {
              projects: [
                {
                  projectPath: '/proj',
                  sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/proj', lastActivityAt: 1000, title: 'Found Session' }],
                },
              ],
              lastLoadedAt: Date.now(),
              query: 'test',
              searchTier: 'fullText',
              appliedQuery: 'test',
              appliedSearchTier: 'fullText',
              deepSearchPending: true,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])
      expect(screen.getByText('Scanning files...')).toBeInTheDocument()

      // Clear the search
      fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: '' } })
      await act(() => vi.advanceTimersByTime(0))

      expect(screen.queryByText('Scanning files...')).not.toBeInTheDocument()
    })

    it('"Scanning files..." indicator has role="status" and aria-live="polite"', async () => {
      const store = createTestStore({
        projects: [],
        sessions: {
          activeSurface: 'sidebar',
          wsSnapshotReceived: true,
          windows: {
            sidebar: {
              projects: [
                {
                  projectPath: '/proj',
                  sessions: [{ provider: 'claude', sessionId: 's1', projectPath: '/proj', lastActivityAt: 1000, title: 'Found Session' }],
                },
              ],
              lastLoadedAt: Date.now(),
              query: 'test',
              searchTier: 'fullText',
              appliedQuery: 'test',
              appliedSearchTier: 'fullText',
              deepSearchPending: true,
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      const statusElement = screen.getByRole('status')
      expect(statusElement).toBeInTheDocument()
      expect(statusElement.getAttribute('aria-live')).toBe('polite')
      expect(statusElement.textContent).toContain('Scanning files...')
    })
  })

  describe('applied search fallback behavior', () => {
    it('shows only matching title-search fallback tabs and keeps them unpinned below newer server results', async () => {
      const matchingFallbackSessionId = sessionId('matching-fallback')
      const unrelatedFallbackSessionId = sessionId('unrelated-fallback')
      const searchProjects: ProjectGroup[] = [
        {
          projectPath: '/work/server',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'server-newer',
              projectPath: '/work/server',
              lastActivityAt: 3_000,
              title: 'Newer Server Result',
            },
          ],
        },
        {
          projectPath: '/work/repos/trycycle',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'server-leaf',
              projectPath: '/work/repos/trycycle',
              cwd: '/work/repos/trycycle/server',
              lastActivityAt: 2_500,
              title: 'Routine work',
            },
          ],
        },
      ]

      const store = createTestStore({
        projects: searchProjects,
        tabs: [
          {
            id: 'tab-match',
            title: 'Matching Fallback',
            mode: 'codex',
            resumeSessionId: matchingFallbackSessionId,
            createdAt: 1_000,
          },
          {
            id: 'tab-unrelated',
            title: 'Unrelated Fallback',
            mode: 'codex',
            resumeSessionId: unrelatedFallbackSessionId,
            createdAt: 900,
          },
        ],
        panes: {
          layouts: {
            'tab-match': {
              type: 'leaf',
              id: 'pane-match',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-match',
                status: 'running',
                resumeSessionId: matchingFallbackSessionId,
                initialCwd: '/tmp/local/trycycle',
              },
            },
            'tab-unrelated': {
              type: 'leaf',
              id: 'pane-unrelated',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-unrelated',
                status: 'running',
                resumeSessionId: unrelatedFallbackSessionId,
                initialCwd: '/tmp/local/elsewhere',
              },
            },
          },
          activePane: {
            'tab-match': 'pane-match',
            'tab-unrelated': 'pane-unrelated',
          },
          paneTitles: {
            'tab-match': {
              'pane-match': 'Matching Fallback',
            },
            'tab-unrelated': {
              'pane-unrelated': 'Unrelated Fallback',
            },
          },
        },
        sessions: {
          activeSurface: 'sidebar',
          projects: searchProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: searchProjects,
              lastLoadedAt: 1_700_000_000_000,
              query: 'trycycle',
              searchTier: 'title',
              appliedQuery: 'trycycle',
              appliedSearchTier: 'title',
              loading: false,
            },
          },
        },
        sortMode: 'activity',
      })

      renderSidebar(store, [])

      expect(screen.getByText('Newer Server Result')).toBeInTheDocument()
      expect(screen.getByText('Routine work')).toBeInTheDocument()
      expect(screen.getByText('Matching Fallback')).toBeInTheDocument()
      expect(screen.queryByText('Unrelated Fallback')).not.toBeInTheDocument()
      expect(getSidebarSessionOrder([
        'Newer Server Result',
        'Routine work',
        'Matching Fallback',
      ])).toEqual([
        'Newer Server Result',
        'Routine work',
        'Matching Fallback',
      ])
    })

    it('hides fallback tabs entirely while a deep-search result set is on screen', async () => {
      const deepFallbackSessionId = sessionId('deep-fallback')
      const deepProjects: ProjectGroup[] = [
        {
          projectPath: '/work/deep',
          sessions: [
            {
              provider: 'claude',
              sessionId: 'deep-server',
              projectPath: '/work/deep',
              lastActivityAt: 3_000,
              title: 'Deep Search Result',
            },
          ],
        },
      ]

      const store = createTestStore({
        projects: deepProjects,
        tabs: [{
          id: 'tab-deep',
          title: 'Deep Matching Fallback',
          mode: 'codex',
          resumeSessionId: deepFallbackSessionId,
          createdAt: 1_000,
        }],
        panes: {
          layouts: {
            'tab-deep': {
              type: 'leaf',
              id: 'pane-deep',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-deep',
                status: 'running',
                resumeSessionId: deepFallbackSessionId,
                initialCwd: '/tmp/local/trycycle',
              },
            },
          },
          activePane: {
            'tab-deep': 'pane-deep',
          },
          paneTitles: {
            'tab-deep': {
              'pane-deep': 'Deep Matching Fallback',
            },
          },
        },
        sessions: {
          activeSurface: 'sidebar',
          projects: deepProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: deepProjects,
              lastLoadedAt: 1_700_000_000_000,
              query: 'trycycle',
              searchTier: 'fullText',
              appliedQuery: 'trycycle',
              appliedSearchTier: 'fullText',
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      expect(screen.getByText('Deep Search Result')).toBeInTheDocument()
      expect(screen.queryByText('Deep Matching Fallback')).not.toBeInTheDocument()
    })

    it('keeps the previous applied title-search result set visible while a replacement search is loading', async () => {
      const replacementSearch = createDeferred<any>()
      const alphaFallbackSessionId = sessionId('alpha-fallback')
      const betaFallbackSessionId = sessionId('beta-fallback')
      vi.mocked(mockSearchSessions).mockReturnValueOnce(replacementSearch.promise)

      const alphaProjects: ProjectGroup[] = [
        {
          projectPath: '/work/alpha',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'alpha-server',
              projectPath: '/work/alpha',
              lastActivityAt: 3_000,
              title: 'Alpha Server Result',
            },
          ],
        },
      ]

      const store = createTestStore({
        projects: alphaProjects,
        tabs: [
          {
            id: 'tab-alpha-fallback',
            title: 'Alpha Fallback',
            mode: 'codex',
            resumeSessionId: alphaFallbackSessionId,
            createdAt: 1_000,
          },
          {
            id: 'tab-beta-fallback',
            title: 'Beta Fallback',
            mode: 'codex',
            resumeSessionId: betaFallbackSessionId,
            createdAt: 900,
          },
        ],
        panes: {
          layouts: {
            'tab-alpha-fallback': {
              type: 'leaf',
              id: 'pane-alpha-fallback',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-alpha-fallback',
                status: 'running',
                resumeSessionId: alphaFallbackSessionId,
                initialCwd: '/tmp/local/alpha',
              },
            },
            'tab-beta-fallback': {
              type: 'leaf',
              id: 'pane-beta-fallback',
              content: {
                kind: 'terminal',
                mode: 'codex',
                createRequestId: 'req-beta-fallback',
                status: 'running',
                resumeSessionId: betaFallbackSessionId,
                initialCwd: '/tmp/local/beta',
              },
            },
          },
          activePane: {
            'tab-alpha-fallback': 'pane-alpha-fallback',
            'tab-beta-fallback': 'pane-beta-fallback',
          },
          paneTitles: {
            'tab-alpha-fallback': {
              'pane-alpha-fallback': 'Alpha Fallback',
            },
            'tab-beta-fallback': {
              'pane-beta-fallback': 'Beta Fallback',
            },
          },
        },
        sessions: {
          activeSurface: 'sidebar',
          projects: alphaProjects,
          lastLoadedAt: 1_700_000_000_000,
          windows: {
            sidebar: {
              projects: alphaProjects,
              lastLoadedAt: 1_700_000_000_000,
              query: 'alpha',
              searchTier: 'title',
              appliedQuery: 'alpha',
              appliedSearchTier: 'title',
              loading: false,
            },
          },
        },
      })

      renderSidebar(store, [])

      try {
        fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'beta' } })

        await act(async () => {
          vi.advanceTimersByTime(350)
          await Promise.resolve()
        })

        expect(screen.getByTestId('search-loading')).toBeInTheDocument()
        expect(screen.getByText('Alpha Server Result')).toBeInTheDocument()
        expect(screen.getByText('Alpha Fallback')).toBeInTheDocument()
        expect(screen.queryByText('Beta Fallback')).not.toBeInTheDocument()
      } finally {
        replacementSearch.resolve({
          results: [],
          tier: 'title',
          query: 'beta',
          totalScanned: 0,
        })

        await act(async () => {
          await Promise.resolve()
          await Promise.resolve()
        })
      }
    })

    it('keeps browse append disabled until browse data replaces stale applied search results', async () => {
      vi.useRealTimers()

      const browseProjects: ProjectGroup[] = [{
        projectPath: '/browse',
        sessions: [{
          provider: 'codex',
          sessionId: 'browse-session',
          projectPath: '/browse',
          lastActivityAt: 20,
          title: 'Browse Session',
        }],
      }]

      mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
        projects: [{
          projectPath: '/older',
          sessions: [{
            provider: 'codex',
            sessionId: 'older-session',
            projectPath: '/older',
            lastActivityAt: 10,
            title: 'Older Session',
          }],
        }],
        totalSessions: 2,
        oldestIncludedTimestamp: 10,
        oldestIncludedSessionId: 'codex:older-session',
        hasMore: false,
      })

      const store = createTestStore({
        projects: [{
          projectPath: '/search',
          sessions: [{
            provider: 'codex',
            sessionId: 'search-session',
            projectPath: '/search',
            lastActivityAt: 30,
            title: 'Search Result',
          }],
        }],
        sessions: {
          activeSurface: 'sidebar',
          projects: [{
            projectPath: '/search',
            sessions: [{
              provider: 'codex',
              sessionId: 'search-session',
              projectPath: '/search',
              lastActivityAt: 30,
              title: 'Search Result',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 30,
          oldestLoadedSessionId: 'codex:search-session',
          windows: {
            sidebar: {
              projects: [{
                projectPath: '/search',
                sessions: [{
                  provider: 'codex',
                  sessionId: 'search-session',
                  projectPath: '/search',
                  lastActivityAt: 30,
                  title: 'Search Result',
                }],
              }],
              lastLoadedAt: 1_700_000_000_000,
              hasMore: true,
              oldestLoadedTimestamp: 30,
              oldestLoadedSessionId: 'codex:search-session',
              loading: true,
              loadingKind: 'search',
              query: '',
              searchTier: 'title',
              appliedQuery: 'search',
              appliedSearchTier: 'title',
            },
          },
        },
      })

      renderSidebar(store)
      const list = screen.getByTestId('sidebar-session-list')

      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })
      expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()

      await act(async () => {
        store.dispatch(commitSessionWindowReplacement({
          surface: 'sidebar',
          projects: browseProjects,
          totalSessions: 1,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:browse-session',
          query: '',
          searchTier: 'title',
        }))
      })

      triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

      await waitFor(() => {
        expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
          limit: 50,
          before: 20,
          beforeId: 'codex:browse-session',
          signal: expect.any(AbortSignal),
        }))
      })
      await waitFor(() => {
        expect(screen.getByText('Older Session')).toBeInTheDocument()
      })
    })
  })
})

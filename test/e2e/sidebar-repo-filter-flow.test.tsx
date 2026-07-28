import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import Sidebar from '@/components/Sidebar'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import sessionActivityReducer from '@/store/sessionActivitySlice'
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
import codexActivityReducer from '@/store/codexActivitySlice'
import type { ProjectGroup } from '@/store/types'
import { searchSessions as mockSearchSessions, fetchSidebarSessionsSnapshot as mockFetchSnapshot } from '@/lib/api'
import { _resetSessionWindowThunkState } from '@/store/sessionsThunks'

const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})
const mockConnect = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    fetchSidebarSessionsSnapshot: vi.fn(),
    searchSessions: vi.fn(),
  }
})

function createStore(options?: {
  projects?: ProjectGroup[]
  sessions?: Record<string, unknown>
  tabs?: any[]
  panes?: any
}) {
  const projects = (options?.projects ?? []).map((project) => ({
    ...project,
    sessions: (project.sessions ?? []).map((session) => ({
      ...session,
      provider: session.provider ?? 'claude',
    })),
  }))

  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      panes: panesReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      sessionActivity: sessionActivityReducer,
      terminalDirectory: terminalDirectoryReducer,
      codexActivity: codexActivityReducer,
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
            sortMode: 'activity',
            showProjectBadges: true,
            hideEmptySessions: false,
          },
        },
        loaded: true,
        lastSavedAt: undefined,
      },
      tabs: {
        tabs: options?.tabs ?? [],
        activeTabId: null,
      },
      panes: options?.panes ?? {
        layouts: {},
        activePane: {},
        paneTitles: {},
      },
      sessions: {
        projects,
        expandedProjects: new Set<string>(),
        wsSnapshotReceived: true,
        ...options?.sessions,
      },
      connection: {
        status: 'connected',
        error: null,
      },
      sessionActivity: {
        sessions: {},
      },
      terminalDirectory: {
        windows: {
          sidebar: {
            items: [],
            nextCursor: null,
            revision: 1,
          },
        },
        searches: {},
      },
      codexActivity: {
        byTerminalId: {},
        lastSnapshotSeq: 0,
        liveMutationSeqByTerminalId: {},
        removedMutationSeqByTerminalId: {},
      },
    },
  })
}

function renderSidebar(store: ReturnType<typeof createStore>) {
  const onNavigate = vi.fn()
  const result = render(
    <Provider store={store}>
      <Sidebar view="terminal" onNavigate={onNavigate} />
    </Provider>,
  )
  return { ...result, onNavigate }
}

describe('sidebar repo filter flow (e2e)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    _resetSessionWindowThunkState()
    vi.mocked(mockSearchSessions).mockReset()
    vi.mocked(mockFetchSnapshot).mockReset()
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: [],
      totalSessions: 0,
      oldestIncludedTimestamp: 0,
      oldestIncludedSessionId: '',
      hasMore: false,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    _resetSessionWindowThunkState()
  })

  const browseProjects: ProjectGroup[] = [
    {
      projectPath: '/home/user/repo-alpha',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-alpha-1',
        projectPath: '/home/user/repo-alpha',
        lastActivityAt: 2_000,
        title: 'Alpha session',
      }],
    },
    {
      projectPath: '/home/user/repo-beta',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-beta-1',
        projectPath: '/home/user/repo-beta',
        lastActivityAt: 1_000,
        title: 'Beta session',
      }],
    },
  ]

  function createBrowseStore() {
    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: browseProjects,
      totalSessions: 2,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:session-beta-1',
      hasMore: false,
    })
    return createStore({
      projects: browseProjects,
      sessions: {
        activeSurface: 'sidebar',
        projects: browseProjects,
        lastLoadedAt: 1_000,
        windows: {
          sidebar: {
            projects: browseProjects,
            lastLoadedAt: 1_000,
            query: '',
            searchTier: 'title',
            appliedQuery: '',
            appliedSearchTier: 'title',
            loading: false,
            hasMore: false,
            oldestLoadedTimestamp: 1_000,
            oldestLoadedSessionId: 'claude:session-beta-1',
          },
        },
      },
    })
  }

  it('repo dropdown filters browse results and the clear-x restores them', async () => {
    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    expect(screen.getByText('Alpha session')).toBeInTheDocument()
    expect(screen.getByText('Beta session')).toBeInTheDocument()

    const select = screen.getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
    expect(select).toHaveValue('all')
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'all',
      '/home/user/repo-alpha',
      '/home/user/repo-beta',
    ])

    fireEvent.change(select, { target: { value: '/home/user/repo-beta' } })
    expect(screen.getByText('Beta session')).toBeInTheDocument()
    expect(screen.queryByText('Alpha session')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Clear repo filter'))
    expect(select).toHaveValue('all')
    expect(screen.getByText('Alpha session')).toBeInTheDocument()
    expect(screen.getByText('Beta session')).toBeInTheDocument()
  })

  it('repo filter ANDs with a committed server search and the selection survives the commit', async () => {
    vi.mocked(mockSearchSessions).mockResolvedValue({
      results: [
        {
          sessionId: 'session-alpha-hit',
          provider: 'claude',
          projectPath: '/home/user/repo-alpha',
          title: 'Alpha deploy notes',
          matchedIn: 'title',
          lastActivityAt: 3_000,
          archived: false,
        },
        {
          sessionId: 'session-beta-hit',
          provider: 'claude',
          projectPath: '/home/user/repo-beta',
          title: 'Beta deploy notes',
          matchedIn: 'title',
          lastActivityAt: 2_500,
          archived: false,
        },
      ],
      tier: 'title',
      query: 'deploy',
      totalScanned: 5,
    })

    const store = createBrowseStore()
    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    const select = screen.getByRole('combobox', { name: /repo filter/i }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '/home/user/repo-alpha' } })
    expect(screen.queryByText('Beta session')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'deploy' } })
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
      query: 'deploy',
      tier: 'title',
    }))

    // Search results committed (window replaced); repo filter still ANDs on top.
    expect(screen.getByText('Alpha deploy notes')).toBeInTheDocument()
    expect(screen.queryByText('Beta deploy notes')).not.toBeInTheDocument()

    // Selection survived the window replacement and remains a valid option.
    expect(select).toHaveValue('/home/user/repo-alpha')
    expect(Array.from(select.options).map((o) => o.value)).toContain('/home/user/repo-alpha')
  })
})

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createStore(options?: {
  projects?: ProjectGroup[]
  sessions?: Record<string, unknown>
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
        tabs: [],
        activeTabId: null,
      },
      panes: {
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

describe('sidebar search flow (e2e)', () => {
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

  it('title-tier search goes through server and renders results', async () => {
    vi.mocked(mockSearchSessions).mockResolvedValue({
      results: [{
        sessionId: 'session-deploy',
        provider: 'claude',
        projectPath: '/proj',
        title: 'Deploy Pipeline',
        matchedIn: 'title',
        lastActivityAt: 2_000,
        archived: false,
      }],
      tier: 'title',
      query: 'deploy',
      totalScanned: 10,
    })

    const store = createStore({
      projects: [
        {
          projectPath: '/proj',
          sessions: [{
            sessionId: 'session-other',
            projectPath: '/proj',
            lastActivityAt: 1_000,
            title: 'Other Session',
          }],
        },
      ],
    })

    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    // Type a search query
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'deploy' } })

    // Wait for debounce + server response
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // Server-side search was called
    expect(mockSearchSessions).toHaveBeenCalledWith(expect.objectContaining({
      query: 'deploy',
      tier: 'title',
    }))

    // Search results rendered
    expect(screen.getByText('Deploy Pipeline')).toBeInTheDocument()
  })

  it('deep-tier search shows title results first, then merged results after Phase 2', async () => {
    const phase1Deferred = createDeferred<any>()
    const phase2Deferred = createDeferred<any>()
    vi.mocked(mockSearchSessions)
      .mockReturnValueOnce(phase1Deferred.promise)
      .mockReturnValueOnce(phase2Deferred.promise)

    const store = createStore({
      projects: [{
        projectPath: '/proj',
        sessions: [{
          sessionId: 'session-bg',
          projectPath: '/proj',
          lastActivityAt: 500,
          title: 'Background Session',
        }],
      }],
    })

    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    // Type search and change tier to fullText
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'auth' } })
    fireEvent.change(screen.getByRole('combobox', { name: /search tier/i }), { target: { value: 'fullText' } })

    // Wait for debounce
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // Resolve Phase 1 (title)
    await act(async () => {
      phase1Deferred.resolve({
        results: [{
          sessionId: 'session-auth-design',
          provider: 'claude',
          projectPath: '/proj',
          title: 'Auth Design',
          matchedIn: 'title',
          lastActivityAt: 3_000,
          archived: false,
        }],
        tier: 'title',
        query: 'auth',
        totalScanned: 5,
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Phase 1 results visible
    expect(screen.getByText('Auth Design')).toBeInTheDocument()
    // "Scanning files..." indicator visible
    expect(screen.getByText('Scanning files...')).toBeInTheDocument()

    // Resolve Phase 2 (fullText) with both sessions
    await act(async () => {
      phase2Deferred.resolve({
        results: [
          {
            sessionId: 'session-auth-design',
            provider: 'claude',
            projectPath: '/proj',
            title: 'Auth Design',
            matchedIn: 'userMessage',
            lastActivityAt: 3_000,
            archived: false,
          },
          {
            sessionId: 'session-login-bug',
            provider: 'claude',
            projectPath: '/proj',
            title: 'Login Bug',
            matchedIn: 'userMessage',
            lastActivityAt: 2_000,
            archived: false,
          },
        ],
        tier: 'fullText',
        query: 'auth',
        totalScanned: 20,
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Both sessions now visible
    expect(screen.getByText('Auth Design')).toBeInTheDocument()
    expect(screen.getByText('Login Bug')).toBeInTheDocument()
    // "Scanning files..." gone
    expect(screen.queryByText('Scanning files...')).not.toBeInTheDocument()
  })

  it('changing query while deep search is pending aborts the old search', async () => {
    const alphaPhase1 = createDeferred<any>()
    const alphaPhase2 = createDeferred<any>()
    const betaResults = {
      results: [{
        sessionId: 'session-beta',
        provider: 'claude',
        projectPath: '/proj',
        title: 'Beta Result',
        matchedIn: 'title',
        lastActivityAt: 4_000,
        archived: false,
      }],
      tier: 'title',
      query: 'beta',
      totalScanned: 1,
    }

    vi.mocked(mockSearchSessions)
      .mockReturnValueOnce(alphaPhase1.promise) // alpha Phase 1
      .mockReturnValueOnce(alphaPhase2.promise) // alpha Phase 2

    const store = createStore()

    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    // Start search for "alpha" with fullText tier
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'alpha' } })
    fireEvent.change(screen.getByRole('combobox', { name: /search tier/i }), { target: { value: 'fullText' } })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // Resolve alpha Phase 1
    await act(async () => {
      alphaPhase1.resolve({
        results: [{
          sessionId: 'session-alpha',
          provider: 'claude',
          projectPath: '/proj',
          title: 'Alpha Result',
          matchedIn: 'title',
          lastActivityAt: 3_000,
          archived: false,
        }],
        tier: 'title',
        query: 'alpha',
        totalScanned: 5,
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // "Scanning files..." should be visible
    expect(screen.getByText('Scanning files...')).toBeInTheDocument()

    // Now type "beta" (replaces "alpha")
    vi.mocked(mockSearchSessions).mockResolvedValueOnce(betaResults as any)
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'beta' } })

    // Wait for debounce
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Beta results visible
    expect(screen.getByText('Beta Result')).toBeInTheDocument()
    // Alpha's scanning indicator gone
    expect(screen.queryByText('Scanning files...')).not.toBeInTheDocument()

    // Resolve alpha Phase 2 (should be ignored)
    alphaPhase2.resolve({
      results: [],
      tier: 'fullText',
      query: 'alpha',
      totalScanned: 0,
    })
  })

  it('clearing search returns to browse mode', async () => {
    const phase1Deferred = createDeferred<any>()
    const phase2Deferred = createDeferred<any>()
    vi.mocked(mockSearchSessions)
      .mockReturnValueOnce(phase1Deferred.promise) // Phase 1
      .mockReturnValueOnce(phase2Deferred.promise) // Phase 2 (will hang)

    const browseProjects: ProjectGroup[] = [{
      projectPath: '/proj',
      sessions: [{
        provider: 'claude',
        sessionId: 'session-browse',
        projectPath: '/proj',
        lastActivityAt: 1_000,
        title: 'Browse Session',
      }],
    }]

    vi.mocked(mockFetchSnapshot).mockResolvedValue({
      projects: browseProjects,
      totalSessions: 1,
      oldestIncludedTimestamp: 1_000,
      oldestIncludedSessionId: 'claude:session-browse',
      hasMore: false,
    })

    const store = createStore({ projects: browseProjects })

    renderSidebar(store)
    await act(() => vi.advanceTimersByTime(100))

    // Start a search with fullText tier
    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'needle' } })
    fireEvent.change(screen.getByRole('combobox', { name: /search tier/i }), { target: { value: 'fullText' } })

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
    })

    // Resolve Phase 1
    await act(async () => {
      phase1Deferred.resolve({
        results: [{
          sessionId: 'session-found',
          provider: 'claude',
          projectPath: '/proj',
          title: 'Found Session',
          matchedIn: 'title',
          lastActivityAt: 2_000,
          archived: false,
        }],
        tier: 'title',
        query: 'needle',
        totalScanned: 5,
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // "Scanning files..." visible (Phase 2 pending, deferred hangs)
    expect(screen.getByText('Scanning files...')).toBeInTheDocument()

    // Clear search (aborts Phase 2, triggers browse re-fetch)
    const clearButton = screen.getByLabelText('Clear search')
    fireEvent.click(clearButton)

    // Wait for browse re-fetch
    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Resolve the dangling Phase 2 (should be ignored due to abort)
    phase2Deferred.resolve({
      results: [],
      tier: 'fullText',
      query: 'needle',
      totalScanned: 0,
    })

    // "Scanning files..." gone
    expect(screen.queryByText('Scanning files...')).not.toBeInTheDocument()
    // Tier dropdown gone (no active search)
    expect(screen.queryByRole('combobox', { name: /search tier/i })).not.toBeInTheDocument()
    // Browse session visible
    expect(screen.getByText('Browse Session')).toBeInTheDocument()
  })
})
